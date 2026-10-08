use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use sqlx::{Row, SqlitePool};
use tokio::io::AsyncReadExt;
use uuid::Uuid;
use walkdir::WalkDir;

use crate::database;
use crate::error::{AppError, AppResult};
use crate::models::{CreateSyncMappingRequest, Instance, SyncMapping, SyncRunResult};
use crate::security::validate_relative_path;
use crate::state::AppState;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SyncPhase {
    Pull,
    Push,
}

impl SyncPhase {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pull => "pull",
            Self::Push => "push",
        }
    }
}

#[derive(Default)]
struct Counters {
    copied: u64,
    unchanged: u64,
    backups: u64,
}

#[derive(Deserialize)]
struct SyncSettings {
    #[serde(rename = "worldsEnabled", default)]
    worlds_enabled: bool,
}

pub async fn list_mappings(pool: &SqlitePool) -> AppResult<Vec<SyncMapping>> {
    let rows = sqlx::query(
        "SELECT id, category, scope_ids_json, direction, enabled, source_relative_path, \
         target_relative_path, safety_level, last_sync_at, created_at \
         FROM sync_mappings ORDER BY created_at",
    )
    .fetch_all(pool)
    .await?;
    rows.into_iter().map(row_to_mapping).collect()
}

pub async fn create_mapping(
    state: &AppState,
    request: CreateSyncMappingRequest,
) -> AppResult<SyncMapping> {
    if request.instance_ids.is_empty() {
        return Err(AppError::InvalidInput(
            "Select at least one instance for synchronization".into(),
        ));
    }
    if !matches!(
        request.direction.as_str(),
        "pull" | "push" | "bidirectional"
    ) {
        return Err(AppError::InvalidInput(
            "Sync direction must be pull, push, or bidirectional".into(),
        ));
    }
    let (shared_relative, instance_relative, safety) = category_paths(&request.category)?;
    validate_relative_path(Path::new(&shared_relative))?;
    validate_relative_path(Path::new(&instance_relative))?;

    let all_instances = request.instance_ids.len() == 1 && request.instance_ids[0] == "*";
    let mut instances = Vec::new();
    let mut unique = BTreeSet::new();
    if all_instances {
        unique.insert("*".to_owned());
        instances = database::instances(&state.database).await?;
    } else {
        for id in &request.instance_ids {
            if id == "*" {
                return Err(AppError::InvalidInput(
                    "All-instances scope cannot be combined with individual instances".into(),
                ));
            }
            if !unique.insert(id.clone()) {
                continue;
            }
            instances.push(database::instance(&state.database, id).await?);
        }
    }
    if instances.is_empty() && !(all_instances && request.initial_source == "shared") {
        return Err(AppError::InvalidInput(
            "Create an instance or use shared storage as the initial source".into(),
        ));
    }
    if request.category == "worlds" {
        let settings: SyncSettings =
            serde_json::from_value(database::setting(&state.database, "sync").await?)?;
        if !settings.worlds_enabled || !request.acknowledge_world_risk {
            return Err(AppError::Security(
                "World sync requires enabling it in settings and explicit risk acknowledgement"
                    .into(),
            ));
        }
        let running = state.running_instances.read().await;
        if instances
            .iter()
            .any(|instance| running.contains(&instance.id))
        {
            return Err(AppError::Conflict(
                "World sync cannot be configured while a selected instance is running".into(),
            ));
        }
    }
    if request.initial_source != "shared"
        && !instances
            .iter()
            .any(|instance| instance.id == request.initial_source)
    {
        return Err(AppError::InvalidInput(
            "Initial source must be shared or one of the selected instances".into(),
        ));
    }

    let id = Uuid::new_v4().to_string();
    let scope_json = serde_json::to_string(&unique.into_iter().collect::<Vec<_>>())?;
    sqlx::query(
        "INSERT INTO sync_mappings(id, category, scope_type, scope_ids_json, direction, enabled, \
         source_relative_path, target_relative_path, safety_level) \
         VALUES (?, ?, 'instances', ?, ?, 0, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&request.category)
    .bind(scope_json)
    .bind(&request.direction)
    .bind(&shared_relative)
    .bind(&instance_relative)
    .bind(safety)
    .execute(&state.database)
    .await?;

    let initialize_result = initialize_mapping(
        state,
        &id,
        &shared_relative,
        &instance_relative,
        &instances,
        &request.initial_source,
        request.category == "worlds",
    )
    .await;
    if let Err(error) = initialize_result {
        let _ = sqlx::query("DELETE FROM sync_mappings WHERE id = ?")
            .bind(&id)
            .execute(&state.database)
            .await;
        return Err(error);
    }
    sqlx::query("UPDATE sync_mappings SET enabled = 1, last_sync_at = ? WHERE id = ?")
        .bind(Utc::now().to_rfc3339())
        .bind(&id)
        .execute(&state.database)
        .await?;
    mapping(&state.database, &id).await
}

pub async fn set_mapping_enabled(
    state: &AppState,
    mapping_id: &str,
    enabled: bool,
) -> AppResult<SyncMapping> {
    let affected = sqlx::query("UPDATE sync_mappings SET enabled = ? WHERE id = ?")
        .bind(enabled)
        .bind(mapping_id)
        .execute(&state.database)
        .await?
        .rows_affected();
    if affected == 0 {
        return Err(AppError::NotFound(format!("Sync mapping {mapping_id}")));
    }
    mapping(&state.database, mapping_id).await
}

pub async fn delete_mapping(state: &AppState, mapping_id: &str) -> AppResult<()> {
    let affected = sqlx::query("DELETE FROM sync_mappings WHERE id = ?")
        .bind(mapping_id)
        .execute(&state.database)
        .await?
        .rows_affected();
    if affected == 0 {
        return Err(AppError::NotFound(format!("Sync mapping {mapping_id}")));
    }
    Ok(())
}

pub async fn run_for_instance(
    state: &AppState,
    instance: &Instance,
    phase: SyncPhase,
) -> AppResult<Vec<SyncRunResult>> {
    let mappings = list_mappings(&state.database).await?;
    let mut results = Vec::new();
    for mapping in mappings.into_iter().filter(|mapping| {
        mapping.enabled
            && mapping
                .instance_ids
                .iter()
                .any(|id| id == "*" || id == &instance.id)
            && match (mapping.direction.as_str(), phase) {
                ("pull", SyncPhase::Pull) | ("push", SyncPhase::Push) => true,
                ("bidirectional", _) => true,
                _ => false,
            }
    }) {
        if mapping.category == "worlds"
            && state.running_instances.read().await.contains(&instance.id)
        {
            return Err(AppError::Conflict(
                "World sync is blocked while the instance is running".into(),
            ));
        }
        let mut counters = Counters::default();
        sync_roots(state, &mapping, instance, phase, false, &mut counters).await?;
        sqlx::query("UPDATE sync_mappings SET last_sync_at = ? WHERE id = ?")
            .bind(Utc::now().to_rfc3339())
            .bind(&mapping.id)
            .execute(&state.database)
            .await?;
        results.push(SyncRunResult {
            mapping_id: mapping.id,
            instance_id: instance.id.clone(),
            phase: phase.as_str().into(),
            copied_files: counters.copied,
            unchanged_files: counters.unchanged,
            backups_created: counters.backups,
        });
    }
    Ok(results)
}

pub async fn apply_to_new_instance(
    state: &AppState,
    instance: &Instance,
) -> AppResult<Vec<SyncRunResult>> {
    run_for_instance(state, instance, SyncPhase::Pull).await
}

pub async fn run_mapping_now(
    state: &AppState,
    mapping_id: &str,
    source_instance_id: &str,
) -> AppResult<Vec<SyncRunResult>> {
    let mapping = mapping(&state.database, mapping_id).await?;
    if !mapping.enabled {
        return Err(AppError::Conflict(
            "Enable this sync mapping before running it".into(),
        ));
    }
    let instances = if mapping.instance_ids.iter().any(|id| id == "*") {
        database::instances(&state.database).await?
    } else {
        let mut instances = Vec::new();
        for id in &mapping.instance_ids {
            instances.push(database::instance(&state.database, id).await?);
        }
        instances
    };
    let source = instances
        .iter()
        .find(|instance| instance.id == source_instance_id)
        .ok_or_else(|| {
            AppError::InvalidInput("The chosen source is outside this mapping".into())
        })?;
    if mapping.category == "worlds" {
        let running = state.running_instances.read().await;
        if instances
            .iter()
            .any(|instance| running.contains(&instance.id))
        {
            return Err(AppError::Conflict(
                "World sync is blocked while any mapped instance is running".into(),
            ));
        }
    }

    let mut results = Vec::new();
    let mut source_counters = Counters::default();
    sync_roots(
        state,
        &mapping,
        source,
        SyncPhase::Push,
        true,
        &mut source_counters,
    )
    .await?;
    results.push(SyncRunResult {
        mapping_id: mapping.id.clone(),
        instance_id: source.id.clone(),
        phase: SyncPhase::Push.as_str().into(),
        copied_files: source_counters.copied,
        unchanged_files: source_counters.unchanged,
        backups_created: source_counters.backups,
    });
    for instance in instances.iter().filter(|instance| instance.id != source.id) {
        let mut counters = Counters::default();
        sync_roots(
            state,
            &mapping,
            instance,
            SyncPhase::Pull,
            true,
            &mut counters,
        )
        .await?;
        results.push(SyncRunResult {
            mapping_id: mapping.id.clone(),
            instance_id: instance.id.clone(),
            phase: SyncPhase::Pull.as_str().into(),
            copied_files: counters.copied,
            unchanged_files: counters.unchanged,
            backups_created: counters.backups,
        });
    }
    sqlx::query("UPDATE sync_mappings SET last_sync_at = ? WHERE id = ?")
        .bind(Utc::now().to_rfc3339())
        .bind(&mapping.id)
        .execute(&state.database)
        .await?;
    Ok(results)
}

async fn initialize_mapping(
    state: &AppState,
    mapping_id: &str,
    shared_relative: &str,
    instance_relative: &str,
    instances: &[Instance],
    initial_source: &str,
    worlds: bool,
) -> AppResult<()> {
    let mapping = SyncMapping {
        id: mapping_id.into(),
        category: if worlds { "worlds" } else { "initial" }.into(),
        instance_ids: instances.iter().map(|item| item.id.clone()).collect(),
        direction: "bidirectional".into(),
        enabled: false,
        source_relative_path: shared_relative.into(),
        target_relative_path: instance_relative.into(),
        safety_level: if worlds { "danger" } else { "normal" }.into(),
        last_sync_at: None,
        created_at: Utc::now().to_rfc3339(),
    };
    if initial_source == "shared" {
        for instance in instances {
            let mut counters = Counters::default();
            sync_roots(
                state,
                &mapping,
                instance,
                SyncPhase::Pull,
                true,
                &mut counters,
            )
            .await?;
        }
    } else {
        let source = instances
            .iter()
            .find(|instance| instance.id == initial_source)
            .ok_or_else(|| AppError::InvalidInput("Initial instance was not found".into()))?;
        let mut counters = Counters::default();
        sync_roots(
            state,
            &mapping,
            source,
            SyncPhase::Push,
            true,
            &mut counters,
        )
        .await?;
        for instance in instances.iter().filter(|item| item.id != source.id) {
            let mut counters = Counters::default();
            sync_roots(
                state,
                &mapping,
                instance,
                SyncPhase::Pull,
                true,
                &mut counters,
            )
            .await?;
        }
    }
    Ok(())
}

async fn sync_roots(
    state: &AppState,
    mapping: &SyncMapping,
    instance: &Instance,
    phase: SyncPhase,
    force: bool,
    counters: &mut Counters,
) -> AppResult<()> {
    let shared = state.paths.shared.join(&mapping.source_relative_path);
    let local = PathBuf::from(&instance.game_dir).join(&mapping.target_relative_path);
    let (source, target) = match phase {
        SyncPhase::Pull => (&shared, &local),
        SyncPhase::Push => (&local, &shared),
    };
    if source.is_file() || (!source.exists() && target.extension().is_some()) {
        sync_file(
            state,
            mapping,
            instance,
            Path::new(""),
            &shared,
            &local,
            phase,
            force,
            counters,
        )
        .await?;
        return Ok(());
    }
    let mut relatives = collect_files(source)?;
    if mapping.direction == "bidirectional" {
        relatives.extend(collect_files(target)?);
    }
    for relative in relatives {
        sync_file(
            state,
            mapping,
            instance,
            &relative,
            &shared.join(&relative),
            &local.join(&relative),
            phase,
            force,
            counters,
        )
        .await?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn sync_file(
    state: &AppState,
    mapping: &SyncMapping,
    instance: &Instance,
    relative: &Path,
    shared: &Path,
    local: &Path,
    phase: SyncPhase,
    force: bool,
    counters: &mut Counters,
) -> AppResult<()> {
    let shared_hash = file_hash(shared).await?;
    let local_hash = file_hash(local).await?;
    let (source, target, source_hash, target_hash) = match phase {
        SyncPhase::Pull => (shared, local, &shared_hash, &local_hash),
        SyncPhase::Push => (local, shared, &local_hash, &shared_hash),
    };
    let Some(source_hash) = source_hash else {
        write_snapshot(
            state,
            mapping,
            instance,
            relative,
            shared_hash,
            local_hash,
            phase,
        )
        .await?;
        counters.unchanged += 1;
        return Ok(());
    };
    if target_hash.as_ref() == Some(source_hash) {
        write_snapshot(
            state,
            mapping,
            instance,
            relative,
            shared_hash,
            local_hash,
            phase,
        )
        .await?;
        counters.unchanged += 1;
        return Ok(());
    }

    if !force && mapping.direction == "bidirectional" {
        if let Some((old_shared, old_local)) =
            previous_hashes(state, mapping, instance, relative).await?
        {
            let shared_changed = shared_hash != old_shared;
            let local_changed = local_hash != old_local;
            if is_conflict(&old_shared, &old_local, &shared_hash, &local_hash) {
                return Err(AppError::Conflict(format!(
                    "Sync conflict in {} for instance {}: both copies changed",
                    relative.display(),
                    instance.name
                )));
            }
            let source_changed = match phase {
                SyncPhase::Pull => shared_changed,
                SyncPhase::Push => local_changed,
            };
            if !source_changed {
                write_snapshot(
                    state,
                    mapping,
                    instance,
                    relative,
                    shared_hash,
                    local_hash,
                    phase,
                )
                .await?;
                counters.unchanged += 1;
                return Ok(());
            }
        }
    }
    if target.exists() {
        create_backup(state, mapping, instance, relative, target).await?;
        counters.backups += 1;
    }
    atomic_copy(source, target).await?;
    counters.copied += 1;
    let new_shared = file_hash(shared).await?;
    let new_local = file_hash(local).await?;
    write_snapshot(
        state, mapping, instance, relative, new_shared, new_local, phase,
    )
    .await?;
    Ok(())
}

fn is_conflict(
    old_shared: &Option<String>,
    old_local: &Option<String>,
    new_shared: &Option<String>,
    new_local: &Option<String>,
) -> bool {
    new_shared != old_shared && new_local != old_local && new_shared != new_local
}

fn collect_files(root: &Path) -> AppResult<BTreeSet<PathBuf>> {
    let mut files = BTreeSet::new();
    if !root.exists() || root.is_file() {
        return Ok(files);
    }
    for entry in WalkDir::new(root).follow_links(false) {
        let entry = entry.map_err(|error| AppError::Io(std::io::Error::other(error)))?;
        if entry.file_type().is_symlink() {
            return Err(AppError::Security(format!(
                "Symlink is not allowed in sync source: {}",
                entry.path().display()
            )));
        }
        if entry.file_type().is_file() {
            let relative = entry
                .path()
                .strip_prefix(root)
                .map_err(|_| AppError::Security("Sync path escaped its root".into()))?
                .to_path_buf();
            validate_relative_path(&relative)?;
            files.insert(relative);
        }
    }
    Ok(files)
}

async fn file_hash(path: &Path) -> AppResult<Option<String>> {
    if !path.exists() {
        return Ok(None);
    }
    if !path.is_file() {
        return Err(AppError::InvalidInput(format!(
            "Expected a file during sync: {}",
            path.display()
        )));
    }
    let mut file = tokio::fs::File::open(path).await?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 128 * 1024];
    loop {
        let read = file.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(Some(hex::encode(hasher.finalize())))
}

async fn atomic_copy(source: &Path, target: &Path) -> AppResult<()> {
    let parent = target
        .parent()
        .ok_or_else(|| AppError::InvalidInput("Sync destination has no parent".into()))?;
    tokio::fs::create_dir_all(parent).await?;
    let temporary = parent.join(format!(".slh-sync-{}.tmp", Uuid::new_v4()));
    tokio::fs::copy(source, &temporary).await?;
    if target.exists() {
        tokio::fs::remove_file(target).await?;
    }
    tokio::fs::rename(&temporary, target).await?;
    Ok(())
}

async fn create_backup(
    state: &AppState,
    mapping: &SyncMapping,
    instance: &Instance,
    relative: &Path,
    source: &Path,
) -> AppResult<()> {
    let backup_id = Uuid::new_v4().to_string();
    let safe_relative = if relative.as_os_str().is_empty() {
        source
            .file_name()
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("file"))
    } else {
        relative.to_path_buf()
    };
    let backup = state
        .paths
        .backups
        .join("sync")
        .join(&mapping.id)
        .join(&instance.id)
        .join(Utc::now().format("%Y%m%d-%H%M%S-%3f").to_string())
        .join(safe_relative);
    let parent = backup
        .parent()
        .ok_or_else(|| AppError::InvalidInput("Backup path has no parent".into()))?;
    tokio::fs::create_dir_all(parent).await?;
    let size = tokio::fs::copy(source, &backup).await?;
    sqlx::query(
        "INSERT INTO backups(id, mapping_id, instance_id, backup_type, source_path, backup_path, size_bytes) \
         VALUES (?, ?, ?, 'sync-overwrite', ?, ?, ?)",
    )
    .bind(backup_id)
    .bind(&mapping.id)
    .bind(&instance.id)
    .bind(source.to_string_lossy().into_owned())
    .bind(backup.to_string_lossy().into_owned())
    .bind(size as i64)
    .execute(&state.database)
    .await?;
    Ok(())
}

async fn previous_hashes(
    state: &AppState,
    mapping: &SyncMapping,
    instance: &Instance,
    relative: &Path,
) -> AppResult<Option<(Option<String>, Option<String>)>> {
    let row = sqlx::query(
        "SELECT shared_hash, instance_hash FROM sync_snapshots \
         WHERE mapping_id = ? AND instance_id = ? AND relative_path = ?",
    )
    .bind(&mapping.id)
    .bind(&instance.id)
    .bind(relative.to_string_lossy().into_owned())
    .fetch_optional(&state.database)
    .await?;
    Ok(row.map(|row| (row.get("shared_hash"), row.get("instance_hash"))))
}

async fn write_snapshot(
    state: &AppState,
    mapping: &SyncMapping,
    instance: &Instance,
    relative: &Path,
    shared_hash: Option<String>,
    instance_hash: Option<String>,
    phase: SyncPhase,
) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO sync_snapshots(mapping_id, instance_id, relative_path, shared_hash, instance_hash, last_direction, synced_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(mapping_id, instance_id, relative_path) DO UPDATE SET \
         shared_hash = excluded.shared_hash, instance_hash = excluded.instance_hash, \
         last_direction = excluded.last_direction, synced_at = excluded.synced_at",
    )
    .bind(&mapping.id)
    .bind(&instance.id)
    .bind(relative.to_string_lossy().into_owned())
    .bind(shared_hash)
    .bind(instance_hash)
    .bind(phase.as_str())
    .bind(Utc::now().to_rfc3339())
    .execute(&state.database)
    .await?;
    Ok(())
}

async fn mapping(pool: &SqlitePool, id: &str) -> AppResult<SyncMapping> {
    let row = sqlx::query(
        "SELECT id, category, scope_ids_json, direction, enabled, source_relative_path, \
         target_relative_path, safety_level, last_sync_at, created_at FROM sync_mappings WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("Sync mapping {id}")))?;
    row_to_mapping(row)
}

fn row_to_mapping(row: sqlx::sqlite::SqliteRow) -> AppResult<SyncMapping> {
    Ok(SyncMapping {
        id: row.get("id"),
        category: row.get("category"),
        instance_ids: serde_json::from_str(&row.get::<String, _>("scope_ids_json"))?,
        direction: row.get("direction"),
        enabled: row.get("enabled"),
        source_relative_path: row.get("source_relative_path"),
        target_relative_path: row.get("target_relative_path"),
        safety_level: row.get("safety_level"),
        last_sync_at: row.get("last_sync_at"),
        created_at: row.get("created_at"),
    })
}

fn category_paths(category: &str) -> AppResult<(String, String, &'static str)> {
    let paths = match category {
        "options" => ("options/options.txt", "options.txt", "normal"),
        "servers" => ("servers/servers.dat", "servers.dat", "normal"),
        "resourcepacks" => ("resourcepacks", "resourcepacks", "normal"),
        "screenshots" => ("screenshots", "screenshots", "normal"),
        "mod-configs" => ("mod-configs", "config", "caution"),
        "worlds" => ("worlds", "saves", "danger"),
        _ => {
            return Err(AppError::InvalidInput(format!(
                "Unsupported sync category: {category}"
            )));
        }
    };
    Ok((paths.0.into(), paths.1.into(), paths.2))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn categories_map_to_safe_relative_paths() {
        for category in [
            "options",
            "servers",
            "resourcepacks",
            "screenshots",
            "mod-configs",
            "worlds",
        ] {
            let (shared, local, _) = category_paths(category).unwrap();
            validate_relative_path(Path::new(&shared)).unwrap();
            validate_relative_path(Path::new(&local)).unwrap();
        }
    }

    #[test]
    fn unknown_category_is_rejected() {
        assert!(category_paths("../escape").is_err());
    }

    #[test]
    fn detects_two_sided_changes_but_not_one_sided_updates() {
        let old_shared = Some("same".into());
        let old_local = Some("same".into());
        assert!(is_conflict(
            &old_shared,
            &old_local,
            &Some("shared-new".into()),
            &Some("local-new".into())
        ));
        assert!(!is_conflict(
            &old_shared,
            &old_local,
            &Some("shared-new".into()),
            &old_local
        ));
        assert!(!is_conflict(
            &old_shared,
            &old_local,
            &Some("both-new".into()),
            &Some("both-new".into())
        ));
    }
}
