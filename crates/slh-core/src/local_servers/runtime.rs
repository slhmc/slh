use super::{config::*, host::*, providers, store};
use crate::{
    error::{AppError, AppResult},
    host::Host,
    state::AppState,
};
use std::path::{Path, PathBuf};

pub fn run_file(state: &AppState, id: &str) -> PathBuf {
    state
        .paths
        .data
        .join("server-runs")
        .join(format!("{id}.json"))
}
pub fn java_is_alive(state: &AppState, id: &str) -> bool {
    read_run(&run_file(state, id))
        .is_ok_and(|r| r.java_started > 0 && process_identity(r.java_pid) == Some(r.java_started))
}
pub async fn state_for(state: &AppState, id: &str, stored: &str) -> String {
    if stored == "installing" { return stored.into(); }
    match read_run(&run_file(state, id)) {
        Ok(info) => {
            if let Ok(s) = request(&info, "status", "", u64::MAX).await {
                return s.state;
            }
            if info.java_started > 0 && process_identity(info.java_pid) == Some(info.java_started) {
                "unmanaged".into()
            } else if ["stopped", "failed"].contains(&info.state.as_str()) {
                info.state
            } else {
                "failed".into()
            }
        }
        Err(_) => stored.into(),
    }
}
pub async fn effective_plan(app: &Host, state: &AppState, id: &str) -> AppResult<LaunchPlan> {
    let native = store::get(state, id).await?;
    if native.config.core == "horizon" {
        crate::minecraft::horizon::ensure_enabled(&state.database).await?;
        let mut plan = super::horizon::plan(&native)?;
        plan.args.extend(native.config.server_args);
        return Ok(plan);
    }
    if super::recovery::inspect(state, id).await?.needs_repair {
        return Err(AppError::Conflict("serverCoreRepair.required".into()));
    }
    let s = store::get(state, id).await?;
    let mut plan = store::load_plan(state, id)
        .await?
        .ok_or_else(|| AppError::InvalidInput("Install the server core first".into()))?;
    plan.java = providers::resolve_java(app, state, &s.config, plan.required_java).await?;
    let actual = crate::minecraft::java::inspect(Path::new(&plan.java)).await?;
    let mut args = jvm_arguments(&s.config, actual.major_version)?;
    args.extend(plan.args);
    if !s
        .config
        .server_args
        .iter()
        .any(|a| a == "nogui" || a == "--nogui")
    {
        args.push("nogui".into());
    }
    args.extend(s.config.server_args.clone());
    plan.args = args;
    plan.directory = s.path;
    Ok(plan)
}
pub fn ensure_host(state: &AppState, bytes: &[u8]) -> AppResult<PathBuf> {
    use sha2::Digest;
    if bytes.len() < 1024 {
        return Err(AppError::Unavailable(
            "The packaged server host is missing; rebuild SLH".into(),
        ));
    }
    let digest = hex::encode(sha2::Sha256::digest(bytes));
    let directory = state.paths.data.join("server-runtime").join(&digest[..20]);
    let exe = directory.join(if cfg!(windows) {
        "slh-server-host.exe"
    } else {
        "slh-server-host"
    });
    store::plain_path(&exe)?;
    if !exe.is_file() {
        store::atomic_write(&exe, bytes)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o700))?;
        }
    } else if providers::hash_file(&exe, Some("sha256"), Some(&digest)).is_err() {
        return Err(AppError::Security(
            "The installed server host was modified".into(),
        ));
    }
    Ok(exe)
}
pub async fn start(
    app: &Host,
    state: &AppState,
    id: &str,
    host_bytes: &[u8],
) -> AppResult<HostSnapshot> {
    let mut s = store::idle(state, id).await?;
    if s.presentation["readiness"]=="needs_setup" || s.presentation["readiness"]=="missing" {
        return Err(AppError::InvalidInput("The imported server requires configuration or its directory is unavailable".into()));
    }
    if !s.installed {
        s = providers::install(app, state, id).await?;
    }
    if !s.config.eula_accepted {
        return Err(AppError::InvalidInput(
            "Accept Minecraft EULA before starting".into(),
        ));
    }
    let port = s
        .config
        .properties
        .get("server-port")
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(25565);
    let ip = s
        .config
        .properties
        .get("server-ip")
        .filter(|v| !v.is_empty())
        .map(String::as_str)
        .unwrap_or("0.0.0.0");
    let probe = tokio::net::TcpListener::bind((ip, port))
        .await
        .map_err(|_| {
            AppError::Conflict(format!(
                "Server port {port} is already in use or the address is unavailable"
            ))
        })?;
    drop(probe);
    let claimed=sqlx::query("UPDATE local_servers SET status='starting' WHERE id=? AND status IN ('created','stopped','failed')").bind(id).execute(&state.database).await?.rows_affected();
    if claimed != 1 {
        return Err(AppError::Conflict("This server is already starting".into()));
    }
    let result: AppResult<HostSnapshot> = async {
        let launch = effective_plan(app, state, id).await?;
        let exe = ensure_host(state, host_bytes)?;
        let descriptor = run_file(state, id);
        if descriptor.exists() {
            store::plain_path(&descriptor)?;
            std::fs::remove_file(&descriptor)?;
        }
        let plan_file = descriptor.with_extension("plan.json");
        let log_file = Path::new(&s.path).join("slh-console.jsonl");
        // Each run starts a new sequence; retain the previous run for diagnostics.
        if log_file.exists() {
            store::plain_path(&log_file)?;
            let old = log_file.with_extension("previous.jsonl");
            if old.exists() {
                std::fs::remove_file(&old)?;
            }
            std::fs::rename(&log_file, old)?;
        }
        store::atomic_write(
            &plan_file,
            &serde_json::to_vec(&HostPlan {
                server_id: id.into(),
                launch,
                run_file: descriptor.clone(),
                log_file,
            })?,
        )?;
        let errors = std::fs::File::create(Path::new(&s.path).join("slh-host.log"))?;
        let mut cmd = std::process::Command::new(exe);
        cmd.arg("run")
            .arg(&plan_file)
            .current_dir(&s.path)
            .stdin(std::process::Stdio::null())
            .stdout(errors.try_clone()?)
            .stderr(errors);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }
        let mut child = cmd.spawn()?;
        for _ in 0..100 {
            if let Ok(info) = read_run(&descriptor) {
                if let Ok(snapshot) = request(&info, "status", "", 0).await {
                    return Ok(snapshot);
                }
            }
            if let Some(exit) = child.try_wait()? {
                return Err(AppError::Process(format!(
                    "Server host exited ({exit}); inspect slh-host.log"
                )));
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        Err(AppError::Process("Server host did not become ready".into()))
    }
    .await;
    match &result {
        Ok(snapshot) => store::set_status(state, id, &snapshot.state).await?,
        Err(_) => {
            store::set_status(
                state,
                id,
                if java_is_alive(state, id) {
                    "unmanaged"
                } else {
                    "failed"
                },
            )
            .await?;
        }
    }
    result
}
pub async fn poll(state: &AppState, id: &str, cursor: u64) -> AppResult<HostSnapshot> {
    let s = store::get(state, id).await?;
    let info = read_run(&run_file(state, id)).ok();
    if let Some(info) = &info {
        if let Ok(value) = request(&info, "status", "", cursor).await {
            return Ok(value);
        }
    }
    let log = Path::new(&s.path).join("slh-console.jsonl");
    store::plain_path(&log)?;
    let lines = saved_console(&log, cursor);
    let last_seq = lines.last().map(|l| l.seq).unwrap_or(cursor);
    Ok(HostSnapshot {
        run_id: info.as_ref().map(console_run_id),
        state: s.status,
        lines,
        last_seq,
        exit_code: info.and_then(|i| i.exit_code),
        error: None,
    })
}
pub async fn control(
    state: &AppState,
    id: &str,
    action: &str,
    command: &str,
) -> AppResult<HostSnapshot> {
    let _ = store::get(state, id).await?;
    if !["stop", "kill", "command"].contains(&action) {
        return Err(AppError::InvalidInput(
            "Invalid server control action".into(),
        ));
    }
    if command.len() > 4096 || command.contains(['\0', '\r', '\n']) {
        return Err(AppError::InvalidInput("Enter one server command".into()));
    }
    let info = read_run(&run_file(state, id))?;
    let response = match request(&info, action, command, u64::MAX).await {
        Ok(response) => response,
        Err(error)
            if action == "kill"
                && info.java_started > 0
                && process_identity(info.java_pid) == Some(info.java_started) =>
        {
            use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
            let pid = Pid::from_u32(info.java_pid);
            let mut system = System::new();
            system.refresh_processes_specifics(
                ProcessesToUpdate::Some(&[pid]),
                false,
                ProcessRefreshKind::nothing().without_tasks(),
            );
            let process = system.process(pid).ok_or(error)?;
            if process.start_time() != info.java_started || !process.kill() {
                return Err(AppError::Process(
                    "Could not terminate the verified unmanaged Java process".into(),
                ));
            }
            HostSnapshot {
                run_id: Some(console_run_id(&info)),
                state: "stopping".into(),
                lines: vec![],
                last_seq: 0,
                exit_code: None,
                error: None,
            }
        }
        Err(error) => return Err(error),
    };
    store::set_status(state, id, &response.state).await?;
    Ok(response)
}
pub async fn restart(
    app: &Host,
    state: &AppState,
    id: &str,
    bytes: &[u8],
) -> AppResult<HostSnapshot> {
    control(state, id, "stop", "").await?;
    for _ in 0..120 {
        if !java_is_alive(state, id) {
            store::set_status(state, id, "stopped").await?;
            return start(app, state, id, bytes).await;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    Err(AppError::Conflict(
        "The server is still saving; wait for it to stop before restarting".into(),
    ))
}
pub async fn script(app: &Host, state: &AppState, id: &str, overwrite: bool) -> AppResult<String> {
    let s = store::idle(state, id).await?;
    let plan = effective_plan(app, state, id).await?;
    let path = Path::new(&s.path).join(if cfg!(windows) {
        "start.bat"
    } else {
        "start.sh"
    });
    if path.exists() && !overwrite {
        return Err(AppError::Conflict(
            "Start script already exists; confirm replacement".into(),
        ));
    }
    store::atomic_write(&path, start_script(&plan, cfg!(windows))?.as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(path.to_string_lossy().into_owned())
}
pub async fn external_console(state: &AppState, id: &str, bytes: &[u8]) -> AppResult<()> {
    let _ = store::get(state, id).await?;
    let info = read_run(&run_file(state, id))?;
    request(&info, "status", "", 0).await?;
    let exe = ensure_host(state, bytes)?;
    let file = run_file(state, id);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new(exe)
            .arg("console")
            .arg(file)
            .creation_flags(0x00000010)
            .spawn()?;
    }
    #[cfg(target_os = "macos")]
    {
        let script = state
            .paths
            .data
            .join("server-runs")
            .join(format!("console-{id}.command"));
        let text = format!(
            "#!/bin/sh\nexec {} console {}\n",
            shell_quote(exe.to_str().unwrap_or("")),
            shell_quote(file.to_str().unwrap_or(""))
        );
        store::atomic_write(&script, text.as_bytes())?;
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700))?;
        std::process::Command::new("open")
            .args(["-a", "Terminal"])
            .arg(script)
            .spawn()?;
    }
    #[cfg(target_os = "linux")]
    {
        let terminal = providers::find_tool("x-terminal-emulator")
            .or_else(|| providers::find_tool("xterm"))
            .ok_or_else(|| {
                AppError::Unavailable(
                    "No system terminal was found; use the built-in console".into(),
                )
            })?;
        std::process::Command::new(terminal)
            .arg("-e")
            .arg(exe)
            .arg("console")
            .arg(file)
            .spawn()?;
    }
    Ok(())
}
