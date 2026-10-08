use std::collections::HashSet;
use std::fs::File;
use std::path::{Path, PathBuf};

use crate::host::Host;
use uuid::Uuid;

use crate::database;
use crate::error::{AppError, AppResult};
use crate::models::{Instance, MinecraftVersionSummary, ProgressEvent};
use crate::state::AppState;

use super::download::{DownloadPlan, configured_concurrency, download_many, download_verified};
use super::types::{AssetIndex, VersionDetails, VersionManifest, maven_download, rules_allow_for};

const VERSION_MANIFEST_URL: &str =
    "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const VERSION_MANIFEST_CACHE_TTL_SECS: u64 = 5 * 60;
const UNAVAILABLE_ERROR_PREFIX: &str = "This capability is unavailable: ";

fn normalize_unavailable_reason(mut reason: String) -> String {
    while let Some(stripped) = reason.strip_prefix(UNAVAILABLE_ERROR_PREFIX) {
        reason = stripped.to_owned();
    }
    reason
}

pub async fn list_versions(state: &AppState) -> AppResult<Vec<MinecraftVersionSummary>> {
    let manifest = fetch_manifest(state).await?;
    Ok(manifest
        .versions
        .into_iter()
        .map(|version| MinecraftVersionSummary {
            id: version.id,
            version_type: version.version_type,
            release_time: version.release_time,
            url: version.url,
            sha1: version.sha1,
            mirrors: Vec::new(),
            md5: None,
            size_bytes: None,
            package_type: None,
            install_method: None,
            package_family_name: None,
            channel: None,
            architecture: None,
            installability: None,
            install_reason: None,
            status: None,
        })
        .collect())
}

async fn fetch_manifest(state: &AppState) -> AppResult<VersionManifest> {
    let cache_path = state
        .paths
        .cache
        .join("minecraft")
        .join("version_manifest_v2.json");
    // The official manifest changes infrequently compared with the number of
    // times the Library/Create dialog is opened. Reuse a fresh local copy so
    // opening an already-installed version does not wait for a network round
    // trip; a failed/expired cache still falls back to the live endpoint.
    if let Ok(metadata) = tokio::fs::metadata(&cache_path).await {
        let fresh = metadata
            .modified()
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age.as_secs() < VERSION_MANIFEST_CACHE_TTL_SECS);
        if fresh {
            if let Ok(bytes) = tokio::fs::read(&cache_path).await {
                if let Ok(manifest) = serde_json::from_slice(&bytes) {
                    return Ok(manifest);
                }
            }
        }
    }
    let response = state.http.get(VERSION_MANIFEST_URL).send().await;
    match response {
        Ok(response) => {
            let response = response.error_for_status()?;
            let bytes = response.bytes().await?;
            if let Some(parent) = cache_path.parent() {
                tokio::fs::create_dir_all(parent).await?;
            }
            tokio::fs::write(&cache_path, &bytes).await?;
            Ok(serde_json::from_slice(&bytes)?)
        }
        Err(error) if cache_path.is_file() => {
            tracing::warn!(%error, "using cached Minecraft version manifest");
            Ok(serde_json::from_slice(&tokio::fs::read(cache_path).await?)?)
        }
        Err(error) => Err(error.into()),
    }
}

pub async fn install_instance(
    app: &Host,
    state: &AppState,
    instance_id: &str,
    bedrock_mirror_url: Option<&str>,
) -> AppResult<Instance> {
    let current = database::instance(&state.database, instance_id).await?;
    if current.loader_type == "bedrock" {
        crate::settings::ensure_bedrock_enabled(&state.database).await?;
    }
    if matches!(
        current.status.as_str(),
        "installing" | "launching" | "running"
    ) {
        return Err(AppError::Conflict(if current.status == "running" {
            "Stop Minecraft before repairing this instance".into()
        } else {
            "This instance is already installing; wait for it to finish or fail before retrying"
                .into()
        }));
    }
    // Claim the instance atomically. Two clicks (or a stale Install button in
    // another view) can otherwise both observe `created` and start duplicate
    // downloads before either one updates the status.
    let claimed = sqlx::query(
        "UPDATE instances SET status = 'installing' WHERE id = ? \
         AND status NOT IN ('installing', 'launching', 'running')",
    )
    .bind(instance_id)
    .execute(&state.database)
    .await?
    .rows_affected();
    if claimed == 0 {
        let latest = database::instance(&state.database, instance_id).await?;
        return Err(AppError::Conflict(match latest.status.as_str() {
            "running" => "Stop Minecraft before repairing this instance".into(),
            "installing" | "launching" => {
                "This instance is already installing; wait for it to finish or fail before retrying"
                    .into()
            }
            _ => "The instance could not be claimed for installation".into(),
        }));
    }
    install_instance_claimed_with_mirror(app, state, instance_id, bedrock_mirror_url).await
}

/// Continue an installation whose owner already claimed the status. Modpack
/// imports use this while their archive files are being fetched, which keeps
/// the Install button disabled for the whole operation without a second claim.
pub(crate) async fn install_instance_claimed(
    app: &Host,
    state: &AppState,
    instance_id: &str,
) -> AppResult<Instance> {
    install_instance_claimed_with_mirror(app, state, instance_id, None).await
}

pub(crate) async fn install_instance_claimed_with_mirror(
    app: &Host,
    state: &AppState,
    instance_id: &str,
    bedrock_mirror_url: Option<&str>,
) -> AppResult<Instance> {
    let instance = database::instance(&state.database, instance_id).await?;
    if instance.status != "installing" {
        return Err(AppError::Conflict(
            "The instance is not in an installation state".into(),
        ));
    }
    let operation_id = Uuid::new_v4().to_string();
    emit_progress(
        app,
        &operation_id,
        &instance.id,
        "install",
        "metadata",
        "Fetching Minecraft metadata",
        0,
        None,
    );
    let result = async {
        if instance.loader_type == "bedrock" {
            let outcome = crate::minecraft::bedrock::install_instance(
                app,
                state,
                &instance,
                &operation_id,
                bedrock_mirror_url,
            )
            .await?;
            if !outcome.launchable {
                let reason = outcome.reason.unwrap_or_else(|| {
                    "Bedrock was downloaded, but Windows could not finish deployment.".into()
                });
                return Err(AppError::Unavailable(normalize_unavailable_reason(reason)));
            }
        } else {
            install_vanilla(app, state, &instance, &operation_id).await?;
        }
        if !matches!(instance.loader_type.as_str(), "vanilla" | "bedrock") {
            crate::loaders::install_profile(app, state, &instance, &operation_id).await?;
        }
        Ok::<(), AppError>(())
    }
    .await;
    match result {
        Ok(()) => {
            sqlx::query("UPDATE instances SET status = 'installed' WHERE id = ?")
                .bind(instance_id)
                .execute(&state.database)
                .await?;
            emit_progress(
                app,
                &operation_id,
                &instance.id,
                "install",
                "complete",
                "Instance is ready",
                1,
                Some(1),
            );
            database::instance(&state.database, instance_id).await
        }
        Err(error) => {
            let _ = sqlx::query("UPDATE instances SET status = 'error' WHERE id = ?")
                .bind(instance_id)
                .execute(&state.database)
                .await;
            emit_progress(
                app,
                &operation_id,
                &instance.id,
                "install",
                "failed",
                &error.to_string(),
                0,
                None,
            );
            Err(error)
        }
    }
}

async fn install_vanilla(
    app: &Host,
    state: &AppState,
    instance: &Instance,
    operation_id: &str,
) -> AppResult<()> {
    let manifest = fetch_manifest(state).await?;
    let selected = manifest
        .versions
        .into_iter()
        .find(|version| version.id == instance.minecraft_version)
        .ok_or_else(|| AppError::NotFound(format!("Minecraft {}", instance.minecraft_version)))?;
    let minecraft_cache = state.paths.cache.join("minecraft");
    let metadata_cache = minecraft_cache
        .join("versions")
        .join(format!("{}.json", selected.id));
    download_verified(
        &state.http,
        &DownloadPlan {
            url: selected.url.clone(),
            destination: metadata_cache.clone(),
            sha1: (!selected.sha1.trim().is_empty()).then(|| selected.sha1.clone()),
            max_bytes: None,
        },
    )
    .await?;
    let bytes = tokio::fs::read(&metadata_cache).await?;
    let details: VersionDetails = serde_json::from_slice(&bytes)?;
    let instance_root = PathBuf::from(&instance.game_dir)
        .parent()
        .ok_or_else(|| AppError::InvalidInput("Instance game directory has no parent".into()))?
        .to_path_buf();
    let version_root = instance_root.join("versions").join(&details.id);
    tokio::fs::create_dir_all(&version_root).await?;
    tokio::fs::write(
        version_root.join("version.json"),
        serde_json::to_vec_pretty(&details)?,
    )
    .await?;

    let libraries_root = minecraft_cache.join("libraries");
    let assets_root = minecraft_cache.join("assets");
    let mut primary_plans = Vec::new();
    primary_plans.push(DownloadPlan {
        url: details.downloads.client.url.clone(),
        destination: version_root.join(format!("{}.jar", details.id)),
        sha1: details.downloads.client.sha1.clone(),
        max_bytes: None,
    });
    let mut target = crate::platform::RuntimeTarget::host();
    let java = if let Some(path) = &instance.java_path {
        Some(super::java::inspect(Path::new(path)).await?)
    } else {
        super::java::discover_fast(
            state,
            details.java_version.as_ref().map(|v| v.major_version),
        )
        .await?
        .into_iter()
        .find(|v| v.compatible)
    };
    if let Some(java) = java {
        target.java_arch = crate::platform::Architecture::from_java(&java.architecture)?;
    }
    let mut native_archives = Vec::<(PathBuf, Vec<String>)>::new();
    for library in &details.libraries {
        if !rules_allow_for(&library.rules, true, target) {
            continue;
        }
        let artifact = library.downloads.artifact.clone().or_else(|| {
            (library.natives.is_none() && library.downloads.classifiers.is_empty())
                .then(|| maven_download(&library.name, library.url.as_deref(), None))
                .flatten()
        });
        if let Some(artifact) = artifact {
            let relative = artifact.path.as_deref().ok_or_else(|| {
                AppError::InvalidInput(format!("Library {} has no artifact path", library.name))
            })?;
            primary_plans.push(DownloadPlan {
                url: artifact.url.clone(),
                destination: libraries_root.join(relative),
                sha1: artifact.sha1.clone(),
                max_bytes: None,
            });
        }
        if let Some(native_key) = library.natives.as_ref().and_then(|natives| {
            natives.get(crate::platform::OperatingSystem::current().minecraft_name())
        }) {
            let classifier = crate::platform::native_classifier(
                native_key,
                target,
                &library.downloads.classifiers,
            )?;
            if let Some(download) = library
                .downloads
                .classifiers
                .get(&classifier)
                .cloned()
                .or_else(|| {
                    maven_download(&library.name, library.url.as_deref(), Some(&classifier))
                })
            {
                let relative = download.path.as_deref().ok_or_else(|| {
                    AppError::InvalidInput(format!("Native {} has no path", library.name))
                })?;
                let destination = libraries_root.join(relative);
                primary_plans.push(DownloadPlan {
                    url: download.url.clone(),
                    destination: destination.clone(),
                    sha1: download.sha1.clone(),
                    max_bytes: None,
                });
                native_archives.push((
                    destination,
                    library
                        .extract
                        .as_ref()
                        .map(|rules| rules.exclude.clone())
                        .unwrap_or_default(),
                ));
            }
        }
    }
    if let Some(logging) = &details.logging {
        primary_plans.push(DownloadPlan {
            url: logging.client.file.url.clone(),
            destination: assets_root
                .join("log_configs")
                .join(logging.client.file.path.as_deref().unwrap_or("client.xml")),
            sha1: logging.client.file.sha1.clone(),
            max_bytes: None,
        });
    }

    // A few manifests repeat a library (or list the same native classifier
    // more than once). Avoid racing two downloads that target the same cache
    // path; it also removes needless checksum work on a cold install.
    let mut unique_destinations = HashSet::new();
    primary_plans.retain(|plan| unique_destinations.insert(plan.destination.clone()));
    let mut unique_natives = HashSet::new();
    native_archives.retain(|(path, _)| unique_natives.insert(path.clone()));

    emit_progress(
        app,
        operation_id,
        &instance.id,
        "install",
        "libraries",
        "Downloading game files and libraries",
        0,
        Some(primary_plans.len() as u64),
    );
    let asset_index_path = assets_root
        .join("indexes")
        .join(format!("{}.json", details.asset_index.id));
    // The asset index is independent of the client/libraries. Fetch it at the
    // same time so a cold install does not pay two full network round trips
    // before the large asset batch can begin.
    let asset_index_plan = DownloadPlan {
        url: details.asset_index.url.clone(),
        destination: asset_index_path.clone(),
        sha1: Some(details.asset_index.sha1.clone()),
        max_bytes: None,
    };
    let primary_download = download_batch(
        app,
        state,
        operation_id,
        &instance.id,
        "libraries",
        primary_plans,
    );
    let index_download = download_verified(&state.http, &asset_index_plan);
    let (primary_result, index_result) = tokio::join!(primary_download, index_download);
    primary_result?;
    index_result?;
    let index: AssetIndex = serde_json::from_slice(&tokio::fs::read(&asset_index_path).await?)?;
    let mut seen = HashSet::new();
    let mut asset_plans = Vec::new();
    for object in index.objects.into_values() {
        if object.hash.len() < 2 || !seen.insert(object.hash.clone()) {
            continue;
        }
        asset_plans.push(DownloadPlan {
            url: format!(
                "https://resources.download.minecraft.net/{}/{}",
                &object.hash[..2],
                object.hash
            ),
            destination: assets_root
                .join("objects")
                .join(&object.hash[..2])
                .join(&object.hash),
            sha1: Some(object.hash),
            max_bytes: None,
        });
    }
    emit_progress(
        app,
        operation_id,
        &instance.id,
        "install",
        "assets",
        "Downloading Minecraft assets",
        0,
        Some(asset_plans.len() as u64),
    );
    download_batch(
        app,
        state,
        operation_id,
        &instance.id,
        "assets",
        asset_plans,
    )
    .await?;

    let natives_root = instance_root.join("natives").join(&details.id);
    if natives_root.exists() {
        tokio::fs::remove_dir_all(&natives_root).await?;
    }
    tokio::fs::create_dir_all(&natives_root).await?;
    emit_progress(
        app,
        operation_id,
        &instance.id,
        "install",
        "natives",
        "Extracting native libraries",
        0,
        Some(native_archives.len() as u64),
    );
    let target_file = natives_root.join("runtime-target.json");
    tokio::task::spawn_blocking(move || extract_native_archives(&native_archives, &natives_root))
        .await
        .map_err(|error| AppError::Process(format!("Native extraction task failed: {error}")))??;
    tokio::fs::write(target_file, serde_json::to_vec(&target)?).await?;
    Ok(())
}

async fn download_batch(
    app: &Host,
    state: &AppState,
    operation_id: &str,
    instance_id: &str,
    stage: &str,
    plans: Vec<DownloadPlan>,
) -> AppResult<()> {
    let total = plans.len() as u64;
    let names = plans
        .iter()
        .map(|plan| {
            plan.destination
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("file")
                .to_owned()
        })
        .collect::<Vec<_>>();
    let app = app.clone();
    let operation_id = operation_id.to_owned();
    let instance_id = instance_id.to_owned();
    let stage = stage.to_owned();
    let mut completed = 0_u64;
    let concurrency = configured_concurrency(&state.database).await;
    download_many(&state.http, plans, concurrency, move |index, _bytes| {
        completed += 1;
        emit_progress(
            &app,
            &operation_id,
            &instance_id,
            "install",
            &stage,
            &format!("Downloaded {}", names[index]),
            completed,
            Some(total),
        );
    })
    .await?;
    Ok(())
}

fn extract_native_archives(archives: &[(PathBuf, Vec<String>)], output: &Path) -> AppResult<()> {
    for (archive_path, excludes) in archives {
        let file = File::open(archive_path)?;
        let mut archive = zip::ZipArchive::new(file)?;
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index)?;
            let Some(relative) = entry.enclosed_name() else {
                return Err(AppError::Security(format!(
                    "Native archive contains an unsafe path: {}",
                    entry.name()
                )));
            };
            let relative_text = relative.to_string_lossy().replace('\\', "/");
            if relative_text.starts_with("META-INF/")
                || excludes
                    .iter()
                    .any(|prefix| relative_text.starts_with(prefix))
            {
                continue;
            }
            if entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
            {
                return Err(AppError::Security(format!(
                    "Native archive contains a symbolic link: {}",
                    entry.name()
                )));
            }
            let destination = output.join(relative);
            if entry.is_dir() {
                std::fs::create_dir_all(destination)?;
                continue;
            }
            if let Some(parent) = destination.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut target = File::create(destination)?;
            std::io::copy(&mut entry, &mut target)?;
        }
    }
    Ok(())
}

fn emit_progress(
    app: &Host,
    operation_id: &str,
    instance_id: &str,
    operation: &str,
    stage: &str,
    message: &str,
    completed: u64,
    total: Option<u64>,
) {
    let _ = app.emit(
        crate::host::EventKind::OperationProgress,
        ProgressEvent {
            operation_id: operation_id.into(),
            instance_id: Some(instance_id.into()),
            operation: operation.into(),
            stage: stage.into(),
            message: message.into(),
            completed,
            total,
            downloaded_bytes: None,
            total_bytes: None,
        },
    );
}
