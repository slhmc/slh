use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use crate::host::Host;
use futures_util::{StreamExt, stream};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;
use walkdir::WalkDir;
use zip::write::SimpleFileOptions;

use crate::error::{AppError, AppResult};
use crate::instances;
use crate::minecraft::download::{DownloadPlan, configured_concurrency, download_many};
use crate::models::{
    ArchiveInspection, CreateInstanceRequest, ExportEntry, ExportInstanceRequest, ExportResult,
    ImportFolderRequest, ImportSlhRequest, Instance, ProgressEvent,
};
use crate::security::validate_relative_path;
use crate::state::AppState;

const MAX_ENTRIES: usize = 200_000;
const MAX_UNCOMPRESSED_BYTES: u64 = 16 * 1024 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SlhExportManifest {
    format: String,
    format_version: u32,
    name: String,
    minecraft_version: String,
    loader_type: String,
    loader_version: Option<String>,
    memory_min_mb: i64,
    memory_max_mb: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModrinthPackManifest {
    format_version: u32,
    game: String,
    name: String,
    dependencies: std::collections::HashMap<String, String>,
    #[serde(default)]
    files: Vec<ModrinthPackFile>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModrinthPackFile {
    path: String,
    hashes: std::collections::HashMap<String, String>,
    downloads: Vec<String>,
    file_size: u64,
    env: Option<ModrinthPackEnvironment>,
}

#[derive(Deserialize)]
struct ModrinthPackEnvironment {
    client: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CurseForgePackManifest {
    manifest_type: String,
    manifest_version: u32,
    name: String,
    minecraft: CurseForgeMinecraft,
    #[serde(default)]
    files: Vec<CurseForgePackFile>,
    overrides: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CurseForgeMinecraft {
    version: String,
    #[serde(default)]
    mod_loaders: Vec<CurseForgeModLoader>,
}

#[derive(Deserialize)]
struct CurseForgeModLoader {
    id: String,
    #[serde(default)]
    primary: bool,
}

#[derive(Deserialize)]
struct CurseForgePackFile {
    #[serde(rename = "projectID")]
    project_id: u64,
    #[serde(rename = "fileID")]
    file_id: u64,
    required: bool,
}

struct PreparedModrinthFile {
    relative: PathBuf,
    url: String,
    sha1: String,
    file_size: u64,
}

struct PreparedCurseForgeFile {
    project_id: u64,
    file_id: u64,
    destination_folder: &'static str,
    download: crate::content::curseforge::PackDownload,
}

pub async fn inspect_archive(
    path: &str,
    curseforge_available: bool,
) -> AppResult<ArchiveInspection> {
    let path = PathBuf::from(path);
    tokio::task::spawn_blocking(move || inspect_archive_sync_with_key(&path, curseforge_available))
        .await
        .map_err(|error| AppError::Process(format!("Archive inspection task failed: {error}")))?
}

pub async fn export_instance(
    state: &AppState,
    instance_id: &str,
    request: ExportInstanceRequest,
) -> AppResult<ExportResult> {
    let instance = crate::database::instance(&state.database, instance_id).await?;
    let destination = PathBuf::from(&request.destination);
    if destination.exists() {
        return Err(AppError::Conflict(format!(
            "Export destination already exists: {}",
            destination.display()
        )));
    }
    if instance.loader_type == "bedrock" {
        let instance_root = instances::validated_instance_root(
            &state.paths,
            &instance.folder_name,
            &instance.game_dir,
        )?;
        let roots = crate::bedrock_files::roots(&instance, &instance_root);
        let sources = crate::bedrock_files::export_sources(&roots);
        return tokio::task::spawn_blocking(move || {
            export_bedrock_sync(&sources, &destination, &request)
        })
        .await
        .map_err(|error| AppError::Process(format!("Bedrock export task failed: {error}")))?;
    }
    let game_dir = PathBuf::from(&instance.game_dir);
    tokio::task::spawn_blocking(move || export_sync(&instance, &game_dir, &destination, &request))
        .await
        .map_err(|error| AppError::Process(format!("Export task failed: {error}")))?
}

pub async fn list_export_entries(
    state: &AppState,
    instance_id: &str,
) -> AppResult<Vec<ExportEntry>> {
    let instance = crate::database::instance(&state.database, instance_id).await?;
    if instance.loader_type == "bedrock" {
        let instance_root = instances::validated_instance_root(
            &state.paths,
            &instance.folder_name,
            &instance.game_dir,
        )?;
        let roots = crate::bedrock_files::roots(&instance, &instance_root);
        let sources = crate::bedrock_files::export_sources(&roots);
        return tokio::task::spawn_blocking(move || list_bedrock_export_entries_sync(&sources))
            .await
            .map_err(|error| {
                AppError::Process(format!("Bedrock export indexing task failed: {error}"))
            })?;
    }
    let game_dir = PathBuf::from(instance.game_dir);
    tokio::task::spawn_blocking(move || list_export_entries_sync(&game_dir))
        .await
        .map_err(|error| AppError::Process(format!("Export indexing task failed: {error}")))?
}

fn list_bedrock_export_entries_sync(sources: &[(String, PathBuf)]) -> AppResult<Vec<ExportEntry>> {
    let mut result = Vec::new();
    for (relative_path, source) in sources {
        if !source.is_dir() {
            continue;
        }
        let mut files = 0_u64;
        let mut size_bytes = 0_u64;
        for entry in WalkDir::new(source).follow_links(false) {
            let entry = entry.map_err(|error| AppError::Io(std::io::Error::other(error)))?;
            if entry.file_type().is_symlink() || !entry.file_type().is_file() {
                continue;
            }
            files = files.saturating_add(1);
            size_bytes = size_bytes.saturating_add(
                entry
                    .metadata()
                    .map_err(|error| AppError::Io(std::io::Error::other(error)))?
                    .len(),
            );
        }
        result.push(ExportEntry {
            relative_path: relative_path.clone(),
            is_directory: true,
            files,
            size_bytes,
        });
    }
    result.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(result)
}

fn export_bedrock_sync(
    sources: &[(String, PathBuf)],
    destination: &Path,
    request: &ExportInstanceRequest,
) -> AppResult<ExportResult> {
    if request.format != "zip" {
        return Err(AppError::InvalidInput(
            "Bedrock instances can be exported as ZIP archives".into(),
        ));
    }
    if request.entries.is_empty() {
        return Err(AppError::InvalidInput(
            "Select at least one Bedrock folder to export".into(),
        ));
    }
    let selected = request
        .entries
        .iter()
        .cloned()
        .collect::<std::collections::HashSet<_>>();
    for entry in &selected {
        validate_relative_path(Path::new(entry))?;
        if !sources
            .iter()
            .any(|(relative, source)| relative == entry && source.is_dir())
        {
            return Err(AppError::Security(
                "Bedrock export selection is not a known game-data folder".into(),
            ));
        }
    }

    let parent = destination
        .parent()
        .ok_or_else(|| AppError::InvalidInput("Export destination has no parent".into()))?;
    std::fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".slh-bedrock-export-{}.tmp", Uuid::new_v4()));
    let file = File::create(&temporary)?;
    let mut zip = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o600);
    let mut files_written = 0_u64;
    for (relative, source) in sources {
        if !selected.contains(relative) {
            continue;
        }
        for entry in WalkDir::new(source).follow_links(false) {
            let entry = entry.map_err(|error| AppError::Io(std::io::Error::other(error)))?;
            if entry.file_type().is_symlink() || !entry.file_type().is_file() {
                continue;
            }
            let tail = entry.path().strip_prefix(source).map_err(|_| {
                AppError::Security("Bedrock export path escaped its content folder".into())
            })?;
            let archive_path = if tail.as_os_str().is_empty() {
                relative.clone()
            } else {
                format!("{}/{}", relative, tail.to_string_lossy().replace('\\', "/"))
            };
            zip.start_file(archive_path, options)?;
            let mut input = File::open(entry.path())?;
            std::io::copy(&mut input, &mut zip)?;
            files_written = files_written.saturating_add(1);
        }
    }
    zip.finish()?.sync_all()?;
    std::fs::rename(&temporary, destination)?;
    Ok(ExportResult {
        path: destination.to_string_lossy().into_owned(),
        files_written,
        size_bytes: std::fs::metadata(destination)?.len(),
    })
}

pub async fn import_slh(state: &AppState, request: ImportSlhRequest) -> AppResult<Instance> {
    let archive_path = PathBuf::from(&request.archive_path);
    let inspection = inspect_archive(&request.archive_path, true).await?;
    if inspection.archive_type != "slh" || !inspection.can_import {
        return Err(AppError::InvalidInput(inspection.message));
    }
    let staging = tempfile::Builder::new()
        .prefix("slh-import-")
        .tempdir_in(&state.paths.downloads)?;
    let staging_path = staging.path().to_path_buf();
    let source = archive_path.clone();
    tokio::task::spawn_blocking(move || safe_extract(&source, &staging_path))
        .await
        .map_err(|error| AppError::Process(format!("Archive extraction task failed: {error}")))??;
    let manifest: SlhExportManifest =
        serde_json::from_slice(&tokio::fs::read(staging.path().join("slh-export.json")).await?)?;
    let created = instances::create_instance(
        &state.database,
        &state.paths,
        CreateInstanceRequest {
            name: request.name.unwrap_or(manifest.name),
            group_id: None,
            minecraft_version: manifest.minecraft_version,
            loader_type: manifest.loader_type,
            loader_version: manifest.loader_version,
            java_path: None,
            memory_min_mb: manifest.memory_min_mb,
            memory_max_mb: manifest.memory_max_mb,
            icon_key: None,
            icon_background: None,
            icon_foreground: None,
            bedrock_profile_mode: None,
        },
    )
    .await?;
    let source_game = staging.path().join("game");
    let target_game = PathBuf::from(&created.game_dir);
    let copy_result = tokio::task::spawn_blocking(move || copy_tree(&source_game, &target_game))
        .await
        .map_err(|error| AppError::Process(format!("Import copy task failed: {error}")))?;
    if let Err(error) = copy_result {
        let _ = sqlx::query("DELETE FROM instances WHERE id = ?")
            .bind(&created.id)
            .execute(&state.database)
            .await;
        let instance_root = PathBuf::from(&created.game_dir)
            .parent()
            .map(Path::to_path_buf);
        if let Some(instance_root) = instance_root {
            let _ = tokio::fs::remove_dir_all(instance_root).await;
        }
        return Err(error);
    }
    Ok(created)
}

pub async fn import_folder(
    app: &Host,
    state: &AppState,
    request: ImportFolderRequest,
) -> AppResult<Instance> {
    let source = PathBuf::from(&request.source_path);
    if !source.is_dir() {
        return Err(AppError::InvalidInput(format!(
            "Import source is not a directory: {}",
            source.display()
        )));
    }
    let canonical_source = source.canonicalize()?;
    let canonical_portable_root = state.paths.root.canonicalize()?;
    if canonical_portable_root.starts_with(&canonical_source) {
        return Err(AppError::InvalidInput(
            "Select the Minecraft game directory, not the SLH portable root or one of its parent directories".into(),
        ));
    }
    let (metadata_root, game_root) = resolve_existing_folder_layout(&canonical_source);
    let detected = tokio::task::spawn_blocking({
        let source = metadata_root.clone();
        move || infer_existing_folder_metadata(&source)
    })
    .await
    .map_err(|error| AppError::Process(format!("Folder metadata scan failed: {error}")))?;
    let created = instances::create_instance(
        &state.database,
        &state.paths,
        CreateInstanceRequest {
            name: detected.name,
            group_id: None,
            minecraft_version: detected.minecraft_version,
            loader_type: detected.loader_type,
            loader_version: detected.loader_version,
            java_path: None,
            memory_min_mb: 512,
            memory_max_mb: 4096,
            icon_key: None,
            icon_background: None,
            icon_foreground: None,
            bedrock_profile_mode: None,
        },
    )
    .await?;
    let claimed = sqlx::query(
        "UPDATE instances SET status = 'installing' WHERE id = ? AND status = 'created'",
    )
    .bind(&created.id)
    .execute(&state.database)
    .await?
    .rows_affected();
    if claimed != 1 {
        return Err(AppError::Conflict(
            "This instance is already being installed by another operation".into(),
        ));
    }
    let operation_id = Uuid::new_v4().to_string();
    let _ = app.emit(
        crate::host::EventKind::OperationProgress,
        ProgressEvent {
            operation_id: operation_id.clone(),
            instance_id: Some(created.id.clone()),
            operation: "import".into(),
            stage: "folder-scan".into(),
            message: "Validating existing Minecraft folder".into(),
            completed: 0,
            total: None,
            downloaded_bytes: None,
            total_bytes: None,
        },
    );
    let staging = tempfile::Builder::new()
        .prefix("slh-folder-import-")
        .tempdir_in(&state.paths.downloads)?;
    let source_for_copy = game_root;
    let staging_path = staging.path().to_path_buf();
    let staging_result = tokio::task::spawn_blocking(move || {
        stage_minecraft_folder(&source_for_copy, &staging_path)
    })
    .await
    .map_err(|error| AppError::Process(format!("Folder import task failed: {error}")))?;
    let (files, bytes) = match staging_result {
        Ok(result) => result,
        Err(error) => {
            cleanup_created_instance(state, &created).await;
            return Err(error);
        }
    };
    let _ = app.emit(
        crate::host::EventKind::OperationProgress,
        ProgressEvent {
            operation_id: operation_id.clone(),
            instance_id: Some(created.id.clone()),
            operation: "import".into(),
            stage: "folder-copy".into(),
            message: format!("Validated {files} files"),
            completed: files,
            total: Some(files),
            downloaded_bytes: Some(bytes),
            total_bytes: Some(bytes),
        },
    );
    let staged = staging.path().to_path_buf();
    let target = PathBuf::from(&created.game_dir);
    let copy_result = tokio::task::spawn_blocking(move || copy_tree(&staged, &target))
        .await
        .map_err(|error| AppError::Process(format!("Folder commit task failed: {error}")))?;
    if let Err(error) = copy_result {
        cleanup_created_instance(state, &created).await;
        return Err(error);
    }
    sqlx::query("UPDATE instances SET status = 'created' WHERE id = ?")
        .bind(&created.id)
        .execute(&state.database)
        .await?;
    let _ = app.emit(
        crate::host::EventKind::OperationProgress,
        ProgressEvent {
            operation_id,
            instance_id: Some(created.id.clone()),
            operation: "import".into(),
            stage: "complete".into(),
            message: "Existing folder imported; install will restore runtime files".into(),
            completed: files,
            total: Some(files),
            downloaded_bytes: Some(bytes),
            total_bytes: Some(bytes),
        },
    );
    Ok(created)
}

struct ExistingFolderMetadata {
    name: String,
    minecraft_version: String,
    loader_type: String,
    loader_version: Option<String>,
}

#[derive(Deserialize)]
struct PrismPackMetadata {
    #[serde(default)]
    components: Vec<PrismPackComponent>,
}

#[derive(Deserialize)]
struct PrismPackComponent {
    uid: String,
    version: Option<String>,
}

fn resolve_existing_folder_layout(source: &Path) -> (PathBuf, PathBuf) {
    let nested_game = source.join("minecraft");
    if nested_game.is_dir()
        && (source.join("instance.cfg").is_file()
            || source.join("mmc-pack.json").is_file()
            || has_minecraft_game_data(&nested_game))
    {
        return (source.to_path_buf(), nested_game);
    }

    if source
        .file_name()
        .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("minecraft"))
    {
        if let Some(parent) = source.parent() {
            if parent.join("instance.cfg").is_file() || parent.join("mmc-pack.json").is_file() {
                return (parent.to_path_buf(), source.to_path_buf());
            }
        }
    }
    (source.to_path_buf(), source.to_path_buf())
}

fn has_minecraft_game_data(path: &Path) -> bool {
    [
        "mods",
        "config",
        "saves",
        "resourcepacks",
        "shaderpacks",
        "options.txt",
    ]
    .iter()
    .any(|entry| path.join(entry).exists())
}

fn instance_cfg_name(source: &Path) -> Option<String> {
    let text = std::fs::read_to_string(source.join("instance.cfg")).ok()?;
    text.lines()
        .find_map(|line| line.strip_prefix("name="))
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(|name| name.chars().take(80).collect())
}

fn apply_prism_pack_metadata(source: &Path, result: &mut ExistingFolderMetadata) {
    let Ok(bytes) = std::fs::read(source.join("mmc-pack.json")) else {
        return;
    };
    let Ok(pack) = serde_json::from_slice::<PrismPackMetadata>(&bytes) else {
        return;
    };
    for component in pack.components {
        let version = component.version.filter(|value| !value.trim().is_empty());
        match component.uid.as_str() {
            "net.minecraft" => {
                if let Some(version) = version {
                    result.minecraft_version = version;
                }
            }
            "net.fabricmc.fabric-loader" => {
                result.loader_type = "fabric".into();
                result.loader_version = version;
            }
            "net.minecraftforge" => {
                result.loader_type = "forge".into();
                result.loader_version = version;
            }
            "net.neoforged" | "net.neoforged.neoforge" => {
                result.loader_type = "neoforge".into();
                result.loader_version = version;
            }
            "org.quiltmc.quilt-loader" => {
                result.loader_type = "quilt".into();
                result.loader_version = version;
            }
            _ => {}
        }
    }
}

fn infer_existing_folder_metadata(source: &Path) -> ExistingFolderMetadata {
    let fallback_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(80).collect())
        .unwrap_or_else(|| "Imported instance".into());
    let mut result = ExistingFolderMetadata {
        name: fallback_name,
        minecraft_version: "unknown".into(),
        loader_type: "vanilla".into(),
        loader_version: None,
    };
    if let Some(name) = instance_cfg_name(source) {
        result.name = name;
    }
    apply_prism_pack_metadata(source, &mut result);

    let mut candidates = vec![
        source.join("version.json"),
        source.join("minecraft/version.json"),
    ];
    for root in [source.to_path_buf(), source.join("minecraft")] {
        if !root.is_dir() {
            continue;
        }
        for entry in WalkDir::new(&root)
            .min_depth(1)
            .max_depth(2)
            .into_iter()
            .flatten()
        {
            let path = entry.path();
            if path.is_file()
                && path
                    .extension()
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("json"))
            {
                candidates.push(path.to_path_buf());
            }
        }
    }
    for candidate in candidates.into_iter().take(64) {
        let Ok(metadata) = std::fs::metadata(&candidate) else {
            continue;
        };
        if metadata.len() == 0 || metadata.len() > 2 * 1024 * 1024 {
            continue;
        }
        let Ok(bytes) = std::fs::read(&candidate) else {
            continue;
        };
        let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
            continue;
        };
        let id = value.get("id").and_then(Value::as_str).unwrap_or_default();
        let inherits = value
            .get("inheritsFrom")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty());
        let (loader_type, loader_version, version_from_id) = infer_loader_from_version_id(id);
        let minecraft_version = inherits
            .map(str::to_owned)
            .or(version_from_id)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| id.to_owned());
        if minecraft_version.is_empty() {
            continue;
        }
        if result.minecraft_version == "unknown" || loader_type != "vanilla" {
            result.minecraft_version = minecraft_version;
        }
        if loader_type != "vanilla" || result.loader_type == "vanilla" {
            result.loader_type = loader_type;
            result.loader_version = loader_version;
        }
        if result.loader_type != "vanilla" || inherits.is_none() {
            break;
        }
    }
    result
}

fn infer_loader_from_version_id(id: &str) -> (String, Option<String>, Option<String>) {
    if let Some(rest) = id.strip_prefix("fabric-loader-") {
        if let Some((loader, minecraft)) = rest.split_once('-') {
            return ("fabric".into(), Some(loader.into()), Some(minecraft.into()));
        }
    }
    if let Some(rest) = id.strip_prefix("quilt-loader-") {
        if let Some((loader, minecraft)) = rest.split_once('-') {
            return ("quilt".into(), Some(loader.into()), Some(minecraft.into()));
        }
    }
    if let Some(rest) = id.strip_prefix("neoforge-") {
        if let Some((minecraft, loader)) = rest.split_once('-') {
            return (
                "neoforge".into(),
                Some(loader.into()),
                Some(minecraft.into()),
            );
        }
    }
    if let Some((minecraft, loader)) = id.split_once("-forge-") {
        return ("forge".into(), Some(loader.into()), Some(minecraft.into()));
    }
    (
        "vanilla".into(),
        None,
        Some(id.to_owned()).filter(|value| {
            value
                .chars()
                .next()
                .is_some_and(|character| character.is_ascii_digit())
        }),
    )
}

async fn cleanup_created_instance(state: &AppState, instance: &Instance) {
    let _ = sqlx::query("DELETE FROM instances WHERE id = ?")
        .bind(&instance.id)
        .execute(&state.database)
        .await;
    if let Some(instance_root) = PathBuf::from(&instance.game_dir).parent() {
        let _ = tokio::fs::remove_dir_all(instance_root).await;
    }
}

pub async fn import_modrinth_pack(
    app: &Host,
    state: &AppState,
    request: ImportSlhRequest,
) -> AppResult<Instance> {
    let archive_path = PathBuf::from(&request.archive_path);
    let source_for_manifest = archive_path.clone();
    let manifest = tokio::task::spawn_blocking(move || -> AppResult<ModrinthPackManifest> {
        let file = File::open(source_for_manifest)?;
        let mut archive = zip::ZipArchive::new(file)?;
        validate_archive(&mut archive)?;
        let value = read_json_entry(&mut archive, "modrinth.index.json")?
            .ok_or_else(|| AppError::InvalidInput("Archive has no modrinth.index.json".into()))?;
        Ok(serde_json::from_value(value)?)
    })
    .await
    .map_err(|error| AppError::Process(format!("Modrinth manifest task failed: {error}")))??;
    if manifest.format_version != 1 || manifest.game != "minecraft" {
        return Err(AppError::InvalidInput(
            "Only Modrinth Minecraft pack format version 1 is supported".into(),
        ));
    }
    let minecraft_version = manifest
        .dependencies
        .get("minecraft")
        .cloned()
        .ok_or_else(|| AppError::InvalidInput("Modrinth pack has no Minecraft version".into()))?;
    let loaders = [
        ("fabric-loader", "fabric"),
        ("quilt-loader", "quilt"),
        ("forge", "forge"),
        ("neoforge", "neoforge"),
    ]
    .into_iter()
    .filter_map(|(key, loader_type)| {
        manifest
            .dependencies
            .get(key)
            .map(|version| (loader_type, version.clone()))
    })
    .collect::<Vec<_>>();
    if loaders.len() > 1 {
        return Err(AppError::Conflict(
            "Modrinth pack declares more than one mod loader".into(),
        ));
    }
    let (loader_type, loader_version) = loaders
        .into_iter()
        .next()
        .map_or(("vanilla", None), |(kind, version)| (kind, Some(version)));
    let mut destinations = std::collections::HashSet::new();
    let downloadable = manifest
        .files
        .into_iter()
        .filter(|file| {
            file.env.as_ref().and_then(|env| env.client.as_deref()) != Some("unsupported")
        })
        .map(|file| {
            let relative = PathBuf::from(&file.path);
            validate_relative_path(&relative)?;
            let key = relative
                .to_string_lossy()
                .replace('\\', "/")
                .to_ascii_lowercase();
            if !destinations.insert(key) {
                return Err(AppError::Conflict(format!(
                    "Modrinth pack repeats destination {}",
                    relative.display()
                )));
            }
            let url = file
                .downloads
                .into_iter()
                .find(|url| url.starts_with("https://"))
                .ok_or_else(|| {
                    AppError::Security(format!(
                        "Modrinth pack file {} has no HTTPS download",
                        relative.display()
                    ))
                })?;
            let sha1 = file.hashes.get("sha1").cloned().ok_or_else(|| {
                AppError::Security(format!(
                    "Modrinth pack file {} has no SHA-1 hash",
                    relative.display()
                ))
            })?;
            Ok(PreparedModrinthFile {
                relative,
                url,
                sha1,
                file_size: file.file_size,
            })
        })
        .collect::<AppResult<Vec<_>>>()?;
    let total_size = downloadable
        .iter()
        .map(|file| file.file_size)
        .try_fold(0_u64, u64::checked_add)
        .ok_or_else(|| AppError::Security("Modrinth pack size overflowed".into()))?;
    if total_size > MAX_UNCOMPRESSED_BYTES {
        return Err(AppError::Security(
            "Modrinth pack downloads exceed the 16 GiB safety limit".into(),
        ));
    }
    let created = instances::create_instance(
        &state.database,
        &state.paths,
        CreateInstanceRequest {
            name: request.name.unwrap_or(manifest.name),
            group_id: None,
            minecraft_version,
            loader_type: loader_type.into(),
            loader_version,
            java_path: None,
            memory_min_mb: 512,
            memory_max_mb: 4096,
            icon_key: None,
            icon_background: None,
            icon_foreground: None,
            bedrock_profile_mode: None,
        },
    )
    .await?;
    // Claim the newly-created instance for the complete import+installation
    // operation so its side panel cannot offer a second Install action while
    // pack files are still downloading.
    let claimed = sqlx::query(
        "UPDATE instances SET status = 'installing' WHERE id = ? AND status = 'created'",
    )
    .bind(&created.id)
    .execute(&state.database)
    .await?
    .rows_affected();
    if claimed != 1 {
        return Err(AppError::Conflict(
            "This instance is already being installed by another operation".into(),
        ));
    }
    let operation_id = Uuid::new_v4().to_string();
    let game_dir = PathBuf::from(&created.game_dir);
    let total_files = downloadable.len() as u64;
    let result = async {
        let source_for_overrides = archive_path.clone();
        let game_for_overrides = game_dir.clone();
        tokio::task::spawn_blocking(move || {
            extract_override_prefixes(&source_for_overrides, &game_for_overrides)
        })
        .await
        .map_err(|error| AppError::Process(format!("Pack overrides task failed: {error}")))??;
        let plans = downloadable
            .iter()
            .map(|file| DownloadPlan {
                url: file.url.clone(),
                destination: game_dir.join(&file.relative),
                sha1: Some(file.sha1.clone()),
                max_bytes: None,
            })
            .collect::<Vec<_>>();
        let relative_names = downloadable
            .iter()
            .map(|file| file.relative.display().to_string())
            .collect::<Vec<_>>();
        let install_app = app.clone();
        let progress_app = install_app.clone();
        let operation_id_for_progress = operation_id.clone();
        let instance_id_for_progress = created.id.clone();
        let mut completed = 0_u64;
        let mut downloaded_bytes = 0_u64;
        let concurrency = configured_concurrency(&state.database).await;
        download_many(&state.http, plans, concurrency, move |index, bytes| {
            completed += 1;
            downloaded_bytes = downloaded_bytes.saturating_add(bytes);
            let _ = progress_app.emit(
                crate::host::EventKind::OperationProgress,
                ProgressEvent {
                    operation_id: operation_id_for_progress.clone(),
                    instance_id: Some(instance_id_for_progress.clone()),
                    operation: "import".into(),
                    stage: "pack-files".into(),
                    message: format!("Importing {}", relative_names[index]),
                    completed,
                    total: Some(total_files),
                    downloaded_bytes: Some(downloaded_bytes),
                    total_bytes: Some(total_size),
                },
            );
        })
        .await?;
        crate::minecraft::installer::install_instance_claimed(&install_app, state, &created.id)
            .await
    }
    .await;
    if result.is_ok() {
        let _ = app.emit(
            crate::host::EventKind::OperationProgress,
            ProgressEvent {
                operation_id: operation_id.clone(),
                instance_id: Some(created.id.clone()),
                operation: "import".into(),
                stage: "complete".into(),
                message: "Modpack import complete".into(),
                completed: total_files,
                total: Some(total_files),
                downloaded_bytes: Some(total_size),
                total_bytes: Some(total_size),
            },
        );
    }
    if let Err(error) = &result {
        let _ = app.emit(
            crate::host::EventKind::OperationProgress,
            ProgressEvent {
                operation_id: operation_id.clone(),
                instance_id: Some(created.id.clone()),
                operation: "import".into(),
                stage: "failed".into(),
                message: error.to_string(),
                completed: 0,
                total: Some(total_files),
                downloaded_bytes: None,
                total_bytes: Some(total_size),
            },
        );
        let _ = sqlx::query("UPDATE instances SET status = 'error' WHERE id = ?")
            .bind(&created.id)
            .execute(&state.database)
            .await;
    }
    result
}

pub async fn import_curseforge_pack(
    app: &Host,
    state: &AppState,
    request: ImportSlhRequest,
) -> AppResult<Instance> {
    let archive_path = PathBuf::from(&request.archive_path);
    let source_for_manifest = archive_path.clone();
    let manifest = tokio::task::spawn_blocking(move || -> AppResult<CurseForgePackManifest> {
        let file = File::open(source_for_manifest)?;
        let mut archive = zip::ZipArchive::new(file)?;
        validate_archive(&mut archive)?;
        let value = read_json_entry(&mut archive, "manifest.json")?
            .ok_or_else(|| AppError::InvalidInput("Archive has no manifest.json".into()))?;
        Ok(serde_json::from_value(value)?)
    })
    .await
    .map_err(|error| AppError::Process(format!("CurseForge manifest task failed: {error}")))??;
    if manifest.manifest_type != "minecraftModpack" || manifest.manifest_version != 1 {
        return Err(AppError::InvalidInput(
            "Only CurseForge Minecraft modpack manifest version 1 is supported".into(),
        ));
    }
    if manifest.files.len() > MAX_ENTRIES {
        return Err(AppError::Security(
            "CurseForge manifest contains too many files".into(),
        ));
    }
    let (loader_type, loader_version) = curseforge_loader(&manifest.minecraft.mod_loaders)?;
    let overrides = PathBuf::from(manifest.overrides.trim_matches(['/', '\\']));
    validate_relative_path(&overrides)?;
    let mut prepared = Vec::new();
    let mut project_ids = std::collections::HashSet::new();
    let mut destinations = std::collections::HashSet::new();
    let mut total_size = 0_u64;
    let required_files = manifest
        .files
        .iter()
        .filter(|file| file.required)
        .map(|file| (file.project_id, file.file_id))
        .collect::<Vec<_>>();
    // Resolving a CurseForge pack entry normally needs several API calls. Do
    // those lookups concurrently; the download URL and SHA-1 are still
    // validated before anything is written to the instance.
    let metadata_concurrency = configured_concurrency(&state.database).await.min(8);
    let mut metadata = stream::iter(required_files.into_iter().map(
        |(project_id, file_id)| async move {
            let download =
                crate::content::curseforge::pack_download(state, project_id, file_id).await;
            (project_id, file_id, download)
        },
    ))
    .buffer_unordered(metadata_concurrency);
    while let Some((project_id, file_id, download)) = metadata.next().await {
        let download = download?;
        if !project_ids.insert(project_id) {
            return Err(AppError::Conflict(format!(
                "CurseForge pack repeats project {}",
                project_id
            )));
        }
        let destination_folder = match download.project_type.as_str() {
            "mod" => "mods",
            "resourcepack" => "resourcepacks",
            "shader" => "shaderpacks",
            kind => {
                return Err(AppError::Unavailable(format!(
                    "CurseForge pack requires unsupported {kind} project {}",
                    download.display_name
                )));
            }
        };
        let destination_key = format!(
            "{destination_folder}/{}",
            download.file_name.to_ascii_lowercase()
        );
        if !destinations.insert(destination_key) {
            return Err(AppError::Conflict(format!(
                "CurseForge pack repeats destination {}/{}",
                destination_folder, download.file_name
            )));
        }
        total_size = total_size
            .checked_add(download.size_bytes)
            .ok_or_else(|| AppError::Security("CurseForge pack size overflowed".into()))?;
        if total_size > MAX_UNCOMPRESSED_BYTES {
            return Err(AppError::Security(
                "CurseForge pack downloads exceed the 16 GiB safety limit".into(),
            ));
        }
        prepared.push(PreparedCurseForgeFile {
            project_id,
            file_id,
            destination_folder,
            download,
        });
    }
    let created = instances::create_instance(
        &state.database,
        &state.paths,
        CreateInstanceRequest {
            name: request.name.unwrap_or(manifest.name),
            group_id: None,
            minecraft_version: manifest.minecraft.version,
            loader_type: loader_type.into(),
            loader_version,
            java_path: None,
            memory_min_mb: 512,
            memory_max_mb: 4096,
            icon_key: None,
            icon_background: None,
            icon_foreground: None,
            bedrock_profile_mode: None,
        },
    )
    .await?;
    // Keep the newly-created instance busy for the entire pack import. The
    // public installer command uses an atomic claim as well, so a stale UI
    // cannot launch a duplicate installation in parallel.
    sqlx::query("UPDATE instances SET status = 'installing' WHERE id = ?")
        .bind(&created.id)
        .execute(&state.database)
        .await?;
    let operation_id = Uuid::new_v4().to_string();
    let game_dir = PathBuf::from(&created.game_dir);
    let total_files = prepared.len() as u64;
    let result = async {
        let source_for_overrides = archive_path.clone();
        let game_for_overrides = game_dir.clone();
        let override_prefix = overrides.clone();
        tokio::task::spawn_blocking(move || {
            extract_override_prefix(&source_for_overrides, &game_for_overrides, &override_prefix)
        })
        .await
        .map_err(|error| AppError::Process(format!("Pack overrides task failed: {error}")))??;
        let mut plans = Vec::with_capacity(prepared.len());
        let mut destinations = Vec::with_capacity(prepared.len());
        let mut download_ids = Vec::with_capacity(prepared.len());
        for file in &prepared {
            let destination = game_dir
                .join(file.destination_folder)
                .join(&file.download.file_name);
            let download_id = Uuid::new_v4().to_string();
            sqlx::query(
                "INSERT INTO downloads(id, source, url, destination, status, total_bytes) \
                 VALUES (?, 'curseforge', ?, ?, 'running', ?)",
            )
            .bind(&download_id)
            .bind(&file.download.url)
            .bind(destination.to_string_lossy().into_owned())
            .bind(file.download.size_bytes as i64)
            .execute(&state.database)
            .await?;
            plans.push(DownloadPlan {
                url: file.download.url.clone(),
                destination: destination.clone(),
                sha1: Some(file.download.sha1.clone()),
                max_bytes: None,
            });
            destinations.push(destination);
            download_ids.push(download_id);
        }
        let display_names = prepared
            .iter()
            .map(|file| file.download.display_name.clone())
            .collect::<Vec<_>>();
        let progress_app = app.clone();
        let progress_operation = operation_id.clone();
        let progress_instance = created.id.clone();
        let mut completed = 0_u64;
        let mut downloaded_bytes = 0_u64;
        let concurrency = configured_concurrency(&state.database).await;
        let downloaded = download_many(&state.http, plans, concurrency, move |index, bytes| {
            completed += 1;
            downloaded_bytes = downloaded_bytes.saturating_add(bytes);
            let _ = progress_app.emit(
                crate::host::EventKind::OperationProgress,
                ProgressEvent {
                    operation_id: progress_operation.clone(),
                    instance_id: Some(progress_instance.clone()),
                    operation: "import".into(),
                    stage: "pack-files".into(),
                    message: format!("Importing {}", display_names[index]),
                    completed,
                    total: Some(total_files),
                    downloaded_bytes: Some(downloaded_bytes),
                    total_bytes: Some(total_size),
                },
            );
        })
        .await;
        let bytes_by_index = match downloaded {
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
        };
        for (index, file) in prepared.iter().enumerate() {
            sqlx::query(
                "UPDATE downloads SET status = 'complete', downloaded_bytes = ?, \
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
            )
            .bind(bytes_by_index[index] as i64)
            .bind(&download_ids[index])
            .execute(&state.database)
            .await?;
            sqlx::query(
                "INSERT INTO installed_content(instance_id, provider, project_id, version_id, \
                 project_type, display_name, file_path, file_sha1) \
                 VALUES (?, 'curseforge', ?, ?, ?, ?, ?, ?) \
                 ON CONFLICT(instance_id, provider, project_id) DO UPDATE SET \
                 version_id = excluded.version_id, project_type = excluded.project_type, \
                 display_name = excluded.display_name, file_path = excluded.file_path, \
                 file_sha1 = excluded.file_sha1",
            )
            .bind(&created.id)
            .bind(file.project_id.to_string())
            .bind(file.file_id.to_string())
            .bind(&file.download.project_type)
            .bind(&file.download.display_name)
            .bind(destinations[index].to_string_lossy().into_owned())
            .bind(&file.download.sha1)
            .execute(&state.database)
            .await?;
        }
        crate::minecraft::installer::install_instance_claimed(app, state, &created.id).await
    }
    .await;
    if result.is_ok() {
        let _ = app.emit(
            crate::host::EventKind::OperationProgress,
            ProgressEvent {
                operation_id: operation_id.clone(),
                instance_id: Some(created.id.clone()),
                operation: "import".into(),
                stage: "complete".into(),
                message: "Modpack import complete".into(),
                completed: total_files,
                total: Some(total_files),
                downloaded_bytes: Some(total_size),
                total_bytes: Some(total_size),
            },
        );
    }
    if let Err(error) = &result {
        let _ = app.emit(
            crate::host::EventKind::OperationProgress,
            ProgressEvent {
                operation_id: operation_id.clone(),
                instance_id: Some(created.id.clone()),
                operation: "import".into(),
                stage: "failed".into(),
                message: error.to_string(),
                completed: 0,
                total: Some(total_files),
                downloaded_bytes: None,
                total_bytes: Some(total_size),
            },
        );
        let _ = sqlx::query("UPDATE instances SET status = 'error' WHERE id = ?")
            .bind(&created.id)
            .execute(&state.database)
            .await;
    }
    result
}

fn curseforge_loader(loaders: &[CurseForgeModLoader]) -> AppResult<(&'static str, Option<String>)> {
    let Some(loader) = loaders
        .iter()
        .find(|loader| loader.primary)
        .or_else(|| loaders.first())
    else {
        return Ok(("vanilla", None));
    };
    for (prefix, loader_type) in [
        ("fabric-", "fabric"),
        ("forge-", "forge"),
        ("neoforge-", "neoforge"),
        ("quilt-", "quilt"),
    ] {
        if let Some(version) = loader.id.strip_prefix(prefix) {
            if version.is_empty() {
                break;
            }
            return Ok((loader_type, Some(version.to_owned())));
        }
    }
    Err(AppError::Unavailable(format!(
        "Unsupported CurseForge mod loader {}",
        loader.id
    )))
}

#[cfg(test)]
fn inspect_archive_sync(path: &Path) -> AppResult<ArchiveInspection> {
    inspect_archive_sync_with_key(
        path,
        crate::content::curseforge::environment_api_key().is_some(),
    )
}

fn inspect_archive_sync_with_key(
    path: &Path,
    curseforge_available: bool,
) -> AppResult<ArchiveInspection> {
    let file = File::open(path)?;
    let mut archive = zip::ZipArchive::new(file)?;
    validate_archive(&mut archive)?;
    if let Some(value) = read_json_entry(&mut archive, "slh-export.json")? {
        let manifest: SlhExportManifest = serde_json::from_value(value)?;
        if manifest.format != "slh-instance" || manifest.format_version != 1 {
            return Err(AppError::InvalidInput(
                "Unsupported SLH export format version".into(),
            ));
        }
        return Ok(ArchiveInspection {
            archive_type: "slh".into(),
            name: Some(manifest.name),
            minecraft_version: Some(manifest.minecraft_version),
            loader_type: Some(manifest.loader_type),
            loader_version: manifest.loader_version,
            can_import: true,
            message: "SLH instance export is ready to import".into(),
        });
    }
    if let Some(value) = read_json_entry(&mut archive, "modrinth.index.json")? {
        let dependencies = value.get("dependencies").and_then(Value::as_object);
        let minecraft = dependencies
            .and_then(|items| items.get("minecraft"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let (loader_type, loader_version) = dependencies
            .and_then(|items| {
                ["fabric-loader", "quilt-loader", "forge", "neoforge"]
                    .into_iter()
                    .find_map(|key| {
                        items
                            .get(key)
                            .and_then(Value::as_str)
                            .map(|value| (key, value))
                    })
            })
            .map_or((None, None), |(kind, version)| {
                (
                    Some(kind.trim_end_matches("-loader").into()),
                    Some(version.into()),
                )
            });
        return Ok(ArchiveInspection {
            archive_type: "modrinth".into(),
            name: value.get("name").and_then(Value::as_str).map(str::to_owned),
            minecraft_version: minecraft,
            loader_type,
            loader_version,
            can_import: true,
            message: "Modrinth pack manifest is valid and ready to import".into(),
        });
    }
    if let Some(value) = read_json_entry(&mut archive, "manifest.json")? {
        let minecraft = value
            .pointer("/minecraft/version")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let (loader_type, loader_version) = value
            .pointer("/minecraft/modLoaders")
            .and_then(Value::as_array)
            .and_then(|loaders| {
                loaders
                    .iter()
                    .find(|loader| loader.get("primary").and_then(Value::as_bool) == Some(true))
                    .or_else(|| loaders.first())
            })
            .and_then(|loader| loader.get("id").and_then(Value::as_str))
            .and_then(|id| {
                ["fabric", "forge", "neoforge", "quilt"]
                    .into_iter()
                    .find_map(|kind| {
                        id.strip_prefix(&format!("{kind}-"))
                            .map(|version| (kind.to_owned(), version.to_owned()))
                    })
            })
            .map_or((None, None), |(kind, version)| (Some(kind), Some(version)));
        let can_import = curseforge_available;
        return Ok(ArchiveInspection {
            archive_type: "curseforge".into(),
            name: value.get("name").and_then(Value::as_str).map(str::to_owned),
            minecraft_version: minecraft,
            loader_type,
            loader_version,
            can_import,
            message: if can_import {
                "CurseForge pack manifest is valid and ready to import".into()
            } else {
                "CurseForge archive is valid; resolving project file IDs requires a configured API key".into()
            },
        });
    }
    Ok(ArchiveInspection {
        archive_type: "unknown".into(),
        name: None,
        minecraft_version: None,
        loader_type: None,
        loader_version: None,
        can_import: false,
        message: "No supported pack manifest was found".into(),
    })
}

fn validate_archive(archive: &mut zip::ZipArchive<File>) -> AppResult<()> {
    if archive.len() > MAX_ENTRIES {
        return Err(AppError::Security(
            "Archive contains too many entries".into(),
        ));
    }
    let mut total = 0_u64;
    for index in 0..archive.len() {
        let entry = archive.by_index(index)?;
        if entry.enclosed_name().is_none() {
            return Err(AppError::Security(format!(
                "Archive contains an unsafe path: {}",
                entry.name()
            )));
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(AppError::Security(format!(
                "Archive contains a symbolic link: {}",
                entry.name()
            )));
        }
        total = total.saturating_add(entry.size());
        if total > MAX_UNCOMPRESSED_BYTES {
            return Err(AppError::Security(
                "Archive expands beyond the 16 GiB safety limit".into(),
            ));
        }
    }
    Ok(())
}

fn read_json_entry(archive: &mut zip::ZipArchive<File>, name: &str) -> AppResult<Option<Value>> {
    let Ok(mut entry) = archive.by_name(name) else {
        return Ok(None);
    };
    if entry.size() > 8 * 1024 * 1024 {
        return Err(AppError::Security(format!("Manifest {name} is too large")));
    }
    let mut bytes = Vec::with_capacity(entry.size() as usize);
    entry.read_to_end(&mut bytes)?;
    Ok(Some(serde_json::from_slice(&bytes)?))
}

pub(crate) fn safe_extract(source: &Path, destination: &Path) -> AppResult<()> {
    let file = File::open(source)?;
    let mut archive = zip::ZipArchive::new(file)?;
    validate_archive(&mut archive)?;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        let relative = entry
            .enclosed_name()
            .ok_or_else(|| AppError::Security(format!("Unsafe archive path: {}", entry.name())))?;
        let target = destination.join(relative);
        if entry.is_dir() {
            std::fs::create_dir_all(target)?;
        } else {
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut output = File::create(target)?;
            std::io::copy(&mut entry, &mut output)?;
        }
    }
    Ok(())
}

fn extract_override_prefixes(source: &Path, game_dir: &Path) -> AppResult<()> {
    for prefix in [Path::new("overrides"), Path::new("client-overrides")] {
        extract_override_prefix(source, game_dir, prefix)?;
    }
    Ok(())
}

fn extract_override_prefix(source: &Path, game_dir: &Path, prefix: &Path) -> AppResult<()> {
    validate_relative_path(prefix)?;
    let prefix = format!("{}/", prefix.to_string_lossy().replace('\\', "/"));
    let file = File::open(source)?;
    let mut archive = zip::ZipArchive::new(file)?;
    validate_archive(&mut archive)?;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        let normalized = entry.name().replace('\\', "/");
        let Some(relative_text) = normalized.strip_prefix(&prefix) else {
            continue;
        };
        if relative_text.is_empty() {
            continue;
        }
        let relative = PathBuf::from(relative_text);
        validate_relative_path(&relative)?;
        let destination = game_dir.join(relative);
        if entry.is_dir() {
            std::fs::create_dir_all(destination)?;
            continue;
        }
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let temporary = destination.with_extension(format!("slh-{}.tmp", Uuid::new_v4()));
        let mut output = File::create(&temporary)?;
        std::io::copy(&mut entry, &mut output)?;
        output.sync_all()?;
        drop(output);
        if destination.exists() {
            std::fs::remove_file(&destination)?;
        }
        std::fs::rename(temporary, destination)?;
    }
    Ok(())
}

fn export_sync(
    instance: &Instance,
    game_dir: &Path,
    destination: &Path,
    request: &ExportInstanceRequest,
) -> AppResult<ExportResult> {
    let parent = destination
        .parent()
        .ok_or_else(|| AppError::InvalidInput("Export destination has no parent".into()))?;
    std::fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".slh-export-{}.tmp", Uuid::new_v4()));
    let file = File::create(&temporary)?;
    let mut zip = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o600);
    let prefix = match request.format.as_str() {
        "zip" => "",
        "curseforge" => {
            let loader = instance.loader_version.as_ref().map(|version| {
                serde_json::json!({
                    "id": format!("{}-{version}", instance.loader_type), "primary": true
                })
            });
            let manifest = serde_json::json!({
                "minecraft": { "version": instance.minecraft_version, "modLoaders": loader.into_iter().collect::<Vec<_>>() },
                "manifestType": "minecraftModpack", "manifestVersion": 1,
                "name": instance.name, "version": "1.0.0", "author": "SLH",
                "files": [], "overrides": "overrides"
            });
            zip.start_file("manifest.json", options)?;
            zip.write_all(&serde_json::to_vec_pretty(&manifest)?)?;
            "overrides/"
        }
        "mrpack" => {
            let mut dependencies = serde_json::Map::new();
            dependencies.insert(
                "minecraft".into(),
                serde_json::Value::String(instance.minecraft_version.clone()),
            );
            if instance.loader_type != "vanilla" {
                if let Some(version) = &instance.loader_version {
                    let dependency = match instance.loader_type.as_str() {
                        "fabric" => "fabric-loader",
                        "quilt" => "quilt-loader",
                        value => value,
                    };
                    dependencies.insert(
                        dependency.into(),
                        serde_json::Value::String(version.clone()),
                    );
                }
            }
            let manifest = serde_json::json!({
                "formatVersion": 1, "game": "minecraft", "versionId": "1.0.0",
                "name": instance.name, "summary": "Exported from SLH", "files": [],
                "dependencies": dependencies
            });
            zip.start_file("modrinth.index.json", options)?;
            zip.write_all(&serde_json::to_vec_pretty(&manifest)?)?;
            "overrides/"
        }
        other => {
            return Err(AppError::InvalidInput(format!(
                "Unsupported export format: {other}"
            )));
        }
    };
    let mut files_written = if request.format == "zip" { 0 } else { 1 };
    let selected: Vec<PathBuf> = request.entries.iter().map(PathBuf::from).collect();
    if selected.is_empty() {
        return Err(AppError::InvalidInput(
            "Select at least one file or folder to export".into(),
        ));
    }
    for path in &selected {
        validate_relative_path(path)?;
    }
    if game_dir.exists() {
        for entry in WalkDir::new(game_dir).follow_links(false) {
            let entry = entry.map_err(|error| AppError::Io(std::io::Error::other(error)))?;
            if entry.file_type().is_symlink() || !entry.file_type().is_file() {
                continue;
            }
            let relative = entry
                .path()
                .strip_prefix(game_dir)
                .map_err(|_| AppError::Security("Export path escaped the game directory".into()))?;
            let relative_text = relative.to_string_lossy().replace('\\', "/");
            if relative_text == "logs"
                || relative_text.starts_with("logs/")
                || relative_text == "crash-reports"
                || relative_text.starts_with("crash-reports/")
                || !selected
                    .iter()
                    .any(|path| relative == path || relative.starts_with(path))
            {
                continue;
            }
            zip.start_file(format!("{prefix}{relative_text}"), options)?;
            let mut input = File::open(entry.path())?;
            std::io::copy(&mut input, &mut zip)?;
            files_written += 1;
        }
    }
    zip.finish()?.sync_all()?;
    std::fs::rename(&temporary, destination)?;
    Ok(ExportResult {
        path: destination.to_string_lossy().into_owned(),
        files_written,
        size_bytes: std::fs::metadata(destination)?.len(),
    })
}

fn list_export_entries_sync(game_dir: &Path) -> AppResult<Vec<ExportEntry>> {
    if !game_dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut result = Vec::new();
    for child in std::fs::read_dir(game_dir)? {
        let child = child?;
        let path = child.path();
        let name = child.file_name().to_string_lossy().into_owned();
        if name == "logs" || name == "crash-reports" || child.file_type()?.is_symlink() {
            continue;
        }
        let mut files = 0_u64;
        let mut size_bytes = 0_u64;
        if child.file_type()?.is_file() {
            files = 1;
            size_bytes = child.metadata()?.len();
        } else if child.file_type()?.is_dir() {
            for entry in WalkDir::new(&path).follow_links(false) {
                let entry = entry.map_err(|error| AppError::Io(std::io::Error::other(error)))?;
                if entry.file_type().is_symlink() {
                    continue;
                }
                if entry.file_type().is_file() {
                    files += 1;
                    size_bytes += entry
                        .metadata()
                        .map_err(|error| AppError::Io(std::io::Error::other(error)))?
                        .len();
                }
            }
        }
        result.push(ExportEntry {
            relative_path: name,
            is_directory: child.file_type()?.is_dir(),
            files,
            size_bytes,
        });
    }
    result.sort_by(|a, b| {
        a.relative_path
            .to_ascii_lowercase()
            .cmp(&b.relative_path.to_ascii_lowercase())
    });
    Ok(result)
}

fn copy_tree(source: &Path, destination: &Path) -> AppResult<()> {
    if !source.exists() {
        return Ok(());
    }
    for entry in WalkDir::new(source).follow_links(false) {
        let entry = entry.map_err(|error| AppError::Io(std::io::Error::other(error)))?;
        if entry.file_type().is_symlink() {
            return Err(AppError::Security(format!(
                "Imported data contains a symbolic link: {}",
                entry.path().display()
            )));
        }
        let relative = entry
            .path()
            .strip_prefix(source)
            .map_err(|_| AppError::Security("Import path escaped staging".into()))?;
        let target = destination.join(relative);
        if entry.file_type().is_dir() {
            std::fs::create_dir_all(target)?;
        } else if entry.file_type().is_file() {
            copy_file_atomic(entry.path(), &target)?;
        }
    }
    Ok(())
}

fn stage_minecraft_folder(source: &Path, destination: &Path) -> AppResult<(u64, u64)> {
    let mut files = 0_u64;
    let mut bytes = 0_u64;
    let mut entries = WalkDir::new(source).follow_links(false).into_iter();
    while let Some(entry) = entries.next() {
        let entry = entry.map_err(|error| AppError::Io(std::io::Error::other(error)))?;
        if entry.file_type().is_symlink() {
            return Err(AppError::Security(format!(
                "Import source contains a symbolic link: {}",
                entry.path().display()
            )));
        }
        let relative = entry
            .path()
            .strip_prefix(source)
            .map_err(|_| AppError::Security("Folder import path escaped its source".into()))?;
        if relative.as_os_str().is_empty() {
            continue;
        }
        if excluded_folder_import_path(relative) {
            if entry.file_type().is_dir() {
                entries.skip_current_dir();
            }
            continue;
        }
        let target = destination.join(relative);
        if entry.file_type().is_dir() {
            std::fs::create_dir_all(target)?;
            continue;
        }
        if !entry.file_type().is_file() {
            return Err(AppError::Security(format!(
                "Import source contains an unsupported entry: {}",
                entry.path().display()
            )));
        }
        files = files.saturating_add(1);
        if files as usize > MAX_ENTRIES {
            return Err(AppError::Security(
                "Import source contains too many files".into(),
            ));
        }
        let file_size = entry
            .metadata()
            .map_err(|error| AppError::Io(std::io::Error::other(error)))?
            .len();
        bytes = bytes
            .checked_add(file_size)
            .ok_or_else(|| AppError::Security("Folder import size overflowed".into()))?;
        if bytes > MAX_UNCOMPRESSED_BYTES {
            return Err(AppError::Security(
                "Import source exceeds the 16 GiB safety limit".into(),
            ));
        }
        copy_file_atomic(entry.path(), &target)?;
    }
    Ok((files, bytes))
}

fn excluded_folder_import_path(relative: &Path) -> bool {
    let first = relative
        .components()
        .next()
        .map(|component| component.as_os_str().to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if [
        "assets",
        "libraries",
        "versions",
        "runtime",
        "natives",
        "logs",
        "crash-reports",
        "webcache",
    ]
    .contains(&first.as_str())
    {
        return true;
    }
    if relative.components().count() != 1 {
        return false;
    }
    [
        "launcher_profiles.json",
        "launcher_accounts.json",
        "launcher_settings.json",
        "usercache.json",
    ]
    .contains(&first.as_str())
}

fn copy_file_atomic(source: &Path, destination: &Path) -> AppResult<()> {
    let parent = destination
        .parent()
        .ok_or_else(|| AppError::InvalidInput("Import destination has no parent".into()))?;
    std::fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".slh-import-{}.tmp", Uuid::new_v4()));
    std::fs::copy(source, &temporary).map_err(|error| {
        AppError::Process(format!(
            "Could not stage {} as {}: {error}",
            source.display(),
            temporary.display()
        ))
    })?;
    {
        let temporary_file = std::fs::OpenOptions::new().write(true).open(&temporary)?;
        temporary_file.sync_all().map_err(|error| {
            AppError::Process(format!("Could not flush {}: {error}", temporary.display()))
        })?;
    }
    if destination.exists() {
        std::fs::remove_file(destination).map_err(|error| {
            AppError::Process(format!(
                "Could not replace existing import file {}: {error}",
                destination.display()
            ))
        })?;
    }
    if let Err(error) = std::fs::rename(&temporary, destination) {
        let _ = std::fs::remove_file(&temporary);
        return Err(AppError::Process(format!(
            "Could not commit {} as {}: {error}",
            temporary.display(),
            destination.display()
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_archive(path: &Path, entries: &[(&str, &[u8])]) {
        let file = File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        for (name, contents) in entries {
            zip.start_file(*name, SimpleFileOptions::default()).unwrap();
            zip.write_all(contents).unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn zip_slip_is_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let archive_path = directory.path().join("unsafe.zip");
        write_archive(&archive_path, &[("../escape.txt", b"unsafe")]);
        assert!(inspect_archive_sync(&archive_path).is_err());
    }

    #[test]
    fn modrinth_pack_is_recognized_as_importable() {
        let directory = tempfile::tempdir().unwrap();
        let archive_path = directory.path().join("sample.mrpack");
        let manifest = br#"{
          "formatVersion": 1,
          "game": "minecraft",
          "versionId": "1.0.0",
          "name": "Safe Pack",
          "summary": "test",
          "files": [],
          "dependencies": {
            "minecraft": "1.21.1",
            "fabric-loader": "0.16.14"
          }
        }"#;
        write_archive(&archive_path, &[("modrinth.index.json", manifest)]);

        let inspection = inspect_archive_sync(&archive_path).unwrap();
        assert_eq!(inspection.archive_type, "modrinth");
        assert_eq!(inspection.name.as_deref(), Some("Safe Pack"));
        assert_eq!(inspection.minecraft_version.as_deref(), Some("1.21.1"));
        assert_eq!(inspection.loader_type.as_deref(), Some("fabric"));
        assert_eq!(inspection.loader_version.as_deref(), Some("0.16.14"));
        assert!(inspection.can_import);
    }

    #[test]
    fn unsafe_modrinth_override_is_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let archive_path = directory.path().join("unsafe.mrpack");
        let game_dir = directory.path().join("game");
        write_archive(&archive_path, &[("overrides/../../outside.txt", b"unsafe")]);

        assert!(extract_override_prefixes(&archive_path, &game_dir).is_err());
        assert!(!directory.path().join("outside.txt").exists());
    }

    #[test]
    fn folder_import_keeps_game_data_and_excludes_credentials_and_runtime_cache() {
        let source = tempfile::tempdir().unwrap();
        let staged = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(source.path().join("saves/world")).unwrap();
        std::fs::create_dir_all(source.path().join("libraries/example")).unwrap();
        std::fs::write(source.path().join("saves/world/level.dat"), b"world").unwrap();
        std::fs::write(source.path().join("options.txt"), b"fov:0.5").unwrap();
        std::fs::write(source.path().join("launcher_accounts.json"), b"secret").unwrap();
        std::fs::write(source.path().join("libraries/example/cache.jar"), b"cache").unwrap();

        let (files, bytes) = stage_minecraft_folder(source.path(), staged.path()).unwrap();

        assert_eq!(files, 2);
        assert_eq!(bytes, 12);
        assert!(staged.path().join("saves/world/level.dat").is_file());
        assert!(staged.path().join("options.txt").is_file());
        assert!(!staged.path().join("launcher_accounts.json").exists());
        assert!(!staged.path().join("libraries").exists());
    }

    #[test]
    fn prism_instance_folder_uses_nested_minecraft_and_mmc_metadata() {
        let source = tempfile::tempdir().unwrap();
        let instance = source.path().join("26.2");
        let game = instance.join("minecraft");
        std::fs::create_dir_all(game.join("mods")).unwrap();
        std::fs::write(
            instance.join("instance.cfg"),
            "InstanceType=OneSix\nname=My Prism Fabric Pack\n",
        )
        .unwrap();
        std::fs::write(
            instance.join("mmc-pack.json"),
            r#"{"components":[{"uid":"net.minecraft","version":"1.21.1"},{"uid":"net.fabricmc.fabric-loader","version":"0.16.14"}]}"#,
        )
        .unwrap();
        std::fs::write(game.join("mods/example.jar"), b"mod").unwrap();

        let (metadata_root, game_root) = resolve_existing_folder_layout(&instance);
        let metadata = infer_existing_folder_metadata(&metadata_root);
        let staged = tempfile::tempdir().unwrap();
        stage_minecraft_folder(&game_root, staged.path()).unwrap();

        assert_eq!(metadata.name, "My Prism Fabric Pack");
        assert_eq!(metadata.minecraft_version, "1.21.1");
        assert_eq!(metadata.loader_type, "fabric");
        assert_eq!(metadata.loader_version.as_deref(), Some("0.16.14"));
        assert!(staged.path().join("mods/example.jar").is_file());
        assert!(!staged.path().join("minecraft/mods/example.jar").exists());
    }

    #[test]
    fn curseforge_pack_reports_loader_and_key_gate() {
        let directory = tempfile::tempdir().unwrap();
        let archive_path = directory.path().join("sample.zip");
        let manifest = br#"{
          "minecraft": {
            "version": "1.20.1",
            "modLoaders": [{"id": "forge-47.3.0", "primary": true}]
          },
          "manifestType": "minecraftModpack",
          "manifestVersion": 1,
          "name": "Curse Pack",
          "files": [],
          "overrides": "overrides"
        }"#;
        write_archive(&archive_path, &[("manifest.json", manifest)]);

        let inspection = inspect_archive_sync(&archive_path).unwrap();
        assert_eq!(inspection.archive_type, "curseforge");
        assert_eq!(inspection.minecraft_version.as_deref(), Some("1.20.1"));
        assert_eq!(inspection.loader_type.as_deref(), Some("forge"));
        assert_eq!(inspection.loader_version.as_deref(), Some("47.3.0"));
        assert_eq!(
            inspection.can_import,
            crate::content::curseforge::environment_api_key().is_some()
        );
    }

    #[test]
    fn curseforge_loader_rejects_unknown_or_empty_loader_ids() {
        let forge = [CurseForgeModLoader {
            id: "forge-47.3.0".into(),
            primary: true,
        }];
        assert_eq!(
            curseforge_loader(&forge).unwrap(),
            ("forge", Some("47.3.0".into()))
        );
        let unknown = [CurseForgeModLoader {
            id: "unknown-1.0".into(),
            primary: true,
        }];
        assert!(curseforge_loader(&unknown).is_err());
    }
}
