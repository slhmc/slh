use serde_json::Value;
use std::cmp::Ordering;

// Cargo and Tauri accept three SemVer components. Extra numeric components
// are encoded as build metadata (0.2.2.1.2 => 0.2.2+1.2).
#[derive(Debug)]
struct LauncherVersion {
    components: Vec<String>,
    prerelease: semver::Prerelease,
}

fn version(tag: &str) -> Option<LauncherVersion> {
    let input = tag.trim().trim_start_matches(['v', 'V']);
    let (without_build, build) = input.split_once('+').map_or((input, None), |(a, b)| (a, Some(b)));
    let (numbers, pre) = without_build.split_once('-').map_or((without_build, ""), |(a, b)| (a, b));
    if without_build.ends_with('-') || build == Some("") { return None; }
    let mut parts: Vec<&str> = numbers.split('.').collect();
    if parts.len() < 3 || parts.iter().any(|p| p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()) || (p.len() > 1 && p.starts_with('0'))) { return None; }
    let base = format!("{}.{}.{}{}", parts[0], parts[1], parts[2], if pre.is_empty() { String::new() } else { format!("-{pre}") });
    let parsed = semver::Version::parse(&base).ok()?;
    if let Some(build) = build {
        let extra: Vec<&str> = build.split('.').collect();
        if extra.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) && (p.len() == 1 || !p.starts_with('0'))) {
            parts.extend(extra);
        } else {
            // Validate ordinary SemVer build metadata, but do not order it.
            semver::BuildMetadata::new(build).ok()?;
        }
    }
    Some(LauncherVersion { components: parts.into_iter().map(str::to_owned).collect(), prerelease: parsed.pre })
}

fn compare(left: &LauncherVersion, right: &LauncherVersion) -> Ordering {
    for i in 0..left.components.len().max(right.components.len()) {
        let a = left.components.get(i).map(String::as_str).unwrap_or("0");
        let b = right.components.get(i).map(String::as_str).unwrap_or("0");
        let order = a.len().cmp(&b.len()).then_with(|| a.cmp(b));
        if order != Ordering::Equal { return order; }
    }
    left.prerelease.cmp(&right.prerelease)
}

pub fn display_version(version: &str) -> String {
    let Some((base, build)) = version.split_once('+') else { return version.to_owned(); };
    if build.split('.').all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())) {
        if let Some((numbers, pre)) = base.split_once('-') { format!("{numbers}.{build}-{pre}") } else { format!("{base}.{build}") }
    } else { version.to_owned() }
}

pub fn latest_release(releases: &[Value]) -> Option<&Value> {
    releases.iter().filter(|r| r.get("draft").and_then(Value::as_bool) != Some(true))
        .filter_map(|r| Some((version(r.get("tag_name")?.as_str()?)?, r)))
        .max_by(|a, b| compare(&a.0, &b.0)).map(|(_, r)| r)
}

pub fn is_newer(latest: &str, current: &str) -> bool {
    match (version(latest), version(current)) {
        (Some(a), Some(b)) => compare(&a, &b).is_gt(),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn compares_arbitrary_numeric_components_and_prereleases() {
        assert!(is_newer("v0.2.2.1", "0.2.2"));
        assert!(is_newer("0.2.2+1.2.3", "0.2.2.1.2.2"));
        assert!(!is_newer("0.2.2.1", "0.2.2+1"));
        assert!(is_newer("0.2.2.1", "0.2.2.1-rc.2"));
        assert!(is_newer("0.2.3", "0.2.2.999999999999999999999"));
        assert!(!is_newer("0.2.0+build.2", "0.2.0+build.1"));
        assert!(!is_newer("invalid", "0.2.0"));
        assert!(!is_newer("0.9.0-", "0.2.0"));
        assert!(!is_newer("0.9.0+", "0.2.0"));
        assert_eq!(display_version("0.2.2+1.2.3"), "0.2.2.1.2.3");
        assert_eq!(display_version("0.2.2-rc.1+1.2"), "0.2.2.1.2-rc.1");
    }
    #[test]
    fn selects_latest_dotted_release_and_ignores_drafts() {
        let releases = vec![serde_json::json!({"tag_name":"v0.2.2"}), serde_json::json!({"tag_name":"v0.2.2.1"}), serde_json::json!({"tag_name":"v0.3.0", "draft":true})];
        assert_eq!(latest_release(&releases).unwrap()["tag_name"], "v0.2.2.1");
    }
}
