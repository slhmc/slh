//! Read-only discovery. Existing scripts are inspected, never executed or rewritten.
use super::{config::*, store};
use crate::{
    error::{AppError, AppResult},
    state::AppState,
};
use serde::{Deserialize, Serialize};
use std::{
    io::Read,
    path::{Path, PathBuf},
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredServer {
    pub path: String,
    pub name: String,
    pub config: ServerConfig,
    pub entry: Vec<String>,
    pub ready: bool,
    pub note: Option<String>,
}

fn text(path: &Path) -> String {
    if store::plain_path(path).is_ok() && path.metadata().is_ok_and(|m| m.len() < 1024 * 1024) {
        std::fs::read_to_string(path).unwrap_or_default()
    } else {
        String::new()
    }
}
fn game_version(path: &Path, jar: Option<&Path>) -> String {
    // The selected executable's metadata wins over its filename or cached histories.
    if let Some(jar) = jar {
        if let Ok(details) = super::recovery::candidate(jar) { return details.minecraft_version; }
    }
    let pattern = regex::Regex::new(r"(?:\b1\.\d+(?:\.\d+)?\b|\b2\d\.\d+(?:\.\d+)?\b)").unwrap();
    for source in [jar
        .and_then(|p| p.file_name())
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()]
    {
        if let Some(v) = pattern.find(&source) {
            return v.as_str().into();
        }
    }
    if let Some(jar) = jar {
        if let Ok(file) = std::fs::File::open(jar) {
            if let Ok(mut zip) = zip::ZipArchive::new(file) {
                for name in ["version.json", "META-INF/versions.list"] {
                    if let Ok(mut entry) = zip.by_name(name) {
                        if entry.size() < 65536 {
                            let mut value = String::new();
                            let _ = entry.read_to_string(&mut value);
                            if name == "version.json" {
                                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&value) {
                                    if let Some(id) = v["id"].as_str() {
                                        return id.into();
                                    }
                                }
                            } else if let Some(v) = pattern.find(&value) {
                                return v.as_str().into();
                            }
                        }
                    }
                }
            }
        }
    }
    if let Ok(history) =
        serde_json::from_str::<serde_json::Value>(&text(&path.join("version_history.json")))
    {
        if let Some(version) = history["currentVersion"]
            .as_str()
            .and_then(|s| pattern.find(s))
        {
            return version.as_str().into();
        }
    }
    for folder in [
        "versions",
        ".fabric/server",
        "libraries/net/minecraft/server",
    ] {
        let parent = path.join(folder);
        if store::plain_path(&parent).is_err() {
            continue;
        }
        if let Ok(entries) = std::fs::read_dir(parent) {
            let mut versions: Vec<_> = entries
                .filter_map(Result::ok)
                .filter(|e| e.file_type().is_ok_and(|t| t.is_dir() && !t.is_symlink()))
                .filter_map(|e| {
                    let name = e.file_name().to_string_lossy().into_owned();
                    pattern.find(&name).map(|v| v.as_str().to_owned())
                })
                .collect();
            versions.sort();
            versions.dedup();
            if versions.len() == 1 {
                return versions.remove(0);
            }
        }
    }
    String::new()
}
pub(crate) fn inspect(path: &Path) -> AppResult<Option<DiscoveredServer>> {
    store::plain_path(path)?;
    if !path.join("server.properties").is_file() {
        return Ok(None);
    }
    let name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let mut config = ServerConfig::default();
    config.properties_text = text(&path.join("server.properties"));
    let properties = config.properties_text.clone();
    import_properties(&mut config, &properties);
    config.eula_accepted = text(&path.join("eula.txt"))
        .lines()
        .any(|s| s.trim() == "eula=true");
    let mut entry = vec![];
    let mut chosen_jar = None;
    let mut note = None;
    for script in ["start.bat", "start.sh", "run.bat", "run.sh", "start.ps1"] {
        let contents = text(&path.join(script));
        for line in contents
            .lines()
            .filter(|l| !l.trim_start().starts_with(['#', ':']))
        {
            let normalized = line.replace('\\', "/");
            let Some(tokens) = shlex::split(&normalized) else {
                continue;
            };
            let Some(at) = tokens
                .iter()
                .position(|s| s.eq_ignore_ascii_case("-jar") || s.starts_with("@libraries/"))
            else {
                continue;
            };
            if tokens
                .iter()
                .any(|s| matches!(s.as_str(), "&" | "&&" | "|" | "||" | ">" | "<"))
            {
                note = Some(
                    "The start script contains shell commands; review the launch configuration"
                        .into(),
                );
                continue;
            }
            let target = if tokens[at] == "-jar" {
                tokens.get(at + 1).cloned()
            } else {
                Some(tokens[at][1..].into())
            };
            let Some(target) = target else { continue };
            let rel = Path::new(&target);
            if rel.is_absolute()
                || rel
                    .components()
                    .any(|c| !matches!(c, std::path::Component::Normal(_)))
            {
                continue;
            }
            let target = path.join(rel);
            if store::plain_path(&target).is_err() || !target.is_file() {
                continue;
            }
            entry = if tokens[at] == "-jar" {
                chosen_jar = Some(target);
                vec!["-jar".into(), tokens[at + 1].clone()]
            } else {
                vec![tokens[at].clone()]
            };
            config.jvm_args = tokens[1..at]
                .iter()
                .filter(|s| !s.starts_with("-Xms") && !s.starts_with("-Xmx"))
                .cloned()
                .collect();
            for value in &tokens[1..at] {
                let parse = |s: &str| -> Option<u32> {
                    let s = s.to_ascii_lowercase();
                    if let Some(n) = s.strip_suffix('g') {
                        n.parse::<u32>().ok()?.checked_mul(1024)
                    } else {
                        s.trim_end_matches('m').parse().ok()
                    }
                };
                if let Some(s) = value.strip_prefix("-Xms") {
                    if let Some(n) = parse(s) {
                        config.memory_min_mb = n;
                    }
                }
                if let Some(s) = value.strip_prefix("-Xmx") {
                    if let Some(n) = parse(s) {
                        config.memory_max_mb = n;
                    }
                }
            }
            config.flags = if config.jvm_args.is_empty() {
                "ordinary"
            } else {
                "custom"
            }
            .into();
            if tokens[0] != "java" && tokens[0] != "java.exe" && Path::new(&tokens[0]).is_absolute()
            {
                config.java_path = Some(tokens[0].clone());
            }
            config.server_args = tokens
                .iter()
                .skip(at + if tokens[at] == "-jar" { 2 } else { 1 })
                .filter(|s| *s != "nogui" && *s != "--nogui")
                .cloned()
                .collect();
            break;
        }
        if !entry.is_empty() {
            break;
        }
    }
    if entry.is_empty() {
        let jars: Vec<_> = std::fs::read_dir(path)?
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|e| e == "jar"))
            .collect();
        if jars.len() == 1 {
            chosen_jar = Some(jars[0].clone());
            entry = vec![
                "-jar".into(),
                jars[0].file_name().unwrap().to_string_lossy().into_owned(),
            ];
        }
    }
    config.minecraft_version = game_version(path, chosen_jar.as_deref());
    let lower = chosen_jar
        .as_ref()
        .map(|p| p.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    config.core = if path.join("leaf.yml").is_file() || path.join("config/leaf-global.yml").is_file() || lower.contains("leaf") {
        "leaf"
    } else if path.join("arclight.conf").is_file() {
        "custom"
    } else if path.join("purpur.yml").is_file() || lower.contains("purpur") {
        "purpur"
    } else if path.join("config/paper-global.yml").is_file() || lower.contains("paper") {
        "paper"
    } else if path.join("spigot.yml").is_file() {
        "spigot"
    } else if path.join("bukkit.yml").is_file() {
        "bukkit"
    } else if path.join(".fabric").is_dir() {
        "fabric"
    } else if path.join("quilt-server-launch.jar").is_file() {
        "quilt"
    } else if entry.iter().any(|s| s.contains("neoforged")) {
        "neoforge"
    } else if entry.iter().any(|s| s.contains("minecraftforge")) {
        "forge"
    } else {
        "custom"
    }
    .into();
    config.core_version = "imported".into();
    config.custom_jar = chosen_jar.map(|p| p.to_string_lossy().into_owned());
    let ready = !entry.is_empty() && !config.minecraft_version.is_empty();
    if !ready {
        note = Some("Select a Minecraft version and a server JAR to connect this folder".into());
    }
    Ok(Some(DiscoveredServer {
        path: path.to_string_lossy().into_owned(),
        name,
        config,
        entry,
        ready,
        note,
    }))
}
pub async fn scan(state: &AppState, directory: Option<String>) -> AppResult<Vec<DiscoveredServer>> {
    let root = directory
        .map(PathBuf::from)
        .unwrap_or(store::root(state, &store::defaults(state).await?));
    store::plain_path(&root)?;
    if !root.is_dir() {
        return Ok(vec![]);
    }
    let known = store::list(state).await?;
    let mut result = vec![];
    for e in walkdir::WalkDir::new(&root)
        .max_depth(5)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            store::plain_path(e.path()).is_ok()
                && (e.depth() == 0
                    || !e
                        .path()
                        .parent()
                        .is_some_and(|p| p.join("server.properties").is_file()))
        })
    {
        let Ok(e) = e else { continue };
        if !e.file_type().is_dir() {
            continue;
        }
        let path = e.path();
        if known.iter().any(|s| {
            std::fs::canonicalize(&s.path)
                .ok()
                .is_some_and(|p| std::fs::canonicalize(path).is_ok_and(|q| p == q))
        }) {
            continue;
        }
        if let Some(server) = inspect(path)? {
            result.push(server);
        }
        if result.len() >= 500 {
            break;
        }
    }
    result.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(result)
}
pub async fn connect(
    state: &AppState,
    path: String,
    config: Option<ServerConfig>,
) -> AppResult<store::LocalServer> {
    let path = PathBuf::from(path);
    let mut found = inspect(&path)?
        .ok_or_else(|| AppError::InvalidInput("No server.properties in this folder".into()))?;
    if let Some(c) = config {
        found.config = c;
    }
    if !found.ready {
        if let Some(jar) = &found.config.custom_jar {
            let p = Path::new(jar);
            store::plain_path(p)?;
            if p.parent() != Some(path.as_path()) || !p.is_file() {
                return Err(AppError::InvalidInput(
                    "Choose a JAR inside the existing server folder".into(),
                ));
            }
            found.entry = vec![
                "-jar".into(),
                p.file_name().unwrap().to_string_lossy().into_owned(),
            ];
        }
    }
    if found.entry.is_empty() || found.config.minecraft_version.is_empty() {
        return Err(AppError::InvalidInput(
            "Select the server JAR and Minecraft version".into(),
        ));
    }
    store::validate_server_path(&found.config.core, &path)?;
    validate(&found.config)?;
    if let Some(s) = store::list(state).await?.into_iter().find(|s| {
        std::fs::canonicalize(&s.path)
            .ok()
            .is_some_and(|p| std::fs::canonicalize(&path).is_ok_and(|q| p == q))
    }) {
        return Ok(s);
    }
    let id = uuid::Uuid::new_v4().to_string();
    let plan = LaunchPlan {
        java: found.config.java_path.clone().unwrap_or_default(),
        args: found.entry,
        directory: found.path.clone(),
        required_java: super::providers::required_java(&found.config.minecraft_version),
    };
    sqlx::query("INSERT INTO local_servers(id,name,path,config_json,plan_json,status) VALUES (?,?,?,?,?,'stopped')").bind(&id).bind(found.name).bind(found.path).bind(serde_json::to_string(&found.config)?).bind(serde_json::to_string(&plan)?).execute(&state.database).await?;
    store::get(state, &id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn old_history_cannot_override_the_selected_jar_or_the_current_history_entry() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(
            root.path().join("version_history.json"),
            r#"{"oldVersion":"1.18.2","currentVersion":"1.21.4 (MC: 1.21.4)"}"#,
        )
        .unwrap();
        assert_eq!(game_version(root.path(), None), "1.21.4");
        let jar = root.path().join("purpur-1.21.5.jar");
        std::fs::write(&jar, "fixture").unwrap();
        assert_eq!(game_version(root.path(), Some(&jar)), "1.21.5");
    }
    #[test]
    fn scripts_are_read_without_running_and_plugin_jars_are_not_mistaken_for_the_core() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("server.properties"), "server-port=25570\n").unwrap();
        std::fs::write(root.path().join("purpur.yml"), "").unwrap();
        std::fs::write(root.path().join("purpur-1.21.4.jar"), "fixture").unwrap();
        std::fs::write(root.path().join("another-plugin.jar"), "plugin").unwrap();
        std::fs::write(
            root.path().join("start.bat"),
            "java -Xms1G -Xmx4G -jar purpur-1.21.4.jar nogui\n",
        )
        .unwrap();
        let s = inspect(root.path()).unwrap().unwrap();
        assert!(s.ready);
        assert_eq!(s.config.core, "purpur");
        assert_eq!(s.config.memory_max_mb, 4096);
        assert_eq!(s.config.properties["server-port"], "25570");
        assert_eq!(s.config.minecraft_version, "1.21.4");
        assert_eq!(s.entry[1], "purpur-1.21.4.jar");
    }
}
