use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};

use crate::host::Host;
use chrono::Utc;
use reqwest::header::HeaderValue;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use uuid::Uuid;

use crate::database;
use crate::error::{AppError, AppResult};
use crate::minecraft::download::{
    DownloadPlan, configured_concurrency, download_many, download_verified_with_progress,
    verify_sha1,
};
use crate::models::{
    ContentInstallPlan, ContentInstallPlanItem, ContentInstallResult, CurseForgeKeyStatus,
    ImportSlhRequest, Instance, ModpackVersionOption, ModrinthProject, ModrinthProjectDetails,
    ModrinthSearchResult, ProgressEvent, ProjectGalleryImage,
};
use crate::portable::PortablePaths;
use crate::security::{decrypt_for_current_user, encrypt_for_current_user, validate_relative_path};
use crate::state::AppState;

const API_ROOT: &str = "https://api.curseforge.com/v1";
const RELAY_API_ROOT: &str = "https://voluble-entremet-324baf.netlify.app/api/v1";
const MINECRAFT_GAME_ID: u64 = 432;
const BEDROCK_GAME_ID: u64 = 78022;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchResponse {
    data: Vec<Project>,
    pagination: Pagination,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Project {
    id: u64,
    name: String,
    slug: String,
    summary: String,
    download_count: u64,
    class_id: Option<u64>,
    #[serde(default)]
    categories: Vec<Category>,
    #[serde(default)]
    authors: Vec<Author>,
    logo: Option<Asset>,
    #[serde(default)]
    screenshots: Vec<Screenshot>,
    #[serde(default)]
    latest_files_indexes: Vec<FileIndex>,
    date_modified: String,
    allow_mod_distribution: Option<bool>,
}

#[derive(Clone, Deserialize)]
struct Category {
    slug: String,
}

#[derive(Clone, Deserialize)]
struct Author {
    name: String,
}

#[derive(Clone, Deserialize)]
struct Asset {
    url: String,
}

#[derive(Clone, Deserialize)]
struct Screenshot {
    url: String,
    title: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileIndex {
    game_version: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pagination {
    index: u64,
    page_size: u64,
    total_count: u64,
}

#[derive(Deserialize)]
struct ProjectResponse {
    data: Project,
}

#[derive(Deserialize)]
struct FilesResponse {
    data: Vec<ProjectFile>,
}

#[derive(Deserialize)]
struct FileResponse {
    data: ProjectFile,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectFile {
    id: u64,
    mod_id: u64,
    is_available: bool,
    display_name: String,
    file_name: String,
    release_type: u32,
    #[serde(default)]
    hashes: Vec<FileHash>,
    file_date: String,
    file_length: u64,
    download_url: Option<String>,
    #[serde(default)]
    game_versions: Vec<String>,
    #[serde(default)]
    dependencies: Vec<FileDependency>,
}

#[derive(Clone, Deserialize)]
struct FileHash {
    value: String,
    algo: u32,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileDependency {
    mod_id: u64,
    relation_type: u32,
}

#[derive(Deserialize)]
struct StringResponse {
    data: String,
}

#[derive(Clone)]
struct ResolvedItem {
    plan: ContentInstallPlanItem,
    project_type: String,
    url: String,
    sha1: String,
    old_path: Option<String>,
}

pub(crate) struct PackDownload {
    pub project_type: String,
    pub display_name: String,
    pub file_name: String,
    pub url: String,
    pub sha1: String,
    pub size_bytes: u64,
    pub manual_download_url: Option<String>,
    pub local_path: Option<PathBuf>,
}

pub(crate) fn environment_api_key() -> Option<String> {
    std::env::var("SLH_CURSEFORGE_API_KEY")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

pub(crate) fn load_portable_key(paths: &PortablePaths) -> AppResult<Option<String>> {
    let path = portable_key_path(paths);
    if !path.is_file() {
        return Ok(None);
    }
    let encrypted = std::fs::read(path)?;
    let decrypted = decrypt_for_current_user(&encrypted)?;
    let key = String::from_utf8(decrypted)
        .map_err(|_| AppError::Security("Stored CurseForge API key is not valid UTF-8".into()))?;
    let key = normalize_key(&key)?;
    Ok(Some(key))
}

pub async fn key_status(state: &AppState) -> CurseForgeKeyStatus {
    let configured = state.curseforge_api_key.read().await.is_some();
    let source = state.curseforge_key_source.read().await.clone();
    let message = match source.as_str() {
        "environment" => {
            "Configured by SLH_CURSEFORGE_API_KEY. Environment values override portable storage."
        }
        "portable" => "Stored locally as a Windows DPAPI-encrypted portable secret.",
        "unavailable" => {
            "The stored key cannot be decrypted by this Windows profile. Save it again."
        }
        _ => "No personal key configured. CurseForge requests use the SLH relay.",
    };
    CurseForgeKeyStatus {
        configured,
        source,
        message: message.into(),
    }
}

pub async fn save_api_key(state: &AppState, value: &str) -> AppResult<CurseForgeKeyStatus> {
    if environment_api_key().is_some() {
        return Err(AppError::Conflict(
            "SLH_CURSEFORGE_API_KEY is active. Remove that environment variable before using portable key storage.".into(),
        ));
    }
    let key = normalize_key(value)?;
    let header = header_value(&key)?;
    let response = state
        .http
        .get(format!("{API_ROOT}/games/{MINECRAFT_GAME_ID}"))
        .header("x-api-key", header)
        .send()
        .await?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED
        || response.status() == reqwest::StatusCode::FORBIDDEN
    {
        return Err(AppError::InvalidInput(
            "CurseForge rejected this API key. Check the approved key and try again.".into(),
        ));
    }
    response.error_for_status()?;
    let encrypted = encrypt_for_current_user(key.as_bytes())?;
    let destination = portable_key_path(&state.paths);
    let parent = destination
        .parent()
        .ok_or_else(|| AppError::InvalidInput("CurseForge secret path has no parent".into()))?;
    tokio::fs::create_dir_all(parent).await?;
    let temporary = destination.with_extension(format!("{}.tmp", Uuid::new_v4()));
    tokio::fs::write(&temporary, encrypted).await?;
    if destination.exists() {
        tokio::fs::remove_file(&destination).await?;
    }
    tokio::fs::rename(temporary, destination).await?;
    *state.curseforge_api_key.write().await = Some(key);
    *state.curseforge_key_source.write().await = "portable".into();
    Ok(key_status(state).await)
}

pub async fn clear_api_key(state: &AppState) -> AppResult<CurseForgeKeyStatus> {
    if environment_api_key().is_some() {
        return Err(AppError::Conflict(
            "The active CurseForge key comes from SLH_CURSEFORGE_API_KEY and cannot be removed by SLH.".into(),
        ));
    }
    let destination = portable_key_path(&state.paths);
    if destination.exists() {
        tokio::fs::remove_file(destination).await?;
    }
    *state.curseforge_api_key.write().await = None;
    *state.curseforge_key_source.write().await = "none".into();
    Ok(key_status(state).await)
}

async fn active_api_key(state: &AppState) -> Option<String> {
    state.curseforge_api_key.read().await.clone()
}

async fn api_get(state: &AppState, relative_path: &str) -> AppResult<reqwest::RequestBuilder> {
    validate_api_relative_path(relative_path)?;
    if let Some(key) = active_api_key(state).await {
        Ok(state
            .http
            .get(format!("{API_ROOT}/{relative_path}"))
            .header("x-api-key", header_value(&key)?))
    } else {
        Ok(state.http.get(format!("{RELAY_API_ROOT}/{relative_path}")))
    }
}

async fn api_post(state: &AppState, relative_path: &str, body: &serde_json::Value) -> AppResult<reqwest::RequestBuilder> {
    validate_api_relative_path(relative_path)?;
    let request = if let Some(key) = active_api_key(state).await {
        state.http.post(format!("{API_ROOT}/{relative_path}")).header("x-api-key", header_value(&key)?)
    } else { state.http.post(format!("{RELAY_API_ROOT}/{relative_path}")) };
    Ok(request.json(body))
}

/// Populate the same per-file cache used by normal lookups. A pack containing
/// hundreds of mods needs two batch requests rather than two requests per mod.
/// Older relays fall back once to GET without failing the user's installation.
pub(crate) async fn prefetch_pack_metadata(state: &AppState, entries: &[(u64, u64)]) -> AppResult<()> {
    if !state.curseforge_http.batch_available(api_post(state, "mods", &serde_json::json!({ "modIds": [] })).await?).await? { return Ok(()); }
    for files in [false, true] {
        let mut missing = Vec::new();
        let mut seen = HashSet::new();
        for &(project, file) in entries {
            let id = if files { file } else { project };
            if !seen.insert(id) { continue; }
            let endpoint = if files { format!("mods/{project}/files/{file}") } else { format!("mods/{project}") };
            if !state.curseforge_http.cached(api_get(state, &endpoint).await?, &state.database).await? { missing.push(id); }
        }
        for chunk in missing.chunks(100) {
            let endpoint = if files { "mods/files" } else { "mods" };
            let body = if files { serde_json::json!({ "fileIds": chunk }) } else { serde_json::json!({ "modIds": chunk }) };
            let response: serde_json::Value = match send_api_json(state, api_post(state, endpoint, &body).await?).await {
                Ok(value) => value,
                Err(AppError::Unavailable(message)) if message == "CurseForge batch requests are unavailable" => return Ok(()),
                Err(error) => return Err(error),
            };
            let data = response.get("data").and_then(|data| data.as_array()).ok_or_else(|| AppError::Unavailable("CurseForge batch response has no data array".into()))?;
            for value in data {
                let Some(id) = value.get("id").and_then(|id| id.as_u64()).filter(|id| chunk.contains(id)) else { continue; };
                let endpoint = if files {
                    let Some(&(project, _)) = entries.iter().find(|&&(_, file)| file == id) else { continue; };
                    if value.get("modId").and_then(|id| id.as_u64()) != Some(project) {
                        return Err(AppError::Security("CurseForge batch returned a file belonging to another project".into()));
                    }
                    format!("mods/{project}/files/{id}")
                } else { format!("mods/{id}") };
                state.curseforge_http.remember(api_get(state, &endpoint).await?, serde_json::json!({ "data": value }), &state.database).await?;
            }
        }
    }
    Ok(())
}

fn validate_api_relative_path(relative_path: &str) -> AppResult<()> {
    if relative_path.is_empty()
        || relative_path.starts_with('/')
        || relative_path.contains("..")
        || relative_path.contains(['\\', '?', '#'])
    {
        Err(AppError::Security(
            "CurseForge request path is not a safe relative API path".into(),
        ))
    } else {
        Ok(())
    }
}

async fn send_api_json<T: DeserializeOwned>(
    state: &AppState,
    request: reqwest::RequestBuilder,
) -> AppResult<T> {
    let value = state.curseforge_http.json(
        &state.http, request, Some(&state.database), active_api_key(state).await.is_some(),
    ).await?;
    Ok(serde_json::from_value(value)?)
}

fn portable_key_path(paths: &PortablePaths) -> PathBuf {
    paths.data.join("secrets").join("curseforge-api-key.dpapi")
}

fn normalize_key(value: &str) -> AppResult<String> {
    let key = value.trim();
    if key.is_empty() || key.len() > 1024 {
        return Err(AppError::InvalidInput(
            "CurseForge API key must contain between 1 and 1024 characters".into(),
        ));
    }
    header_value(key)?;
    Ok(key.to_owned())
}

fn header_value(key: &str) -> AppResult<HeaderValue> {
    HeaderValue::from_str(key)
        .map_err(|_| AppError::InvalidInput("CurseForge API key is not a valid HTTP header".into()))
}

pub async fn search(
    state: &AppState,
    query: &str,
    project_type: Option<&str>,
    game_version: Option<&str>,
    loader: Option<&str>,
    category: Option<&str>,
    sort: Option<&str>,
    offset: u64,
    limit: u64,
) -> AppResult<ModrinthSearchResult> {
    let limit = limit.clamp(1, 50);
    let mut parameters = vec![
        ("gameId", MINECRAFT_GAME_ID.to_string()),
        ("index", offset.min(9_999).to_string()),
        ("pageSize", limit.to_string()),
        (
            "sortField",
            curseforge_sort_field(sort.unwrap_or("relevance")).to_string(),
        ),
        ("sortOrder", "desc".into()),
    ];
    if let Some(category) = category.filter(|value| !value.is_empty()) {
        let id = category.parse::<u64>().map_err(|_| AppError::InvalidInput("Invalid CurseForge category".into()))?;
        parameters.push(("categoryId", id.to_string()));
    }
    if !query.trim().is_empty() {
        parameters.push(("searchFilter", query.trim().to_owned()));
    }
    if let Some(class_id) = project_type.and_then(class_id_for) {
        parameters.push(("classId", class_id.to_string()));
    }
    if let Some(version) = game_version
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        parameters.push(("gameVersion", version.to_owned()));
    }
    if let (Some(loader), Some(project_type)) = (
        loader.map(str::trim).filter(|value| !value.is_empty()),
        project_type,
    ) {
        if let Some(code) = loader_code(loader, project_type)? {
            parameters.push(("modLoaderType", code.to_string()));
        }
    }
    let response: SearchResponse = send_api_json(
        state,
        api_get(state, "mods/search").await?.query(&parameters),
    )
    .await?;
    Ok(ModrinthSearchResult {
        hits: response.data.into_iter().map(project_to_dto).collect(),
        offset: response.pagination.index,
        limit: response.pagination.page_size,
        total_hits: response.pagination.total_count,
    })
}

pub async fn search_bedrock(
    state: &AppState,
    query: &str,
    category: &str,
    offset: u64,
    game_version: Option<&str>,
    sort: Option<&str>,
) -> AppResult<ModrinthSearchResult> {
    let class_id = match category {
        "addons" => 4984,
        "resourcepacks" => 6929,
        "worlds" => 6913,
        _ => {
            return Err(AppError::InvalidInput(
                "Unknown Bedrock catalog category".into(),
            ));
        }
    };
    let mut parameters = vec![
        ("gameId", BEDROCK_GAME_ID.to_string()),
        ("classId", class_id.to_string()),
        ("index", offset.min(9_999).to_string()),
        ("pageSize", "24".into()),
        (
            "sortField",
            curseforge_sort_field(sort.unwrap_or("downloads")).to_string(),
        ),
        ("sortOrder", "desc".into()),
    ];
    if !query.trim().is_empty() {
        parameters.push(("searchFilter", query.trim().to_owned()));
    }
    if let Some(version) = game_version.filter(|version| !version.trim().is_empty()) {
        parameters.push(("gameVersion", version.trim().to_owned()));
    }
    let response: SearchResponse = send_api_json(
        state,
        api_get(state, "mods/search").await?.query(&parameters),
    )
    .await?;
    let hits = response.data.into_iter().map(project_to_dto).collect();
    Ok(ModrinthSearchResult {
        hits,
        offset: response.pagination.index,
        limit: response.pagination.page_size,
        total_hits: response.pagination.total_count,
    })
}

pub async fn download_bedrock(
    state: &AppState,
    project_id: &str,
    game_version: Option<&str>,
) -> AppResult<PathBuf> {
    let project_id = validate_project_id(project_id)?;
    let project = project(state, project_id).await?;
    if !matches!(project.class_id, Some(4984 | 6929 | 6913)) {
        return Err(AppError::InvalidInput(
            "This project is not Bedrock content".into(),
        ));
    }
    if project.allow_mod_distribution == Some(false) {
        return Err(AppError::Unavailable(
            "This author allows downloads only on the CurseForge website".into(),
        ));
    }
    let mut file_request = api_get(state, &format!("mods/{project_id}/files"))
        .await?
        .query(&[("pageSize", "50")]);
    if let Some(version) = game_version.filter(|version| !version.trim().is_empty()) {
        file_request = file_request.query(&[("gameVersion", version.trim())]);
    }
    let mut files: FilesResponse = send_api_json(state, file_request).await?;
    files.data.retain(|file| {
        let extension = Path::new(&file.file_name)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        file.is_available
            && file.hashes.iter().any(|hash| hash.algo == 1)
            && ["mcpack", "mcaddon", "mcworld"]
                .iter()
                .any(|allowed| extension.eq_ignore_ascii_case(allowed))
            && game_version
                .filter(|version| !version.trim().is_empty())
                .is_none_or(|version| {
                    file.game_versions
                        .iter()
                        .any(|supported| supported == version)
                })
    });
    files.data.sort_by(|left, right| {
        left.release_type
            .cmp(&right.release_type)
            .then_with(|| right.file_date.cmp(&left.file_date))
    });
    let file = files.data.into_iter().next().ok_or_else(|| {
        AppError::Unavailable("No importable Bedrock package is available for this project".into())
    })?;
    validate_file_name(&file.file_name)?;
    let extension = Path::new(&file.file_name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "mcpack" | "mcaddon" | "mcworld") {
        return Err(AppError::InvalidInput(
            "The latest CurseForge file is not a Bedrock import package".into(),
        ));
    }
    if file.file_length == 0 || file.file_length > 200 * 1024 * 1024 {
        return Err(AppError::InvalidInput(
            "Bedrock package must be smaller than 200 MB".into(),
        ));
    }
    let sha1 = file
        .hashes
        .iter()
        .find(|hash| hash.algo == 1)
        .map(|hash| hash.value.clone())
        .ok_or_else(|| AppError::Security("CurseForge file has no SHA-1 hash".into()))?;
    let url = download_url(state, project_id, file.id, file.download_url.as_deref()).await?;
    let folder = state.paths.downloads.join("bedrock");
    tokio::fs::create_dir_all(&folder).await?;
    let destination = folder.join(format!("{project_id}-{}-{}", file.id, file.file_name));
    download_verified_with_progress(
        &state.http,
        &DownloadPlan {
            url,
            destination: destination.clone(),
            sha1: Some(sha1),
            max_bytes: Some(200 * 1024 * 1024),
        },
        |_completed, _total| {},
    )
    .await?;
    Ok(destination)
}

pub async fn plan(
    state: &AppState,
    instance_id: &str,
    project_id: &str,
) -> AppResult<ContentInstallPlan> {
    let (_, plan) = resolve(state, instance_id, project_id).await?;
    Ok(plan)
}

pub async fn install(
    app: &Host,
    state: &AppState,
    instance_id: &str,
    project_id: &str,
) -> AppResult<ContentInstallResult> {
    if state.running_instances.read().await.contains(instance_id) {
        return Err(AppError::Conflict(
            "Content cannot be changed while the instance is running".into(),
        ));
    }
    let (resolved, plan) = resolve(state, instance_id, project_id).await?;
    if !plan.conflicts.is_empty() {
        return Err(AppError::Conflict(plan.conflicts.join("; ")));
    }
    let operation_id = Uuid::new_v4().to_string();
    let mut installed_files = 0_u64;
    let mut unchanged_files = 0_u64;
    let mut backups_created = 0_u64;
    let total = resolved.len() as u64;
    // Stage backups and download records first, then fetch all independent
    // CurseForge files concurrently. World archives still get unpacked in
    // order after their verified download completes.
    let mut changed = Vec::new();
    for (index, item) in resolved.iter().enumerate() {
        let destination = PathBuf::from(&item.plan.destination);
        if item.plan.action == "unchanged" {
            unchanged_files += 1;
        } else {
            if item.project_type != "world" && destination.exists() {
                backup_content_file(state, instance_id, &destination).await?;
                backups_created += 1;
            }
            let download_destination = if item.project_type == "world" {
                let directory = state.paths.downloads.join("curseforge-worlds");
                tokio::fs::create_dir_all(&directory).await?;
                directory.join(format!(
                    "{}-{}.zip",
                    item.plan.project_id, item.plan.version_id
                ))
            } else {
                destination.clone()
            };
            let download_id = Uuid::new_v4().to_string();
            sqlx::query(
                "INSERT INTO downloads(id, source, url, destination, status, total_bytes) \
                 VALUES (?, 'curseforge', ?, ?, 'running', ?)",
            )
            .bind(&download_id)
            .bind(&item.url)
            .bind(download_destination.to_string_lossy().into_owned())
            .bind(item.plan.size_bytes as i64)
            .execute(&state.database)
            .await?;
            changed.push((
                index,
                DownloadPlan {
                    url: item.url.clone(),
                    destination: download_destination,
                    sha1: Some(item.sha1.clone()),
                    max_bytes: None,
                },
                download_id,
            ));
        }
    }

    let changed_total = changed.len() as u64;
    let download_ids = changed
        .iter()
        .map(|(_, _, id)| id.clone())
        .collect::<Vec<_>>();
    let plans = changed
        .iter()
        .map(|(_, plan, _)| plan.clone())
        .collect::<Vec<_>>();
    let names = changed
        .iter()
        .map(|(index, _, _)| resolved[*index].plan.display_name.clone())
        .collect::<Vec<_>>();
    let bytes_by_index = if changed_total == 0 {
        Vec::new()
    } else {
        let progress_app = app.clone();
        let progress_operation = operation_id.clone();
        let progress_instance = instance_id.to_owned();
        let mut completed = 0_u64;
        let mut downloaded_bytes = 0_u64;
        let total_bytes = plan.total_bytes;
        let concurrency = configured_concurrency(&state.database).await;
        match download_many(&state.http, plans, concurrency, move |index, bytes| {
            completed += 1;
            downloaded_bytes = downloaded_bytes.saturating_add(bytes);
            let _ = progress_app.emit(
                crate::host::EventKind::OperationProgress,
                ProgressEvent {
                    operation_id: progress_operation.clone(),
                    instance_id: Some(progress_instance.clone()),
                    operation: "content".into(),
                    stage: "download".into(),
                    message: format!("Downloading {}", names[index]),
                    completed,
                    total: Some(changed_total),
                    downloaded_bytes: Some(downloaded_bytes),
                    total_bytes: Some(total_bytes),
                },
            );
        })
        .await
        {
            Ok(bytes) => bytes,
            Err(error) => {
                let message = crate::security::redact_secrets(&error.to_string());
                for download_id in &download_ids {
                    let _ = sqlx::query(
                        "UPDATE downloads SET status = 'failed', error_message = ?, \
                         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
                    )
                    .bind(&message)
                    .bind(download_id)
                    .execute(&state.database)
                    .await;
                }
                return Err(error);
            }
        }
    };

    for (index, item) in resolved.iter().enumerate() {
        if item.plan.action != "unchanged" {
            let batch_index = changed
                .iter()
                .position(|(item_index, _, _)| *item_index == index)
                .expect("every changed item has a download plan");
            let download_id = &changed[batch_index].2;
            let download_destination = &changed[batch_index].1.destination;
            sqlx::query(
                "UPDATE downloads SET status = 'complete', downloaded_bytes = ?, \
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
            )
            .bind(bytes_by_index[batch_index] as i64)
            .bind(download_id)
            .execute(&state.database)
            .await?;
            let destination = PathBuf::from(&item.plan.destination);
            if item.project_type == "world" {
                backups_created += install_world_archive(
                    state,
                    instance_id,
                    download_destination,
                    &destination,
                    item.old_path.as_deref(),
                )
                .await?;
            } else if let Some(old_path) = &item.old_path {
                let old_path = PathBuf::from(old_path);
                if old_path != destination && old_path.exists() {
                    backup_content_file(state, instance_id, &old_path).await?;
                    backups_created += 1;
                    tokio::fs::remove_file(old_path).await?;
                }
            }
            installed_files += 1;
        }
        sqlx::query(
            "INSERT INTO installed_content(instance_id, provider, project_id, version_id, \
             project_type, display_name, file_path, file_sha1, installed_at) \
             VALUES (?, 'curseforge', ?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(instance_id, provider, project_id) DO UPDATE SET \
             version_id = excluded.version_id, project_type = excluded.project_type, \
             display_name = excluded.display_name, file_path = excluded.file_path, \
             file_sha1 = excluded.file_sha1, installed_at = excluded.installed_at",
        )
        .bind(instance_id)
        .bind(&item.plan.project_id)
        .bind(&item.plan.version_id)
        .bind(&item.project_type)
        .bind(&item.plan.display_name)
        .bind(&item.plan.destination)
        .bind(&item.sha1)
        .bind(Utc::now().to_rfc3339())
        .execute(&state.database)
        .await?;
        let _ = app.emit(
            crate::host::EventKind::OperationProgress,
            ProgressEvent {
                operation_id: operation_id.clone(),
                instance_id: Some(instance_id.to_owned()),
                operation: "content".into(),
                stage: "install".into(),
                message: format!("Installed {}", item.plan.display_name),
                completed: (index + 1) as u64,
                total: Some(total),
                downloaded_bytes: None,
                total_bytes: Some(plan.total_bytes),
            },
        );
    }
    let _ = app.emit(
        crate::host::EventKind::OperationProgress,
        ProgressEvent {
            operation_id,
            instance_id: Some(instance_id.to_owned()),
            operation: "content".into(),
            stage: "complete".into(),
            message: "Content installation complete".into(),
            completed: total,
            total: Some(total),
            downloaded_bytes: Some(plan.total_bytes),
            total_bytes: Some(plan.total_bytes),
        },
    );
    Ok(ContentInstallResult {
        plan,
        installed_files,
        unchanged_files,
        backups_created,
    })
}

pub async fn install_modpack(
    app: &Host,
    state: &AppState,
    project_id: &str,
    name: Option<String>,
    version_id: Option<String>,
) -> AppResult<Instance> {
    install_modpack_tracked(app, state, project_id, name, version_id, None).await
}

pub async fn install_modpack_tracked(
    app: &Host, state: &AppState, project_id: &str, name: Option<String>,
    version_id: Option<String>, progress_key: Option<String>,
) -> AppResult<Instance> {
    let operation_id = progress_key.unwrap_or_else(|| Uuid::new_v4().to_string());
    let _ = app.emit(crate::host::EventKind::OperationProgress, ProgressEvent {
        operation_id: operation_id.clone(), instance_id: None, operation: "modpack".into(),
        stage: "metadata".into(), message: "Preparing modpack".into(), completed: 0,
        total: None, downloaded_bytes: None, total_bytes: None,
    });
    let project_id = validate_project_id(project_id)?;
    let project = project(state, project_id).await?;
    if project_type(project.class_id) != "modpack" {
        return Err(AppError::InvalidInput(format!(
            "CurseForge project {} is not a modpack",
            project.name
        )));
    }
    if project.allow_mod_distribution == Some(false) {
        return Err(AppError::Unavailable(format!(
            "{} does not allow third-party distribution",
            project.name
        )));
    }
    let requested_instance_name = match name {
        Some(name) => crate::instances::validate_display_name(&name)?,
        None => safe_modpack_name(&project.name),
    };
    let instance_name =
        crate::instances::allocate_unique_display_name(&state.database, &requested_instance_name)
            .await?;
    let file = if let Some(version_id) = version_id {
        let file_id = validate_project_id(&version_id)?;
        let response: FileResponse = send_api_json(
            state,
            api_get(state, &format!("mods/{project_id}/files/{file_id}")).await?,
        ).await?;
        if response.data.mod_id != project_id || !response.data.is_available {
            return Err(AppError::Conflict("Selected CurseForge modpack file is unavailable".into()));
        }
        response.data
    } else {
        latest_available_file(state, project_id).await?
    };
    validate_file_name(&file.file_name)?;
    if file.file_length > 512 * 1024 * 1024 {
        return Err(AppError::Security(
            "CurseForge modpack archive exceeds the 512 MiB safety limit".into(),
        ));
    }
    let sha1 = file
        .hashes
        .iter()
        .find(|hash| hash.algo == 1)
        .map(|hash| hash.value.clone())
        .ok_or_else(|| AppError::Security("CurseForge modpack has no SHA-1 hash".into()))?;
    let url = download_url(state, project_id, file.id, file.download_url.as_deref()).await?;
    let pack_directory = state.paths.downloads.join("curseforge-packs");
    tokio::fs::create_dir_all(&pack_directory).await?;
    let archive_path = pack_directory.join(format!("{project_id}-{}.zip", file.id));
    let download_id = Uuid::new_v4().to_string();
    let _archive_download_guard = crate::pack_operations::ArchiveDownloadGuard(state.database.clone(), download_id.clone());
    sqlx::query(
        "INSERT INTO downloads(id, source, url, destination, status, total_bytes) \
         VALUES (?, 'curseforge', ?, ?, 'running', ?)",
    )
    .bind(&download_id)
    .bind(&url)
    .bind(archive_path.to_string_lossy().into_owned())
    .bind(file.file_length as i64)
    .execute(&state.database)
    .await?;
    let _ = app.emit(
        crate::host::EventKind::OperationProgress,
        ProgressEvent {
            operation_id: operation_id.clone(),
            instance_id: None,
            operation: "modpack".into(),
            stage: "download".into(),
            message: format!("Downloading {}", project.name),
            completed: 0,
            total: Some(1),
            downloaded_bytes: Some(0),
            total_bytes: Some(file.file_length),
        },
    );
    let progress_app = app.clone();
    let progress_operation = operation_id.clone();
    let project_name = project.name.clone();
    let downloaded = download_verified_with_progress(
        &state.http,
        &DownloadPlan {
            url: url.clone(),
            destination: archive_path.clone(),
            sha1: Some(sha1),
            max_bytes: None,
        },
        move |completed, total| {
            let _ = progress_app.emit(
                crate::host::EventKind::OperationProgress,
                ProgressEvent {
                    operation_id: progress_operation.clone(),
                    instance_id: None,
                    operation: "modpack".into(),
                    stage: "download".into(),
                    message: format!("Downloading {}", project_name),
                    completed: 0,
                    total: Some(1),
                    downloaded_bytes: Some(completed),
                    total_bytes: total.or(Some(file.file_length)),
                },
            );
        },
    )
    .await;
    match downloaded {
        Ok(bytes) => {
            sqlx::query(
                "UPDATE downloads SET status = 'complete', downloaded_bytes = ?, \
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
            )
            .bind(bytes as i64)
            .bind(&download_id)
            .execute(&state.database)
            .await?;
            let _ = app.emit(
                crate::host::EventKind::OperationProgress,
                ProgressEvent {
                    operation_id: operation_id.clone(),
                    instance_id: None,
                    operation: "modpack".into(),
                    stage: "downloaded".into(),
                    message: format!("{} archive verified", project.name),
                    completed: 1,
                    total: Some(1),
                    downloaded_bytes: Some(bytes),
                    total_bytes: Some(file.file_length),
                },
            );
        }
        Err(error) => {
            sqlx::query(
                "UPDATE downloads SET status = 'failed', error_message = ?, \
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
            )
            .bind(crate::security::redact_secrets(&error.to_string()))
            .bind(&download_id)
            .execute(&state.database)
            .await?;
            let _ = app.emit(
                crate::host::EventKind::OperationProgress,
                ProgressEvent {
                    operation_id,
                    instance_id: None,
                    operation: "modpack".into(),
                    stage: "failed".into(),
                    message: error.to_string(),
                    completed: 0,
                    total: Some(1),
                    downloaded_bytes: None,
                    total_bytes: Some(file.file_length),
                },
            );
            return Err(error);
        }
    }
    let imported = crate::archives::import_curseforge_pack_tracked(
        app,
        state,
        ImportSlhRequest {
            archive_path: archive_path.to_string_lossy().into_owned(),
            name: Some(instance_name),
        },
        Some(operation_id.clone()),
    )
    .await;
    if let Err(error) = &imported {
        let _ = app.emit(
            crate::host::EventKind::OperationProgress,
            ProgressEvent {
                operation_id,
                instance_id: None,
                operation: "modpack".into(),
                stage: "failed".into(),
                message: error.to_string(),
                completed: 0,
                total: Some(1),
                downloaded_bytes: None,
                total_bytes: Some(file.file_length),
            },
        );
    }
    imported
}

pub(crate) async fn pack_download(
    state: &AppState,
    project_id: u64,
    file_id: u64,
) -> AppResult<PackDownload> {
    let project = project(state, project_id).await?;
    let response: FileResponse = send_api_json(
        state,
        api_get(state, &format!("mods/{project_id}/files/{file_id}")).await?,
    )
    .await?;
    let file = response.data;
    if file.mod_id != project_id || !file.is_available {
        return Err(AppError::Conflict(format!(
            "CurseForge file {file_id} is unavailable for project {project_id}"
        )));
    }
    validate_file_name(&file.file_name)?;
    let sha1 = file
        .hashes
        .iter()
        .find(|hash| hash.algo == 1)
        .map(|hash| hash.value.clone())
        .ok_or_else(|| AppError::Security("CurseForge file has no SHA-1 hash".into()))?;
    let manual_download_url = (project.allow_mod_distribution == Some(false))
        .then(|| format!("https://www.curseforge.com/minecraft/{}/{}/download/{file_id}",
            match project_type(project.class_id) {
                "resourcepack" => "texture-packs", "shader" => "shaders", "world" => "worlds", _ => "mc-mods",
            }, project.slug));
    let local_path = if manual_download_url.is_some() {
        cached_pack_file(state, project_id, file_id, &file.file_name, &sha1).await?
    } else { None };
    let url = if manual_download_url.is_some() { String::new() } else {
        download_url(state, project_id, file_id, file.download_url.as_deref()).await?
    };
    Ok(PackDownload {
        project_type: project_type(project.class_id).into(),
        display_name: project.name,
        file_name: file.file_name,
        url,
        sha1,
        size_bytes: file.file_length,
        manual_download_url,
        local_path,
    })
}

/// Preserve exact, author-downloaded artifacts after Downloads is cleaned, and
/// reuse unmodified files already installed by SLH. Worlds use the original ZIP,
/// never a player's modified save directory.
async fn cached_pack_file(
    state: &AppState, project_id: u64, file_id: u64, file_name: &str, sha1: &str,
) -> AppResult<Option<PathBuf>> {
    let cache = state.paths.downloads.join("curseforge-manual");
    let cached = pack_cache_path(&cache, file_name, sha1)?;
    if cached.is_file() && matches!(verify_sha1(&cached, sha1).await, Ok(true)) { return Ok(Some(cached)); }
    if let Some(source) = verified_manual_file(&cache, file_name, sha1).await? {
        return cache_verified_pack_file(&cache, &source, file_name, sha1).await.map(Some);
    }
    if let Some(directory) = browser_download_directory(state).await? {
        if let Some(source) = verified_download_file(&directory, file_name, sha1).await? {
            return cache_verified_pack_file(&cache, &source, file_name, sha1).await.map(Some);
        }
    }
    let mut candidates: Vec<String> = sqlx::query_scalar(
        "SELECT file_path FROM installed_content WHERE provider = 'curseforge' AND project_id = ? AND version_id = ?",
    ).bind(project_id.to_string()).bind(file_id.to_string()).fetch_all(&state.database).await?;
    candidates.push(state.paths.downloads.join("curseforge-worlds")
        .join(format!("{project_id}-{file_id}.zip")).to_string_lossy().into_owned());
    for candidate in candidates {
        let source = PathBuf::from(candidate);
        if source.is_file() && matches!(verify_sha1(&source, sha1).await, Ok(true)) {
            return cache_verified_pack_file(&cache, &source, file_name, sha1).await.map(Some);
        }
    }
    Ok(None)
}

async fn cache_verified_pack_file(cache: &Path, source: &Path, file_name: &str, sha1: &str) -> AppResult<PathBuf> {
    let target = pack_cache_path(cache, file_name, sha1)?;
    tokio::fs::create_dir_all(cache).await?;
    if source == target { return Ok(target); }
    // A unique temporary file avoids exposing a partially copied download to
    // another pack installation. Hash again in case the source changed mid-copy.
    let temporary = cache.join(format!("{}.slh-part", Uuid::new_v4()));
    tokio::fs::copy(source, &temporary).await?;
    if !verify_sha1(&temporary, sha1).await? {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(AppError::Security(format!("Downloaded file changed while caching: {file_name}")));
    }
    if target.is_file() { tokio::fs::remove_file(&target).await?; }
    tokio::fs::rename(temporary, &target).await?;
    Ok(target)
}

fn pack_cache_path(cache: &Path, file_name: &str, sha1: &str) -> AppResult<PathBuf> {
    validate_file_name(file_name)?;
    if sha1.len() != 40 || !sha1.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(AppError::Security("CurseForge file has an invalid SHA-1 hash".into()));
    }
    Ok(cache.join(format!("{}-{file_name}", sha1.to_ascii_lowercase())))
}

async fn verified_manual_file(directory: &Path, file_name: &str, sha1: &str) -> AppResult<Option<PathBuf>> {
    validate_file_name(file_name)?;
    let path = directory.join(file_name);
    if path.is_file() && verify_sha1(&path, sha1).await? { return Ok(Some(path)); }
    Ok(None)
}

pub(crate) async fn browser_download_directory(state: &AppState) -> AppResult<Option<PathBuf>> {
    let settings = crate::database::setting(&state.database, "downloads").await?;
    Ok(settings.get("curseforgeDirectory").and_then(serde_json::Value::as_str)
        .filter(|path| !path.trim().is_empty()).map(PathBuf::from)
        .or_else(|| directories::UserDirs::new().and_then(|dirs| dirs.download_dir().map(Path::to_path_buf))))
}

/// Only exact manifest artifacts in the configured browser folder or SLH's
/// manual cache are disposable. Installed files and unrelated downloads stay.
pub(crate) async fn cleanup_pack_downloads(state: &AppState, files: &[(String, String)], archive: &Path, archive_sha1: &str) -> AppResult<()> {
    let settings = crate::database::setting(&state.database, "downloads").await?;
    if settings.get("curseforgeDeleteAfterInstall").and_then(serde_json::Value::as_bool) != Some(true) { return Ok(()); }
    let mut directories = vec![state.paths.downloads.join("curseforge-manual")];
    if let Some(directory) = browser_download_directory(state).await? { directories.push(directory); }
    let mut installed_roots = Vec::new();
    for instance in crate::database::instances(&state.database).await? {
        if let Ok(root) = tokio::fs::canonicalize(&instance.game_dir).await { installed_roots.push(root); }
    }
    let mut safe_directories = Vec::new();
    for directory in directories {
        if let Ok(resolved) = tokio::fs::canonicalize(&directory).await {
            if !installed_roots.iter().any(|root| resolved.starts_with(root)) { safe_directories.push(directory); }
        }
    }
    let mut directories = safe_directories;
    let archive_parent = tokio::fs::canonicalize(archive.parent().unwrap_or(Path::new(""))).await.ok();
    for directory in &directories {
        for (name, sha1) in files {
            for candidate in download_candidates(directory, &[name.clone()]).await? {
                remove_verified_download(&candidate, sha1).await?;
            }
            let cached = pack_cache_path(directory, name, sha1)?;
            remove_verified_download(&cached, sha1).await?;
        }
    }
    directories.push(state.paths.downloads.join("curseforge-packs"));
    for directory in directories {
        if let Ok(parent) = tokio::fs::canonicalize(directory).await {
            if archive_parent.as_ref() == Some(&parent) { remove_verified_download(archive, archive_sha1).await?; break; }
        }
    }
    Ok(())
}

async fn remove_verified_download(path: &Path, sha1: &str) -> AppResult<()> {
    let metadata = match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() { return Ok(()); }
    if verify_sha1(path, sha1).await? { tokio::fs::remove_file(path).await?; }
    Ok(())
}

pub(crate) async fn archive_source_signature(path: &Path) -> AppResult<String> {
    use sha2::Digest;
    let metadata = tokio::fs::metadata(path).await?;
    let value = format!("{}:{}:{:?}", path.display(), metadata.len(), metadata.modified()?);
    Ok(format!("curseforge-auto:{}", hex::encode(sha2::Sha256::digest(value.as_bytes()))))
}

/// Enumerate complete ZIP names only; the UI waits for a stable signature and
/// inspects the manifest before starting an ordinary tracked pack import.
pub async fn scan_pack_archives(state: &AppState) -> AppResult<Vec<(String, String)>> {
    let settings = crate::database::setting(&state.database, "downloads").await?;
    if settings.get("curseforgeImportArchives").and_then(serde_json::Value::as_bool) != Some(true) { return Ok(Vec::new()); }
    let Some(directory) = browser_download_directory(state).await? else { return Ok(Vec::new()); };
    let mut entries = match tokio::fs::read_dir(directory).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    let mut result = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        if !entry.file_type().await?.is_file() || !path.extension().is_some_and(|e| e.eq_ignore_ascii_case("zip")) { continue; }
        let metadata = entry.metadata().await?;
        if metadata.len() == 0 || metadata.len() > 512 * 1024 * 1024 { continue; }
        let signature = archive_source_signature(&path).await?;
        if crate::database::setting(&state.database, &signature).await.ok().and_then(|v| v.as_bool()) == Some(true) { continue; }
        result.push((path.to_string_lossy().into_owned(), signature));
    }
    result.sort();
    Ok(result)
}

fn browser_download_name(candidate: &str, expected: &str) -> bool {
    if candidate == expected { return true; }
    let path = Path::new(expected);
    let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else { return false; };
    let Some(extension) = path.extension().and_then(|s| s.to_str()) else { return false; };
    candidate.strip_prefix(&format!("{stem} (")).and_then(|s| s.strip_suffix(&format!(").{extension}")))
        .is_some_and(|number| !number.is_empty() && number.chars().all(|ch| ch.is_ascii_digit()))
}

async fn download_candidates(directory: &Path, names: &[String]) -> AppResult<Vec<PathBuf>> {
    for name in names { validate_file_name(name)?; }
    let mut entries = match tokio::fs::read_dir(directory).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    let mut paths = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        if !names.iter().any(|name| browser_download_name(&entry.file_name().to_string_lossy(), name)) { continue; }
        let metadata = match entry.metadata().await { Ok(value) => value, Err(_) => continue };
        if metadata.is_file() && metadata.len() <= 512 * 1024 * 1024 { paths.push(entry.path()); }
    }
    paths.sort();
    Ok(paths)
}

async fn verified_download_file(directory: &Path, name: &str, sha1: &str) -> AppResult<Option<PathBuf>> {
    for path in download_candidates(directory, &[name.to_owned()]).await? {
        // Browsers may still be writing the file. Only the exact manifest hash is usable.
        if matches!(verify_sha1(&path, sha1).await, Ok(true)) { return Ok(Some(path)); }
    }
    Ok(None)
}

pub async fn scan_manual_pack_downloads(state: &AppState, file_names: Vec<String>) -> AppResult<Vec<String>> {
    if file_names.len() > 512 { return Err(AppError::InvalidInput("Too many expected files".into())); }
    let Some(downloads) = browser_download_directory(state).await? else { return Ok(Vec::new()); };
    let mut signatures = Vec::new();
    for path in download_candidates(&downloads, &file_names).await? {
        if let Ok(metadata) = tokio::fs::metadata(&path).await {
            let candidate = path.file_name().unwrap().to_string_lossy();
            for name in &file_names {
                if browser_download_name(&candidate, name) {
                    signatures.push(format!("{name}\0{}:{}:{:?}", path.display(), metadata.len(), metadata.modified().ok()));
                }
            }
        }
    }
    Ok(signatures)
}

pub async fn add_manual_pack_files(state: &AppState, paths: Vec<String>) -> AppResult<u64> {
    if paths.len() > 512 { return Err(AppError::InvalidInput("Too many selected files".into())); }
    let directory = state.paths.downloads.join("curseforge-manual");
    tokio::fs::create_dir_all(&directory).await?;
    let mut count = 0;
    for source in paths {
        let source = PathBuf::from(source);
        let filename = source.file_name().and_then(|name| name.to_str())
            .ok_or_else(|| AppError::InvalidInput("Selected file has no valid filename".into()))?;
        validate_file_name(filename)?;
        if !matches!(source.extension().and_then(|ext| ext.to_str()).map(str::to_ascii_lowercase).as_deref(), Some("jar" | "zip")) {
            return Err(AppError::InvalidInput("Select CurseForge JAR or ZIP files".into()));
        }
        if tokio::fs::metadata(&source).await?.len() > 512 * 1024 * 1024 {
            return Err(AppError::Security("Selected file exceeds 512 MiB".into()));
        }
        let destination = directory.join(filename);
        if source == destination { continue; }
        let temporary = directory.join(format!("{}.tmp", Uuid::new_v4()));
        let result = async {
            tokio::fs::copy(&source, &temporary).await?;
            if destination.exists() { tokio::fs::remove_file(&destination).await?; }
            tokio::fs::rename(&temporary, &destination).await
        }.await;
        if result.is_err() { let _ = tokio::fs::remove_file(&temporary).await; }
        result?;
        count += 1;
    }
    Ok(count)
}

async fn resolve(
    state: &AppState,
    instance_id: &str,
    project_id: &str,
) -> AppResult<(Vec<ResolvedItem>, ContentInstallPlan)> {
    let root_id = validate_project_id(project_id)?;
    let instance = database::instance(&state.database, instance_id).await?;
    if instance.status != "installed" {
        return Err(AppError::Conflict(
            "Install and verify the target instance before adding content".into(),
        ));
    }
    let root_project = project(state, root_id).await?;
    let root_type = project_type(root_project.class_id);
    match root_type {
        "mod" if matches!(instance.loader_type.as_str(), "vanilla" | "bedrock") => {
            return Err(AppError::Conflict(
                "Mods require a Fabric, Forge, NeoForge, or Quilt instance".into(),
            ));
        }
        "mod" | "resourcepack" | "shader" => {}
        "world" => return resolve_world(state, instance, root_project).await,
        kind => {
            return Err(AppError::Unavailable(format!(
                "Installing CurseForge {kind} projects is not active yet"
            )));
        }
    }
    loader_code(&instance.loader_type, root_type)?;
    let mut queue = VecDeque::from([root_id]);
    let mut visited = HashSet::new();
    let mut projects = HashMap::new();
    let mut files = Vec::new();
    let mut incompatible = HashSet::new();
    while let Some(id) = queue.pop_front() {
        if !visited.insert(id) {
            continue;
        }
        if visited.len() > 64 {
            return Err(AppError::Security(
                "CurseForge dependency graph exceeds 64 projects".into(),
            ));
        }
        let project = if id == root_id {
            root_project.clone()
        } else {
            project(state, id).await?
        };
        if project.allow_mod_distribution == Some(false) {
            return Err(AppError::Unavailable(format!(
                "{} does not allow third-party distribution",
                project.name
            )));
        }
        let dependency_loader = loader_code(&instance.loader_type, project_type(project.class_id))?;
        let file =
            compatible_file(state, id, &instance.minecraft_version, dependency_loader).await?;
        for dependency in &file.dependencies {
            match dependency.relation_type {
                3 => queue.push_back(dependency.mod_id),
                5 => {
                    incompatible.insert(dependency.mod_id);
                }
                _ => {}
            }
        }
        projects.insert(id, project);
        files.push(file);
    }
    let mut conflicts = Vec::new();
    for id in incompatible {
        let installed: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM installed_content \
             WHERE instance_id = ? AND provider = 'curseforge' AND project_id = ?)",
        )
        .bind(instance_id)
        .bind(id.to_string())
        .fetch_one(&state.database)
        .await?;
        if installed || visited.contains(&id) {
            conflicts.push(format!("CurseForge project {id} is marked incompatible"));
        }
    }
    let game_dir = PathBuf::from(&instance.game_dir);
    let mut destinations = HashSet::new();
    let mut resolved = Vec::new();
    for file in files {
        let project = projects
            .get(&file.mod_id)
            .ok_or_else(|| AppError::NotFound(format!("CurseForge project {}", file.mod_id)))?;
        let kind = project_type(project.class_id);
        let folder = match content_folder(kind) {
            Some(folder) => folder,
            None => {
                conflicts.push(format!(
                    "Required project {} has unsupported type {kind}",
                    project.name
                ));
                continue;
            }
        };
        validate_file_name(&file.file_name)?;
        let sha1 = file
            .hashes
            .iter()
            .find(|hash| hash.algo == 1)
            .map(|hash| hash.value.clone())
            .ok_or_else(|| AppError::Security("CurseForge file has no SHA-1 hash".into()))?;
        let url = download_url(state, file.mod_id, file.id, file.download_url.as_deref()).await?;
        let destination = game_dir.join(folder).join(&file.file_name);
        let destination_text = destination.to_string_lossy().into_owned();
        if !destinations.insert(destination_text.to_ascii_lowercase()) {
            conflicts.push(format!(
                "Multiple dependencies resolve to {}",
                file.file_name
            ));
        }
        let existing = sqlx::query(
            "SELECT version_id, file_path, file_sha1 FROM installed_content \
             WHERE instance_id = ? AND provider = 'curseforge' AND project_id = ?",
        )
        .bind(instance_id)
        .bind(file.mod_id.to_string())
        .fetch_optional(&state.database)
        .await?;
        let mut action = "install".to_owned();
        let mut old_path = None;
        if let Some(row) = existing {
            use sqlx::Row;
            let installed_path: String = row.get("file_path");
            old_path = Some(installed_path.clone());
            if row.get::<String, _>("version_id") == file.id.to_string()
                && row
                    .get::<String, _>("file_sha1")
                    .eq_ignore_ascii_case(&sha1)
                && Path::new(&installed_path).is_file()
                && verify_sha1(Path::new(&installed_path), &sha1).await?
            {
                action = "unchanged".into();
            } else {
                action = "update".into();
            }
        } else if destination.exists() {
            if verify_sha1(&destination, &sha1).await? {
                action = "unchanged".into();
            } else {
                conflicts.push(format!(
                    "{} already exists and is not managed by this CurseForge project",
                    destination.display()
                ));
            }
        }
        resolved.push(ResolvedItem {
            plan: ContentInstallPlanItem {
                project_id: file.mod_id.to_string(),
                version_id: file.id.to_string(),
                display_name: project.name.clone(),
                version_number: file.display_name.clone(),
                file_name: file.file_name.clone(),
                destination: destination_text,
                size_bytes: file.file_length,
                action,
            },
            project_type: kind.into(),
            url,
            sha1,
            old_path,
        });
    }
    let total_bytes = resolved
        .iter()
        .filter(|item| item.plan.action != "unchanged")
        .map(|item| item.plan.size_bytes)
        .sum();
    Ok((
        resolved.clone(),
        ContentInstallPlan {
            provider: "curseforge".into(),
            root_project_id: root_id.to_string(),
            instance_id: instance.id,
            project_type: root_type.into(),
            items: resolved.into_iter().map(|item| item.plan).collect(),
            conflicts,
            total_bytes,
        },
    ))
}

async fn resolve_world(
    state: &AppState,
    instance: Instance,
    project: Project,
) -> AppResult<(Vec<ResolvedItem>, ContentInstallPlan)> {
    if project.allow_mod_distribution == Some(false) {
        return Err(AppError::Unavailable(format!(
            "{} does not allow third-party distribution",
            project.name
        )));
    }
    let file = compatible_file(state, project.id, &instance.minecraft_version, None).await?;
    if file.file_length > 2 * 1024 * 1024 * 1024 {
        return Err(AppError::Security(
            "CurseForge world archive exceeds the 2 GiB safety limit".into(),
        ));
    }
    validate_file_name(&file.file_name)?;
    let sha1 = file
        .hashes
        .iter()
        .find(|hash| hash.algo == 1)
        .map(|hash| hash.value.clone())
        .ok_or_else(|| AppError::Security("CurseForge world has no SHA-1 hash".into()))?;
    let url = download_url(state, project.id, file.id, file.download_url.as_deref()).await?;
    let destination = PathBuf::from(&instance.game_dir)
        .join("saves")
        .join(safe_world_name(&project.name));
    let destination_text = destination.to_string_lossy().into_owned();
    let existing = sqlx::query(
        "SELECT version_id, file_path FROM installed_content \
         WHERE instance_id = ? AND provider = 'curseforge' AND project_id = ?",
    )
    .bind(&instance.id)
    .bind(project.id.to_string())
    .fetch_optional(&state.database)
    .await?;
    let mut action = "install".to_owned();
    let mut old_path = None;
    let mut conflicts = Vec::new();
    if let Some(row) = existing {
        use sqlx::Row;
        let installed_path: String = row.get("file_path");
        old_path = Some(installed_path.clone());
        if row.get::<String, _>("version_id") == file.id.to_string()
            && Path::new(&installed_path).is_dir()
        {
            action = "unchanged".into();
        } else {
            action = "update".into();
        }
    } else if destination.exists() {
        conflicts.push(format!(
            "A world named {} already exists and is not managed by CurseForge",
            project.name
        ));
    }
    let item = ResolvedItem {
        plan: ContentInstallPlanItem {
            project_id: project.id.to_string(),
            version_id: file.id.to_string(),
            display_name: project.name,
            version_number: file.display_name,
            file_name: file.file_name,
            destination: destination_text,
            size_bytes: file.file_length,
            action,
        },
        project_type: "world".into(),
        url,
        sha1,
        old_path,
    };
    Ok((
        vec![item.clone()],
        ContentInstallPlan {
            provider: "curseforge".into(),
            root_project_id: project.id.to_string(),
            instance_id: instance.id,
            project_type: "world".into(),
            total_bytes: if item.plan.action == "unchanged" {
                0
            } else {
                item.plan.size_bytes
            },
            items: vec![item.plan],
            conflicts,
        },
    ))
}

async fn latest_available_file(state: &AppState, project_id: u64) -> AppResult<ProjectFile> {
    let mut response: FilesResponse = send_api_json(
        state,
        api_get(state, &format!("mods/{project_id}/files"))
            .await?
            .query(&[("pageSize", "50")]),
    )
    .await?;
    response
        .data
        .retain(|file| file.is_available && file.hashes.iter().any(|hash| hash.algo == 1));
    response.data.sort_by(|left, right| {
        left.release_type
            .cmp(&right.release_type)
            .then_with(|| right.file_date.cmp(&left.file_date))
    });
    response.data.into_iter().next().ok_or_else(|| {
        AppError::Conflict(format!(
            "No downloadable CurseForge file is available for project {project_id}"
        ))
    })
}

async fn project(state: &AppState, id: u64) -> AppResult<Project> {
    let response: ProjectResponse =
        send_api_json(state, api_get(state, &format!("mods/{id}")).await?).await?;
    Ok(response.data)
}

pub async fn project_details(
    state: &AppState,
    project_id: &str,
) -> AppResult<ModrinthProjectDetails> {
    let project_id = validate_project_id(project_id)?;
    let project = project(state, project_id).await?;
    // The official endpoint provides the complete HTML body. Older relay deployments may not
    // allow this route yet, so keep the project page usable while a personal API key still gets
    // the complete description immediately.
    let description = match send_api_json::<StringResponse>(
        state,
        api_get(state, &format!("mods/{project_id}/description")).await?,
    )
    .await
    {
        Ok(response) => response.data,
        Err(_) => project.summary.clone(),
    };
    let files: FilesResponse = send_api_json(
        state,
        api_get(state, &format!("mods/{project_id}/files")).await?,
    )
    .await?;
    Ok(ModrinthProjectDetails {
        project_id: project_id.to_string(),
        body: description,
        gallery: project
            .screenshots
            .into_iter()
            .filter_map(|image| {
                approved_content_url(image.url).map(|url| ProjectGalleryImage {
                    url: url.clone(),
                    thumbnail_url: Some(url),
                    title: image.title,
                    description: None,
                })
            })
            .take(12)
            .collect(),
        modpack_versions: files
            .data
            .into_iter()
            .filter(|file| file.is_available)
            .take(50)
            .map(|file| {
                let game_versions = file
                    .game_versions
                    .iter()
                    .filter(|value| {
                        value
                            .chars()
                            .next()
                            .is_some_and(|character| character.is_ascii_digit())
                    })
                    .cloned()
                    .collect::<Vec<_>>();
                let loaders = file
                    .game_versions
                    .iter()
                    .filter(|value| {
                        !value
                            .chars()
                            .next()
                            .is_some_and(|character| character.is_ascii_digit())
                    })
                    .cloned()
                    .collect::<Vec<_>>();
                ModpackVersionOption {
                    id: file.id.to_string(),
                    name: file.display_name.clone(),
                    version_number: file.file_name,
                    game_versions,
                    loaders,
                }
            })
            .collect(),
    })
}

async fn compatible_file(
    state: &AppState,
    project_id: u64,
    game_version: &str,
    loader: Option<u32>,
) -> AppResult<ProjectFile> {
    let mut parameters = vec![
        ("gameVersion", game_version.to_owned()),
        ("pageSize", "50".into()),
    ];
    if let Some(loader) = loader {
        parameters.push(("modLoaderType", loader.to_string()));
    }
    let mut response: FilesResponse = send_api_json(
        state,
        api_get(state, &format!("mods/{project_id}/files"))
            .await?
            .query(&parameters),
    )
    .await?;
    response.data.retain(|file| {
        file.is_available
            && file
                .game_versions
                .iter()
                .any(|version| version == game_version)
            && file.hashes.iter().any(|hash| hash.algo == 1)
    });
    response.data.sort_by(|left, right| {
        left.release_type
            .cmp(&right.release_type)
            .then_with(|| right.file_date.cmp(&left.file_date))
    });
    response.data.into_iter().next().ok_or_else(|| {
        AppError::Conflict(format!(
            "No compatible CurseForge file for project {project_id}, Minecraft {game_version}"
        ))
    })
}

pub(crate) async fn migration_version_candidate(
    state: &AppState,
    project_id: &str,
    game_version: &str,
    loader_type: &str,
    project_type: &str,
) -> AppResult<(String, String)> {
    let project_id = validate_project_id(project_id)?;
    let loader = if project_type == "mod" {
        loader_code(loader_type, project_type)?
    } else {
        None
    };
    let file = compatible_file(state, project_id, game_version, loader).await?;
    Ok((file.id.to_string(), file.display_name))
}

async fn download_url(
    state: &AppState,
    project_id: u64,
    file_id: u64,
    supplied: Option<&str>,
) -> AppResult<String> {
    if let Some(url) = supplied.filter(|url| url.starts_with("https://")) {
        return Ok(url.to_owned());
    }
    let response: StringResponse = send_api_json(
        state,
        api_get(
            state,
            &format!("mods/{project_id}/files/{file_id}/download-url"),
        )
        .await?,
    )
    .await?;
    if !response.data.starts_with("https://") {
        return Err(AppError::Security(
            "CurseForge returned a non-HTTPS download URL".into(),
        ));
    }
    Ok(response.data)
}

fn project_to_dto(project: Project) -> ModrinthProject {
    let mut versions = project
        .latest_files_indexes
        .into_iter()
        .map(|file| file.game_version)
        .collect::<Vec<_>>();
    versions.sort();
    versions.dedup();
    versions.reverse();
    ModrinthProject {
        project_id: project.id.to_string(),
        slug: project.slug,
        title: project.name,
        description: project.summary,
        project_type: project_type(project.class_id).into(),
        icon_url: project.logo.and_then(|asset| approved_icon_url(asset.url)),
        downloads: project.download_count,
        follows: 0,
        author: project
            .authors
            .first()
            .map(|author| author.name.clone())
            .unwrap_or_else(|| "CurseForge author".into()),
        categories: project
            .categories
            .into_iter()
            .map(|category| category.slug)
            .collect(),
        versions,
        date_modified: project.date_modified,
    }
}

fn approved_icon_url(value: String) -> Option<String> {
    let url = url::Url::parse(&value).ok()?;
    (url.scheme() == "https" && url.host_str() == Some("media.forgecdn.net")).then_some(value)
}

fn approved_content_url(value: String) -> Option<String> {
    let url = url::Url::parse(&value).ok()?;
    (url.scheme() == "https" && url.host_str().is_some()).then_some(value)
}

fn validate_project_id(value: &str) -> AppResult<u64> {
    value
        .parse::<u64>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| AppError::InvalidInput("CurseForge project ID is invalid".into()))
}

fn validate_file_name(value: &str) -> AppResult<()> {
    validate_relative_path(Path::new(value))?;
    if Path::new(value).file_name().and_then(|name| name.to_str()) != Some(value) {
        return Err(AppError::Security(format!(
            "CurseForge supplied an unsafe file name: {value}"
        )));
    }
    Ok(())
}

fn class_id_for(project_type: &str) -> Option<u64> {
    match project_type {
        "mod" => Some(6),
        "resourcepack" => Some(12),
        "modpack" => Some(4471),
        "shader" => Some(6552),
        "world" => Some(17),
        _ => None,
    }
}

fn curseforge_sort_field(sort: &str) -> u32 {
    match sort {
        "downloads" => 6,
        "updated" => 3,
        "newest" => 11,
        "follows" | "relevance" => 2,
        _ => 2,
    }
}

fn project_type(class_id: Option<u64>) -> &'static str {
    match class_id {
        Some(4984) => "mod",
        Some(6929) => "resourcepack",
        Some(6913) => "world",
        Some(6) => "mod",
        Some(12) => "resourcepack",
        Some(4471) => "modpack",
        Some(6552) => "shader",
        Some(17) => "world",
        _ => "project",
    }
}

fn loader_code(loader: &str, project_type: &str) -> AppResult<Option<u32>> {
    if matches!(project_type, "resourcepack" | "shader" | "world") {
        return Ok(None);
    }
    match loader {
        "forge" => Ok(Some(1)),
        "fabric" => Ok(Some(4)),
        "quilt" => Ok(Some(5)),
        "neoforge" => Ok(Some(6)),
        _ => Err(AppError::Conflict(format!(
            "CurseForge mods do not support loader {loader}"
        ))),
    }
}

fn content_folder(project_type: &str) -> Option<&'static str> {
    match project_type {
        "mod" => Some("mods"),
        "resourcepack" => Some("resourcepacks"),
        "shader" => Some("shaderpacks"),
        _ => None,
    }
}

pub(crate) fn safe_modpack_name(title: &str) -> String {
    let mut result = String::with_capacity(title.len());
    for character in title.trim().chars().take(80) {
        if character.is_control()
            || matches!(
                character,
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
            )
        {
            result.push('-');
        } else {
            result.push(character);
        }
    }
    let result = result.trim().trim_end_matches(['.', ' ']).to_owned();
    if crate::instances::validate_display_name(&result).is_ok() {
        result
    } else {
        "CurseForge pack".into()
    }
}

fn safe_world_name(title: &str) -> String {
    let candidate = safe_modpack_name(title);
    if candidate == "CurseForge pack" {
        "CurseForge world".into()
    } else {
        candidate
    }
}

pub(crate) async fn install_world_archive(
    state: &AppState,
    instance_id: &str,
    archive: &Path,
    destination: &Path,
    old_path: Option<&str>,
) -> AppResult<u64> {
    let staging = tempfile::Builder::new()
        .prefix("slh-curseforge-world-")
        .tempdir_in(&state.paths.downloads)?;
    let extraction = staging.path().join("extracted");
    tokio::fs::create_dir_all(&extraction).await?;
    let source = archive.to_path_buf();
    let extraction_for_task = extraction.clone();
    tokio::task::spawn_blocking(move || {
        crate::archives::safe_extract(&source, &extraction_for_task)
    })
    .await
    .map_err(|error| AppError::Process(format!("World extraction task failed: {error}")))??;

    let world_root = find_world_root(&extraction)?;
    let mut backups = 0_u64;
    if destination.exists() {
        backup_world_directory(state, instance_id, destination).await?;
        backups += 1;
    }
    if let Some(old_path) = old_path {
        let old_path = PathBuf::from(old_path);
        if old_path != destination && old_path.exists() {
            backup_world_directory(state, instance_id, &old_path).await?;
            backups += 1;
        }
    }
    let parent = destination
        .parent()
        .ok_or_else(|| AppError::InvalidInput("World destination has no parent".into()))?;
    tokio::fs::create_dir_all(parent).await?;
    tokio::fs::rename(world_root, destination).await?;
    Ok(backups)
}

fn find_world_root(extraction: &Path) -> AppResult<PathBuf> {
    let mut roots = Vec::new();
    for entry in walkdir::WalkDir::new(extraction).follow_links(false) {
        let entry = entry.map_err(|error| AppError::Io(std::io::Error::other(error)))?;
        if entry.file_type().is_symlink() {
            return Err(AppError::Security(
                "World archive extracted a symbolic link".into(),
            ));
        }
        if entry.file_type().is_file() && entry.file_name() == "level.dat" {
            if let Some(parent) = entry.path().parent() {
                roots.push(parent.to_path_buf());
            }
        }
    }
    roots.sort_by_key(|path| path.components().count());
    roots.into_iter().next().ok_or_else(|| {
        AppError::InvalidInput("CurseForge world archive does not contain level.dat".into())
    })
}

async fn backup_world_directory(
    state: &AppState,
    instance_id: &str,
    source: &Path,
) -> AppResult<()> {
    if !source.is_dir() {
        return Err(AppError::InvalidInput(format!(
            "Expected a world directory: {}",
            source.display()
        )));
    }
    let filename = source
        .file_name()
        .ok_or_else(|| AppError::InvalidInput("World directory has no name".into()))?;
    let backup = state
        .paths
        .backups
        .join("content")
        .join(instance_id)
        .join(Utc::now().format("%Y%m%d-%H%M%S-%3f").to_string())
        .join(filename);
    if let Some(parent) = backup.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::rename(source, backup).await?;
    Ok(())
}

async fn backup_content_file(state: &AppState, instance_id: &str, source: &Path) -> AppResult<()> {
    let filename = source
        .file_name()
        .ok_or_else(|| AppError::InvalidInput("Content file has no name".into()))?;
    let backup = state
        .paths
        .backups
        .join("content")
        .join(instance_id)
        .join(Utc::now().format("%Y%m%d-%H%M%S-%3f").to_string())
        .join(filename);
    if let Some(parent) = backup.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::copy(source, backup).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn pack_cache_keeps_distinct_versions_and_rejects_changed_files() {
        use sha1::{Digest, Sha1};
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("download.jar");
        let cache = directory.path().join("cache");
        tokio::fs::write(&source, b"first version").await.unwrap();
        let first_hash = hex::encode(Sha1::digest(b"first version"));
        let first = cache_verified_pack_file(&cache, &source, "mod.jar", &first_hash).await.unwrap();
        tokio::fs::write(&source, b"second version").await.unwrap();
        assert!(cache_verified_pack_file(&cache, &source, "mod.jar", &first_hash).await.is_err());
        let second_hash = hex::encode(Sha1::digest(b"second version"));
        let second = cache_verified_pack_file(&cache, &source, "mod.jar", &second_hash).await.unwrap();
        assert_ne!(first, second);
        assert!(verify_sha1(&first, &first_hash).await.unwrap());
        assert!(verify_sha1(&second, &second_hash).await.unwrap());
        assert!(pack_cache_path(&cache, "mod.jar", "../outside").is_err());
    }

    #[test]
    fn curseforge_ids_loaders_and_names_are_constrained() {
        assert_eq!(validate_project_id("238222").unwrap(), 238222);
        assert!(validate_project_id("../238222").is_err());
        assert_eq!(loader_code("fabric", "mod").unwrap(), Some(4));
        assert_eq!(loader_code("vanilla", "resourcepack").unwrap(), None);
        assert_eq!(loader_code("vanilla", "shader").unwrap(), None);
        assert_eq!(content_folder("shader"), Some("shaderpacks"));
        assert!(loader_code("vanilla", "mod").is_err());
        assert!(validate_file_name("sodium.jar").is_ok());
        assert!(validate_file_name("../sodium.jar").is_err());
        assert!(validate_api_relative_path("mods/238222/files").is_ok());
        assert!(validate_api_relative_path("../secret").is_err());
        assert!(validate_api_relative_path("mods/search?gameId=432").is_err());
    }

    #[test]
    fn curseforge_class_ids_map_to_supported_project_types() {
        assert_eq!(class_id_for("mod"), Some(6));
        assert_eq!(class_id_for("world"), Some(17));
        assert_eq!(project_type(Some(4471)), "modpack");
        assert_eq!(project_type(Some(999_999)), "project");
    }

    #[test]
    fn curseforge_logo_cdn_is_allowlisted_in_the_webview() {
        let logo = "https://media.forgecdn.net/avatars/1081/393/example.png".to_owned();
        assert_eq!(approved_icon_url(logo.clone()), Some(logo));
        assert!(approved_icon_url("https://example.com/icon.png".into()).is_none());
        // CSP is verified by the Tauri adapter, not this UI-independent core.
    }

    #[test]
    fn extracted_world_root_is_found_by_level_dat() {
        let temporary = tempfile::tempdir().unwrap();
        let world = temporary.path().join("SkyBlock");
        std::fs::create_dir_all(&world).unwrap();
        std::fs::write(world.join("level.dat"), b"fixture").unwrap();
        assert_eq!(find_world_root(temporary.path()).unwrap(), world);
    }
    #[tokio::test]
    async fn manual_pack_files_require_exact_hashes_and_safe_names() {
        let directory = tempfile::tempdir().unwrap();
        let sha1 = "a9993e364706816aba3e25717850c26c9cd0d89d";
        assert!(verified_manual_file(directory.path(), "mod.jar", sha1).await.unwrap().is_none());
        std::fs::write(directory.path().join("mod.jar"), b"wrong version").unwrap();
        assert!(verified_manual_file(directory.path(), "mod.jar", sha1).await.unwrap().is_none());
        std::fs::write(directory.path().join("mod.jar"), b"abc").unwrap();
        assert_eq!(verified_manual_file(directory.path(), "mod.jar", sha1).await.unwrap(), Some(directory.path().join("mod.jar")));
        assert!(verified_manual_file(directory.path(), "../mod.jar", sha1).await.is_err());
    }

    #[tokio::test]
    async fn downloads_accept_browser_duplicates_only_after_hash_verification() {
        let directory = tempfile::tempdir().unwrap();
        let sha1 = "a9993e364706816aba3e25717850c26c9cd0d89d";
        std::fs::write(directory.path().join("required.jar"), b"wrong version").unwrap();
        std::fs::write(directory.path().join("required (1).jar.crdownload"), b"abc").unwrap();
        std::fs::write(directory.path().join("different.jar"), b"abc").unwrap();
        assert!(verified_download_file(directory.path(), "required.jar", sha1).await.unwrap().is_none());
        let duplicate = directory.path().join("required (2).jar");
        std::fs::write(&duplicate, b"abc").unwrap();
        assert_eq!(verified_download_file(directory.path(), "required.jar", sha1).await.unwrap(), Some(duplicate));
        assert!(download_candidates(directory.path(), &["../escape.jar".into()]).await.is_err());
        assert!(!browser_download_name("required (bad).jar", "required.jar"));
    }

    #[tokio::test]
    async fn pack_world_is_unpacked_into_saves_without_replacing_override_world() {
        use std::io::Write;
        let directory = tempfile::tempdir().unwrap();
        let paths = PortablePaths::from_executable(&directory.path().join("SLH.exe"), Some(directory.path().to_path_buf())).unwrap();
        let state = AppState::initialize_isolated_at(paths).await.unwrap();
        let archive_path = directory.path().join("world.zip");
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&archive_path).unwrap());
        zip.start_file("OneBlock/level.dat", zip::write::SimpleFileOptions::default()).unwrap();
        zip.write_all(b"world fixture").unwrap();
        zip.start_file("OneBlock/region/r.0.0.mca", zip::write::SimpleFileOptions::default()).unwrap();
        zip.write_all(b"region fixture").unwrap();
        zip.finish().unwrap();
        let saves = directory.path().join("game/saves");
        std::fs::create_dir_all(saves.join("PackWorld")).unwrap();
        std::fs::write(saves.join("PackWorld/level.dat"), b"override fixture").unwrap();
        let destination = saves.join("curseforge-307740");
        install_world_archive(&state, "fixture", &archive_path, &destination, None).await.unwrap();
        assert_eq!(std::fs::read(destination.join("level.dat")).unwrap(), b"world fixture");
        assert!(destination.join("region/r.0.0.mca").is_file());
        assert!(!destination.join("OneBlock").exists());
        assert_eq!(std::fs::read(saves.join("PackWorld/level.dat")).unwrap(), b"override fixture");
        state.database.close().await;
    }

    #[tokio::test]
    async fn custom_downloads_scan_and_cleanup_preserve_unrelated_files() {
        let root = tempfile::tempdir().unwrap();
        let paths = PortablePaths::from_executable(&root.path().join("SLH.exe"), Some(root.path().to_path_buf())).unwrap();
        let state = AppState::initialize_isolated_at(paths).await.unwrap();
        let browser = root.path().join("Browser");
        tokio::fs::create_dir_all(&browser).await.unwrap();
        let archive = browser.join("pack.zip");
        let required = browser.join("required (1).jar");
        let unrelated = browser.join("unrelated.jar");
        let wrong = browser.join("required.jar");
        for path in [&archive, &required, &unrelated] { tokio::fs::write(path, b"abc").await.unwrap(); }
        tokio::fs::write(&wrong, b"wrong version").await.unwrap();
        tokio::fs::write(browser.join("partial.zip.crdownload"), b"abc").await.unwrap();
        let sha1 = "a9993e364706816aba3e25717850c26c9cd0d89d";
        let mut settings = crate::database::setting(&state.database, "downloads").await.unwrap();
        settings["curseforgeDirectory"] = serde_json::json!(browser);
        crate::settings::update(&state.database, "downloads", settings.clone()).await.unwrap();
        assert!(scan_pack_archives(&state).await.unwrap().is_empty());
        assert_eq!(scan_manual_pack_downloads(&state, vec!["required.jar".into()]).await.unwrap().len(), 2);
        let cached = cached_pack_file(&state, 1, 1, "required.jar", sha1).await.unwrap().unwrap();
        assert!(verify_sha1(&cached, sha1).await.unwrap());
        let files = vec![("required.jar".into(), sha1.into())];
        cleanup_pack_downloads(&state, &files, &archive, sha1).await.unwrap();
        assert!(archive.exists() && required.exists() && cached.exists());
        settings["curseforgeImportArchives"] = serde_json::json!(true);
        settings["curseforgeDeleteAfterInstall"] = serde_json::json!(true);
        crate::settings::update(&state.database, "downloads", settings).await.unwrap();
        let found = scan_pack_archives(&state).await.unwrap();
        assert_eq!(found.len(), 1);
        crate::database::set_setting(&state.database, &found[0].1, &serde_json::json!(true)).await.unwrap();
        assert!(scan_pack_archives(&state).await.unwrap().is_empty());
        cleanup_pack_downloads(&state, &files, &archive, sha1).await.unwrap();
        assert!(!archive.exists() && !required.exists() && !cached.exists());
        assert!(wrong.exists() && unrelated.exists());
    }


}

pub async fn categories(state: &AppState, project_type: &str) -> AppResult<Vec<crate::models::ContentCategory>> {
 let class_id = class_id_for(project_type).ok_or_else(|| AppError::InvalidInput("Unknown content type".into()))?;
 let request = api_get(state, "categories").await?.query(&[("gameId", MINECRAFT_GAME_ID.to_string()), ("classId", class_id.to_string())]);
 let response: serde_json::Value = send_api_json(state, request).await?;
 Ok(response["data"].as_array().ok_or_else(|| AppError::Unavailable("Category list missing".into()))?.iter().filter(|v| v["isClass"].as_bool() != Some(true)).filter_map(|v| Some(crate::models::ContentCategory { id: v["id"].as_u64()?.to_string(), name: v["name"].as_str()?.into() })).collect())
}
