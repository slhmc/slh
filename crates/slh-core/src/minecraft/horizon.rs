//! Experimental native Horizon runtime. Releases and preparation are isolated per instance.
use super::download::{DownloadPlan, download_verified};
use crate::{
    database,
    error::{AppError, AppResult},
    host::Host,
    models::Instance,
    state::AppState,
};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tokio::process::Command;

const LEGACY_RELEASE: &str = "v0.2.96";
use super::horizon_catalog::{self, GameLock};

pub fn validate(version: &str) -> AppResult<()> {
    if !cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        return Err(AppError::Unavailable(
            "Horizon integration currently requires Windows x64".into(),
        ));
    }
    if !horizon_catalog::valid_game(version) {
        return Err(AppError::InvalidInput(
            "Invalid Horizon Minecraft version".into(),
        ));
    }
    Ok(())
}

pub async fn ensure_enabled(pool: &sqlx::SqlitePool) -> AppResult<()> {
    if database::setting(pool, "general").await?["rustMinecraft"].as_bool() != Some(true) {
        return Err(AppError::Unavailable(
            "Enable Minecraft on Rust in Advanced settings".into(),
        ));
    }
    Ok(())
}

pub fn root(instance: &Instance) -> AppResult<PathBuf> {
    Ok(Path::new(&instance.game_dir)
        .parent()
        .ok_or_else(|| AppError::InvalidInput("Missing instance root".into()))?
        .join("horizon"))
}

fn extract(archive: &Path, destination: &Path) -> AppResult<()> {
    let mut zip = zip::ZipArchive::new(std::fs::File::open(archive)?)?;
    if zip.len() > 20_000 {
        return Err(AppError::Security(
            "Horizon archive has too many entries".into(),
        ));
    }
    let mut size = 0_u64;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i)?;
        size = size.saturating_add(entry.size());
        if size > 2 * 1024 * 1024 * 1024 || entry.is_symlink() {
            return Err(AppError::Security("Unsafe Horizon archive".into()));
        }
        let relative = entry
            .enclosed_name()
            .ok_or_else(|| AppError::Security("Unsafe Horizon archive path".into()))?;
        crate::security::validate_relative_path(&relative)?;
        let relative = relative
            .strip_prefix("horizon-windows-x64")
            .unwrap_or(&relative);
        let target = destination.join(relative);
        if entry.is_dir() {
            std::fs::create_dir_all(target)?;
        } else {
            std::fs::create_dir_all(target.parent().unwrap())?;
            std::io::copy(&mut entry, &mut std::fs::File::create(target)?)?;
        }
    }
    Ok(())
}

#[derive(serde::Deserialize)]
struct InstalledRelease {
    release: String,
    minecraft: String,
}

fn installed_release(instance: &Instance) -> AppResult<InstalledRelease> {
    let installed: InstalledRelease =
        serde_json::from_slice(&std::fs::read(root(instance)?.join("installed.json"))?)?;
    if !horizon_catalog::valid_tag(&installed.release)
        || installed.minecraft != instance.minecraft_version
    {
        return Err(AppError::Conflict(
            "Installed Horizon version does not match this instance; repair it first".into(),
        ));
    }
    Ok(installed)
}

fn selected_tag(instance: &Instance) -> AppResult<String> {
    let tag = if let Some(tag) = &instance.loader_version {
        tag.clone()
    } else if let Ok(installed) = installed_release(instance) {
        installed.release
    } else if instance.minecraft_version == "26.3" {
        LEGACY_RELEASE.into()
    } else {
        return Err(AppError::InvalidInput("Select a Horizon release".into()));
    };
    if !horizon_catalog::valid_tag(&tag) {
        return Err(AppError::InvalidInput("Invalid Horizon release tag".into()));
    }
    Ok(tag)
}

fn pinned_download(value: &serde_json::Value, destination: PathBuf) -> AppResult<DownloadPlan> {
    let sha1 = value["sha1"].as_str().unwrap_or("");
    if sha1.len() != 40 || !sha1.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::Security(
            "Missing Minecraft download checksum".into(),
        ));
    }
    Ok(DownloadPlan {
        url: value["url"]
            .as_str()
            .ok_or_else(|| AppError::InvalidInput("Missing Minecraft download URL".into()))?
            .into(),
        destination,
        sha1: Some(sha1.into()),
        max_bytes: Some(1024 * 1024 * 1024),
    })
}

async fn download_imports(
    client: &reqwest::Client,
    plans: Vec<DownloadPlan>,
    source: &Path,
    cache: &Path,
    concurrency: usize,
    mut progress: impl FnMut(usize, usize),
) -> AppResult<()> {
    use futures_util::{stream, StreamExt};
    let total = plans.len();
    let mut pending = stream::iter(plans.into_iter().map(|plan| async move {
        let hash = plan.sha1.as_deref().ok_or_else(|| AppError::Security("Missing import checksum".into()))?;
        if plan.destination.is_file() && super::download::verify_sha1(&plan.destination, hash).await? {
            return Ok::<(), AppError>(());
        }
        plan.destination.strip_prefix(source)
            .map_err(|_| AppError::Security("Import outside Horizon directory".into()))?;
        // The same Maven path can identify different bytes in two Horizon
        // releases. Content-address every import so concurrent installations
        // never overwrite a file before the other instance copies it.
        let cached = cache.join("horizon/objects").join(hash);
        download_verified(client, &DownloadPlan { destination: cached.clone(), ..plan.clone() }).await?;
        tokio::fs::create_dir_all(plan.destination.parent().unwrap()).await?;
        // No hard links: preparation must not be able to mutate shared cache files.
        tokio::fs::copy(cached, &plan.destination).await?;
        Ok(())
    })).buffer_unordered(concurrency.clamp(1, super::download::MAX_DOWNLOAD_CONCURRENCY));
    let mut completed = 0;
    progress(0, total);
    while let Some(result) = pending.next().await {
        result?;
        completed += 1;
        progress(completed, total);
    }
    Ok(())
}

/// Mojang may republish the same game version with a different asset index.
/// Horizon accepts only the manifests pinned in its verified release archive.
/// Fetch the canonical one into this instance, never replace SLH's shared cache.
async fn import_metadata(
    client: &reqwest::Client,
    release: &Path,
    source: &Path,
    metadata_base: &str,
) -> AppResult<serde_json::Value> {
    let lock: serde_json::Value =
        serde_json::from_slice(&tokio::fs::read(release.join("research-lock.json")).await?)?;
    let game = GameLock::parse(&serde_json::to_vec(&lock)?)?;
    let pin = &game.manifest_sha1;
    let version = &game.version;
    let metadata = source
        .join("versions")
        .join(version)
        .join(format!("{version}.json"));
    download_verified(
        client,
        &DownloadPlan {
            url: format!("{metadata_base}/{pin}/{version}.json"),
            destination: metadata.clone(),
            sha1: Some(pin.clone()),
            max_bytes: Some(8 * 1024 * 1024),
        },
    )
    .await?;
    let value: serde_json::Value = serde_json::from_slice(&tokio::fs::read(metadata).await?)?;
    if value["id"].as_str() != Some(version.as_str()) {
        return Err(AppError::Security(
            "Horizon Minecraft manifest version mismatch".into(),
        ));
    }
    let asset = &value["assetIndex"];
    let id = asset["id"].as_str().unwrap_or("");
    if id.is_empty()
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
        return Err(AppError::Security(
            "Invalid Horizon asset index identifier".into(),
        ));
    }
    let sha1 = asset["sha1"].as_str().unwrap_or("");
    if sha1.len() != 40 || !sha1.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::Security(
            "Missing Horizon asset index checksum".into(),
        ));
    }
    download_verified(
        client,
        &DownloadPlan {
            url: asset["url"]
                .as_str()
                .ok_or_else(|| AppError::InvalidInput("Missing Horizon asset index URL".into()))?
                .into(),
            destination: source.join("assets/indexes").join(format!("{id}.json")),
            sha1: Some(sha1.into()),
            max_bytes: Some(32 * 1024 * 1024),
        },
    )
    .await?;
    Ok(value)
}

pub async fn install(
    app: &Host,
    state: &AppState,
    instance: &Instance,
    operation: &str,
) -> AppResult<()> {
    validate(&instance.minecraft_version)?;
    ensure_enabled(&state.database).await?;
    require_microsoft(state).await?;
    let root = root(instance)?;
    let tag = selected_tag(instance)?;
    let selected = horizon_catalog::release(state, &tag).await?;
    if selected.game.version != instance.minecraft_version {
        return Err(AppError::InvalidInput(format!(
            "Horizon {tag} requires Minecraft {}, selected {}",
            selected.game.version, instance.minecraft_version
        )));
    }
    let version = &instance.minecraft_version;
    let release = root.join(&tag);
    super::installer::emit_progress(
        app,
        operation,
        &instance.id,
        "install",
        "horizon",
        "Downloading Horizon Rust client",
        0,
        None,
    );
    let archive = root.join(format!("{tag}.zip"));
    if archive.is_file()
        && hex::encode(Sha256::digest(tokio::fs::read(&archive).await?)) != selected.sha256
    {
        tokio::fs::remove_file(&archive).await?;
    }
    download_verified(
        &state.http,
        &DownloadPlan {
            url: selected.url.clone(),
            destination: archive.clone(),
            sha1: None,
            max_bytes: Some(1024 * 1024 * 1024),
        },
    )
    .await?;
    if hex::encode(Sha256::digest(tokio::fs::read(&archive).await?)) != selected.sha256 {
        return Err(AppError::Security("Horizon SHA-256 mismatch".into()));
    }
    let destination = release.clone();
    tokio::task::spawn_blocking(move || extract(&archive, &destination))
        .await
        .map_err(|e| AppError::Process(e.to_string()))??;
    let game = GameLock::parse(&tokio::fs::read(release.join("research-lock.json")).await?)?;
    if game != selected.game {
        return Err(AppError::Security(
            "Horizon archive compatibility metadata differs from its published release".into(),
        ));
    }
    if !release.join("horizon-client.exe").is_file()
        || !release.join("horizon-prepare.exe").is_file()
    {
        return Err(AppError::Unavailable(
            "Unsupported Horizon archive layout; update SLH".into(),
        ));
    }
    let source = root.join("imports").join(&tag);
    if instance.loader_type == "horizon-server" && crate::local_servers::horizon::reuse_prepared(state, &tag, &selected.sha256, version, &release).await? {
        tokio::fs::write(root.join("installed.json"), serde_json::to_vec(&serde_json::json!({"release":tag,"minecraft":version,"archiveSha256":selected.sha256,"javaMajor":game.java_major}))?).await?;
        return Ok(());
    }
    let version_dir = source.join("versions").join(version);
    let value = import_metadata(
        &state.http,
        &release,
        &source,
        "https://piston-meta.mojang.com/v1/packages",
    )
    .await?;
    let mut plans = vec![pinned_download(
        &value["downloads"]["client"],
        version_dir.join(format!("{version}.jar")),
    )?];
    let server_path = source.join("server.jar");
    plans.push(pinned_download(&value["downloads"]["server"], server_path.clone())?);
    for library in value["libraries"].as_array().into_iter().flatten() {
        let artifact = &library["downloads"]["artifact"];
        if let Some(path) = artifact["path"].as_str() {
            crate::security::validate_relative_path(Path::new(path))?;
            plans.push(pinned_download(artifact, source.join("libraries").join(path))?);
        }
    }
    let index: super::types::AssetIndex = serde_json::from_slice(
        &tokio::fs::read(source.join("assets/indexes").join(format!(
            "{}.json", value["assetIndex"]["id"].as_str().unwrap()
        ))).await?,
    )?;
    let mut seen = std::collections::HashSet::new();
    for object in index.objects.values() {
        if object.hash.len() != 40 || !object.hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(AppError::Security("Invalid Minecraft asset hash".into()));
        }
        if seen.insert(object.hash.clone()) {
            plans.push(DownloadPlan {
                url: format!("https://resources.download.minecraft.net/{}/{}", &object.hash[..2], object.hash),
                destination: source.join(format!("assets/objects/{}/{}", &object.hash[..2], object.hash)),
                sha1: Some(object.hash.clone()),
                max_bytes: None,
            });
        }
    }
    // Jars, libraries and assets share one bounded queue. Each verified object
    // is cached across instances; preparation still receives private copies.
    download_imports(
        &state.http, plans, &source, &state.paths.cache.join("minecraft"),
        super::download::configured_concurrency(&state.database).await,
        |completed, total| super::installer::emit_progress(
            app, operation, &instance.id, "install", "horizon-downloads",
            "Downloading Horizon Minecraft resources", completed as u64, Some(total as u64),
        ),
    ).await?;
    let minecraft_settings = database::setting(&state.database, "minecraft").await?;
    let configured_java = instance
        .java_path
        .as_deref()
        .filter(|p| !p.trim().is_empty())
        .or_else(|| {
            minecraft_settings["javaPath"].as_str().filter(|p| {
                !p.trim().is_empty() && minecraft_settings["javaMode"].as_str() == Some("custom")
            })
        });
    let configured_java = if instance.loader_type == "horizon-server" { None } else { configured_java };
    let java = if let Some(path) = configured_java {
        super::java::inspect(Path::new(path)).await?
    } else {
        resolve_preparation_java(app, state, game.java_major).await?
    };
    if java.major_version != game.java_major {
        return Err(AppError::JavaCompatibility {
            required: game.java_major,
            actual: java.major_version,
            path: java.path,
        });
    }
    let java_home = Path::new(&java.path)
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| AppError::InvalidInput("Invalid Java path".into()))?;
    let mut help_command = Command::new(release.join("horizon-prepare.exe"));
    help_command.arg("--help").kill_on_drop(true);
    #[cfg(windows)]
    help_command.creation_flags(0x08000000);
    let help = tokio::time::timeout(std::time::Duration::from_secs(15), help_command.output())
        .await
        .map_err(|_| AppError::Process("Horizon preparation help timed out".into()))??;
    let help =
        String::from_utf8_lossy(&help.stdout).to_string() + &String::from_utf8_lossy(&help.stderr);
    let modes = preparation_modes(&help)?;
    for mode in modes {
        if instance.loader_type == "horizon-server" && mode != "--prepare" { continue; }
        super::installer::emit_progress(
            app,
            operation,
            &instance.id,
            "install",
            "horizon-prepare",
            &format!("Preparing Horizon: {mode}"),
            0,
            None,
        );
        let mut command = Command::new(release.join("horizon-prepare.exe"));
        command
            .arg(mode)
            .arg("--root")
            .arg(&release)
            .arg("--minecraft-dir")
            .arg(&source)
            .env("JAVA_HOME", java_home)
            .current_dir(&release)
            .kill_on_drop(true);
        if mode == "--prepare" {
            command.arg("--server-jar").arg(&server_path);
        }
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let output = tokio::time::timeout(std::time::Duration::from_secs(1800), command.output())
            .await
            .map_err(|_| {
                AppError::Process("Horizon preparation timed out; retry installation".into())
            })??;
        // Preparation never receives account tokens. Keep its output for diagnosing upstream failures.
        tokio::fs::write(
            root.join(format!("prepare-{}.log", mode.trim_start_matches('-'))),
            [&output.stdout[..], &output.stderr[..]].concat(),
        )
        .await?;
        if !output.status.success() {
            return Err(AppError::Process(format!(
                "Horizon preparation failed ({mode}); see {}",
                root.display()
            )));
        }
    }
    if !release
        .join(format!(
            ".local/horizon-client/{version}/horizon-resources.json"
        ))
        .is_file()
    {
        return Err(AppError::Process(
            "Horizon did not produce its resource manifest".into(),
        ));
    }
    let prepared: serde_json::Value = serde_json::from_slice(
        &tokio::fs::read(release.join(format!(
            ".local/horizon-client/{version}/horizon-resources.json"
        )))
        .await?,
    )?;
    if prepared["minecraft"].as_str() != Some(version.as_str())
        || prepared["schema"].as_u64().is_none()
    {
        return Err(AppError::Unavailable(
            "Unsupported Horizon prepared resource manifest; update SLH".into(),
        ));
    }
    tokio::fs::write(
        root.join("installed.json"),
        serde_json::to_vec(&serde_json::json!({"release":tag,"minecraft":version,"archiveSha256":selected.sha256,"javaMajor":game.java_major}))?,
    )
    .await?;
    Ok(())
}

fn preparation_modes(help: &str) -> AppResult<Vec<&'static str>> {
    for flag in ["--prepare", "--root", "--minecraft-dir", "--server-jar"] {
        if !help.contains(flag) {
            return Err(AppError::Unavailable(
                "Unsupported Horizon preparation CLI; update SLH".into(),
            ));
        }
    }
    let mut modes = vec!["--prepare"];
    for mode in ["sounds", "panorama", "fonts", "packs", "languages"] {
        if help.contains(&format!("horizon-prepare {mode}")) {
            modes.push(mode);
        }
    }
    Ok(modes)
}

async fn resolve_preparation_java(
    app: &Host,
    state: &AppState,
    major: u32,
) -> AppResult<crate::models::JavaInstallation> {
    if major <= 25 {
        return super::java::resolve_automatic(app, state, Some(major)).await;
    }
    let preferences = database::setting(&state.database, "java").await?;
    if preferences["autoDetect"].as_bool() == Some(false) {
        return Err(AppError::Unavailable(
            "Choose a Java executable or enable automatic Java detection".into(),
        ));
    }
    if let Some(java) = super::java::discover_fast(state, Some(major))
        .await?
        .into_iter()
        .find(|j| j.compatible)
    {
        return Ok(java);
    }
    if preferences["autoDownload"].as_bool() == Some(false) {
        return Err(AppError::Unavailable(format!(
            "Horizon requires Java {major}; install it or enable automatic Java download"
        )));
    }
    super::java::install_managed_kind(app, state, major, "jdk").await
}

pub async fn require_microsoft(state: &AppState) -> AppResult<()> {
    if database::active_account(&state.database)
        .await?
        .is_none_or(|a| a.provider != "microsoft")
    {
        return Err(AppError::Unavailable(
            "Select a Microsoft account that owns Minecraft Java Edition to use Horizon".into(),
        ));
    }
    Ok(())
}

pub fn launch_command(
    instance: &Instance,
    credentials: &crate::accounts::AccountLaunchCredentials,
) -> AppResult<(Command, tempfile::TempPath)> {
    validate(&instance.minecraft_version)?;
    let root = root(instance)?;
    if !root.join("installed.json").is_file() {
        return Err(AppError::Conflict(
            "Install or repair this Horizon instance first".into(),
        ));
    }
    let installed = installed_release(instance)?;
    if instance
        .loader_version
        .as_deref()
        .is_some_and(|tag| tag != installed.release)
    {
        return Err(AppError::Conflict(
            "Install the selected Horizon release before launching".into(),
        ));
    }
    let release = root.join(&installed.release);
    let resources = release.join(format!(".local/horizon-client/{}", installed.minecraft));
    if !resources.join("horizon-resources.json").is_file() {
        return Err(AppError::Conflict(
            "Horizon resources are missing; repair this instance".into(),
        ));
    }
    let mut session = tempfile::NamedTempFile::new()?;
    // tempfile uses private permissions on Unix; Windows inherits the current user's temp ACL.
    use std::io::Write;
    session.write_all(&serde_json::to_vec(&serde_json::json!({"name":credentials.username,"uuid":credentials.uuid,"access_token":credentials.access_token,"user_type":"msa"}))?)?;
    let session = session.into_temp_path();
    let mut command = Command::new(release.join("horizon-client.exe"));
    command
        .arg("--resources")
        .arg(&resources)
        .arg("--session-file")
        .arg(&session)
        .env("HORIZON_HOME", &instance.game_dir)
        .env("HORIZON_NO_TELEMETRY", "1");
    Ok((command, session))
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn imports_share_verified_downloads_but_keep_private_files_and_pinned_jars() {
        use super::*;
        use sha1::{Digest, Sha1};
        let server = httpmock::MockServer::start_async().await;
        let artifact = server.mock_async(|when, then| {
            when.method("GET").path("/artifact");
            then.body("original");
        }).await;
        let temp = tempfile::tempdir().unwrap();
        let cache = temp.path().join("cache");
        let client = reqwest::Client::new();
        let hash = hex::encode(Sha1::digest(b"original"));
        for name in ["first", "second", "second"] {
            let source = temp.path().join(name);
            let target = source.join("server.jar");
            let plan = DownloadPlan { url: server.url("/artifact"), destination: target.clone(), sha1: Some(hash.clone()), max_bytes: None };
            download_imports(&client, vec![plan], &source, &cache, 4, |_, _| {}).await.unwrap();
            assert_eq!(std::fs::read(&target).unwrap(), b"original");
            // A preparation tool or interrupted copy cannot poison the shared object.
            std::fs::write(target, b"changed by preparation").unwrap();
        }
        artifact.assert_calls_async(1).await;
        assert_eq!(std::fs::read(cache.join("horizon/objects").join(&hash)).unwrap(), b"original");
        let other = server.mock_async(|when, then| {
            when.method("GET").path("/older");
            then.body("older pinned jar");
        }).await;
        let source = temp.path().join("older");
        download_imports(&client, vec![DownloadPlan {
            url: server.url("/older"), destination: source.join("server.jar"),
            sha1: Some(hex::encode(Sha1::digest(b"older pinned jar"))), max_bytes: None,
        }], &source, &cache, 4, |_, _| {}).await.unwrap();
        other.assert_calls_async(1).await;
        assert_eq!(std::fs::read(source.join("server.jar")).unwrap(), b"older pinned jar");

        // A library path may be reused with different contents by two
        // releases. Installing them together must keep both cached objects.
        let newer = server.mock_async(|when, then| {
            when.method("GET").path("/library-new");
            then.body("new library");
        }).await;
        let older = server.mock_async(|when, then| {
            when.method("GET").path("/library-old");
            then.body("old library");
        }).await;
        let first = temp.path().join("first-library");
        let second = temp.path().join("second-library");
        let new_hash = hex::encode(Sha1::digest(b"new library"));
        let old_hash = hex::encode(Sha1::digest(b"old library"));
        let relative = "libraries/example/example.jar";
        let first_install = download_imports(&client, vec![DownloadPlan {
            url: server.url("/library-new"), destination: first.join(relative),
            sha1: Some(new_hash.clone()), max_bytes: None,
        }], &first, &cache, 4, |_, _| {});
        let second_install = download_imports(&client, vec![DownloadPlan {
            url: server.url("/library-old"), destination: second.join(relative),
            sha1: Some(old_hash.clone()), max_bytes: None,
        }], &second, &cache, 4, |_, _| {});
        let (first_result, second_result) = tokio::join!(first_install, second_install);
        first_result.unwrap();
        second_result.unwrap();
        newer.assert_calls_async(1).await;
        older.assert_calls_async(1).await;
        assert_eq!(std::fs::read(first.join(relative)).unwrap(), b"new library");
        assert_eq!(std::fs::read(second.join(relative)).unwrap(), b"old library");
        assert_eq!(std::fs::read(cache.join("horizon/objects").join(new_hash)).unwrap(), b"new library");
        assert_eq!(std::fs::read(cache.join("horizon/objects").join(old_hash)).unwrap(), b"old library");
    }
    use super::*;
    #[test]
    fn preparation_cli_accepts_optional_modes_but_rejects_unknown_protocol() {
        let help = "--prepare --root --minecraft-dir --server-jar\nhorizon-prepare sounds\nhorizon-prepare fonts";
        assert_eq!(
            preparation_modes(help).unwrap(),
            vec!["--prepare", "sounds", "fonts"]
        );
        assert!(preparation_modes("new-cli --convert --home").is_err());
    }

    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    #[tokio::test]
    async fn release_changes_preserve_game_files_and_launch_the_installed_version_offline() {
        let temp = tempfile::tempdir().unwrap();
        let paths = crate::portable::PortablePaths::from_executable(
            &temp.path().join("SLH.exe"),
            Some(temp.path().to_path_buf()),
        )
        .unwrap();
        let state = AppState::initialize_isolated_at(paths).await.unwrap();
        sqlx::query("UPDATE settings SET value_json=json_set(value_json,'$.rustMinecraft',json('true')) WHERE key='general'").execute(&state.database).await.unwrap();
        for (game_version, tag) in [("26.3", "v0.2.96"), ("26.4", "v0.3.0")] {
            let request=serde_json::from_value(serde_json::json!({"name":format!("Horizon {game_version}"),"minecraftVersion":game_version,"loaderType":"rust","loaderVersion":tag,"memoryMinMb":512,"memoryMaxMb":2048})).unwrap();
            let mut instance =
                crate::instances::create_instance(&state.database, &state.paths, request)
                    .await
                    .unwrap();
            let root = root(&instance).unwrap();
            let resources = root
                .join(tag)
                .join(format!(".local/horizon-client/{game_version}"));
            std::fs::create_dir_all(&resources).unwrap();
            std::fs::write(resources.join("horizon-resources.json"), b"{}").unwrap();
            std::fs::write(
                root.join("installed.json"),
                serde_json::to_vec(&serde_json::json!({"release":tag,"minecraft":game_version}))
                    .unwrap(),
            )
            .unwrap();
            let options = Path::new(&instance.game_dir).join("options.txt");
            std::fs::write(&options, b"user settings").unwrap();
            // Legacy instances do not have loaderVersion. No network lookup or automatic upgrade.
            if game_version == "26.3" {
                instance.loader_version = None;
            }
            assert_eq!(selected_tag(&instance).unwrap(), tag);
            let credentials = crate::accounts::AccountLaunchCredentials {
                username: "Player".into(),
                uuid: "00000000000000000000000000000001".into(),
                access_token: "MUST_STAY_PRIVATE".into(),
                user_type: "msa".into(),
                extra_jvm_arguments: vec![],
            };
            let (command, session) = launch_command(&instance, &credentials).unwrap();
            assert_eq!(
                command.as_std().get_program(),
                root.join(tag).join("horizon-client.exe")
            );
            let args = command
                .as_std()
                .get_args()
                .map(|a| a.to_string_lossy().into_owned())
                .collect::<Vec<_>>();
            assert!(
                args.windows(2)
                    .any(|a| a[0] == "--resources" && Path::new(&a[1]) == resources)
            );
            assert!(!args.iter().any(|a| a.contains("MUST_STAY_PRIVATE")));
            let session_path = session.to_path_buf();
            drop(session);
            assert!(!session_path.exists());
            let update=serde_json::from_value(serde_json::json!({"instanceId":instance.id,"name":instance.name,"iconKey":"cube","iconBackground":"#3f493c","iconForeground":"#f0f4ed","memoryMinMb":512,"memoryMaxMb":2048,"loaderType":"rust","loaderVersion":"v0.3.1"})).unwrap();
            let changed = crate::instances::update_instance(&state, update)
                .await
                .unwrap();
            assert_eq!(changed.loader_version.as_deref(), Some("v0.3.1"));
            assert_eq!(changed.status, "created");
            assert_eq!(std::fs::read(&options).unwrap(), b"user settings");
            assert!(
                launch_command(&changed, &credentials).is_err(),
                "an uninstalled selected release cannot silently launch the old one"
            );
        }
        state.database.close().await;
    }

    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    #[tokio::test]
    #[ignore = "downloads an official Horizon release and probes its preparation CLI"]
    async fn live_github_catalog_and_verified_v0297_archive() {
        let temp = tempfile::tempdir().unwrap();
        let paths = crate::portable::PortablePaths::from_executable(
            &temp.path().join("SLH.exe"),
            Some(temp.path().to_path_buf()),
        )
        .unwrap();
        let state = AppState::initialize_isolated_at(paths).await.unwrap();
        let versions = horizon_catalog::versions(&state, "26.3").await.unwrap();
        assert!(!versions.is_empty());
        assert!(versions.iter().all(|v| horizon_catalog::valid_tag(&v.id)));
        let release = horizon_catalog::release(&state, "v0.2.97").await.unwrap();
        assert_eq!(release.game.version, "26.3");
        let archive = temp.path().join("release.zip");
        download_verified(
            &state.http,
            &DownloadPlan {
                url: release.url,
                destination: archive.clone(),
                sha1: None,
                max_bytes: Some(1024 * 1024 * 1024),
            },
        )
        .await
        .unwrap();
        assert_eq!(
            hex::encode(Sha256::digest(std::fs::read(&archive).unwrap())),
            release.sha256
        );
        let target = temp.path().join("release");
        extract(&archive, &target).unwrap();
        assert_eq!(
            GameLock::parse(&std::fs::read(target.join("research-lock.json")).unwrap()).unwrap(),
            release.game
        );
        let mut command = Command::new(target.join("horizon-prepare.exe"));
        command.arg("--help").creation_flags(0x08000000);
        let output = command.output().await.unwrap();
        assert!(output.status.success());
        let help = String::from_utf8_lossy(&output.stdout).to_string()
            + &String::from_utf8_lossy(&output.stderr);
        assert!(preparation_modes(&help).unwrap().contains(&"--prepare"));
        eprintln!(
            "Verified live catalog: {} compatible releases, v0.2.97 archive, Minecraft {}, Java {}",
            versions.len(),
            release.game.version,
            release.game.java_major
        );
        // Both installation and the writable download cache stay in the
        // temporary directory, never in a user's existing launcher data.
        sqlx::query("UPDATE settings SET value_json=json_set(value_json,'$.rustMinecraft',json('true')) WHERE key='general'").execute(&state.database).await.unwrap();
        sqlx::query("INSERT INTO accounts(id,provider,provider_uuid,username,auth_status,active) VALUES ('fixture','microsoft','00000000000000000000000000000001','Fixture','ready',1)").execute(&state.database).await.unwrap();
        if let Ok(java) = std::env::var("SLH_HORIZON_TEST_JAVA") {
            sqlx::query("UPDATE settings SET value_json=json_set(value_json,'$.javaMode','custom','$.javaPath',?) WHERE key='minecraft'").bind(java).execute(&state.database).await.unwrap();
        }
        let request=serde_json::from_value(serde_json::json!({"name":"Live Horizon fixture","minecraftVersion":"26.3","loaderType":"rust","loaderVersion":"v0.2.97","memoryMinMb":512,"memoryMaxMb":2048})).unwrap();
        let instance = crate::instances::create_instance(&state.database, &state.paths, request)
            .await
            .unwrap();
        let options = Path::new(&instance.game_dir).join("options.txt");
        std::fs::write(&options, b"preserve user options").unwrap();
        let installed = super::super::installer::install_instance(
            &crate::host::Host::silent(),
            &state,
            &instance.id,
            None,
        )
        .await;
        if let Err(error) = &installed {
            if let Ok(logs) = std::fs::read_dir(root(&instance).unwrap()) {
                for entry in logs
                    .flatten()
                    .filter(|e| e.path().extension().is_some_and(|ext| ext == "log"))
                {
                    eprintln!(
                        "{}: {}",
                        entry.path().display(),
                        std::fs::read_to_string(entry.path()).unwrap_or_default()
                    );
                }
            }
            panic!("live Horizon install: {error}");
        }
        assert_eq!(installed.unwrap().status, "installed");
        assert_eq!(std::fs::read(&options).unwrap(), b"preserve user options");
        assert_eq!(installed_release(&instance).unwrap().release, "v0.2.97");
        eprintln!(
            "Full v0.2.97 installation and resource preparation passed without launching the game"
        );
        state.database.close().await;
    }
    #[tokio::test]
    async fn republished_manifest_and_index_are_replaced_only_in_horizon_import() {
        for (game_version, java_major) in [("26.3", 25), ("26.4", 26)] {
            use sha1::{Digest, Sha1};
            let server = httpmock::MockServer::start_async().await;
            let index = br#"{"objects":{}}"#;
            let metadata = serde_json::to_vec(&serde_json::json!({
            "id":game_version,
            "assetIndex":{"id":"34","sha1":hex::encode(Sha1::digest(index)),"url":server.url("/index.json")},
            "downloads":{"server":{"url":"https://example.invalid/server.jar"}}
        })).unwrap();
            let pin = hex::encode(Sha1::digest(&metadata));
            let manifest_mock = server
                .mock_async(|when, then| {
                    when.method(httpmock::Method::GET)
                        .path(format!("/packages/{pin}/{game_version}.json"));
                    then.status(200).body(metadata.clone());
                })
                .await;
            let index_mock = server
                .mock_async(|when, then| {
                    when.method(httpmock::Method::GET).path("/index.json");
                    then.status(200).body(index);
                })
                .await;
            let temp = tempfile::tempdir().unwrap();
            let release = temp.path().join("release");
            let source = temp.path().join("horizon/minecraft");
            std::fs::create_dir_all(&release).unwrap();
            std::fs::create_dir_all(source.join(format!("versions/{game_version}"))).unwrap();
            std::fs::create_dir_all(source.join("assets/indexes")).unwrap();
            std::fs::write(
                release.join("research-lock.json"),
                serde_json::to_vec(&serde_json::json!({
                    "minecraft":{"version":game_version,"manifest_sha1":pin,"java_major":java_major}
                }))
                .unwrap(),
            )
            .unwrap();
            let latest = b"republished Mojang metadata, not yet accepted by Horizon";
            let shared = temp.path().join("shared-java-metadata.json");
            std::fs::write(&shared, latest).unwrap();
            std::fs::write(
                source.join(format!("versions/{game_version}/{game_version}.json")),
                latest,
            )
            .unwrap();
            std::fs::write(source.join("assets/indexes/34.json"), b"new asset index").unwrap();
            import_metadata(
                &reqwest::Client::new(),
                &release,
                &source,
                &server.url("/packages"),
            )
            .await
            .unwrap();
            assert_eq!(
                std::fs::read(source.join(format!("versions/{game_version}/{game_version}.json")))
                    .unwrap(),
                metadata
            );
            assert_eq!(
                std::fs::read(source.join("assets/indexes/34.json")).unwrap(),
                index
            );
            assert_eq!(std::fs::read(shared).unwrap(), latest);
            // A retry reuses the verified import without making more requests.
            import_metadata(
                &reqwest::Client::new(),
                &release,
                &source,
                &server.url("/packages"),
            )
            .await
            .unwrap();
            manifest_mock.assert_calls_async(1).await;
            index_mock.assert_calls_async(1).await;
        }
    }
    #[test]
    fn rejects_unsupported_game_versions() {
        assert!(validate("../26.4").is_err());
    }
    #[test]
    fn rejects_archive_traversal() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("bad.zip");
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&archive).unwrap());
        zip.start_file("../outside", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"bad").unwrap();
        zip.finish().unwrap();
        assert!(extract(&archive, &dir.path().join("out")).is_err());
        assert!(!dir.path().join("outside").exists());
    }
}
