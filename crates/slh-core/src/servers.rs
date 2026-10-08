use std::collections::HashMap;
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::database;
use crate::error::{AppError, AppResult};
use crate::models::{AddServerRequest, ServerEntry};
use crate::state::AppState;

const MAX_SERVERS_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_SERVERS: usize = 10_000;

#[derive(Default, Deserialize, Serialize)]
struct ServerRoot {
    #[serde(default)]
    servers: Vec<ServerRecord>,
    #[serde(flatten)]
    extra: HashMap<String, fastnbt::Value>,
}

#[derive(Deserialize, Serialize)]
struct ServerRecord {
    name: String,
    ip: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    icon: Option<String>,
    #[serde(
        default,
        rename = "acceptTextures",
        skip_serializing_if = "Option::is_none"
    )]
    accept_textures: Option<i8>,
    #[serde(flatten)]
    extra: HashMap<String, fastnbt::Value>,
}

pub async fn list(state: &AppState, instance_id: &str) -> AppResult<Vec<ServerEntry>> {
    let path = servers_path(state, instance_id).await?;
    let root = tokio::task::spawn_blocking(move || read_server_root(&path))
        .await
        .map_err(|error| AppError::Process(format!("Server list task failed: {error}")))??;
    Ok(root
        .servers
        .into_iter()
        .enumerate()
        .map(|(index, server)| ServerEntry {
            index: index as u32,
            name: server.name,
            address: server.ip,
            accept_textures: server.accept_textures.map(|value| value != 0),
            has_icon: server.icon.is_some(),
        })
        .collect())
}

pub async fn add(state: &AppState, request: AddServerRequest) -> AppResult<Vec<ServerEntry>> {
    ensure_instance_idle(state, &request.instance_id).await?;
    let name = validate_name(&request.name)?;
    let address = validate_address(&request.address)?;
    let path = servers_path(state, &request.instance_id).await?;
    let backups = state.paths.backups.clone();
    let instance_id = request.instance_id.clone();
    let backup = tokio::task::spawn_blocking(move || {
        let mut root = read_server_root(&path)?;
        if root.servers.iter().any(|server| {
            server.name.eq_ignore_ascii_case(&name) && server.ip.eq_ignore_ascii_case(&address)
        }) {
            return Err(AppError::Conflict(format!(
                "Server {name} ({address}) is already in this instance"
            )));
        }
        if root.servers.len() >= MAX_SERVERS {
            return Err(AppError::Security(
                "Server list contains too many entries".into(),
            ));
        }
        root.servers.push(ServerRecord {
            name,
            ip: address,
            icon: None,
            accept_textures: None,
            extra: HashMap::new(),
        });
        write_server_root(&path, &backups, &instance_id, &root)
    })
    .await
    .map_err(|error| AppError::Process(format!("Server update task failed: {error}")))??;
    record_backup(state, &request.instance_id, backup).await?;
    list(state, &request.instance_id).await
}

pub async fn remove(
    state: &AppState,
    instance_id: &str,
    index: u32,
) -> AppResult<Vec<ServerEntry>> {
    ensure_instance_idle(state, instance_id).await?;
    let path = servers_path(state, instance_id).await?;
    let backups = state.paths.backups.clone();
    let owned_instance_id = instance_id.to_owned();
    let backup = tokio::task::spawn_blocking(move || {
        let mut root = read_server_root(&path)?;
        if index as usize >= root.servers.len() {
            return Err(AppError::NotFound(format!("Server entry {index}")));
        }
        root.servers.remove(index as usize);
        write_server_root(&path, &backups, &owned_instance_id, &root)
    })
    .await
    .map_err(|error| AppError::Process(format!("Server removal task failed: {error}")))??;
    record_backup(state, instance_id, backup).await?;
    list(state, instance_id).await
}

async fn ensure_instance_idle(state: &AppState, instance_id: &str) -> AppResult<()> {
    if state.running_instances.read().await.contains(instance_id) {
        return Err(AppError::Conflict(
            "servers.dat cannot be changed while the instance is running".into(),
        ));
    }
    Ok(())
}

async fn servers_path(state: &AppState, instance_id: &str) -> AppResult<PathBuf> {
    let instance = database::instance(&state.database, instance_id).await?;
    Ok(PathBuf::from(instance.game_dir).join("servers.dat"))
}

fn read_server_root(path: &Path) -> AppResult<ServerRoot> {
    if !path.exists() {
        return Ok(ServerRoot::default());
    }
    let metadata = std::fs::metadata(path)?;
    if !metadata.is_file() || metadata.len() > MAX_SERVERS_FILE_BYTES {
        return Err(AppError::Security(
            "servers.dat is not a regular file or exceeds 16 MiB".into(),
        ));
    }
    let bytes = std::fs::read(path)?;
    let root: ServerRoot = fastnbt::from_bytes(&bytes)
        .map_err(|error| AppError::InvalidInput(format!("servers.dat is invalid: {error}")))?;
    if root.servers.len() > MAX_SERVERS {
        return Err(AppError::Security(
            "Server list contains too many entries".into(),
        ));
    }
    Ok(root)
}

fn write_server_root(
    path: &Path,
    backups_root: &Path,
    instance_id: &str,
    root: &ServerRoot,
) -> AppResult<Option<BackupRecord>> {
    let bytes = fastnbt::to_bytes(root)
        .map_err(|error| AppError::Process(format!("Could not serialize servers.dat: {error}")))?;
    if bytes.len() as u64 > MAX_SERVERS_FILE_BYTES {
        return Err(AppError::Security(
            "Serialized servers.dat exceeds 16 MiB".into(),
        ));
    }
    let parent = path
        .parent()
        .ok_or_else(|| AppError::InvalidInput("servers.dat has no parent directory".into()))?;
    std::fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".servers-{}.tmp", Uuid::new_v4()));
    let mut output = File::create(&temporary)?;
    output.write_all(&bytes)?;
    output.sync_all()?;
    drop(output);

    let backup = if path.exists() {
        let backup_dir = backups_root.join("servers").join(instance_id);
        std::fs::create_dir_all(&backup_dir)?;
        let backup_path = backup_dir.join(format!(
            "{}-{}.dat",
            chrono::Utc::now().format("%Y%m%dT%H%M%S%.3fZ"),
            Uuid::new_v4()
        ));
        let size_bytes = std::fs::metadata(path)?.len();
        std::fs::rename(path, &backup_path)?;
        Some(BackupRecord {
            source_path: path.to_path_buf(),
            backup_path,
            size_bytes,
        })
    } else {
        None
    };
    if let Err(error) = std::fs::rename(&temporary, path) {
        let _ = std::fs::remove_file(&temporary);
        if let Some(backup) = &backup {
            let _ = std::fs::rename(&backup.backup_path, path);
        }
        return Err(error.into());
    }
    Ok(backup)
}

struct BackupRecord {
    source_path: PathBuf,
    backup_path: PathBuf,
    size_bytes: u64,
}

async fn record_backup(
    state: &AppState,
    instance_id: &str,
    backup: Option<BackupRecord>,
) -> AppResult<()> {
    let Some(backup) = backup else {
        return Ok(());
    };
    sqlx::query(
        "INSERT INTO backups(id, instance_id, backup_type, source_path, backup_path, size_bytes) \
         VALUES (?, ?, 'servers', ?, ?, ?)",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(instance_id)
    .bind(backup.source_path.to_string_lossy().into_owned())
    .bind(backup.backup_path.to_string_lossy().into_owned())
    .bind(backup.size_bytes as i64)
    .execute(&state.database)
    .await?;
    Ok(())
}

fn validate_name(value: &str) -> AppResult<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 128 || value.chars().any(char::is_control) {
        return Err(AppError::InvalidInput(
            "Server name must contain 1 to 128 printable characters".into(),
        ));
    }
    Ok(value.to_owned())
}

fn validate_address(value: &str) -> AppResult<String> {
    let value = value.trim();
    if value.is_empty()
        || value.chars().count() > 255
        || value
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        return Err(AppError::InvalidInput(
            "Server address must contain 1 to 255 non-whitespace characters".into(),
        ));
    }
    Ok(value.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_nbt_round_trip_preserves_entries() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("servers.dat");
        let backups = directory.path().join("backups");
        let root = ServerRoot {
            servers: vec![ServerRecord {
                name: "Local realm".into(),
                ip: "[::1]:25565".into(),
                icon: None,
                accept_textures: Some(1),
                extra: HashMap::new(),
            }],
            extra: HashMap::new(),
        };
        assert!(
            write_server_root(&path, &backups, "test", &root)
                .unwrap()
                .is_none()
        );
        let loaded = read_server_root(&path).unwrap();
        assert_eq!(loaded.servers.len(), 1);
        assert_eq!(loaded.servers[0].name, "Local realm");
        assert_eq!(loaded.servers[0].ip, "[::1]:25565");
        assert_eq!(loaded.servers[0].accept_textures, Some(1));
    }

    #[test]
    fn server_fields_reject_controls_and_whitespace_addresses() {
        assert!(validate_name("Play together").is_ok());
        assert!(validate_name("bad\nname").is_err());
        assert!(validate_address("play.example.net:25565").is_ok());
        assert!(validate_address("bad address").is_err());
    }
}
