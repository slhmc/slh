//! Opt-in process-lifetime and standalone-script checks for an isolated installed server.
use slh_core::{
    host::Host,
    local_servers::{host, runtime, store},
    portable::PortablePaths,
    state::AppState,
};
use std::path::{Path, PathBuf};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    let root = std::fs::canonicalize(PathBuf::from(args.get(1).ok_or("isolated root required")?))?;
    if !root.join(".server-test-root").is_file() {
        return Err("test marker required".into());
    }
    let paths = PortablePaths::from_executable(&root.join("slh-test.exe"), Some(root.clone()))?;
    let mut state = AppState::initialize_isolated_at(paths.clone()).await?;
    let app = Host::silent();
    let mut server = store::list(&state)
        .await?
        .into_iter()
        .find(|s| s.installed)
        .or_else(|| None);
    if server.is_none() {
        server = store::list(&state)
            .await?
            .into_iter()
            .find(|s| s.status == "failed");
    }
    let mut server = server.ok_or("no server profile")?;
    println!("PROFILE {} status={} run={}", server.id, server.status, runtime::run_file(&state,&server.id).display());
    if let Err(error)=host::read_run(&runtime::run_file(&state,&server.id)) { println!("DESCRIPTOR {error}"); }
    if ["paper", "purpur", "spigot", "bukkit"].contains(&server.config.core.as_str()) && server.path.contains(['!', '+']) {
        let folder = Path::new(&server.path)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .replace(['!', '+'], "_");
        server = store::move_server(&state, &server.id, server.group_id.clone(), &folder).await?;
    }
    if !server.installed {
        server = slh_core::local_servers::providers::install(&app, &state, &server.id).await?;
    }
    let host = std::fs::read(args.get(2).ok_or("host path required")?)?;
    let script = runtime::script(&app, &state, &server.id, true).await?;
    runtime::start(&app, &state, &server.id, &host).await?;
    let info = host::read_run(&runtime::run_file(&state, &server.id))?;
    drop(state);
    state = AppState::initialize_isolated_at(paths).await?;
    let outcome: Result<(), Box<dyn std::error::Error>> = async {
        let mut ready = false;
        for _ in 0..120 {
            let snapshot = runtime::poll(&state, &server.id, 0).await?;
            if snapshot.state == "running" {
                ready = true;
                break;
            }
            if snapshot.state == "failed" {
                return Err(format!("start failed: {:?}", snapshot.error).into());
            }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
        if !ready {
            return Err("reattached server never became ready".into());
        }
        let after = host::read_run(&runtime::run_file(&state, &server.id))?;
        assert_eq!(info.java_pid, after.java_pid);
        assert!(
            runtime::start(&app, &state, &server.id, &host)
                .await
                .is_err()
        );
        assert!(!runtime::poll(&state, &server.id, 0).await?.lines.is_empty());
        println!(
            "PASS reattached to Java {} with console history",
            after.java_pid
        );
        Ok(())
    }
    .await;
    let _ = runtime::control(&state, &server.id, "stop", "").await;
    for _ in 0..90 {
        if !runtime::java_is_alive(&state, &server.id) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
    if runtime::java_is_alive(&state, &server.id) {
        return Err("Java did not stop gracefully".into());
    }
    outcome?;
    assert!(Path::new(&server.path).join("world/level.dat").is_file());
    // This launch uses only the exported script and Java, with no SLH host.
    let normal_script = script.strip_prefix("\\\\?\\").unwrap_or(&script);
    let mut command = if cfg!(windows) {
        let mut c = tokio::process::Command::new("cmd.exe");
        c.args(["/d", "/s", "/c"]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            c.as_std_mut().raw_arg(format!("\"\"{normal_script}\"\""));
        }
        c
    } else {
        let mut c = tokio::process::Command::new("sh");
        c.arg(normal_script);
        c
    };
    let mut child = command
        .current_dir(&server.path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let mut input = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let (tx, mut lines) = tokio::sync::mpsc::channel(512);
    let out_tx=tx.clone();
    tokio::spawn(async move {
        let mut reader=tokio::io::BufReader::new(stdout).lines();
        while let Ok(Some(line))=reader.next_line().await { if out_tx.send(line).await.is_err() {break;} }
    });
    tokio::spawn(async move {
        let mut reader=tokio::io::BufReader::new(stderr).lines();
        while let Ok(Some(line))=reader.next_line().await { if tx.send(line).await.is_err() {break;} }
    });
    let ready = tokio::time::timeout(std::time::Duration::from_secs(120), async {
        while let Some(line) = lines.recv().await {
            println!("{line}");
            if line.contains("Done (") {
                return true;
            }
        }
        false
    }).await.unwrap_or(false);
    if !ready {
        let _=input.write_all(b"stop\n").await;
        let _=tokio::time::timeout(std::time::Duration::from_secs(30),child.wait()).await;
        return Err("standalone script failed before readiness".into());
    }
    assert!(!runtime::java_is_alive(&state, &server.id));
    input.write_all(b"stop\n").await?;
    input.flush().await?;
    tokio::spawn(async move { while lines.recv().await.is_some() {} });
    let status = tokio::time::timeout(std::time::Duration::from_secs(90), child.wait()).await??;
    if !status.success() {
        return Err(format!("standalone exit {status}").into());
    }
    println!(
        "PASS {} standalone script, saved world and graceful stop",
        server.config.core
    );
    Ok(())
}
