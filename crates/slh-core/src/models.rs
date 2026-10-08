use serde::{Deserialize, Serialize};
use sqlx::FromRow;

#[derive(Clone, Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Instance {
    pub id: String,
    pub name: String,
    pub group_id: Option<String>,
    pub icon_path: Option<String>,
    pub folder_name: String,
    pub icon_key: String,
    pub icon_background: Option<String>,
    pub icon_foreground: Option<String>,
    pub minecraft_version: String,
    pub loader_type: String,
    pub loader_version: Option<String>,
    pub status: String,
    pub created_at: String,
    pub last_played_at: Option<String>,
    pub last_launched_at: Option<String>,
    pub playtime_seconds: i64,
    pub java_path: Option<String>,
    pub memory_min_mb: i64,
    pub memory_max_mb: i64,
    pub game_dir: String,
    pub config_schema_version: i64,
    /// Bedrock-only profile strategy. Existing databases are migrated to
    /// `shared` so an upgrade can never replace the user's current worlds.
    pub bedrock_profile_mode: String,
}

#[derive(Clone, Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct InstanceGroup {
    pub id: String,
    pub name: String,
    pub sort_order: i64,
    pub collapsed: bool,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub provider: String,
    pub provider_uuid: String,
    /// Xbox XUID used to bind a Microsoft Store entitlement to this account.
    /// Java's profile UUID in `provider_uuid` is a different identity.
    pub xbox_xuid: Option<String>,
    pub username: String,
    pub avatar_cache_path: Option<String>,
    pub auth_status: String,
    pub last_auth_at: Option<String>,
    pub active: bool,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountTexture {
    pub id: String,
    pub data_url: Option<String>,
    /// A compact, front-facing preview when the original texture contains
    /// multiple regions (Microsoft cape sheets). Older cached appearance
    /// files do not have this field, so keep deserialization backward-safe.
    #[serde(default)]
    pub thumbnail_data_url: Option<String>,
    pub variant: Option<String>,
    pub alias: Option<String>,
    pub active: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountAppearance {
    pub account_id: String,
    pub provider: String,
    pub username: String,
    pub can_change_skin: bool,
    pub can_change_cape: bool,
    pub message: Option<String>,
    pub skins: Vec<AccountTexture>,
    pub capes: Vec<AccountTexture>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocaleDescriptor {
    pub code: String,
    pub name: String,
    pub path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapData {
    pub capabilities: crate::platform::Capabilities,
    pub version: String,
    pub build_unix: u64,
    pub portable_root: String,
    pub first_run: bool,
    pub locales: Vec<LocaleDescriptor>,
    pub settings: serde_json::Value,
    pub groups: Vec<InstanceGroup>,
    pub instances: Vec<Instance>,
    pub accounts: Vec<Account>,
    pub providers: Vec<ProviderAvailability>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherUpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub release_name: String,
    pub release_url: String,
    pub published_at: Option<String>,
    pub update_available: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAvailability {
    pub provider: String,
    pub available: bool,
    pub message: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurseForgeKeyStatus {
    pub configured: bool,
    pub source: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    pub operation_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance_id: Option<String>,
    pub operation: String,
    pub stage: String,
    pub message: String,
    pub completed: u64,
    pub total: Option<u64>,
    pub downloaded_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateGroupRequest {
    pub name: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetGroupCollapsedRequest {
    pub group_id: String,
    pub collapsed: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssignInstanceGroupRequest {
    pub instance_id: String,
    pub group_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameGroupRequest {
    pub group_id: String,
    pub name: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteGroupRequest {
    pub group_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderGroupsRequest {
    pub group_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateOfflineAccountRequest {
    pub username: String,
    #[serde(default)]
    pub allow_invalid_username: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginElyByRequest {
    pub username: String,
    pub password: String,
    pub totp: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateInstanceRequest {
    pub name: String,
    pub group_id: Option<String>,
    pub minecraft_version: String,
    pub loader_type: String,
    pub loader_version: Option<String>,
    pub java_path: Option<String>,
    pub memory_min_mb: i64,
    pub memory_max_mb: i64,
    #[serde(default)]
    pub icon_key: Option<String>,
    #[serde(default)]
    pub icon_background: Option<String>,
    #[serde(default)]
    pub icon_foreground: Option<String>,
    #[serde(default)]
    pub bedrock_profile_mode: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInstanceRequest {
    pub instance_id: String,
    pub name: String,
    pub icon_key: String,
    pub icon_background: String,
    pub icon_foreground: String,
    pub memory_min_mb: i64,
    pub memory_max_mb: i64,
    #[serde(default)]
    pub minecraft_version: Option<String>,
    #[serde(default)]
    pub loader_type: Option<String>,
    #[serde(default)]
    pub loader_version: Option<String>,
    #[serde(default)]
    pub bedrock_profile_mode: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteInstanceResult {
    pub instance_id: String,
    pub backup_path: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MinecraftVersionSummary {
    pub id: String,
    pub version_type: String,
    pub release_time: String,
    pub url: String,
    pub sha1: String,
    /// Additional official package URLs for Bedrock GDK downloads. Java and
    /// UWP entries keep this empty.
    #[serde(default)]
    pub mirrors: Vec<String>,
    /// MD5 published by the Bedrock GDK catalogue. It is optional because
    /// the Microsoft Update UWP catalogue does not publish one.
    #[serde(default)]
    pub md5: Option<String>,
    #[serde(default)]
    pub size_bytes: Option<u64>,
    #[serde(default)]
    pub package_type: Option<String>,
    /// Deployment route: Windows Update, licensed native MSIXVC extraction,
    /// or adoption of an already registered Store package.
    #[serde(default)]
    pub install_method: Option<String>,
    #[serde(default)]
    pub package_family_name: Option<String>,
    #[serde(default)]
    pub channel: Option<String>,
    #[serde(default)]
    pub architecture: Option<String>,
    #[serde(default)]
    pub installability: Option<String>,
    #[serde(default)]
    pub install_reason: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BedrockMirrorProbe {
    pub url: String,
    pub host: String,
    pub latency_ms: Option<u64>,
    pub ok: bool,
    pub status: Option<u16>,
    pub content_length: Option<u64>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JavaInstallation {
    pub architecture: String,
    pub path: String,
    pub version: String,
    pub major_version: u32,
    pub source: String,
    pub compatible: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoaderVersion {
    pub id: String,
    pub stable: bool,
    pub recommended: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncMapping {
    pub id: String,
    pub category: String,
    pub instance_ids: Vec<String>,
    pub direction: String,
    pub enabled: bool,
    pub source_relative_path: String,
    pub target_relative_path: String,
    pub safety_level: String,
    pub last_sync_at: Option<String>,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSyncMappingRequest {
    pub category: String,
    pub instance_ids: Vec<String>,
    pub direction: String,
    pub initial_source: String,
    #[serde(default)]
    pub acknowledge_world_risk: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRunResult {
    pub mapping_id: String,
    pub instance_id: String,
    pub phase: String,
    pub copied_files: u64,
    pub unchanged_files: u64,
    pub backups_created: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleLine {
    pub timestamp: Option<String>,
    pub stream: String,
    pub level: String,
    pub text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleLineEvent {
    pub launch_id: String,
    pub instance_id: String,
    pub timestamp: Option<String>,
    pub stream: String,
    pub level: String,
    pub text: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceFileEntry {
    pub name: String,
    pub path: String,
    pub entry_type: String,
    pub size_bytes: u64,
    pub modified_at: Option<String>,
    pub icon_data_url: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionMigrationEntry {
    pub path: String,
    pub name: String,
    pub is_directory: bool,
    pub file_count: u64,
    pub size_bytes: u64,
    pub selected_by_default: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionMigrationContent {
    pub path: String,
    pub is_directory: bool,
    pub provider: Option<String>,
    pub project_id: Option<String>,
    pub project_type: String,
    pub display_name: String,
    pub current_version_id: Option<String>,
    pub update_status: String,
    pub candidate_version: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceVersionMigrationPreview {
    pub entries: Vec<VersionMigrationEntry>,
    pub content: Vec<VersionMigrationContent>,
    pub target_loader_version: Option<String>,
    pub loader_error: Option<String>,
    pub lookup_warnings: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectInstanceVersionMigrationRequest {
    pub instance_id: String,
    pub target_minecraft_version: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListInstanceVersionMigrationEntriesRequest {
    pub instance_id: String,
    pub path: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionMigrationSelection {
    pub path: String,
    pub selected: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionMigrationFallbackOverride {
    pub path: String,
    pub action: VersionMigrationFallbackAction,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum VersionMigrationFallbackAction {
    #[default]
    Copy,
    Disable,
    Skip,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateInstanceVersionCopyRequest {
    pub instance_id: String,
    pub target_minecraft_version: String,
    pub selections: Vec<VersionMigrationSelection>,
    #[serde(default)]
    pub update_selections: Vec<VersionMigrationSelection>,
    #[serde(default)]
    pub fallback_action: VersionMigrationFallbackAction,
    #[serde(default)]
    pub fallback_overrides: Vec<VersionMigrationFallbackOverride>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionMigrationIssue {
    pub path: String,
    pub display_name: String,
    pub project_type: String,
    pub reason: String,
    pub action: VersionMigrationFallbackAction,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateInstanceVersionCopyResult {
    pub instance: Instance,
    pub updated_content_files: u64,
    pub warnings: Vec<String>,
    pub issues: Vec<VersionMigrationIssue>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageSummary {
    pub total_bytes: u64,
    pub database_bytes: u64,
    pub instances_bytes: u64,
    pub shared_bytes: u64,
    pub cache_bytes: u64,
    pub downloads_bytes: u64,
    pub java_bytes: u64,
    pub logs_bytes: u64,
    pub backups_bytes: u64,
}

#[derive(Clone, Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRecord {
    pub id: String,
    pub source: String,
    pub destination: String,
    pub status: String,
    pub downloaded_bytes: i64,
    pub total_bytes: Option<i64>,
    pub error_message: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerEntry {
    pub index: u32,
    pub name: String,
    pub address: String,
    pub accept_textures: Option<bool>,
    pub has_icon: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddServerRequest {
    pub instance_id: String,
    pub name: String,
    pub address: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveInspection {
    pub archive_type: String,
    pub name: Option<String>,
    pub minecraft_version: Option<String>,
    pub loader_type: Option<String>,
    pub loader_version: Option<String>,
    pub can_import: bool,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub path: String,
    pub files_written: u64,
    pub size_bytes: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportEntry {
    pub relative_path: String,
    pub is_directory: bool,
    pub files: u64,
    pub size_bytes: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportInstanceRequest {
    pub destination: String,
    pub format: String,
    pub entries: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSlhRequest {
    pub archive_path: String,
    pub name: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportFolderRequest {
    pub source_path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchResponse {
    pub launch_id: String,
    pub instance_id: String,
    pub status: String,
    pub log_path: String,
    pub used_offline_fallback: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModrinthProject {
    pub project_id: String,
    pub slug: String,
    pub title: String,
    pub description: String,
    pub project_type: String,
    pub icon_url: Option<String>,
    pub downloads: u64,
    pub follows: u64,
    pub author: String,
    pub categories: Vec<String>,
    pub versions: Vec<String>,
    pub date_modified: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModrinthSearchResult {
    pub hits: Vec<ModrinthProject>,
    pub offset: u64,
    pub limit: u64,
    pub total_hits: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGalleryImage {
    pub url: String,
    pub thumbnail_url: Option<String>,
    pub title: Option<String>,
    pub description: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModpackVersionOption {
    pub id: String,
    pub name: String,
    pub version_number: String,
    pub game_versions: Vec<String>,
    pub loaders: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModrinthProjectDetails {
    pub project_id: String,
    pub body: String,
    pub gallery: Vec<ProjectGalleryImage>,
    #[serde(default)]
    pub modpack_versions: Vec<ModpackVersionOption>,
}

#[derive(Clone, Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct InstalledContentRecord {
    pub provider: String,
    pub project_id: String,
    pub version_id: String,
    pub project_type: String,
    pub display_name: String,
    pub file_path: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentInstallPlanItem {
    pub project_id: String,
    pub version_id: String,
    pub display_name: String,
    pub version_number: String,
    pub file_name: String,
    pub destination: String,
    pub size_bytes: u64,
    pub action: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentInstallPlan {
    pub provider: String,
    pub root_project_id: String,
    pub instance_id: String,
    pub project_type: String,
    pub items: Vec<ContentInstallPlanItem>,
    pub conflicts: Vec<String>,
    pub total_bytes: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentInstallResult {
    pub plan: ContentInstallPlan,
    pub installed_files: u64,
    pub unchanged_files: u64,
    pub backups_created: u64,
}
