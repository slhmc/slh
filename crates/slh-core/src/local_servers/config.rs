use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ServerConfig {
    pub core: String,
    pub minecraft_version: String,
    pub core_version: String,
    pub java_path: Option<String>,
    pub git_path: Option<String>,
    pub jdk_path: Option<String>,
    pub memory_min_mb: u32,
    pub memory_max_mb: u32,
    pub flags: String,
    pub jvm_args: Vec<String>,
    pub server_args: Vec<String>,
    pub console: String,
    pub properties: BTreeMap<String, String>,
    pub properties_text: String,
    pub custom_jar: Option<String>,
    pub eula_accepted: bool,
}
impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            core: "vanilla".into(),
            minecraft_version: String::new(),
            core_version: String::new(),
            java_path: None,
            git_path: None,
            jdk_path: None,
            memory_min_mb: 1024,
            memory_max_mb: 4096,
            flags: "ordinary".into(),
            jvm_args: vec![],
            server_args: vec![],
            console: "builtin".into(),
            properties: BTreeMap::from([
                ("server-port".into(), "25565".into()),
                ("server-ip".into(), "".into()),
                ("max-players".into(), "20".into()),
                ("motd".into(), "SLH server".into()),
                ("level-name".into(), "world".into()),
                ("level-seed".into(), "".into()),
                ("level-type".into(), "minecraft:normal".into()),
                ("gamemode".into(), "survival".into()),
                ("difficulty".into(), "normal".into()),
                ("hardcore".into(), "false".into()),
                ("online-mode".into(), "true".into()),
                ("white-list".into(), "false".into()),
                ("pvp".into(), "true".into()),
                ("enable-command-block".into(), "false".into()),
                ("allow-flight".into(), "false".into()),
                ("spawn-protection".into(), "16".into()),
                ("view-distance".into(), "10".into()),
                ("simulation-distance".into(), "10".into()),
                ("generate-structures".into(), "true".into()),
                ("allow-nether".into(), "true".into()),
            ]),
            properties_text: String::new(),
            custom_jar: None,
            eula_accepted: false,
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ServerDefaults {
    pub port_allocation: String,
    pub directory: Option<String>,
    pub config: ServerConfig,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchPlan {
    pub java: String,
    pub args: Vec<String>,
    pub directory: String,
    pub required_java: u32,
}

pub fn validate(config: &ServerConfig) -> AppResult<()> {
    if ![
        "vanilla", "fabric", "forge", "quilt", "neoforge", "paper", "purpur", "leaf", "spigot", "bukkit",
        "custom", "horizon",
    ]
    .contains(&config.core.as_str())
    {
        return Err(AppError::InvalidInput("Unknown server core".into()));
    }
    if !["ordinary", "aikar", "custom"].contains(&config.flags.as_str())
        || !["builtin", "external", "hidden"].contains(&config.console.as_str())
    {
        return Err(AppError::InvalidInput(
            "Invalid server launch preference".into(),
        ));
    }
    if config.memory_min_mb < 128
        || config.memory_min_mb > config.memory_max_mb
        || config.memory_max_mb > 1_048_576
    {
        return Err(AppError::InvalidInput("Invalid server memory range".into()));
    }
    for args in [&config.jvm_args, &config.server_args] {
        if args.len() > 128
            || args
                .iter()
                .any(|a| a.len() > 4096 || a.contains(['\0', '\r', '\n']))
        {
            return Err(AppError::InvalidInput("Invalid server arguments".into()));
        }
    }
    if config.jvm_args.iter().any(|a| {
        a.starts_with("-Xms") || a.starts_with("-Xmx") || a == "-jar" || a.starts_with('@')
    }) {
        return Err(AppError::InvalidInput(
            "Use the memory fields; entry points and argument files are managed by SLH".into(),
        ));
    }
    if config.properties.len() > 200 || config.properties_text.len() > 1024 * 1024 {
        return Err(AppError::InvalidInput(
            "Server properties are too large".into(),
        ));
    }
    for (key, value) in &config.properties {
        if key.is_empty()
            || key.len() > 128
            || key.contains(['\0', '\n', '\r', '=', ' ', ':'])
            || value.len() > 4096
            || value.contains(['\0', '\n', '\r'])
        {
            return Err(AppError::InvalidInput("Invalid server property".into()));
        }
    }
    for (key, min, max) in [
        ("server-port", 1, 65535),
        ("max-players", 1, 100000),
        ("view-distance", 2, 32),
        ("simulation-distance", 2, 32),
        ("spawn-protection", 0, 65535),
    ] {
        if let Some(value) = config.properties.get(key) {
            if !value.parse::<u32>().is_ok_and(|v| v >= min && v <= max) {
                return Err(AppError::InvalidInput(format!("Invalid {key}")));
            }
        }
    }
    if let Some(name) = config.properties.get("level-name") {
        validate_component(name)?;
    }
    for field in [
        &config.java_path,
        &config.jdk_path,
        &config.git_path,
        &config.custom_jar,
    ] {
        if let Some(path) = field {
            if path.contains(['\0', '\r', '\n']) || !Path::new(path).is_absolute() {
                return Err(AppError::InvalidInput(
                    "Choose an absolute tool path".into(),
                ));
            }
        }
    }
    Ok(())
}

pub fn validate_component(name: &str) -> AppResult<()> {
    let base = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if name.trim().is_empty()
        || name.len() > 180
        || name.ends_with([' ', '.'])
        || name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|'])
        || name.chars().any(char::is_control)
        || name == "."
        || name == ".."
        || [
            "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
            "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
        ]
        .contains(&base.as_str())
    {
        return Err(AppError::InvalidInput(
            "Invalid server or folder name".into(),
        ));
    }
    Ok(())
}

pub fn modern(version: &str, minor: u32) -> bool {
    let parts: Vec<u32> = version.split('.').filter_map(|p| p.parse().ok()).collect();
    if let Some((year, week)) = version
        .split_once('w')
        .and_then(|(y, w)| Some((y.parse::<u32>().ok()?, w.get(..2)?.parse::<u32>().ok()?)))
    {
        let threshold = match minor {
            0..=4 => (12, 32),
            5..=8 => (14, 2),
            9..=13 => (17, 43),
            14..=18 => (21, 37),
            19 => (22, 11),
            _ => (23, 12),
        };
        return (year, week) >= threshold;
    }
    parts.first().is_some_and(|v| *v > 1)
        || (parts.first() == Some(&1) && parts.get(1).copied().unwrap_or(0) >= minor)
}

fn escape_property(value: &str) -> String {
    let mut out = String::new();
    for (i, c) in value.chars().enumerate() {
        match c {
            '\\' => out.push_str("\\\\"),
            ' ' if i == 0 => out.push_str("\\ "),
            c if !c.is_ascii() => {
                for unit in c.encode_utf16(&mut [0; 2]).iter() {
                    out.push_str(&format!("\\u{unit:04x}"));
                }
            }
            c => out.push(c),
        }
    }
    out
}

/// Preserve unknown properties, comments and continuations. Replace only owned keys.
pub fn properties_text(existing: &str, config: &ServerConfig) -> String {
    let mut values = config.properties.clone();
    if !modern(&config.minecraft_version, 18) {
        values.remove("simulation-distance");
    }
    if !modern(&config.minecraft_version, 4) {
        values.remove("enable-command-block");
    }
    if !modern(&config.minecraft_version, 19) {
        if let Some(value) = values.get_mut("level-type") {
            if value.starts_with("minecraft:") {
                *value = if value.contains("flat") {
                    "flat"
                } else {
                    "default"
                }
                .into();
            }
        }
    }
    if !modern(&config.minecraft_version, 13) {
        for (key, names) in [
            (
                "gamemode",
                vec!["survival", "creative", "adventure", "spectator"],
            ),
            ("difficulty", vec!["peaceful", "easy", "normal", "hard"]),
        ] {
            if let Some(v) = values.get_mut(key) {
                if let Some(index) = names.iter().position(|n| n == v) {
                    *v = index.to_string();
                }
            }
        }
        if let Some(v) = values.get_mut("level-type") {
            *v = if v.contains("flat") {
                "FLAT"
            } else {
                "DEFAULT"
            }
            .into();
        }
    }
    let mut lines = Vec::new();
    let mut continuation = false;
    let mut replacing = false;
    for line in existing.lines() {
        let trimmed = line.trim_start();
        if continuation {
            if !replacing {
                lines.push(line.to_owned());
            }
            continuation = trailing_continuation(line);
            continue;
        }
        continuation = trailing_continuation(line);
        replacing = false;
        if !trimmed.starts_with(['#', '!']) {
            let key = trimmed.split(['=', ':', ' ', '\t']).next().unwrap_or("");
            if let Some(value) = values.remove(key) {
                lines.push(format!("{key}={}", escape_property(&value)));
                replacing = true;
                continue;
            }
            // Eliminate duplicate owned definitions so they cannot override the form.
            if config.properties.contains_key(key) {
                replacing = true;
                continue;
            }
        }
        lines.push(line.to_owned());
    }
    for (key, value) in values {
        lines.push(format!("{key}={}", escape_property(&value)));
    }
    lines.join("\n") + "\n"
}
fn trailing_continuation(line: &str) -> bool {
    line.chars().rev().take_while(|c| *c == '\\').count() % 2 == 1
}

/// Read the properties controlled by the form, retaining the original document separately.
pub fn import_properties(config: &mut ServerConfig, text: &str) {
    for (key, value) in ServerConfig::default().properties {
        config.properties.entry(key).or_insert(value);
    }
    fn decode(value: &str) -> String {
        let mut chars = value.chars();
        let mut units = Vec::new();
        while let Some(c) = chars.next() {
            if c != '\\' {
                units.extend(c.encode_utf16(&mut [0; 2]).iter().copied());
                continue;
            }
            match chars.next() {
                Some('u') => {
                    let digits: String = chars.by_ref().take(4).collect();
                    if let Ok(n) = u16::from_str_radix(&digits, 16) {
                        units.push(n);
                    }
                }
                Some('n') => units.push(10),
                Some('r') => units.push(13),
                Some('t') => units.push(9),
                Some(c) => units.extend(c.encode_utf16(&mut [0; 2]).iter().copied()),
                None => {}
            }
        }
        String::from_utf16_lossy(&units)
    }
    let mut logical = String::new();
    for line in text.lines() {
        logical.push_str(line.trim_start());
        if trailing_continuation(&logical) {
            logical.pop();
            continue;
        }
        if !logical.starts_with(['#', '!']) {
            if let Some(index) = logical.find(['=', ':', ' ', '\t']) {
                let key = decode(&logical[..index]);
                if let Some(value) = config.properties.get_mut(&key) {
                    *value = decode(logical[index..].trim_start_matches([' ', '\t', '=', ':']));
                    if matches!(key.as_str(), "white-list" | "online-mode" | "pvp" | "enable-command-block" | "allow-flight" | "hardcore" | "generate-structures" | "allow-nether") {
                        if value.eq_ignore_ascii_case("true") { *value = "true".into(); }
                        else if value.eq_ignore_ascii_case("false") { *value = "false".into(); }
                    }
                }
            }
        }
        logical.clear();
    }
    if !modern(&config.minecraft_version, 19) {
        if let Some(value) = config.properties.get_mut("level-type") {
            if ["FLAT", "flat", "DEFAULT", "default"].contains(&value.as_str()) {
                *value = if value.eq_ignore_ascii_case("flat") {
                    "minecraft:flat"
                } else {
                    "minecraft:normal"
                }
                .into();
            }
        }
    }
    if !modern(&config.minecraft_version, 13) {
        for (key, names) in [
            (
                "gamemode",
                vec!["survival", "creative", "adventure", "spectator"],
            ),
            ("difficulty", vec!["peaceful", "easy", "normal", "hard"]),
        ] {
            if let Some(value) = config.properties.get_mut(key) {
                if let Some(name) = value.parse::<usize>().ok().and_then(|n| names.get(n)) {
                    *value = (*name).into();
                }
            }
        }
        if let Some(value) = config.properties.get_mut("level-type") {
            *value = if value.to_ascii_lowercase().contains("flat") {
                "minecraft:flat"
            } else {
                "minecraft:normal"
            }
            .into();
        }
    }
}

pub fn jvm_arguments(config: &ServerConfig, java_major: u32) -> AppResult<Vec<String>> {
    validate(config)?;
    let mut args = vec![
        format!("-Xms{}M", config.memory_min_mb),
        format!("-Xmx{}M", config.memory_max_mb),
    ];
    if config.flags == "aikar" {
        if java_major < 8 {
            return Err(AppError::InvalidInput(
                "Aikar flags require Java 8 or newer".into(),
            ));
        }
        args.extend(
            [
                "-XX:+UseG1GC",
                "-XX:+ParallelRefProcEnabled",
                "-XX:MaxGCPauseMillis=200",
                "-XX:+UnlockExperimentalVMOptions",
                "-XX:+DisableExplicitGC",
                "-XX:+AlwaysPreTouch",
                "-XX:G1NewSizePercent=30",
                "-XX:G1MaxNewSizePercent=40",
                "-XX:G1HeapRegionSize=8M",
                "-XX:G1ReservePercent=20",
                "-XX:G1HeapWastePercent=5",
                "-XX:G1MixedGCCountTarget=4",
                "-XX:InitiatingHeapOccupancyPercent=15",
                "-XX:G1MixedGCLiveThresholdPercent=90",
                "-XX:SurvivorRatio=32",
                "-XX:+PerfDisableSharedMem",
                "-XX:MaxTenuringThreshold=1",
                "-Dusing.aikars.flags=https://mcflags.emc.gs",
                "-Daikars.new.flags=true",
            ]
            .map(str::to_owned),
        );
        // G1RSetUpdatingPauseTimePercent was removed in recent JVMs.
        if java_major < 24 {
            args.push("-XX:G1RSetUpdatingPauseTimePercent=5".into());
        }
    }
    if config.flags == "custom" {
        args.extend(config.jvm_args.clone());
    }
    Ok(args)
}

pub fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
pub fn batch_quote(value: &str) -> AppResult<String> {
    // cmd.exe has a second expansion language beyond Windows argv quoting.
    if value.contains(['\r', '\n', '\0', '"']) {
        return Err(AppError::InvalidInput("A batch argument cannot contain quotes or line breaks; use the launcher for this argument".into()));
    }
    Ok(format!("\"{}\"", value.replace('%', "%%")))
}
pub fn start_script(plan: &LaunchPlan, windows: bool) -> AppResult<String> {
    let args = std::iter::once(&plan.java).chain(plan.args.iter());
    let native_env = if plan.required_java == 0 {
        if windows { "set \"HORIZON_HOME=%CD%\"\r\nset \"HORIZON_NO_AUDIO=1\"\r\nset \"HORIZON_NO_TELEMETRY=1\"\r\n" }
        else { "export HORIZON_HOME=\"$PWD\" HORIZON_NO_AUDIO=1 HORIZON_NO_TELEMETRY=1\n" }
    } else { "" };
    if windows {
        Ok(format!(
            "@echo off\r\nsetlocal DisableDelayedExpansion\r\nchcp 65001 >nul\r\ncd /d \"%~dp0\"\r\n{native_env}{}\r\n",
            args.map(|s| batch_quote(s))
                .collect::<AppResult<Vec<_>>>()?
                .join(" ")
        ))
    } else {
        Ok(format!(
            "#!/bin/sh\ncd -- \"$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)\" || exit 1\n{native_env}exec {}\n",
            args.map(|s| shell_quote(s)).collect::<Vec<_>>().join(" ")
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn properties_keep_comments_and_unknown_values() {
        let c = ServerConfig::default();
        let text = properties_text(
            "# Keep me\ncustom.x=hello\\\n world\nonline-mode=false\nonline-mode=false\n",
            &c,
        );
        assert!(text.contains("custom.x=hello\\\n world"));
        assert!(text.contains("# Keep me"));
        assert_eq!(text.matches("online-mode=").count(), 1);
        assert!(text.contains("online-mode=true"));
        assert!(!text.contains("simulation-distance"));
    }
    #[test]
    fn arguments_and_names_reject_control_injection() {
        let mut c = ServerConfig::default();
        c.jvm_args = vec!["-Xmx10G".into()];
        assert!(validate(&c).is_err());
        for n in ["../evil", "a/b", "CON", "x."] {
            assert!(validate_component(n).is_err());
        }
        assert!(validate_component("Мои серверы & 100%!").is_ok());
    }
    #[test]
    fn scripts_are_independent_and_escape_expansion() {
        let p = LaunchPlan {
            java: "C:/Java 21/bin/java.exe".into(),
            args: vec!["-Dname=100% & !".into(), "-jar".into(), "server.jar".into()],
            directory: "ignored".into(),
            required_java: 21,
        };
        let b = start_script(&p, true).unwrap();
        assert!(b.contains("100%% & !"));
        assert!(b.contains("DisableDelayedExpansion"));
        assert!(!b.contains("SLH.exe"));
        assert!(
            start_script(&p, false)
                .unwrap()
                .contains("exec 'C:/Java 21/bin/java.exe'")
        );
    }
}
