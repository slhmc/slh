use serde_json::Value;
use sqlx::SqlitePool;
use std::path::Path;

use crate::database;
use crate::error::{AppError, AppResult};

const ALLOWED_SETTING_KEYS: &[&str] = &[
    "general",
    "appearance",
    "minecraft",
    "downloads",
    "privacy",
    "sync",
    "notifications",
    "console",
    "java",
    "bedrock",
    "onboarding",
];

pub async fn update(pool: &SqlitePool, key: &str, value: Value) -> AppResult<Value> {
    if !ALLOWED_SETTING_KEYS.contains(&key) {
        return Err(AppError::InvalidInput(format!(
            "Unknown settings category: {key}"
        )));
    }
    if !value.is_object() {
        return Err(AppError::InvalidInput(
            "Settings payload must be a JSON object".into(),
        ));
    }
    if key == "privacy" {
        let telemetry = value
            .get("telemetry")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if telemetry {
            return Err(AppError::InvalidInput(
                "Telemetry is not supported by this personal portable build".into(),
            ));
        }
    }
    if key == "appearance" {
        validate_appearance(&value)?;
    }
    if key == "notifications" {
        validate_notifications(&value)?;
    }
    if key == "console" {
        validate_console(&value)?;
    }
    if key == "java" {
        validate_java(&value)?;
    }
    if key == "bedrock" {
        validate_bedrock(&value)?;
    }
    database::set_setting(pool, key, &value).await?;
    Ok(value)
}

pub async fn ensure_bedrock_enabled(pool: &SqlitePool) -> AppResult<()> {
    if !crate::platform::capabilities().bedrock {
        return Err(AppError::Unavailable("Bedrock is available only on Windows".into()));
    }
    let setting = database::setting(pool, "bedrock").await?;
    if setting.get("enabled").and_then(Value::as_bool) == Some(false) {
        return Err(AppError::Unavailable(
            "Bedrock is disabled in launcher settings".into(),
        ));
    }
    Ok(())
}

fn validate_bedrock(value: &Value) -> AppResult<()> {
    if !value.get("enabled").is_some_and(Value::is_boolean)
        || !value
            .get("showPreviewVersions")
            .is_some_and(Value::is_boolean)
        || !matches!(
            value.get("defaultProfileMode").and_then(Value::as_str),
            Some("shared" | "isolated")
        )
        || !matches!(
            value.get("cardClickAction").and_then(Value::as_str),
            None | Some("none" | "summary" | "curseforge")
        )
    {
        return Err(AppError::InvalidInput(
            "Bedrock settings are invalid".into(),
        ));
    }
    Ok(())
}

fn validate_java(value: &Value) -> AppResult<()> {
    let Some(directory) = value.get("installDirectory") else {
        return Err(AppError::InvalidInput(
            "Java install directory is required".into(),
        ));
    };
    if directory.is_null() {
        return Ok(());
    }
    let directory = directory.as_str().ok_or_else(|| {
        AppError::InvalidInput("Java install directory must be a string or null".into())
    })?;
    let path = Path::new(directory);
    if directory.trim().is_empty()
        || directory.len() > 240
        || !path.is_absolute()
        || path.parent().is_none()
    {
        return Err(AppError::InvalidInput(
            "Choose an absolute local folder for managed Java".into(),
        ));
    }
    Ok(())
}

fn validate_appearance(value: &Value) -> AppResult<()> {
    const COLORS: &[&str] = &[
        "background",
        "surface",
        "surface2",
        "border",
        "text",
        "textMuted",
        "accent",
        "accentHover",
        "accentPressed",
    ];
    let valid_color = |color: &str| {
        color.len() == 7
            && color.starts_with('#')
            && color[1..]
                .chars()
                .all(|character| character.is_ascii_hexdigit())
    };
    if let Some(minimalism) = value.get("minimalism") {
        if !minimalism.is_boolean() {
            return Err(AppError::InvalidInput(
                "Appearance minimalism must be a boolean".into(),
            ));
        }
    }
    if let Some(fps) = value.get("homeCharacterFps") {
        if !fps.as_u64().is_some_and(|fps| fps <= 60) {
            return Err(AppError::InvalidInput(
                "Home character FPS must be an integer from 0 (unlimited) to 60".into(),
            ));
        }
    }
    for key in COLORS {
        let color = value
            .get(key)
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::InvalidInput(format!("Appearance color {key} is required")))?;
        if !valid_color(color) {
            return Err(AppError::InvalidInput(format!(
                "Appearance color {key} must use #RRGGBB"
            )));
        }
    }
    let presets = value
        .get("presets")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::InvalidInput("Appearance presets must be an array".into()))?;
    if presets.len() > 12 {
        return Err(AppError::InvalidInput(
            "Appearance supports at most 12 custom presets".into(),
        ));
    }
    for preset in presets {
        let id = preset.get("id").and_then(Value::as_str).unwrap_or_default();
        let name = preset
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !id.starts_with("custom-") || id.len() > 80 || name.trim().is_empty() || name.len() > 40
        {
            return Err(AppError::InvalidInput(
                "Custom appearance preset metadata is invalid".into(),
            ));
        }
        let colors = preset
            .get("colors")
            .and_then(Value::as_object)
            .ok_or_else(|| {
                AppError::InvalidInput("Appearance preset colors are required".into())
            })?;
        for key in COLORS {
            if !colors
                .get(*key)
                .and_then(Value::as_str)
                .is_some_and(&valid_color)
            {
                return Err(AppError::InvalidInput(format!(
                    "Appearance preset color {key} must use #RRGGBB"
                )));
            }
        }
    }
    let scale = value
        .get("scalePercent")
        .and_then(Value::as_u64)
        .ok_or_else(|| AppError::InvalidInput("Launcher scale is required".into()))?;
    if !(50..=200).contains(&scale) {
        return Err(AppError::InvalidInput(
            "Launcher scale must be between 50 and 200 percent".into(),
        ));
    }
    let font_family = value
        .get("fontFamily")
        .and_then(Value::as_str)
        .unwrap_or("pixeloid");
    if !matches!(font_family, "pixeloid" | "system" | "monospace" | "local") {
        return Err(AppError::InvalidInput(
            "Unknown interface font choice".into(),
        ));
    }
    let custom_font_path = value.get("customFontPath");
    if font_family == "local"
        && !custom_font_path
            .and_then(Value::as_str)
            .is_some_and(|path| !path.is_empty() && path.len() <= 260)
    {
        return Err(AppError::InvalidInput(
            "A portable local font must be selected before using it".into(),
        ));
    }
    Ok(())
}

fn validate_notifications(value: &Value) -> AppResult<()> {
    let max_visible = value
        .get("maxVisible")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            AppError::InvalidInput("Maximum visible notifications is required".into())
        })?;
    let duration = value
        .get("durationMs")
        .and_then(Value::as_u64)
        .ok_or_else(|| AppError::InvalidInput("Notification duration is required".into()))?;
    if !(1..=8).contains(&max_visible) || !(1500..=30000).contains(&duration) {
        return Err(AppError::InvalidInput(
            "Notification limits are outside the supported range".into(),
        ));
    }
    for key in ["enabled", "showInfo", "showSuccess", "showErrors"] {
        if value.get(key).and_then(Value::as_bool).is_none() {
            return Err(AppError::InvalidInput(format!(
                "Notification setting {key} must be true or false"
            )));
        }
    }
    if let Some(destination) = value.get("destination") {
        if !matches!(destination.as_str(), Some("launcher" | "windows")) {
            return Err(AppError::InvalidInput(
                "Notification destination must be launcher or windows".into(),
            ));
        }
    }
    Ok(())
}

fn validate_console(value: &Value) -> AppResult<()> {
    for key in [
        "background",
        "foreground",
        "info",
        "warning",
        "error",
        "debug",
        "timestamp",
    ] {
        let color = value.get(key).and_then(Value::as_str).unwrap_or_default();
        if color.len() != 7
            || !color.starts_with('#')
            || !color[1..]
                .chars()
                .all(|character| character.is_ascii_hexdigit())
        {
            return Err(AppError::InvalidInput(format!(
                "Console color {key} must use #RRGGBB"
            )));
        }
    }
    let font_size = value.get("fontSize").and_then(Value::as_u64).unwrap_or(0);
    let max_lines = value.get("maxLines").and_then(Value::as_u64).unwrap_or(0);
    if !(10..=22).contains(&font_size) || !(250..=10_000).contains(&max_lines) {
        return Err(AppError::InvalidInput(
            "Console font size or retained line limit is outside the supported range".into(),
        ));
    }
    for key in ["wrapLines", "showTimestamps", "autoScroll", "openOnLaunch"] {
        if value.get(key).and_then(Value::as_bool).is_none() {
            return Err(AppError::InvalidInput(format!(
                "Console setting {key} must be true or false"
            )));
        }
    }
    if value
        .get("openOnHomeLaunch")
        .is_some_and(|setting| !setting.is_boolean())
    {
        return Err(AppError::InvalidInput(
            "Console setting openOnHomeLaunch must be true or false".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appearance_presets_are_bounded_and_hex_only() {
        let valid = serde_json::json!({
            "background":"#1f2226","surface":"#292d32","surface2":"#343a40",
            "border":"#454c54","text":"#ffffff","textMuted":"#aeb6bf",
            "accent":"#cd491e","accentHover":"#e15828","accentPressed":"#ae3916",
            "activePresetId":"slh-orange","presets":[]
            ,"scalePercent":100
        });
        assert!(validate_appearance(&valid).is_ok());
        for fps in [0, 1, 30, 60] {
            let mut selected = valid.clone();
            selected["homeCharacterFps"] = serde_json::json!(fps);
            assert!(validate_appearance(&selected).is_ok());
        }
        for fps in [
            serde_json::json!(-1),
            serde_json::json!(61),
            serde_json::json!(1.5),
            serde_json::json!("30"),
        ] {
            let mut selected = valid.clone();
            selected["homeCharacterFps"] = fps;
            assert!(validate_appearance(&selected).is_err());
        }
        let mut invalid = valid;
        invalid["accent"] = Value::String("orange".into());
        assert!(validate_appearance(&invalid).is_err());
    }

    #[test]
    fn console_palette_and_history_limits_are_validated() {
        let valid = serde_json::json!({
            "background":"#111417","foreground":"#d8dee9","info":"#8fb8de",
            "warning":"#e6b85c","error":"#f06a6a","debug":"#85909c",
            "timestamp":"#66717d","fontSize":13,"maxLines":2000,
            "wrapLines":true,"showTimestamps":true,"autoScroll":true,"openOnLaunch":true
        });
        assert!(validate_console(&valid).is_ok());
        let mut invalid = valid;
        invalid["maxLines"] = Value::from(100_000);
        assert!(validate_console(&invalid).is_err());
    }
}
