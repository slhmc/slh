use super::{config::*, store};
use crate::{
    database,
    error::{AppError, AppResult},
    host::Host,
    minecraft::{download, java},
    state::AppState,
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use tokio::io::AsyncWriteExt;

const USER_AGENT: &str = "SLH/0.2.2.1 (https://github.com/slhmc/slh)";
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreVersion {
    pub id: String,
    pub stable: bool,
    pub java_major: u32,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerCatalog {
    pub minecraft_versions: Vec<String>,
    pub versions: Vec<CoreVersion>,
}

pub async fn json(state: &AppState, url: &str) -> AppResult<Value> {
    let key = format!("server-catalog:{url}");
    let cached: Option<(String, String)> =
        sqlx::query_as("SELECT value_json,updated_at FROM settings WHERE key=?")
            .bind(&key)
            .fetch_optional(&state.database)
            .await?;
    if let Some((value, stamp)) = &cached {
        if chrono::DateTime::parse_from_rfc3339(stamp)
            .is_ok_and(|t| chrono::Utc::now().signed_duration_since(t).num_seconds() < 300)
        {
            return Ok(serde_json::from_str(value)?);
        }
    }
    let request = state
        .http
        .get(url)
        .header("User-Agent", USER_AGENT)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await;
    match request {
        Ok(r) if r.status().is_success() => {
            let value: Value = r.json().await?;
            database::set_setting(&state.database, &key, &value).await?;
            Ok(value)
        }
        other => {
            if let Some((value, _)) = cached {
                return Ok(serde_json::from_str(&value)?);
            }
            match other {
                Ok(r) => Err(AppError::Unavailable(format!(
                    "Server catalog returned {}",
                    r.status()
                ))),
                Err(e) => Err(e.into()),
            }
        }
    }
}
fn version_path(value: &str) -> AppResult<&str> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._+-".contains(c))
    {
        return Err(AppError::InvalidInput(
            "Invalid server version identifier".into(),
        ));
    }
    Ok(value)
}
pub fn required_java(mc: &str) -> u32 {
    if modern(mc, 21) && (mc.starts_with("26.") || mc.starts_with("27.")) {
        25
    } else if modern(mc, 20)
        && (!mc.starts_with("1.20.")
            || mc
                .split('.')
                .nth(2)
                .and_then(|p| p.parse::<u32>().ok())
                .unwrap_or(0)
                >= 5)
    {
        21
    } else if modern(mc, 18) {
        17
    } else if modern(mc, 17) {
        16
    } else {
        8
    }
}
pub async fn vanilla_details(state: &AppState, mc: &str) -> AppResult<Value> {
    let manifest = json(
        state,
        "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
    )
    .await?;
    let item = manifest["versions"]
        .as_array()
        .and_then(|a| a.iter().find(|v| v["id"] == mc))
        .ok_or_else(|| AppError::NotFound("Minecraft server version".into()))?;
    let url = item["url"]
        .as_str()
        .ok_or_else(|| AppError::InvalidInput("Missing version metadata URL".into()))?;
    json(state, url).await
}
pub async fn catalog(state: &AppState, core: &str, mc: Option<&str>) -> AppResult<ServerCatalog> {
    let mut out = ServerCatalog {
        minecraft_versions: vec![],
        versions: vec![],
    };
    let manifest = json(
        state,
        "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
    )
    .await?;
    let all = manifest["versions"].as_array().cloned().unwrap_or_default();
    let mut available: Option<Vec<String>> = None;
    match core {
        "paper" => {
            let data = json(state, "https://fill.papermc.io/v3/projects/paper").await?;
            available = Some(
                data["versions"]
                    .as_object()
                    .map(|o| {
                        o.values()
                            .flat_map(|a| {
                                a.as_array()
                                    .into_iter()
                                    .flatten()
                                    .filter_map(|s| s.as_str().map(str::to_owned))
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
            );
        }
        "leaf" => {
            available = Some(json(state, "https://api.leafmc.one/v2/projects/leaf").await?["versions"]
                .as_array().into_iter().flatten().filter_map(|v| v.as_str().map(str::to_owned)).collect());
        }
        "purpur" => {
            available = Some(
                json(state, "https://api.purpurmc.org/v2/purpur").await?["versions"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_str().map(str::to_owned))
                            .collect()
                    })
                    .unwrap_or_default(),
            )
        }
        "fabric" | "quilt" => {
            let url = if core == "fabric" {
                "https://meta.fabricmc.net/v2/versions/game"
            } else {
                "https://meta.quiltmc.org/v3/versions/game"
            };
            available = Some(
                json(state, url)
                    .await?
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v["version"].as_str().map(str::to_owned))
                            .collect()
                    })
                    .unwrap_or_default(),
            );
        }
        "forge" | "neoforge" => {
            let endpoint = if core == "forge" {
                "https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml"
            } else {
                "https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml"
            };
            let versions = maven_versions(state, endpoint).await?;
            available = Some(
                all.iter()
                    .filter_map(|v| v["id"].as_str())
                    .filter(|mc| {
                        let prefix = if core == "forge" {
                            Some(format!("{mc}-"))
                        } else {
                            crate::loaders::neoforge_prefix(mc).ok()
                        };
                        prefix.is_some_and(|p| versions.iter().any(|v| v.starts_with(&p)))
                    })
                    .map(str::to_owned)
                    .collect(),
            );
        }
        "spigot" | "bukkit" => {
            available = Some(
                text_versions(
                    state,
                    "https://hub.spigotmc.org/versions/",
                    r#"href="([^"/?]+)\.json""#,
                )
                .await?,
            );
        }
        "vanilla" | "custom" => {}
        _ => return Err(AppError::InvalidInput("Unknown server core".into())),
    }
    out.minecraft_versions = all
        .iter()
        .filter(|v| v["type"] != "old_alpha" && v["type"] != "old_beta")
        .filter_map(|v| v["id"].as_str())
        .filter(|id| available.as_ref().is_none_or(|a| a.iter().any(|v| v == id)))
        .map(str::to_owned)
        .collect();
    let Some(mc) = mc else { return Ok(out) };
    version_path(mc)?;
    let metadata = vanilla_details(state, mc).await?;
    let major = metadata["javaVersion"]["majorVersion"]
        .as_u64()
        .map(|n| n as u32)
        .unwrap_or_else(|| required_java(mc));
    match core {
        "vanilla" => {
            let data = vanilla_details(state, mc).await?;
            if data["downloads"]["server"]["url"].is_string() {
                out.versions.push(CoreVersion {
                    id: mc.into(),
                    stable: !mc.contains(['w', '-']),
                    java_major: data["javaVersion"]["majorVersion"]
                        .as_u64()
                        .unwrap_or(major as u64) as u32,
                });
            }
        }
        "fabric" | "quilt" => {
            let url = if core == "fabric" {
                format!("https://meta.fabricmc.net/v2/versions/loader/{mc}")
            } else {
                format!("https://meta.quiltmc.org/v3/versions/loader/{mc}")
            };
            let data = json(state, &url).await?;
            for row in data.as_array().into_iter().flatten() {
                if let Some(id) = row["loader"]["version"].as_str() {
                    out.versions.push(CoreVersion {
                        id: id.into(),
                        stable: row["loader"]["stable"]
                            .as_bool()
                            .unwrap_or(!id.contains("beta")),
                        java_major: major,
                    });
                }
            }
        }
        "forge" | "neoforge" => {
            out.versions = crate::loaders::list_versions(state, core, mc)
                .await?
                .into_iter()
                .map(|v| CoreVersion {
                    id: v.id,
                    stable: v.stable,
                    java_major: major,
                })
                .collect();
        }
        "paper" => {
            let data = json(
                state,
                &format!("https://fill.papermc.io/v3/projects/paper/versions/{mc}/builds"),
            )
            .await?;
            for row in data.as_array().into_iter().flatten() {
                if let Some(id) = row["id"].as_u64() {
                    out.versions.push(CoreVersion {
                        id: id.to_string(),
                        stable: row["channel"] == "STABLE",
                        java_major: major,
                    });
                }
            }
        }
        "leaf" => {
            let data = json(state, &format!("https://api.leafmc.one/v2/projects/leaf/versions/{mc}/builds")).await?;
            out.versions = leaf_builds(&data, major);
        }
        "purpur" => {
            let data = json(state, &format!("https://api.purpurmc.org/v2/purpur/{mc}")).await?;
            out.versions = data["builds"]["all"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .rev()
                        .filter_map(|v| {
                            v.as_str().map(|s| CoreVersion {
                                id: s.into(),
                                stable: true,
                                java_major: major,
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
        }
        "spigot" | "bukkit" => {
            let data = json(
                state,
                &format!("https://hub.spigotmc.org/versions/{mc}.json"),
            )
            .await?;
            if data["refs"].is_object() {
                out.versions.push(CoreVersion {
                    id: mc.into(),
                    stable: !mc.contains('-'),
                    java_major: major,
                });
            }
        }
        "custom" => out.versions.push(CoreVersion {
            id: "custom".into(),
            stable: true,
            java_major: major,
        }),
        _ => {}
    }
    Ok(out)
}

async fn checksum_url(state: &AppState, url: &str) -> Option<String> {
    state
        .http
        .get(url)
        .header("User-Agent", USER_AGENT)
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .text()
        .await
        .ok()
        .and_then(|s| s.split_whitespace().next().map(str::to_owned))
}

/// Published checksums are checked before an artifact becomes visible in its final path.
pub async fn artifact(
    state: &AppState,
    url: &str,
    path: &Path,
    algorithm: Option<&str>,
    expected: Option<&str>,
    owner: &str,
) -> AppResult<()> {
    store::plain_path(path)?;
    let parsed = url::Url::parse(url).map_err(|e| AppError::InvalidInput(e.to_string()))?;
    if parsed.scheme() != "https" {
        return Err(AppError::Security("Server downloads require HTTPS".into()));
    }
    let parent = path.parent().unwrap();
    tokio::fs::create_dir_all(parent).await?;
    let temp = parent.join(format!(".slh-{}.part", uuid::Uuid::new_v4()));
    let result:AppResult<()>=async {
        let response=state.http.get(url).header("User-Agent",USER_AGENT).timeout(std::time::Duration::from_secs(180)).send().await?.error_for_status()?;
        if response.content_length().is_some_and(|v|v>2*1024*1024*1024){return Err(AppError::Security("Server artifact exceeds 2 GiB".into()));}
        let mut output=tokio::fs::OpenOptions::new().write(true).create_new(true).open(&temp).await?;let mut stream=response.bytes_stream();let mut size=0u64;
        while let Some(chunk)=stream.next().await {let bytes=chunk?;size+=bytes.len() as u64;if size>2*1024*1024*1024{return Err(AppError::Security("Server artifact exceeds 2 GiB".into()));}output.write_all(&bytes).await?;}
        output.sync_all().await?;drop(output);
        let temp2=temp.clone();let algo=algorithm.map(str::to_owned);let want=expected.map(str::to_owned);
        let hash=tokio::task::spawn_blocking(move || hash_file(&temp2,algo.as_deref(),want.as_deref())).await.map_err(|e|AppError::Process(e.to_string()))??;
        tokio::fs::rename(&temp,path).await?;
        sqlx::query("INSERT INTO managed_artifacts(path,sha256,source,owner_id,completed) VALUES (?,?,?,?,1) ON CONFLICT(path) DO UPDATE SET sha256=excluded.sha256,owner_id=excluded.owner_id,completed=1")
            .bind(path.to_string_lossy().as_ref()).bind(hash).bind(url).bind(owner).execute(&state.database).await?;
        Ok(())
    }.await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(temp).await;
    }
    result
}
pub fn hash_file(
    path: &Path,
    algorithm: Option<&str>,
    expected: Option<&str>,
) -> AppResult<String> {
    use sha1::Digest as _;
    use sha2::Digest;
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut sha = sha2::Sha256::new();
    let mut legacy = sha1::Sha1::new();
    let mut md5 = md5::Context::new();
    let mut buffer = vec![0u8; 128 * 1024];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        sha.update(&buffer[..n]);
        if algorithm == Some("sha1") {
            sha1::Digest::update(&mut legacy, &buffer[..n]);
        }
        if algorithm == Some("md5") {
            md5.consume(&buffer[..n]);
        }
    }
    let hash = hex::encode(sha.finalize());
    if let Some(want) = expected {
        let got = match algorithm {
            Some("sha1") => hex::encode(sha1::Digest::finalize(legacy)),
            Some("md5") => format!("{:x}", md5.finalize()),
            _ => hash.clone(),
        };
        if !got.eq_ignore_ascii_case(want.trim()) {
            return Err(AppError::Security(
                "Server artifact checksum mismatch".into(),
            ));
        }
    }
    Ok(hash)
}

async fn text_versions(state: &AppState, url: &str, pattern: &str) -> AppResult<Vec<String>> {
    let key = format!("server-catalog:{url}#versions");
    let cached: Option<(String, String)> =
        sqlx::query_as("SELECT value_json,updated_at FROM settings WHERE key=?")
            .bind(&key)
            .fetch_optional(&state.database)
            .await?;
    if let Some((json, stamp)) = &cached {
        if chrono::DateTime::parse_from_rfc3339(stamp)
            .is_ok_and(|t| chrono::Utc::now().signed_duration_since(t).num_seconds() < 300)
        {
            return Ok(serde_json::from_str(json)?);
        }
    }
    let response = state
        .http
        .get(url)
        .header("User-Agent", USER_AGENT)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await;
    let text = match response {
        Ok(r) if r.status().is_success() => r.text().await?,
        other => {
            if let Some((json, _)) = cached {
                return Ok(serde_json::from_str(&json)?);
            }
            return Err(AppError::Unavailable(format!(
                "Server version catalog unavailable: {other:?}"
            )));
        }
    };
    let re = regex::Regex::new(pattern).map_err(|e| AppError::InvalidInput(e.to_string()))?;
    let versions: Vec<String> = re.captures_iter(&text).map(|c| c[1].to_owned()).collect();
    database::set_setting(&state.database, &key, &serde_json::to_value(&versions)?).await?;
    Ok(versions)
}
async fn maven_versions(state: &AppState, url: &str) -> AppResult<Vec<String>> {
    text_versions(state, url, r"<version>([^<]+)</version>").await
}
fn hide(command: &mut tokio::process::Command) {
    #[cfg(windows)]
    {
        command.creation_flags(0x08000000);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}
async fn installer(
    java: &str,
    args: &[String],
    directory: &Path,
    log: &Path,
    git: Option<&Path>,
) -> AppResult<()> {
    let mut cmd = tokio::process::Command::new(java);
    cmd.args(args).current_dir(directory).kill_on_drop(true);
    hide(&mut cmd);
    if let Some(git) = git {
        let git_config = directory.join(".slh-buildtools.gitconfig");
        store::atomic_write(&git_config,b"[user]\n    name = SLH BuildTools\n    email = buildtools@localhost\n[core]\n    autocrlf = false\n")?;
        cmd.env("GIT_CONFIG_GLOBAL", git_config)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_TERMINAL_PROMPT", "0");
        let path = std::env::var_os("PATH").unwrap_or_default();
        let paths = std::iter::once(git.to_path_buf()).chain(std::env::split_paths(&path));
        cmd.env(
            "PATH",
            std::env::join_paths(paths).map_err(|e| AppError::InvalidInput(e.to_string()))?,
        );
    }
    let output = std::fs::File::create(log)?;
    cmd.stdout(output.try_clone()?).stderr(output);
    let status = tokio::time::timeout(std::time::Duration::from_secs(1800), cmd.status())
        .await
        .map_err(|_| AppError::Process("Server installer timed out after 30 minutes".into()))??;
    if !status.success() {
        return Err(AppError::Process(format!(
            "Server installer failed ({status}); inspect {}",
            log.display()
        )));
    }
    Ok(())
}
pub async fn resolve_java(
    app: &Host,
    state: &AppState,
    config: &ServerConfig,
    major: u32,
) -> AppResult<String> {
    if let Some(path) = &config.java_path {
        let j = java::inspect(Path::new(path)).await?;
        if j.major_version < major {
            return Err(AppError::InvalidInput(format!(
                "Server requires Java {major} or newer"
            )));
        }
        return Ok(path.clone());
    }
    Ok(java::install_managed_kind(app, state, major, "server-jre")
        .await?
        .path)
}
pub async fn resolve_jdk(
    app: &Host,
    state: &AppState,
    config: &ServerConfig,
    major: u32,
) -> AppResult<String> {
    if let Some(path) = &config.jdk_path {
        let j = java::inspect(Path::new(path)).await?;
        let compiler =
            Path::new(path).with_file_name(if cfg!(windows) { "javac.exe" } else { "javac" });
        if j.major_version != major || !compiler.is_file() {
            return Err(AppError::InvalidInput(format!(
                "BuildTools requires a full JDK {major}, including javac"
            )));
        }
        return Ok(path.clone());
    }
    Ok(java::install_managed_kind(app, state, major, "jdk")
        .await?
        .path)
}

pub async fn install(
    app: &Host,
    state: &AppState,
    id: &str,
) -> AppResult<super::store::LocalServer> {
    let server = store::idle(state, id).await?;
    if server.presentation["origin"]=="imported" {return Err(AppError::InvalidInput("Existing server cores are not replaced automatically; configure the imported JAR".into()));}
    let config = &server.config;
    validate(config)?;
    let claimed=sqlx::query("UPDATE local_servers SET status='installing' WHERE id=? AND status IN ('created','stopped','failed')").bind(id).execute(&state.database).await?.rows_affected();
    if claimed != 1 {
        return Err(AppError::Conflict(
            "Server installation is already running".into(),
        ));
    }
    let result = Box::pin(install_inner(app, state, &server)).await;
    match result {
        Ok(plan) => {
            store::save_plan(state, id, &plan).await?;
            store::set_status(state, id, "stopped").await?;
            store::get(state, id).await
        }
        Err(e) => {
            store::set_status(state, id, "failed").await?;
            Err(e)
        }
    }
}
async fn install_inner(
    app: &Host,
    state: &AppState,
    server: &store::LocalServer,
) -> AppResult<LaunchPlan> {
    let c = &server.config;
    version_path(&c.minecraft_version)?;
    version_path(&c.core_version)?;
    let mc = &c.minecraft_version;
    let version = &c.core_version;
    let destination = Path::new(&server.path);
    store::validate_server_path(&c.core, destination)?;
    let choices = catalog(state, &c.core, Some(mc)).await?;
    let choice = choices
        .versions
        .iter()
        .find(|v| v.id == *version)
        .ok_or_else(|| {
            AppError::Unavailable(
                "This core build is unavailable for the selected Minecraft version".into(),
            )
        })?;
    let major = choice.java_major;
    let java = resolve_java(app, state, c, major).await?;
    let _parallelism = download::configured_concurrency(&state.database).await;
    let staging = destination.join(format!(".slh-install-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&staging)?;
    let log = destination.join("slh-install.log");
    let mut entry = vec!["-jar".into(), "server.jar".into()];
    let operation:AppResult<()>=async {
        match c.core.as_str() {
            "vanilla"=>{let data=vanilla_details(state,mc).await?;let d=&data["downloads"]["server"];artifact(state,d["url"].as_str().ok_or_else(||AppError::Unavailable("No official server JAR for this version".into()))?,&staging.join("server.jar"),Some("sha1"),d["sha1"].as_str(),&server.id).await?;},
            "paper"=>{let data=json(state,&format!("https://fill.papermc.io/v3/projects/paper/versions/{mc}/builds")).await?;let build=data.as_array().and_then(|a|a.iter().find(|b|b["id"].as_u64().map(|n|n.to_string())==Some(version.clone()))).ok_or_else(||AppError::NotFound("Paper build".into()))?;let d=&build["downloads"]["server:default"];artifact(state,d["url"].as_str().ok_or_else(||AppError::Unavailable("No Paper server download".into()))?,&staging.join("server.jar"),Some("sha256"),d["checksums"]["sha256"].as_str(),&server.id).await?;},
            "leaf"=>{
                let data=json(state,&format!("https://api.leafmc.one/v2/projects/leaf/versions/{mc}/builds/{version}")).await?;
                let (url,hash)=leaf_download(&data,mc,version)?;
                artifact(state,&url,&staging.join("server.jar"),Some("sha256"),Some(&hash),&server.id).await?;
            },
            "purpur"=>{let d=json(state,&format!("https://api.purpurmc.org/v2/purpur/{mc}/{version}")).await?;artifact(state,&format!("https://api.purpurmc.org/v2/purpur/{mc}/{version}/download"),&staging.join("server.jar"),Some("md5"),d["md5"].as_str(),&server.id).await?;},
            "fabric"=>{let installers=json(state,"https://meta.fabricmc.net/v2/versions/installer").await?;let installer_version=installers.as_array().and_then(|a|a.iter().find(|v|v["stable"]==true).or_else(||a.first())).and_then(|v|v["version"].as_str()).ok_or_else(||AppError::Unavailable("Fabric installer unavailable".into()))?;version_path(installer_version)?;artifact(state,&format!("https://meta.fabricmc.net/v2/versions/loader/{mc}/{version}/{installer_version}/server/jar"),&staging.join("server.jar"),None,None,&server.id).await?;},
            "quilt"=>{let versions=maven_versions(state,"https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-installer/maven-metadata.xml").await?;let iv=versions.last().ok_or_else(||AppError::Unavailable("Quilt installer unavailable".into()))?;version_path(iv)?;let url=format!("https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-installer/{iv}/quilt-installer-{iv}.jar");let hash=checksum_url(state,&format!("{url}.sha1")).await;artifact(state,&url,&staging.join("installer.jar"),Some("sha1"),hash.as_deref(),&server.id).await?;installer(&java,&["-jar".into(),"installer.jar".into(),"install".into(),"server".into(),mc.clone(),version.clone(),"--download-server".into(),"--install-dir=.".into()],&staging,&log,None).await?;entry=vec!["-jar".into(),"quilt-server-launch.jar".into()];},
            "forge"|"neoforge"=>{let (base,artifact_name)=if c.core=="forge"{("https://maven.minecraftforge.net/net/minecraftforge/forge","forge")}else{("https://maven.neoforged.net/releases/net/neoforged/neoforge","neoforge")};let full=if c.core=="forge"&&!version.starts_with(&format!("{mc}-")){format!("{mc}-{version}")}else{version.clone()};version_path(&full)?;let url=format!("{base}/{full}/{artifact_name}-{full}-installer.jar");let hash=checksum_url(state,&format!("{url}.sha1")).await;artifact(state,&url,&staging.join("installer.jar"),Some("sha1"),hash.as_deref(),&server.id).await?;installer(&java,&["-jar".into(),"installer.jar".into(),"--installServer".into()],&staging,&log,None).await?;
                let arg_name=if cfg!(windows){"win_args.txt"}else{"unix_args.txt"};
                let file=walkdir::WalkDir::new(staging.join("libraries")).follow_links(false).into_iter().filter_map(Result::ok).find(|e|e.file_name()==arg_name).map(|e|e.path().to_path_buf());
                if let Some(p)=file {entry=vec![format!("@{}",p.strip_prefix(&staging).unwrap().to_string_lossy())];}
                else {let prefix=format!("{artifact_name}-{full}");let jar=std::fs::read_dir(&staging)?.filter_map(Result::ok).map(|e|e.path()).find(|p|p.file_name().and_then(|n|n.to_str()).is_some_and(|s|s.starts_with(&prefix)&&s.ends_with(".jar")&&!s.contains("installer"))).ok_or_else(||AppError::Unavailable("Installer did not produce a server entry point".into()))?;entry=vec!["-jar".into(),jar.file_name().unwrap().to_string_lossy().into_owned()];}
            },
            "spigot"|"bukkit"=>{
                let git=if let Some(path)=&c.git_path {PathBuf::from(path)}else{find_tool(if cfg!(windows){"git.exe"}else{"git"}).ok_or_else(||AppError::Unavailable("Git is required for BuildTools; choose Git in server settings".into()))?};
                let jdk=resolve_jdk(app,state,c,major).await?;
                // BuildTools' workspace is separate from the user's nested server folder.
                let build=tempfile::Builder::new().prefix("slh-buildtools-").tempdir()?;
                artifact(state,"https://hub.spigotmc.org/jenkins/job/BuildTools/lastSuccessfulBuild/artifact/target/BuildTools.jar",&build.path().join("BuildTools.jar"),None,None,&server.id).await?;
                let product=if c.core=="bukkit"{"craftbukkit"}else{"spigot"};
                installer(&jdk,&["-jar".into(),"BuildTools.jar".into(),"--rev".into(),mc.clone(),"--compile".into(),product.into(),"--nogui".into()],build.path(),&log,git.parent()).await?;
                let jar=std::fs::read_dir(build.path())?.filter_map(Result::ok).map(|e|e.path()).find(|p|p.file_name().and_then(|s|s.to_str()).is_some_and(|s|s.starts_with(&format!("{product}-"))&&s.ends_with(".jar"))).ok_or_else(||AppError::Unavailable("BuildTools did not produce the requested server JAR".into()))?;
                std::fs::copy(jar,staging.join("server.jar"))?;
            },
            "custom"=>{let source=c.custom_jar.as_ref().ok_or_else(||AppError::InvalidInput("Choose a server JAR".into()))?;store::plain_path(Path::new(source))?;let file=std::fs::File::open(source)?;let mut zip=zip::ZipArchive::new(file).map_err(|_|AppError::InvalidInput("The selected file is not a JAR".into()))?;let manifest=zip.by_name("META-INF/MANIFEST.MF").map_err(|_|AppError::InvalidInput("Server JAR has no manifest".into()))?;drop(manifest);std::fs::copy(source,staging.join("server.jar"))?;},_=>return Err(AppError::InvalidInput("Unknown server core".into()))
        }
        let expected=entry.last().unwrap();if !expected.starts_with('@') && !staging.join(expected).is_file(){return Err(AppError::Unavailable("Server entry point was not generated".into()));}
        merge_staging(&staging,destination)?;
        Ok(())
    }.await;
    if staging.parent() == Some(destination) && store::plain_path(&staging).is_ok() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    operation?;
    Ok(LaunchPlan {
        java,
        args: entry,
        directory: server.path.clone(),
        required_java: major,
    })
}
pub fn find_tool(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .map(|p| p.join(name))
        .find(|p| p.is_file())
}
fn merge_staging(source: &Path, target: &Path) -> AppResult<()> {
    for entry in walkdir::WalkDir::new(source)
        .follow_links(false)
        .min_depth(1)
    {
        let e = entry.map_err(|e| AppError::Process(e.to_string()))?;
        let rel = e.path().strip_prefix(source).unwrap();
        let dest = target.join(rel);
        store::plain_path(&dest)?;
        if e.file_type().is_symlink() {
            return Err(AppError::Security(
                "Installer produced a symbolic link".into(),
            ));
        }
        if e.file_type().is_dir() {
            std::fs::create_dir_all(dest)?;
        } else {
            if dest.exists() {
                if hash_file(&dest, None, None)? != hash_file(e.path(), None, None)? {
                    return Err(AppError::Conflict(format!(
                        "Installer would replace {}",
                        dest.display()
                    )));
                }
            } else {
                std::fs::rename(e.path(), dest)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn checksums_reject_modified_artifacts() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("server.jar");
        std::fs::write(&path, b"verified").unwrap();
        let hash = hash_file(&path, None, None).unwrap();
        assert!(hash_file(&path, Some("sha256"), Some(&hash)).is_ok());
        std::fs::write(&path, b"different").unwrap();
        assert!(hash_file(&path, Some("sha256"), Some(&hash)).is_err());
    }
    #[test]
    fn server_java_requirements() {
        assert_eq!(required_java("1.16.5"), 8);
        assert_eq!(required_java("1.17.1"), 16);
        assert_eq!(required_java("1.20.4"), 17);
        assert_eq!(required_java("1.21.4"), 21);
    }
}

/// Leaf uses the Paper v2 schema, including explicit experimental channels.
pub fn leaf_builds(data: &Value, java_major: u32) -> Vec<CoreVersion> {
    let mut builds: Vec<_> = data["builds"].as_array().into_iter().flatten().filter_map(|row| {
        let id = row["build"].as_u64()?;
        Some((id, CoreVersion { id: id.to_string(), stable: matches!(row["channel"].as_str(), Some("default" | "stable")), java_major }))
    }).collect();
    builds.sort_by_key(|(id, _)| std::cmp::Reverse(*id));
    builds.into_iter().map(|(_, build)| build).collect()
}
pub fn leaf_download(data: &Value, mc: &str, build: &str) -> AppResult<(String, String)> {
    version_path(mc)?; version_path(build)?;
    let download = &data["downloads"]["primary"];
    let name = download["name"].as_str().ok_or_else(|| AppError::Unavailable("Missing Leaf download".into()))?;
    let hash = download["sha256"].as_str().ok_or_else(|| AppError::Unavailable("Missing Leaf checksum".into()))?;
    if !name.ends_with(".jar") || version_path(name).is_err() || hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::Security("Invalid Leaf download metadata".into()));
    }
    Ok((format!("https://api.leafmc.one/v2/projects/leaf/versions/{mc}/builds/{build}/downloads/{name}"), hash.into()))
}
