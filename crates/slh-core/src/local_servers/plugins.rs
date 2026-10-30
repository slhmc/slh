use super::{providers, store};
use crate::{
    error::{AppError, AppResult},
    minecraft::download::{DownloadPlan, configured_concurrency, download_many},
    state::AppState,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashSet, VecDeque},
    io::Read,
    path::{Path, PathBuf},
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginVersion {
    pub id: String,
    pub name: String,
    pub filename: String,
    pub url: Option<String>,
    pub sha1: String,
    pub dependencies: Vec<(String, Option<String>)>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginFile {
    pub filename: String,
    pub name: String,
    pub enabled: bool,
    pub size: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginPlan {
    pub items: Vec<PluginItem>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginItem {
    pub project_id: String,
    pub version: PluginVersion,
}

fn safe_id(id: &str) -> AppResult<&str> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
    {
        Err(AppError::InvalidInput(
            "Invalid plugin project or version".into(),
        ))
    } else {
        Ok(id)
    }
}
fn filename(name: &str) -> AppResult<&str> {
    if Path::new(name).file_name().and_then(|s| s.to_str()) != Some(name)
        || !name.ends_with(".jar")
        || name.contains(['\\', '/', ':', '\0'])
    {
        return Err(AppError::Security("Invalid plugin JAR filename".into()));
    }
    Ok(name)
}
pub async fn supported(state: &AppState, id: &str) -> AppResult<store::LocalServer> {
    let s = store::get(state, id).await?;
    if !["paper", "purpur", "leaf", "spigot", "bukkit"].contains(&s.config.core.as_str())
        && !Path::new(&s.path).join("bukkit.yml").is_file()
    {
        return Err(AppError::Unavailable(
            "This server does not support Bukkit plugins".into(),
        ));
    }
    Ok(s)
}
pub async fn search(
    state: &AppState,
    id: &str,
    provider: &str,
    query: &str,
    offset: u64,
) -> AppResult<crate::models::ModrinthSearchResult> {
    let s = supported(state, id).await?;
    if provider == "curseforge" {
        return crate::content::curseforge::search(
            state,
            query,
            Some("plugin"),
            Some(&s.config.minecraft_version),
            None,
            None,
            Some("relevance"),
            offset,
            20,
        )
        .await;
    }
    if provider != "modrinth" {
        return Err(AppError::InvalidInput("Unknown plugin provider".into()));
    }
    crate::content::modrinth::search(
        state,
        query,
        Some("plugin"),
        Some(&s.config.minecraft_version),
        Some(&loaders(&s).join(",")),
        None,
        Some("relevance"),
        offset,
        20,
    )
    .await
}
fn loaders(s: &store::LocalServer) -> Vec<&'static str> {
    if ["paper", "purpur", "leaf", "custom"].contains(&s.config.core.as_str()) {
        vec!["paper", "spigot", "bukkit"]
    } else {
        vec!["spigot", "bukkit"]
    }
}
pub async fn versions(
    state: &AppState,
    id: &str,
    provider: &str,
    project: &str,
) -> AppResult<Vec<PluginVersion>> {
    let s = supported(state, id).await?;
    safe_id(project)?;
    let mc = &s.config.minecraft_version;
    if provider == "curseforge" {
        if project.parse::<u64>().is_err() {
            return Err(AppError::InvalidInput(
                "Invalid CurseForge plugin ID".into(),
            ));
        }
        let info =
            crate::content::curseforge::server_api(state, &format!("mods/{project}"), &[]).await?;
        if info["data"]["classId"] != 5 {
            return Err(AppError::InvalidInput(
                "The CurseForge project is not a Bukkit plugin".into(),
            ));
        }
        let value = crate::content::curseforge::server_api(
            state,
            &format!("mods/{project}/files"),
            &[
                ("gameVersion".into(), mc.clone()),
                ("pageSize".into(), "50".into()),
            ],
        )
        .await?;
        return Ok(value["data"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|f| {
                f["isAvailable"] == true
                    && f["gameVersions"]
                        .as_array()
                        .is_some_and(|a| a.iter().any(|v| v == mc))
            })
            .filter_map(|f| {
                let name = f["fileName"].as_str()?;
                filename(name).ok()?;
                let sha =
                    f["hashes"].as_array()?.iter().find(|h| h["algo"] == 1)?["value"].as_str()?;
                Some(PluginVersion {
                    id: f["id"].as_u64()?.to_string(),
                    name: f["displayName"].as_str().unwrap_or(name).into(),
                    filename: name.into(),
                    url: f["downloadUrl"].as_str().map(str::to_owned),
                    sha1: sha.into(),
                    dependencies: f["dependencies"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(|d| d["relationType"] == 3)
                        .filter_map(|d| Some((d["modId"].as_u64()?.to_string(), None)))
                        .collect(),
                })
            })
            .collect());
    }
    if provider != "modrinth" {
        return Err(AppError::InvalidInput("Unknown plugin provider".into()));
    }
    let ls = loaders(&s);
    let url = url::Url::parse_with_params(
        &format!("https://api.modrinth.com/v2/project/{project}/version"),
        &[
            ("game_versions", serde_json::json!([mc]).to_string()),
            ("loaders", serde_json::to_string(&ls)?),
        ],
    )
    .unwrap();
    let mut value = providers::json(state, url.as_str()).await?;
    if let Some(items) = value.as_array_mut() {
        for version in items {
            if let Some(dependencies) = version["dependencies"].as_array_mut() {
                for dep in dependencies {
                    if dep["dependency_type"] == "required" && dep["project_id"].is_null() {
                        let id = dep["version_id"].as_str().ok_or_else(|| {
                            AppError::InvalidInput(
                                "Required plugin dependency has no project or version".into(),
                            )
                        })?;
                        safe_id(id)?;
                        let resolved = providers::json(
                            state,
                            &format!("https://api.modrinth.com/v2/version/{id}"),
                        )
                        .await?;
                        let project = resolved["project_id"].as_str().ok_or_else(|| {
                            AppError::InvalidInput(
                                "Required plugin dependency has no project".into(),
                            )
                        })?;
                        dep["project_id"] = serde_json::Value::String(project.into());
                    }
                }
            }
        }
    }
    Ok(value
        .as_array()
        .into_iter()
        .flatten()
        .filter(|v| {
            v["game_versions"]
                .as_array()
                .is_some_and(|a| a.iter().any(|x| x == mc))
                && v["loaders"].as_array().is_some_and(|a| {
                    a.iter()
                        .any(|x| x.as_str().is_some_and(|x| ls.contains(&x)))
                })
        })
        .filter_map(|v| {
            let files = v["files"].as_array()?;
            let f = files
                .iter()
                .find(|f| f["primary"] == true)
                .or_else(|| files.first())?;
            let name = f["filename"].as_str()?;
            filename(name).ok()?;
            Some(PluginVersion {
                id: v["id"].as_str()?.into(),
                name: v["name"].as_str().unwrap_or(name).into(),
                filename: name.into(),
                url: f["url"].as_str().map(str::to_owned),
                sha1: f["hashes"]["sha1"].as_str()?.into(),
                dependencies: v["dependencies"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|d| d["dependency_type"] == "required")
                    .filter_map(|d| {
                        Some((
                            d["project_id"].as_str()?.into(),
                            d["version_id"].as_str().map(str::to_owned),
                        ))
                    })
                    .collect(),
            })
        })
        .collect())
}
pub async fn plan(
    state: &AppState,
    id: &str,
    provider: &str,
    project: &str,
    version: &str,
) -> AppResult<PluginPlan> {
    let mut queue = VecDeque::from([(project.to_owned(), Some(version.to_owned()))]);
    let mut visited = HashSet::new();
    let mut items: Vec<PluginItem> = vec![];
    while let Some((project, wanted)) = queue.pop_front() {
        if !visited.insert(project.clone()) {
            if let Some(w) = wanted {
                if items
                    .iter()
                    .find(|i| i.project_id == project)
                    .is_some_and(|i| i.version.id != w)
                {
                    return Err(AppError::Conflict(
                        "Plugin dependencies require conflicting versions".into(),
                    ));
                }
            }
            continue;
        }
        if visited.len() > 64 {
            return Err(AppError::Security("Too many plugin dependencies".into()));
        }
        let versions = versions(state, id, provider, &project).await?;
        let selected = versions
            .into_iter()
            .find(|v| wanted.as_ref().is_none_or(|w| w == &v.id))
            .ok_or_else(|| {
                AppError::Unavailable(
                    "A required plugin has no compatible version for this Minecraft release".into(),
                )
            })?;
        if selected.url.is_none() {
            return Err(AppError::Unavailable(
                "The author disabled automatic downloads for this CurseForge plugin".into(),
            ));
        }
        for d in &selected.dependencies {
            queue.push_back(d.clone());
        }
        items.push(PluginItem {
            project_id: project,
            version: selected,
        });
    }
    let mut names = HashSet::new();
    if items
        .iter()
        .any(|i| !names.insert(i.version.filename.to_lowercase()))
    {
        return Err(AppError::Conflict(
            "Plugin dependencies have conflicting filenames".into(),
        ));
    }
    Ok(PluginPlan { items })
}
fn plugin_name(path: &Path) -> Option<String> {
    store::plain_path(path).ok()?;
    let mut zip = zip::ZipArchive::new(std::fs::File::open(path).ok()?).ok()?;
    for name in ["plugin.yml", "paper-plugin.yml"] {
        if let Ok(file) = zip.by_name(name) {
            if file.size() > 256 * 1024 {
                return None;
            }
            let mut yaml = String::new();
            file.take(256 * 1024).read_to_string(&mut yaml).ok()?;
            if let Some(value) = yaml.lines().find_map(|l| {
                l.strip_prefix("name:")
                    .map(|s| s.trim().trim_matches(['\'', '"']).to_owned())
            }) {
                if !value.is_empty() {
                    return Some(value);
                }
            }
        }
    }
    None
}
pub async fn files(state: &AppState, id: &str) -> AppResult<Vec<PluginFile>> {
    let s = supported(state, id).await?;
    let root = Path::new(&s.path).join("plugins");
    store::plain_path(&root)?;
    if !root.exists() {
        return Ok(vec![]);
    }
    let mut out = vec![];
    for e in std::fs::read_dir(root)? {
        let p = e?.path();
        if store::plain_path(&p).is_err() || !p.is_file() {
            continue;
        }
        let filename = p.file_name().unwrap().to_string_lossy().into_owned();
        let enabled = filename.ends_with(".jar");
        if !enabled && !filename.ends_with(".jar.disabled") {
            continue;
        }
        out.push(PluginFile {
            name: plugin_name(&p).unwrap_or_else(|| filename.clone()),
            filename,
            enabled,
            size: p.metadata()?.len(),
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}
pub async fn manage(state: &AppState, id: &str, name: &str, action: &str) -> AppResult<()> {
    let s = store::idle(state, id).await?;
    if Path::new(name).file_name().and_then(|s| s.to_str()) != Some(name)
        || name.contains(['\\', '/', ':'])
    {
        return Err(AppError::Security("Invalid plugin path".into()));
    }
    let path = Path::new(&s.path).join("plugins").join(name);
    store::plain_path(&path)?;
    if !path.is_file() || !(name.ends_with(".jar") || name.ends_with(".jar.disabled")) {
        return Err(AppError::InvalidInput(
            "Choose an installed plugin JAR".into(),
        ));
    }
    if !["toggle", "remove"].contains(&action) {
        return Err(AppError::InvalidInput("Invalid plugin action".into()));
    }
    if sqlx::query("UPDATE local_servers SET status='installing' WHERE id=? AND status IN ('created','stopped','failed')").bind(id).execute(&state.database).await?.rows_affected()!=1{return Err(AppError::Conflict("Another server operation is running".into()));}
    let result: AppResult<()> = async {
        if action == "toggle" {
            let new = path.with_file_name(if name.ends_with(".disabled") {
                name.trim_end_matches(".disabled").to_owned()
            } else {
                format!("{name}.disabled")
            });
            store::plain_path(&new)?;
            if new.exists() {
                return Err(AppError::Conflict(
                    "The target plugin filename already exists".into(),
                ));
            }
            std::fs::rename(path, new)?;
        } else if action == "remove" {
            let backup = state
                .paths
                .backups
                .join("server-plugins")
                .join(id)
                .join(uuid::Uuid::new_v4().to_string())
                .join(name);
            std::fs::create_dir_all(backup.parent().unwrap())?;
            std::fs::copy(&path, &backup)?;
            if providers::hash_file(&path, None, None)?
                != providers::hash_file(&backup, None, None)?
            {
                return Err(AppError::Conflict("Plugin changed; retry".into()));
            }
            std::fs::remove_file(path)?;
            sqlx::query("DELETE FROM server_content WHERE server_id=? AND filename=?")
                .bind(id)
                .bind(name)
                .execute(&state.database)
                .await?;
        } else {
            return Err(AppError::InvalidInput("Invalid plugin action".into()));
        }
        Ok(())
    }
    .await;
    store::set_status(state, id, "stopped").await?;
    result
}
pub async fn install(
    state: &AppState,
    id: &str,
    provider: &str,
    project: &str,
    version: &str,
) -> AppResult<u64> {
    let s = store::idle(state, id).await?;
    let plan = plan(state, id, provider, project, version).await?;
    if sqlx::query("UPDATE local_servers SET status='installing' WHERE id=? AND status IN ('created','stopped','failed')").bind(id).execute(&state.database).await?.rows_affected()!=1{return Err(AppError::Conflict("Another server operation is running".into()));}
    let result:AppResult<u64>=async {
 let root=Path::new(&s.path).join("plugins");store::plain_path(&root)?;std::fs::create_dir_all(&root)?;let temp=tempfile::Builder::new().prefix(".slh-plugin-").tempdir_in(&s.path)?;
 let downloads=plan.items.iter().map(|i|DownloadPlan{url:i.version.url.clone().unwrap(),destination:temp.path().join(&i.version.filename),sha1:Some(i.version.sha1.clone()),max_bytes:Some(256*1024*1024)}).collect();
 download_many(&state.http,downloads,configured_concurrency(&state.database).await,|_,_|{}).await?;
 let existing=files(state,id).await?;let mut changes:Vec<(PathBuf,String,PathBuf)>=vec![];let mut destinations=vec![];let mut identities=HashSet::new();
 for item in &plan.items {let stage=temp.path().join(&item.version.filename);let identity=plugin_name(&stage).ok_or_else(||AppError::Security("Downloaded JAR is not a Bukkit plugin".into()))?;if !identities.insert(identity.to_ascii_lowercase()){return Err(AppError::Conflict("Dependencies contain the same Bukkit plugin twice".into()));}let dest=root.join(&item.version.filename);store::plain_path(&dest)?;
 for file in &existing {if file.enabled&&(file.name.eq_ignore_ascii_case(&identity)||file.filename==item.version.filename){let old=root.join(&file.filename);if !changes.iter().any(|(p,_,_)|p==&old){let hash=providers::hash_file(&old,None,None)?;let backup=state.paths.backups.join("server-plugins").join(id).join(uuid::Uuid::new_v4().to_string()).join(&file.filename);store::plain_path(&backup)?;std::fs::create_dir_all(backup.parent().unwrap())?;std::fs::copy(&old,&backup)?;if providers::hash_file(&backup,None,None)?!=hash{return Err(AppError::Conflict("Plugin changed while backing up".into()));}changes.push((old,hash,backup));}}}
 if dest.exists()&&!changes.iter().any(|(p,_,_)|p==&dest){return Err(AppError::Conflict("Installation would overwrite an unknown plugin file".into()));}destinations.push((stage,dest));}
 for (old,hash,_) in &changes {store::plain_path(old)?;if providers::hash_file(old,None,None)?!=*hash{return Err(AppError::Conflict("Plugin changed before installation; retry".into()));}}
 let mut written=vec![];let commit:AppResult<()>=async {for (old,_,_) in &changes{std::fs::remove_file(old)?;}for (src,dest) in &destinations{if dest.exists(){return Err(AppError::Conflict("Plugin destination changed".into()));}std::fs::rename(src,dest)?;written.push(dest.clone());}let mut tx=state.database.begin().await?;for item in &plan.items{sqlx::query("INSERT INTO server_content(server_id,provider,project_id,version_id,name,filename,sha1) VALUES (?,?,?,?,?,?,?) ON CONFLICT(server_id,provider,project_id) DO UPDATE SET version_id=excluded.version_id,name=excluded.name,filename=excluded.filename,sha1=excluded.sha1").bind(id).bind(provider).bind(&item.project_id).bind(&item.version.id).bind(&item.version.name).bind(&item.version.filename).bind(&item.version.sha1).execute(&mut *tx).await?;}tx.commit().await?;Ok(())}.await;
 if let Err(error)=commit{for p in written{let _=std::fs::remove_file(p);}for (old,_,backup) in &changes{if !old.exists(){let _=std::fs::copy(backup,old);}}return Err(error);}Ok(plan.items.len() as u64)
 }.await;
    store::set_status(state, id, "stopped").await?;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_non_plugin_jars_and_recognizes_bukkit_identity() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("test.jar");
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&p).unwrap());
        zip.start_file("plugin.yml", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"name: Example\nversion: 1.0\n").unwrap();
        zip.finish().unwrap();
        assert_eq!(plugin_name(&p).as_deref(), Some("Example"));
        assert!(filename("../escape.jar").is_err());
        assert!(filename("C:escape.jar").is_err());
        assert!(filename("plugin.zip").is_err());
    }
}
