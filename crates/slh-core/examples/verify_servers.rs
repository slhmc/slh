//! Opt-in integration probe. Always uses a separate data root supplied by the tester.
use slh_core::{
    host::Host,
    local_servers::{config::ServerConfig, providers, runtime, store},
    portable::PortablePaths,
    state::AppState,
};
use std::path::{Path, PathBuf};

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 4 {
        return Err("Usage: verify_servers <isolated-root> <catalog|exercise|jdk> <core|major> [minecraft] [host-exe]".into());
    }
    let root = std::fs::canonicalize(&args[1])?;
    if root == Path::new("E:/SLH") || !root.join(".server-test-root").is_file() {
        return Err("An isolated root with .server-test-root marker is required".into());
    }
    let paths = PortablePaths::from_executable(&root.join("slh-test.exe"), Some(root.clone()))?;
    let state = AppState::initialize_isolated_at(paths).await?;
    let app = Host::silent();
    if args[2] == "jdk" {
        let java =
            slh_core::minecraft::java::install_managed_kind(&app, &state, args[3].parse()?, "jdk")
                .await?;
        println!("JDK {} {}", java.major_version, java.path);
        return Ok(());
    }
    let mc = args.get(4).map(String::as_str).unwrap_or("1.21.4");
    let catalog = providers::catalog(&state, &args[3], Some(mc)).await?;
    println!(
        "{}: {} versions, builds {:?}",
        args[3],
        catalog.minecraft_versions.len(),
        catalog
            .versions
            .iter()
            .take(3)
            .map(|v| &v.id)
            .collect::<Vec<_>>()
    );
    if args[2] == "catalog" {
        return Ok(());
    }
    let selected = catalog
        .versions
        .iter()
        .find(|v| v.stable)
        .or_else(|| catalog.versions.first())
        .ok_or("No compatible build")?;
    let mut config = ServerConfig {
        core: args[3].clone(),
        minecraft_version: mc.into(),
        core_version: selected.id.clone(),
        memory_min_mb: 512,
        memory_max_mb: 1536,
        eula_accepted: true,
        ..Default::default()
    };
    config.properties.insert("view-distance".into(), "2".into());
    config
        .properties
        .insert("simulation-distance".into(), "2".into());
    config
        .properties
        .insert("server-ip".into(), "127.0.0.1".into());
    config.properties.insert(
        "server-port".into(),
        std::net::TcpListener::bind("127.0.0.1:0")?
            .local_addr()?
            .port()
            .to_string(),
    );
    if let Some(java) = std::env::var_os("SLH_TEST_JAVA") {
        config.java_path = Some(java.to_string_lossy().into_owned());
        config.jdk_path = config.java_path.clone();
    }
    if args[3] == "custom" {
        config.custom_jar = Some(std::env::var("SLH_TEST_JAR")?);
    }
    let server = store::create(
        &state,
        store::CreateServer { players: None,
            name: format!("Probe {}", args[3]),
            folder: format!("{} Кириллица & 100%! {}", args[3], uuid::Uuid::new_v4()),
            group_id: None,
            config,
        },
    )
    .await?;
    println!("INSTALL {} {}", server.id, server.path);
    providers::install(&app, &state, &server.id).await?;
    let host = std::fs::read(PathBuf::from(
        args.get(5).ok_or("Host executable required")?,
    ))?;
    let script = runtime::script(&app, &state, &server.id, false).await?;
    println!("SCRIPT {script}");
    runtime::start(&app, &state, &server.id, &host).await?;
    let result: Result<(), Box<dyn std::error::Error>> = async {
        let mut ready = false;
        let mut cursor = 0;
        for _ in 0..180 {
            let snapshot = runtime::poll(&state, &server.id, cursor).await?;
            for line in &snapshot.lines {
                println!("{}", line.text);
                cursor = line.seq;
            }
            if snapshot.state == "running" {
                ready = true;
                break;
            }
            if snapshot.state == "failed" {
                return Err("Java exited before ready".into());
            }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
        if !ready {
            return Err("Server did not become ready in 180 seconds".into());
        }
        assert!(
            runtime::start(&app, &state, &server.id, &host)
                .await
                .is_err()
        );

        runtime::control(&state, &server.id, "command", "save-all").await?;
        Ok(())
    }
    .await;
    if let Err(e) = runtime::control(&state, &server.id, "stop", "").await {
        eprintln!("STOP ERROR {e}");
    }
    for _ in 0..90 {
        if !runtime::java_is_alive(&state, &server.id) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
    if runtime::java_is_alive(&state, &server.id) {
        return Err("Test server did not stop gracefully".into());
    }
    result?;
    assert!(Path::new(&server.path).join("world/level.dat").is_file());
    println!("PASS {} installed, started, saved and stopped", args[3]);
    Ok(())
}
