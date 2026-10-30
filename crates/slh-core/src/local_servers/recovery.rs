//! Explicit recovery of externally replaced server JARs. Server files are never rewritten.
use super::{config::LaunchPlan, providers, store};
use crate::{error::{AppError, AppResult}, state::AppState};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{io::Read, path::{Path, PathBuf}};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreCandidate {
    pub path: String,
    pub filename: String,
    pub minecraft_version: String,
    pub core: String,
    pub required_java: u32,
    pub fingerprint: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchCheck {
    pub needs_repair: bool,
    pub missing: bool,
    pub old_target: String,
    pub old_version: String,
    pub revision: String,
    pub candidates: Vec<CoreCandidate>,
}
fn small_entry(zip: &mut zip::ZipArchive<std::fs::File>, name: &str) -> String {
    let Ok(mut entry) = zip.by_name(name) else { return String::new() };
    if entry.size() > 65536 { return String::new() }
    let mut text = String::new();
    let _ = entry.by_ref().take(65537).read_to_string(&mut text);
    text
}
pub fn candidate(path: &Path) -> AppResult<CoreCandidate> {
    store::plain_path(path)?;
    let invalid = || AppError::InvalidInput("serverCoreRepair.invalidJar".into());
    if !path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("jar")) { return Err(invalid()) }
    let meta = std::fs::metadata(path)?;
    let mut zip = zip::ZipArchive::new(std::fs::File::open(path)?).map_err(|_| invalid())?;
    let manifest = small_entry(&mut zip, "META-INF/MANIFEST.MF");
    let main = manifest.lines().find_map(|line| line.strip_prefix("Main-Class:")).unwrap_or("").trim().to_lowercase();
    if !["minecraft", "paperclip", "fabric", "quilt", "bukkit", "forge", "arclight"].iter().any(|name| main.contains(name)) { return Err(invalid()) }
    let version: serde_json::Value = serde_json::from_str(&small_entry(&mut zip, "version.json")).unwrap_or_default();
    let versions = small_entry(&mut zip, "META-INF/versions.list");
    let filename = path.file_name().ok_or_else(invalid)?.to_string_lossy().into_owned();
    let pattern = regex::Regex::new(r"(?:\b1\.\d+(?:\.\d+)?\b|\b2\d\.\d+(?:\.\d+)?\b)").unwrap();
    let minecraft_version = version["id"].as_str().filter(|v| !v.is_empty() && v.len() <= 128).map(str::to_owned)
        .or_else(|| versions.lines().find_map(|line| line.split_whitespace().nth(1)).map(str::to_owned))
        .or_else(|| pattern.find(&filename).map(|v| v.as_str().to_owned()))
        .or_else(|| manifest.lines().find_map(|line| line.strip_prefix("Implementation-Version:")).and_then(|v| pattern.find(v)).map(|v| v.as_str().to_owned()))
        .ok_or_else(invalid)?;
    let identity = format!("{filename} {versions} {manifest}").to_lowercase();
    let core = ["leaf", "purpur", "paper", "neoforge", "forge", "fabric", "quilt", "spigot", "bukkit"].iter()
        .find(|name| identity.contains(**name)).copied().unwrap_or(if main.contains("minecraft") { "vanilla" } else { "custom" }).to_owned();
    let required_java = version["java_version"].as_u64().filter(|v| (8..=99).contains(v)).map(|v| v as u32).unwrap_or_else(|| providers::required_java(&minecraft_version));
    let modified = meta.modified()?.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
    Ok(CoreCandidate { path: path.to_string_lossy().into_owned(), filename, minecraft_version, core, required_java, fingerprint: format!("{}:{modified}", meta.len()) })
}
fn revision(config: &str, plan: &str) -> String {
    let mut digest = Sha256::new(); digest.update(config); digest.update([0]); digest.update(plan); hex::encode(digest.finalize())
}
fn target(plan: &LaunchPlan) -> Option<PathBuf> {
    let at = plan.args.iter().position(|arg| arg == "-jar")?;
    Some(PathBuf::from(plan.args.get(at + 1)?))
}
pub async fn inspect(state: &AppState, id: &str) -> AppResult<LaunchCheck> {
    let server = store::get(state, id).await?;
    let (config, raw_plan): (String, Option<String>) = sqlx::query_as("SELECT config_json,plan_json FROM local_servers WHERE id=?").bind(id).fetch_one(&state.database).await?;
    let mut result = LaunchCheck { needs_repair: false, missing: false, old_target: String::new(), old_version: server.config.minecraft_version.clone(), revision: revision(&config, raw_plan.as_deref().unwrap_or("")), candidates: vec![] };
    let Some(raw_plan) = raw_plan else { return Ok(result) };
    let plan: LaunchPlan = serde_json::from_str(&raw_plan)?;
    let Some(old) = target(&plan) else { return Ok(result) };
    let old = Path::new(&server.path).join(old);
    store::plain_path(&old)?;
    result.old_target = old.file_name().unwrap_or_default().to_string_lossy().into_owned();
    result.missing = !old.is_file();
    if !result.missing {
        if let Ok(current) = candidate(&old) {
            if current.minecraft_version != server.config.minecraft_version {
                result.needs_repair = true;
                result.candidates.push(current);
            }
        }
        return Ok(result);
    }
    result.needs_repair = true;
    // Only inspect this server's root. Plugin, backup and library JARs are excluded.
    for entry in std::fs::read_dir(&server.path)?.take(512).flatten() {
        if entry.file_type().is_ok_and(|t| t.is_file() && !t.is_symlink()) {
            if let Ok(value) = candidate(&entry.path()) {
                if server.config.core == "custom" || value.core == "custom" || value.core == server.config.core { result.candidates.push(value); }
            }
        }
    }
    result.candidates.sort_by(|a, b| a.filename.cmp(&b.filename));
    Ok(result)
}
pub async fn repair(state: &AppState, id: &str, path: String, expected_revision: String, expected_fingerprint: String) -> AppResult<store::LocalServer> {
    let server = store::idle(state, id).await?;
    let check = inspect(state, id).await?;
    if !check.needs_repair || check.revision != expected_revision { return Err(AppError::Conflict("serverCoreRepair.changed".into())) }
    let selected = inspect_candidate(state, id, path).await?;
    if selected.fingerprint != expected_fingerprint { return Err(AppError::Conflict("serverCoreRepair.changed".into())) }
    let (raw_config, raw_plan): (String, String) = sqlx::query_as("SELECT config_json,plan_json FROM local_servers WHERE id=?").bind(id).fetch_one(&state.database).await?;
    if revision(&raw_config, &raw_plan) != expected_revision { return Err(AppError::Conflict("serverCoreRepair.changed".into())) }
    let mut config = server.config;
    config.minecraft_version = selected.minecraft_version;
    config.custom_jar = Some(selected.path);
    if selected.core != "custom" { config.core = selected.core; }
    config.core_version = "imported".into();
    super::config::validate(&config)?;
    store::validate_server_path(&config.core, Path::new(&server.path))?;
    let mut plan: LaunchPlan = serde_json::from_str(&raw_plan)?;
    let at = plan.args.iter().position(|arg| arg == "-jar").ok_or_else(|| AppError::InvalidInput("serverCoreRepair.invalidJar".into()))?;
    plan.args[at + 1] = selected.filename;
    plan.required_java = selected.required_java;
    let backup = state.paths.backups.join("local-servers").join(id).join(format!("launch-{}.json", uuid::Uuid::new_v4()));
    store::atomic_write(&backup, &serde_json::to_vec(&serde_json::json!({"config":serde_json::from_str::<serde_json::Value>(&raw_config)?,"plan":serde_json::from_str::<serde_json::Value>(&raw_plan)?}))?)?;
    let mut tx = state.database.begin().await?;
    let changed = sqlx::query("UPDATE local_servers SET config_json=?,plan_json=? WHERE id=? AND config_json=? AND plan_json=?")
        .bind(serde_json::to_string(&config)?).bind(serde_json::to_string(&plan)?).bind(id).bind(&raw_config).bind(&raw_plan).execute(&mut *tx).await?.rows_affected();
    if changed != 1 { return Err(AppError::Conflict("serverCoreRepair.changed".into())) }
    sqlx::query("UPDATE server_library_entries SET readiness='ready',note=NULL WHERE server_id=?").bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    store::get(state, id).await
}
pub async fn inspect_candidate(state: &AppState, id: &str, path: String) -> AppResult<CoreCandidate> {
    let server = store::get(state, id).await?;
    let path = PathBuf::from(path);
    store::plain_path(&path)?;
    let parent = path.parent().ok_or_else(|| AppError::Security("serverCoreRepair.insideFolder".into()))?;
    if std::fs::canonicalize(parent)? != std::fs::canonicalize(&server.path)? { return Err(AppError::Security("serverCoreRepair.insideFolder".into())) }
    candidate(&path)
}
