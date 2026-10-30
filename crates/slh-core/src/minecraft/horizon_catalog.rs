//! Stable game releases only: launcher and nightly tags are never executable candidates.
use crate::{
    error::{AppError, AppResult},
    models::LoaderVersion,
    state::AppState,
};
use futures_util::{StreamExt, stream};
use serde::{Deserialize, Serialize};
use std::path::Path;

const API: &str = "https://api.github.com/repos/horizon-rust/horizon";
const RAW: &str = "https://raw.githubusercontent.com/horizon-rust/horizon";
const ASSET: &str = "horizon-windows-x64.zip";
static CATALOG_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub fn valid_tag(tag: &str) -> bool {
    let Some(tag) = tag.strip_prefix('v') else {
        return false;
    };
    let parts: Vec<_> = tag.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.len() <= 8 && p.bytes().all(|b| b.is_ascii_digit()))
}

pub fn valid_game(version: &str) -> bool {
    !version.is_empty()
        && version.len() <= 64
        && version != "."
        && version != ".."
        && version
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

fn valid_hash(hash: &str, length: usize) -> bool {
    hash.len() == length && hash.bytes().all(|b| b.is_ascii_hexdigit())
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct GameLock {
    pub version: String,
    pub manifest_sha1: String,
    pub java_major: u32,
}

impl GameLock {
    pub fn parse(bytes: &[u8]) -> AppResult<Self> {
        let value: serde_json::Value = serde_json::from_slice(bytes)?;
        let lock: Self = serde_json::from_value(value["minecraft"].clone()).map_err(|_| AppError::Unavailable("Unsupported Horizon research-lock format; update SLH before installing this release".into()))?;
        if !valid_game(&lock.version)
            || !valid_hash(&lock.manifest_sha1, 40)
            || !(8..=100).contains(&lock.java_major)
        {
            return Err(AppError::Security(
                "Invalid Horizon Minecraft compatibility metadata".into(),
            ));
        }
        Ok(lock)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Release {
    pub tag: String,
    pub url: String,
    pub sha256: String,
    pub game: GameLock,
}

#[derive(Deserialize)]
struct ApiRelease {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    assets: Vec<ApiAsset>,
}
#[derive(Deserialize)]
struct ApiAsset {
    name: String,
    browser_download_url: String,
    digest: Option<String>,
}

fn game_asset(release: &ApiRelease) -> Option<(&ApiAsset, &str)> {
    if release.draft || release.prerelease || !valid_tag(&release.tag_name) {
        return None;
    }
    let asset = release.assets.iter().find(|a| a.name == ASSET)?;
    let digest = asset.digest.as_deref()?.strip_prefix("sha256:")?;
    let expected = format!(
        "https://github.com/horizon-rust/horizon/releases/download/{}/{}",
        release.tag_name, ASSET
    );
    (valid_hash(digest, 64) && asset.browser_download_url == expected).then_some((asset, digest))
}

async fn bounded_json<T: serde::de::DeserializeOwned>(
    client: &reqwest::Client,
    url: &str,
) -> AppResult<T> {
    let bytes = client
        .get(url)
        .header("User-Agent", "SLH-Horizon")
        .send()
        .await?
        .error_for_status()?
        .bytes()
        .await?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err(AppError::Security(
            "Horizon metadata response is too large".into(),
        ));
    }
    Ok(serde_json::from_slice(&bytes)?)
}

async fn describe(client: &reqwest::Client, api: ApiRelease) -> AppResult<Release> {
    let (asset, digest) = game_asset(&api).ok_or_else(|| {
        AppError::Unavailable(
            "This Horizon release has no verified Windows x64 game archive".into(),
        )
    })?;
    let url = asset.browser_download_url.clone();
    let sha256 = digest.to_owned();
    let value: serde_json::Value = bounded_json(
        client,
        &format!("{RAW}/{}/research-lock.json", api.tag_name),
    )
    .await?;
    let game = GameLock::parse(&serde_json::to_vec(&value)?)?;
    Ok(Release {
        tag: api.tag_name,
        url,
        sha256,
        game,
    })
}

pub async fn release(state: &AppState, tag: &str) -> AppResult<Release> {
    if !valid_tag(tag) {
        return Err(AppError::InvalidInput("Invalid Horizon release tag".into()));
    }
    // A direct lookup keeps old pinned instances repairable even after they
    // disappear from the bounded recent-release catalog.
    describe(
        &state.http,
        bounded_json(&state.http, &format!("{API}/releases/tags/{tag}")).await?,
    )
    .await
}

async fn fetch_catalog(state: &AppState) -> AppResult<Vec<Release>> {
    let mut candidates = Vec::new();
    for page in 1..=3 {
        let entries: Vec<ApiRelease> = bounded_json(
            &state.http,
            &format!("{API}/releases?per_page=100&page={page}"),
        )
        .await?;
        let last = entries.len() < 100;
        candidates.extend(entries.into_iter().filter(|r| game_asset(r).is_some()));
        if last || candidates.len() >= 60 {
            break;
        }
    }
    let mut releases = stream::iter(
        candidates
            .into_iter()
            .map(|api| async move { describe(&state.http, api).await }),
    )
    .buffer_unordered(8)
    .filter_map(|result| async move {
        match result {
            Ok(release) => Some(release),
            Err(error) => {
                tracing::warn!(%error, "Horizon release metadata unavailable");
                None
            }
        }
    })
    .collect::<Vec<_>>()
    .await;
    releases.sort_by(|a, b| release_order(&b.tag).cmp(&release_order(&a.tag)));
    releases.dedup_by(|a, b| a.tag == b.tag);
    if releases.is_empty() {
        return Err(AppError::Unavailable(
            "No compatible verified Horizon releases were found; retry when GitHub is available"
                .into(),
        ));
    }
    Ok(releases)
}

fn version_parts(tag: &str) -> Vec<u64> {
    tag.trim_start_matches('v')
        .split('.')
        .map(|p| p.parse().unwrap_or(0))
        .collect()
}

fn release_order(tag: &str) -> (bool, Vec<u64>) {
    let parts = version_parts(tag);
    // Before 0.2 Horizon used calendar tags. A year such as 2026 must not
    // rank above the modern 0.2/0.3 series and become the recommended release.
    let calendar = parts.len() == 3
        && (2000..=2999).contains(&parts[0])
        && (1..=12).contains(&parts[1])
        && (1..=31).contains(&parts[2]);
    (!calendar, parts)
}

async fn read_cache(path: &Path) -> AppResult<Vec<Release>> {
    if tokio::fs::metadata(path).await?.len() > 8 * 1024 * 1024 {
        return Err(AppError::Security(
            "Horizon catalog cache is too large".into(),
        ));
    }
    let releases: Vec<Release> = serde_json::from_slice(&tokio::fs::read(path).await?)?;
    let mut releases = releases
        .into_iter()
        .filter(|r| valid_tag(&r.tag) && valid_game(&r.game.version) && valid_hash(&r.sha256, 64))
        .collect::<Vec<_>>();
    releases.sort_by(|a, b| release_order(&b.tag).cmp(&release_order(&a.tag)));
    Ok(releases)
}

fn write_cache(path: &Path, releases: &[Release]) -> AppResult<()> {
    std::fs::create_dir_all(path.parent().unwrap())?;
    let mut temporary = tempfile::NamedTempFile::new_in(path.parent().unwrap())?;
    serde_json::to_writer(&mut temporary, releases)?;
    temporary
        .persist(path)
        .map_err(|error| AppError::Io(error.error))?;
    Ok(())
}

async fn catalog(state: &AppState) -> AppResult<Vec<Release>> {
    let _catalog_guard = CATALOG_LOCK.lock().await;
    let path = state.paths.cache.join("horizon/releases.json");
    let fresh = tokio::fs::metadata(&path)
        .await
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.elapsed().ok())
        .is_some_and(|age| age.as_secs() < 300);
    let cached = read_cache(&path)
        .await
        .ok()
        .filter(|items| !items.is_empty());
    let releases = if fresh && cached.is_some() {
        cached.unwrap()
    } else {
        match fetch_catalog(state).await {
            Ok(items) => {
                if let Err(error) = write_cache(&path, &items) {
                    tracing::warn!(%error,"could not persist Horizon catalog cache");
                }
                items
            }
            Err(error) => match cached {
                Some(items) => items,
                None => return Err(error),
            },
        }
    };
    Ok(releases)
}

pub async fn minecraft_versions(state: &AppState) -> AppResult<Vec<String>> {
    let mut games = Vec::new();
    for release in catalog(state).await? {
        if !games.contains(&release.game.version) { games.push(release.game.version); }
    }
    Ok(games)
}

pub async fn versions(state: &AppState, minecraft: &str) -> AppResult<Vec<LoaderVersion>> {
    Ok(catalog(state).await?
        .into_iter()
        .filter(|r| r.game.version == minecraft)
        .enumerate()
        .map(|(i, r)| LoaderVersion {
            id: r.tag,
            stable: true,
            recommended: i == 0,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn cached_catalog_is_atomic_and_filters_new_minecraft_versions() {
        let temp = tempfile::tempdir().unwrap();
        let paths = crate::portable::PortablePaths::from_executable(
            &temp.path().join("SLH.exe"),
            Some(temp.path().to_path_buf()),
        )
        .unwrap();
        let state = AppState::initialize_isolated_at(paths).await.unwrap();
        let stable=Release { tag:"v0.2.97".into(),url:"https://github.com/horizon-rust/horizon/releases/download/v0.2.97/horizon-windows-x64.zip".into(),sha256:"a".repeat(64),game:GameLock {version:"26.3".into(),manifest_sha1:"b".repeat(40),java_major:25} };
        let mut future = stable.clone();
        future.tag = "v0.3.0".into();
        future.game.version = "26.4".into();
        future.game.java_major = 26;
        let mut old = stable.clone();
        old.tag = "v2026.10.13".into();
        let cache = state.paths.cache.join("horizon/releases.json");
        write_cache(&cache, &[old.clone(), stable.clone()]).unwrap();
        write_cache(&cache, &[old, future, stable]).unwrap();
        let versions = versions(&state, "26.4").await.unwrap();
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].id, "v0.3.0");
        assert!(versions[0].recommended);
        let versions = super::versions(&state, "26.3").await.unwrap();
        assert_eq!(versions[0].id, "v0.2.97");
        assert!(versions[0].recommended);
        assert!(!versions[1].recommended);
        assert!(super::versions(&state, "1.21.8").await.unwrap().is_empty());
        state.database.close().await;
    }
    #[test]
    fn future_game_and_release_need_no_version_constants() {
        assert!(valid_tag("v0.3.0"));
        assert!(valid_tag("v12.1.205"));
        for tag in [
            "launcher@0.3.0",
            "launcher-v0.3.0",
            "nightly-2026-10-29",
            "../v0.3.0",
            "v0.3.0-beta",
        ] {
            assert!(!valid_tag(tag));
        }
        let lock=GameLock::parse(br#"{"minecraft":{"version":"26.4","java_major":25,"manifest_sha1":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}"#).unwrap();
        assert_eq!(lock.version, "26.4");
        assert!(
            GameLock::parse(
                br#"{"minecraft":{"version":"../26.4","java_major":25,"manifest_sha1":"bad"}}"#
            )
            .is_err()
        );
        assert!(GameLock::parse(br#"{"new_format":true}"#).is_err());
        assert!(version_parts("v0.3.0") > version_parts("v0.2.999"));
        assert!(release_order("v0.2.97") > release_order("v2026.10.13"));
    }
    #[test]
    fn game_release_requires_the_correct_asset_and_checksum() {
        let mut api = ApiRelease {
            tag_name: "v0.3.0".into(),
            draft: false,
            prerelease: false,
            assets: vec![ApiAsset {
                name: ASSET.into(),
                browser_download_url: format!(
                    "https://github.com/horizon-rust/horizon/releases/download/v0.3.0/{ASSET}"
                ),
                digest: Some(format!("sha256:{}", "a".repeat(64))),
            }],
        };
        assert!(game_asset(&api).is_some());
        api.assets[0].digest = None;
        assert!(game_asset(&api).is_none());
    }
}
