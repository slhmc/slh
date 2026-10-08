use std::path::{Path, PathBuf};

use crate::models::Instance;

#[derive(Clone, Debug)]
pub struct BedrockRoots {
    /// Active com.mojang folder. For Store-owned installs this is shared with
    /// Minecraft; for supported sideloaded packages it can be per instance.
    pub game_data: PathBuf,
    pub behavior_packs: Vec<PathBuf>,
    pub resource_packs: Vec<PathBuf>,
    pub skin_packs: Vec<PathBuf>,
    pub worlds: Vec<PathBuf>,
    pub screenshots: Vec<PathBuf>,
    pub logs: Vec<PathBuf>,
}

pub fn roots(instance: &Instance, instance_root: &Path) -> BedrockRoots {
    let metadata = read_metadata(instance, instance_root);
    let family = metadata
        .as_ref()
        .and_then(|value| value.get("packageFamilyName"))
        .and_then(serde_json::Value::as_str);
    let is_registered_store = metadata
        .as_ref()
        .and_then(|value| value.get("installMethod"))
        .and_then(serde_json::Value::as_str)
        == Some("registered_store");
    let channel = metadata
        .as_ref()
        .and_then(|value| value.get("channel"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let is_preview = channel.eq_ignore_ascii_case("preview")
        || instance
            .minecraft_version
            .to_ascii_lowercase()
            .contains("preview")
        || family.is_some_and(|value| value.to_ascii_lowercase().contains("beta"));
    let is_official_uwp =
        family.is_some_and(|value| value.to_ascii_lowercase().ends_with("_8wekyb3d8bbwe"));
    let isolated_profile =
        instance.bedrock_profile_mode == "isolated" && !is_registered_store && !is_official_uwp;

    let app_data = std::env::var_os("APPDATA").map(PathBuf::from);
    let local_app_data = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let product_name = if is_preview {
        "Minecraft Bedrock Preview"
    } else {
        "Minecraft Bedrock"
    };
    let gdk_base = app_data.as_ref().map(|path| path.join(product_name));
    let gdk_shared = gdk_base.as_ref().map(|path| {
        path.join("users")
            .join("shared")
            .join("games")
            .join("com.mojang")
    });

    let local_state_roots = local_app_data.as_ref().map(|path| {
        let package_family = family.unwrap_or(if is_preview {
            "Microsoft.MinecraftWindowsBeta_8wekyb3d8bbwe"
        } else {
            "Microsoft.MinecraftUWP_8wekyb3d8bbwe"
        });
        path.join("Packages")
            .join(package_family)
            .join("LocalState")
    });
    let legacy_game_data = local_state_roots
        .as_ref()
        .map(|path| path.join("games").join("com.mojang"));

    let private_game_data = instance_root
        .join("bedrock")
        .join("profiles")
        .join(&instance.minecraft_version)
        .join("com.mojang");

    let use_gdk = gdk_shared.as_ref().is_some_and(|path| path.exists())
        || metadata
            .as_ref()
            .and_then(|value| value.get("packageType"))
            .and_then(serde_json::Value::as_str)
            == Some("gdk")
        || is_gdk_version(&instance.minecraft_version);

    let game_data = if isolated_profile {
        private_game_data
    } else if use_gdk {
        gdk_shared
            .clone()
            .unwrap_or_else(|| PathBuf::from("Minecraft Bedrock/users/shared/games/com.mojang"))
    } else if legacy_game_data.as_ref().is_some_and(|path| path.exists()) {
        legacy_game_data.clone().unwrap_or_default()
    } else if let Some(path) = gdk_shared.clone() {
        path
    } else {
        legacy_game_data.clone().unwrap_or_default()
    };

    let mut pack_game_data = if isolated_profile {
        vec![game_data.clone()]
    } else {
        let mut roots = Vec::new();
        if let Some(path) = &gdk_shared {
            if path.is_dir() {
                roots.push(path.clone());
            }
        }
        if let Some(path) = &legacy_game_data {
            if path.is_dir() {
                roots.push(path.clone());
            }
        }
        roots.push(game_data.clone());
        deduplicate(roots)
    };
    if pack_game_data.is_empty() {
        pack_game_data.push(game_data.clone());
    }

    let mut worlds = Vec::new();
    if isolated_profile {
        worlds.push(game_data.join("minecraftWorlds"));
    } else {
        if let Some(base) = &gdk_base {
            let users = base.join("users");
            if let Ok(entries) = std::fs::read_dir(users) {
                for entry in entries.flatten() {
                    if !entry.file_type().is_ok_and(|kind| kind.is_dir())
                        || entry
                            .file_name()
                            .to_string_lossy()
                            .eq_ignore_ascii_case("shared")
                    {
                        continue;
                    }
                    worlds.push(
                        entry
                            .path()
                            .join("games")
                            .join("com.mojang")
                            .join("minecraftWorlds"),
                    );
                }
            }
        }
        worlds.extend(
            pack_game_data
                .iter()
                .map(|path| path.join("minecraftWorlds")),
        );
    }
    let worlds = deduplicate(worlds);

    let mut logs = Vec::new();
    if let Some(base) = &gdk_base {
        logs.push(base.join("logs"));
    }
    if let Some(local_state) = &local_state_roots {
        logs.push(local_state.join("logs"));
    }
    logs.push(instance_root.join("logs"));
    let screenshots = pack_game_data
        .iter()
        .map(|path| path.join("screenshots"))
        .collect::<Vec<_>>();

    BedrockRoots {
        game_data,
        behavior_packs: pack_game_data
            .iter()
            .map(|path| path.join("behavior_packs"))
            .collect(),
        resource_packs: pack_game_data
            .iter()
            .map(|path| path.join("resource_packs"))
            .collect(),
        skin_packs: pack_game_data
            .iter()
            .map(|path| path.join("skin_packs"))
            .collect(),
        worlds,
        screenshots: deduplicate(screenshots),
        logs: deduplicate(logs),
    }
}

fn read_metadata(instance: &Instance, instance_root: &Path) -> Option<serde_json::Value> {
    let version_root = instance_root
        .join("bedrock")
        .join(&instance.minecraft_version);
    for name in ["runtime.json", "package.json"] {
        let Ok(bytes) = std::fs::read(version_root.join(name)) else {
            continue;
        };
        if let Ok(value) = serde_json::from_slice(&bytes) {
            return Some(value);
        }
    }
    None
}

fn is_gdk_version(value: &str) -> bool {
    let parts = value
        .split('.')
        .take(3)
        .filter_map(|part| part.parse::<u32>().ok())
        .collect::<Vec<_>>();
    parts.len() >= 3 && (parts[0], parts[1], parts[2]) >= (1, 21, 120)
}

pub fn directories_for_category(roots: &BedrockRoots, category: &str) -> Vec<PathBuf> {
    match category {
        "mods" => roots.behavior_packs.clone(),
        "resourcepacks" => roots.resource_packs.clone(),
        "worlds" => roots.worlds.clone(),
        "screenshots" => roots.screenshots.clone(),
        "logs" => roots.logs.clone(),
        _ => Vec::new(),
    }
}

pub fn export_sources(roots: &BedrockRoots) -> Vec<(String, PathBuf)> {
    let mut sources = Vec::new();
    for (category, paths) in [
        ("behavior_packs", &roots.behavior_packs),
        ("resource_packs", &roots.resource_packs),
        ("skin_packs", &roots.skin_packs),
    ] {
        let mut alternate = 0;
        for path in paths.iter().filter(|path| path.is_dir()) {
            let is_active = path == &roots.game_data.join(category);
            let label = if is_active {
                format!("bedrock/{category}")
            } else {
                alternate += 1;
                format!("bedrock/legacy-{alternate}/{category}")
            };
            sources.push((label, path.clone()));
        }
    }
    let mut world_index = 0;
    for world_root in &roots.worlds {
        if !world_root.is_dir() {
            continue;
        }
        world_index += 1;
        let label = if world_index == 1 {
            "bedrock/worlds".to_owned()
        } else {
            format!("bedrock/worlds-{world_index}")
        };
        sources.push((label, world_root.clone()));
    }
    sources
}

fn deduplicate(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut result: Vec<PathBuf> = Vec::new();
    for path in paths {
        let key = normalize(&path);
        if result.iter().all(|existing| normalize(existing) != key) {
            result.push(path);
        }
    }
    result
}

fn normalize(path: &Path) -> String {
    path.to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_ascii_lowercase()
}
