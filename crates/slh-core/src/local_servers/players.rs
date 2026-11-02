//! Standard access lists: files while stopped, console commands while running.
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
    pub runtime_state: String,
    pub whitelist_enabled: bool,
    pub operator_level: u8,
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
    #[serde(default)]
    pub identity_provider: Option<String>,
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
    let mut config = store::read_config(state, id).await?.config;
    // This property is not managed by the settings form. Read it with the same
    // escaping/continuation rules without adding it to the saved profile.
    config.properties.insert("op-permission-level".into(), "4".into());
    let text = config.properties_text.clone();
    super::config::import_properties(&mut config, &text);
    let operator_level = config.properties.get("op-permission-level").and_then(|v| v.parse::<u8>().ok()).filter(|v| (1..=4).contains(v)).unwrap_or(4);
    Ok(PlayerLists { runtime_state: server.status, whitelist_enabled: config.properties.get("white-list").is_some_and(|v| v == "true"), operator_level, whitelist: data.remove("whitelist").unwrap(), operators: data.remove("operators").unwrap(),
        banned_players: data.remove("bannedPlayers").unwrap(), banned_ips: data.remove("bannedIps").unwrap(), revisions })
}

fn player_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 16 && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

fn live_command(request: &PlayerEdit) -> AppResult<String> {
    let add = match request.action.as_str() {
        "add" => true, "remove" => false,
        _ => return Err(AppError::InvalidInput("serverPlayers.invalidInput".into())),
    };
    if request.kind == "whitelistState" {
        return Ok(format!("whitelist {}", if add { "on" } else { "off" }));
    }
    let name = request.name.trim();
    if request.kind == "bannedIps" {
        name.parse::<std::net::IpAddr>().map_err(|_| AppError::InvalidInput("serverPlayers.invalidIp".into()))?;
    } else if !player_name(name) {
        return Err(AppError::InvalidInput("serverPlayers.invalidName".into()));
    }
    let verb = match (request.kind.as_str(), add) {
        ("whitelist", true) => "whitelist add", ("whitelist", false) => "whitelist remove",
        ("operators", true) => "op", ("operators", false) => "deop",
        ("bannedPlayers", true) => "ban", ("bannedPlayers", false) => "pardon",
        ("bannedIps", true) => "ban-ip", ("bannedIps", false) => "pardon-ip",
        _ => return Err(AppError::InvalidInput("serverPlayers.invalidInput".into())),
    };
    let reason = request.reason.as_deref().unwrap_or("").trim();
    if reason.len() > 512 || reason.chars().any(char::is_control) {
        return Err(AppError::InvalidInput("serverPlayers.invalidInput".into()));
    }
    Ok(if add && request.kind.starts_with("banned") && !reason.is_empty() {
        format!("{verb} {name} {reason}")
    } else { format!("{verb} {name}") })
}

async fn edit_running(state: &AppState, id: &str, request: &PlayerEdit) -> AppResult<PlayerLists> {
    let command = live_command(request)?;
    let before = list(state, id).await?;
    if request.kind != "whitelistState" && before.revisions.get(&request.kind) != Some(&request.expected_revision) {
        return Err(AppError::Conflict("serverPlayers.changed".into()));
    }
    super::live::wait_ready(state, id).await?;
    let ready = list(state, id).await?;
    let rows_for = |lists: &PlayerLists| match request.kind.as_str() {
        "whitelist" => lists.whitelist.clone(), "operators" => lists.operators.clone(),
        "bannedPlayers" => lists.banned_players.clone(), "bannedIps" => lists.banned_ips.clone(), _ => vec![],
    };
    if request.kind != "whitelistState" && rows_for(&before) != rows_for(&ready) {
        return Err(AppError::Conflict("serverPlayers.changed".into()));
    }
    if request.kind == "operators" && request.action == "add" {
        let level = ready.operator_level;
        if request.level.unwrap_or(level) != level {
            return Err(AppError::InvalidInput("serverPlayers.liveIdentityHintV2".into()));
        }
    }
    // Recheck readiness after disk reads; never fall back to writing a live cache.
    let server = store::get(state, id).await?;
    if runtime::state_for(state, id, &server.status).await != "running" {
        return Err(AppError::Conflict("serverPlayers.liveUnavailable".into()));
    }
    runtime::control(state, id, "command", &command).await?;
    // stdin acceptance is not Minecraft confirmation. Wait for its persisted result.
    for _ in 0..40 {
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        let result = list(state, id).await?;
        let add = request.action == "add";
        let done = if request.kind == "whitelistState" { result.whitelist_enabled == add } else {
            let rows = match request.kind.as_str() { "whitelist" => &result.whitelist, "operators" => &result.operators,
                "bannedPlayers" => &result.banned_players, _ => &result.banned_ips };
            rows.iter().any(|row| if request.kind == "bannedIps" {
                row["ip"].as_str().and_then(|v| v.parse::<std::net::IpAddr>().ok()) == request.name.trim().parse::<std::net::IpAddr>().ok()
            } else { row["name"].as_str().is_some_and(|v| v.eq_ignore_ascii_case(request.name.trim()))
                && (!add || request.kind != "operators" || request.level.is_none_or(|level| row["level"].as_u64() == Some(level as u64))) }) == add
        };
        if done { return Ok(result); }
    }
    Err(AppError::Unavailable("serverPlayers.commandUnconfirmedV2".into()))
}

#[cfg(test)]
mod live_tests {
    use super::*;
    fn edit(kind: &str, action: &str, name: &str) -> PlayerEdit {
        PlayerEdit { kind: kind.into(), action: action.into(), name: name.into(), uuid: None, identity_provider: None, level: None, reason: None, expected_revision: "missing".into() }
    }
    #[test]
    fn builds_only_standard_access_commands() {
        for (kind, add, remove) in [("whitelist", "whitelist add", "whitelist remove"), ("operators", "op", "deop"), ("bannedPlayers", "ban", "pardon"), ("bannedIps", "ban-ip", "pardon-ip")] {
            let name = if kind == "bannedIps" { "192.0.2.1" } else { "Alex" };
            assert_eq!(live_command(&edit(kind, "add", name)).unwrap(), format!("{add} {name}"));
            assert_eq!(live_command(&edit(kind, "remove", name)).unwrap(), format!("{remove} {name}"));
        }
        assert_eq!(live_command(&edit("whitelistState", "add", "")).unwrap(), "whitelist on");
        assert_eq!(live_command(&edit("whitelistState", "remove", "")).unwrap(), "whitelist off");
    }
    #[test]
    fn rejects_command_injection_and_invalid_actions() {
        assert!(live_command(&edit("operators", "add", "Alex\nstop")).is_err());
        assert!(live_command(&edit("bannedIps", "add", "localhost stop")).is_err());
        assert!(live_command(&edit("whitelistState", "enable", "")).is_err());
        let mut request = edit("bannedPlayers", "add", "Alex"); request.reason = Some("reason\rstop".into());
        assert!(live_command(&request).is_err());
    }
}

async fn identity(state: &AppState, root: &str, name: &str, supplied: Option<&str>, online: bool, provider: &str) -> AppResult<(String, String)> {
    if !player_name(name) { return Err(AppError::InvalidInput("serverPlayers.invalidName".into())); }
    if let Some(value) = supplied.filter(|s| !s.trim().is_empty()) {
        let id = uuid::Uuid::parse_str(value.trim()).map_err(|_| AppError::InvalidInput("serverPlayers.invalidUuid".into()))?;
        return Ok((name.into(), id.to_string()));
    }
    if !["auto", "offline", "elyby"].contains(&provider) { return Err(AppError::InvalidInput("serverPlayers.invalidInput".into())); }
    if provider == "offline" { return Ok((name.into(), crate::accounts::offline_uuid(name).to_string())); }
    // A server's cache also covers proxy and authentication-plugin identities.
    let cache = Path::new(root).join("usercache.json");
    store::plain_path(&cache)?;
    if provider == "auto" { if let Ok(meta) = std::fs::metadata(&cache) {
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
    }
    if provider == "auto" && !online { return Ok((name.into(), crate::accounts::offline_uuid(name).to_string())); }
    let url = if provider == "elyby" { format!("https://authserver.ely.by/api/users/profiles/minecraft/{name}") } else { format!("https://api.mojang.com/users/profiles/minecraft/{name}") };
    let response = state.http.get(url)
        .timeout(std::time::Duration::from_secs(15)).send().await.map_err(|_| AppError::Unavailable("serverPlayers.profileUnavailableV2".into()))?;
    if !response.status().is_success() { return Err(AppError::Unavailable("serverPlayers.profileUnavailableV2".into())); }
    let profile: Value = response.json().await.map_err(|_| AppError::Unavailable("serverPlayers.profileUnavailableV2".into()))?;
    let id = profile["id"].as_str().and_then(|s| uuid::Uuid::parse_str(s).ok())
        .ok_or_else(|| AppError::Unavailable("serverPlayers.profileUnavailableV2".into()))?;
    let actual = profile["name"].as_str().filter(|s| player_name(s) && s.eq_ignore_ascii_case(name))
        .ok_or_else(|| AppError::Unavailable("serverPlayers.profileUnavailableV2".into()))?;
    Ok((actual.into(), id.to_string()))
}

pub async fn edit(state: &AppState, id: &str, request: PlayerEdit) -> AppResult<PlayerLists> {
    let _edit = EDIT.lock().await;
    let current = store::get(state, id).await?;
    let status = runtime::state_for(state, id, &current.status).await;
    if ["running", "starting"].contains(&status.as_str()) {
        return edit_running(state, id, &request).await;
    }
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
        identity(state, &server.path, request.name.trim(), request.uuid.as_deref(), config.config.properties.get("online-mode").is_none_or(|s| s != "false"), request.identity_provider.as_deref().unwrap_or("auto")).await?
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
