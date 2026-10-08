use base64::Engine;
use serde_json::Value;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State, WebviewWindow};

use crate::accounts;
use crate::database;
use crate::error::CommandResult;
use crate::instances;
use crate::localization;
use crate::minecraft;
use crate::models::{
    Account, AddServerRequest, ArchiveInspection, AssignInstanceGroupRequest, BootstrapData,
    ConsoleLine, ContentInstallPlan, ContentInstallResult, CreateGroupRequest,
    CreateInstanceRequest, CreateOfflineAccountRequest, CreateSyncMappingRequest,
    CurseForgeKeyStatus, DeleteGroupRequest, DeleteInstanceResult, DownloadRecord, ExportResult,
    ImportFolderRequest, ImportSlhRequest, InstalledContentRecord, Instance, InstanceFileEntry,
    CreateInstanceVersionCopyRequest, CreateInstanceVersionCopyResult,
    InspectInstanceVersionMigrationRequest, InstanceGroup, InstanceVersionMigrationPreview,
    ListInstanceVersionMigrationEntriesRequest, VersionMigrationEntry,
    JavaInstallation, LaunchResponse, LauncherUpdateInfo, LoaderVersion, LoginElyByRequest,
    MinecraftVersionSummary, ModrinthSearchResult, RenameGroupRequest, ReorderGroupsRequest,
    ServerEntry, SetGroupCollapsedRequest, StorageSummary, SyncMapping, SyncRunResult,
    UpdateInstanceRequest,
};
use crate::settings;
use crate::state::AppState;
use crate::window_state;

#[tauri::command]
pub fn exit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
pub async fn save_window_state(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    window_state::save(&window, &state.database)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn get_bootstrap(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<BootstrapData> {
    // Keep status accurate when Minecraft outlives the launcher window.
    crate::minecraft::launcher::reconcile_running_instances(&crate::core_host::host(&app), &state)
        .await
        .map_err(crate::error::CommandError::from)?;
    async fn load(state: &AppState) -> crate::error::AppResult<BootstrapData> {
        let mut settings = database::all_settings(&state.database).await?;
        // Capability masking affects this response only, never stored settings.
        if !slh_core::platform::capabilities().bedrock {
            settings["bedrock"]["enabled"] = Value::Bool(false);
        }
        let mut accounts = database::accounts(&state.database).await?;
        // Databases created by early development builds can contain accounts
        // without an active flag. Keep the account visible and launchable
        // instead of presenting an empty identity selector.
        if !accounts.is_empty() && !accounts.iter().any(|account| account.active) {
            accounts::activate_account(&state.database, &accounts[0].id).await?;
            accounts = database::accounts(&state.database).await?;
        }
        let first_run = settings
            .get("onboarding")
            .and_then(|value| value.get("completed"))
            .and_then(Value::as_bool)
            .is_none_or(|completed| !completed);
        Ok(BootstrapData {
            capabilities: slh_core::platform::capabilities(),
            version: env!("CARGO_PKG_VERSION").into(),
            build_unix: env!("SLH_BUILD_UNIX").parse().unwrap_or_default(),
            portable_root: state.paths.root.to_string_lossy().into_owned(),
            first_run,
            locales: localization::list_locales(&state.paths)?,
            settings,
            groups: database::groups(&state.database).await?,
            instances: database::instances(&state.database).await?,
            accounts,
            providers: accounts::provider_availability(),
        })
    }
    load(&state).await.map_err(Into::into)
}

/// Check the public GitHub release feed without exposing any credentials to
/// the webview. The response is deliberately reduced to the fields the UI
/// needs, so release descriptions and arbitrary asset metadata never enter
/// launcher state.
#[tauri::command]
pub async fn check_launcher_updates(
    state: State<'_, AppState>,
) -> CommandResult<LauncherUpdateInfo> {
    let current_version = env!("CARGO_PKG_VERSION").to_owned();
    // `/releases/latest` only considers non-prerelease releases.  SLH currently
    // publishes prereleases, so use the public collection endpoint and select
    // the newest non-draft tag ourselves.  This also keeps update checks useful
    // before the first stable release is published.
    let releases = state
        .http
        .get("https://api.github.com/repos/slhmc/slh/releases?per_page=20")
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .header(
            reqwest::header::USER_AGENT,
            format!("SLH/{current_version}"),
        )
        .send()
        .await
        .map_err(crate::error::AppError::from)?
        .error_for_status()
        .map_err(crate::error::AppError::from)?
        .json::<Vec<serde_json::Value>>()
        .await
        .map_err(crate::error::AppError::from)?;
    let release = crate::updates::latest_release(&releases)
        .ok_or_else(|| {
            crate::error::AppError::NotFound("GitHub returned no published releases".into())
        })?;
    let latest_version = release
        .get("tag_name")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            crate::error::AppError::InvalidInput("GitHub returned no release tag".into())
        })?
        .to_owned();
    let release_url = release
        .get("html_url")
        .and_then(serde_json::Value::as_str)
        .filter(|value| value.starts_with("https://github.com/slhmc/slh/releases/"))
        .ok_or_else(|| {
            crate::error::AppError::Security("GitHub returned an unexpected release URL".into())
        })?
        .to_owned();
    let release_name = release
        .get("name")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(&latest_version)
        .to_owned();
    let published_at = release
        .get("published_at")
        .and_then(serde_json::Value::as_str)
        .map(ToOwned::to_owned);
    let update_available = crate::updates::is_newer(&latest_version, &current_version);
    Ok(LauncherUpdateInfo {
        current_version,
        latest_version,
        release_name,
        release_url,
        published_at,
        update_available,
    })
}

#[tauri::command]
pub async fn update_setting(
    state: State<'_, AppState>,
    key: String,
    value: Value,
) -> CommandResult<Value> {
    settings::update(&state.database, &key, value)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub fn prepare_windows_notifications() -> CommandResult<()> {
    crate::windows_notifications::ensure_start_menu_shortcut().map_err(Into::into)
}

#[tauri::command]
pub fn send_windows_notification(
    app: AppHandle,
    title: String,
    body: Option<String>,
) -> CommandResult<()> {
    use tauri_plugin_notification::NotificationExt;

    let title = title.trim();
    if title.is_empty() || title.chars().count() > 160 {
        return Err(crate::error::AppError::InvalidInput(
            "Windows notification title must contain 1 to 160 characters".into(),
        )
        .into());
    }
    if body.as_ref().is_some_and(|value| value.chars().count() > 1000) {
        return Err(crate::error::AppError::InvalidInput(
            "Windows notification body is too long".into(),
        )
        .into());
    }
    let mut notification = app.notification().builder().title(title);
    if let Some(body) = body.as_deref().filter(|value| !value.trim().is_empty()) {
        notification = notification.body(body.trim());
    }
    notification
        .show()
        .map_err(|error| crate::error::AppError::Process(format!("Could not show Windows notification: {error}")))
        .map_err(Into::into)
}

#[tauri::command]
pub fn open_bedrock_content_file(path: String) -> CommandResult<()> {
    let path = PathBuf::from(path);
    let metadata = std::fs::symlink_metadata(&path).map_err(crate::error::AppError::from)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(crate::error::AppError::InvalidInput(
            "Choose a regular Bedrock content file".into(),
        )
        .into());
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if !["mcpack", "mcaddon", "mcworld"]
        .iter()
        .any(|allowed| extension.eq_ignore_ascii_case(allowed))
    {
        return Err(crate::error::AppError::InvalidInput(
            "Only .mcpack, .mcaddon, and .mcworld files can be imported".into(),
        )
        .into());
    }
    tauri_plugin_opener::open_path(&path, None::<&str>)
        .map_err(|error| crate::error::AppError::Process(format!("Minecraft could not open the Bedrock content file: {error}")))
        .map_err(Into::into)
}

#[tauri::command]
pub async fn search_bedrock_curseforge(
    state: State<'_, AppState>,
    query: String,
    category: String,
    offset: Option<u64>,
    game_version: Option<String>,
    sort: Option<String>,
) -> CommandResult<ModrinthSearchResult> {
    settings::ensure_bedrock_enabled(&state.database).await.map_err(crate::error::CommandError::from)?;
    crate::content::curseforge::search_bedrock(&state, &query, &category, offset.unwrap_or(0), game_version.as_deref(), sort.as_deref())
        .await.map_err(Into::into)
}

#[tauri::command]
pub async fn download_bedrock_curseforge(
    state: State<'_, AppState>,
    project_id: String,
    game_version: Option<String>,
) -> CommandResult<String> {
    settings::ensure_bedrock_enabled(&state.database).await.map_err(crate::error::CommandError::from)?;
    let path = crate::content::curseforge::download_bedrock(&state, &project_id, game_version.as_deref())
        .await.map_err(crate::error::CommandError::from)?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn import_local_font(
    state: State<'_, AppState>,
    source_path: String,
) -> CommandResult<String> {
    async fn import(state: &AppState, source_path: &str) -> crate::error::AppResult<String> {
        let source = std::path::PathBuf::from(source_path);
        let metadata = tokio::fs::metadata(&source).await?;
        if !metadata.is_file() || metadata.len() == 0 || metadata.len() > 10 * 1024 * 1024 {
            return Err(crate::error::AppError::InvalidInput(
                "Choose a font file smaller than 10 MB".into(),
            ));
        }
        let extension = source
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase)
            .filter(|value| matches!(value.as_str(), "ttf" | "otf" | "woff" | "woff2"))
            .ok_or_else(|| {
                crate::error::AppError::InvalidInput(
                    "Supported local font files are .ttf, .otf, .woff, and .woff2".into(),
                )
            })?;
        let target = state.paths.fonts.join(format!("interface.{extension}"));
        tokio::fs::copy(&source, &target).await?;
        Ok(target.to_string_lossy().into_owned())
    }
    import(&state, &source_path).await.map_err(Into::into)
}

#[tauri::command]
pub async fn get_local_font_data(state: State<'_, AppState>) -> CommandResult<Option<String>> {
    async fn load(state: &AppState) -> crate::error::AppResult<Option<String>> {
        let appearance = database::setting(&state.database, "appearance").await?;
        let Some(path) = appearance.get("customFontPath").and_then(Value::as_str) else {
            return Ok(None);
        };
        let path = std::path::PathBuf::from(path);
        if path.parent() != Some(state.paths.fonts.as_path()) {
            return Err(crate::error::AppError::Security(
                "Local font path escaped portable font storage".into(),
            ));
        }
        let bytes = tokio::fs::read(&path).await?;
        if bytes.is_empty() || bytes.len() > 10 * 1024 * 1024 {
            return Err(crate::error::AppError::Security(
                "Stored local font is not within the allowed size".into(),
            ));
        }
        let mime = match path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str()
        {
            "ttf" => "font/ttf",
            "otf" => "font/otf",
            "woff" => "font/woff",
            "woff2" => "font/woff2",
            _ => {
                return Err(crate::error::AppError::Security(
                    "Stored local font has an invalid extension".into(),
                ));
            }
        };
        Ok(Some(format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        )))
    }
    load(&state).await.map_err(Into::into)
}

#[tauri::command]
pub async fn load_locale(state: State<'_, AppState>, code: String) -> CommandResult<Value> {
    localization::load_locale(&state.paths, &code).map_err(Into::into)
}

/// Re-scan the portable language folders without requiring an application restart.
/// The UI uses this while the language selector is open so user-added locale files
/// become available as soon as they are saved to `data/languages`.
#[tauri::command]
pub fn list_locales(
    state: State<'_, AppState>,
) -> CommandResult<Vec<crate::models::LocaleDescriptor>> {
    localization::list_locales(&state.paths).map_err(Into::into)
}

#[tauri::command]
pub async fn create_group(
    state: State<'_, AppState>,
    request: CreateGroupRequest,
) -> CommandResult<InstanceGroup> {
    instances::create_group(&state.database, request)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn set_group_collapsed(
    state: State<'_, AppState>,
    request: SetGroupCollapsedRequest,
) -> CommandResult<InstanceGroup> {
    instances::set_group_collapsed(&state.database, request)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn assign_instance_group(
    state: State<'_, AppState>,
    request: AssignInstanceGroupRequest,
) -> CommandResult<Instance> {
    instances::assign_instance_group(&state.database, request)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn rename_group(
    state: State<'_, AppState>,
    request: RenameGroupRequest,
) -> CommandResult<InstanceGroup> {
    instances::rename_group(&state.database, request)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn delete_group(
    state: State<'_, AppState>,
    request: DeleteGroupRequest,
) -> CommandResult<()> {
    instances::delete_group(&state.database, request)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn reorder_groups(
    state: State<'_, AppState>,
    request: ReorderGroupsRequest,
) -> CommandResult<()> {
    instances::reorder_groups(&state.database, request)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn create_offline_account(
    state: State<'_, AppState>,
    request: CreateOfflineAccountRequest,
) -> CommandResult<Account> {
    accounts::create_offline_account(&state.database, request)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn activate_account(
    state: State<'_, AppState>,
    account_id: String,
) -> CommandResult<Account> {
    accounts::activate_account(&state.database, &account_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn delete_account(state: State<'_, AppState>, account_id: String) -> CommandResult<()> {
    accounts::delete_account(&state, &account_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn get_account_avatar(
    state: State<'_, AppState>,
    account_id: String,
) -> CommandResult<Option<String>> {
    async fn load(state: &AppState, account_id: &str) -> crate::error::AppResult<Option<String>> {
        let account = database::accounts(&state.database)
            .await?
            .into_iter()
            .find(|account| account.id == account_id)
            .ok_or_else(|| crate::error::AppError::NotFound(format!("Account {account_id}")))?;
        let expected = state.paths.accounts.join(format!("{account_id}.skin.png"));
        let bytes = match tokio::fs::read(&expected).await {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        if bytes.len() > 2 * 1024 * 1024 || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            return Err(crate::error::AppError::Security(
                "Cached account avatar is not a valid PNG texture".into(),
            ));
        }
        // The database used to store an absolute path. After moving a
        // portable data directory that path can be stale even though the
        // account-specific cache file is still present. The verified path
        // above is the only path used for reading; repair the metadata here.
        let expected_path = expected.to_string_lossy().into_owned();
        if account.avatar_cache_path.as_deref() != Some(expected_path.as_str()) {
            sqlx::query("UPDATE accounts SET avatar_cache_path = ? WHERE id = ?")
                .bind(&expected_path)
                .bind(&account_id)
                .execute(&state.database)
                .await?;
        }
        Ok(Some(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        )))
    }
    load(&state, &account_id).await.map_err(Into::into)
}

#[tauri::command]
pub async fn get_account_appearance(
    state: State<'_, AppState>,
    account_id: String,
) -> CommandResult<crate::models::AccountAppearance> {
    accounts::appearance(&state, &account_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn get_home_account_skin(state: State<'_, AppState>, account_id: String) -> CommandResult<serde_json::Value> {
    accounts::home_skin(&state, &account_id).await.map_err(Into::into)
}

#[tauri::command]
pub async fn upload_account_skin(
    state: State<'_, AppState>,
    account_id: String,
    source_path: String,
    variant: String,
) -> CommandResult<crate::models::AccountAppearance> {
    accounts::upload_skin(&state, &account_id, &source_path, &variant)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn upload_account_skin_bytes(
    state: State<'_, AppState>,
    account_id: String,
    png_bytes: Vec<u8>,
    file_name: String,
    variant: String,
    existing_skin_id: Option<String>,
) -> CommandResult<crate::models::AccountAppearance> {
    accounts::upload_skin_bytes(
        &state,
        &account_id,
        png_bytes,
        &file_name,
        &variant,
        existing_skin_id.as_deref(),
    )
    .await
    .map_err(Into::into)
}

#[tauri::command]
pub async fn select_account_cape(
    state: State<'_, AppState>,
    account_id: String,
    cape_id: Option<String>,
) -> CommandResult<crate::models::AccountAppearance> {
    accounts::select_cape(&state, &account_id, cape_id.as_deref())
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn delete_saved_account_skin(
    state: State<'_, AppState>,
    account_id: String,
    skin_id: String,
) -> CommandResult<crate::models::AccountAppearance> {
    accounts::delete_saved_skin(&state, &account_id, &skin_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn login_elyby(
    state: State<'_, AppState>,
    request: LoginElyByRequest,
) -> CommandResult<Account> {
    accounts::elyby::login(&state, request)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn login_microsoft(app: AppHandle, state: State<'_, AppState>) -> CommandResult<Account> {
    accounts::microsoft::login(&crate::core_host::host(&app), &state)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn list_minecraft_versions(
    state: State<'_, AppState>,
) -> CommandResult<Vec<MinecraftVersionSummary>> {
    minecraft::installer::list_versions(&state)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn list_bedrock_versions(
    state: State<'_, AppState>,
) -> CommandResult<Vec<MinecraftVersionSummary>> {
    minecraft::bedrock::list_versions(&state)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn test_bedrock_mirrors(
    state: State<'_, AppState>,
    version: String,
    timeout_ms: Option<u64>,
) -> CommandResult<Vec<crate::models::BedrockMirrorProbe>> {
    minecraft::bedrock::test_mirrors(&state, &version, timeout_ms)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn get_bedrock_runtime_status(
    state: State<'_, AppState>,
) -> CommandResult<crate::minecraft::bedrock_runtime::BedrockRuntimeStatus> {
    crate::minecraft::bedrock_runtime::get_runtime_status(&state)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn refresh_bedrock_entitlements(
    state: State<'_, AppState>,
) -> CommandResult<crate::minecraft::bedrock_runtime::BedrockRuntimeStatus> {
    crate::minecraft::bedrock_runtime::refresh_entitlements(&state)
        .await
        .map_err(Into::into)
}

/// Explicitly re-authenticate and bind the active Microsoft/Xbox profile used
/// for Bedrock. The operation is intentionally separate from Java account
/// identity; `provider_uuid` is never treated as an Xbox XUID.
#[tauri::command]
pub async fn bind_bedrock_store_account(
    state: State<'_, AppState>,
) -> CommandResult<crate::minecraft::bedrock_runtime::BedrockRuntimeStatus> {
    crate::minecraft::bedrock_runtime::bind_store_account(&state).await?;
    crate::minecraft::bedrock_runtime::get_runtime_status(&state)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn prepare_bedrock_runtime(
    app: AppHandle,
    state: State<'_, AppState>,
    instance_id: Option<String>,
) -> CommandResult<crate::minecraft::bedrock_runtime::BedrockRuntimeStatus> {
    crate::minecraft::bedrock_runtime::prepare_runtime(&crate::core_host::host(&app), &state, instance_id.as_deref())
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub fn open_bedrock_store(app: AppHandle) -> CommandResult<()> {
    crate::minecraft::bedrock_runtime::open_store(&crate::core_host::host(&app)).map_err(Into::into)
}

#[tauri::command]
pub fn open_bedrock_xbox(app: AppHandle) -> CommandResult<()> {
    crate::minecraft::bedrock_runtime::open_xbox(&crate::core_host::host(&app)).map_err(Into::into)
}

#[tauri::command]
pub async fn discover_java(
    app: AppHandle,
    state: State<'_, AppState>,
    required_major: Option<u32>,
    scan_all: Option<bool>,
) -> CommandResult<Vec<JavaInstallation>> {
    let result = if scan_all.unwrap_or(false) {
        minecraft::java::discover(Some(&crate::core_host::host(&app)), &state, required_major).await
    } else {
        minecraft::java::discover_fast(&state, required_major).await
    };
    result.map_err(Into::into)
}

#[tauri::command]
pub fn cancel_java_discovery(state: State<'_, AppState>) {
    state
        .java_scan_cancelled
        .store(true, std::sync::atomic::Ordering::Relaxed);
}

#[tauri::command]
pub async fn install_managed_java(
    app: AppHandle,
    state: State<'_, AppState>,
    major_version: u32,
) -> CommandResult<JavaInstallation> {
    minecraft::java::install_managed(&crate::core_host::host(&app), &state, major_version)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn create_instance(
    state: State<'_, AppState>,
    request: CreateInstanceRequest,
) -> CommandResult<Instance> {
    async fn create(
        state: &AppState,
        request: CreateInstanceRequest,
    ) -> crate::error::AppResult<Instance> {
        if request.loader_type == "bedrock" {
            settings::ensure_bedrock_enabled(&state.database).await?;
        }
        let instance = instances::create_instance(&state.database, &state.paths, request).await?;
        crate::sync::apply_to_new_instance(state, &instance).await?;
        Ok(instance)
    }
    create(&state, request).await.map_err(Into::into)
}

#[tauri::command]
pub async fn update_instance(
    state: State<'_, AppState>,
    request: UpdateInstanceRequest,
) -> CommandResult<Instance> {
    instances::update_instance(&state, request)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn inspect_instance_version_migration(
    state: State<'_, AppState>,
    request: InspectInstanceVersionMigrationRequest,
) -> CommandResult<InstanceVersionMigrationPreview> {
    crate::version_migration::inspect(&state, request)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn list_instance_version_migration_entries(
    state: State<'_, AppState>,
    request: ListInstanceVersionMigrationEntriesRequest,
) -> CommandResult<Vec<VersionMigrationEntry>> {
    crate::version_migration::list_entries(&state, request)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn create_instance_version_copy(
    app: AppHandle,
    state: State<'_, AppState>,
    request: CreateInstanceVersionCopyRequest,
) -> CommandResult<CreateInstanceVersionCopyResult> {
    crate::version_migration::create_copy(&crate::core_host::host(&app), &state, request)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn delete_instance(
    state: State<'_, AppState>,
    instance_id: String,
) -> CommandResult<DeleteInstanceResult> {
    instances::delete_instance(&state, &instance_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn reveal_instance_path(
    state: State<'_, AppState>,
    instance_id: String,
    path: Option<String>,
) -> CommandResult<()> {
    crate::storage::reveal_instance_path(&state, &instance_id, path.as_deref())
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn install_instance(
    app: AppHandle,
    state: State<'_, AppState>,
    instance_id: String,
    bedrock_mirror_url: Option<String>,
) -> CommandResult<Instance> {
    minecraft::installer::install_instance(
        &crate::core_host::host(&app),
        &state,
        &instance_id,
        bedrock_mirror_url.as_deref(),
    )
    .await
    .map_err(Into::into)
}

#[tauri::command]
pub async fn launch_instance(
    app: AppHandle,
    state: State<'_, AppState>,
    instance_id: String,
    offline_username: Option<String>,
) -> CommandResult<LaunchResponse> {
    minecraft::launcher::launch_instance(&crate::core_host::host(&app), &state, &instance_id, offline_username.as_deref())
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn kill_instance(state: State<'_, AppState>, instance_id: String) -> CommandResult<()> {
    minecraft::launcher::kill_instance(&state, &instance_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn search_modrinth(
    state: State<'_, AppState>,
    query: String,
    project_type: Option<String>,
    game_version: Option<String>,
    loader: Option<String>,
    sort: Option<String>,
    offset: Option<u64>,
    limit: Option<u64>,
) -> CommandResult<ModrinthSearchResult> {
    crate::content::search(
        &state,
        "modrinth",
        &query,
        project_type.as_deref(),
        game_version.as_deref(),
        loader.as_deref(),
        sort.as_deref(),
        offset.unwrap_or(0),
        limit.unwrap_or(24),
    )
    .await
    .map_err(Into::into)
}

#[tauri::command]
pub async fn search_curseforge(
    state: State<'_, AppState>,
    query: String,
    project_type: Option<String>,
    game_version: Option<String>,
    loader: Option<String>,
    sort: Option<String>,
    offset: Option<u64>,
    limit: Option<u64>,
) -> CommandResult<ModrinthSearchResult> {
    crate::content::search(
        &state,
        "curseforge",
        &query,
        project_type.as_deref(),
        game_version.as_deref(),
        loader.as_deref(),
        sort.as_deref(),
        offset.unwrap_or(0),
        limit.unwrap_or(24),
    )
    .await
    .map_err(Into::into)
}

#[tauri::command]
pub async fn get_modrinth_project_details(
    state: State<'_, AppState>,
    project_id: String,
) -> CommandResult<crate::models::ModrinthProjectDetails> {
    crate::content::modrinth::project_details(&state, &project_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn get_curseforge_project_details(
    state: State<'_, AppState>,
    project_id: String,
) -> CommandResult<crate::models::ModrinthProjectDetails> {
    crate::content::curseforge::project_details(&state, &project_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn list_content_providers(
    state: State<'_, AppState>,
) -> CommandResult<Vec<crate::models::ProviderAvailability>> {
    Ok(crate::content::provider_availability(&state).await)
}

#[tauri::command]
pub async fn get_curseforge_key_status(
    state: State<'_, AppState>,
) -> CommandResult<CurseForgeKeyStatus> {
    Ok(crate::content::curseforge::key_status(&state).await)
}

#[tauri::command]
pub async fn save_curseforge_api_key(
    state: State<'_, AppState>,
    api_key: String,
) -> CommandResult<CurseForgeKeyStatus> {
    crate::content::curseforge::save_api_key(&state, &api_key)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn clear_curseforge_api_key(
    state: State<'_, AppState>,
) -> CommandResult<CurseForgeKeyStatus> {
    crate::content::curseforge::clear_api_key(&state)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn plan_modrinth_install(
    state: State<'_, AppState>,
    instance_id: String,
    project_id: String,
) -> CommandResult<ContentInstallPlan> {
    crate::content::install::plan(&state, &instance_id, &project_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn install_modrinth_project(
    app: AppHandle,
    state: State<'_, AppState>,
    instance_id: String,
    project_id: String,
) -> CommandResult<ContentInstallResult> {
    crate::content::install::install(&crate::core_host::host(&app), &state, &instance_id, &project_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn install_modrinth_modpack(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    name: Option<String>,
    minecraft_version: Option<String>,
    loader: Option<String>,
    version_id: Option<String>,
) -> CommandResult<Instance> {
    async fn install(
        app: &AppHandle,
        state: &AppState,
        project_id: &str,
        name: Option<String>,
        minecraft_version: Option<String>,
        loader: Option<String>,
        version_id: Option<String>,
    ) -> crate::error::AppResult<Instance> {
        let instance = crate::content::install::install_modpack(
            &crate::core_host::host(app),
            state,
            project_id,
            name,
            minecraft_version.as_deref(),
            loader.as_deref(),
            version_id.as_deref(),
        )
        .await?;
        crate::sync::apply_to_new_instance(state, &instance).await?;
        Ok(instance)
    }
    install(
        &app,
        &state,
        &project_id,
        name,
        minecraft_version,
        loader,
        version_id,
    )
    .await
    .map_err(Into::into)
}

#[tauri::command]
pub async fn plan_curseforge_install(
    state: State<'_, AppState>,
    instance_id: String,
    project_id: String,
) -> CommandResult<ContentInstallPlan> {
    crate::content::curseforge::plan(&state, &instance_id, &project_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn install_curseforge_project(
    app: AppHandle,
    state: State<'_, AppState>,
    instance_id: String,
    project_id: String,
) -> CommandResult<ContentInstallResult> {
    crate::content::curseforge::install(&crate::core_host::host(&app), &state, &instance_id, &project_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn list_installed_content(
    state: State<'_, AppState>,
    instance_id: String,
    project_type: Option<String>,
) -> CommandResult<Vec<InstalledContentRecord>> {
    list_installed_content_records(&state, &instance_id, project_type.as_deref())
        .await
        .map_err(Into::into)
}

async fn list_installed_content_records(
    state: &AppState,
    instance_id: &str,
    project_type: Option<&str>,
) -> crate::error::AppResult<Vec<InstalledContentRecord>> {
    let _ = crate::database::instance(&state.database, instance_id).await?;
    let records = if let Some(project_type) = project_type {
        sqlx::query_as::<_, InstalledContentRecord>(
            "SELECT provider, project_id, version_id, project_type, display_name, file_path \
                 FROM installed_content WHERE instance_id = ? AND project_type = ? \
                 ORDER BY display_name COLLATE NOCASE",
        )
        .bind(instance_id)
        .bind(project_type)
        .fetch_all(&state.database)
        .await?
    } else {
        sqlx::query_as::<_, InstalledContentRecord>(
            "SELECT provider, project_id, version_id, project_type, display_name, file_path \
                 FROM installed_content WHERE instance_id = ? \
                 ORDER BY display_name COLLATE NOCASE",
        )
        .bind(instance_id)
        .fetch_all(&state.database)
        .await?
    };
    Ok(records)
}

#[tauri::command]
pub async fn reconcile_installed_content(
    state: State<'_, AppState>,
    instance_id: String,
    project_type: String,
) -> CommandResult<Vec<InstalledContentRecord>> {
    crate::content::install::reconcile_local_content(&state, &instance_id, &project_type).await?;
    list_installed_content_records(&state, &instance_id, Some(&project_type))
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn delete_instance_content(
    state: State<'_, AppState>,
    instance_id: String,
    category: String,
    path: String,
) -> CommandResult<()> {
    crate::storage::delete_instance_content(&state, &instance_id, &category, &path)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn set_instance_content_enabled(
    state: State<'_, AppState>,
    instance_id: String,
    category: String,
    path: String,
    enabled: bool,
) -> CommandResult<String> {
    crate::storage::set_instance_content_enabled(&state, &instance_id, &category, &path, enabled)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn install_curseforge_modpack(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    name: Option<String>,
) -> CommandResult<Instance> {
    async fn install(
        app: &AppHandle,
        state: &AppState,
        project_id: &str,
        name: Option<String>,
    ) -> crate::error::AppResult<Instance> {
        let instance =
            crate::content::curseforge::install_modpack(&crate::core_host::host(app), state, project_id, name).await?;
        crate::sync::apply_to_new_instance(state, &instance).await?;
        Ok(instance)
    }
    install(&app, &state, &project_id, name)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn list_loader_versions(
    state: State<'_, AppState>,
    loader_type: String,
    minecraft_version: String,
) -> CommandResult<Vec<LoaderVersion>> {
    crate::loaders::list_versions(&state, &loader_type, &minecraft_version)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn list_sync_mappings(state: State<'_, AppState>) -> CommandResult<Vec<SyncMapping>> {
    crate::sync::list_mappings(&state.database)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn create_sync_mapping(
    state: State<'_, AppState>,
    request: CreateSyncMappingRequest,
) -> CommandResult<SyncMapping> {
    crate::sync::create_mapping(&state, request)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn set_sync_mapping_enabled(
    state: State<'_, AppState>,
    mapping_id: String,
    enabled: bool,
) -> CommandResult<SyncMapping> {
    crate::sync::set_mapping_enabled(&state, &mapping_id, enabled)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn delete_sync_mapping(
    state: State<'_, AppState>,
    mapping_id: String,
) -> CommandResult<()> {
    crate::sync::delete_mapping(&state, &mapping_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn run_sync(
    state: State<'_, AppState>,
    instance_id: String,
    phase: String,
) -> CommandResult<Vec<SyncRunResult>> {
    let instance = database::instance(&state.database, &instance_id)
        .await
        .map_err(crate::error::CommandError::from)?;
    let phase = match phase.as_str() {
        "pull" => crate::sync::SyncPhase::Pull,
        "push" => crate::sync::SyncPhase::Push,
        _ => {
            return Err(crate::error::CommandError::from(
                crate::error::AppError::InvalidInput("Sync phase must be pull or push".into()),
            ));
        }
    };
    crate::sync::run_for_instance(&state, &instance, phase)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn run_sync_mapping_now(
    state: State<'_, AppState>,
    mapping_id: String,
    source_instance_id: String,
) -> CommandResult<Vec<SyncRunResult>> {
    crate::sync::run_mapping_now(&state, &mapping_id, &source_instance_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub fn reveal_shared_path(state: State<'_, AppState>) -> CommandResult<()> {
    crate::storage::reveal_shared_path(&state).map_err(Into::into)
}

#[tauri::command]
pub async fn open_instance_screenshot(
    state: State<'_, AppState>,
    instance_id: String,
    path: String,
) -> CommandResult<()> {
    crate::storage::open_instance_screenshot(&state, &instance_id, &path)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn get_screenshot_thumbnail(
    state: State<'_, AppState>,
    instance_id: String,
    path: String,
) -> CommandResult<String> {
    crate::storage::screenshot_thumbnail(&state, &instance_id, &path)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn get_instance_console(
    state: State<'_, AppState>,
    instance_id: String,
    limit: u32,
) -> CommandResult<Vec<ConsoleLine>> {
    crate::console::latest(&state, &instance_id, limit)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn list_instance_files(
    app: AppHandle,
    state: State<'_, AppState>,
    instance_id: String,
    category: String,
) -> CommandResult<Vec<InstanceFileEntry>> {
    async fn list(
        app: &AppHandle,
        state: &AppState,
        instance_id: &str,
        category: &str,
    ) -> crate::error::AppResult<Vec<InstanceFileEntry>> {
        let entries = crate::storage::list_instance_files(state, instance_id, category).await?;
        if category == "screenshots" {
            let scope = app.asset_protocol_scope();
            for entry in &entries {
                scope.allow_file(&entry.path).map_err(|error| {
                    crate::error::AppError::Security(format!(
                        "Screenshot preview could not be authorized: {error}"
                    ))
                })?;
            }
        }
        Ok(entries)
    }
    list(&app, &state, &instance_id, &category)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn get_storage_summary(state: State<'_, AppState>) -> CommandResult<StorageSummary> {
    crate::storage::summary(&state).await.map_err(Into::into)
}

#[tauri::command]
pub async fn list_downloads(
    state: State<'_, AppState>,
    limit: Option<u32>,
) -> CommandResult<Vec<DownloadRecord>> {
    crate::storage::list_downloads(&state, limit.unwrap_or(50))
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn list_servers(
    state: State<'_, AppState>,
    instance_id: String,
) -> CommandResult<Vec<ServerEntry>> {
    crate::servers::list(&state, &instance_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn add_server(
    state: State<'_, AppState>,
    request: AddServerRequest,
) -> CommandResult<Vec<ServerEntry>> {
    crate::servers::add(&state, request)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn remove_server(
    state: State<'_, AppState>,
    instance_id: String,
    index: u32,
) -> CommandResult<Vec<ServerEntry>> {
    crate::servers::remove(&state, &instance_id, index)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn inspect_archive(
    _state: State<'_, AppState>,
    archive_path: String,
) -> CommandResult<ArchiveInspection> {
    crate::archives::inspect_archive(&archive_path, true)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn import_slh_archive(
    state: State<'_, AppState>,
    request: ImportSlhRequest,
) -> CommandResult<Instance> {
    async fn import(
        state: &AppState,
        request: ImportSlhRequest,
    ) -> crate::error::AppResult<Instance> {
        let instance = crate::archives::import_slh(state, request).await?;
        crate::sync::apply_to_new_instance(state, &instance).await?;
        Ok(instance)
    }
    import(&state, request).await.map_err(Into::into)
}

#[tauri::command]
pub async fn import_modrinth_pack(
    app: AppHandle,
    state: State<'_, AppState>,
    request: ImportSlhRequest,
) -> CommandResult<Instance> {
    async fn import(
        app: &AppHandle,
        state: &AppState,
        request: ImportSlhRequest,
    ) -> crate::error::AppResult<Instance> {
        let instance = crate::archives::import_modrinth_pack(&crate::core_host::host(app), state, request).await?;
        crate::sync::apply_to_new_instance(state, &instance).await?;
        Ok(instance)
    }
    import(&app, &state, request).await.map_err(Into::into)
}

#[tauri::command]
pub async fn import_curseforge_pack(
    app: AppHandle,
    state: State<'_, AppState>,
    request: ImportSlhRequest,
) -> CommandResult<Instance> {
    async fn import(
        app: &AppHandle,
        state: &AppState,
        request: ImportSlhRequest,
    ) -> crate::error::AppResult<Instance> {
        let instance = crate::archives::import_curseforge_pack(&crate::core_host::host(app), state, request).await?;
        crate::sync::apply_to_new_instance(state, &instance).await?;
        Ok(instance)
    }
    import(&app, &state, request).await.map_err(Into::into)
}

#[tauri::command]
pub async fn import_instance_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    request: ImportFolderRequest,
) -> CommandResult<Instance> {
    async fn import(
        app: &AppHandle,
        state: &AppState,
        request: ImportFolderRequest,
    ) -> crate::error::AppResult<Instance> {
        let instance = crate::archives::import_folder(&crate::core_host::host(app), state, request).await?;
        crate::sync::apply_to_new_instance(state, &instance).await?;
        Ok(instance)
    }
    import(&app, &state, request).await.map_err(Into::into)
}

#[tauri::command]
pub async fn export_instance(
    state: State<'_, AppState>,
    instance_id: String,
    request: crate::models::ExportInstanceRequest,
) -> CommandResult<ExportResult> {
    crate::archives::export_instance(&state, &instance_id, request)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn list_instance_export_entries(
    state: State<'_, AppState>,
    instance_id: String,
) -> CommandResult<Vec<crate::models::ExportEntry>> {
    crate::archives::list_export_entries(&state, &instance_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn create_instance_desktop_shortcut(
    state: State<'_, AppState>,
    instance_id: String,
) -> CommandResult<()> {
    let instance = database::instance(&state.database, &instance_id).await?;
    #[cfg(windows)]
    {
        let exe = std::env::current_exe().map_err(|error| {
            crate::error::AppError::Process(format!(
                "Could not resolve launcher executable: {error}"
            ))
        })?;
        let desktop = std::env::var("USERPROFILE")
            .map(|home| std::path::PathBuf::from(home).join("Desktop"))
            .map_err(|_| {
                crate::error::AppError::Process(
                    "Could not locate the Windows desktop folder".into(),
                )
            })?;
        let safe_name = instance
            .name
            .replace(['<', '>', ':', '"', '/', '\\', '|', '?', '*'], "-");
        let link = desktop.join(format!("SLH - {safe_name}.lnk"));
        let quote = |value: &std::path::Path| value.to_string_lossy().replace('\'', "''");
        let script = format!(
            "$shell = New-Object -ComObject WScript.Shell; $link = $shell.CreateShortcut('{}'); $link.TargetPath = '{}'; $link.Arguments = '--launch-instance {}'; $link.WorkingDirectory = '{}'; $link.Description = 'Launch Minecraft instance: {}'; $link.Save()",
            quote(&link),
            quote(&exe),
            instance.id.replace('\'', "''"),
            quote(&std::path::PathBuf::from(&instance.game_dir)),
            instance.name.replace('\'', "''")
        );
        let output = tokio::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                &script,
            ])
            .output()
            .await
            .map_err(|error| {
                crate::error::AppError::Process(format!(
                    "Could not create desktop shortcut: {error}"
                ))
            })?;
        if !output.status.success() {
            return Err(crate::error::AppError::Process(format!(
                "Windows could not create the shortcut: {}",
                String::from_utf8_lossy(&output.stderr)
            ))
            .into());
        }
    }
    #[cfg(not(windows))]
    {
        let _ = instance;
        return Err(crate::error::AppError::InvalidInput(
            "Desktop shortcuts are currently supported on Windows only".into(),
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn repair_instance(
    app: AppHandle,
    state: State<'_, AppState>,
    instance_id: String,
) -> CommandResult<Instance> {
    minecraft::installer::install_instance(&crate::core_host::host(&app), &state, &instance_id, None)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn get_system_metrics(state: State<'_, AppState>, scope: Option<crate::system_metrics::MetricsScope>, metrics: Option<Vec<crate::system_metrics::Metric>>) -> CommandResult<crate::system_metrics::SystemMetrics> {
    let root = state.paths.root.clone();
    tokio::task::spawn_blocking(move || crate::system_metrics::sample(&root, scope, metrics))
        .await.map_err(|error| crate::error::AppError::Process(format!("System metrics task failed: {error}")))?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn get_launcher_storage_usage(state: State<'_, AppState>, force: Option<bool>) -> CommandResult<u64> {
    let root = state.paths.root.clone();
    tokio::task::spawn_blocking(move || crate::system_metrics::launcher_storage_bytes(&root, force.unwrap_or(false)))
        .await.map_err(|error| crate::error::AppError::Process(format!("Launcher storage task failed: {error}")))?
        .map_err(Into::into)
}
