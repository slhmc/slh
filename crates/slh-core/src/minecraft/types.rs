use std::collections::HashMap;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionManifest {
    pub versions: Vec<ManifestVersion>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestVersion {
    pub id: String,
    #[serde(rename = "type")]
    pub version_type: String,
    pub url: String,
    pub sha1: String,
    pub release_time: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionDetails {
    pub id: String,
    #[serde(rename = "type")]
    pub version_type: String,
    pub main_class: String,
    pub assets: String,
    pub asset_index: AssetIndexReference,
    pub downloads: VersionDownloads,
    #[serde(default)]
    pub libraries: Vec<Library>,
    pub arguments: Option<VersionArguments>,
    pub minecraft_arguments: Option<String>,
    pub java_version: Option<JavaVersionRequirement>,
    pub logging: Option<LoggingConfiguration>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JavaVersionRequirement {
    pub component: String,
    pub major_version: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct VersionDownloads {
    pub client: DownloadInfo,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetIndexReference {
    pub id: String,
    pub sha1: String,
    pub size: Option<u64>,
    pub total_size: Option<u64>,
    pub url: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AssetIndex {
    pub objects: HashMap<String, AssetObject>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AssetObject {
    pub hash: String,
    pub size: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct DownloadInfo {
    pub sha1: Option<String>,
    pub size: Option<u64>,
    pub url: String,
    pub path: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Library {
    pub name: String,
    pub url: Option<String>,
    #[serde(default)]
    pub downloads: LibraryDownloads,
    #[serde(default)]
    pub rules: Vec<Rule>,
    pub natives: Option<HashMap<String, String>>,
    pub extract: Option<ExtractRules>,
}

pub fn maven_download(
    coordinate: &str,
    repository: Option<&str>,
    classifier_override: Option<&str>,
) -> Option<DownloadInfo> {
    let (coordinate, extension) = coordinate
        .split_once('@')
        .map_or((coordinate, "jar"), |(value, extension)| (value, extension));
    let parts: Vec<&str> = coordinate.split(':').collect();
    if parts.len() < 3 {
        return None;
    }
    let group = parts[0].replace('.', "/");
    let artifact = parts[1];
    let version = parts[2];
    let classifier = classifier_override.or_else(|| parts.get(3).copied());
    let file_name = match classifier {
        Some(classifier) => format!("{artifact}-{version}-{classifier}.{extension}"),
        None => format!("{artifact}-{version}.{extension}"),
    };
    let path = format!("{group}/{artifact}/{version}/{file_name}");
    let base = repository
        .unwrap_or("https://libraries.minecraft.net/")
        .trim_end_matches('/');
    Some(DownloadInfo {
        sha1: None,
        size: None,
        url: format!("{base}/{path}"),
        path: Some(path),
    })
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct LibraryDownloads {
    pub artifact: Option<DownloadInfo>,
    #[serde(default)]
    pub classifiers: HashMap<String, DownloadInfo>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ExtractRules {
    #[serde(default)]
    pub exclude: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct VersionArguments {
    #[serde(default)]
    pub game: Vec<Argument>,
    #[serde(default)]
    pub jvm: Vec<Argument>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub enum Argument {
    Plain(String),
    Conditional(ConditionalArgument),
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ConditionalArgument {
    pub rules: Vec<Rule>,
    pub value: ArgumentValue,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub enum ArgumentValue {
    One(String),
    Many(Vec<String>),
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Rule {
    pub action: String,
    pub os: Option<OsRule>,
    pub features: Option<HashMap<String, bool>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct OsRule {
    pub name: Option<String>,
    pub version: Option<String>,
    pub arch: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct LoggingConfiguration {
    pub client: LoggingClient,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct LoggingClient {
    pub argument: String,
    pub file: DownloadInfo,
    #[serde(rename = "type")]
    pub logging_type: String,
}

pub fn rules_allow(rules: &[Rule], custom_resolution: bool) -> bool {
    rules_allow_for(
        rules,
        custom_resolution,
        crate::platform::RuntimeTarget::host(),
    )
}
pub fn rules_allow_for(
    rules: &[Rule],
    custom_resolution: bool,
    target: crate::platform::RuntimeTarget,
) -> bool {
    rules_allow_for_version(rules, custom_resolution, target, crate::platform::os_version())
}
fn rules_allow_for_version(rules: &[Rule], custom_resolution: bool, target: crate::platform::RuntimeTarget, os_version: &str) -> bool {
    if rules.is_empty() {
        return true;
    }
    let mut allowed = false;
    for rule in rules {
        if rule_matches(rule, custom_resolution, target, os_version) {
            allowed = rule.action == "allow";
        }
    }
    allowed
}

fn rule_matches(
    rule: &Rule,
    custom_resolution: bool,
    target: crate::platform::RuntimeTarget,
    os_version: &str,
) -> bool {
    if let Some(os) = &rule.os {
        if let Some(name) = &os.name {
            if name != target.os.minecraft_name() {
                return false;
            }
        }
        if let Some(arch) = &os.arch {
            use crate::platform::Architecture;
            let matches = match target.java_arch {
                Architecture::X86 => ["x86", "i386", "i686"].contains(&arch.as_str()),
                Architecture::X64 => ["x86_64", "amd64", "x64"].contains(&arch.as_str()),
                Architecture::Arm64 => ["aarch64", "arm64"].contains(&arch.as_str()),
            };
            if !matches {
                return false;
            }
        }
        if let Some(pattern) = &os.version {
            if let Ok(regex) = regex::Regex::new(pattern) {
                if !regex.is_match(os_version) {
                    return false;
                }
            }
        }
    }
    if let Some(features) = &rule.features {
        for (feature, expected) in features {
            let actual = match feature.as_str() {
                "has_custom_resolution" => custom_resolution,
                "is_demo_user" => false,
                "has_quick_plays_support"
                | "is_quick_play_singleplayer"
                | "is_quick_play_multiplayer"
                | "is_quick_play_realms" => false,
                _ => false,
            };
            if actual != *expected {
                return false;
            }
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rules_match_java_architecture_and_real_os_version() {
        use crate::platform::{Architecture, OperatingSystem, RuntimeTarget};
        let target = RuntimeTarget { os: OperatingSystem::MacOs, java_arch: Architecture::Arm64 };
        let rules = vec![Rule { action: "allow".into(),
            os: Some(OsRule { name: Some("osx".into()), arch: Some("aarch64".into()), version: Some("^14\\.".into()) }),
            features: None }];
        assert!(rules_allow_for_version(&rules, false, target, "14.6"));
        assert!(!rules_allow_for_version(&rules, false, target, "13.6"));
        assert!(!rules_allow_for_version(&rules, false, RuntimeTarget { java_arch: Architecture::X64, ..target }, "14.6"));
    }

    #[test]
    fn maven_coordinate_becomes_https_download() {
        let download = maven_download(
            "net.fabricmc:fabric-loader:0.16.14",
            Some("https://maven.fabricmc.net/"),
            None,
        )
        .unwrap();
        assert_eq!(
            download.path.as_deref(),
            Some("net/fabricmc/fabric-loader/0.16.14/fabric-loader-0.16.14.jar")
        );
        assert_eq!(
            download.url,
            "https://maven.fabricmc.net/net/fabricmc/fabric-loader/0.16.14/fabric-loader-0.16.14.jar"
        );
    }

    #[test]
    fn rules_apply_last_matching_action() {
        let rules = vec![
            Rule {
                action: "allow".into(),
                os: Some(OsRule {
                    name: Some(
                        crate::platform::OperatingSystem::current()
                            .minecraft_name()
                            .into(),
                    ),
                    version: None,
                    arch: None,
                }),
                features: None,
            },
            Rule {
                action: "disallow".into(),
                os: None,
                features: Some(HashMap::from([("has_custom_resolution".into(), true)])),
            },
        ];
        assert!(!rules_allow(&rules, true));
        assert!(rules_allow(&rules, false));
    }
}
