use serde_json::Value;

fn version(tag: &str) -> Option<semver::Version> {
    semver::Version::parse(tag.trim().trim_start_matches(['v', 'V'])).ok()
}

pub fn latest_release(releases: &[Value]) -> Option<&Value> {
    releases.iter()
        .filter(|release| release.get("draft").and_then(Value::as_bool) != Some(true))
        .filter_map(|release| Some((version(release.get("tag_name")?.as_str()?)?, release)))
        // Published preview builds remain discoverable. SemVer correctly puts
        // alpha/beta/rc before the stable release with the same numeric version.
        .max_by(|left, right| left.0.cmp_precedence(&right.0))
        .map(|(_, release)| release)
}

pub fn is_newer(latest: &str, current: &str) -> bool {
    match (version(latest), version(current)) {
        (Some(latest), Some(current)) => latest.cmp_precedence(&current).is_gt(),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stable_versions_are_newer_than_their_prereleases() {
        assert!(!is_newer("v0.2.0-beta.1", "0.2.0"));
        assert!(is_newer("v0.2.0", "0.2.0-rc.2"));
        assert!(!is_newer("0.2.0+build.2", "0.2.0+build.1"));
        assert!(!is_newer("invalid", "0.2.0"));
    }
    #[test]
    fn ignores_drafts_and_invalid_tags() {
        let releases = vec![
            serde_json::json!({"tag_name":"v0.2.0-beta.1"}),
            serde_json::json!({"tag_name":"v0.2.0"}),
            serde_json::json!({"tag_name":"v0.3.0", "draft":true}),
            serde_json::json!({"tag_name":"preview"}),
        ];
        assert_eq!(latest_release(&releases).unwrap()["tag_name"], "v0.2.0");
    }
}
