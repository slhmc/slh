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
    let command = command(&edit)?;
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
