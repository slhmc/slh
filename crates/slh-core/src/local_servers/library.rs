//! Persistent library organization is independent of physical server directories.
use super::{
    config::{LaunchPlan, ServerConfig},
    discovery, store,
};
use crate::{
    database,
    error::{AppError, AppResult},
    state::AppState,
};
use serde::Serialize;
use serde_json::{Value, json};
use std::{collections::HashMap, path::Path};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub source_path: Option<String>,
    pub sort_order: i64,
    pub collapsed: bool,
}
pub async fn collections(state: &AppState) -> AppResult<Vec<Collection>> {
    let rows:Vec<(String,String,Option<String>,Option<String>,i64,bool)>=sqlx::query_as("SELECT id,name,parent_id,source_path,sort_order,collapsed FROM server_collections WHERE deleted=0 ORDER BY sort_order,name").fetch_all(&state.database).await?;
    Ok(rows
        .into_iter()
        .map(
            |(id, name, parent_id, source_path, sort_order, collapsed)| Collection {
                id,
                name,
                parent_id,
                source_path,
                sort_order,
                collapsed,
            },
        )
        .collect())
}
pub async fn presentation(state: &AppState, id: &str) -> AppResult<Value> {
    let row:Option<(Option<String>,i64,String,String,Option<String>,String,bool)>=sqlx::query_as("SELECT collection_id,sort_order,origin,readiness,note,icon_json,manual_group FROM server_library_entries WHERE server_id=?").bind(id).fetch_optional(&state.database).await?;
    Ok(
        if let Some((group, order, origin, readiness, note, icon, manual)) = row {
            json!({"collectionId":group,"manualGroup":manual,"sortOrder":order,"origin":origin,"readiness":readiness,"note":note,"icon":serde_json::from_str::<Value>(&icon)?})
        } else {
            json!({"collectionId":null,"sortOrder":0,"origin":"created","readiness":"ready","note":null,"icon":{}})
        },
    )
}
fn key(path: &Path) -> String {
    let value = std::fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .replace(char::from(92), "/");
    let value = value.trim_start_matches("//?/").to_owned();
    if cfg!(windows) {
        value.to_lowercase()
    } else {
        value
    }
}

async fn source_group(state: &AppState, path: &Path, root: &Path) -> AppResult<Option<String>> {
    if path == root {
        return Ok(None);
    }
    let relative = path
        .strip_prefix(root)
        .map_err(|_| AppError::Security("Folder is outside the server root".into()))?;
    let mut parent = None;
    let mut current = root.to_path_buf();
    for part in relative.components() {
        current.push(part);
        let source = key(&current);
        let mut existing: Option<(String, bool, Option<String>)> = sqlx::query_as(
            "SELECT id,deleted,parent_id FROM server_collections WHERE source_path=?",
        )
        .bind(&source)
        .fetch_optional(&state.database)
        .await?;
        if existing.is_none() {
            let legacy:Vec<(String,bool,Option<String>,String)>=sqlx::query_as("SELECT id,deleted,parent_id,source_path FROM server_collections WHERE source_path IS NOT NULL").fetch_all(&state.database).await?;
            if let Some((id, deleted, parent, _)) = legacy
                .into_iter()
                .find(|(_, _, _, path)| key(Path::new(path)) == source)
            {
                sqlx::query("UPDATE server_collections SET source_path=? WHERE id=?")
                    .bind(&source)
                    .bind(&id)
                    .execute(&state.database)
                    .await?;
                existing = Some((id, deleted, parent));
            }
        }
        if let Some((id, deleted, fallback)) = existing {
            parent = if deleted { fallback } else { Some(id) };
        } else {
            let id = uuid::Uuid::new_v4().to_string();
            sqlx::query("INSERT INTO server_collections(id,name,parent_id,source_path,sort_order) VALUES (?,?,?,?,(SELECT COUNT(*) FROM server_collections))").bind(&id).bind(part.as_os_str().to_string_lossy().as_ref()).bind(&parent).bind(source).execute(&state.database).await?;
            parent = Some(id);
        }
    }
    Ok(parent)
}
pub async fn synchronize(
    state: &AppState,
    directory: Option<String>,
) -> AppResult<store::ServerOverview> {
    static SYNC: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    let _sync = SYNC
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;
    let _gate = crate::storage_cleanup::gate().read().await;
    let mut defaults = store::defaults(state).await?;
    let root = directory
        .as_ref()
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| store::root(state, &defaults));
    store::plain_path(&root)?;
    if !root.is_dir() {
        return Err(AppError::NotFound("Server directory is unavailable".into()));
    }
    std::fs::read_dir(&root)?;
    if let Some(directory) = directory {
        defaults.directory = Some(directory);
        store::save_defaults(state, serde_json::to_value(defaults)?).await?;
    }
    let known = store::list(state).await?;
    let mut by_path: HashMap<String, String> = known
        .iter()
        .map(|s| (key(Path::new(&s.path)), s.id.clone()))
        .collect();
    let mut issues = vec![];
    let mut count = 0;
    for e in walkdir::WalkDir::new(&root)
        .max_depth(8)
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
        let e = match e {
            Ok(e) => e,
            Err(error) => {
                issues.push(error.to_string());
                continue;
            }
        };
        if !e.file_type().is_dir() {
            continue;
        }
        let path = e.path();
        let found = match discovery::inspect(path) {
            Ok(Some(s)) => s,
            Ok(None) => continue,
            Err(error) => {
                issues.push(format!("{}: {error}", path.display()));
                continue;
            }
        };
        count += 1;
        if count > 2000 {
            issues.push("Server scan limit reached".into());
            break;
        }
        let group = source_group(state, path.parent().unwrap_or(&root), &root).await?;
        if let Some(id) = by_path.get(&key(path)) {
            sqlx::query("INSERT OR IGNORE INTO server_library_entries(server_id,collection_id) VALUES (?,?)").bind(id).bind(&group).execute(&state.database).await?;
            // A manual assignment, including Ungrouped, is never changed by a refresh.
            sqlx::query("UPDATE server_library_entries SET collection_id=? WHERE server_id=? AND manual_group=0").bind(&group).bind(id).execute(&state.database).await?;
            sqlx::query("UPDATE server_library_entries SET readiness=CASE WHEN (SELECT plan_json FROM local_servers WHERE id=?) IS NULL AND origin='imported' THEN 'needs_setup' ELSE 'ready' END WHERE server_id=? AND readiness='missing'").bind(id).bind(id).execute(&state.database).await?;
            continue;
        }
        let valid = found.ready
            && found.note.is_none()
            && super::config::validate(&found.config).is_ok()
            && store::validate_server_path(&found.config.core, path).is_ok();
        let plan = if valid {
            Some(serde_json::to_string(&LaunchPlan {
                java: found.config.java_path.clone().unwrap_or_default(),
                args: found.entry,
                directory: found.path.clone(),
                required_java: super::providers::required_java(&found.config.minecraft_version),
            })?)
        } else {
            None
        };
        let id = uuid::Uuid::new_v4().to_string();
        let mut tx = state.database.begin().await?;
        sqlx::query("INSERT INTO local_servers(id,name,path,config_json,plan_json,data_relative,status) VALUES (?,?,?,?,?,?,'stopped')").bind(&id).bind(found.name).bind(&found.path).bind(serde_json::to_string(&found.config)?).bind(plan).bind(path.strip_prefix(&state.paths.data).ok().map(|p|p.to_string_lossy().into_owned())).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO server_library_entries(server_id,collection_id,origin,readiness,note,sort_order) VALUES (?,?,'imported',?,?,(SELECT COUNT(*) FROM server_library_entries))").bind(&id).bind(&group).bind(if valid{"ready"}else{"needs_setup"}).bind(if valid{None}else{Some(found.note.unwrap_or_else(||"Review the server JAR, Minecraft version and launch arguments".into()))}).execute(&mut *tx).await?;
        tx.commit().await?;
        by_path.insert(key(path), id);
    }
    for s in store::list(state).await? {
        if !Path::new(&s.path).is_dir() {
            sqlx::query("UPDATE server_library_entries SET readiness='missing' WHERE server_id=?")
                .bind(s.id)
                .execute(&state.database)
                .await?;
        }
    }
    let mut result = store::overview(state).await?;
    result.issues = issues;
    Ok(result)
}
pub async fn edit_group(
    state: &AppState,
    action: &str,
    id: Option<String>,
    name: Option<String>,
    parent: Option<String>,
) -> AppResult<()> {
    if let Some(p) = &parent {
        if !collections(state).await?.iter().any(|g| &g.id == p) {
            return Err(AppError::NotFound("Server group".into()));
        }
    }
    match action {
        "create" => {
            let name = name.ok_or_else(|| AppError::InvalidInput("Group name required".into()))?;
            super::config::validate_component(&name)?;
            sqlx::query("INSERT INTO server_collections(id,name,parent_id,sort_order) VALUES (?,?,?,(SELECT COUNT(*) FROM server_collections))").bind(uuid::Uuid::new_v4().to_string()).bind(name).bind(parent).execute(&state.database).await?;
        }
        "rename" => {
            let name = name.ok_or_else(|| AppError::InvalidInput("Group name required".into()))?;
            super::config::validate_component(&name)?;
            sqlx::query("UPDATE server_collections SET name=? WHERE id=? AND deleted=0")
                .bind(name)
                .bind(id)
                .execute(&state.database)
                .await?;
        }
        "collapse" => {
            sqlx::query(
                "UPDATE server_collections SET collapsed=NOT collapsed WHERE id=? AND deleted=0",
            )
            .bind(id)
            .execute(&state.database)
            .await?;
        }
        "delete" => {
            let id = id.ok_or_else(|| AppError::InvalidInput("Group required".into()))?;
            let row: Option<(Option<String>,)> =
                sqlx::query_as("SELECT parent_id FROM server_collections WHERE id=? AND deleted=0")
                    .bind(&id)
                    .fetch_optional(&state.database)
                    .await?;
            let parent = row
                .ok_or_else(|| AppError::NotFound("Server group".into()))?
                .0;
            let mut tx = state.database.begin().await?;
            sqlx::query("UPDATE server_library_entries SET collection_id=?,manual_group=1 WHERE collection_id=?").bind(&parent).bind(&id).execute(&mut *tx).await?;
            sqlx::query("UPDATE server_collections SET parent_id=? WHERE parent_id=?")
                .bind(&parent)
                .bind(&id)
                .execute(&mut *tx)
                .await?;
            sqlx::query("UPDATE server_collections SET deleted=1 WHERE id=?")
                .bind(id)
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
        }
        _ => {
            return Err(AppError::InvalidInput(
                "Unknown library group action".into(),
            ));
        }
    }
    Ok(())
}
pub async fn organize(
    state: &AppState,
    id: &str,
    collection: Option<String>,
    before: Option<String>,
) -> AppResult<()> {
    store::get(state, id).await?;
    if let Some(group) = &collection {
        if !collections(state).await?.iter().any(|g| &g.id == group) {
            return Err(AppError::NotFound("Server group".into()));
        }
    }
    let mut tx = state.database.begin().await?;
    sqlx::query("INSERT OR IGNORE INTO server_library_entries(server_id) VALUES (?)")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "UPDATE server_library_entries SET collection_id=?,manual_group=1 WHERE server_id=?",
    )
    .bind(&collection)
    .bind(id)
    .execute(&mut *tx)
    .await?;
    let mut ids:Vec<String>=sqlx::query_scalar("SELECT server_id FROM server_library_entries WHERE collection_id IS ? AND server_id<>? ORDER BY sort_order,server_id").bind(&collection).bind(id).fetch_all(&mut *tx).await?;
    let index = before
        .and_then(|target| ids.iter().position(|s| s == &target))
        .unwrap_or(ids.len());
    ids.insert(index, id.into());
    for (order, id) in ids.iter().enumerate() {
        sqlx::query("UPDATE server_library_entries SET sort_order=? WHERE server_id=?")
            .bind(order as i64)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}
pub async fn reorder_groups(state: &AppState, ids: Vec<String>) -> AppResult<()> {
    let mut tx = state.database.begin().await?;
    for (index, id) in ids.into_iter().enumerate() {
        sqlx::query("UPDATE server_collections SET sort_order=? WHERE id=? AND deleted=0")
            .bind(index as i64)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}
pub async fn save_view(state: &AppState, value: Value) -> AppResult<()> {
    if serde_json::to_string(&value)?.len() > 65536 {
        return Err(AppError::InvalidInput(
            "Library settings are too large".into(),
        ));
    }
    database::set_setting(&state.database, "serverLibrary", &value).await
}
pub async fn save_icon(
    state: &AppState,
    id: &str,
    icon: Value,
    name: Option<String>,
) -> AppResult<()> {
    store::get(state, id).await?;
    if let Some(name) = &name {
        super::config::validate_component(name)?;
    }
    for field in ["background", "foreground"] {
        if let Some(value) = icon[field].as_str() {
            if value.len() != 7
                || !value.starts_with('#')
                || !value[1..].bytes().all(|b| b.is_ascii_hexdigit())
            {
                return Err(AppError::InvalidInput("Invalid icon color".into()));
            }
        }
    }
    if icon["key"].as_str().is_some_and(|s| {
        ![
            "cube", "package", "blocks", "sword", "tree", "star", "gamepad", "globe", "coffee",
            "image", "server", "tools",
        ]
        .contains(&s)
    }) {
        return Err(AppError::InvalidInput("Invalid icon".into()));
    }
    let mut tx = state.database.begin().await?;
    sqlx::query("INSERT OR IGNORE INTO server_library_entries(server_id) VALUES (?)")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE server_library_entries SET icon_json=? WHERE server_id=?")
        .bind(serde_json::to_string(&icon)?)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    if let Some(name) = name {
        sqlx::query("UPDATE local_servers SET name=? WHERE id=?")
            .bind(name)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}
pub async fn resolve_setup(
    state: &AppState,
    id: &str,
    config: &ServerConfig,
) -> AppResult<Option<LaunchPlan>> {
    let metadata = presentation(state, id).await?;
    if metadata["origin"] != "imported" || metadata["readiness"] != "needs_setup" {
        return Ok(None);
    }
    let s = store::get(state, id).await?;
    let mut entry = discovery::inspect(Path::new(&s.path))?
        .map(|s| s.entry)
        .unwrap_or_default();
    if let Some(jar) = &config.custom_jar {
        let jar = Path::new(jar);
        store::plain_path(jar)?;
        if jar.parent() != Some(Path::new(&s.path)) || !jar.is_file() {
            return Err(AppError::InvalidInput(
                "Choose a server JAR inside this server folder".into(),
            ));
        }
        entry = vec![
            "-jar".into(),
            jar.file_name().unwrap().to_string_lossy().into_owned(),
        ];
    }
    if config.minecraft_version.is_empty() || entry.is_empty() {
        return Err(AppError::InvalidInput(
            "Select the server JAR and Minecraft version".into(),
        ));
    }
    let plan = LaunchPlan {
        java: config.java_path.clone().unwrap_or_default(),
        args: entry,
        directory: s.path,
        required_java: super::providers::required_java(&config.minecraft_version),
    };
    Ok(Some(plan))
}
