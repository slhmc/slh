use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::host::Host;
use futures_util::StreamExt;
use sha1::{Digest, Sha1};
use sqlx::FromRow;

use crate::database;
use crate::error::{AppError, AppResult};
use crate::instances;
use crate::models::{
    CreateInstanceRequest, CreateInstanceVersionCopyRequest, CreateInstanceVersionCopyResult,
    InspectInstanceVersionMigrationRequest, Instance, InstanceVersionMigrationPreview,
    ListInstanceVersionMigrationEntriesRequest, VersionMigrationContent, VersionMigrationEntry,
    VersionMigrationFallbackAction, VersionMigrationFallbackOverride, VersionMigrationIssue,
    VersionMigrationSelection,
};
use crate::state::AppState;

const EXCLUDED: &[&str] = &[
    "assets",
    "libraries",
    "versions",
    "natives",
    "logs",
    "crash-reports",
    "cache",
    ".fabric",
    ".mixin.out",
    ".minecraft",
    ".modrinth",
    ".curseforge",
];

#[derive(Clone, Debug, FromRow)]
struct StoredContent {
    provider: String,
    project_id: String,
    version_id: String,
    project_type: String,
    display_name: String,
    file_path: String,
    file_sha1: Option<String>,
    installed_at: String,
}

fn relative_path(path: &str) -> AppResult<PathBuf> {
    if path.contains('\\') {
        return Err(AppError::InvalidInput(
            "Use forward slashes in paths".into(),
        ));
    }
    let candidate = PathBuf::from(path);
    crate::security::validate_relative_path(&candidate)?;
    if candidate.components().next().is_some_and(|first| {
        EXCLUDED.contains(
            &first
                .as_os_str()
                .to_string_lossy()
                .to_ascii_lowercase()
                .as_str(),
        )
    }) {
        return Err(AppError::InvalidInput(
            "Launcher runtime data cannot be copied".into(),
        ));
    }
    Ok(candidate)
}

fn checked_path(root: &Path, relative: &str) -> AppResult<PathBuf> {
    let relative = relative_path(relative)?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component);
        if fs::symlink_metadata(&current)?.file_type().is_symlink() {
            return Err(AppError::Security(format!(
                "Symbolic link is not allowed: {relative:?}"
            )));
        }
    }
    Ok(current)
}

fn game_root(state: &AppState, instance: &Instance) -> AppResult<PathBuf> {
    instances::validated_instance_root(&state.paths, &instance.folder_name, &instance.game_dir)?;
    Ok(PathBuf::from(&instance.game_dir))
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn scan_entry(root: &Path, path: &Path) -> AppResult<VersionMigrationEntry> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() {
        return Err(AppError::Security("Symbolic link in build".into()));
    }
    let relative = path
        .strip_prefix(root)
        .map_err(|_| AppError::Security("File is outside build".into()))?;
    let name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let is_directory = metadata.is_dir();
    let (mut count, mut size) = (0, 0);
    if is_directory {
        for child in walkdir::WalkDir::new(path)
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
        {
            if child.file_type().is_file() {
                count += 1;
                size += child.metadata().map(|m| m.len()).unwrap_or(0);
            }
        }
    } else {
        count = 1;
        size = metadata.len();
    }
    Ok(VersionMigrationEntry {
        path: path_string(relative),
        name: name.clone(),
        is_directory,
        file_count: count,
        size_bytes: size,
        selected_by_default: relative.components().count() == 1
            && is_directory
            && matches!(name.to_ascii_lowercase().as_str(), "mods" | "resourcepacks"),
    })
}

pub async fn list_entries(
    state: &AppState,
    request: ListInstanceVersionMigrationEntriesRequest,
) -> AppResult<Vec<VersionMigrationEntry>> {
    let instance = database::instance(&state.database, &request.instance_id).await?;
    let root = game_root(state, &instance)?;
    let relative = request.path.unwrap_or_default();
    let parent = if relative.is_empty() {
        root.clone()
    } else {
        checked_path(&root, &relative)?
    };
    tokio::task::spawn_blocking(move || -> AppResult<Vec<VersionMigrationEntry>> {
        if !parent.is_dir() {
            return Err(AppError::InvalidInput("Folder does not exist".into()));
        }
        let mut entries = Vec::new();
        for item in fs::read_dir(&parent)? {
            let path = item?.path();
            let name = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_ascii_lowercase();
            if parent == root && EXCLUDED.contains(&name.as_str()) {
                continue;
            }
            if fs::symlink_metadata(&path)?.file_type().is_symlink() {
                continue;
            }
            entries.push(scan_entry(&root, &path)?);
        }
        entries.sort_by(|a, b| {
            b.selected_by_default
                .cmp(&a.selected_by_default)
                .then_with(|| b.is_directory.cmp(&a.is_directory))
                .then_with(|| {
                    a.name
                        .to_ascii_lowercase()
                        .cmp(&b.name.to_ascii_lowercase())
                })
        });
        Ok(entries)
    })
    .await
    .map_err(|e| AppError::Process(e.to_string()))?
}

async fn release_and_loader(
    state: &AppState,
    source: &Instance,
    target: &str,
) -> AppResult<Option<String>> {
    let versions = crate::minecraft::installer::list_versions(state).await?;
    if !versions
        .iter()
        .any(|v| v.id == target && v.version_type == "release")
    {
        return Err(AppError::InvalidInput(format!(
            "Minecraft release {target} was not found"
        )));
    }
    if source.loader_type == "vanilla" {
        return Ok(None);
    }
    let loaders = crate::loaders::list_versions(state, &source.loader_type, target).await?;
    Ok(loaders
        .iter()
        .find(|v| v.recommended)
        .or_else(|| loaders.iter().find(|v| v.stable))
        .or_else(|| loaders.first())
        .map(|v| v.id.clone()))
}

fn collect_content(root: &Path) -> Vec<(String, String, String, bool)> {
    let mut result = Vec::new();
    for (folder, kind) in [
        ("mods", "mod"),
        ("resourcepacks", "resourcepack"),
        ("shaderpacks", "shader"),
    ] {
        let dir = root.join(folder);
        let Ok(items) = fs::read_dir(dir) else {
            continue;
        };
        for item in items.filter_map(Result::ok) {
            let path = item.path();
            let Ok(meta) = fs::symlink_metadata(&path) else {
                continue;
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            let name = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            let extension = path
                .extension()
                .and_then(|x| x.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase();
            let supported = if meta.is_file() {
                match kind {
                    "mod" => extension == "jar" || extension == "disabled",
                    _ => extension == "zip",
                }
            } else if meta.is_dir() {
                kind == "resourcepack" && path.join("pack.mcmeta").is_file()
                    || kind == "shader" && path.join("shaders").is_dir()
            } else {
                false
            };
            if supported {
                result.push((format!("{folder}/{name}"), kind.into(), name, meta.is_dir()));
            }
        }
    }
    result
}

async fn stored_content(state: &AppState, instance_id: &str) -> AppResult<Vec<StoredContent>> {
    Ok(sqlx::query_as::<_, StoredContent>("SELECT provider, project_id, version_id, project_type, display_name, file_path, file_sha1, installed_at FROM installed_content WHERE instance_id = ?")
        .bind(instance_id).fetch_all(&state.database).await?)
}

async fn copied_content_hash(row: &StoredContent, destination: &Path) -> AppResult<Option<String>> {
    if !Path::new(&row.file_path).is_dir() || !destination.is_file() {
        return Ok(row.file_sha1.clone());
    }
    let destination = destination.to_path_buf();
    tokio::task::spawn_blocking(move || -> AppResult<Option<String>> {
        let mut input = fs::File::open(destination)?;
        let mut digest = Sha1::new();
        let mut buffer = [0_u8; 128 * 1024];
        loop {
            let length = input.read(&mut buffer)?;
            if length == 0 {
                break;
            }
            digest.update(&buffer[..length]);
        }
        Ok(Some(format!("{:x}", digest.finalize())))
    })
    .await
    .map_err(|error| AppError::Process(error.to_string()))?
}

async fn candidate(
    state: &AppState,
    row: &StoredContent,
    target: &str,
    loader: &str,
) -> AppResult<(String, String)> {
    match row.provider.as_str() {
        "modrinth" => {
            crate::content::install::migration_version_candidate(
                state,
                &row.project_id,
                target,
                loader,
                &row.project_type,
            )
            .await
        }
        "curseforge" => {
            crate::content::curseforge::migration_version_candidate(
                state,
                &row.project_id,
                target,
                loader,
                &row.project_type,
            )
            .await
        }
        _ => Err(AppError::NotFound("Unknown content provider".into())),
    }
}

pub async fn inspect(
    state: &AppState,
    request: InspectInstanceVersionMigrationRequest,
) -> AppResult<InstanceVersionMigrationPreview> {
    let instance = database::instance(&state.database, &request.instance_id).await?;
    let root = game_root(state, &instance)?;
    if instance.loader_type == "bedrock" {
        return Err(AppError::InvalidInput("Java edition only".into()));
    }
    if request.target_minecraft_version.is_none() {
        return Ok(InstanceVersionMigrationPreview {
            entries: list_entries(
                state,
                ListInstanceVersionMigrationEntriesRequest {
                    instance_id: request.instance_id,
                    path: None,
                },
            )
            .await?,
            content: vec![],
            target_loader_version: None,
            loader_error: None,
            lookup_warnings: vec![],
        });
    }
    let target = request.target_minecraft_version.unwrap();
    let loader = release_and_loader(state, &instance, &target).await?;
    let loader_error = if instance.loader_type != "vanilla" && loader.is_none() {
        Some(format!(
            "No {} loader for Minecraft {target}",
            instance.loader_type
        ))
    } else {
        None
    };
    let mut lookup_warnings = Vec::new();
    for kind in ["mod", "resourcepack", "shader"] {
        if let Err(error) =
            crate::content::install::reconcile_local_content(state, &instance.id, kind).await
        {
            lookup_warnings.push(format!("{kind}: {error}"));
        }
    }
    let records = stored_content(state, &instance.id).await?;
    let by_path: HashMap<String, StoredContent> = records
        .into_iter()
        .filter_map(|row| {
            Path::new(&row.file_path)
                .strip_prefix(&root)
                .ok()
                .map(|p| (path_string(p).to_ascii_lowercase(), row.clone()))
        })
        .collect();
    let files = tokio::task::spawn_blocking(move || collect_content(&root))
        .await
        .map_err(|e| AppError::Process(e.to_string()))?;
    let by_path = &by_path;
    let target = &target;
    let loader_type = instance.loader_type.as_str();
    let mut content = futures_util::stream::iter(files.into_iter().map(
        |(path, kind, name, is_directory)| async move {
            if let Some(record) = by_path.get(&path.to_ascii_lowercase()) {
                let (status, version) = match candidate(state, record, target, loader_type).await {
                    Ok((id, version)) if id == record.version_id => ("current", Some(version)),
                    Ok((_, version)) => ("available", Some(version)),
                    Err(AppError::Conflict(_) | AppError::NotFound(_)) => ("incompatible", None),
                    Err(_) => ("error", None),
                };
                VersionMigrationContent {
                    path,
                    is_directory,
                    provider: Some(record.provider.clone()),
                    project_id: Some(record.project_id.clone()),
                    project_type: kind,
                    display_name: record.display_name.clone(),
                    current_version_id: Some(record.version_id.clone()),
                    update_status: status.into(),
                    candidate_version: version,
                }
            } else {
                VersionMigrationContent {
                    path,
                    is_directory,
                    provider: None,
                    project_id: None,
                    project_type: kind,
                    display_name: name,
                    current_version_id: None,
                    update_status: "unknown".into(),
                    candidate_version: None,
                }
            }
        },
    ))
    .buffer_unordered(8)
    .collect::<Vec<_>>()
    .await;
    content.sort_by(|a, b| {
        a.path
            .to_ascii_lowercase()
            .cmp(&b.path.to_ascii_lowercase())
    });
    Ok(InstanceVersionMigrationPreview {
        entries: vec![],
        content,
        target_loader_version: loader,
        loader_error,
        lookup_warnings,
    })
}

fn is_selected(path: &str, rules: &[VersionMigrationSelection]) -> bool {
    let mut selected = false;
    let mut best = 0;
    for rule in rules {
        if (path == rule.path || path.starts_with(&format!("{}/", rule.path)))
            && rule.path.len() >= best
        {
            best = rule.path.len();
            selected = rule.selected;
        }
    }
    selected
}

fn content_selected(item: &VersionMigrationContent, rules: &[VersionMigrationSelection]) -> bool {
    is_selected(&item.path, rules)
        || item.is_directory
            && rules
                .iter()
                .any(|rule| rule.selected && rule.path.starts_with(&format!("{}/", item.path)))
}

fn fallback_for(
    path: &str,
    default: VersionMigrationFallbackAction,
    overrides: &[VersionMigrationFallbackOverride],
) -> VersionMigrationFallbackAction {
    overrides
        .iter()
        .find(|item| item.path == path)
        .map_or(default, |item| item.action)
}

fn disabled_path(path: &str, is_directory: bool) -> String {
    if is_directory {
        return format!("{path}.zip.off");
    }
    if path.to_ascii_lowercase().ends_with(".off") {
        return path.to_owned();
    }
    let base = if path.to_ascii_lowercase().ends_with(".disabled") {
        &path[..path.len() - ".disabled".len()]
    } else {
        path
    };
    format!("{base}.off")
}

// Rules for failed updates apply to the whole package, including unpacked packs.
type CopyPolicies = HashMap<String, (VersionMigrationFallbackAction, bool)>;

fn copy_policy<'a>(
    path: &str,
    policies: &'a CopyPolicies,
) -> Option<(&'a str, VersionMigrationFallbackAction, bool)> {
    policies
        .iter()
        .filter(|(parent, (_, directory))| {
            path == parent.as_str() || *directory && path.starts_with(&format!("{parent}/"))
        })
        .max_by_key(|(parent, _)| parent.len())
        .map(|(parent, (action, directory))| (parent.as_str(), *action, *directory))
}

fn copy_files(
    root: &Path,
    destination: &Path,
    rules: &[VersionMigrationSelection],
    policies: &CopyPolicies,
) -> AppResult<()> {
    copy_files_from(root, root, destination, rules, policies)
}

fn copy_files_from(
    root: &Path,
    scan_root: &Path,
    destination: &Path,
    rules: &[VersionMigrationSelection],
    policies: &CopyPolicies,
) -> AppResult<()> {
    let mut outputs = HashSet::new();
    for item in walkdir::WalkDir::new(scan_root)
        .min_depth(usize::from(root == scan_root))
        .follow_links(false)
        .into_iter()
    {
        let item = item.map_err(|e| AppError::Io(std::io::Error::other(e)))?;
        if item.file_type().is_symlink() {
            continue;
        }
        let relative = item
            .path()
            .strip_prefix(root)
            .map_err(|_| AppError::Security("Invalid source path".into()))?;
        let path = path_string(relative);
        if relative.components().next().is_some_and(|first| {
            EXCLUDED.contains(
                &first
                    .as_os_str()
                    .to_string_lossy()
                    .to_ascii_lowercase()
                    .as_str(),
            )
        }) {
            continue;
        }
        if !is_selected(&path, rules) {
            continue;
        }
        let output = match copy_policy(&path, policies) {
            Some((_, VersionMigrationFallbackAction::Skip, _)) => continue,
            Some((_, VersionMigrationFallbackAction::Disable, true)) => continue,
            Some((_, VersionMigrationFallbackAction::Disable, false)) => {
                disabled_path(&path, false)
            }
            _ => path,
        };
        let target = destination.join(relative_path(&output)?);
        if item.file_type().is_dir() {
            fs::create_dir_all(target)?;
            continue;
        }
        if !outputs.insert(output.clone()) {
            return Err(AppError::Conflict(format!(
                "Two selected files have the same destination: {output}"
            )));
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(item.path(), target)?;
    }
    // A directory ending in .off can still be discovered by Minecraft.
    // Store unpacked disabled packs as .zip.off, which can also be enabled in SLH.
    for (path, (action, directory)) in policies {
        if *action != VersionMigrationFallbackAction::Disable || !directory {
            continue;
        }
        let output = disabled_path(path, true);
        if !outputs.insert(output.clone()) {
            return Err(AppError::Conflict(format!(
                "Two selected files have the same destination: {output}"
            )));
        }
        let source = checked_path(root, path)?;
        let target = destination.join(relative_path(&output)?);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut archive = zip::ZipWriter::new(fs::File::create(&target)?);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for item in walkdir::WalkDir::new(&source)
            .min_depth(1)
            .follow_links(false)
            .into_iter()
        {
            let item = item.map_err(|e| AppError::Io(std::io::Error::other(e)))?;
            if !item.file_type().is_file() {
                continue;
            }
            let original = item
                .path()
                .strip_prefix(root)
                .map_err(|_| AppError::Security("Invalid pack path".into()))?;
            if !is_selected(&path_string(original), rules) {
                continue;
            }
            let relative = item
                .path()
                .strip_prefix(&source)
                .map_err(|_| AppError::Security("Invalid pack path".into()))?;
            archive.start_file(path_string(relative), options)?;
            std::io::copy(&mut fs::File::open(item.path())?, &mut archive)?;
        }
        archive.finish()?;
    }
    Ok(())
}

fn remove_generated_content(root: &Path, path: &Path) -> AppResult<()> {
    if !path.exists() {
        return Ok(());
    }
    let relative = path
        .strip_prefix(root)
        .map_err(|_| AppError::Security("Content is outside new instance".into()))?;
    let first = relative
        .components()
        .next()
        .map(|part| part.as_os_str().to_string_lossy().into_owned());
    if !matches!(
        first.as_deref(),
        Some("mods" | "resourcepacks" | "shaderpacks")
    ) || relative.components().count() < 2
    {
        return Err(AppError::Security(
            "Only generated content packages can be replaced".into(),
        ));
    }
    let path = checked_path(root, &path_string(relative))?;
    if path.is_dir() {
        fs::remove_dir_all(path)?;
    } else {
        fs::remove_file(path)?;
    }
    Ok(())
}

async fn restore_content_choices(
    state: &AppState,
    source: &Instance,
    created: &Instance,
    content: &[VersionMigrationContent],
    updated: &HashSet<String>,
    rules: &[VersionMigrationSelection],
    policies: &CopyPolicies,
) -> AppResult<()> {
    let source_root = game_root(state, source)?;
    let target_root = game_root(state, created)?;
    let source_records = stored_content(state, &source.id).await?;
    let target_records = stored_content(state, &created.id).await?;
    for item in content {
        if updated.contains(&item.path) || !content_selected(item, rules) {
            continue;
        }
        let action = policies
            .get(&item.path)
            .map_or(VersionMigrationFallbackAction::Copy, |entry| entry.0);
        let original_target = target_root.join(relative_path(&item.path)?);
        let output = match action {
            VersionMigrationFallbackAction::Disable => disabled_path(&item.path, item.is_directory),
            _ => item.path.clone(),
        };
        let desired_target = target_root.join(relative_path(&output)?);
        for record in target_records.iter().filter(|record| {
            item.provider.as_deref() == Some(record.provider.as_str())
                && item.project_id.as_deref() == Some(record.project_id.as_str())
                || Path::new(&record.file_path) == original_target
                || Path::new(&record.file_path) == desired_target
        }) {
            let recorded = PathBuf::from(&record.file_path);
            if action == VersionMigrationFallbackAction::Skip || recorded != desired_target {
                remove_generated_content(&target_root, &recorded)?;
            }
            sqlx::query("DELETE FROM installed_content WHERE instance_id = ? AND provider = ? AND project_id = ?")
                .bind(&created.id).bind(&record.provider).bind(&record.project_id).execute(&state.database).await?;
        }
        if action != VersionMigrationFallbackAction::Copy {
            remove_generated_content(&target_root, &original_target)?;
        }
        if action == VersionMigrationFallbackAction::Skip {
            continue;
        }
        let source_path = checked_path(&source_root, &item.path)?;
        let source_root_task = source_root.clone();
        let destination_task = target_root.clone();
        let rules_task = rules.to_vec();
        let own_policy = policies
            .get(&item.path)
            .map(|entry| HashMap::from([(item.path.clone(), *entry)]))
            .unwrap_or_default();
        tokio::task::spawn_blocking(move || {
            copy_files_from(
                &source_root_task,
                &source_path,
                &destination_task,
                &rules_task,
                &own_policy,
            )
        })
        .await
        .map_err(|error| AppError::Process(error.to_string()))??;
        if let Some(record) = source_records.iter().find(|record| {
            item.provider.as_deref() == Some(record.provider.as_str())
                && item.project_id.as_deref() == Some(record.project_id.as_str())
        }) {
            let copied_hash = copied_content_hash(record, &desired_target).await?;
            sqlx::query("INSERT OR REPLACE INTO installed_content(instance_id, provider, project_id, version_id, project_type, display_name, file_path, file_sha1, installed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
                .bind(&created.id).bind(&record.provider).bind(&record.project_id).bind(&record.version_id).bind(&record.project_type)
                .bind(&record.display_name).bind(desired_target.to_string_lossy().to_string()).bind(&copied_hash).bind(&record.installed_at)
                .execute(&state.database).await?;
        }
    }
    Ok(())
}

pub async fn create_copy(
    app: &Host,
    state: &AppState,
    request: CreateInstanceVersionCopyRequest,
) -> AppResult<CreateInstanceVersionCopyResult> {
    let source = database::instance(&state.database, &request.instance_id).await?;
    let root = game_root(state, &source)?;
    if state.running_instances.read().await.contains(&source.id) {
        return Err(AppError::Conflict("Stop the source instance first".into()));
    }
    if request.selections.len() + request.update_selections.len() + request.fallback_overrides.len()
        > 100_000
    {
        return Err(AppError::InvalidInput("Too many file selections".into()));
    }
    for rules in [&request.selections, &request.update_selections] {
        let mut seen = HashSet::new();
        for rule in rules {
            if !seen.insert(&rule.path) {
                return Err(AppError::InvalidInput("Duplicate selection".into()));
            }
            checked_path(&root, &rule.path)?;
        }
    }
    let preview = inspect(
        state,
        InspectInstanceVersionMigrationRequest {
            instance_id: source.id.clone(),
            target_minecraft_version: Some(request.target_minecraft_version.clone()),
        },
    )
    .await?;
    if let Some(error) = preview.loader_error {
        return Err(AppError::Conflict(error));
    }
    let mut seen = HashSet::new();
    for item in &request.fallback_overrides {
        if !seen.insert(&item.path)
            || !preview
                .content
                .iter()
                .any(|content| content.path == item.path)
        {
            return Err(AppError::InvalidInput(
                "Unknown or duplicate fallback file".into(),
            ));
        }
    }
    let mut issues = preview
        .content
        .iter()
        .filter(|item| {
            content_selected(item, &request.selections)
                && is_selected(&item.path, &request.update_selections)
                && matches!(
                    item.update_status.as_str(),
                    "incompatible" | "unknown" | "error"
                )
        })
        .map(|item| VersionMigrationIssue {
            path: item.path.clone(),
            display_name: item.display_name.clone(),
            project_type: item.project_type.clone(),
            reason: item.update_status.clone(),
            action: fallback_for(
                &item.path,
                request.fallback_action,
                &request.fallback_overrides,
            ),
        })
        .collect::<Vec<_>>();
    let mut policies: CopyPolicies = preview
        .content
        .iter()
        .filter(|item| issues.iter().any(|issue| issue.path == item.path))
        .map(|item| {
            (
                item.path.clone(),
                (
                    fallback_for(
                        &item.path,
                        request.fallback_action,
                        &request.fallback_overrides,
                    ),
                    item.is_directory,
                ),
            )
        })
        .collect();
    let selected_updates = preview
        .content
        .iter()
        .filter(|item| {
            item.update_status == "available"
                && content_selected(item, &request.selections)
                && is_selected(&item.path, &request.update_selections)
        })
        .map(|item| item.path.clone())
        .collect::<HashSet<_>>();
    let target_name = format!("{} ({})", source.name, request.target_minecraft_version);
    let created = instances::create_instance(
        &state.database,
        &state.paths,
        CreateInstanceRequest {
            name: target_name,
            group_id: source.group_id.clone(),
            minecraft_version: request.target_minecraft_version.clone(),
            loader_type: source.loader_type.clone(),
            loader_version: preview.target_loader_version.clone(),
            java_path: source.java_path.clone(),
            memory_min_mb: source.memory_min_mb,
            memory_max_mb: source.memory_max_mb,
            icon_key: Some(source.icon_key.clone()),
            icon_background: source.icon_background.clone(),
            icon_foreground: source.icon_foreground.clone(),
            bedrock_profile_mode: None,
        },
    )
    .await?;
    let destination = PathBuf::from(&created.game_dir);
    let rules = request.selections.clone();
    let source_root = root.clone();
    let copy_policies = policies.clone();
    tokio::task::spawn_blocking(move || -> AppResult<()> {
        copy_files(&source_root, &destination, &rules, &copy_policies)
    })
    .await
    .map_err(|e| AppError::Process(e.to_string()))??;
    let records = stored_content(state, &source.id).await?;
    for row in &records {
        let Ok(relative) = Path::new(&row.file_path).strip_prefix(&root) else {
            continue;
        };
        let path = path_string(relative);
        let output = match copy_policy(&path, &policies) {
            Some((_, VersionMigrationFallbackAction::Skip, _)) => continue,
            Some((parent, VersionMigrationFallbackAction::Disable, directory)) => {
                disabled_path(parent, directory)
            }
            _ => path.clone(),
        };
        let copied = PathBuf::from(&created.game_dir).join(relative_path(&output)?);
        if !is_selected(&path, &request.selections) || !copied.exists() {
            continue;
        }
        let copied_hash = copied_content_hash(row, &copied).await?;
        sqlx::query("INSERT OR REPLACE INTO installed_content(instance_id, provider, project_id, version_id, project_type, display_name, file_path, file_sha1, installed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .bind(&created.id).bind(&row.provider).bind(&row.project_id).bind(&row.version_id).bind(&row.project_type)
            .bind(&row.display_name).bind(copied.to_string_lossy().to_string()).bind(&copied_hash).bind(&row.installed_at)
            .execute(&state.database).await?;
    }
    let mut warnings = preview
        .lookup_warnings
        .into_iter()
        .filter(|warning| {
            issues.iter().any(|item| {
                matches!(item.reason.as_str(), "unknown" | "error")
                    && warning.starts_with(&format!("{}:", item.project_type))
            })
        })
        .collect::<Vec<_>>();
    if let Err(error) =
        crate::minecraft::installer::install_instance(app, state, &created.id, None).await
    {
        warnings.push(format!("Minecraft installation: {error}"));
    }
    let mut updated_content_files = 0;
    let mut updated_paths = HashSet::new();
    for item in &preview.content {
        let Some(provider) = &item.provider else {
            continue;
        };
        let Some(project_id) = &item.project_id else {
            continue;
        };
        if !selected_updates.contains(&item.path) {
            continue;
        }
        let installed = match provider.as_str() {
            "modrinth" => crate::content::install::install(app, state, &created.id, project_id)
                .await
                .map(|_| ()),
            "curseforge" => {
                crate::content::curseforge::install(app, state, &created.id, project_id)
                    .await
                    .map(|_| ())
            }
            _ => continue,
        };
        match installed {
            Ok(()) => {
                updated_content_files += 1;
                updated_paths.insert(item.path.clone());
            }
            Err(error) => {
                warnings.push(format!("{}: {error}", item.display_name));
                let action = fallback_for(
                    &item.path,
                    request.fallback_action,
                    &request.fallback_overrides,
                );
                policies.insert(item.path.clone(), (action, item.is_directory));
                issues.push(VersionMigrationIssue {
                    path: item.path.clone(),
                    display_name: item.display_name.clone(),
                    project_type: item.project_type.clone(),
                    reason: "error".into(),
                    action,
                });
            }
        }
    }
    // Required dependencies can touch other projects. Restore each copied-only
    // package and enforce the chosen fallback after all update operations.
    if !selected_updates.is_empty() {
        restore_content_choices(
            state,
            &source,
            &created,
            &preview.content,
            &updated_paths,
            &request.selections,
            &policies,
        )
        .await?;
    }
    let instance = database::instance(&state.database, &created.id).await?;
    Ok(CreateInstanceVersionCopyResult {
        instance,
        updated_content_files,
        warnings,
        issues,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(path: &str, selected: bool) -> VersionMigrationSelection {
        VersionMigrationSelection {
            path: path.into(),
            selected,
        }
    }

    fn write(root: &Path, path: &str, bytes: &[u8]) {
        let path = root.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    #[test]
    fn warning_files_can_be_copied_disabled_or_skipped_without_changing_source() {
        let source = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        write(source.path(), "mods/copy.jar", b"copy bytes");
        write(source.path(), "mods/disable.jar", b"disable bytes");
        write(source.path(), "mods/skip.jar", b"skip bytes");
        write(source.path(), "mods/untouched.jar", b"untouched bytes");
        let policies = HashMap::from([
            (
                "mods/copy.jar".into(),
                (VersionMigrationFallbackAction::Copy, false),
            ),
            (
                "mods/disable.jar".into(),
                (VersionMigrationFallbackAction::Disable, false),
            ),
            (
                "mods/skip.jar".into(),
                (VersionMigrationFallbackAction::Skip, false),
            ),
        ]);
        copy_files(
            source.path(),
            target.path(),
            &[rule("mods", true)],
            &policies,
        )
        .unwrap();
        assert_eq!(
            fs::read(target.path().join("mods/copy.jar")).unwrap(),
            b"copy bytes"
        );
        assert_eq!(
            fs::read(target.path().join("mods/disable.jar.off")).unwrap(),
            b"disable bytes"
        );
        assert!(!target.path().join("mods/disable.jar").exists());
        assert!(!target.path().join("mods/skip.jar").exists());
        assert_eq!(
            fs::read(target.path().join("mods/untouched.jar")).unwrap(),
            b"untouched bytes"
        );
        assert_eq!(
            fs::read(source.path().join("mods/disable.jar")).unwrap(),
            b"disable bytes"
        );
        assert_eq!(
            fs::read(source.path().join("mods/skip.jar")).unwrap(),
            b"skip bytes"
        );
    }

    #[test]
    fn disabled_unpacked_packs_become_enableable_zip_off_archives() {
        let source = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        write(
            source.path(),
            "resourcepacks/local/pack.mcmeta",
            b"metadata",
        );
        write(
            source.path(),
            "resourcepacks/local/assets/keep.png",
            b"keep",
        );
        write(
            source.path(),
            "resourcepacks/local/assets/excluded.png",
            b"exclude",
        );
        let policies = HashMap::from([(
            "resourcepacks/local".into(),
            (VersionMigrationFallbackAction::Disable, true),
        )]);
        copy_files(
            source.path(),
            target.path(),
            &[
                rule("resourcepacks", true),
                rule("resourcepacks/local/assets/excluded.png", false),
            ],
            &policies,
        )
        .unwrap();
        assert!(!target.path().join("resourcepacks/local").exists());
        let mut zip = zip::ZipArchive::new(
            fs::File::open(target.path().join("resourcepacks/local.zip.off")).unwrap(),
        )
        .unwrap();
        assert!(zip.by_name("pack.mcmeta").is_ok());
        assert!(zip.by_name("assets/keep.png").is_ok());
        assert!(zip.by_name("assets/excluded.png").is_err());
        assert_eq!(
            fs::read(source.path().join("resourcepacks/local/pack.mcmeta")).unwrap(),
            b"metadata"
        );
    }

    #[test]
    fn individual_selection_and_fallback_overrides_take_precedence() {
        let source = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        write(source.path(), "mods/keep.jar", b"keep");
        write(source.path(), "mods/other.jar", b"other");
        copy_files(
            source.path(),
            target.path(),
            &[rule("mods", false), rule("mods/keep.jar", true)],
            &HashMap::new(),
        )
        .unwrap();
        assert!(target.path().join("mods/keep.jar").exists());
        assert!(!target.path().join("mods/other.jar").exists());
        let overrides = vec![VersionMigrationFallbackOverride {
            path: "mods/keep.jar".into(),
            action: VersionMigrationFallbackAction::Copy,
        }];
        assert_eq!(
            fallback_for(
                "mods/keep.jar",
                VersionMigrationFallbackAction::Skip,
                &overrides
            ),
            VersionMigrationFallbackAction::Copy
        );
        assert_eq!(
            fallback_for(
                "mods/other.jar",
                VersionMigrationFallbackAction::Skip,
                &overrides
            ),
            VersionMigrationFallbackAction::Skip
        );
        assert_eq!(
            disabled_path("mods/old.jar.disabled", false),
            "mods/old.jar.off"
        );
        assert_eq!(disabled_path("mods/old.jar.off", false), "mods/old.jar.off");
    }

    #[test]
    fn disabling_never_overwrites_another_selected_file() {
        let source = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        write(source.path(), "mods/same.jar", b"first");
        write(source.path(), "mods/same.jar.off", b"second");
        let policies = HashMap::from([(
            "mods/same.jar".into(),
            (VersionMigrationFallbackAction::Disable, false),
        )]);
        assert!(matches!(
            copy_files(
                source.path(),
                target.path(),
                &[rule("mods", true)],
                &policies
            ),
            Err(AppError::Conflict(_))
        ));
        assert_eq!(
            fs::read(source.path().join("mods/same.jar.off")).unwrap(),
            b"second"
        );
    }

    #[test]
    fn fallback_cannot_remove_files_outside_the_new_content_folders() {
        let root = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        write(external.path(), "outside.jar", b"keep");
        write(root.path(), "options.txt", b"keep");
        assert!(
            remove_generated_content(root.path(), &external.path().join("outside.jar")).is_err()
        );
        assert!(remove_generated_content(root.path(), &root.path().join("options.txt")).is_err());
        assert!(external.path().join("outside.jar").exists());
        assert!(root.path().join("options.txt").exists());
    }
}
