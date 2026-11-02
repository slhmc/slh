//! Horizon's dedicated engine, supervised by SLH rather than a second supervisor.
use super::{config::LaunchPlan, store::LocalServer};
use crate::{error::{AppError, AppResult}, host::Host, models::Instance, state::AppState};
use std::path::Path;

pub async fn reuse_prepared(state: &AppState, tag: &str, hash: &str, game: &str, release: &Path) -> AppResult<bool> {
    let mut roots: Vec<std::path::PathBuf> = sqlx::query_scalar::<_, String>("SELECT game_dir FROM instances WHERE loader_type='rust'").fetch_all(&state.database).await?
        .into_iter().filter_map(|p| Path::new(&p).parent().map(|p| p.join("horizon"))).collect();
    roots.extend(sqlx::query_scalar::<_, String>("SELECT path FROM local_servers WHERE json_extract(config_json,'$.core')='horizon'").fetch_all(&state.database).await?.into_iter().map(|p| Path::new(&p).join(".slh-horizon/horizon")));
    let tag = tag.to_owned(); let hash = hash.to_owned(); let game = game.to_owned(); let release = release.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let destination = release.join(".local/horizon-client").join(&game);
        for root in roots {
            let marker: serde_json::Value = std::fs::read(root.join("installed.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
            if marker["archiveSha256"].as_str() != Some(hash.as_str()) || marker["release"].as_str() != Some(tag.as_str()) { continue; }
            let source = root.join(&tag).join(".local/horizon-client").join(&game);
            if source == destination { continue; }
            let manifest: serde_json::Value = std::fs::read(source.join("horizon-resources.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
            if manifest["minecraft"].as_str() != Some(game.as_str()) || !source.join("registries.json").is_file() || !source.join("commands.json").is_file() { continue; }
            let mut valid = true; let mut checked = 0;
            if let Some(fields) = manifest.as_object() { for (key, files) in fields { if key.ends_with("files_sha256") { if let Some(files) = files.as_object() { for (name, expected) in files {
                let path = source.join(name);
                if expected.as_str().is_none_or(|v| v.len() != 64) || crate::security::validate_relative_path(Path::new(name)).is_err() || super::store::plain_path(&path).is_err() || super::providers::hash_file(&path, Some("sha256"), expected.as_str()).is_err() { valid = false; break; }
                checked += 1;
            } } } } }
            if !valid || checked == 0 { continue; }
            let entries = walkdir::WalkDir::new(&source).follow_links(false).into_iter().collect::<Result<Vec<_>, _>>().map_err(|e| AppError::Process(e.to_string()))?;
            if entries.iter().any(|e| e.file_type().is_symlink()) { continue; }
            for entry in entries { let target = destination.join(entry.path().strip_prefix(&source).unwrap());
                if entry.file_type().is_dir() { std::fs::create_dir_all(target)?; }
                else if entry.file_type().is_file() { super::store::plain_path(&target)?; std::fs::copy(entry.path(), target)?; }
            }
            return Ok(true);
        }
        Ok(false)
    }).await.map_err(|e| AppError::Process(e.to_string()))?
}

pub fn supported(tag: &str) -> bool {
    let parts = tag.trim_start_matches('v').split('.').map(str::parse::<u32>).collect::<Result<Vec<_>, _>>();
    matches!(parts, Ok(ref p) if p.len() == 3 && p[0] < 2026 && (p[0],p[1],p[2]) >= (0,2,95))
}

fn instance(server: &LocalServer) -> Instance {
    Instance {
        id: server.id.clone(), name: server.name.clone(), group_id: None, icon_path: None,
        folder_name: String::new(), icon_key: "cube".into(), icon_background: None, icon_foreground: None,
        minecraft_version: server.config.minecraft_version.clone(), loader_type: "horizon-server".into(),
        loader_version: Some(server.config.core_version.clone()), status: "installing".into(), created_at: String::new(),
        last_played_at: None, last_launched_at: None, playtime_seconds: 0,
        java_path: server.config.java_path.clone(), memory_min_mb: server.config.memory_min_mb.into(),
        memory_max_mb: server.config.memory_max_mb.into(), config_schema_version: 1, bedrock_profile_mode: "shared".into(),
        game_dir: Path::new(&server.path).join(".slh-horizon/game").to_string_lossy().into_owned(),
    }
}

pub async fn install(app: &Host, state: &AppState, server: &LocalServer) -> AppResult<LaunchPlan> {
    super::store::validate_server_path("horizon", Path::new(&server.path))?;
    let instance = instance(server);
    if !supported(&server.config.core_version) { return Err(AppError::Unavailable("Select a supported Horizon server release (v0.2.95 or newer)".into())); }
    super::store::plain_path(&crate::minecraft::horizon::root(&instance)?)?;
    let result = crate::minecraft::horizon::install(app, state, &instance, &server.id).await;
    let _ = app.send(crate::host::CoreEvent::Progress(crate::models::ProgressEvent {
        operation_id: server.id.clone(), instance_id: None, operation: "server-install".into(),
        stage: if result.is_ok() { "complete" } else { "failed" }.into(),
        message: if result.is_ok() { "Horizon server resources are ready".into() } else { "Horizon server installation failed".into() },
        completed: u64::from(result.is_ok()), total: Some(1), downloaded_bytes: None, total_bytes: None,
    }));
    result?;
    plan(server)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn native_server_uses_dedicated_engine_and_obeys_shared_toggle() {
        let root = tempfile::tempdir().unwrap();
        let paths = crate::portable::PortablePaths::from_executable(&root.path().join("SLH.exe"), Some(root.path().to_path_buf())).unwrap();
        let state = AppState::initialize_isolated_at(paths).await.unwrap();
        let config = super::super::config::ServerConfig { core: "horizon".into(), minecraft_version: "26.3".into(), core_version: "v0.2.97".into(),
            eula_accepted: true, java_path: Some(std::env::current_exe().unwrap().to_string_lossy().into_owned()), ..Default::default() };
        let request = || super::super::store::CreateServer { name: "Rust server".into(), folder: "rust-server".into(), group_id: None, config: config.clone() };
        assert!(super::super::store::create(&state, request()).await.is_err());
        let mut general = crate::database::setting(&state.database, "general").await.unwrap();
        general["rustMinecraft"] = true.into();
        crate::database::set_setting(&state.database, "general", &general).await.unwrap();
        let created = super::super::store::create(&state, request()).await;
        if !cfg!(all(target_os = "windows", target_arch = "x86_64")) {
            assert!(matches!(created, Err(AppError::Unavailable(_))), "unsupported platforms must reject the native engine");
            state.database.close().await;
            return;
        }
        let server = created.unwrap();
        std::fs::write(Path::new(&server.path).join("server.properties"), "server-port=25568\n").unwrap();
        assert_eq!(super::super::store::get(&state, &server.id).await.unwrap().config.properties["server-port"], "25568");
        std::fs::write(Path::new(&server.path).join("server.properties"), "server-port=25565\n").unwrap();
        assert_eq!(super::super::store::get(&state, &server.id).await.unwrap().config.properties["server-port"], "25565");
        let private = crate::minecraft::horizon::root(&instance(&server)).unwrap();
        let release = private.join("v0.2.97");
        std::fs::create_dir_all(release.join(".local/horizon-client/26.3")).unwrap();
        std::fs::write(private.join("installed.json"), br#"{"release":"v0.2.97","minecraft":"26.3"}"#).unwrap();
        std::fs::write(release.join("horizon-client.exe"), b"fixture").unwrap();
        std::fs::write(release.join(".local/horizon-client/26.3/horizon-resources.json"), b"{}").unwrap();
        let plan = super::super::runtime::effective_plan(&Host::silent(), &state, &server.id).await.unwrap();
        assert_eq!(plan.required_java, 0);
        assert!(plan.java.ends_with("horizon-client.exe"));
        assert!(plan.args.contains(&"--dedicated".into()));
        assert!(plan.args.contains(&"--nogui".into()));
        assert!(!plan.args.iter().any(|a| a.starts_with("-Xm") || a == "-jar"));
        let script = super::super::config::start_script(&plan, true).unwrap();
        assert!(script.contains("HORIZON_HOME=%CD%"));
        assert!(script.contains("--dedicated"));
        use sha2::Digest;
        let hash = hex::encode(sha2::Sha256::digest(b"{}"));
        let resources = release.join(".local/horizon-client/26.3");
        for file in ["registries.json", "commands.json"] { std::fs::write(resources.join(file), b"{}").unwrap(); }
        std::fs::write(resources.join("horizon-resources.json"), serde_json::to_vec(&serde_json::json!({"minecraft":"26.3","files_sha256":{"registries.json":hash,"commands.json":hash}})).unwrap()).unwrap();
        std::fs::write(private.join("installed.json"), br#"{"release":"v0.2.97","minecraft":"26.3","archiveSha256":"fixture-archive"}"#).unwrap();
        assert!(reuse_prepared(&state, "v0.2.97", "fixture-archive", "26.3", &root.path().join("copied-release")).await.unwrap());
        assert_eq!(std::fs::read(root.path().join("copied-release/.local/horizon-client/26.3/commands.json")).unwrap(), b"{}");
        std::fs::write(resources.join("commands.json"), b"damaged").unwrap();
        assert!(!reuse_prepared(&state, "v0.2.97", "fixture-archive", "26.3", &root.path().join("invalid-release")).await.unwrap());
        general["rustMinecraft"] = false.into();
        crate::database::set_setting(&state.database, "general", &general).await.unwrap();
        assert!(super::super::runtime::effective_plan(&Host::silent(), &state, &server.id).await.is_err());
        state.database.close().await;
    }
}

pub fn plan(server: &LocalServer) -> AppResult<LaunchPlan> {
    let instance = instance(server);
    crate::minecraft::horizon::validate(&instance.minecraft_version)?;
    if !crate::minecraft::horizon_catalog::valid_tag(&server.config.core_version) {
        return Err(AppError::InvalidInput("Select a Horizon release before installing the server".into()));
    }
    let root = crate::minecraft::horizon::root(&instance)?;
    let installed: serde_json::Value = serde_json::from_slice(&std::fs::read(root.join("installed.json"))?)?;
    if installed["release"].as_str() != Some(server.config.core_version.as_str())
        || installed["minecraft"].as_str() != Some(server.config.minecraft_version.as_str()) {
        return Err(AppError::Conflict("Reinstall the selected Horizon server release".into()));
    }
    let release = root.join(&server.config.core_version);
    let executable = release.join("horizon-client.exe");
    let resources = release.join(".local/horizon-client").join(&server.config.minecraft_version);
    if !executable.is_file() || !resources.join("horizon-resources.json").is_file() {
        return Err(AppError::NotFound("Horizon server engine or resources; reinstall the core".into()));
    }
    Ok(LaunchPlan { java: executable.to_string_lossy().into_owned(), required_java: 0,
        args: vec!["--resources".into(), resources.to_string_lossy().into_owned(), "--dedicated".into(), "--nogui".into()],
        directory: server.path.clone() })
}
