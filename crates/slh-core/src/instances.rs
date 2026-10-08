use std::path::{Path, PathBuf};

use regex::Regex;
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::models::{
    AssignInstanceGroupRequest, CreateGroupRequest, CreateInstanceRequest, DeleteGroupRequest,
    DeleteInstanceResult, Instance, InstanceGroup, RenameGroupRequest, ReorderGroupsRequest,
    SetGroupCollapsedRequest, UpdateInstanceRequest,
};
use crate::portable::PortablePaths;
use crate::state::AppState;

const RESERVED_WINDOWS_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

const INSTANCE_ICONS: &[&str] = &[
    "cube", "package", "blocks", "sword", "tree", "star", "gamepad", "globe", "coffee", "image",
    "server", "tools",
];

pub fn validate_display_name(name: &str) -> AppResult<String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(AppError::InvalidInput(
            "Instance name must contain between 1 and 80 characters".into(),
        ));
    }
    let invalid = Regex::new(r#"[<>:\"/\\|?*\x00-\x1F]"#).expect("filename regex is valid");
    if invalid.is_match(name) || name.ends_with('.') || name.ends_with(' ') {
        return Err(AppError::InvalidInput(
            "Instance name contains characters that are not safe on Windows".into(),
        ));
    }
    let stem = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
    if RESERVED_WINDOWS_NAMES.contains(&stem.as_str()) {
        return Err(AppError::InvalidInput(
            "Instance name is reserved by Windows".into(),
        ));
    }
    Ok(name.to_owned())
}

pub async fn assign_instance_group(
    pool: &SqlitePool,
    request: AssignInstanceGroupRequest,
) -> AppResult<Instance> {
    if let Some(group_id) = &request.group_id {
        let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM groups WHERE id = ?)")
            .bind(group_id)
            .fetch_one(pool)
            .await?;
        if !exists {
            return Err(AppError::NotFound(format!("Group {group_id}")));
        }
    }
    let changed = sqlx::query("UPDATE instances SET group_id = ? WHERE id = ?")
        .bind(&request.group_id)
        .bind(&request.instance_id)
        .execute(pool)
        .await?;
    if changed.rows_affected() == 0 {
        return Err(AppError::NotFound(format!(
            "Instance {}",
            request.instance_id
        )));
    }
    crate::database::instance(pool, &request.instance_id).await
}

/// Reserves a readable display name for imported packs without replacing an existing instance.
/// Folder allocation already has collision handling; imports also need distinct names in the UI.
pub async fn allocate_unique_display_name(pool: &SqlitePool, desired: &str) -> AppResult<String> {
    let base = validate_display_name(desired)?;
    for suffix in 0..10_000 {
        let candidate = if suffix == 0 {
            base.clone()
        } else {
            let postfix = format!(" ({suffix})");
            let prefix: String = base
                .chars()
                .take(80usize.saturating_sub(postfix.chars().count()))
                .collect();
            format!("{prefix}{postfix}")
        };
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM instances WHERE name = ? COLLATE NOCASE)",
        )
        .bind(&candidate)
        .fetch_one(pool)
        .await?;
        if !exists {
            return Ok(candidate);
        }
    }
    Err(AppError::Conflict(
        "Could not allocate a unique instance name".into(),
    ))
}

pub async fn create_group(
    pool: &SqlitePool,
    request: CreateGroupRequest,
) -> AppResult<InstanceGroup> {
    let name = validate_display_name(&request.name)?;
    let id = Uuid::new_v4().to_string();
    let next_order: i64 =
        sqlx::query_scalar("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM groups")
            .fetch_one(pool)
            .await?;
    sqlx::query("INSERT INTO groups(id, name, sort_order) VALUES (?, ?, ?)")
        .bind(&id)
        .bind(&name)
        .bind(next_order)
        .execute(pool)
        .await?;
    Ok(sqlx::query_as::<_, InstanceGroup>(
        "SELECT id, name, sort_order, collapsed, created_at FROM groups WHERE id = ?",
    )
    .bind(id)
    .fetch_one(pool)
    .await?)
}

pub async fn set_group_collapsed(
    pool: &SqlitePool,
    request: SetGroupCollapsedRequest,
) -> AppResult<InstanceGroup> {
    let changed = sqlx::query("UPDATE groups SET collapsed = ? WHERE id = ?")
        .bind(request.collapsed)
        .bind(&request.group_id)
        .execute(pool)
        .await?;
    if changed.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("Group {}", request.group_id)));
    }
    Ok(sqlx::query_as::<_, InstanceGroup>(
        "SELECT id, name, sort_order, collapsed, created_at FROM groups WHERE id = ?",
    )
    .bind(request.group_id)
    .fetch_one(pool)
    .await?)
}

pub async fn rename_group(
    pool: &SqlitePool,
    request: RenameGroupRequest,
) -> AppResult<InstanceGroup> {
    let name = validate_display_name(&request.name)?;
    let changed = sqlx::query("UPDATE groups SET name = ? WHERE id = ?")
        .bind(name)
        .bind(&request.group_id)
        .execute(pool)
        .await?;
    if changed.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("Group {}", request.group_id)));
    }
    Ok(sqlx::query_as::<_, InstanceGroup>(
        "SELECT id, name, sort_order, collapsed, created_at FROM groups WHERE id = ?",
    )
    .bind(request.group_id)
    .fetch_one(pool)
    .await?)
}

/// Removing a group never removes its Minecraft instances. They are deliberately
/// returned to the ungrouped library first, inside the same transaction.
pub async fn delete_group(pool: &SqlitePool, request: DeleteGroupRequest) -> AppResult<()> {
    let mut transaction = pool.begin().await?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM groups WHERE id = ?)")
        .bind(&request.group_id)
        .fetch_one(&mut *transaction)
        .await?;
    if !exists {
        return Err(AppError::NotFound(format!("Group {}", request.group_id)));
    }
    sqlx::query("UPDATE instances SET group_id = NULL WHERE group_id = ?")
        .bind(&request.group_id)
        .execute(&mut *transaction)
        .await?;
    sqlx::query("DELETE FROM groups WHERE id = ?")
        .bind(&request.group_id)
        .execute(&mut *transaction)
        .await?;
    transaction.commit().await?;
    Ok(())
}

pub async fn reorder_groups(pool: &SqlitePool, request: ReorderGroupsRequest) -> AppResult<()> {
    let mut transaction = pool.begin().await?;
    for (position, group_id) in request.group_ids.iter().enumerate() {
        sqlx::query("UPDATE groups SET sort_order = ? WHERE id = ?")
            .bind(position as i64)
            .bind(group_id)
            .execute(&mut *transaction)
            .await?;
    }
    transaction.commit().await?;
    Ok(())
}

pub async fn create_instance(
    pool: &SqlitePool,
    paths: &PortablePaths,
    request: CreateInstanceRequest,
) -> AppResult<Instance> {
    let name = validate_display_name(&request.name)?;
    if request.minecraft_version.trim().is_empty() {
        return Err(AppError::InvalidInput(
            "Minecraft version is required".into(),
        ));
    }
    if request.memory_min_mb < 256 || request.memory_max_mb < request.memory_min_mb {
        return Err(AppError::InvalidInput(
            "Memory limits are invalid; maximum must be at least the minimum".into(),
        ));
    }
    let loader = request.loader_type.to_ascii_lowercase();
    if !["vanilla", "fabric", "forge", "neoforge", "quilt", "bedrock"].contains(&loader.as_str()) {
        return Err(AppError::InvalidInput(format!(
            "Unsupported loader type: {}",
            request.loader_type
        )));
    }
    if loader == "bedrock" && request.loader_version.is_some() {
        return Err(AppError::InvalidInput(
            "Bedrock does not use a Java loader version".into(),
        ));
    }
    let bedrock_profile_mode = if loader == "bedrock" {
        let mode = request
            .bedrock_profile_mode
            .as_deref()
            .unwrap_or("isolated")
            .trim()
            .to_ascii_lowercase();
        if !matches!(mode.as_str(), "isolated" | "shared") {
            return Err(AppError::InvalidInput(
                "Bedrock profile mode must be isolated or shared".into(),
            ));
        }
        mode
    } else {
        "shared".into()
    };
    if let Some(group_id) = &request.group_id {
        let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM groups WHERE id = ?)")
            .bind(group_id)
            .fetch_one(pool)
            .await?;
        if !exists {
            return Err(AppError::NotFound(format!("Group {group_id}")));
        }
    }
    if loader != "bedrock" {
        if let Some(java_path) = &request.java_path {
            if !Path::new(java_path).is_file() {
                return Err(AppError::InvalidInput(format!(
                    "Java executable does not exist: {java_path}"
                )));
            }
        }
    }
    let java_path = if loader == "bedrock" {
        None
    } else {
        request.java_path.as_deref()
    };

    let id = Uuid::new_v4().to_string();
    let folder_name = allocate_folder_name(paths, &name, None)?;
    let instance_root = paths.instances.join(&folder_name);
    let game_dir = instance_root.join("game");
    for directory in [
        game_dir.clone(),
        game_dir.join("mods"),
        game_dir.join("resourcepacks"),
        game_dir.join("shaderpacks"),
        game_dir.join("screenshots"),
        game_dir.join("saves"),
        instance_root.join("logs"),
        instance_root.join("versions"),
        instance_root.join("natives"),
    ] {
        std::fs::create_dir_all(directory)?;
    }

    let (default_background, default_foreground) = default_icon_colors(&loader);
    let icon_key = request.icon_key.as_deref().unwrap_or("cube");
    validate_icon(icon_key)?;
    let icon_background = request
        .icon_background
        .as_deref()
        .unwrap_or(default_background);
    let icon_foreground = request
        .icon_foreground
        .as_deref()
        .unwrap_or(default_foreground);
    validate_hex_color(icon_background)?;
    validate_hex_color(icon_foreground)?;
    let insert = sqlx::query(
        "INSERT INTO instances(id, name, group_id, folder_name, icon_key, icon_background, \
         icon_foreground, minecraft_version, loader_type, loader_version, status, java_path, \
         memory_min_mb, memory_max_mb, game_dir, bedrock_profile_mode) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&name)
    .bind(&request.group_id)
    .bind(&folder_name)
    .bind(icon_key)
    .bind(icon_background)
    .bind(icon_foreground)
    .bind(request.minecraft_version.trim())
    .bind(loader)
    .bind(&request.loader_version)
    .bind(java_path)
    .bind(request.memory_min_mb)
    .bind(request.memory_max_mb)
    .bind(game_dir.to_string_lossy().into_owned())
    .bind(&bedrock_profile_mode)
    .execute(pool)
    .await;

    if let Err(error) = insert {
        let _ = std::fs::remove_dir_all(&instance_root);
        return Err(error.into());
    }
    crate::database::instance(pool, &id).await
}

pub async fn update_instance(
    state: &AppState,
    request: UpdateInstanceRequest,
) -> AppResult<Instance> {
    let name = validate_display_name(&request.name)?;
    validate_icon(&request.icon_key)?;
    validate_hex_color(&request.icon_background)?;
    validate_hex_color(&request.icon_foreground)?;
    if request.memory_min_mb < 256 || request.memory_max_mb < request.memory_min_mb {
        return Err(AppError::InvalidInput(
            "Memory limits are invalid; maximum must be at least the minimum".into(),
        ));
    }
    let instance = crate::database::instance(&state.database, &request.instance_id).await?;
    if instance.status == "running" || state.running_instances.read().await.contains(&instance.id) {
        return Err(AppError::Conflict(
            "Stop Minecraft before renaming this instance".into(),
        ));
    }
    let old_root =
        validated_instance_root(&state.paths, &instance.folder_name, &instance.game_dir)?;
    let loader_type = request
        .loader_type
        .clone()
        .unwrap_or_else(|| instance.loader_type.clone())
        .to_ascii_lowercase();
    if !["vanilla", "fabric", "forge", "neoforge", "quilt", "bedrock"]
        .contains(&loader_type.as_str())
    {
        return Err(AppError::InvalidInput(format!(
            "Unsupported loader type: {loader_type}"
        )));
    }
    let minecraft_version = request
        .minecraft_version
        .as_deref()
        .unwrap_or(&instance.minecraft_version)
        .trim()
        .to_owned();
    if minecraft_version.is_empty() {
        return Err(AppError::InvalidInput(
            "Minecraft version is required".into(),
        ));
    }
    let bedrock_profile_mode = if loader_type == "bedrock" {
        let mode = request
            .bedrock_profile_mode
            .as_deref()
            .unwrap_or(&instance.bedrock_profile_mode)
            .trim()
            .to_ascii_lowercase();
        if !matches!(mode.as_str(), "isolated" | "shared") {
            return Err(AppError::InvalidInput(
                "Bedrock profile mode must be isolated or shared".into(),
            ));
        }
        mode
    } else {
        "shared".into()
    };
    if minecraft_version != instance.minecraft_version {
        let available = if loader_type == "bedrock" {
            crate::minecraft::bedrock::list_versions(state).await?
        } else {
            crate::minecraft::installer::list_versions(state).await?
        };
        if !available
            .iter()
            .any(|version| version.id == minecraft_version)
        {
            return Err(AppError::InvalidInput(format!(
                "Minecraft version {minecraft_version} is not present in the official manifest"
            )));
        }
    }
    let loader_version = if matches!(loader_type.as_str(), "vanilla" | "bedrock") {
        None
    } else {
        request
            .loader_version
            .clone()
            .or_else(|| instance.loader_version.clone())
    };
    if !matches!(loader_type.as_str(), "vanilla" | "bedrock")
        && loader_version.as_deref().unwrap_or("").trim().is_empty()
    {
        return Err(AppError::InvalidInput(format!(
            "{loader_type} loader version is required"
        )));
    }
    let runtime_changed = minecraft_version != instance.minecraft_version
        || loader_type != instance.loader_type
        || loader_version != instance.loader_version;
    let next_status = if runtime_changed {
        "created"
    } else {
        instance.status.as_str()
    };
    let mut folder_name = instance.folder_name.clone();
    let mut new_root = old_root.clone();
    let name_changed = name != instance.name;
    if name_changed {
        folder_name = allocate_folder_name(&state.paths, &name, Some(&old_root))?;
        new_root = state.paths.instances.join(&folder_name);
    }

    let moved = name_changed && old_root != new_root;
    if moved {
        rename_directory_case_safe(&old_root, &new_root).await?;
    }
    let old_game = PathBuf::from(&instance.game_dir);
    let new_game = new_root.join("game");
    let update_result: AppResult<()> = async {
        let mut transaction = state.database.begin().await?;
        sqlx::query(
            "UPDATE instances SET name = ?, folder_name = ?, icon_key = ?, icon_background = ?, \
             icon_foreground = ?, memory_min_mb = ?, memory_max_mb = ?, minecraft_version = ?, loader_type = ?, loader_version = ?, \
             status = ?, game_dir = ?, bedrock_profile_mode = ? WHERE id = ?",
        )
        .bind(&name)
        .bind(&folder_name)
        .bind(&request.icon_key)
        .bind(&request.icon_background)
        .bind(&request.icon_foreground)
        .bind(request.memory_min_mb)
        .bind(request.memory_max_mb)
        .bind(&minecraft_version)
        .bind(&loader_type)
        .bind(&loader_version)
        .bind(next_status)
        .bind(new_game.to_string_lossy().into_owned())
        .bind(&bedrock_profile_mode)
        .bind(&instance.id)
        .execute(&mut *transaction)
        .await?;
        if moved {
            sqlx::query(
                "UPDATE installed_content SET file_path = replace(file_path, ?, ?) WHERE instance_id = ?",
            )
            .bind(old_game.to_string_lossy().into_owned())
            .bind(new_game.to_string_lossy().into_owned())
            .bind(&instance.id)
            .execute(&mut *transaction)
            .await?;
            sqlx::query(
                "UPDATE launch_history SET log_path = replace(log_path, ?, ?) WHERE instance_id = ?",
            )
            .bind(old_root.to_string_lossy().into_owned())
            .bind(new_root.to_string_lossy().into_owned())
            .bind(&instance.id)
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;
        Ok(())
    }
    .await;
    if let Err(error) = update_result {
        if moved {
            let _ = rename_directory_case_safe(&new_root, &old_root).await;
        }
        return Err(error);
    }
    crate::database::instance(&state.database, &instance.id).await
}

pub async fn migrate_legacy_instance_folders(
    pool: &SqlitePool,
    paths: &PortablePaths,
) -> AppResult<()> {
    let rows: Vec<(String, String, String, String)> =
        sqlx::query_as("SELECT id, name, game_dir, folder_name FROM instances ORDER BY created_at")
            .fetch_all(pool)
            .await?;
    for (id, name, game_dir, existing_folder_name) in rows {
        let stored_game = PathBuf::from(&game_dir);
        let stored_root = stored_game.parent().map(Path::to_path_buf);
        let legacy_root = paths.instances.join(&id);

        let folder_name = if existing_folder_name.is_empty() {
            allocate_folder_name(
                paths,
                &name,
                legacy_root.exists().then_some(legacy_root.as_path()),
            )?
        } else {
            validate_display_name(&existing_folder_name)?
        };
        let new_root = paths.instances.join(&folder_name);
        let new_game = new_root.join("game");

        // Portable databases contain absolute paths. A relocated copy must only move a
        // directory derived from its current portable root, never the old stored location.
        if !new_root.exists() && legacy_root.exists() && !paths_match(&legacy_root, &new_root) {
            rename_directory_case_safe(&legacy_root, &new_root).await?;
        }

        let mut transaction = pool.begin().await?;
        sqlx::query("UPDATE instances SET folder_name = ?, game_dir = ? WHERE id = ?")
            .bind(&folder_name)
            .bind(new_game.to_string_lossy().into_owned())
            .bind(&id)
            .execute(&mut *transaction)
            .await?;
        sqlx::query(
            "UPDATE installed_content SET file_path = replace(file_path, ?, ?) WHERE instance_id = ?",
        )
        .bind(stored_game.to_string_lossy().into_owned())
        .bind(new_game.to_string_lossy().into_owned())
        .bind(&id)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            "UPDATE launch_history SET log_path = replace(log_path, ?, ?) WHERE instance_id = ?",
        )
        .bind(
            stored_root
                .as_deref()
                .unwrap_or_else(|| Path::new(&game_dir))
                .to_string_lossy()
                .into_owned(),
        )
        .bind(new_root.to_string_lossy().into_owned())
        .bind(&id)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
    }
    Ok(())
}

pub async fn delete_instance(
    state: &AppState,
    instance_id: &str,
) -> AppResult<DeleteInstanceResult> {
    let instance = crate::database::instance(&state.database, instance_id).await?;
    if instance.status == "running" || state.running_instances.read().await.contains(instance_id) {
        return Err(AppError::Conflict(
            "Stop Minecraft before deleting this instance".into(),
        ));
    }

    let instance_root =
        validated_instance_root(&state.paths, &instance.folder_name, &instance.game_dir)?;
    if instance_root.exists() {
        // Deletion is intentionally immediate and permanent. The user has
        // explicitly disabled deleted-instance backups, so do not stage the
        // root under data/backups or insert a backup record.
        tokio::fs::remove_dir_all(&instance_root).await?;
    }

    let mut transaction = state.database.begin().await?;
    sqlx::query("DELETE FROM instances WHERE id = ?")
        .bind(instance_id)
        .execute(&mut *transaction)
        .await?;
    transaction.commit().await?;

    Ok(DeleteInstanceResult {
        instance_id: instance_id.to_owned(),
        backup_path: None,
    })
}

pub(crate) fn validated_instance_root(
    paths: &PortablePaths,
    folder_name: &str,
    game_dir: &str,
) -> AppResult<std::path::PathBuf> {
    let safe_folder = validate_display_name(folder_name)?;
    let instance_root = paths.instances.join(safe_folder);
    if !paths_match(Path::new(game_dir), &instance_root.join("game")) {
        return Err(AppError::Security(
            "Instance directory does not match the portable instance root".into(),
        ));
    }
    Ok(instance_root)
}

fn allocate_folder_name(
    paths: &PortablePaths,
    display_name: &str,
    current_root: Option<&Path>,
) -> AppResult<String> {
    let base = validate_display_name(display_name)?;
    for suffix in 1..=999_u32 {
        let candidate = if suffix == 1 {
            base.clone()
        } else {
            let tail = format!(" ({suffix})");
            let keep = 80_usize.saturating_sub(tail.chars().count());
            format!(
                "{}{}",
                base.chars().take(keep).collect::<String>().trim_end(),
                tail
            )
        };
        let path = paths.instances.join(&candidate);
        if current_root.is_some_and(|root| paths_match(root, &path)) || !path.exists() {
            return Ok(candidate);
        }
    }
    Err(AppError::Conflict(
        "Could not allocate a unique instance folder name".into(),
    ))
}

async fn rename_directory_case_safe(source: &Path, destination: &Path) -> AppResult<()> {
    if paths_match(source, destination) && source != destination {
        let temporary = source.with_file_name(format!(".slh-rename-{}", Uuid::new_v4()));
        tokio::fs::rename(source, &temporary).await?;
        if let Err(error) = tokio::fs::rename(&temporary, destination).await {
            let _ = tokio::fs::rename(&temporary, source).await;
            return Err(error.into());
        }
    } else if source != destination {
        tokio::fs::rename(source, destination).await?;
    }
    Ok(())
}

fn validate_icon(value: &str) -> AppResult<()> {
    if INSTANCE_ICONS.contains(&value) {
        Ok(())
    } else {
        Err(AppError::InvalidInput("Unknown instance icon".into()))
    }
}

fn validate_hex_color(value: &str) -> AppResult<()> {
    if value.len() == 7
        && value.starts_with('#')
        && value[1..]
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        Ok(())
    } else {
        Err(AppError::InvalidInput(
            "Instance icon colors must use #RRGGBB".into(),
        ))
    }
}

fn default_icon_colors(loader: &str) -> (&'static str, &'static str) {
    match loader {
        "vanilla" => ("#3f493c", "#f0f4ed"),
        "fabric" => ("#4d4033", "#f1e8dd"),
        "forge" => ("#503d34", "#f2e5dc"),
        "neoforge" => ("#51352f", "#f3dfd9"),
        "quilt" => ("#43374e", "#eee7f5"),
        "bedrock" => ("#355b76", "#edf7ff"),
        _ => ("#3a3f45", "#eef0f2"),
    }
}

fn paths_match(left: &Path, right: &Path) -> bool {
    #[cfg(windows)]
    {
        fn key(path: &Path) -> String {
            let value = path
                .to_string_lossy()
                .replace('/', "\\")
                .trim_end_matches('\\')
                .to_lowercase();
            if let Some(rest) = value.strip_prefix(r"\\?\unc\") {
                format!(r"\\{rest}")
            } else if let Some(rest) = value.strip_prefix(r"\\?\") {
                rest.to_owned()
            } else {
                value
            }
        }
        key(left) == key(right)
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_windows_reserved_names_and_unsafe_characters() {
        assert!(validate_display_name("Cobblemon 1.20.1").is_ok());
        assert!(validate_display_name("CON").is_err());
        assert!(validate_display_name("bad/name").is_err());
        assert!(validate_display_name("trailing.").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn deletion_target_accepts_windows_case_and_separator_variants() {
        let paths = PortablePaths::from_executable(
            Path::new(r"C:\SLH Portable\SLH.exe"),
            Some(r"D:\Games\SLH".into()),
        )
        .unwrap();
        let id = "62dcc977-d80f-46ba-831b-5aee58d29801";
        assert!(
            validated_instance_root(
                &paths,
                id,
                r"\\?\d:/games/slh/data/instances/62DCC977-D80F-46BA-831B-5AEE58D29801/game"
            )
            .is_ok()
        );
    }

    #[test]
    fn deletion_target_cannot_escape_the_portable_instance_root() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("Игры SLH");
        let paths = PortablePaths::from_executable(
            &root.join("SLH.exe"),
            Some(root.clone()),
        )
        .unwrap();
        let id = "62dcc977-d80f-46ba-831b-5aee58d29801";
        assert!(
            validated_instance_root(
                &paths,
                id,
                &paths.instances.join(id).join("game").to_string_lossy()
            )
            .is_ok()
        );
        assert!(validated_instance_root(&paths, id, &directory.path().join("other/game").to_string_lossy()).is_err());
    }

    #[tokio::test]
    async fn relocation_migration_never_moves_the_stored_external_directory() {
        let current = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        let paths = PortablePaths::from_executable(
            &current.path().join("SLH.exe"),
            Some(current.path().to_path_buf()),
        )
        .unwrap();
        paths.initialize().unwrap();

        let id = "62dcc977-d80f-46ba-831b-5aee58d29801";
        let current_legacy = paths.instances.join(id);
        std::fs::create_dir_all(current_legacy.join("game")).unwrap();
        std::fs::write(current_legacy.join("game").join("current.txt"), b"current").unwrap();

        let external_root = external.path().join(id);
        let external_game = external_root.join("game");
        std::fs::create_dir_all(&external_game).unwrap();
        std::fs::write(external_game.join("original.txt"), b"original").unwrap();

        let pool = crate::database::connect(&paths).await.unwrap();
        sqlx::query(
            "INSERT INTO instances(id, name, minecraft_version, game_dir) VALUES (?, ?, ?, ?)",
        )
        .bind(id)
        .bind("Сборка с пробелом")
        .bind("1.21.1")
        .bind(external_game.to_string_lossy().into_owned())
        .execute(&pool)
        .await
        .unwrap();

        migrate_legacy_instance_folders(&pool, &paths)
            .await
            .unwrap();

        let migrated: (String, String) =
            sqlx::query_as("SELECT folder_name, game_dir FROM instances WHERE id = ?")
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap();
        let expected_root = paths.instances.join(&migrated.0);
        assert_eq!(PathBuf::from(migrated.1), expected_root.join("game"));
        assert!(expected_root.join("game").join("current.txt").exists());
        assert!(external_game.join("original.txt").exists());
        assert!(!current_legacy.exists());
    }
}
