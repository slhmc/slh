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
    let response = request.send().await?;
    if !response.status().is_success() {
        if active_api_key(state).await.is_none() {
            if matches!(
                response.status(),
                reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN
            ) {
                return Err(AppError::Unavailable(
                    "The SLH CurseForge relay is locked by Netlify access protection. Disable Visitor Access for /api/v1/* on the relay deployment.".into(),
                ));
            }
            if response.status() == reqwest::StatusCode::NOT_FOUND {
                return Err(AppError::Unavailable(
                    "The SLH CurseForge relay route /api/v1/* is not deployed (HTTP 404)".into(),
                ));
            }
        }
        return Err(response
            .error_for_status()
            .expect_err("non-success response")
            .into());
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !content_type.contains("application/json") {
        return Err(AppError::Unavailable(
            "CurseForge returned a non-JSON response; check the relay routing and access protection".into(),
        ));
    }
    Ok(response.json().await?)
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
) -> AppResult<Instance> {
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
    let file = latest_available_file(state, project_id).await?;
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
    let operation_id = Uuid::new_v4().to_string();
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
    let imported = crate::archives::import_curseforge_pack(
        app,
        state,
        ImportSlhRequest {
            archive_path: archive_path.to_string_lossy().into_owned(),
            name: Some(instance_name),
        },
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
    if project.allow_mod_distribution == Some(false) {
        return Err(AppError::Unavailable(format!(
            "{} does not allow third-party distribution",
            project.name
        )));
    }
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
    let url = download_url(state, project_id, file_id, file.download_url.as_deref()).await?;
    Ok(PackDownload {
        project_type: project_type(project.class_id).into(),
        display_name: project.name,
        file_name: file.file_name,
        url,
        sha1,
        size_bytes: file.file_length,
    })
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

fn safe_modpack_name(title: &str) -> String {
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

async fn install_world_archive(
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
}
