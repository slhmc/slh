//! Minecraft's standard access lists. Never edit a running server's cached lists.
use super::{runtime, store};
use crate::{error::{AppError, AppResult}, state::AppState};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::{Path, PathBuf}, sync::LazyLock};
use tokio::sync::Mutex;

static EDIT: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
const KINDS: [&str; 4] = ["whitelist", "operators", "bannedPlayers", "bannedIps"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerLists {
    pub whitelist: Vec<Value>,
    pub operators: Vec<Value>,
    pub banned_players: Vec<Value>,
    pub banned_ips: Vec<Value>,
    pub revisions: BTreeMap<String, String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerEdit {
    pub kind: String,
    pub action: String,
    pub name: String,
    pub uuid: Option<String>,
    pub level: Option<u8>,
    pub reason: Option<String>,
    pub expected_revision: String,
}

fn file(root: &str, kind: &str) -> AppResult<PathBuf> {
    let filename = match kind {
        "whitelist" => "whitelist.json",
        "operators" => "ops.json",
        "bannedPlayers" => "banned-players.json",
        "bannedIps" => "banned-ips.json",
        _ => return Err(AppError::InvalidInput("serverPlayers.invalidInput".into())),
    };
    let path = Path::new(root).join(filename);
    store::plain_path(&path)?;
    Ok(path)
}

fn read(path: &Path, ip: bool) -> AppResult<(Vec<Value>, String)> {
    store::plain_path(path)?;
    let bytes = match std::fs::metadata(path) {
        Ok(meta) if meta.len() <= 2 * 1024 * 1024 => std::fs::read(path)?,
        Ok(_) => return Err(AppError::InvalidInput("serverPlayers.invalidFile".into())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((vec![], "missing".into())),
        Err(e) => return Err(e.into()),
    };
    let rows: Vec<Value> = serde_json::from_slice(&bytes)
        .map_err(|_| AppError::InvalidInput("serverPlayers.invalidFile".into()))?;
    if rows.iter().any(|v| !v.is_object() || if ip {
        v["ip"].as_str().and_then(|s| s.parse::<std::net::IpAddr>().ok()).is_none()
    } else {
        v["uuid"].as_str().and_then(|s| uuid::Uuid::parse_str(s).ok()).is_none() || v["name"].as_str().is_none()
    }) {
        return Err(AppError::InvalidInput("serverPlayers.invalidFile".into()));
    }
    Ok((rows, hex::encode(Sha256::digest(&bytes))))
}

pub async fn list(state: &AppState, id: &str) -> AppResult<PlayerLists> {
    let server = store::get(state, id).await?;
    store::plain_path(Path::new(&server.path))?;
    if !Path::new(&server.path).is_dir() { return Err(AppError::NotFound("serverLibrary.missingHint".into())); }
    let mut data = BTreeMap::new();
    let mut revisions = BTreeMap::new();
    for kind in KINDS {
        let (rows, revision) = read(&file(&server.path, kind)?, kind == "bannedIps")?;
        data.insert(kind, rows);
        revisions.insert(kind.into(), revision);
    }
    Ok(PlayerLists { whitelist: data.remove("whitelist").unwrap(), operators: data.remove("operators").unwrap(),
        banned_players: data.remove("bannedPlayers").unwrap(), banned_ips: data.remove("bannedIps").unwrap(), revisions })
}

fn player_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 16 && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

async fn identity(state: &AppState, root: &str, name: &str, supplied: Option<&str>, online: bool) -> AppResult<(String, String)> {
    if !player_name(name) { return Err(AppError::InvalidInput("serverPlayers.invalidName".into())); }
    if let Some(value) = supplied.filter(|s| !s.trim().is_empty()) {
        let id = uuid::Uuid::parse_str(value.trim()).map_err(|_| AppError::InvalidInput("serverPlayers.invalidUuid".into()))?;
        return Ok((name.into(), id.to_string()));
    }
    // A server's cache also covers proxy and authentication-plugin identities.
    let cache = Path::new(root).join("usercache.json");
    store::plain_path(&cache)?;
    if let Ok(meta) = std::fs::metadata(&cache) {
        if meta.len() <= 2 * 1024 * 1024 {
            if let Ok(rows) = serde_json::from_slice::<Vec<Value>>(&std::fs::read(&cache)?) {
                if let Some(row) = rows.iter().find(|v| v["name"].as_str().is_some_and(|s| s.eq_ignore_ascii_case(name))) {
                    if let Some(id) = row["uuid"].as_str().and_then(|s| uuid::Uuid::parse_str(s).ok()) {
                        return Ok((row["name"].as_str().unwrap().into(), id.to_string()));
                    }
                }
            }
        }
    }
    if !online { return Ok((name.into(), crate::accounts::offline_uuid(name).to_string())); }
    let response = state.http.get(format!("https://api.mojang.com/users/profiles/minecraft/{name}"))
        .timeout(std::time::Duration::from_secs(15)).send().await.map_err(|_| AppError::Unavailable("serverPlayers.profileUnavailable".into()))?;
    if !response.status().is_success() { return Err(AppError::Unavailable("serverPlayers.profileUnavailable".into())); }
    let profile: Value = response.json().await.map_err(|_| AppError::Unavailable("serverPlayers.profileUnavailable".into()))?;
    let id = profile["id"].as_str().and_then(|s| uuid::Uuid::parse_str(s).ok())
        .ok_or_else(|| AppError::Unavailable("serverPlayers.profileUnavailable".into()))?;
    let actual = profile["name"].as_str().filter(|s| player_name(s) && s.eq_ignore_ascii_case(name))
        .ok_or_else(|| AppError::Unavailable("serverPlayers.profileUnavailable".into()))?;
    Ok((actual.into(), id.to_string()))
}

pub async fn edit(state: &AppState, id: &str, request: PlayerEdit) -> AppResult<PlayerLists> {
    let _edit = EDIT.lock().await;
    let server = store::idle(state, id).await?;
    if !Path::new(&server.path).is_dir() { return Err(AppError::NotFound("serverLibrary.missingHint".into())); }
    let path = file(&server.path, &request.kind)?;
    if !["add", "remove"].contains(&request.action.as_str()) { return Err(AppError::InvalidInput("serverPlayers.invalidInput".into())); }
    let ip = request.kind == "bannedIps";
    let (mut rows, revision) = read(&path, ip)?;
    if revision != request.expected_revision { return Err(AppError::Conflict("serverPlayers.changed".into())); }
    let is_add = request.action == "add";
    let (name, key) = if ip {
        let address = request.name.trim().parse::<std::net::IpAddr>().map_err(|_| AppError::InvalidInput("serverPlayers.invalidIp".into()))?.to_string();
        (address.clone(), address)
    } else if !is_add {
        let id = request.uuid.as_deref().and_then(|s| uuid::Uuid::parse_str(s).ok())
            .ok_or_else(|| AppError::InvalidInput("serverPlayers.invalidUuid".into()))?;
        (request.name.clone(), id.to_string())
    } else {
        let config = store::read_config(state, id).await?;
        identity(state, &server.path, request.name.trim(), request.uuid.as_deref(), config.config.properties.get("online-mode").is_none_or(|s| s != "false")).await?
    };
    let reason = request.reason.as_deref().unwrap_or("").trim();
    if reason.len() > 512 || reason.chars().any(char::is_control) { return Err(AppError::InvalidInput("serverPlayers.invalidInput".into())); }
    let level = request.level.unwrap_or(4);
    if !(1..=4).contains(&level) { return Err(AppError::InvalidInput("serverPlayers.invalidInput".into())); }
    let matches = |row: &Value| if ip {
        row["ip"].as_str().and_then(|s| s.parse::<std::net::IpAddr>().ok()).is_some_and(|v| v.to_string() == key)
    } else { row["uuid"].as_str().and_then(|s| uuid::Uuid::parse_str(s).ok()).is_some_and(|v| v.to_string() == key) };
    if is_add {
        let mut value = rows.iter().find(|row| matches(row)).cloned().unwrap_or_else(|| json!({}));
        if ip { value["ip"] = json!(key); } else { value["uuid"] = json!(key); value["name"] = json!(name); }
        if request.kind == "operators" {
            value["level"] = json!(level);
            if value.get("bypassesPlayerLimit").is_none() { value["bypassesPlayerLimit"] = json!(false); }
        }
        if request.kind.starts_with("banned") {
            value["created"] = json!(chrono::Utc::now().format("%Y-%m-%d %H:%M:%S %z").to_string());
            value["source"] = json!("SLH"); value["expires"] = json!("forever");
            value["reason"] = json!(if reason.is_empty() { "Banned by an operator." } else { reason });
        }
        rows.retain(|row| !matches(row)); rows.push(value);
    } else { rows.retain(|row| !matches(row)); }
    // Resolve may await the network: verify both process state and disk revision again.
    store::idle(state, id).await?;
    if runtime::java_is_alive(state, id) || read(&path, ip)?.1 != revision {
        return Err(AppError::Conflict("serverPlayers.changed".into()));
    }
    let bytes = serde_json::to_vec_pretty(&rows)?;
    if bytes.len() > 2 * 1024 * 1024 { return Err(AppError::InvalidInput("serverPlayers.invalidFile".into())); }
    store::atomic_write(&path, &bytes)?;
    list(state, id).await
}
