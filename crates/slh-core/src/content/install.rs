use std::collections::{HashMap, HashSet, VecDeque};
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::host::Host;
use chrono::Utc;
use serde::Deserialize;
use sha1::{Digest, Sha1};
use uuid::Uuid;

use crate::database;
use crate::error::{AppError, AppResult};
use crate::minecraft::download::{
    DownloadPlan, configured_concurrency, download_many, download_verified_with_progress,
    verify_sha1,
};
use crate::models::{
    ContentInstallPlan, ContentInstallPlanItem, ContentInstallResult, ImportSlhRequest, Instance,
    ProgressEvent,
};
use crate::security::validate_relative_path;
use crate::state::AppState;

#[derive(Clone, Deserialize)]
struct ProjectDetails {
    id: String,
    title: String,
    project_type: String,
}

#[derive(Clone, Deserialize)]
struct ProjectVersion {
    id: String,
    project_id: String,
    name: String,
    version_number: String,
    #[serde(default)]
    dependencies: Vec<ProjectDependency>,
    #[serde(default)]
    game_versions: Vec<String>,
    #[serde(default)]
    loaders: Vec<String>,
    version_type: String,
    #[serde(default)]
    files: Vec<ProjectFile>,
}

#[derive(Clone, Deserialize)]
struct ProjectDependency {
    version_id: Option<String>,
    project_id: Option<String>,
    dependency_type: String,
}

#[derive(Clone, Deserialize)]
struct ProjectFile {
    hashes: HashMap<String, String>,
    url: String,
    filename: String,
    #[serde(default)]
    primary: bool,
    size: u64,
    file_type: Option<String>,
}

#[derive(Clone)]
struct ResolvedItem {
    plan: ContentInstallPlanItem,
    project_type: String,
    url: String,
    sha1: String,
    old_path: Option<String>,
}

/// Reconcile files that were copied or imported outside SLH with Modrinth's
/// canonical version records. Exact file hashes are used deliberately: file
/// names are not stable identifiers and must never be used to guess a project.
pub async fn reconcile_local_content(
    state: &AppState,
    instance_id: &str,
    project_type: &str,
) -> AppResult<()> {
    let relative_directory = match project_type {
        "mod" => "mods",
        "resourcepack" => "resourcepacks",
        "shader" => "shaderpacks",
        // Installed worlds are directories after extraction, so their source
        // cannot be proven from an archive hash. Launcher-installed worlds are
        // already recorded during installation and remain updateable.
        "world" => return Ok(()),
        value => {
            return Err(AppError::InvalidInput(format!(
                "Unsupported content type for reconciliation: {value}"
            )));
        }
    };
    let instance = database::instance(&state.database, instance_id).await?;
    let directory = PathBuf::from(&instance.game_dir).join(relative_directory);
    if !directory.is_dir() {
        return Ok(());
    }
    let tracked_paths: HashSet<String> = sqlx::query_scalar::<_, String>(
        "SELECT file_path FROM installed_content WHERE instance_id = ?",
    )
    .bind(instance_id)
    .fetch_all(&state.database)
    .await?
    .into_iter()
    .map(|path| path.replace('\\', "/").to_ascii_lowercase())
    .collect();
    let content_kind = project_type.to_owned();
    let file_hashes =
        tokio::task::spawn_blocking(move || -> AppResult<HashMap<String, PathBuf>> {
            let mut hashes = HashMap::new();
            for entry in std::fs::read_dir(directory)? {
                let path = entry?.path();
                if !path.is_file()
                    || tracked_paths.contains(
                        &path
                            .to_string_lossy()
                            .replace('\\', "/")
                            .to_ascii_lowercase(),
                    )
                {
                    continue;
                }
                let extension = path
                    .extension()
                    .and_then(|value| value.to_str())
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                let allowed = match content_kind.as_str() {
                    "mod" => extension == "jar" || extension == "disabled",
                    "resourcepack" | "shader" => extension == "zip",
                    _ => false,
                };
                if !allowed {
                    continue;
                }
                let mut file = std::fs::File::open(&path)?;
                let mut hasher = Sha1::new();
                let mut buffer = [0_u8; 128 * 1024];
                loop {
                    let read = file.read(&mut buffer)?;
                    if read == 0 {
                        break;
                    }
                    hasher.update(&buffer[..read]);
                }
                hashes.insert(format!("{:x}", hasher.finalize()), path);
            }
            Ok(hashes)
        })
        .await
        .map_err(|error| AppError::Process(format!("Content hashing task failed: {error}")))??;
    let versions: HashMap<String, ProjectVersion> = if file_hashes.is_empty() {
        HashMap::new()
    } else {
        let requested_hashes: Vec<&String> = file_hashes.keys().collect();
        state
            .http
            .post("https://api.modrinth.com/v2/version_files")
            .json(&serde_json::json!({ "hashes": requested_hashes, "algorithm": "sha1" }))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?
    };
    for (hash, version) in versions {
        let Some(path) = file_hashes.get(&hash) else {
            continue;
        };
        // A version title (for example `1.0.39+1.21`) is not the project
        // title users recognize. It is refreshed from the project endpoint
        // below; use the filename only as a temporary offline-safe fallback.
        let display_name = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or(&version.project_id)
            .to_owned();
        sqlx::query(
            "INSERT INTO installed_content(instance_id, provider, project_id, version_id, \
             project_type, display_name, file_path, file_sha1, installed_at) \
             VALUES (?, 'modrinth', ?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(instance_id, provider, project_id) DO UPDATE SET \
             version_id = excluded.version_id, project_type = excluded.project_type, \
             display_name = excluded.display_name, file_path = excluded.file_path, \
             file_sha1 = excluded.file_sha1, installed_at = excluded.installed_at",
        )
        .bind(instance_id)
        .bind(&version.project_id)
        .bind(&version.id)
        .bind(project_type)
        .bind(display_name)
        .bind(path.to_string_lossy().into_owned())
        .bind(&hash)
        .bind(Utc::now().to_rfc3339())
        .execute(&state.database)
        .await?;
    }
    // Project-name enrichment is cosmetic. A transient metadata failure must
    // not prevent local files from being indexed and updated.
    let _ = refresh_modrinth_display_names(state, instance_id, project_type).await;
    Ok(())
}

async fn refresh_modrinth_display_names(
    state: &AppState,
    instance_id: &str,
    project_type: &str,
) -> AppResult<()> {
    let project_ids = sqlx::query_scalar::<_, String>(
        "SELECT project_id FROM installed_content WHERE instance_id = ? AND provider = 'modrinth' AND project_type = ?",
    )
    .bind(instance_id)
    .bind(project_type)
    .fetch_all(&state.database)
    .await?;
    for chunk in project_ids.chunks(100) {
        if chunk.is_empty() {
            continue;
        }
        let ids = serde_json::to_string(chunk)?;
        let projects: Vec<ProjectDetails> = state
            .http
            .get("https://api.modrinth.com/v2/projects")
            .query(&[("ids", ids)])
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        for project in projects {
            sqlx::query(
                "UPDATE installed_content SET display_name = ? WHERE instance_id = ? AND provider = 'modrinth' AND project_id = ?",
            )
            .bind(project.title)
            .bind(instance_id)
            .bind(project.id)
            .execute(&state.database)
            .await?;
        }
    }
    Ok(())
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
    // Prepare every changed destination and its download record first. The
    // transfers themselves are independent and can safely run concurrently;
    // filesystem backups happen before any network work so an interrupted
    // update never destroys the previous content.
    let mut changed = Vec::new();
    for (index, item) in resolved.iter().enumerate() {
        let destination = PathBuf::from(&item.plan.destination);
        if item.plan.action == "unchanged" {
            unchanged_files += 1;
        } else {
            if destination.exists() {
                backup_content_file(state, instance_id, &destination).await?;
                backups_created += 1;
            }
            let download_id = Uuid::new_v4().to_string();
            sqlx::query(
                "INSERT INTO downloads(id, source, url, destination, status, total_bytes) \
                 VALUES (?, 'modrinth', ?, ?, 'running', ?)",
            )
            .bind(&download_id)
            .bind(&item.url)
            .bind(destination.to_string_lossy().into_owned())
            .bind(item.plan.size_bytes as i64)
            .execute(&state.database)
            .await?;
            changed.push((
                index,
                DownloadPlan {
                    url: item.url.clone(),
                    destination,
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
            sqlx::query(
                "UPDATE downloads SET status = 'complete', downloaded_bytes = ?, \
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
            )
            .bind(bytes_by_index[batch_index] as i64)
            .bind(download_id)
            .execute(&state.database)
            .await?;
            let destination = PathBuf::from(&item.plan.destination);
            if let Some(old_path) = &item.old_path {
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
             VALUES (?, 'modrinth', ?, ?, ?, ?, ?, ?, ?) \
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
    minecraft_version: Option<&str>,
    loader: Option<&str>,
    version_id: Option<&str>,
) -> AppResult<Instance> {
    validate_id(project_id)?;
    let project = project(state, project_id).await?;
    if project.project_type != "modpack" {
        return Err(AppError::InvalidInput(format!(
            "Modrinth project {} is not a modpack",
            project.title
        )));
    }
    let requested_instance_name = match name {
        Some(name) => crate::instances::validate_display_name(&name)?,
        None => safe_modpack_name(&project.title),
    };
    let instance_name =
        crate::instances::allocate_unique_display_name(&state.database, &requested_instance_name)
            .await?;
    let minecraft_version = minecraft_version
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            AppError::InvalidInput("Choose a Minecraft version before installing a modpack".into())
        })?;
    let version = match version_id.map(str::trim).filter(|value| !value.is_empty()) {
        Some(version_id) => {
            let version = version_by_id(state, version_id).await?;
            if version.project_id != project_id {
                return Err(AppError::InvalidInput(
                    "The selected version belongs to another Modrinth project".into(),
                ));
            }
            if !version
                .game_versions
                .iter()
                .any(|version_game| version_game == minecraft_version)
                || loader.is_some_and(|expected_loader| {
                    !version
                        .loaders
                        .iter()
                        .any(|version_loader| version_loader == expected_loader)
                })
            {
                return Err(AppError::Conflict("The selected modpack version is not compatible with the selected Minecraft version or loader".into()));
            }
            version
        }
        None => compatible_version(state, project_id, minecraft_version, loader).await?,
    };
    let file = choose_modpack_file(&version)?;
    if !file.url.starts_with("https://") {
        return Err(AppError::Security(
            "Modrinth returned a non-HTTPS modpack download URL".into(),
        ));
    }
    if file.size > 512 * 1024 * 1024 {
        return Err(AppError::Security(
            "Modrinth modpack archive exceeds the 512 MiB safety limit".into(),
        ));
    }
    let sha1 = file
        .hashes
        .get("sha1")
        .cloned()
        .ok_or_else(|| AppError::Security("Modrinth modpack has no SHA-1 hash".into()))?;
    let pack_directory = state.paths.downloads.join("modrinth-packs");
    tokio::fs::create_dir_all(&pack_directory).await?;
    let archive_path = pack_directory.join(format!("{project_id}-{}.mrpack", version.id));
    let download_id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO downloads(id, source, url, destination, status, total_bytes) \
         VALUES (?, 'modrinth', ?, ?, 'running', ?)",
    )
    .bind(&download_id)
    .bind(&file.url)
    .bind(archive_path.to_string_lossy().into_owned())
    .bind(file.size as i64)
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
            message: format!("Downloading {}", project.title),
            completed: 0,
            total: Some(1),
            downloaded_bytes: Some(0),
            total_bytes: Some(file.size),
        },
    );
    let progress_app = app.clone();
    let project_title = project.title.clone();
    let progress_operation = operation_id.clone();
    let downloaded = download_verified_with_progress(
        &state.http,
        &DownloadPlan {
            url: file.url.clone(),
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
                    message: format!("Downloading {}", project_title),
                    completed: 0,
                    total: Some(1),
                    downloaded_bytes: Some(completed),
                    total_bytes: total.or(Some(file.size)),
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
                    message: format!("{} archive verified", project.title),
                    completed: 1,
                    total: Some(1),
                    downloaded_bytes: Some(bytes),
                    total_bytes: Some(file.size),
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
                    operation_id: operation_id.clone(),
                    instance_id: None,
                    operation: "modpack".into(),
                    stage: "failed".into(),
                    message: error.to_string(),
                    completed: 0,
                    total: Some(1),
                    downloaded_bytes: None,
                    total_bytes: Some(file.size),
                },
            );
            return Err(error);
        }
    }

    let imported = crate::archives::import_modrinth_pack(
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
                total_bytes: Some(file.size),
            },
        );
    }
    imported
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
        "Modrinth pack".into()
    }
}

async fn resolve(
    state: &AppState,
    instance_id: &str,
    project_id: &str,
) -> AppResult<(Vec<ResolvedItem>, ContentInstallPlan)> {
    validate_id(project_id)?;
    let instance = database::instance(&state.database, instance_id).await?;
    if instance.status != "installed" {
        return Err(AppError::Conflict(
            "Install and verify the target instance before adding content".into(),
        ));
    }
    let root_project = project(state, project_id).await?;
    let root_loader = loader_for_project(&root_project.project_type, &instance)?;
    let root_version = compatible_version(
        state,
        &root_project.id,
        &instance.minecraft_version,
        root_loader.as_deref(),
    )
    .await?;
    let mut queue = VecDeque::from([(root_version, root_project.project_type.clone())]);
    let mut visited = HashSet::new();
    let mut versions = Vec::new();
    let mut incompatible_projects = HashSet::new();
    while let Some((version, version_project_type)) = queue.pop_front() {
        if !visited.insert(version.id.clone()) {
            continue;
        }
        let version_loader = loader_for_project(&version_project_type, &instance)?;
        ensure_version_compatible(&version, &instance, version_loader.as_deref())?;
        if visited.len() > 64 {
            return Err(AppError::Security(
                "Modrinth dependency graph exceeds 64 versions".into(),
            ));
        }
        for dependency in &version.dependencies {
            match dependency.dependency_type.as_str() {
                "required" => {
                    let (dependency_version, dependency_project_type) = if let Some(version_id) =
                        &dependency.version_id
                    {
                        let dependency_version = version_by_id(state, version_id).await?;
                        let dependency_project =
                            project(state, &dependency_version.project_id).await?;
                        (dependency_version, dependency_project.project_type)
                    } else if let Some(project_id) = &dependency.project_id {
                        let dependency_project = project(state, project_id).await?;
                        let dependency_loader =
                            loader_for_project(&dependency_project.project_type, &instance)?;
                        let dependency_version = compatible_version(
                            state,
                            project_id,
                            &instance.minecraft_version,
                            dependency_loader.as_deref(),
                        )
                        .await?;
                        (dependency_version, dependency_project.project_type)
                    } else {
                        return Err(AppError::Conflict(format!(
                            "{} declares a required external dependency without a Modrinth project",
                            version.name
                        )));
                    };
                    queue.push_back((dependency_version, dependency_project_type));
                }
                "incompatible" => {
                    if let Some(project_id) = &dependency.project_id {
                        incompatible_projects.insert(project_id.clone());
                    } else if let Some(version_id) = &dependency.version_id {
                        incompatible_projects
                            .insert(version_by_id(state, version_id).await?.project_id);
                    }
                }
                _ => {}
            }
        }
        versions.push((version, version_project_type));
    }
    let game_dir = PathBuf::from(&instance.game_dir);
    let mut resolved = Vec::new();
    let mut conflicts = Vec::new();
    let mut destinations = HashSet::new();
    for incompatible in incompatible_projects {
        let installed: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM installed_content \
             WHERE instance_id = ? AND provider = 'modrinth' AND project_id = ?)",
        )
        .bind(instance_id)
        .bind(&incompatible)
        .fetch_one(&state.database)
        .await?;
        if installed {
            conflicts.push(format!(
                "Installed Modrinth project {incompatible} is marked incompatible"
            ));
        }
    }
    for (version, version_project_type) in versions {
        let target_folder = target_folder_for_project(&version_project_type, &instance)?;
        let file = choose_file(&version)?;
        validate_relative_path(Path::new(&file.filename))?;
        if Path::new(&file.filename)
            .file_name()
            .and_then(|name| name.to_str())
            != Some(file.filename.as_str())
        {
            return Err(AppError::Security(format!(
                "Modrinth supplied an unsafe file name: {}",
                file.filename
            )));
        }
        let sha1 = file
            .hashes
            .get("sha1")
            .cloned()
            .ok_or_else(|| AppError::Security("Modrinth file has no SHA-1 hash".into()))?;
        let destination = game_dir.join(target_folder).join(&file.filename);
        let destination_text = destination.to_string_lossy().into_owned();
        if !destinations.insert(destination_text.to_ascii_lowercase()) {
            conflicts.push(format!(
                "Multiple dependencies resolve to {}",
                file.filename
            ));
        }
        let existing = sqlx::query(
            "SELECT version_id, file_path, file_sha1 FROM installed_content \
             WHERE instance_id = ? AND provider = 'modrinth' AND project_id = ?",
        )
        .bind(instance_id)
        .bind(&version.project_id)
        .fetch_optional(&state.database)
        .await?;
        let mut action = "install".to_owned();
        let mut old_path = None;
        if let Some(row) = existing {
            use sqlx::Row;
            let installed_path: String = row.get("file_path");
            old_path = Some(installed_path.clone());
            if row.get::<String, _>("version_id") == version.id
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
                    "{} already exists and is not managed by this Modrinth project",
                    destination.display()
                ));
            }
        }
        resolved.push(ResolvedItem {
            plan: ContentInstallPlanItem {
                project_id: version.project_id.clone(),
                version_id: version.id.clone(),
                display_name: version.name.clone(),
                version_number: version.version_number.clone(),
                file_name: file.filename.clone(),
                destination: destination_text,
                size_bytes: file.size,
                action,
            },
            project_type: version_project_type,
            url: file.url.clone(),
            sha1,
            old_path,
        });
    }
    let total_bytes = resolved
        .iter()
        .filter(|item| item.plan.action != "unchanged")
        .map(|item| item.plan.size_bytes)
        .sum();
    let plan = ContentInstallPlan {
        provider: "modrinth".into(),
        root_project_id: root_project.id,
        instance_id: instance.id,
        project_type: root_project.project_type,
        items: resolved.iter().map(|item| item.plan.clone()).collect(),
        conflicts,
        total_bytes,
    };
    Ok((resolved, plan))
}

async fn project(state: &AppState, project_id: &str) -> AppResult<ProjectDetails> {
    validate_id(project_id)?;
    Ok(state
        .http
        .get(format!("https://api.modrinth.com/v2/project/{project_id}"))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?)
}

async fn compatible_version(
    state: &AppState,
    project_id: &str,
    game_version: &str,
    loader: Option<&str>,
) -> AppResult<ProjectVersion> {
    validate_id(project_id)?;
    let mut query = vec![
        ("game_versions", serde_json::to_string(&[game_version])?),
        ("include_changelog", "false".into()),
    ];
    if let Some(loader) = loader {
        query.push(("loaders", serde_json::to_string(&[loader])?));
    }
    let versions: Vec<ProjectVersion> = state
        .http
        .get(format!(
            "https://api.modrinth.com/v2/project/{project_id}/version"
        ))
        .query(&query)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    // Modrinth returns versions newest-first. A featured release can be older
    // than the latest compatible release, so featured must not override the
    // actual update candidate.
    versions
        .iter()
        .find(|version| version.version_type == "release")
        .or_else(|| versions.first())
        .cloned()
        .ok_or_else(|| {
            AppError::Conflict(format!(
                "No compatible version of Modrinth project {project_id} supports Minecraft {game_version}{}",
                loader.map(|value| format!(" / {value}")).unwrap_or_default()
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
    let loader = if project_type == "mod" {
        match loader_type {
            "fabric" | "forge" | "neoforge" | "quilt" => Some(loader_type),
            _ => {
                return Err(AppError::Conflict(format!(
                    "Mods are not compatible with the {loader_type} loader"
                )));
            }
        }
    } else {
        None
    };
    let version = compatible_version(state, project_id, game_version, loader).await?;
    Ok((version.id, version.version_number))
}

async fn version_by_id(state: &AppState, version_id: &str) -> AppResult<ProjectVersion> {
    validate_id(version_id)?;
    Ok(state
        .http
        .get(format!("https://api.modrinth.com/v2/version/{version_id}"))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?)
}

fn ensure_version_compatible(
    version: &ProjectVersion,
    instance: &Instance,
    loader: Option<&str>,
) -> AppResult<()> {
    let game_matches = version
        .game_versions
        .iter()
        .any(|game| game == &instance.minecraft_version);
    let loader_matches =
        loader.is_none_or(|loader| version.loaders.iter().any(|item| item == loader));
    if !game_matches || !loader_matches {
        return Err(AppError::Conflict(format!(
            "Required dependency {} is not compatible with Minecraft {}{}",
            version.name,
            instance.minecraft_version,
            loader
                .map(|value| format!(" / {value}"))
                .unwrap_or_default()
        )));
    }
    Ok(())
}

fn loader_for_project(project_type: &str, instance: &Instance) -> AppResult<Option<String>> {
    match project_type {
        "mod" if matches!(instance.loader_type.as_str(), "vanilla" | "bedrock") => Err(
            AppError::Conflict("Mods require a Fabric, Forge, NeoForge, or Quilt instance".into()),
        ),
        "mod" => Ok(Some(instance.loader_type.clone())),
        "resourcepack" => Ok(Some("minecraft".into())),
        "shader" => Ok(None),
        "modpack" => Err(AppError::Unavailable(
            "Modpacks are installed as new instances".into(),
        )),
        kind => Err(AppError::Unavailable(format!(
            "Installing Modrinth {kind} projects is not active yet"
        ))),
    }
}

fn target_folder_for_project(project_type: &str, instance: &Instance) -> AppResult<&'static str> {
    match project_type {
        "mod" if !matches!(instance.loader_type.as_str(), "vanilla" | "bedrock") => Ok("mods"),
        "mod" => Err(AppError::Conflict(
            "Mods require a Fabric, Forge, NeoForge, or Quilt instance".into(),
        )),
        "resourcepack" => Ok("resourcepacks"),
        "shader" => Ok("shaderpacks"),
        kind => Err(AppError::Unavailable(format!(
            "Installing Modrinth {kind} projects into an existing instance is not active"
        ))),
    }
}

fn choose_file(version: &ProjectVersion) -> AppResult<&ProjectFile> {
    version
        .files
        .iter()
        .filter(|file| {
            !matches!(
                file.file_type.as_deref(),
                Some("sources-jar" | "dev-jar" | "javadoc-jar" | "signature")
            )
        })
        .find(|file| file.primary)
        .or_else(|| version.files.first())
        .ok_or_else(|| AppError::NotFound(format!("No downloadable file for {}", version.name)))
}

fn choose_modpack_file(version: &ProjectVersion) -> AppResult<&ProjectFile> {
    version
        .files
        .iter()
        .filter(|file| {
            Path::new(&file.filename)
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("mrpack"))
        })
        .find(|file| file.primary)
        .or_else(|| {
            version.files.iter().find(|file| {
                Path::new(&file.filename)
                    .extension()
                    .and_then(|value| value.to_str())
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("mrpack"))
            })
        })
        .ok_or_else(|| AppError::NotFound(format!("No .mrpack archive for {}", version.name)))
}

fn validate_id(value: &str) -> AppResult<()> {
    if value.len() < 2
        || value.len() > 64
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err(AppError::InvalidInput(
            "Modrinth project or version ID is invalid".into(),
        ));
    }
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

    fn test_instance(loader_type: &str) -> Instance {
        Instance {
            id: "instance".into(),
            name: "Test".into(),
            group_id: None,
            icon_path: None,
            folder_name: "Test".into(),
            icon_key: "cube".into(),
            icon_background: Some("#3f493c".into()),
            icon_foreground: Some("#f0f4ed".into()),
            minecraft_version: "1.21.8".into(),
            loader_type: loader_type.into(),
            loader_version: None,
            status: "installed".into(),
            created_at: "2026-08-09T00:00:00Z".into(),
            last_played_at: None,
            last_launched_at: None,
            playtime_seconds: 0,
            java_path: None,
            memory_min_mb: 512,
            memory_max_mb: 4096,
            game_dir: r"C:\SLH\data\instances\instance\game".into(),
            config_schema_version: 1,
            bedrock_profile_mode: "shared".into(),
        }
    }

    #[test]
    fn ids_and_file_names_are_constrained() {
        assert!(validate_id("AANobbMI").is_ok());
        assert!(validate_id("../escape").is_err());
        assert!(validate_relative_path(Path::new("sodium.jar")).is_ok());
        assert!(validate_relative_path(Path::new("../sodium.jar")).is_err());
    }

    #[test]
    fn project_types_route_to_safe_instance_folders() {
        let fabric = test_instance("fabric");
        assert_eq!(target_folder_for_project("mod", &fabric).unwrap(), "mods");
        assert_eq!(
            target_folder_for_project("resourcepack", &fabric).unwrap(),
            "resourcepacks"
        );
        assert_eq!(
            target_folder_for_project("shader", &fabric).unwrap(),
            "shaderpacks"
        );
        assert!(target_folder_for_project("modpack", &fabric).is_err());
        assert!(target_folder_for_project("mod", &test_instance("vanilla")).is_err());
    }

    #[test]
    fn modpack_titles_become_windows_safe_instance_names() {
        assert_eq!(
            safe_modpack_name("Better: Minecraft?"),
            "Better- Minecraft-"
        );
        assert_eq!(safe_modpack_name("CON"), "Modrinth pack");
        assert_eq!(safe_modpack_name("Pack. "), "Pack");
    }
}
