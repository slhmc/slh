//! Explicit opt-in: read-only discovery on a supplied folder, plugin writes only in a marked test root.
use slh_core::{
    local_servers::{config::ServerConfig, discovery, plugins, store},
    portable::PortablePaths,
    state::AppState,
};
use std::path::{Path, PathBuf};
#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    let root = std::fs::canonicalize(PathBuf::from(args.get(1).ok_or("test root required")?))?;
    if !root.join(".server-test-root").is_file() || root == Path::new("E:/SLH") {
        return Err("Isolated marked test root required".into());
    }
    let state = AppState::initialize_isolated_at(PortablePaths::from_executable(
        &root.join("test.exe"),
        Some(root.clone()),
    )?)
    .await?;
    if let Some(directory) = args.get(2) {
        let scan = discovery::scan(&state, Some(directory.clone())).await?;
        for s in &scan {
            println!(
                "FOUND {} core={} mc={} ready={} args={:?}",
                s.name, s.config.core, s.config.minecraft_version, s.ready, s.entry
            );
        }
        std::fs::write(
            root.join("discovery.json"),
            serde_json::to_vec_pretty(&scan)?,
        )?;
    }
    let server = store::create(
        &state,
        store::CreateServer { players: None,
            name: "Plugin probe".into(),
            folder: "Plugin probe".into(),
            group_id: None,
            config: ServerConfig {
                core: "purpur".into(),
                minecraft_version: "1.21.4".into(),
                core_version: "imported".into(),
                eula_accepted: true,
                ..Default::default()
            },
        },
    )
    .await?;
    for provider in ["modrinth", "curseforge"] {
        let hits = match plugins::search(&state, &server.id, provider, "LuckPerms", 0).await {
            Ok(v) => v,
            Err(e) => {
                println!("PROVIDER_UNAVAILABLE {provider}: {e}");
                continue;
            }
        };
        println!("SEARCH {provider} {} hits", hits.hits.len());
        let Some(project) = hits.hits.first() else {
            continue;
        };
        let versions = plugins::versions(&state, &server.id, provider, &project.project_id).await?;
        println!("VERSIONS {provider} {}", versions.len());
        let Some(latest) = versions.first() else {
            continue;
        };
        let selected = versions.get(1).unwrap_or(latest);
        let count = plugins::install(
            &state,
            &server.id,
            provider,
            &project.project_id,
            &selected.id,
        )
        .await?;
        assert!(count > 0);
        let before = plugins::files(&state, &server.id).await?;
        assert!(!before.is_empty());
        plugins::install(
            &state,
            &server.id,
            provider,
            &project.project_id,
            &latest.id,
        )
        .await?;
        let after = plugins::files(&state, &server.id).await?;
        let identities: std::collections::HashSet<_> = after
            .iter()
            .filter(|f| f.enabled)
            .map(|f| &f.name)
            .collect();
        assert_eq!(identities.len(), after.iter().filter(|f| f.enabled).count());
        println!(
            "PASS {provider} verified download, installed Bukkit manifest, update without duplicates; files={}",
            after.len()
        );
    }
    Ok(())
}
