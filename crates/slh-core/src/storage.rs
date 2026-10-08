use std::fs::File;
use std::io::Cursor;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use base64::Engine;
use regex::Regex;
use serde_json::Value;
use walkdir::WalkDir;
use zip::ZipArchive;

use crate::database;
use crate::error::{AppError, AppResult};
use crate::models::{DownloadRecord, InstanceFileEntry, StorageSummary};
use crate::state::AppState;

pub async fn reveal_instance_path(
    state: &AppState,
    instance_id: &str,
    requested_path: Option<&str>,
) -> AppResult<()> {
    let instance = database::instance(&state.database, instance_id).await?;
    let instance_root = crate::instances::validated_instance_root(
        &state.paths,
        &instance.folder_name,
        &instance.game_dir,
    )?;
    let requested = requested_path
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(&instance.game_dir));

    if instance.loader_type == "bedrock" {
        let roots = crate::bedrock_files::roots(&instance, &instance_root);
        let game_dir = PathBuf::from(&instance.game_dir);
        let target = if requested == game_dir {
            if is_symlink_path(&roots.game_data)? {
                return Err(AppError::Security(
                    "Bedrock game-data folder cannot be a symbolic link".into(),
                ));
            }
            std::fs::create_dir_all(&roots.game_data)?;
            roots.game_data
        } else if requested == instance_root.join("logs") || requested == game_dir.join("logs") {
            let target = roots
                .logs
                .iter()
                .find(|path| is_plain_directory(path))
                .cloned()
                .or_else(|| roots.logs.first().cloned())
                .ok_or_else(|| AppError::Unavailable("Bedrock log folder is unavailable".into()))?;
            if is_symlink_path(&target)? {
                return Err(AppError::Security(
                    "Bedrock log folder cannot be a symbolic link".into(),
                ));
            }
            std::fs::create_dir_all(&target)?;
            target
        } else if roots.logs.iter().any(|root| {
            is_plain_directory(root) && validate_existing_descendant(root, &requested).is_ok()
        }) {
            let metadata = std::fs::symlink_metadata(&requested)?;
            let extension = requested
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or_default();
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || !["log", "txt", "json", "gz"]
                    .iter()
                    .any(|allowed| extension.eq_ignore_ascii_case(allowed))
            {
                return Err(AppError::Security(
                    "Only Bedrock log files can be opened from this folder".into(),
                ));
            }
            requested
        } else {
            return Err(AppError::Security(
                "Only the Bedrock game-data and log folders can be opened here".into(),
            ));
        };
        return open_in_explorer(&target);
    }

    if !requested.exists() && requested == PathBuf::from(&instance.game_dir) {
        tokio::fs::create_dir_all(&requested).await?;
    }
    validate_existing_descendant(&instance_root, &requested)?;
    open_in_explorer(&requested)
}

pub fn reveal_shared_path(state: &AppState) -> AppResult<()> {
    std::fs::create_dir_all(&state.paths.shared)?;
    open_in_explorer(&state.paths.shared)
}

pub async fn open_instance_screenshot(
    state: &AppState,
    instance_id: &str,
    requested_path: &str,
) -> AppResult<()> {
    let instance = database::instance(&state.database, instance_id).await?;
    let instance_root = crate::instances::validated_instance_root(
        &state.paths,
        &instance.folder_name,
        &instance.game_dir,
    )?;
    let requested = PathBuf::from(requested_path);
    let screenshot_roots = if instance.loader_type == "bedrock" {
        crate::bedrock_files::roots(&instance, &instance_root).screenshots
    } else {
        vec![PathBuf::from(&instance.game_dir).join("screenshots")]
    };
    validate_in_roots(&screenshot_roots, &requested)?;
    if !requested.is_file()
        || requested
            .extension()
            .and_then(|value| value.to_str())
            .is_none_or(|value| !is_screenshot_extension(value))
    {
        return Err(AppError::InvalidInput(
            "Only image files from this game's screenshot folder can be opened".into(),
        ));
    }
    open_file(&requested)
}

pub async fn screenshot_thumbnail(
    state: &AppState,
    instance_id: &str,
    requested_path: &str,
) -> AppResult<String> {
    let instance = database::instance(&state.database, instance_id).await?;
    let instance_root = crate::instances::validated_instance_root(
        &state.paths,
        &instance.folder_name,
        &instance.game_dir,
    )?;
    let requested = PathBuf::from(requested_path);
    let screenshot_roots = if instance.loader_type == "bedrock" {
        crate::bedrock_files::roots(&instance, &instance_root).screenshots
    } else {
        vec![PathBuf::from(&instance.game_dir).join("screenshots")]
    };
    validate_in_roots(&screenshot_roots, &requested)?;
    if !requested.is_file()
        || requested
            .extension()
            .and_then(|value| value.to_str())
            .is_none_or(|value| !is_screenshot_extension(value))
    {
        return Err(AppError::InvalidInput(
            "Only image files from this game's screenshot folder can be previewed".into(),
        ));
    }
    tokio::task::spawn_blocking(move || create_screenshot_thumbnail(&requested))
        .await
        .map_err(|error| AppError::Process(format!("Screenshot preview task failed: {error}")))?
}

fn is_screenshot_extension(extension: &str) -> bool {
    ["png", "jpg", "jpeg"]
        .iter()
        .any(|allowed| extension.eq_ignore_ascii_case(allowed))
}

fn is_symlink_path(path: &Path) -> AppResult<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => Ok(metadata.file_type().is_symlink()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn is_plain_directory(path: &Path) -> bool {
    std::fs::symlink_metadata(path)
        .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
}

fn validate_in_roots(roots: &[PathBuf], requested: &Path) -> AppResult<()> {
    for root in roots.iter().filter(|path| is_plain_directory(path)) {
        if validate_existing_descendant(root, requested).is_ok() {
            return Ok(());
        }
    }
    Err(AppError::Security(
        "Requested path is outside the allowed game-data folders".into(),
    ))
}

fn validate_existing_descendant(root: &Path, requested: &Path) -> AppResult<()> {
    if !requested.exists() {
        return Err(AppError::NotFound(format!(
            "Instance path does not exist: {}",
            requested.display()
        )));
    }
    let canonical_root = std::fs::canonicalize(root)?;
    let canonical_requested = std::fs::canonicalize(requested)?;
    if !path_is_within(&canonical_root, &canonical_requested) {
        return Err(AppError::Security(
            "Requested path is outside the portable instance root".into(),
        ));
    }
    Ok(())
}

fn path_is_within(root: &Path, requested: &Path) -> bool {
    #[cfg(windows)]
    {
        let normalize = |path: &Path| {
            path.to_string_lossy()
                .replace('/', "\\")
                .trim_end_matches('\\')
                .to_lowercase()
        };
        let root = normalize(root);
        let requested = normalize(requested);
        requested == root || requested.starts_with(&format!("{root}\\"))
    }
    #[cfg(not(windows))]
    {
        requested.starts_with(root)
    }
}

#[cfg(windows)]
fn open_in_explorer(path: &Path) -> AppResult<()> {
    let metadata = std::fs::metadata(path)?;
    let mut command = std::process::Command::new("explorer.exe");
    if metadata.is_file() {
        command.arg("/select,");
    }
    command.arg(path).spawn()?;
    Ok(())
}

#[cfg(not(windows))]
fn open_in_explorer(_path: &Path) -> AppResult<()> {
    Err(AppError::Unavailable(
        "Opening instance folders is available only on Windows".into(),
    ))
}

fn open_file(path: &Path) -> AppResult<()> {
    open::that(path)
        .map_err(|error| AppError::Process(format!("Could not open screenshot: {error}")))
}

pub async fn list_instance_files(
    state: &AppState,
    instance_id: &str,
    category: &str,
) -> AppResult<Vec<InstanceFileEntry>> {
    let instance = database::instance(&state.database, instance_id).await?;
    let instance_root = crate::instances::validated_instance_root(
        &state.paths,
        &instance.folder_name,
        &instance.game_dir,
    )?;
    let game = PathBuf::from(instance.game_dir.clone());
    if instance.loader_type == "bedrock" {
        let roots = crate::bedrock_files::roots(&instance, &instance_root);
        let category_roots = crate::bedrock_files::directories_for_category(&roots, category);
        let (directories_only, extensions, icon_kind): (bool, &[&str], FileIconKind) =
            match category {
                "mods" | "resourcepacks" | "worlds" => (true, &[], FileIconKind::None),
                "screenshots" => (false, &["png", "jpg", "jpeg"], FileIconKind::Screenshot),
                "logs" => (false, &["log", "txt", "json", "gz"], FileIconKind::None),
                _ => {
                    return Err(AppError::InvalidInput(format!(
                        "Unsupported Bedrock file category: {category}"
                    )));
                }
            };
        return tokio::task::spawn_blocking(move || {
            let mut entries = Vec::new();
            for root in category_roots {
                entries.extend(index_root(&root, directories_only, extensions, icon_kind)?);
            }
            let mut seen = std::collections::HashSet::new();
            entries.retain(|entry| seen.insert(entry.path.to_ascii_lowercase()));
            entries.sort_by(|left, right| {
                left.name
                    .to_lowercase()
                    .cmp(&right.name.to_lowercase())
                    .then_with(|| left.path.to_lowercase().cmp(&right.path.to_lowercase()))
            });
            Ok(entries)
        })
        .await
        .map_err(|error| AppError::Process(format!("File index task failed: {error}")))?;
    }
    let (root, directories_only, extensions, icon_kind): (PathBuf, bool, &[&str], FileIconKind) =
        match category {
            "mods" => (
                game.join("mods"),
                false,
                &["jar", "off", "disabled"],
                FileIconKind::Mod,
            ),
            "worlds" => (game.join("saves"), true, &[], FileIconKind::None),
            "screenshots" => (
                game.join("screenshots"),
                false,
                &["png"],
                FileIconKind::Screenshot,
            ),
            "logs" => (
                instance_root.join("logs"),
                false,
                &["log", "gz", "txt"],
                FileIconKind::None,
            ),
            "resourcepacks" => (
                game.join("resourcepacks"),
                false,
                &["zip", "off"],
                FileIconKind::ResourcePack,
            ),
            "shaders" => (
                game.join("shaderpacks"),
                false,
                &["zip", "off"],
                FileIconKind::None,
            ),
            _ => {
                return Err(AppError::InvalidInput(format!(
                    "Unsupported instance file category: {category}"
                )));
            }
        };
    tokio::task::spawn_blocking(move || index_root(&root, directories_only, extensions, icon_kind))
        .await
        .map_err(|error| AppError::Process(format!("File index task failed: {error}")))?
}

/// Remove one visible content entry without allowing arbitrary filesystem
/// paths.  The requested file must belong directly to the selected instance
/// category; symlinks and category roots themselves are never removed.
pub async fn delete_instance_content(
    state: &AppState,
    instance_id: &str,
    category: &str,
    requested_path: &str,
) -> AppResult<()> {
    let instance = database::instance(&state.database, instance_id).await?;
    let game = PathBuf::from(&instance.game_dir);
    if instance.loader_type == "bedrock" {
        let instance_root = crate::instances::validated_instance_root(
            &state.paths,
            &instance.folder_name,
            &instance.game_dir,
        )?;
        let roots = crate::bedrock_files::roots(&instance, &instance_root);
        let category_roots = crate::bedrock_files::directories_for_category(&roots, category);
        if category == "logs" {
            return Err(AppError::InvalidInput(
                "Bedrock log files are read-only in SLH".into(),
            ));
        }
        let directory_only = match category {
            "mods" | "resourcepacks" | "worlds" => true,
            "screenshots" => false,
            _ => {
                return Err(AppError::InvalidInput(
                    "Unsupported Bedrock content category".into(),
                ));
            }
        };
        let requested = PathBuf::from(requested_path);
        let root = category_roots
            .iter()
            .filter(|root| is_plain_directory(root))
            .find(|root| validate_existing_descendant(root, &requested).is_ok())
            .cloned()
            .ok_or_else(|| {
                AppError::Security(
                    "Requested path is outside the allowed Bedrock content folders".into(),
                )
            })?;
        if requested == root {
            return Err(AppError::Security(
                "The content category folder itself cannot be removed".into(),
            ));
        }
        if requested.parent() != Some(root.as_path()) {
            return Err(AppError::Security(
                "Only items directly inside a Bedrock content folder can be removed".into(),
            ));
        }
        let metadata = std::fs::symlink_metadata(&requested)?;
        if metadata.file_type().is_symlink() {
            return Err(AppError::Security(
                "Symbolic links cannot be removed from SLH".into(),
            ));
        }
        if directory_only {
            if !metadata.is_dir() {
                return Err(AppError::InvalidInput(
                    "Only Bedrock pack and world folders can be removed".into(),
                ));
            }
            tokio::fs::remove_dir_all(&requested).await?;
        } else {
            let extension = requested
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or_default();
            if !metadata.is_file() || !is_screenshot_extension(extension) {
                return Err(AppError::InvalidInput(
                    "Only Bedrock screenshot images can be removed".into(),
                ));
            }
            tokio::fs::remove_file(&requested).await?;
        }
        sqlx::query("DELETE FROM installed_content WHERE instance_id = ? AND file_path = ?")
            .bind(instance_id)
            .bind(requested.to_string_lossy().into_owned())
            .execute(&state.database)
            .await?;
        return Ok(());
    }
    let (root, directory_only, extensions): (PathBuf, bool, &[&str]) = match category {
        "mods" => (game.join("mods"), false, &["jar", "off", "disabled"]),
        "resourcepacks" => (game.join("resourcepacks"), false, &["zip", "off"]),
        "shaders" => (game.join("shaderpacks"), false, &["zip", "off"]),
        "worlds" => (game.join("saves"), true, &[]),
        "screenshots" => (game.join("screenshots"), false, &["png"]),
        _ => {
            return Err(AppError::InvalidInput(
                "Unsupported content category".into(),
            ));
        }
    };
    let requested = PathBuf::from(requested_path);
    validate_existing_descendant(&root, &requested)?;
    if requested == root {
        return Err(AppError::Security(
            "The content category folder itself cannot be removed".into(),
        ));
    }
    let metadata = std::fs::symlink_metadata(&requested)?;
    if metadata.file_type().is_symlink() {
        return Err(AppError::Security(
            "Symbolic links cannot be removed from SLH".into(),
        ));
    }
    if directory_only {
        if !metadata.is_dir() {
            return Err(AppError::InvalidInput(
                "Only world directories can be removed".into(),
            ));
        }
        tokio::fs::remove_dir_all(&requested).await?;
    } else {
        let extension = requested
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if !metadata.is_file()
            || !extensions
                .iter()
                .any(|allowed| extension.eq_ignore_ascii_case(allowed))
        {
            return Err(AppError::InvalidInput(
                "This file type cannot be removed from the selected category".into(),
            ));
        }
        tokio::fs::remove_file(&requested).await?;
    }
    sqlx::query("DELETE FROM installed_content WHERE instance_id = ? AND file_path = ?")
        .bind(instance_id)
        .bind(requested.to_string_lossy().into_owned())
        .execute(&state.database)
        .await?;
    Ok(())
}

/// Toggle a directly visible mod, resource pack, or shader without touching
/// any other launcher data. Disabled content uses the Prism-style `.off`
/// suffix (`sodium.jar.off`), which Minecraft ignores until it is enabled.
pub async fn set_instance_content_enabled(
    state: &AppState,
    instance_id: &str,
    category: &str,
    requested_path: &str,
    enabled: bool,
) -> AppResult<String> {
    let instance = database::instance(&state.database, instance_id).await?;
    if instance.loader_type == "bedrock" {
        return Err(AppError::InvalidInput(
            "Bedrock packs are enabled per world inside Minecraft".into(),
        ));
    }
    let game = PathBuf::from(&instance.game_dir);
    let (root, original_extensions): (PathBuf, &[&str]) = match category {
        "mods" => (game.join("mods"), &["jar"]),
        "resourcepacks" => (game.join("resourcepacks"), &["zip"]),
        "shaders" => (game.join("shaderpacks"), &["zip"]),
        _ => {
            return Err(AppError::InvalidInput(
                "Only mods, resource packs, and shaders can be enabled or disabled".into(),
            ));
        }
    };
    let requested = PathBuf::from(requested_path);
    validate_existing_descendant(&root, &requested)?;
    if requested.parent() != Some(root.as_path()) {
        return Err(AppError::Security(
            "Only files directly inside the selected content folder can be changed".into(),
        ));
    }
    let metadata = std::fs::symlink_metadata(&requested)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(AppError::Security(
            "Only regular content files can be enabled or disabled".into(),
        ));
    }

    let name = requested
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| AppError::InvalidInput("Content file name is not valid Unicode".into()))?;
    let lowercase_name = name.to_ascii_lowercase();
    // `.disabled` was used by an older SLH build. Keep it manageable so an
    // update does not hide existing disabled mods; new disables always use
    // the requested Prism-compatible `.off` suffix.
    let disabled_suffix_len = if lowercase_name.ends_with(".off") {
        4
    } else if category == "mods" && lowercase_name.ends_with(".disabled") {
        9
    } else {
        0
    };
    let is_disabled = disabled_suffix_len != 0;
    if is_disabled == !enabled {
        return Ok(requested.to_string_lossy().into_owned());
    }
    let target_name = if enabled {
        let base_len = name.len().checked_sub(disabled_suffix_len).ok_or_else(|| {
            AppError::InvalidInput("Disabled content has an invalid file name".into())
        })?;
        let restored = &name[..base_len];
        let extension = Path::new(restored)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if !original_extensions
            .iter()
            .any(|allowed| extension.eq_ignore_ascii_case(allowed))
        {
            return Err(AppError::InvalidInput(
                "This file type cannot be enabled in the selected category".into(),
            ));
        }
        restored.to_owned()
    } else {
        let extension = requested
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if !original_extensions
            .iter()
            .any(|allowed| extension.eq_ignore_ascii_case(allowed))
        {
            return Err(AppError::InvalidInput(
                "This file type cannot be disabled in the selected category".into(),
            ));
        }
        format!("{name}.off")
    };
    let target = root.join(target_name);
    if target.exists() {
        return Err(AppError::Conflict(
            "A file with the target enabled state already exists".into(),
        ));
    }
    tokio::fs::rename(&requested, &target).await?;
    sqlx::query(
        "UPDATE installed_content SET file_path = ? WHERE instance_id = ? AND file_path = ?",
    )
    .bind(target.to_string_lossy().into_owned())
    .bind(instance_id)
    .bind(requested.to_string_lossy().into_owned())
    .execute(&state.database)
    .await?;
    Ok(target.to_string_lossy().into_owned())
}

pub async fn summary(state: &AppState) -> AppResult<StorageSummary> {
    let paths = state.paths.clone();
    let managed_java = crate::minecraft::java::managed_root(state).await?;
    tokio::task::spawn_blocking(move || {
        let database_bytes = [
            paths.database(),
            paths.data.join("app.db-wal"),
            paths.data.join("app.db-shm"),
        ]
        .iter()
        .filter_map(|path| std::fs::metadata(path).ok())
        .map(|metadata| metadata.len())
        .sum();
        let instances_bytes = directory_size(&paths.instances)?;
        let shared_bytes = directory_size(&paths.shared)?;
        let cache_bytes = directory_size(&paths.cache)?;
        let downloads_bytes = directory_size(&paths.downloads)?;
        let java_bytes = directory_size(&managed_java)?;
        let logs_bytes = directory_size(&paths.logs)?;
        let backups_bytes = directory_size(&paths.backups)?;
        let total_bytes = database_bytes
            + instances_bytes
            + shared_bytes
            + cache_bytes
            + downloads_bytes
            + java_bytes
            + logs_bytes
            + backups_bytes;
        Ok(StorageSummary {
            total_bytes,
            database_bytes,
            instances_bytes,
            shared_bytes,
            cache_bytes,
            downloads_bytes,
            java_bytes,
            logs_bytes,
            backups_bytes,
        })
    })
    .await
    .map_err(|error| AppError::Process(format!("Storage scan task failed: {error}")))?
}

pub async fn list_downloads(state: &AppState, limit: u32) -> AppResult<Vec<DownloadRecord>> {
    let limit = limit.clamp(1, 200) as i64;
    Ok(sqlx::query_as::<_, DownloadRecord>(
        "SELECT id, source, destination, status, downloaded_bytes, total_bytes, error_message, \
         created_at, updated_at FROM downloads ORDER BY updated_at DESC LIMIT ?",
    )
    .bind(limit)
    .fetch_all(&state.database)
    .await?)
}

#[derive(Clone, Copy)]
enum FileIconKind {
    None,
    Mod,
    ResourcePack,
    Screenshot,
}

fn index_root(
    root: &Path,
    directories_only: bool,
    extensions: &[&str],
    icon_kind: FileIconKind,
) -> AppResult<Vec<InstanceFileEntry>> {
    if !is_plain_directory(root) {
        return Ok(Vec::new());
    }
    let mut result = Vec::new();
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        if directories_only && !file_type.is_dir() {
            continue;
        }
        if !directories_only && !file_type.is_file() {
            continue;
        }
        let path = entry.path();
        if !extensions.is_empty()
            && !path
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|extension| {
                    extensions
                        .iter()
                        .any(|allowed| extension.eq_ignore_ascii_case(allowed))
                })
        {
            continue;
        }
        let metadata = entry.metadata()?;
        let size = if file_type.is_dir() {
            directory_size(&path)?
        } else {
            metadata.len()
        };
        let modified_at = metadata.modified().ok().and_then(|modified| {
            modified
                .duration_since(UNIX_EPOCH)
                .ok()
                .and_then(|duration| chrono::DateTime::from_timestamp(duration.as_secs() as i64, 0))
                .map(|date| date.to_rfc3339())
        });
        // Screenshots must stay on disk. Returning whole PNG files as base64 in the IPC response
        // makes a gallery of ordinary Minecraft screenshots allocate hundreds of megabytes in the
        // WebView before the first card can render. The command authorizes the paths for Tauri's
        // asset protocol instead; the UI then loads only thumbnails close to the viewport.
        let icon_data_url = if file_type.is_file() && !matches!(icon_kind, FileIconKind::Screenshot)
        {
            archive_icon_data_url(&path, icon_kind)
        } else {
            None
        };
        result.push(InstanceFileEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: path.to_string_lossy().into_owned(),
            entry_type: if file_type.is_dir() {
                "directory"
            } else {
                "file"
            }
            .into(),
            size_bytes: size,
            modified_at,
            icon_data_url,
        });
    }
    // File-system enumeration order and modification time do not represent a
    // useful default for content lists. Keep every category predictable: names
    // are always shown A–Z / А–Я, case-insensitively.
    result.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(result)
}

const MAX_ICON_BYTES: u64 = 512 * 1024;
const MAX_METADATA_BYTES: u64 = 1024 * 1024;
const MAX_SCREENSHOT_SOURCE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_SCREENSHOT_PIXELS: u64 = 32 * 1024 * 1024;

fn create_screenshot_thumbnail(path: &Path) -> AppResult<String> {
    let size = std::fs::metadata(path)?.len();
    if size > MAX_SCREENSHOT_SOURCE_BYTES {
        return Err(AppError::InvalidInput(
            "Screenshot is too large to preview safely".into(),
        ));
    }
    let (width, height) = image::image_dimensions(path).map_err(|error| {
        AppError::InvalidInput(format!("Screenshot dimensions are invalid: {error}"))
    })?;
    if u64::from(width).saturating_mul(u64::from(height)) > MAX_SCREENSHOT_PIXELS {
        return Err(AppError::InvalidInput(
            "Screenshot dimensions are too large to preview safely".into(),
        ));
    }
    let screenshot = image::open(path).map_err(|error| {
        AppError::InvalidInput(format!("Screenshot could not be decoded: {error}"))
    })?;
    let thumbnail = screenshot.thumbnail(480, 270);
    let mut output = Cursor::new(Vec::new());
    thumbnail
        .write_to(&mut output, image::ImageFormat::Jpeg)
        .map_err(|error| {
            AppError::Process(format!(
                "Screenshot thumbnail could not be encoded: {error}"
            ))
        })?;
    Ok(format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(output.into_inner())
    ))
}

fn archive_icon_data_url(path: &Path, kind: FileIconKind) -> Option<String> {
    let file = File::open(path).ok()?;
    let mut archive = ZipArchive::new(file).ok()?;
    let icon_path = match kind {
        FileIconKind::None | FileIconKind::Screenshot => return None,
        FileIconKind::ResourcePack => {
            find_entry_name(&mut archive, |name| name.eq_ignore_ascii_case("pack.png"))
        }
        FileIconKind::Mod => find_mod_icon_path(&mut archive),
    }?;
    let bytes = read_entry_limited(&mut archive, &icon_path, MAX_ICON_BYTES)?;
    let mime = image_mime(&bytes)?;
    Some(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

fn find_mod_icon_path(archive: &mut ZipArchive<File>) -> Option<String> {
    for metadata_name in ["fabric.mod.json", "quilt.mod.json", "mcmod.info"] {
        let Some(bytes) = read_entry_limited(archive, metadata_name, MAX_METADATA_BYTES) else {
            continue;
        };
        let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
            continue;
        };
        if let Some(path) = find_json_icon_path(&value).and_then(normalize_icon_path) {
            if let Some(name) = find_entry_name(archive, |name| name.eq_ignore_ascii_case(&path)) {
                return Some(name);
            }
        }
    }

    let logo_pattern = Regex::new(r#"(?mi)^\s*logoFile\s*=\s*[\"']([^\"']+)[\"']"#).ok()?;
    for metadata_name in ["META-INF/mods.toml", "META-INF/neoforge.mods.toml"] {
        let Some(bytes) = read_entry_limited(archive, metadata_name, MAX_METADATA_BYTES) else {
            continue;
        };
        let text = String::from_utf8_lossy(&bytes);
        let Some(path) = logo_pattern
            .captures(&text)
            .and_then(|captures| captures.get(1))
            .map(|value| value.as_str())
            .and_then(normalize_icon_path)
        else {
            continue;
        };
        if let Some(name) = find_entry_name(archive, |name| name.eq_ignore_ascii_case(&path)) {
            return Some(name);
        }
    }

    let mut candidates = Vec::new();
    for index in 0..archive.len() {
        let Ok(entry) = archive.by_index(index) else {
            continue;
        };
        if entry.is_dir() || entry.size() > MAX_ICON_BYTES {
            continue;
        }
        let normalized = entry.name().replace('\\', "/");
        let lower = normalized.to_ascii_lowercase();
        if lower == "icon.png"
            || lower == "logo.png"
            || lower.ends_with("/icon.png")
            || lower.ends_with("/logo.png")
        {
            candidates.push(normalized);
        }
    }
    candidates.sort_by_key(|name| name.len());
    candidates.into_iter().next()
}

fn find_json_icon_path(value: &Value) -> Option<&str> {
    match value {
        Value::Object(values) => {
            for key in ["icon", "logoFile", "logo_file"] {
                if let Some(path) = values.get(key).and_then(icon_value_path) {
                    return Some(path);
                }
            }
            values.values().find_map(find_json_icon_path)
        }
        Value::Array(values) => values.iter().find_map(find_json_icon_path),
        _ => None,
    }
}

fn icon_value_path(value: &Value) -> Option<&str> {
    match value {
        Value::String(path) => Some(path),
        Value::Object(values) => values
            .iter()
            .filter_map(|(size, value)| Some((size.parse::<u32>().ok()?, value.as_str()?)))
            .max_by_key(|(size, _)| *size)
            .map(|(_, path)| path),
        _ => None,
    }
}

fn normalize_icon_path(path: &str) -> Option<String> {
    let normalized = path.trim().trim_start_matches("./").replace('\\', "/");
    if normalized.is_empty()
        || normalized.starts_with('/')
        || normalized.contains(':')
        || normalized
            .split('/')
            .any(|part| part == ".." || part.is_empty())
    {
        return None;
    }
    Some(normalized)
}

fn find_entry_name(
    archive: &mut ZipArchive<File>,
    mut matches: impl FnMut(&str) -> bool,
) -> Option<String> {
    for index in 0..archive.len() {
        let Ok(entry) = archive.by_index(index) else {
            continue;
        };
        if entry.is_dir() || entry.size() > MAX_ICON_BYTES.max(MAX_METADATA_BYTES) {
            continue;
        }
        let normalized = entry.name().replace('\\', "/");
        if matches(&normalized) {
            return Some(normalized);
        }
    }
    None
}

fn read_entry_limited(archive: &mut ZipArchive<File>, name: &str, limit: u64) -> Option<Vec<u8>> {
    let matched = find_entry_name(archive, |candidate| candidate.eq_ignore_ascii_case(name))?;
    let index = (0..archive.len()).find(|index| {
        archive.by_index(*index).ok().is_some_and(|entry| {
            entry
                .name()
                .replace('\\', "/")
                .eq_ignore_ascii_case(&matched)
        })
    })?;
    let mut entry = archive.by_index(index).ok()?;
    if entry.is_dir() || entry.size() > limit {
        return None;
    }
    let mut bytes = Vec::with_capacity(entry.size() as usize);
    entry.read_to_end(&mut bytes).ok()?;
    (bytes.len() as u64 <= limit).then_some(bytes)
}

fn image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

fn directory_size(root: &Path) -> AppResult<u64> {
    if !root.exists() {
        return Ok(0);
    }
    let mut size = 0_u64;
    for entry in WalkDir::new(root).follow_links(false) {
        let entry = entry.map_err(|error| AppError::Io(std::io::Error::other(error)))?;
        if entry.file_type().is_symlink() {
            continue;
        }
        if entry.file_type().is_file() {
            let metadata = entry
                .metadata()
                .map_err(|error| AppError::Io(std::io::Error::other(error)))?;
            size = size.saturating_add(metadata.len());
        }
    }
    Ok(size)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    #[test]
    fn descendant_check_rejects_sibling_prefixes() {
        #[cfg(windows)]
        {
            assert!(path_is_within(
                Path::new(r"C:\SLH\data\instances\one"),
                Path::new(r"c:\slh\data\instances\one\game\mods")
            ));
            assert!(!path_is_within(
                Path::new(r"C:\SLH\data\instances\one"),
                Path::new(r"C:\SLH\data\instances\one-escape")
            ));
        }
    }

    #[test]
    fn resource_pack_icon_is_read_from_pack_png() {
        let directory = tempfile::tempdir().unwrap();
        let archive_path = directory.path().join("pack.zip");
        write_test_archive(
            &archive_path,
            &[
                (
                    "pack.mcmeta",
                    br#"{"pack":{"pack_format":15,"description":"test"}}"#,
                ),
                ("pack.png", b"\x89PNG\r\n\x1a\nfixture"),
            ],
        );

        let icon = archive_icon_data_url(&archive_path, FileIconKind::ResourcePack).unwrap();
        assert!(icon.starts_with("data:image/png;base64,"));
    }

    #[test]
    fn fabric_mod_icon_is_read_from_manifest_path() {
        let directory = tempfile::tempdir().unwrap();
        let archive_path = directory.path().join("example.jar");
        write_test_archive(
            &archive_path,
            &[
                (
                    "fabric.mod.json",
                    br#"{"id":"example","icon":"assets/example/icon.png"}"#,
                ),
                ("assets/example/icon.png", b"\x89PNG\r\n\x1a\nfixture"),
            ],
        );

        let icon = archive_icon_data_url(&archive_path, FileIconKind::Mod).unwrap();
        assert!(icon.starts_with("data:image/png;base64,"));
    }

    fn write_test_archive(path: &Path, entries: &[(&str, &[u8])]) {
        let file = File::create(path).unwrap();
        let mut archive = zip::ZipWriter::new(file);
        for (name, contents) in entries {
            archive
                .start_file(*name, SimpleFileOptions::default())
                .unwrap();
            archive.write_all(contents).unwrap();
        }
        archive.finish().unwrap();
    }
}
