//! Conservative, reviewed garbage collection. No caller-supplied deletion paths.
use crate::{
    database,
    error::{AppError, AppResult},
    local_servers::{providers::hash_file, store::plain_path},
    state::AppState,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::OnceLock,
};
use tokio::sync::RwLock;

pub fn gate() -> &'static RwLock<()> {
    static GATE: OnceLock<RwLock<()>> = OnceLock::new();
    GATE.get_or_init(|| RwLock::new(()))
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupEntry {
    pub id: String,
    pub category: String,
    pub path: String,
    pub size: u64,
    pub fingerprint: String,
    pub kind: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupScan {
    pub id: String,
    pub entries: Vec<CleanupEntry>,
    pub busy: bool,
    pub created_at: i64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupResult {
    pub removed_files: u64,
    pub removed_bytes: u64,
    pub skipped: u64,
    pub errors: Vec<String>,
}

fn scan_path(state: &AppState, id: &str) -> AppResult<PathBuf> {
    uuid::Uuid::parse_str(id).map_err(|_| AppError::InvalidInput("Invalid cleanup scan".into()))?;
    Ok(state
        .paths
        .data
        .join("maintenance")
        .join(format!("{id}.json")))
}
fn fingerprint(path: &Path) -> AppResult<(u64, String)> {
    plain_path(path)?;
    let meta = std::fs::symlink_metadata(path)?;
    if !meta.is_file() {
        return Err(AppError::Security(
            "Cleanup accepts regular files only".into(),
        ));
    }
    let modified = meta
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    Ok((
        meta.len(),
        format!("{}:{modified}:{}", meta.len(), hash_file(path, None, None)?),
    ))
}
fn candidate(entries: &mut Vec<CleanupEntry>, category: &str, path: &Path) {
    if let Ok((size, fingerprint)) = fingerprint(path) {
        entries.push(CleanupEntry {
            id: uuid::Uuid::new_v4().to_string(),
            category: category.into(),
            path: path.to_string_lossy().into_owned(),
            size,
            fingerprint,
            kind: "file".into(),
        });
    }
}
fn files(root: &Path) -> Vec<PathBuf> {
    if plain_path(root).is_err() {
        return vec![];
    }
    walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| plain_path(e.path()).is_ok())
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .map(|e| e.into_path())
        .collect()
}
fn old(path: &Path, seconds: u64) -> bool {
    path.metadata()
        .and_then(|m| m.modified())
        .ok()
        .and_then(|m| m.elapsed().ok())
        .is_some_and(|age| age.as_secs() > seconds)
}
pub async fn busy(state: &AppState) -> AppResult<bool> {
    let clients: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM instances WHERE status IN ('installing','launching','running')",
    )
    .fetch_one(&state.database)
    .await?;
    let servers = crate::local_servers::list(state)
        .await?
        .into_iter()
        .any(|s| {
            ["installing", "starting", "running", "stopping", "unmanaged"]
                .contains(&s.status.as_str())
        });
    Ok(clients > 0 || servers)
}
fn version_files(instance: &crate::models::Instance) -> Vec<PathBuf> {
    Path::new(&instance.game_dir)
        .parent()
        .map(|p| files(&p.join("versions")))
        .unwrap_or_default()
        .into_iter()
        .filter(|p| p.extension().is_some_and(|s| s == "json"))
        .collect()
}
fn collect_libraries(
    value: &Value,
    root: &Path,
    output: &mut HashSet<PathBuf>,
    known: &mut HashMap<PathBuf, (String, String)>,
) {
    for lib in value["libraries"].as_array().into_iter().flatten() {
        let mut references = vec![&lib["downloads"]["artifact"]];
        if let Some(classifiers) = lib["downloads"]["classifiers"].as_object() {
            references.extend(classifiers.values());
        }
        for reference in references {
            if let Some(rel) = reference["path"].as_str() {
                let relative = Path::new(rel);
                if relative.is_absolute()
                    || relative
                        .components()
                        .any(|c| matches!(c, std::path::Component::ParentDir))
                {
                    continue;
                }
                let path = root.join(relative);
                output.insert(path.clone());
                if let Some(hash) = reference["sha1"].as_str() {
                    known.insert(path, ("sha1".into(), hash.into()));
                }
            }
        }
        if let Some(name) = lib["name"].as_str() {
            if let Some(artifact) = crate::minecraft::types::maven_download(name, None, None) {
                if let Some(p) = artifact.path {
                    output.insert(root.join(p));
                }
            }
        }
        // Older profiles describe native names without published paths.
        if let Some(natives) = lib["natives"].as_object() {
            for classifier in natives.values().filter_map(Value::as_str) {
                for arch in ["32", "64"] {
                    if let Some(name) = lib["name"].as_str() {
                        if let Some(artifact) = crate::minecraft::types::maven_download(
                            name,
                            None,
                            Some(&classifier.replace("${arch}", arch)),
                        ) {
                            if let Some(p) = artifact.path {
                                output.insert(root.join(p));
                            }
                        }
                    }
                }
            }
        }
    }
}
async fn discover(state: &AppState) -> AppResult<CleanupScan> {
    let mut entries = vec![];
    let busy = busy(state).await?;
    let rows: Vec<(String, String, String)> =
        sqlx::query_as("SELECT cache_key,payload_json,updated_at FROM content_cache")
            .fetch_all(&state.database)
            .await?;
    for (key, payload, stamp) in rows {
        entries.push(CleanupEntry {
            id: uuid::Uuid::new_v4().to_string(),
            category: "metadata".into(),
            path: key,
            size: payload.len() as u64,
            fingerprint: stamp,
            kind: "db-cache".into(),
        });
    }
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT key,value_json,updated_at FROM settings WHERE key LIKE 'server-catalog:%'",
    )
    .fetch_all(&state.database)
    .await?;
    for (key, payload, stamp) in rows {
        entries.push(CleanupEntry {
            id: uuid::Uuid::new_v4().to_string(),
            category: "metadata".into(),
            path: key,
            size: payload.len() as u64,
            fingerprint: stamp,
            kind: "setting-cache".into(),
        });
    }
    // Destructive maintenance is paused while games, servers or installers use these roots.
    if busy {
        return Ok(CleanupScan {
            id: uuid::Uuid::new_v4().to_string(),
            entries: vec![],
            busy,
            created_at: chrono::Utc::now().timestamp(),
        });
    }
    let instances = database::instances(&state.database).await?;
    let library_root = state.paths.cache.join("minecraft/libraries");
    let mut used = HashSet::new();
    let mut known = HashMap::new();
    let mut pinned_versions = HashSet::new();
    let mut pinned_assets: HashSet<String> = HashSet::new();
    let mut complete = true;
    let mut profile_ids = HashSet::new();
    for instance in &instances {
        if instance.loader_type == "bedrock" {
            continue;
        }
        pinned_versions.insert(instance.minecraft_version.clone());
        let profiles = version_files(instance);
        if profiles.is_empty() && instance.status == "installed" {
            complete = false;
        }
        for path in profiles {
            match std::fs::read(&path)
                .ok()
                .and_then(|s| serde_json::from_slice::<Value>(&s).ok())
            {
                Some(value) => {
                    if let Some(id) = value["id"].as_str() {
                        profile_ids.insert(id.to_owned());
                    }
                    collect_libraries(&value, &library_root, &mut used, &mut known);
                    if let Some(id) = value["inheritsFrom"].as_str() {
                        pinned_versions.insert(id.into());
                    }
                    if let Some(id) = value["assetIndex"]["id"].as_str() {
                        pinned_assets.insert(id.into());
                    }
                }
                None => complete = false,
            }
        }
    }
    for server in crate::local_servers::list(state).await? {
        pinned_versions.insert(server.config.minecraft_version);
    }
    let mut cached_versions = Vec::new();
    for path in files(&state.paths.cache.join("minecraft/versions")) {
        if path.extension().is_none_or(|e| e != "json") {
            continue;
        }
        if let Ok(value) = serde_json::from_slice::<Value>(&std::fs::read(&path)?) {
            if value["id"]
                .as_str()
                .is_some_and(|id| path.file_stem().is_some_and(|s| s == id))
            {
                cached_versions.push((path, value));
            }
        }
    }
    // Resolve the entire inheritance chain independently of directory traversal order.
    loop {
        let count = pinned_versions.len();
        for (_, value) in &cached_versions {
            if value["id"]
                .as_str()
                .is_some_and(|id| pinned_versions.contains(id))
            {
                if let Some(parent) = value["inheritsFrom"].as_str() {
                    pinned_versions.insert(parent.to_owned());
                }
            }
        }
        if count == pinned_versions.len() {
            break;
        }
    }
    if pinned_versions.iter().any(|id| {
        !profile_ids.contains(id)
            && !cached_versions
                .iter()
                .any(|(_, v)| v["id"].as_str() == Some(id.as_str()))
    }) {
        complete = false;
    }
    let mut known_assets = HashSet::new();
    for (path, value) in &cached_versions {
        let id = value["id"].as_str().unwrap();
        let mut references = HashSet::new();
        collect_libraries(value, &library_root, &mut references, &mut known);
        if let Some(asset) = value["assetIndex"]["id"].as_str() {
            known_assets.insert(asset.to_owned());
        }
        if pinned_versions.contains(id) {
            used.extend(references);
            if let Some(asset) = value["assetIndex"]["id"].as_str() {
                pinned_assets.insert(asset.to_owned());
            }
        } else {
            candidate(&mut entries, "versions", path);
        }
    }
    if complete {
        for (path, (algorithm, digest)) in known {
            if !used.contains(&path)
                && path.is_file()
                && hash_file(&path, Some(&algorithm), Some(&digest)).is_ok()
            {
                candidate(&mut entries, "libraries", &path);
            }
        }
        for path in files(&state.paths.cache.join("minecraft/assets/indexes")) {
            let id = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            if pinned_assets.contains(id) || !known_assets.contains(id) {
                continue;
            }
            let Ok(value) = serde_json::from_slice::<Value>(&std::fs::read(&path)?) else {
                continue;
            };
            let Some(objects) = value["objects"].as_object() else {
                continue;
            };
            candidate(&mut entries, "derived", &path);
            for (relative, object) in objects {
                let p = Path::new(relative);
                if p.is_absolute()
                    || p.components()
                        .any(|c| matches!(c, std::path::Component::ParentDir))
                {
                    continue;
                }
                let virtual_file = state
                    .paths
                    .cache
                    .join("minecraft/assets/virtual")
                    .join(id)
                    .join(p);
                if let Some(hash) = object["hash"].as_str() {
                    if hash_file(&virtual_file, Some("sha1"), Some(hash)).is_ok() {
                        candidate(&mut entries, "derived", &virtual_file);
                    }
                }
            }
        }
    }
    let manifest = state.paths.cache.join("minecraft/version_manifest_v2.json");
    if manifest.is_file() {
        candidate(&mut entries, "metadata", &manifest);
    }
    // A hash-keyed successful import receipt is proof that the browser ZIP is redundant.
    let receipts: Vec<(String, String)> =
        sqlx::query_as("SELECT key,value_json FROM settings WHERE key LIKE 'curseforge-import:%'")
            .fetch_all(&state.database)
            .await?;
    let browser = crate::content::curseforge::browser_download_directory(state).await?;
    let mut archive_proof: HashMap<String, Value> = HashMap::new();
    for (key, json) in receipts {
        if let Ok(value) = serde_json::from_str::<Value>(&json) {
            if value["pending"] == false
                && value["instanceId"].as_str().is_some_and(|id| {
                    instances
                        .iter()
                        .any(|s| s.id == id && s.status == "installed")
                })
            {
                archive_proof.insert(key.trim_start_matches("curseforge-import:").into(), value);
            }
        }
    }
    let mut archive_roots = vec![
        (state.paths.downloads.join("curseforge-packs"), "archives"),
        (state.paths.downloads.join("modrinth-packs"), "archives"),
    ];
    let server_roots: Vec<_> = crate::local_servers::list(state)
        .await?
        .into_iter()
        .map(|s| PathBuf::from(s.path))
        .collect();
    if let Some(browser) = browser {
        let protected = server_roots.iter().any(|p| browser.starts_with(p))
            || [
                state.paths.accounts.clone(),
                state.paths.backups.clone(),
                state.paths.shared.clone(),
                state.paths.java.clone(),
                state.paths.root.join("resources"),
            ]
            .iter()
            .any(|p| browser.starts_with(p));
        if !protected {
            if !instances
                .iter()
                .any(|i| Path::new(&browser).starts_with(&i.game_dir))
            {
                archive_roots.push((browser, "browserArchives"));
            }
        }
    }
    let installed_packs: HashSet<String> =
        sqlx::query_scalar("SELECT id FROM instances WHERE status='installed'")
            .fetch_all(&state.database)
            .await?
            .into_iter()
            .collect();
    for (directory, category) in archive_roots {
        if let Ok(children) = std::fs::read_dir(directory) {
            for child in children.filter_map(Result::ok) {
                let path = child.path();
                if !path.extension().is_some_and(|e| {
                    e.eq_ignore_ascii_case("zip") || e.eq_ignore_ascii_case("mrpack")
                }) || plain_path(&path).is_err()
                {
                    continue;
                }
                let size = path.metadata().map(|m| m.len()).unwrap_or(0);
                if size == 0 || size > 512 * 1024 * 1024 {
                    continue;
                }
                let mut eligible = false;
                if !archive_proof.is_empty() {
                    use sha1::Digest;
                    use std::io::Read;
                    let mut f = std::fs::File::open(&path)?;
                    let mut hash = sha1::Sha1::new();
                    let mut b = vec![0u8; 128 * 1024];
                    loop {
                        let n = f.read(&mut b)?;
                        if n == 0 {
                            break;
                        }
                        hash.update(&b[..n]);
                    }
                    eligible = archive_proof.contains_key(&hex::encode(hash.finalize()));
                }
                // A recorded managed Modrinth archive is only disposable after that pack installed.
                if !eligible && category == "archives" {
                    let record: Option<(String, Option<String>, i64)> = sqlx::query_as(
                        "SELECT sha256,owner_id,completed FROM managed_artifacts WHERE path=?",
                    )
                    .bind(path.to_string_lossy().as_ref())
                    .fetch_optional(&state.database)
                    .await?;
                    if let Some((hash, owner, 1)) = record {
                        eligible = owner.is_some_and(|id| installed_packs.contains(&id))
                            && hash_file(&path, Some("sha256"), Some(&hash)).is_ok();
                    }
                }
                if eligible {
                    candidate(&mut entries, category, &path);
                }
            }
        }
    }
    let old_downloads: Vec<String> = sqlx::query_scalar(
        "SELECT destination FROM downloads WHERE status IN ('failed','cancelled','complete')",
    )
    .fetch_all(&state.database)
    .await?;
    let known_temps: HashSet<_> = old_downloads
        .iter()
        .filter_map(|s| {
            let p = Path::new(s);
            Some(p.with_file_name(format!(".{}.slh-part", p.file_name()?.to_str()?)))
        })
        .collect();
    for path in files(&state.paths.downloads) {
        if known_temps.contains(&path) && old(&path, 24 * 3600) {
            candidate(&mut entries, "temporary", &path);
        }
    }
    let log_files = files(&state.paths.logs);
    let latest = log_files
        .iter()
        .max_by_key(|p| p.metadata().and_then(|m| m.modified()).ok());
    for path in &log_files {
        if Some(path) != latest && old(path, 7 * 24 * 3600) {
            candidate(&mut entries, "logs", path);
        }
    }
    let protected: Vec<PathBuf> = server_roots
        .into_iter()
        .chain(instances.iter().map(|s| PathBuf::from(&s.game_dir)))
        .chain([
            state.paths.accounts.clone(),
            state.paths.backups.clone(),
            state.paths.shared.clone(),
            state.paths.java.clone(),
            state.paths.instances.clone(),
            state.paths.root.join("resources"),
        ])
        .collect();
    entries.retain(|e| {
        e.kind != "file" || !protected.iter().any(|p| Path::new(&e.path).starts_with(p))
    });
    // Logs inside profiles are not scanned: they may be user-managed or held by Java.
    Ok(CleanupScan {
        id: uuid::Uuid::new_v4().to_string(),
        entries,
        busy,
        created_at: chrono::Utc::now().timestamp(),
    })
}
pub async fn scan(state: &AppState) -> AppResult<CleanupScan> {
    let _lock = gate().write().await;
    let result = discover(state).await?;
    super::local_servers::store::atomic_write(
        &scan_path(state, &result.id)?,
        &serde_json::to_vec(&result)?,
    )?;
    Ok(result)
}
pub async fn execute(
    state: &AppState,
    id: &str,
    entry_ids: Vec<String>,
) -> AppResult<CleanupResult> {
    let _lock = gate().write().await;
    if busy(state).await? {
        return Err(AppError::Conflict(
            "Stop running games, servers and installations before cleanup".into(),
        ));
    }
    let path = scan_path(state, id)?;
    plain_path(&path)?;
    if path.metadata()?.len() > 64 * 1024 * 1024 {
        return Err(AppError::Security("Cleanup manifest is too large".into()));
    }
    let saved: CleanupScan = serde_json::from_slice(&std::fs::read(&path)?)?;
    if chrono::Utc::now().timestamp() - saved.created_at > 7200 {
        return Err(AppError::Conflict(
            "Cleanup preview expired; scan again".into(),
        ));
    }
    let selected: HashSet<_> = entry_ids.into_iter().collect();
    let fresh = discover(state).await?;
    let valid: HashMap<_, _> = fresh
        .entries
        .into_iter()
        .map(|e| ((e.kind.clone(), e.path.clone()), e))
        .collect();
    let mut result = CleanupResult {
        removed_files: 0,
        removed_bytes: 0,
        skipped: 0,
        errors: vec![],
    };
    for entry in saved
        .entries
        .into_iter()
        .filter(|e| selected.contains(&e.id))
    {
        if !valid
            .get(&(entry.kind.clone(), entry.path.clone()))
            .is_some_and(|now| now.fingerprint == entry.fingerprint && now.size == entry.size)
        {
            result.skipped += 1;
            continue;
        }
        let removal:AppResult<bool>=async{match entry.kind.as_str(){
            "file"=>{let p=Path::new(&entry.path);let (size,stamp)=fingerprint(p)?;if stamp!=entry.fingerprint||size!=entry.size{return Ok(false);}std::fs::remove_file(p)?;result.removed_bytes+=size;Ok(true)},
            "db-cache"=>Ok(sqlx::query("DELETE FROM content_cache WHERE cache_key=? AND updated_at=?").bind(&entry.path).bind(&entry.fingerprint).execute(&state.database).await?.rows_affected()==1),
            "setting-cache"=>Ok(sqlx::query("DELETE FROM settings WHERE key=? AND updated_at=? AND key LIKE 'server-catalog:%'").bind(&entry.path).bind(&entry.fingerprint).execute(&state.database).await?.rows_affected()==1),
            _=>Ok(false)
        }}.await;
        match removal {
            Ok(true) => result.removed_files += 1,
            Ok(false) => result.skipped += 1,
            Err(e) => result.errors.push(format!("{}: {e}", entry.path)),
        }
    }
    let _ = std::fs::remove_file(path);
    Ok(result)
}
pub async fn optimize_database(state: &AppState) -> AppResult<CleanupResult> {
    let _lock = gate().write().await;
    if busy(state).await? {
        return Err(AppError::Conflict(
            "Stop games, servers and installations before database maintenance".into(),
        ));
    }
    let before = state.paths.database().metadata()?.len();
    sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .execute(&state.database)
        .await?;
    sqlx::query("VACUUM").execute(&state.database).await?;
    sqlx::query("PRAGMA optimize")
        .execute(&state.database)
        .await?;
    let after = state.paths.database().metadata()?.len();
    Ok(CleanupResult {
        removed_files: 0,
        removed_bytes: before.saturating_sub(after),
        skipped: 0,
        errors: vec![],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn manifest_ids_cannot_be_paths() {
        let root = tempfile::tempdir().unwrap();
        assert!(uuid::Uuid::parse_str("../../app.db").is_err());
        let p = root.path().join("a.part");
        std::fs::write(&p, b"a").unwrap();
        let a = fingerprint(&p).unwrap();
        std::fs::write(&p, b"changed").unwrap();
        assert_ne!(a, fingerprint(&p).unwrap());
    }
    #[test]
    fn all_platform_native_libraries_are_pinned() {
        let d = tempfile::tempdir().unwrap();
        let v = serde_json::json!({"libraries":[{"name":"org.lwjgl:lwjgl:3.3.3","downloads":{"classifiers":{"natives-windows":{"path":"win.jar","sha1":"a"},"natives-osx":{"path":"mac.jar","sha1":"b"}}}}]});
        let mut used = HashSet::new();
        collect_libraries(&v, d.path(), &mut used, &mut HashMap::new());
        assert!(used.contains(&d.path().join("win.jar")));
        assert!(used.contains(&d.path().join("mac.jar")));
    }
}
