//! Runtime settings are commands owned by Minecraft, never live file edits.
use super::{runtime, store};
use crate::{error::{AppError, AppResult}, state::AppState};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveEdit { pub kind: String, pub value: String, pub rule: Option<String> }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveResult { pub command: String, pub lines: Vec<String> }

pub fn command(edit: &LiveEdit) -> AppResult<String> {
    let invalid = || AppError::InvalidInput("serverLive.invalidValue".into());
    let value = edit.value.trim();
    Ok(match edit.kind.as_str() {
        "difficulty" if ["peaceful", "easy", "normal", "hard"].contains(&value) => format!("difficulty {value}"),
        "gamemode" if ["survival", "creative", "adventure", "spectator"].contains(&value) => format!("defaultgamemode {value}"),
        "idleTimeout" => format!("setidletimeout {}", value.parse::<u32>().ok().filter(|v| *v <= 100_000).ok_or_else(invalid)?),
        "time" if ["day", "noon", "night", "midnight"].contains(&value) => format!("time set {value}"),
        "time" => format!("time set {}", value.parse::<u32>().ok().filter(|v| *v <= i32::MAX as u32).ok_or_else(invalid)?),
        "weather" if ["clear", "rain", "thunder"].contains(&value) => format!("weather {value}"),
        "worldBorder" => {
            let size = value.parse::<f64>().ok().filter(|v| v.is_finite() && (1.0..=59_999_968.0).contains(v)).ok_or_else(invalid)?;
            format!("worldborder set {size}")
        },
        "gamerule" => {
            let rule = edit.rule.as_deref().unwrap_or("");
            if rule.is_empty() || rule.len() > 128 || !rule.bytes().all(|b| b.is_ascii_alphanumeric() || b"_:./-".contains(&b))
                || !(value == "true" || value == "false" || value.parse::<i32>().is_ok()) { return Err(invalid()); }
            format!("gamerule {rule} {value}")
        },
        "save" if value.is_empty() => "save-all flush".into(),
        _ => return Err(invalid()),
    })
}

/// Helpers target known Java command dialects; custom engines require the console.
pub fn command_for_config(config: &super::config::ServerConfig, edit: &LiveEdit) -> AppResult<String> {
    let unsupported = || AppError::Unavailable("serverLive.unsupportedCompatibility".into());
    if !["vanilla", "paper", "purpur", "leaf", "spigot", "bukkit", "fabric", "quilt", "forge", "neoforge"].contains(&config.core.as_str()) {
        return Err(unsupported());
    }
    let parts = config.minecraft_version.split('.').map(str::parse::<u32>).collect::<Result<Vec<_>, _>>().map_err(|_| unsupported())?;
    if !(2..=3).contains(&parts.len()) || !(parts[0] == 1 || parts[0] == 26) { return Err(unsupported()); }
    let version = (parts[0], parts[1], parts.get(2).copied().unwrap_or(0));
    let minimum = match edit.kind.as_str() {
        "worldBorder" => (1, 8, 0),
        "idleTimeout" => (1, 7, 2),
        "difficulty" | "gamemode" | "weather" | "gamerule" => (1, 4, 2),
        "time" | "save" => (1, 0, 0),
        _ => return command(edit),
    };
    if version < minimum || edit.kind == "gamemode" && edit.value.trim() == "spectator" && version < (1, 8, 0) { return Err(unsupported()); }
    // Validate before substituting legacy syntax, retaining command-injection checks.
    let mut result = command(edit)?;
    if edit.kind == "time" && version < (1, 13, 0) {
        result = match edit.value.trim() { "noon" => "time set 6000".into(), "midnight" => "time set 18000".into(), _ => result };
    }
    // Bare save-all works on old servers; use the modern synchronous variant only
    // on the command dialect whose support is established here.
    if edit.kind == "save" && version < (1, 13, 0) { result = "save-all".into(); }
    Ok(result)
}

pub async fn wait_ready(state: &AppState, id: &str) -> AppResult<()> {
    store::get(state, id).await?;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(180);
    loop {
        let info = super::host::read_run(&runtime::run_file(state, id)).map_err(|_| AppError::Unavailable("serverLive.unavailable".into()))?;
        let snapshot = super::host::request(&info, "status", "", u64::MAX).await.map_err(|_| AppError::Unavailable("serverLive.unavailable".into()))?;
        match snapshot.state.as_str() {
            "running" => return Ok(()),
            "starting" if tokio::time::Instant::now() < deadline => tokio::time::sleep(std::time::Duration::from_millis(500)).await,
            "starting" => return Err(AppError::Unavailable("serverLive.startTimeout".into())),
            _ => return Err(AppError::Conflict("serverLive.unavailable".into())),
        }
    }
}

pub async fn apply(state: &AppState, id: &str, edit: LiveEdit) -> AppResult<LiveResult> {
    let server = store::get(state, id).await?;
    let command = command_for_config(&server.config, &edit)?;
    wait_ready(state, id).await?;
    let before = runtime::poll(state, id, u64::MAX).await?;
    runtime::control(state, id, "command", &command).await?;
    let mut lines = vec![];
    for _ in 0..12 {
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        let response = runtime::poll(state, id, before.last_seq).await?;
        if response.run_id != before.run_id || response.state != "running" {
            return Err(AppError::Conflict("serverLive.unavailable".into()));
        }
        lines = response.lines.into_iter().take(30).map(|line| line.text.chars().take(2048).collect()).collect();
        if !lines.is_empty() { break; }
    }
    // Output is shown verbatim: plugins may reject/replace vanilla commands.
    Ok(LiveResult { command, lines })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn edit(kind: &str, value: &str, rule: Option<&str>) -> LiveEdit { LiveEdit { kind: kind.into(), value: value.into(), rule: rule.map(str::to_owned) } }
    #[test]
    fn respects_released_java_command_boundaries() {
        let config = |version: &str| super::super::config::ServerConfig { minecraft_version: version.into(), ..Default::default() };
        for (kind, value, before, after) in [("worldBorder", "100", "1.7.10", "1.8"), ("idleTimeout", "5", "1.7.1", "1.7.2"), ("weather", "rain", "1.4.1", "1.4.2"), ("difficulty", "hard", "1.4.1", "1.4.2"), ("gamemode", "spectator", "1.7.10", "1.8")] {
            assert!(command_for_config(&config(before), &edit(kind, value, None)).is_err());
            assert!(command_for_config(&config(after), &edit(kind, value, None)).is_ok());
        }
        assert_eq!(command_for_config(&config("1.12.2"), &edit("time", "noon", None)).unwrap(), "time set 6000");
        assert_eq!(command_for_config(&config("1.12.2"), &edit("time", "midnight", None)).unwrap(), "time set 18000");
        assert_eq!(command_for_config(&config("1.12.2"), &edit("save", "", None)).unwrap(), "save-all");
        assert_eq!(command_for_config(&config("1.13"), &edit("save", "", None)).unwrap(), "save-all flush");
        for version in ["25w44a", "1.21-pre1", "unknown", "b1.8.1"] { assert!(command_for_config(&config(version), &edit("save", "", None)).is_err()); }
        for core in ["custom", "horizon"] { let mut value = config("26.3"); value.core = core.into(); assert!(command_for_config(&value, &edit("save", "", None)).is_err()); }
    }
    #[tokio::test]
    async fn unsupported_helper_fails_before_contacting_runtime() {
        let root = tempfile::tempdir().unwrap();
        let paths = crate::portable::PortablePaths::from_executable(&root.path().join("SLH.exe"), Some(root.path().to_path_buf())).unwrap();
        let state = AppState::initialize_isolated_at(paths).await.unwrap();
        let server = store::create(&state, store::CreateServer { players: None, name: "Legacy".into(), folder: "legacy".into(), group_id: None,
            config: super::super::config::ServerConfig { minecraft_version: "1.7.10".into(), core_version: "1.7.10".into(), eula_accepted: true, ..Default::default() } }).await.unwrap();
        // No run file exists: reaching wait_ready would return a different error.
        let error: crate::error::CommandError = apply(&state, &server.id, edit("worldBorder", "100", None)).await.err().unwrap().into();
        assert_eq!(error.message_key.as_deref(), Some("serverLive.unsupportedCompatibility"));
        state.database.close().await;
    }
    #[test]
    fn allows_runtime_settings_without_shell_or_command_injection() {
        for (kind, value, expected) in [("difficulty","hard","difficulty hard"),("gamemode","creative","defaultgamemode creative"),("idleTimeout","0","setidletimeout 0"),("time","noon","time set noon"),("weather","rain","weather rain"),("worldBorder","1000","worldborder set 1000"),("save","","save-all flush")] {
            assert_eq!(command(&edit(kind,value,None)).unwrap(), expected);
        }
        assert_eq!(command(&edit("gamerule","true",Some("minecraft:keep_inventory"))).unwrap(), "gamerule minecraft:keep_inventory true");
        for (kind,value) in [("difficulty","hard\nstop"),("worldBorder","NaN"),("worldBorder","-1"),("idleTimeout","-1"),("weather","rain stop"),("op","Alex")] { assert!(command(&edit(kind,value,None)).is_err()); }
        assert!(command(&edit("gamerule","true",Some("keepInventory\nstop"))).is_err());
        assert!(command(&edit("gamerule","true\nstop",Some("keepInventory"))).is_err());
        let error: crate::error::CommandError = AppError::Unavailable("serverLive.startTimeout".into()).into();
        assert_eq!(error.message_key.as_deref(), Some("serverLive.startTimeout"));
    }
}
