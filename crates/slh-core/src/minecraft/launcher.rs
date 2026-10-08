use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

use crate::host::Host;
use chrono::Utc;
use tokio::process::Command;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::accounts::AccountLaunchCredentials;
use crate::database;
use crate::error::{AppError, AppResult};
use crate::models::{Instance, LaunchResponse};
use crate::state::AppState;

use super::java;
use super::types::{Argument, ArgumentValue, VersionDetails, maven_download, rules_allow_for};

/// A short connection probe prevents an expired online token from blocking an
/// intentionally offline game. Use endpoints the launcher already needs,
/// rather than Microsoft's captive-portal host, which is commonly blocked by
/// DNS filters despite Minecraft services being reachable. Any HTTPS response
/// counts as connectivity; only DNS, TLS, or connection failure selects the
/// offline path.
async fn internet_available(state: &AppState) -> bool {
    const PROBES: [&str; 2] = [
        "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
        "https://api.minecraftservices.com/minecraft/profile",
    ];

    // Probe both endpoints concurrently. This keeps a transient/offline
    // connection from adding two sequential four-second waits to every
    // online-account launch while avoiding a request to a single host being
    // a hard dependency for the result.
    let first = {
        let client = state.http.clone();
        async move {
            tokio::time::timeout(
                std::time::Duration::from_secs(2),
                client.get(PROBES[0]).send(),
            )
            .await
            .is_ok_and(|result| result.is_ok())
        }
    };
    let second = {
        let client = state.http.clone();
        async move {
            tokio::time::timeout(
                std::time::Duration::from_secs(2),
                client.get(PROBES[1]).send(),
            )
            .await
            .is_ok_and(|result| result.is_ok())
        }
    };
    let (first, second) = tokio::join!(first, second);
    first || second
}

pub async fn launch_instance(
    app: &Host,
    state: &AppState,
    instance_id: &str,
    offline_username: Option<&str>,
) -> AppResult<LaunchResponse> {
    let instance = database::instance(&state.database, instance_id).await?;
    if instance.loader_type == "bedrock" {
        crate::settings::ensure_bedrock_enabled(&state.database).await?;
        return super::bedrock_runtime::launch_instance(app, state, instance_id).await;
    }
    crate::sync::run_for_instance(state, &instance, crate::sync::SyncPhase::Pull).await?;
    {
        let mut running = state.running_instances.write().await;
        if !running.insert(instance_id.to_owned()) {
            return Err(AppError::Conflict(
                "This instance is already running".into(),
            ));
        }
    }
    // Persist the in-flight state before Java discovery or account work. This
    // keeps every library view in sync even if its React component unmounts
    // while the launch preparation is still running.
    sqlx::query("UPDATE instances SET status = 'launching' WHERE id = ? AND status = 'installed'")
        .bind(instance_id)
        .execute(&state.database)
        .await?;
    let _ = app.emit(
        crate::host::EventKind::LaunchState,
        serde_json::json!({
            "instanceId": instance_id,
            "state": "launching"
        }),
    );
    let result = prepare_and_spawn(app, state, instance_id, offline_username).await;
    if result.is_err() {
        state.running_instances.write().await.remove(instance_id);
        state.launch_processes.write().await.remove(instance_id);
        state.kill_requested.write().await.remove(instance_id);
        let _ = sqlx::query(
            "UPDATE instances SET status = 'installed' WHERE id = ? AND status = 'launching'",
        )
        .bind(instance_id)
        .execute(&state.database)
        .await;
        let _ = app.emit(
            crate::host::EventKind::LaunchState,
            serde_json::json!({
                "instanceId": instance_id,
                "state": "launch-failed"
            }),
        );
    }
    result
}

/// Stop a running Minecraft process, including children it may have spawned.
/// This mirrors PrismLauncher's Kill action: there is no confirmation dialog,
/// and the normal launch completion path still records the exit and restores
/// the launcher window.
pub async fn kill_instance(state: &AppState, instance_id: &str) -> AppResult<()> {
    let pid = state
        .launch_processes
        .read()
        .await
        .get(instance_id)
        .copied()
        .ok_or_else(|| AppError::Conflict("This instance is not running".into()))?;

    state
        .kill_requested
        .write()
        .await
        .insert(instance_id.to_owned());

    #[cfg(windows)]
    let result = {
        Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x08000000)
            .status()
            .await
    };
    #[cfg(not(windows))]
    let result = Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .status()
        .await;

    match result {
        Ok(status) if status.success() => {
            // A process restored after SLH was restarted has no waiter task
            // left to finalize its launch history. Mark it stopped here; the
            // original waiter uses the same terminal state and remains safe
            // to run when it exists.
            let ended_at = Utc::now().to_rfc3339();
            sqlx::query(
                "UPDATE launch_history SET ended_at = ?, result = 'killed' \
                 WHERE instance_id = ? AND result = 'running' AND ended_at IS NULL",
            )
            .bind(&ended_at)
            .bind(instance_id)
            .execute(&state.database)
            .await?;
            sqlx::query(
                "UPDATE instances SET status = 'installed' WHERE id = ? AND status = 'running'",
            )
            .bind(instance_id)
            .execute(&state.database)
            .await?;
            state.running_instances.write().await.remove(instance_id);
            state.launch_processes.write().await.remove(instance_id);
            Ok(())
        }
        Ok(status) => {
            state.kill_requested.write().await.remove(instance_id);
            Err(AppError::Process(format!(
                "Could not stop Minecraft process {pid} (exit code {:?})",
                status.code()
            )))
        }
        Err(error) => {
            state.kill_requested.write().await.remove(instance_id);
            Err(AppError::Process(format!(
                "Could not stop Minecraft process {pid}: {error}"
            )))
        }
    }
}

/// Reconcile processes that were launched by a previous SLH process. This is
/// also used for launches without an active Tokio waiter after the launcher
/// window was closed while Minecraft remained open.
pub async fn reconcile_running_instances(app: &Host, state: &AppState) -> AppResult<()> {
    if let Err(error) = super::bedrock_runtime::recover_profile_journals(&state.paths) {
        tracing::warn!(%error, "Bedrock profile journal recovery is pending");
    }
    let processes = state.launch_processes.read().await.clone();
    for (instance_id, pid) in processes {
        if process_is_alive(pid) {
            continue;
        }
        let ended_at = Utc::now().to_rfc3339();
        sqlx::query(
            "UPDATE launch_history SET ended_at = ?, result = 'exited' \
             WHERE instance_id = ? AND result = 'running' AND ended_at IS NULL",
        )
        .bind(&ended_at)
        .bind(&instance_id)
        .execute(&state.database)
        .await?;
        sqlx::query(
            "UPDATE instances SET status = 'installed' WHERE id = ? AND status = 'running'",
        )
        .bind(&instance_id)
        .execute(&state.database)
        .await?;
        state.running_instances.write().await.remove(&instance_id);
        state.launch_processes.write().await.remove(&instance_id);
        state.kill_requested.write().await.remove(&instance_id);
        let _ = app.emit(
            crate::host::EventKind::LaunchState,
            serde_json::json!({ "instanceId": instance_id, "state": "exited" }),
        );
    }
    Ok(())
}

fn process_is_alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        unsafe {
            let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                return false;
            };
            let mut code = 0;
            let alive = GetExitCodeProcess(handle, &mut code).is_ok() && code == 259; // STILL_ACTIVE
            let _ = CloseHandle(handle);
            return alive;
        }
    }
    #[cfg(unix)]
    {
        return std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .is_ok_and(|status| status.success());
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = pid;
        false
    }
}

async fn prepare_and_spawn(
    app: &Host,
    state: &AppState,
    instance_id: &str,
    offline_username: Option<&str>,
) -> AppResult<LaunchResponse> {
    let instance = database::instance(&state.database, instance_id).await?;
    if instance.status != "installed" && instance.status != "launching" {
        return Err(AppError::Conflict(format!(
            "{} is not installed yet. Current status: {}",
            instance.name, instance.status
        )));
    }
    let account = match database::active_account(&state.database).await? {
        Some(account) => account,
        None => {
            // Keep old portable databases usable even when their active marker was
            // malformed by an early build. Selecting the first listed account
            // restores the invariant that exactly one account is active.
            let fallback = database::accounts(&state.database)
                .await?
                .into_iter()
                .next();
            let Some(fallback) = fallback else {
                return Err(AppError::Conflict(
                    "Select or add an account before launching".into(),
                ));
            };
            crate::accounts::activate_account(&state.database, &fallback.id).await?
        }
    };
    let general = database::setting(&state.database, "general").await?;
    let hide_on_launch = general
        .get("hideOnLaunch")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let restore_on_exit = general
        .get("restoreOnExit")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(true);
    let use_offline_fallback = account.provider != "offline" && !internet_available(state).await;
    let credentials = if use_offline_fallback {
        let automatic = general
            .get("offlineFallbackWhenOffline")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(true);
        let username = if automatic {
            account.username.as_str()
        } else {
            offline_username.ok_or_else(|| {
                AppError::OfflineAccountNameRequired(
                    "No internet connection was detected. Enter a Minecraft name for this temporary offline launch.".into(),
                )
            })?
        };
        tracing::info!(account_id = %account.id, provider = %account.provider, username, "launching with temporary offline credentials because no internet connection is available");
        crate::accounts::offline_launch_credentials(username)?
    } else {
        crate::accounts::launch_credentials(state, &account).await?
    };
    let instance_root = PathBuf::from(&instance.game_dir)
        .parent()
        .ok_or_else(|| AppError::InvalidInput("Instance game directory has no parent".into()))?
        .to_path_buf();
    let version_root = instance_root
        .join("versions")
        .join(&instance.minecraft_version);
    let details: VersionDetails =
        serde_json::from_slice(&tokio::fs::read(version_root.join("version.json")).await?)?;
    let required_java = details
        .java_version
        .as_ref()
        .map(|value| value.major_version);
    let selected_java = if let Some(path) = &instance.java_path {
        let inspected = java::inspect(Path::new(path)).await?;
        if required_java.is_some_and(|required| inspected.major_version < required) {
            return Err(AppError::Conflict(format!(
                "Java {} or newer is required, but {} is Java {}",
                required_java.unwrap_or_default(),
                path,
                inspected.major_version
            )));
        }
        inspected
    } else {
        let detected = java::discover_fast(state, required_java)
            .await?
            .into_iter()
            .find(|candidate| candidate.compatible);
        match detected {
            Some(runtime) => runtime,
            None => java::install_compatible_managed(app, state, required_java).await?,
        }
    };
    let runtime_target = crate::platform::RuntimeTarget {
        os: crate::platform::OperatingSystem::current(),
        java_arch: crate::platform::Architecture::from_java(&selected_java.architecture)?,
    };
    if let Ok(bytes) = tokio::fs::read(
        instance_root
            .join("natives")
            .join(&details.id)
            .join("runtime-target.json"),
    )
    .await
    {
        let installed: crate::platform::RuntimeTarget = serde_json::from_slice(&bytes)?;
        if installed != runtime_target {
            return Err(AppError::Conflict("Selected Java architecture or OS differs from installed native libraries; reinstall the instance for this runtime".into()));
        }
    }
    let arguments = build_launch_arguments(
        state,
        &instance,
        &credentials,
        &details,
        &version_root,
        crate::platform::RuntimeTarget {
            os: crate::platform::OperatingSystem::current(),
            java_arch: crate::platform::Architecture::from_java(&selected_java.architecture)?,
        },
    )?;
    let launch_id = Uuid::new_v4().to_string();
    let log_path = instance_root
        .join("logs")
        .join(format!("launch-{}.log", Utc::now().format("%Y%m%d-%H%M%S")));
    let log = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .await?;
    let log = Arc::new(Mutex::new(log));
    let started_at = Utc::now();

    let mut command = Command::new(&selected_java.path);
    command
        .args(&arguments)
        .current_dir(&instance.game_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .kill_on_drop(false);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.as_std_mut().creation_flags(0x08000000);
    }
    let mut child = command.spawn().map_err(|error| {
        AppError::Process(format!(
            "Could not start Java {}: {error}",
            selected_java.path
        ))
    })?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Process("Java stdout pipe was not created".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::Process("Java stderr pipe was not created".into()))?;
    let process_id = if let Some(pid) = child.id() {
        state
            .launch_processes
            .write()
            .await
            .insert(instance.id.clone(), pid);
        pid
    } else {
        return Err(AppError::Process(
            "Java process did not expose a PID".into(),
        ));
    };
    let completion_log = log.clone();
    let stdout_pump = tokio::spawn(crate::console::pump(
        stdout,
        app.clone(),
        launch_id.clone(),
        instance.id.clone(),
        "stdout",
        log.clone(),
    ));
    let stderr_pump = tokio::spawn(crate::console::pump(
        stderr,
        app.clone(),
        launch_id.clone(),
        instance.id.clone(),
        "stderr",
        log,
    ));
    sqlx::query(
        "INSERT INTO launch_history(id, instance_id, account_id, started_at, result, log_path, process_id) \
         VALUES (?, ?, ?, ?, 'running', ?, ?)",
    )
    .bind(&launch_id)
    .bind(&instance.id)
    .bind(&account.id)
    .bind(started_at.to_rfc3339())
    .bind(log_path.to_string_lossy().into_owned())
    .bind(i64::from(process_id))
    .execute(&state.database)
    .await?;
    sqlx::query("UPDATE instances SET status = 'running', last_launched_at = ? WHERE id = ?")
        .bind(started_at.to_rfc3339())
        .bind(&instance.id)
        .execute(&state.database)
        .await?;
    let _ = app.emit(
        crate::host::EventKind::LaunchState,
        serde_json::json!({
            "launchId": launch_id,
            "instanceId": instance.id,
            "state": "running"
        }),
    );

    if hide_on_launch {
        if let Some(window) = app.window() {
            if let Err(error) = window.hide() {
                tracing::warn!(%error, "could not hide launcher after Minecraft started");
            }
        }
    }

    let response = LaunchResponse {
        launch_id: launch_id.clone(),
        instance_id: instance.id.clone(),
        status: "running".into(),
        log_path: log_path.to_string_lossy().into_owned(),
        used_offline_fallback: use_offline_fallback,
    };
    let app = app.clone();
    let state = state.clone();
    let instance_id = instance.id.clone();
    tokio::spawn(async move {
        let status = child.wait().await;
        for pump in [stdout_pump, stderr_pump] {
            match pump.await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => tracing::warn!(%error, "console stream ended with an error"),
                Err(error) => tracing::warn!(%error, "console stream task failed"),
            }
        }
        let ended_at = Utc::now();
        let duration = (ended_at - started_at).num_seconds().max(0);
        let (exit_code, result) = match status {
            Ok(status) if status.success() => (status.code(), "exited"),
            Ok(status) => (status.code(), "crashed"),
            Err(_) => (None, "crashed"),
        };
        let was_killed = state.kill_requested.write().await.remove(&instance_id);
        let result = if was_killed { "killed" } else { result };
        let completion = match exit_code {
            Some(code) => format!("Process exited with code {code}."),
            None => "Process ended without an exit code.".into(),
        };
        if let Err(error) = crate::console::append_system_line(&completion_log, completion).await {
            tracing::warn!(%error, "could not append launcher completion to console log");
        }
        let _ = sqlx::query(
            "UPDATE launch_history SET ended_at = ?, duration_seconds = ?, exit_code = ?, result = ? WHERE id = ?",
        )
        .bind(ended_at.to_rfc3339())
        .bind(duration)
        .bind(exit_code)
        .bind(result)
        .bind(&launch_id)
        .execute(&state.database)
        .await;
        let _ = sqlx::query(
            "UPDATE instances SET status = 'installed', last_played_at = ?, \
             playtime_seconds = playtime_seconds + ? WHERE id = ?",
        )
        .bind(ended_at.to_rfc3339())
        .bind(duration)
        .bind(&instance_id)
        .execute(&state.database)
        .await;
        state.running_instances.write().await.remove(&instance_id);
        state.launch_processes.write().await.remove(&instance_id);
        if let Ok(instance) = database::instance(&state.database, &instance_id).await {
            if let Err(error) =
                crate::sync::run_for_instance(&state, &instance, crate::sync::SyncPhase::Push).await
            {
                tracing::error!(%error, %instance_id, "post-exit sync failed");
                let _ = app.emit(
                    crate::host::EventKind::SyncError,
                    serde_json::json!({
                        "instanceId": instance_id,
                        "message": error.to_string()
                    }),
                );
            }
        }
        let _ = app.emit(
            crate::host::EventKind::LaunchState,
            serde_json::json!({
                "launchId": launch_id,
                "instanceId": instance_id,
                "state": result,
                "exitCode": exit_code,
                "durationSeconds": duration
            }),
        );
        if hide_on_launch && restore_on_exit {
            if let Some(window) = app.window() {
                if let Err(error) = window.show() {
                    tracing::warn!(%error, "could not restore launcher after Minecraft exited");
                } else if let Err(error) = window.set_focus() {
                    tracing::warn!(%error, "could not focus launcher after Minecraft exited");
                }
            }
        }
    });
    Ok(response)
}

fn build_launch_arguments(
    state: &AppState,
    instance: &Instance,
    credentials: &AccountLaunchCredentials,
    details: &VersionDetails,
    version_root: &Path,
    target: crate::platform::RuntimeTarget,
) -> AppResult<Vec<String>> {
    let instance_root = PathBuf::from(&instance.game_dir)
        .parent()
        .ok_or_else(|| AppError::InvalidInput("Instance game directory has no parent".into()))?
        .to_path_buf();
    let natives = instance_root.join("natives").join(&details.id);
    let libraries_root = state.paths.cache.join("minecraft").join("libraries");
    let assets_root = state.paths.cache.join("minecraft").join("assets");
    let mut classpath = Vec::<String>::new();
    for library in &details.libraries {
        if !rules_allow_for(&library.rules, true, target) {
            continue;
        }
        let artifact = library.downloads.artifact.clone().or_else(|| {
            (library.natives.is_none() && library.downloads.classifiers.is_empty())
                .then(|| maven_download(&library.name, library.url.as_deref(), None))
                .flatten()
        });
        if let Some(artifact) = artifact {
            if let Some(relative) = &artifact.path {
                classpath.push(libraries_root.join(relative).to_string_lossy().into_owned());
            }
        }
    }
    classpath.push(
        version_root
            .join(format!("{}.jar", details.id))
            .to_string_lossy()
            .into_owned(),
    );
    let separator = if cfg!(windows) { ";" } else { ":" };
    let classpath = classpath.join(separator);
    let uuid_no_hyphens = credentials.uuid.replace('-', "");
    let mut values = HashMap::<String, String>::new();
    values.insert(
        "${natives_directory}".into(),
        natives.to_string_lossy().into_owned(),
    );
    values.insert("${launcher_name}".into(), "SLH".into());
    values.insert(
        "${launcher_version}".into(),
        env!("CARGO_PKG_VERSION").into(),
    );
    values.insert("${classpath}".into(), classpath.clone());
    values.insert("${classpath_separator}".into(), separator.into());
    values.insert(
        "${library_directory}".into(),
        libraries_root.to_string_lossy().into_owned(),
    );
    values.insert("${auth_player_name}".into(), credentials.username.clone());
    values.insert("${version_name}".into(), details.id.clone());
    values.insert("${game_directory}".into(), instance.game_dir.clone());
    values.insert(
        "${assets_root}".into(),
        assets_root.to_string_lossy().into_owned(),
    );
    values.insert(
        "${assets_index_name}".into(),
        details.asset_index.id.clone(),
    );
    values.insert("${auth_uuid}".into(), uuid_no_hyphens);
    values.insert(
        "${auth_access_token}".into(),
        credentials.access_token.clone(),
    );
    values.insert("${clientid}".into(), String::new());
    values.insert("${auth_xuid}".into(), String::new());
    values.insert("${user_type}".into(), credentials.user_type.clone());
    values.insert("${version_type}".into(), "SLH".into());
    values.insert("${resolution_width}".into(), "1280".into());
    values.insert("${resolution_height}".into(), "720".into());

    let mut arguments = vec![
        format!("-Xms{}M", instance.memory_min_mb),
        format!("-Xmx{}M", instance.memory_max_mb),
    ];
    arguments.extend(credentials.extra_jvm_arguments.iter().cloned());
    if let Some(version_arguments) = &details.arguments {
        arguments.extend(expand_arguments(&version_arguments.jvm, &values, target));
    } else {
        arguments.push(format!("-Djava.library.path={}", natives.to_string_lossy()));
        arguments.push("-cp".into());
        arguments.push(classpath);
    }
    if let Some(logging) = &details.logging {
        let log_config = assets_root
            .join("log_configs")
            .join(logging.client.file.path.as_deref().unwrap_or("client.xml"));
        arguments.push(
            logging
                .client
                .argument
                .replace("${path}", &log_config.to_string_lossy()),
        );
    }
    if target.os == crate::platform::OperatingSystem::MacOs
        && !arguments.iter().any(|argument| argument == "-XstartOnFirstThread") {
        arguments.push("-XstartOnFirstThread".into());
    }
    arguments.push(details.main_class.clone());
    if let Some(version_arguments) = &details.arguments {
        arguments.extend(expand_arguments(&version_arguments.game, &values, target));
    } else if let Some(legacy) = &details.minecraft_arguments {
        let parsed = shlex::split(legacy).ok_or_else(|| {
            AppError::InvalidInput("Legacy Minecraft arguments contain invalid quoting".into())
        })?;
        arguments.extend(
            parsed
                .into_iter()
                .map(|value| replace_values(value, &values)),
        );
    }
    Ok(arguments)
}

fn expand_arguments(
    arguments: &[Argument],
    values: &HashMap<String, String>,
    target: crate::platform::RuntimeTarget,
) -> Vec<String> {
    let mut result = Vec::new();
    for argument in arguments {
        match argument {
            Argument::Plain(value) => result.push(replace_values(value.clone(), values)),
            Argument::Conditional(conditional)
                if rules_allow_for(&conditional.rules, true, target) =>
            {
                match &conditional.value {
                    ArgumentValue::One(value) => {
                        result.push(replace_values(value.clone(), values));
                    }
                    ArgumentValue::Many(items) => result.extend(
                        items
                            .iter()
                            .cloned()
                            .map(|value| replace_values(value, values)),
                    ),
                }
            }
            Argument::Conditional(_) => {}
        }
    }
    result
}

fn replace_values(mut input: String, values: &HashMap<String, String>) -> String {
    for (placeholder, value) in values {
        input = input.replace(placeholder, value);
    }
    input
}
