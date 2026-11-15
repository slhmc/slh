//! Live Leaf install probe. All database and artifact writes use a temporary root.
use slh_core::{host::Host, local_servers::{config::ServerConfig, providers, store}, portable::PortablePaths, state::AppState};
use std::path::Path;

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let java = std::env::args().nth(1).ok_or("Usage: verify_leaf <Java 25 executable>")?;
    if !Path::new(&java).is_file() { return Err("Java executable missing".into()); }
    let root = tempfile::tempdir()?;
    let state = AppState::initialize_isolated_at(PortablePaths::from_executable(&root.path().join("test.exe"), Some(root.path().to_path_buf()))?).await?;
    let catalog = providers::catalog(&state, "leaf", Some("26.3")).await?;
    assert!(catalog.minecraft_versions.contains(&"26.3".into()));
    let build = catalog.versions.first().ok_or("No Leaf builds")?;
    println!("CATALOG Leaf 26.3 build={} stable={} java={}", build.id, build.stable, build.java_major);
    let server = store::create(&state, store::CreateServer { players: None,
        name: "Leaf smoke test".into(), folder: "leaf-smoke".into(), group_id: None,
        config: ServerConfig { core: "leaf".into(), minecraft_version: "26.3".into(), core_version: build.id.clone(), java_path: Some(java), eula_accepted: true, ..Default::default() },
    }).await?;
    let installed = providers::install(&Host::silent(), &state, &server.id).await?;
    assert!(installed.installed);
    let jar = Path::new(&installed.path).join("server.jar");
    let metadata = providers::json(&state, &format!("https://api.leafmc.one/v2/projects/leaf/versions/26.3/builds/{}", build.id)).await?;
    let (_, checksum) = providers::leaf_download(&metadata, "26.3", &build.id)?;
    providers::hash_file(&jar, Some("sha256"), Some(&checksum))?;
    assert!(installed.config.eula_accepted);
    println!("PASS native Leaf install, pinned build, launch plan and SHA-256; no server was started");
    state.database.close().await;
    Ok(())
}

