use crate::{error::CommandResult, state::AppState};
use futures_util::FutureExt;
use serde_json::Value;
use slh_core::{
    local_servers::{self as servers, config::ServerConfig, providers, runtime, store},
    storage_cleanup,
};
use tauri::{AppHandle, State};
const HOST_BYTES: &[u8] = include_bytes!(env!("SLH_SERVER_HOST_PATH"));

#[tauri::command]
pub async fn apply_local_server_live(state: State<'_, AppState>, server_id: String, request: servers::live::LiveEdit) -> CommandResult<servers::live::LiveResult> {
    let _gate = storage_cleanup::gate().read().await;
    servers::live::apply(&state, &server_id, request).await.map_err(Into::into)
}

#[tauri::command]
pub async fn update_local_server_memory(state: State<'_, AppState>, server_id: String, minimum: u32, maximum: u32) -> CommandResult<store::LocalServer> {
    let _gate = storage_cleanup::gate().read().await;
    store::update_memory(&state, &server_id, minimum, maximum).await.map_err(Into::into)
}

#[tauri::command]
pub async fn get_local_server_metrics(state: State<'_, AppState>, server_id: String) -> CommandResult<servers::metrics::ServerMetrics> {
    servers::metrics::get(&state, &server_id).await.map_err(Into::into)
}

fn core_recovery_error(error: slh_core::error::AppError) -> crate::error::CommandError {
    use slh_core::error::AppError;
    let key = match &error {
        AppError::InvalidInput(message) | AppError::Conflict(message) | AppError::Security(message)
            if message.starts_with("serverCoreRepair.") => Some(message.clone()),
        _ => None,
    };
    let mut result: crate::error::CommandError = error.into();
    if key.is_some() { result.message_key = key; }
    result
}

#[tauri::command]
pub async fn check_local_server_launch(state: State<'_, AppState>, server_id: String) -> CommandResult<servers::recovery::LaunchCheck> {
    servers::recovery::inspect(&state, &server_id).await.map_err(core_recovery_error)
}
#[tauri::command]
pub async fn inspect_local_server_core_candidate(state: State<'_, AppState>, server_id: String, path: String) -> CommandResult<servers::recovery::CoreCandidate> {
    servers::recovery::inspect_candidate(&state, &server_id, path).await.map_err(core_recovery_error)
}
#[tauri::command]
pub async fn repair_local_server_core(state: State<'_, AppState>, server_id: String, path: String, expected_revision: String, expected_fingerprint: String) -> CommandResult<store::LocalServer> {
    let _gate = storage_cleanup::gate().read().await;
    servers::recovery::repair(&state, &server_id, path, expected_revision, expected_fingerprint).await.map_err(core_recovery_error)
}

#[tauri::command]
pub async fn discover_local_servers(
    state: State<'_, AppState>,
    directory: Option<String>,
) -> CommandResult<Vec<servers::discovery::DiscoveredServer>> {
    servers::discovery::scan(&state, directory)
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn connect_local_server(
    state: State<'_, AppState>,
    path: String,
    config: Option<ServerConfig>,
) -> CommandResult<store::LocalServer> {
    let _gate = storage_cleanup::gate().read().await;
    servers::discovery::connect(&state, path, config)
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn search_server_plugins(
    state: State<'_, AppState>,
    server_id: String,
    provider: String,
    query: String,
    offset: u64,
) -> CommandResult<slh_core::models::ModrinthSearchResult> {
    servers::plugins::search(&state, &server_id, &provider, &query, offset)
        .boxed()
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn server_plugin_versions(
    state: State<'_, AppState>,
    server_id: String,
    provider: String,
    project_id: String,
) -> CommandResult<Vec<servers::plugins::PluginVersion>> {
    servers::plugins::versions(&state, &server_id, &provider, &project_id)
        .boxed()
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn plan_server_plugin(
    state: State<'_, AppState>,
    server_id: String,
    provider: String,
    project_id: String,
    version_id: String,
) -> CommandResult<servers::plugins::PluginPlan> {
    servers::plugins::plan(&state, &server_id, &provider, &project_id, &version_id)
        .boxed()
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn install_server_plugin(
    state: State<'_, AppState>,
    server_id: String,
    provider: String,
    project_id: String,
    version_id: String,
) -> CommandResult<u64> {
    let _gate = storage_cleanup::gate().read().await;
    servers::plugins::install(&state, &server_id, &provider, &project_id, &version_id)
        .boxed()
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn list_server_plugins(
    state: State<'_, AppState>,
    server_id: String,
) -> CommandResult<Vec<servers::plugins::PluginFile>> {
    servers::plugins::files(&state, &server_id)
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn manage_server_plugin(
    state: State<'_, AppState>,
    server_id: String,
    filename: String,
    action: String,
) -> CommandResult<()> {
    let _gate = storage_cleanup::gate().read().await;
    servers::plugins::manage(&state, &server_id, &filename, &action)
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn get_local_server_icon(
    state: State<'_, AppState>,
    server_id: String,
) -> CommandResult<Option<String>> {
    servers::artwork::get(&state, &server_id)
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn set_local_server_icon(
    state: State<'_, AppState>,
    server_id: String,
    path: String,
) -> CommandResult<()> {
    let _gate = storage_cleanup::gate().read().await;
    servers::artwork::set(&state, &server_id, &path)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn get_local_servers(state: State<'_, AppState>) -> CommandResult<store::ServerOverview> {
    store::overview(&state).await.map_err(Into::into)
}
#[tauri::command]
pub async fn get_local_server_config(
    state: State<'_, AppState>,
    server_id: String,
) -> CommandResult<store::LocalServer> {
    store::read_config(&state, &server_id)
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn local_server_catalog(
    state: State<'_, AppState>,
    core: String,
    minecraft_version: Option<String>,
) -> CommandResult<providers::ServerCatalog> {
    providers::catalog(&state, &core, minecraft_version.as_deref())
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn create_local_server(
    state: State<'_, AppState>,
    request: store::CreateServer,
) -> CommandResult<store::LocalServer> {
    let _gate = storage_cleanup::gate().read().await;
    store::create(&state, request).await.map_err(Into::into)
}
#[tauri::command]
pub async fn update_local_server(
    state: State<'_, AppState>,
    server_id: String,
    name: String,
    config: ServerConfig,
    expected_properties_revision: Option<String>,
) -> CommandResult<store::LocalServer> {
    let _gate = storage_cleanup::gate().write().await;
    store::update_checked(&state, &server_id, &name, config, expected_properties_revision.as_deref())
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn install_local_server(
    app: AppHandle,
    state: State<'_, AppState>,
    server_id: String,
) -> CommandResult<store::LocalServer> {
    let _gate = storage_cleanup::gate().read().await;
    providers::install(&crate::core_host::host(&app), &state, &server_id)
        .boxed()
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn start_local_server(
    app: AppHandle,
    state: State<'_, AppState>,
    server_id: String,
) -> CommandResult<servers::host::HostSnapshot> {
    let _gate = storage_cleanup::gate().read().await;
    runtime::start(
        &crate::core_host::host(&app),
        &state,
        &server_id,
        HOST_BYTES,
    )
    .boxed()
    .await
    .map_err(core_recovery_error)
}
#[tauri::command]
pub async fn control_local_server(
    app: AppHandle,
    state: State<'_, AppState>,
    server_id: String,
    action: String,
    command: Option<String>,
) -> CommandResult<servers::host::HostSnapshot> {
    let _gate = storage_cleanup::gate().read().await;
    if action == "restart" {
        runtime::restart(
            &crate::core_host::host(&app),
            &state,
            &server_id,
            HOST_BYTES,
        )
        .boxed()
        .await
        .map_err(Into::into)
    } else {
        runtime::control(
            &state,
            &server_id,
            &action,
            command.as_deref().unwrap_or(""),
        )
        .await
        .map_err(Into::into)
    }
}
#[tauri::command]
pub async fn get_local_server_console(
    app: AppHandle,
    state: State<'_, AppState>,
    server_id: String,
    cursor: u64,
) -> CommandResult<servers::host::HostSnapshot> {
    let snapshot = runtime::poll(&state, &server_id, cursor).await?;
    use tauri::Emitter;
    let _=app.emit("slh-local-server-state",serde_json::json!({"serverId":server_id,"state":snapshot.state,"exitCode":snapshot.exit_code}));
    if !snapshot.lines.is_empty() {
        let _ = app.emit(
            "slh-local-server-console",
            serde_json::json!({"serverId":server_id,"lines":snapshot.lines}),
        );
    }
    Ok(snapshot)
}
#[tauri::command]
pub async fn open_local_server_console(
    state: State<'_, AppState>,
    server_id: String,
) -> CommandResult<()> {
    runtime::external_console(&state, &server_id, HOST_BYTES)
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn export_local_server_script(
    app: AppHandle,
    state: State<'_, AppState>,
    server_id: String,
    overwrite: bool,
) -> CommandResult<String> {
    let _gate = storage_cleanup::gate().read().await;
    runtime::script(&crate::core_host::host(&app), &state, &server_id, overwrite)
        .boxed()
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn create_server_group(
    state: State<'_, AppState>,
    name: String,
    parent_id: Option<String>,
) -> CommandResult<store::ServerGroup> {
    let _gate = storage_cleanup::gate().read().await;
    store::create_group(&state, &name, parent_id)
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn rename_server_group(
    state: State<'_, AppState>,
    group_id: String,
    name: String,
) -> CommandResult<Vec<store::ServerGroup>> {
    let _gate = storage_cleanup::gate().read().await;
    store::rename_group(&state, &group_id, &name)
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn move_local_server(
    state: State<'_, AppState>,
    server_id: String,
    group_id: Option<String>,
    folder: String,
) -> CommandResult<store::LocalServer> {
    let _gate = storage_cleanup::gate().read().await;
    store::move_server(&state, &server_id, group_id, &folder)
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn save_server_defaults(
    state: State<'_, AppState>,
    value: Value,
) -> CommandResult<Value> {
    store::save_defaults(&state, value)
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn open_local_server_folder(
    state: State<'_, AppState>,
    server_id: Option<String>,
    section: Option<String>,
) -> CommandResult<()> {
    let path = store::section_folder(&state, server_id.as_deref(), section.as_deref()).await?;
    std::fs::create_dir_all(&path).map_err(slh_core::error::AppError::from)?;
    open::that(&path).map_err(slh_core::error::AppError::from)?;
    Ok(())
}
#[tauri::command]
pub async fn scan_storage_cleanup(
    state: State<'_, AppState>,
) -> CommandResult<storage_cleanup::CleanupScan> {
    storage_cleanup::scan(&state)
        .boxed()
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn execute_storage_cleanup(
    state: State<'_, AppState>,
    scan_id: String,
    entry_ids: Vec<String>,
) -> CommandResult<storage_cleanup::CleanupResult> {
    storage_cleanup::execute(&state, &scan_id, entry_ids)
        .boxed()
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn optimize_storage_database(
    state: State<'_, AppState>,
) -> CommandResult<storage_cleanup::CleanupResult> {
    storage_cleanup::optimize_database(&state)
        .boxed()
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn preview_server_launch(config: ServerConfig) -> CommandResult<String> {
    if config.core == "horizon" { return Ok("horizon-client --resources <prepared-resources> --dedicated --nogui".into()); }
    let major = providers::required_java(&config.minecraft_version);
    let mut args = servers::config::jvm_arguments(&config, major)?;
    let entry = match config.core.as_str() {
        "forge" | "neoforge" => vec!["@libraries/<installed-core>/args.txt".into()],
        "quilt" => vec!["-jar".into(), "quilt-server-launch.jar".into()],
        _ => vec!["-jar".into(), "server.jar".into()],
    };
    args.extend(entry);
    args.push("nogui".into());
    args.extend(config.server_args.clone());
    Ok(
        std::iter::once(config.java_path.unwrap_or_else(|| "java".into()))
            .chain(args)
            .map(|s| format!("{s:?}"))
            .collect::<Vec<_>>()
            .join(" "),
    )
}

#[tauri::command]
pub async fn move_server_group(
    state: State<'_, AppState>,
    group_id: String,
    parent_id: Option<String>,
    name: String,
) -> CommandResult<Vec<store::ServerGroup>> {
    let _gate = storage_cleanup::gate().read().await;
    store::move_group(&state, &group_id, parent_id, &name)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn sync_server_library(state:State<'_,AppState>,directory:Option<String>)->CommandResult<store::ServerOverview>{servers::library::synchronize(&state,directory).boxed().await.map_err(Into::into)}
#[tauri::command]
pub async fn edit_server_collection(state:State<'_,AppState>,action:String,id:Option<String>,name:Option<String>,parent:Option<String>)->CommandResult<()>{servers::library::edit_group(&state,&action,id,name,parent).await.map_err(Into::into)}
#[tauri::command]
pub async fn organize_server_library(state:State<'_,AppState>,server_id:String,collection_id:Option<String>,before:Option<String>)->CommandResult<()>{servers::library::organize(&state,&server_id,collection_id,before).await.map_err(Into::into)}
#[tauri::command]
pub async fn reorder_server_collections(state:State<'_,AppState>,ids:Vec<String>)->CommandResult<()>{servers::library::reorder_groups(&state,ids).await.map_err(Into::into)}
#[tauri::command]
pub async fn save_server_library_view(state:State<'_,AppState>,value:Value)->CommandResult<()>{servers::library::save_view(&state,value).await.map_err(Into::into)}
#[tauri::command]
pub async fn save_server_artwork(state:State<'_,AppState>,server_id:String,icon:Value,name:Option<String>)->CommandResult<()>{servers::library::save_icon(&state,&server_id,icon,name).await.map_err(Into::into)}

#[tauri::command]
pub async fn open_server_collection_folder(state:State<'_,AppState>,id:String)->CommandResult<()>{let groups=servers::library::collections(&state).await?;let path=groups.into_iter().find(|g|g.id==id).and_then(|g|g.source_path).ok_or_else(||slh_core::error::AppError::NotFound("Group has no physical directory".into()))?;store::plain_path(std::path::Path::new(&path))?;open::that(path).map_err(slh_core::error::AppError::from)?;Ok(())}

#[tauri::command]
pub async fn delete_local_server(state: State<'_, AppState>, server_id: String, expected_path: String) -> CommandResult<()> {
    let _gate = storage_cleanup::gate().write().await;
    store::delete(&state, &server_id, &expected_path).await.map_err(Into::into)
}

#[tauri::command]
pub async fn get_server_players(state: State<'_, AppState>, server_id: String) -> CommandResult<servers::players::PlayerLists> {
    let _gate = storage_cleanup::gate().read().await;
    servers::players::list(&state, &server_id).await.map_err(Into::into)
}
#[tauri::command]
pub async fn edit_server_players(state: State<'_, AppState>, server_id: String, request: servers::players::PlayerEdit) -> CommandResult<servers::players::PlayerLists> {
    let _gate = storage_cleanup::gate().write().await;
    servers::players::edit(&state, &server_id, request).await.map_err(Into::into)
}
