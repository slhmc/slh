use super::config::*;
use crate::{
    database,
    error::{AppError, AppResult},
    state::AppState,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalServer {
    pub id: String,
    pub name: String,
    pub path: String,
    pub group_id: Option<String>,
    pub config: ServerConfig,
    pub status: String,
    pub created_at: String,
    pub installed: bool,
    pub presentation: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub properties_revision: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerGroup {
    pub id: String,
    pub name: String,
    pub path: String,
    pub parent_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateServer {
    pub name: String,
    pub folder: String,
    pub group_id: Option<String>,
    pub config: ServerConfig,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerOverview {
    pub servers: Vec<LocalServer>,
    pub groups: Vec<ServerGroup>,
    pub defaults: ServerDefaults,
    pub directory: String,
    pub default_directory: String,
    pub collections: Vec<super::library::Collection>,
    pub view: Value,
    pub issues: Vec<String>,
}

pub async fn section_folder(state: &AppState, id: Option<&str>, section: Option<&str>) -> AppResult<PathBuf> {
    let base = if let Some(id) = id {
        PathBuf::from(get(state, id).await?.path)
    } else {
        root(state, &defaults(state).await?)
    };
    let path = match section {
        None | Some("overview" | "settings") => base,
        Some("plugins") if id.is_some() => base.join("plugins"),
        Some("console") if id.is_some() => base.join("logs"),
        _ => return Err(AppError::InvalidInput("Unknown server folder section".into())),
    };
    plain_path(&path)?;
    Ok(path)
}

pub fn plain_path(path: &Path) -> AppResult<()> {
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(AppError::Security(
            "Expected an absolute path without parent traversal".into(),
        ));
    }
    let mut at = PathBuf::new();
    for component in path.components() {
        at.push(component);
        if matches!(component, std::path::Component::Prefix(_)) {
            continue;
        }
        match std::fs::symlink_metadata(&at) {
            Ok(meta) => {
                #[cfg(windows)]
                let link = {
                    use std::os::windows::fs::MetadataExt;
                    meta.file_attributes() & 0x400 != 0
                };
                #[cfg(not(windows))]
                let link = meta.file_type().is_symlink();
                if link {
                    // macOS exposes its standard temporary directories through
                    // /var and /tmp aliases. Accept only the known OS mapping,
                    // after checking the real target; user-created links below
                    // that directory must still be rejected.
                    #[cfg(target_os = "macos")]
                    {
                        let target = match at.as_path() {
                            path if path == Path::new("/var") => Some(Path::new("/private/var")),
                            path if path == Path::new("/tmp") => Some(Path::new("/private/tmp")),
                            _ => None,
                        };
                        if let Some(target) = target {
                            let link_target = std::fs::read_link(&at)?;
                            let resolved_target = if link_target.is_absolute() {
                                link_target
                            } else {
                                Path::new("/").join(link_target)
                            };
                            if resolved_target == target {
                                plain_path(target)?;
                                continue;
                            }
                        }
                    }
                    return Err(AppError::Security(
                        "Server and cleanup paths cannot contain symbolic links or junctions"
                            .into(),
                    ));
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}
pub fn validate_server_path(core: &str, path: &Path) -> AppResult<()> {
    plain_path(path)?;
    if path.components().any(|part| matches!(part, std::path::Component::Normal(name) if name.to_string_lossy().ends_with('!'))) {
        return Err(AppError::InvalidInput("Java cannot read JAR resources when a parent directory ends with '!'; rename that directory".into()));
    }
    if ["paper", "purpur", "leaf", "spigot", "bukkit"].contains(&core) && path.to_string_lossy().contains(['!', '+']) {
        return Err(AppError::InvalidInput("Bukkit-based server paths cannot contain '!' or '+'; choose another folder name or server directory".into()));
    }
    Ok(())
}
pub fn atomic_write(path: &Path, bytes: &[u8]) -> AppResult<()> {
    plain_path(path)?;
    let parent = path
        .parent()
        .ok_or_else(|| AppError::InvalidInput("Missing parent folder".into()))?;
    std::fs::create_dir_all(parent)?;
    let tmp = parent.join(format!(".slh-{}.tmp", Uuid::new_v4()));
    let result = (|| {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(tmp);
    }
    result
}
pub async fn defaults(state: &AppState) -> AppResult<ServerDefaults> {
    let value = database::setting(&state.database, "servers").await?;
    let result: ServerDefaults = serde_json::from_value(value)?;
    validate(&result.config)?;
    if let Some(dir) = &result.directory {
        plain_path(Path::new(dir))?;
    }
    Ok(result)
}
pub fn root(state: &AppState, defaults: &ServerDefaults) -> PathBuf {
    defaults
        .directory
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or_else(|| state.paths.data.join("servers"))
}
fn relative(state: &AppState, path: &Path) -> Option<String> {
    path.strip_prefix(&state.paths.data)
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
}
fn resolve(state: &AppState, path: String, rel: Option<String>) -> String {
    rel.map(|p| state.paths.data.join(p).to_string_lossy().into_owned())
        .unwrap_or(path)
}

pub async fn list(state: &AppState) -> AppResult<Vec<LocalServer>> {
    let rows:Vec<(String,String,String,Option<String>,Option<String>,String,String,String,Option<String>)>=sqlx::query_as("SELECT id,name,path,group_id,data_relative,config_json,status,created_at,plan_json FROM local_servers ORDER BY created_at,name").fetch_all(&state.database).await?;
    let mut out = vec![];
    for (id, name, path, group_id, rel, json, mut status, created_at, plan) in rows {
        let path = resolve(state, path, rel);
        if matches!(
            status.as_str(),
            "starting" | "running" | "stopping" | "unmanaged"
        ) || super::runtime::java_is_alive(state, &id)
        {
            let reconciled = super::runtime::state_for(state, &id, &status).await;
            if reconciled != status {
                sqlx::query("UPDATE local_servers SET status=? WHERE id=? AND status=?")
                    .bind(&reconciled)
                    .bind(&id)
                    .bind(&status)
                    .execute(&state.database)
                    .await?;
            }
            status = reconciled;
        }
        let mut presentation=super::library::presentation(state,&id).await?;
        if !Path::new(&path).is_dir(){presentation["readiness"]=serde_json::json!("missing");}
        out.push(LocalServer {
            properties_revision: None,
            id,
            name,
            path,
            group_id,
            config: serde_json::from_str(&json)?,
            status,
            created_at,
            installed: plan.is_some(),
            presentation,
        });
    }
    Ok(out)
}
pub async fn get(state: &AppState, id: &str) -> AppResult<LocalServer> {
    list(state)
        .await?
        .into_iter()
        .find(|s| s.id == id)
        .ok_or_else(|| AppError::NotFound("Local server".into()))
}
pub async fn groups(state: &AppState) -> AppResult<Vec<ServerGroup>> {
    let rows: Vec<(String, String, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT id,name,path,parent_id,data_relative FROM local_server_groups ORDER BY path",
    )
    .fetch_all(&state.database)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, name, path, parent_id, rel)| ServerGroup {
            id,
            name,
            path: resolve(state, path, rel),
            parent_id,
        })
        .collect())
}
pub async fn overview(state: &AppState) -> AppResult<ServerOverview> {
    let defaults = defaults(state).await?;
    let directory = root(state, &defaults).to_string_lossy().into_owned();
    Ok(ServerOverview {
        collections:super::library::collections(state).await?,
        view:database::setting(&state.database,"serverLibrary").await?,
        issues:vec![],
        servers: list(state).await?,
        groups: groups(state).await?,
        defaults,
        default_directory: state
            .paths
            .data
            .join("servers")
            .to_string_lossy()
            .into_owned(),
        directory,
    })
}

pub async fn create(state: &AppState, request: CreateServer) -> AppResult<LocalServer> {
    validate_component(&request.name)?;
    validate_component(&request.folder)?;
    validate(&request.config)?;
    if !request.config.eula_accepted {
        return Err(AppError::InvalidInput(
            "Accept Minecraft EULA before creating this server".into(),
        ));
    }
    let directory = if let Some(group) = &request.group_id {
        PathBuf::from(
            groups(state)
                .await?
                .into_iter()
                .find(|g| &g.id == group)
                .ok_or_else(|| AppError::NotFound("Server folder".into()))?
                .path,
        )
    } else {
        root(state, &defaults(state).await?)
    };
    let path = directory.join(&request.folder);
    validate_server_path(&request.config.core, &path)?;
    if path.exists() {
        return Err(AppError::Conflict(
            "The server folder already exists".into(),
        ));
    }
    std::fs::create_dir_all(&directory)?;
    std::fs::create_dir(&path)?;
    let id = Uuid::new_v4().to_string();
    let result=sqlx::query("INSERT INTO local_servers(id,name,path,group_id,data_relative,config_json) VALUES (?,?,?,?,?,?)")
        .bind(&id).bind(&request.name).bind(path.to_string_lossy().as_ref()).bind(&request.group_id).bind(relative(state,&path)).bind(serde_json::to_string(&request.config)?).execute(&state.database).await;
    if let Err(e) = result {
        let _ = std::fs::remove_dir(&path);
        return Err(e.into());
    }
    atomic_write(
        &path.join("eula.txt"),
        b"# Accepted explicitly when creating this SLH server\neula=true\n",
    )?;
    write_properties(&path, &request.config)?;
    get(state, &id).await
}

pub fn write_properties(path: &Path, config: &ServerConfig) -> AppResult<()> {
    let file = path.join("server.properties");
    plain_path(&file)?;
    let existing = if config.properties_text.is_empty() {
        std::fs::read_to_string(&file).unwrap_or_default()
    } else {
        config.properties_text.clone()
    };
    atomic_write(&file, properties_text(&existing, config).as_bytes())
}
pub async fn idle(state: &AppState, id: &str) -> AppResult<LocalServer> {
    let s = get(state, id).await?;
    if !["created", "stopped", "failed"].contains(&s.status.as_str()) {
        return Err(AppError::Conflict(
            "Stop the server before changing its files".into(),
        ));
    }
    if super::runtime::java_is_alive(state, id) {
        return Err(AppError::Conflict(
            "The server process is still running".into(),
        ));
    }
    plain_path(Path::new(&s.path))?;
    Ok(s)
}
pub async fn update(
    state: &AppState,
    id: &str,
    name: &str,
    config: ServerConfig,
) -> AppResult<LocalServer> {
    let current = idle(state, id).await?;
    validate_component(name)?;
    validate(&config)?;
    if current.installed
        && (current.config.core != config.core
            || current.config.minecraft_version != config.minecraft_version
            || current.config.core_version != config.core_version)
    {
        return Err(AppError::InvalidInput(
            "Installed core versions are pinned; create another profile to use a different core"
                .into(),
        ));
    }
    if !config.eula_accepted {
        return Err(AppError::InvalidInput(
            "Minecraft EULA must remain accepted to run this profile".into(),
        ));
    }
    let path = Path::new(&current.path);
    let old = path.join("server.properties");
    if old.is_file() {
        let backup = state
            .paths
            .backups
            .join("local-servers")
            .join(id)
            .join(format!("properties-{}.txt", Uuid::new_v4()));
        std::fs::create_dir_all(backup.parent().unwrap())?;
        std::fs::copy(&old, backup)?;
    }
    let resolved=super::library::resolve_setup(state,id,&config).await?;
    write_properties(path, &config)?;
    sqlx::query("UPDATE local_servers SET name=?,config_json=?,plan_json=COALESCE(?,plan_json) WHERE id=?")
        .bind(name).bind(serde_json::to_string(&config)?).bind(resolved.as_ref().map(serde_json::to_string).transpose()?).bind(id).execute(&state.database).await?;
    if resolved.is_some(){sqlx::query("UPDATE server_library_entries SET readiness='ready',note=NULL WHERE server_id=?").bind(id).execute(&state.database).await?;}
    get(state, id).await
}
pub async fn read_config(state: &AppState, id: &str) -> AppResult<LocalServer> {
    let mut s = get(state, id).await?;
    let p = Path::new(&s.path).join("server.properties");
    s.properties_revision = Some(properties_revision(&p)?);
    plain_path(&p)?;
    if let Ok(meta) = p.metadata() {
        if meta.len() > 1024 * 1024 {
            return Err(AppError::InvalidInput(
                "Server properties exceed 1 MiB".into(),
            ));
        }
        let text = std::fs::read_to_string(p)?;
        import_properties(&mut s.config, &text);
        s.config.properties_text = text;
    }
    Ok(s)
}

pub async fn create_group(
    state: &AppState,
    name: &str,
    parent_id: Option<String>,
) -> AppResult<ServerGroup> {
    validate_component(name)?;
    let parent = if let Some(id) = &parent_id {
        PathBuf::from(
            groups(state)
                .await?
                .into_iter()
                .find(|g| &g.id == id)
                .ok_or_else(|| AppError::NotFound("Server folder".into()))?
                .path,
        )
    } else {
        root(state, &defaults(state).await?)
    };
    let path = parent.join(name);
    validate_server_path("vanilla", &path)?;
    if path.exists() {
        return Err(AppError::Conflict("The folder already exists".into()));
    }
    std::fs::create_dir_all(&parent)?;
    std::fs::create_dir(&path)?;
    let id = Uuid::new_v4().to_string();
    if let Err(e) = sqlx::query(
        "INSERT INTO local_server_groups(id,name,path,parent_id,data_relative) VALUES (?,?,?,?,?)",
    )
    .bind(&id)
    .bind(name)
    .bind(path.to_string_lossy().as_ref())
    .bind(&parent_id)
    .bind(relative(state, &path))
    .execute(&state.database)
    .await
    {
        let _ = std::fs::remove_dir(&path);
        return Err(e.into());
    }
    Ok(ServerGroup {
        id,
        name: name.into(),
        path: path.to_string_lossy().into_owned(),
        parent_id,
    })
}
/// A cross-volume move copies and verifies before the original is removed.
fn move_directory(source: &Path, target: &Path) -> AppResult<bool> {
    plain_path(source)?;
    plain_path(target)?;
    match std::fs::rename(source, target) {
        Ok(()) => return Ok(false),
        Err(e) if e.kind() == std::io::ErrorKind::CrossesDevices => {}
        Err(e) => return Err(e.into()),
    }
    std::fs::create_dir(target)?;
    for entry in walkdir::WalkDir::new(source)
        .follow_links(false)
        .min_depth(1)
    {
        let entry = entry.map_err(|e| AppError::Process(e.to_string()))?;
        plain_path(entry.path())?;
        let destination = target.join(entry.path().strip_prefix(source).unwrap());
        plain_path(&destination)?;
        if entry.file_type().is_dir() {
            std::fs::create_dir(&destination)?;
        } else if entry.file_type().is_file() {
            std::fs::copy(entry.path(), &destination)?;
            if super::providers::hash_file(entry.path(), None, None)?
                != super::providers::hash_file(&destination, None, None)?
            {
                return Err(AppError::Conflict(
                    "A file changed during the move; both copies were retained".into(),
                ));
            }
        } else {
            return Err(AppError::Security(
                "Only regular server files can be moved".into(),
            ));
        }
    }
    Ok(true)
}
fn finish_move(source: &Path, target: &Path, copied: bool, committed: bool) -> AppResult<()> {
    if copied {
        // Both absolute roots were validated and this copy belongs to this move.
        let remove = if committed { source } else { target };
        plain_path(remove)?;
        if remove.parent().is_none() || remove == source && source == target {
            return Err(AppError::Security("Invalid move root".into()));
        }
        std::fs::remove_dir_all(remove)?;
    } else if !committed {
        std::fs::rename(target, source)?;
    }
    Ok(())
}
pub async fn move_server(
    state: &AppState,
    id: &str,
    group_id: Option<String>,
    folder: &str,
) -> AppResult<LocalServer> {
    let s = idle(state, id).await?;
    validate_component(folder)?;
    let parent = if let Some(group) = &group_id {
        PathBuf::from(
            groups(state)
                .await?
                .into_iter()
                .find(|g| &g.id == group)
                .ok_or_else(|| AppError::NotFound("Server folder".into()))?
                .path,
        )
    } else {
        root(state, &defaults(state).await?)
    };
    let target = parent.join(folder);
    validate_server_path(&s.config.core, &target)?;
    if target == Path::new(&s.path) {
        return get(state, id).await;
    }
    if target.exists() {
        return Err(AppError::Conflict("The destination already exists".into()));
    }
    std::fs::create_dir_all(&parent)?;
    let copied = move_directory(Path::new(&s.path), &target)?;
    if let Err(e) =
        sqlx::query("UPDATE local_servers SET path=?,data_relative=?,group_id=? WHERE id=?")
            .bind(target.to_string_lossy().as_ref())
            .bind(relative(state, &target))
            .bind(group_id)
            .bind(id)
            .execute(&state.database)
            .await
    {
        let _ = finish_move(Path::new(&s.path), &target, copied, false);
        return Err(e.into());
    }
    finish_move(Path::new(&s.path), &target, copied, true)?;
    // Installed arguments are relative to the profile; only the working directory moves.
    if let Some(mut plan) = load_plan(state, id).await? {
        plan.directory = target.to_string_lossy().into_owned();
        save_plan(state, id, &plan).await?;
    }
    get(state, id).await
}
pub async fn rename_group(state: &AppState, id: &str, name: &str) -> AppResult<Vec<ServerGroup>> {
    relocate_group(state, id, name, None, None).await
}
pub async fn move_group(
    state: &AppState,
    id: &str,
    parent_id: Option<String>,
    name: &str,
) -> AppResult<Vec<ServerGroup>> {
    let parent = if let Some(parent) = &parent_id {
        PathBuf::from(
            groups(state)
                .await?
                .into_iter()
                .find(|g| &g.id == parent)
                .ok_or_else(|| AppError::NotFound("Server folder".into()))?
                .path,
        )
    } else {
        root(state, &defaults(state).await?)
    };
    relocate_group(state, id, name, Some(parent), Some(parent_id)).await
}
async fn relocate_group(
    state: &AppState,
    id: &str,
    name: &str,
    parent: Option<PathBuf>,
    parent_id: Option<Option<String>>,
) -> AppResult<Vec<ServerGroup>> {
    validate_component(name)?;
    let all = groups(state).await?;
    let group = all
        .iter()
        .find(|g| g.id == id)
        .ok_or_else(|| AppError::NotFound("Server folder".into()))?;
    let old = Path::new(&group.path);
    let parent = parent.unwrap_or_else(|| old.parent().unwrap().to_path_buf());
    if parent.starts_with(old) {
        return Err(AppError::InvalidInput(
            "A folder cannot be moved into itself".into(),
        ));
    }
    let new = parent.join(name);
    plain_path(old)?;
    validate_server_path("vanilla", &new)?;
    if old == new {
        return Ok(all);
    }
    if new.exists() {
        return Err(AppError::Conflict("The destination already exists".into()));
    }
    let servers = list(state).await?;
    for s in servers
        .iter()
        .filter(|s| Path::new(&s.path).starts_with(old))
    {
        idle(state, &s.id).await?;
        validate_server_path(
            &s.config.core,
            &new.join(Path::new(&s.path).strip_prefix(old).unwrap()),
        )?;
    }
    std::fs::create_dir_all(&parent)?;
    let copied = move_directory(old, &new)?;
    let mut tx = state.database.begin().await?;
    let result:AppResult<()>=async {
        if let Some(parent_id)=parent_id {sqlx::query("UPDATE local_server_groups SET parent_id=? WHERE id=?").bind(parent_id).bind(id).execute(&mut *tx).await?;}
        for g in all.iter().filter(|g|Path::new(&g.path).starts_with(old)) {let p=new.join(Path::new(&g.path).strip_prefix(old).unwrap());sqlx::query("UPDATE local_server_groups SET path=?,data_relative=?,name=CASE WHEN id=? THEN ? ELSE name END WHERE id=?").bind(p.to_string_lossy().as_ref()).bind(relative(state,&p)).bind(id).bind(name).bind(&g.id).execute(&mut *tx).await?;}
        for s in servers.iter().filter(|s|Path::new(&s.path).starts_with(old)){let p=new.join(Path::new(&s.path).strip_prefix(old).unwrap());sqlx::query("UPDATE local_servers SET path=?,data_relative=? WHERE id=?").bind(p.to_string_lossy().as_ref()).bind(relative(state,&p)).bind(&s.id).execute(&mut *tx).await?;}
        Ok(())
    }.await;
    if let Err(e) = result {
        let _ = tx.rollback().await;
        let _ = finish_move(old, &new, copied, false);
        return Err(e);
    }
    if let Err(e) = tx.commit().await {
        let _ = finish_move(old, &new, copied, false);
        return Err(e.into());
    }
    finish_move(old, &new, copied, true)?;
    Ok(groups(state).await?)
}
pub async fn load_plan(state: &AppState, id: &str) -> AppResult<Option<LaunchPlan>> {
    let json: Option<String> = sqlx::query_scalar("SELECT plan_json FROM local_servers WHERE id=?")
        .bind(id)
        .fetch_one(&state.database)
        .await?;
    Ok(json.map(|v| serde_json::from_str(&v)).transpose()?)
}
pub async fn save_plan(state: &AppState, id: &str, plan: &LaunchPlan) -> AppResult<()> {
    sqlx::query("UPDATE local_servers SET plan_json=? WHERE id=?")
        .bind(serde_json::to_string(plan)?)
        .bind(id)
        .execute(&state.database)
        .await?;
    Ok(())
}
pub async fn set_status(state: &AppState, id: &str, status: &str) -> AppResult<()> {
    sqlx::query("UPDATE local_servers SET status=? WHERE id=?")
        .bind(status)
        .bind(id)
        .execute(&state.database)
        .await?;
    Ok(())
}
pub async fn save_defaults(state: &AppState, value: Value) -> AppResult<Value> {
    let d: ServerDefaults = serde_json::from_value(value.clone())?;
    validate(&d.config)?;
    if let Some(p) = &d.directory {
        plain_path(Path::new(p))?;
    }
    database::set_setting(&state.database, "servers", &value).await?;
    Ok(value)
}

fn properties_revision(path: &Path) -> AppResult<String> {
    use sha2::{Digest, Sha256};
    plain_path(path)?;
    if path.metadata().is_ok_and(|meta| meta.len() > 1024 * 1024) { return Err(AppError::InvalidInput("Server properties exceed 1 MiB".into())); }
    match std::fs::read(path) {
        Ok(bytes) => Ok(hex::encode(Sha256::digest(bytes))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok("missing".into()),
        Err(error) => Err(error.into()),
    }
}
pub async fn update_checked(state: &AppState, id: &str, name: &str, config: ServerConfig, expected_revision: Option<&str>) -> AppResult<LocalServer> {
    let server = get(state, id).await?;
    if let Some(expected) = expected_revision {
        if properties_revision(&Path::new(&server.path).join("server.properties"))? != expected {
            return Err(AppError::Conflict("Server properties changed on disk. Reload the server settings before saving.".into()));
        }
    }
    update(state, id, name, config).await?;
    read_config(state, id).await
}
fn deletion_target(path: &Path, protected: &[PathBuf], others: &[PathBuf]) -> AppResult<PathBuf> {
    plain_path(path)?;
    let target = path.canonicalize()?;
    let normalized = |value: &Path| -> PathBuf {
        let value = value.canonicalize().unwrap_or_else(|_| value.to_path_buf());
        if cfg!(windows) { PathBuf::from(value.to_string_lossy().trim_start_matches(r"\\?\").to_lowercase()) } else { value }
    };
    let key = normalized(&target);
    if target.parent().is_none() || protected.iter().any(|p| normalized(p).starts_with(&key))
        || others.iter().any(|p| { let p = normalized(p); p.starts_with(&key) || key.starts_with(p) }) {
        return Err(AppError::Security("This folder contains launcher data or another server and cannot be deleted".into()));
    }
    // Reject links throughout the tree before removing anything.
    let mut pending = vec![target.clone()];
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(directory)? {
            let entry = entry?;
            plain_path(&entry.path())?;
            if entry.file_type()?.is_dir() { pending.push(entry.path()); }
        }
    }
    Ok(target)
}
pub async fn delete(state: &AppState, id: &str, expected_path: &str) -> AppResult<()> {
    let server = idle(state, id).await?;
    if server.path != expected_path { return Err(AppError::Conflict("The server folder changed; reopen the deletion dialog".into())); }
    let path = Path::new(&server.path);
    let server_root = root(state, &defaults(state).await?);
    let protected = vec![state.paths.data.clone(), state.paths.executable_dir.clone(), server_root];
    let mut others: Vec<PathBuf> = list(state).await?.into_iter().filter(|s| s.id != id).map(|s| PathBuf::from(s.path)).collect();
    others.extend([state.paths.accounts.clone(), state.paths.instances.clone(), state.paths.shared.clone(), state.paths.java.clone(), state.paths.backups.clone(), state.paths.languages.clone(), state.paths.executable_dir.join("resources")]);
    let target = if path.exists() { Some(deletion_target(path, &protected, &others)?) } else { None };
    let mut tx = state.database.begin().await?;
    sqlx::query("DELETE FROM server_content WHERE server_id=?").bind(id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM server_library_entries WHERE server_id=?").bind(id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM managed_artifacts WHERE owner_id=?").bind(id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM local_servers WHERE id=?").bind(id).execute(&mut *tx).await?;
    if let Some(target) = target { std::fs::remove_dir_all(target)?; }
    tx.commit().await?;
    Ok(())
}
