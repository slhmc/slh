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

/// Navigation must not overwrite resource preferences from a newer UI snapshot.
pub async fn remember_section(pool: &SqlitePool, section: &str) -> AppResult<()> {
    if !matches!(section, "home" | "library" | "discover" | "servers") {
        return Err(AppError::InvalidInput("Invalid remembered section".into()));
    }
    sqlx::query("UPDATE settings SET value_json = json_set(value_json, '$.lastSection', ?), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE key = 'general' AND json_extract(value_json, '$.rememberSection') = 1")
        .bind(section).execute(pool).await?;
    Ok(())
}

pub async fn minecraft_memory_defaults(pool: &SqlitePool) -> AppResult<(i64, i64)> {
    let settings = database::setting(pool, "minecraft").await?;
    let max = settings["memoryMaxMb"].as_i64().unwrap_or(4096).clamp(256, 1_048_576);
    let min = settings["memoryMinMb"].as_i64().unwrap_or(512).clamp(256, max);
    Ok((min, max))
}

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
    if key == "general" {
        if let Some(policy) = value.get("webview") {
            let policy: crate::webview_settings::WebviewSettings = serde_json::from_value(policy.clone())
                .map_err(|e| AppError::InvalidInput(format!("Invalid WebView2 settings: {e}")))?;
            policy.validate()?;
        }
    }
    if key == "minecraft" {
        validate_optional_booleans(&value, &["fullscreen", "closeLauncherOnExit"])?;
        for (field,min,max) in [("memoryMinMb",256,1048576),("memoryMaxMb",256,1048576),("resolutionWidth",320,16384),("resolutionHeight",240,16384)] {
            if !value[field].as_u64().is_some_and(|v| v >= min && v <= max) { return Err(AppError::InvalidInput(format!("Invalid {field}"))); }
        }
        if value["memoryMinMb"].as_u64() > value["memoryMaxMb"].as_u64() { return Err(AppError::InvalidInput("Minimum memory exceeds maximum memory".into())); }
        if !value["jvmArgs"].as_array().is_some_and(|v| v.len() <= 128 && v.iter().all(|a| a.as_str().is_some_and(|s| !s.contains('\0') && s.len() <= 4096))) { return Err(AppError::InvalidInput("Invalid JVM arguments".into())); }
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
    if key == "downloads" {
        validate_optional_booleans(&value, &["curseforgeImportArchives", "curseforgeDeleteAfterInstall"])?;
        if let Some(directory) = value.get("curseforgeDirectory").filter(|v| !v.is_null()) {
            let directory = directory.as_str().ok_or_else(|| AppError::InvalidInput("Invalid CurseForge downloads folder".into()))?;
            if directory.contains('\0') || !Path::new(directory).is_absolute() || directory.trim().is_empty() {
                return Err(AppError::InvalidInput("Choose an absolute CurseForge downloads folder".into()));
            }
        }
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
    // Retain fields written by a newer/local build when an older UI saves a
    // category. Arrays and explicit nulls still replace the previous value.
    let stored: Option<String> = sqlx::query_scalar("SELECT value_json FROM settings WHERE key = ?")
        .bind(key).fetch_optional(pool).await?;
    let mut merged = stored.as_deref().map(serde_json::from_str).transpose()?
        .unwrap_or_else(|| serde_json::json!({}));
    merge_values(&mut merged, value);
    database::set_setting(pool, key, &merged).await?;
    Ok(merged)
}

fn merge_values(base: &mut Value, overlay: Value) {
    match (base, overlay) {
        (Value::Object(base), Value::Object(overlay)) => {
            for (key, value) in overlay {
                merge_values(base.entry(key).or_insert(Value::Null), value);
            }
        }
        (base, overlay) => *base = overlay,
    }
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
    validate_optional_booleans(value, &["autoDetect", "autoDownload", "skipCompatibilityCheck", "warnLowMemory"])?;
    if value.get("permGenMb").is_some_and(|v| !v.as_u64().is_some_and(|n| n <= 4096)) {
        return Err(AppError::InvalidInput("PermGen memory must be an integer from 0 to 4096 MB".into()));
    }
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
    validate_optional_booleans(value, &["fitProjectTitles"])?;
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
    for colors in std::iter::once(value).chain(value.get("presets").and_then(Value::as_array).into_iter().flatten().filter_map(|v| v.get("colors"))) {
        for key in ["success", "warning", "error", "info"] {
            if let Some(color) = colors.get(key) {
                if !color.as_str().is_some_and(&valid_color) {
                    return Err(AppError::InvalidInput(format!("Appearance color {key} must use #RRGGBB")));
                }
            }
        }
    }
    if let Some(minimalism) = value.get("minimalism") {
        if !minimalism.is_boolean() {
            return Err(AppError::InvalidInput(
                "Appearance minimalism must be a boolean".into(),
            ));
        }
    }
    if let Some(mode) = value.get("homeCharacterMode") {
        if !mode.as_u64().is_some_and(|mode| mode <= 2) {
            return Err(AppError::InvalidInput(
                "Home character mode must be 0 (off), 1 (image), or 2 (3D)".into(),
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
    validate_optional_booleans(value, &["briefEnabled"])?;
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

fn validate_optional_booleans(value: &Value, keys: &[&str]) -> AppResult<()> {
    for key in keys {
        if value.get(*key).is_some_and(|v| !v.is_boolean()) {
            return Err(AppError::InvalidInput(format!("Setting {key} must be true or false")));
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

    #[tokio::test]
    async fn remembering_a_page_preserves_new_resource_preferences() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        let mut general = database::setting(&pool, "general").await.unwrap();
        general["rememberSection"] = Value::Bool(true);
        general["keyboardZoom"] = Value::Bool(false);
        let mut policy = crate::webview_settings::WebviewSettings::default();
        policy.enabled = true;
        general["webview"] = serde_json::to_value(&policy).unwrap();
        update(&pool, "general", general.clone()).await.unwrap();
        remember_section(&pool, "home").await.unwrap();
        general["lastSection"] = Value::String("home".into());
        assert_eq!(database::setting(&pool, "general").await.unwrap(), general);
        assert!(remember_section(&pool, "../settings").await.is_err());
        general["rememberSection"] = Value::Bool(false);
        update(&pool, "general", general.clone()).await.unwrap();
        remember_section(&pool, "library").await.unwrap();
        assert_eq!(database::setting(&pool, "general").await.unwrap(), general);
    }

    #[tokio::test]
    async fn invalid_webview_limits_do_not_overwrite_other_preferences() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        let original = database::setting(&pool, "general").await.unwrap();
        let mut value = original.clone();
        let mut policy = crate::webview_settings::WebviewSettings::default();
        policy.enabled = true;
        policy.background_memory_mb = 16;
        value["webview"] = serde_json::to_value(&policy).unwrap();
        assert!(update(&pool, "general", value.clone()).await.is_err());
        assert_eq!(database::setting(&pool, "general").await.unwrap(), original);
        policy.extreme = true;
        value["webview"] = serde_json::to_value(&policy).unwrap();
        update(&pool, "general", value.clone()).await.unwrap();
        assert_eq!(database::setting(&pool, "general").await.unwrap(), value);
    }

    #[tokio::test]
    async fn memory_defaults_are_persisted_and_invalid_updates_leave_them_intact() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        let mut minecraft = database::setting(&pool, "minecraft").await.unwrap();
        minecraft["memoryMinMb"] = Value::from(1024);
        minecraft["memoryMaxMb"] = Value::from(8192);
        minecraft["fullscreen"] = Value::from(true);
        update(&pool, "minecraft", minecraft.clone()).await.unwrap();
        assert_eq!(minecraft_memory_defaults(&pool).await.unwrap(), (1024,8192));
        minecraft["memoryMinMb"] = Value::from(16384);
        assert!(update(&pool, "minecraft", minecraft).await.is_err());
        assert_eq!(minecraft_memory_defaults(&pool).await.unwrap(), (1024,8192));
        let legacy = serde_json::json!({"installDirectory":null});
        assert!(validate_java(&legacy).is_ok());
        for field in ["autoDetect", "autoDownload", "skipCompatibilityCheck", "warnLowMemory"] {
            let mut invalid=legacy.clone(); invalid[field]=Value::from("false");
            assert!(validate_java(&invalid).is_err());
        }
    }

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
        for mode in 0..=2 {
            let mut selected = valid.clone();
            selected["homeCharacterMode"] = serde_json::json!(mode);
            assert!(validate_appearance(&selected).is_ok());
        }
        for mode in [serde_json::json!(-1),serde_json::json!(3),serde_json::json!(1.5),serde_json::json!("1")] {
            let mut selected = valid.clone();
            selected["homeCharacterMode"] = mode;
            assert!(validate_appearance(&selected).is_err());
        }
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
