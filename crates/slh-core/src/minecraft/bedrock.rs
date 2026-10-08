use std::cmp::Ordering;
use std::collections::HashSet;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use crate::host::Host;
use chrono::{SecondsFormat, Utc};
use futures_util::future::join_all;
use regex::Regex;
use serde::Deserialize;
use uuid::Uuid;

use crate::database;
use crate::error::{AppError, AppResult};
use crate::models::{BedrockMirrorProbe, Instance, MinecraftVersionSummary, ProgressEvent};
use crate::state::AppState;

use super::bedrock_runtime::{self, BedrockInstallOutcome};
use super::download::{self, ResumableDownloadPlan, download_resumable_verified_with_progress};

// Windows Bedrock is distributed as Store packages rather than Java's
// version.json/JAR layout. These two small community-maintained catalogues
// contain package identities and Microsoft CDN URLs; the game binaries are
// never bundled with SLH.
const UWP_CATALOG_URL: &str = "https://raw.githubusercontent.com/ddf8196/mc-w10-versiondb-auto-update/master/versions.json.min";
const GDK_CATALOG_URL: &str = "https://raw.githubusercontent.com/LiteLDev/minecraft-windows-gdk-version-db/main/historical_versions.json";
const GDK_CATALOG_FALLBACK_URL: &str = "https://raw.githubusercontent.com/LukasPAH/minecraft-windows-gdk-version-db/main/historical_versions.json";
const CATALOG_CACHE_TTL_SECS: u64 = 30 * 60;
const MIRROR_PROBE_TIMEOUT_MS: u64 = 7_000;
/// Official Bedrock Store packages can be several gigabytes. Keep an explicit
/// scoped ceiling for a package fetched from an allow-listed Microsoft CDN.
const MAX_BEDROCK_PACKAGE_BYTES: u64 = 16 * 1024 * 1024 * 1024;
const MICROSOFT_UPDATE_SERVICE_URL: &str =
    "https://fe3.delivery.mp.microsoft.com/ClientWebService/client.asmx/secured";
const MICROSOFT_UPDATE_SERVICE_FALLBACK_URL: &str =
    "https://fe3.delivery.mp.microsoft.com/ClientWebService/client.asmx";

const DEVICE_ATTRIBUTES: &str = "E:BranchReadinessLevel=CBB&DchuNvidiaGrfxExists=1&ProcessorIdentifier=Intel64%20Family%206%20Model%2063%20Stepping%202&CurrentBranch=rs4_release&DataVer_RS5=1942&FlightRing=Retail&AttrDataVer=57&InstallLanguage=en-US&DchuAmdGrfxExists=1&OSUILocale=en-US&InstallationType=Client&FlightingBranchName=&Version_RS5=10&UpgEx_RS5=Green&GStatus_RS5=2&OSSkuId=48&App=WU&InstallDate=1529700913&ProcessorManufacturer=GenuineIntel&AppVer=10.0.17134.471&OSArchitecture=AMD64&UpdateManagementGroup=2&IsDeviceRetailDemo=0&HidOverGattReg=C%3A%5CWINDOWS%5CSystem32%5CDriverStore%5CFileRepository%5Chidbthle.inf_amd64_467f181075371c89%5CMicrosoft.Bluetooth.Profiles.HidOverGatt.dll&IsFlightingEnabled=0&DchuIntelGrfxExists=1&TelemetryLevel=1&DefaultUserRegion=244&DeferFeatureUpdatePeriodInDays=365&Bios=Unknown&WuClientVer=10.0.17134.471&PausedFeatureStatus=1&Steam=URL%3Asteam%20protocol&Free=8to16&OSVersion=10.0.17134.472&DeviceFamily=Windows.Desktop";

#[derive(Clone, Debug)]
enum PackageSource {
    Uwp {
        update_id: String,
    },
    NativeMsixvc {
        mirrors: Vec<String>,
        md5: Option<String>,
        package_family_name: String,
    },
}

#[derive(Clone, Debug)]
struct MsixvcIdentity {
    package_family_name: String,
    architecture: String,
}

#[derive(Clone, Debug)]
struct BedrockVersion {
    summary: MinecraftVersionSummary,
    source: PackageSource,
}

#[derive(Debug, Deserialize)]
struct GdkCatalog {
    #[serde(rename = "releaseVersions", default)]
    release_versions: Vec<GdkEntry>,
    #[serde(rename = "previewVersions", default)]
    preview_versions: Vec<GdkEntry>,
}

#[derive(Debug, Deserialize)]
struct GdkEntry {
    version: String,
    #[serde(default)]
    urls: Vec<String>,
    #[serde(default, alias = "MD5")]
    md5: Option<String>,
}

pub async fn list_versions(state: &AppState) -> AppResult<Vec<MinecraftVersionSummary>> {
    let registered_store_packages = bedrock_runtime::registered_store_packages()
        .await
        .unwrap_or_default();
    let mut versions = match load_catalog(state).await {
        Ok(catalog) => catalog
            .into_iter()
            .map(|version| version.summary)
            .collect::<Vec<_>>(),
        Err(error) if !registered_store_packages.is_empty() => {
            tracing::warn!(
                error = %error,
                "Bedrock catalog is unavailable; showing registered Store packages only"
            );
            Vec::new()
        }
        Err(error) => return Err(error),
    };
    for summary in &mut versions {
        if mark_registered_store_summary(summary, &registered_store_packages) {
            continue;
        }
    }
    for registered in registered_store_summaries(&registered_store_packages) {
        if !versions
            .iter()
            .any(|version| version.id == registered.id && version.channel == registered.channel)
        {
            versions.push(registered);
        }
    }

    let instances = database::instances(&state.database).await?;
    for summary in &mut versions {
        if summary.install_method.as_deref() == Some("registered_store") {
            continue;
        }
        for instance in instances.iter().filter(|instance| {
            instance.loader_type == "bedrock" && instance.minecraft_version == summary.id
        }) {
            let Some(root) = PathBuf::from(&instance.game_dir)
                .parent()
                .map(PathBuf::from)
            else {
                continue;
            };
            let version_root = root.join("bedrock").join(&summary.id);
            if let Ok(bytes) = tokio::fs::read(version_root.join("runtime.json")).await
                && let Ok(metadata) =
                    serde_json::from_slice::<bedrock_runtime::BedrockPackageMetadata>(&bytes)
            {
                summary.status = Some(
                    if metadata.launch_ready {
                        "launchable"
                    } else if metadata.status == "failed" || metadata.status == "unavailable" {
                        "failed"
                    } else {
                        "downloaded"
                    }
                    .into(),
                );
                summary.install_reason = metadata.reason;
                break;
            }
            if ["appx", "msix", "msixvc"].iter().any(|extension| {
                version_root
                    .join(format!("MinecraftBedrock.{extension}"))
                    .is_file()
            }) {
                summary.status = Some("downloaded".into());
                break;
            }
        }
    }
    versions.sort_by(|left, right| version_cmp(&right.id, &left.id));
    Ok(versions)
}

fn registered_store_summaries(
    packages: &[bedrock_runtime::BedrockInstalledPackage],
) -> Vec<MinecraftVersionSummary> {
    let mut summaries = packages
        .iter()
        .filter(|package| bedrock_runtime::is_registered_store_package(package))
        .map(|package| {
            let channel = if package.channel == "preview" {
                "preview"
            } else {
                "release"
            };
            MinecraftVersionSummary {
                id: bedrock_runtime::display_store_version(&package.version),
                version_type: if channel == "preview" {
                    "snapshot".into()
                } else {
                    "release".into()
                },
                release_time: String::new(),
                url: String::new(),
                sha1: String::new(),
                mirrors: Vec::new(),
                md5: None,
                size_bytes: None,
                package_type: Some(
                    if package.name.eq_ignore_ascii_case("Microsoft.MinecraftUWP") {
                        "uwp".into()
                    } else {
                        "gdk".into()
                    },
                ),
                install_method: Some("registered_store".into()),
                package_family_name: Some(package.package_family_name.clone()),
                channel: Some(channel.into()),
                architecture: Some(bedrock_runtime::current_architecture()),
                installability: Some("registered".into()),
                install_reason: Some(format!(
                    "Microsoft Store already registered version {}. SLH will launch it directly.",
                    package.version
                )),
                status: Some("launchable".into()),
            }
        })
        .collect::<Vec<_>>();
    // Prefer the normal release over Preview, then use the newest package.
    summaries.sort_by(|left, right| {
        let left_release = left.channel.as_deref() == Some("release");
        let right_release = right.channel.as_deref() == Some("release");
        right_release
            .cmp(&left_release)
            .then_with(|| version_cmp(&right.id, &left.id))
    });
    summaries.dedup_by(|left, right| {
        left.package_family_name == right.package_family_name && left.id == right.id
    });
    summaries
}

fn mark_registered_store_summary(
    summary: &mut MinecraftVersionSummary,
    packages: &[bedrock_runtime::BedrockInstalledPackage],
) -> bool {
    let channel = summary.channel.as_deref().unwrap_or_else(|| {
        if summary.version_type == "snapshot" {
            "preview"
        } else {
            "release"
        }
    });
    let Some(package) = packages.iter().find(|package| {
        package.channel == channel
            && package.app_user_model_id.is_some()
            && package
                .signature_kind
                .as_deref()
                .is_some_and(|kind| kind.eq_ignore_ascii_case("Store"))
            && summary
                .package_family_name
                .as_deref()
                .is_none_or(|expected| package.package_family_name.eq_ignore_ascii_case(expected))
            && (summary.id == bedrock_runtime::display_store_version(&package.version)
                || bedrock_runtime::versions_match(&summary.id, &package.version))
    }) else {
        return false;
    };
    summary.install_method = Some("registered_store".into());
    summary.package_family_name = Some(package.package_family_name.clone());
    summary.architecture = Some(bedrock_runtime::current_architecture());
    summary.installability = Some("registered".into());
    summary.status = Some("launchable".into());
    summary.install_reason = Some(format!(
        "Microsoft Store already registered version {}. SLH will use it without downloading or enabling Developer Mode.",
        package.version
    ));
    true
}

pub async fn install_instance(
    app: &Host,
    state: &AppState,
    instance: &Instance,
    operation_id: &str,
    requested_mirror: Option<&str>,
) -> AppResult<BedrockInstallOutcome> {
    if bedrock_runtime::current_architecture() != "x64" {
        return Err(AppError::Unavailable(
            "Полная установка Bedrock поддерживается только в Windows x64; эта сборка SLH остаётся Java-only на x86/ARM.".into(),
        ));
    }
    let instance_root = PathBuf::from(&instance.game_dir)
        .parent()
        .ok_or_else(|| AppError::InvalidInput("Instance game directory has no parent".into()))?
        .to_path_buf();
    let version_root = instance_root
        .join("bedrock")
        .join(&instance.minecraft_version);
    if let Some(metadata) =
        bedrock_runtime::adopt_registered_store_package(instance, &version_root).await?
    {
        emit_progress(
            app,
            operation_id,
            &instance.id,
            "complete",
            "Official Store package is already registered",
            1,
            Some(1),
        );
        return Ok(BedrockInstallOutcome {
            launchable: metadata.launch_ready,
            reason: metadata.reason,
        });
    }

    let version = load_catalog(state)
        .await?
        .into_iter()
        .find(|version| version.summary.id == instance.minecraft_version)
        .ok_or_else(|| AppError::NotFound(format!("Bedrock {}", instance.minecraft_version)))?;

    let package_type = match &version.source {
        PackageSource::NativeMsixvc { .. } => "gdk",
        PackageSource::Uwp { .. } => "uwp",
    };
    let install_method = match &version.source {
        PackageSource::NativeMsixvc { .. } => "native_msixvc",
        PackageSource::Uwp { .. } => "windows_update",
    };
    let expected_family_name = match &version.source {
        PackageSource::NativeMsixvc {
            package_family_name,
            ..
        } => Some(package_family_name.as_str()),
        PackageSource::Uwp { .. } => None,
    };
    let channel = if version.summary.version_type == "snapshot" {
        "preview"
    } else {
        "release"
    };

    let store_binding = match &version.source {
        PackageSource::NativeMsixvc { .. } => {
            Some(bedrock_runtime::ensure_store_account_preflight(app, state, channel, true).await?)
        }
        PackageSource::Uwp { .. } => {
            // Signed UWP packages do not use loose-file registration, but
            // they still need the licensed Windows Store/Xbox identity. Do
            // this before downloading so an account problem cannot leave a
            // large, unusable package behind.
            bedrock_runtime::ensure_store_account_preflight(app, state, channel, false).await?;
            None
        }
    };

    let extension = match &version.source {
        PackageSource::NativeMsixvc { .. } => "msixvc",
        PackageSource::Uwp { .. } => "appx",
    };
    let package_path = version_root.join(format!("MinecraftBedrock.{extension}"));
    let cached_metadata = tokio::fs::metadata(&package_path).await.ok();
    let cached_valid = if let Some(metadata) = &cached_metadata {
        if !metadata.is_file() || metadata.len() == 0 {
            false
        } else {
            let package_valid = match &version.source {
                PackageSource::NativeMsixvc { md5, .. } => match md5 {
                    Some(expected) => download::verify_md5(&package_path, expected).await?,
                    None => false,
                },
                PackageSource::Uwp { .. } => {
                    bedrock_runtime::is_valid_downloaded_uwp_package(&package_path)
                }
            };
            if !package_valid {
                tracing::warn!(
                    path = %package_path.display(),
                    "Discarding an invalid cached Bedrock package before retrying"
                );
                let _ = tokio::fs::remove_file(&package_path).await;
            }
            package_valid
        }
    } else {
        false
    };
    let downloaded = if cached_valid {
        let bytes = cached_metadata
            .map(|metadata| metadata.len())
            .unwrap_or_default();
        emit_progress(
            app,
            operation_id,
            &instance.id,
            "bedrock",
            "Using the downloaded and MD5-verified Minecraft Bedrock package",
            bytes,
            Some(bytes),
        );
        bytes
    } else {
        let mirrors = match &version.source {
            PackageSource::NativeMsixvc { mirrors, .. } => {
                order_mirrors_for_download(mirrors, requested_mirror).await?
            }
            PackageSource::Uwp { update_id } => {
                vec![resolve_uwp_package_url(state, update_id).await?]
            }
        };
        let checksum = match &version.source {
            PackageSource::NativeMsixvc { md5, .. } => md5.clone(),
            PackageSource::Uwp { .. } => None,
        };
        let download_client = microsoft_download_client()?;
        let progress_app = app.clone();
        let progress_operation = operation_id.to_owned();
        let progress_instance = instance.id.clone();
        emit_progress(
            app,
            operation_id,
            &instance.id,
            "metadata",
            "Resolving Microsoft package",
            0,
            None,
        );
        download_from_mirrors(
            &download_client,
            &mirrors,
            checksum.as_deref(),
            &package_path,
            move |completed, content_length, mirror| {
                let _ = progress_app.emit(
                    crate::host::EventKind::OperationProgress,
                    ProgressEvent {
                        operation_id: progress_operation.clone(),
                        instance_id: Some(progress_instance.clone()),
                        operation: "install".into(),
                        stage: "bedrock".into(),
                        message: format!("Downloading Minecraft Bedrock package from {mirror}"),
                        completed,
                        total: content_length,
                        downloaded_bytes: Some(completed),
                        total_bytes: content_length,
                    },
                );
            },
        )
        .await?
    };
    tokio::fs::create_dir_all(&version_root).await?;
    emit_progress(
        app,
        operation_id,
        &instance.id,
        "verification",
        "Verified Bedrock package MD5",
        downloaded,
        Some(downloaded),
    );
    let metadata = bedrock_runtime::deploy_downloaded_package(
        app,
        state,
        instance,
        package_type,
        install_method,
        channel,
        expected_family_name,
        &package_path,
        store_binding.as_ref().map(|binding| binding.xuid.as_str()),
    )
    .await?;
    bedrock_runtime::write_download_metadata(&version_root, &metadata).await?;
    let (stage, message) = if metadata.launch_ready {
        ("registered", "Bedrock package registered".to_owned())
    } else {
        (
            "failed",
            metadata.reason.clone().unwrap_or_else(|| {
                "Bedrock package is downloaded but Windows deployment is still required.".into()
            }),
        )
    };
    emit_progress(app, operation_id, &instance.id, stage, &message, 1, Some(1));
    tracing::info!(
        instance_id = %instance.id,
        version = %instance.minecraft_version,
        package_type,
        downloaded_bytes = downloaded,
        launchable = metadata.launch_ready,
        "Bedrock package deployment checked"
    );
    Ok(BedrockInstallOutcome {
        launchable: metadata.launch_ready,
        reason: metadata.reason,
    })
}

async fn load_catalog(state: &AppState) -> AppResult<Vec<BedrockVersion>> {
    let (gdk, uwp) = tokio::join!(
        fetch_gdk_catalog(state),
        fetch_cached(state, UWP_CATALOG_URL, "uwp-catalog.json"),
    );
    let gdk = gdk?;
    let uwp = uwp?;
    let mut versions = Vec::new();
    let mut seen = HashSet::new();

    let gdk_catalog: GdkCatalog = serde_json::from_slice(&gdk)?;
    for (entries, version_type) in [
        (gdk_catalog.release_versions, "release"),
        (gdk_catalog.preview_versions, "snapshot"),
    ] {
        for entry in entries {
            let id = normalize_version(&entry.version);
            let mirrors = normalize_gdk_mirrors(&entry.urls);
            let Some(url) = mirrors.first().cloned() else {
                continue;
            };
            let Some(identity) = classify_msixvc_mirrors(&mirrors) else {
                tracing::warn!(version = %id, "ignoring Bedrock catalogue entry without a supported x64 MSIXVC identity");
                continue;
            };
            if id.is_empty() || !seen.insert(id.clone()) {
                continue;
            }
            let Some(md5) = normalize_md5(entry.md5.as_deref()) else {
                tracing::warn!(version = %id, "ignoring Bedrock MSIXVC entry without a valid MD5 checksum");
                continue;
            };
            versions.push(BedrockVersion {
                summary: MinecraftVersionSummary {
                    id,
                    version_type: version_type.into(),
                    release_time: String::new(),
                    url: url.clone(),
                    sha1: String::new(),
                    mirrors: mirrors.clone(),
                    md5: Some(md5.clone()),
                    size_bytes: None,
                    package_type: Some("gdk".into()),
                    install_method: Some("native_msixvc".into()),
                    package_family_name: Some(identity.package_family_name.clone()),
                    channel: Some(
                        if version_type == "release" {
                            "release"
                        } else {
                            "preview"
                        }
                        .into(),
                    ),
                    architecture: Some(identity.architecture.clone()),
                    installability: Some("downloadable".into()),
                    install_reason: None,
                    status: Some("available".into()),
                },
                source: PackageSource::NativeMsixvc {
                    mirrors,
                    md5: Some(md5),
                    package_family_name: identity.package_family_name,
                },
            });
        }
    }

    let records: Vec<serde_json::Value> = serde_json::from_slice(&uwp)?;
    for record in records {
        let Some(values) = record.as_array() else {
            continue;
        };
        let Some(id) = values.first().and_then(serde_json::Value::as_str) else {
            continue;
        };
        let Some(update_id) = values.get(1).and_then(serde_json::Value::as_str) else {
            continue;
        };
        let preview = values
            .get(2)
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0)
            != 0;
        if id.is_empty() || !seen.insert(id.to_owned()) {
            continue;
        }
        versions.push(BedrockVersion {
            summary: MinecraftVersionSummary {
                id: id.to_owned(),
                version_type: if preview { "snapshot" } else { "release" }.into(),
                release_time: String::new(),
                url: String::new(),
                sha1: String::new(),
                mirrors: Vec::new(),
                md5: None,
                size_bytes: None,
                package_type: Some("uwp".into()),
                install_method: Some("windows_update".into()),
                package_family_name: None,
                channel: Some(if preview { "preview" } else { "release" }.into()),
                architecture: Some("bundle".into()),
                installability: Some("downloadable".into()),
                install_reason: None,
                status: Some("available".into()),
            },
            source: PackageSource::Uwp {
                update_id: update_id.to_owned(),
            },
        });
    }

    versions.sort_by(|left, right| version_cmp(&right.summary.id, &left.summary.id));
    Ok(versions)
}

async fn fetch_gdk_catalog(state: &AppState) -> AppResult<Vec<u8>> {
    // Use a versioned cache name so an older SLH build cannot silently serve
    // its two-mirror catalogue after the launcher has switched to LiteLDev.
    let cache_path = state
        .paths
        .cache
        .join("bedrock")
        .join("gdk-catalog-lite.json");
    if let Ok(metadata) = tokio::fs::metadata(&cache_path).await {
        let fresh = metadata
            .modified()
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age.as_secs() < CATALOG_CACHE_TTL_SECS);
        if fresh {
            if let Ok(bytes) = tokio::fs::read(&cache_path).await {
                if serde_json::from_slice::<GdkCatalog>(&bytes).is_ok() {
                    return Ok(bytes);
                }
            }
        }
    }

    let mut last_error = None;
    for url in [GDK_CATALOG_URL, GDK_CATALOG_FALLBACK_URL] {
        match state.http.get(url).send().await {
            Ok(response) => match response.error_for_status() {
                Ok(response) => match response.bytes().await {
                    Ok(bytes) if serde_json::from_slice::<GdkCatalog>(&bytes).is_ok() => {
                        if let Some(parent) = cache_path.parent() {
                            tokio::fs::create_dir_all(parent).await?;
                        }
                        tokio::fs::write(&cache_path, &bytes).await?;
                        return Ok(bytes.to_vec());
                    }
                    Ok(_) => {
                        last_error = Some(format!("Invalid GDK catalogue received from {url}"));
                    }
                    Err(error) => last_error = Some(error.to_string()),
                },
                Err(error) => last_error = Some(error.to_string()),
            },
            Err(error) => last_error = Some(error.to_string()),
        }
    }

    if cache_path.is_file() {
        let bytes = tokio::fs::read(&cache_path).await?;
        if serde_json::from_slice::<GdkCatalog>(&bytes).is_ok() {
            tracing::warn!("using stale cached Bedrock GDK catalogue");
            return Ok(bytes);
        }
    }
    Err(AppError::Unavailable(last_error.unwrap_or_else(|| {
        "Bedrock GDK catalogue is unavailable".into()
    })))
}

async fn fetch_cached(state: &AppState, url: &str, name: &str) -> AppResult<Vec<u8>> {
    let cache_path = state.paths.cache.join("bedrock").join(name);
    if let Ok(metadata) = tokio::fs::metadata(&cache_path).await {
        let fresh = metadata
            .modified()
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age.as_secs() < CATALOG_CACHE_TTL_SECS);
        if fresh {
            if let Ok(bytes) = tokio::fs::read(&cache_path).await {
                return Ok(bytes);
            }
        }
    }
    let response = state.http.get(url).send().await;
    match response {
        Ok(response) => {
            let bytes = response.error_for_status()?.bytes().await?.to_vec();
            if let Some(parent) = cache_path.parent() {
                tokio::fs::create_dir_all(parent).await?;
            }
            tokio::fs::write(&cache_path, &bytes).await?;
            Ok(bytes)
        }
        Err(error) if cache_path.is_file() => {
            tracing::warn!(%error, url, "using cached Bedrock version catalogue");
            Ok(tokio::fs::read(cache_path).await?)
        }
        Err(error) => Err(error.into()),
    }
}

fn normalize_gdk_mirrors(urls: &[String]) -> Vec<String> {
    let mut mirrors = Vec::new();
    for raw in urls {
        let Ok(url) = secure_microsoft_url(raw) else {
            continue;
        };
        if !mirrors.contains(&url) {
            mirrors.push(url);
        }
    }
    mirrors
}

/// The historical GDK catalogue contains retail MSIXVCs whose filename can
/// say `Microsoft.MinecraftUWP`. The filename, not the catalogue name, is the
/// authoritative deployment identity. Only the two supported retail package
/// families and x64 architecture are allowed into the native extraction path.
fn classify_msixvc_url(raw: &str) -> Option<MsixvcIdentity> {
    let parsed = url::Url::parse(raw).ok()?;
    let filename = parsed.path_segments()?.last()?.to_ascii_lowercase();
    if !filename.ends_with(".msixvc") {
        return None;
    }
    let (package_family_name, package_prefix) = if filename.starts_with("microsoft.minecraftuwp_") {
        (
            "Microsoft.MinecraftUWP_8wekyb3d8bbwe",
            "microsoft.minecraftuwp_",
        )
    } else if filename.starts_with("microsoft.minecraftwindowsbeta_") {
        (
            "Microsoft.MinecraftWindowsBeta_8wekyb3d8bbwe",
            "microsoft.minecraftwindowsbeta_",
        )
    } else {
        return None;
    };
    if !filename.contains("_x64__8wekyb3d8bbwe.msixvc") || !filename.starts_with(package_prefix) {
        return None;
    }
    Some(MsixvcIdentity {
        package_family_name: package_family_name.into(),
        architecture: "x64".into(),
    })
}

fn classify_msixvc_mirrors(mirrors: &[String]) -> Option<MsixvcIdentity> {
    let first = mirrors
        .first()
        .and_then(|mirror| classify_msixvc_url(mirror))?;
    mirrors
        .iter()
        .all(|mirror| {
            classify_msixvc_url(mirror).is_some_and(|identity| {
                identity.package_family_name == first.package_family_name
                    && identity.architecture == first.architecture
            })
        })
        .then_some(first)
}

fn normalize_md5(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    (value.len() == 32 && value.chars().all(|character| character.is_ascii_hexdigit()))
        .then(|| value.to_ascii_lowercase())
}

pub async fn test_mirrors(
    state: &AppState,
    version_id: &str,
    timeout_ms: Option<u64>,
) -> AppResult<Vec<BedrockMirrorProbe>> {
    let version = load_catalog(state)
        .await?
        .into_iter()
        .find(|version| version.summary.id == version_id)
        .ok_or_else(|| AppError::NotFound(format!("Bedrock {version_id}")))?;
    let PackageSource::NativeMsixvc { mirrors, .. } = version.source else {
        return Err(AppError::Unavailable(
            "This legacy UWP version uses Microsoft Update delivery and has no mirror list.".into(),
        ));
    };
    probe_mirrors(&mirrors, timeout_ms.unwrap_or(MIRROR_PROBE_TIMEOUT_MS)).await
}

async fn order_mirrors_for_download(
    mirrors: &[String],
    requested_mirror: Option<&str>,
) -> AppResult<Vec<String>> {
    if mirrors.is_empty() {
        return Err(AppError::NotFound(
            "No official Bedrock download mirrors are available".into(),
        ));
    }
    if let Some(requested) = requested_mirror {
        let requested = secure_microsoft_url(requested)?;
        if !mirrors.iter().any(|mirror| mirror == &requested) {
            return Err(AppError::Security(
                "The selected Bedrock mirror is not part of the official catalogue".into(),
            ));
        }
        let mut ordered = vec![requested.clone()];
        ordered.extend(
            mirrors
                .iter()
                .filter(|mirror| *mirror != &requested)
                .cloned(),
        );
        return Ok(ordered);
    }

    let probes = probe_mirrors(mirrors, MIRROR_PROBE_TIMEOUT_MS).await?;
    let mut healthy = probes.iter().filter(|probe| probe.ok).collect::<Vec<_>>();
    healthy.sort_by_key(|probe| probe.latency_ms.unwrap_or(u64::MAX));
    let mut ordered = healthy
        .into_iter()
        .map(|probe| probe.url.clone())
        .collect::<Vec<_>>();
    for mirror in mirrors {
        if !ordered.iter().any(|selected| selected == mirror) {
            ordered.push(mirror.clone());
        }
    }
    Ok(ordered)
}

async fn probe_mirrors(urls: &[String], timeout_ms: u64) -> AppResult<Vec<BedrockMirrorProbe>> {
    let client = mirror_probe_client(timeout_ms)?;
    let probes = join_all(urls.iter().cloned().map(|url| {
        let client = client.clone();
        async move { probe_mirror(&client, url).await }
    }))
    .await;
    Ok(probes)
}

async fn probe_mirror(client: &reqwest::Client, url: String) -> BedrockMirrorProbe {
    let parsed = match url::Url::parse(&url) {
        Ok(parsed) => parsed,
        Err(error) => {
            return BedrockMirrorProbe {
                url,
                host: String::new(),
                latency_ms: None,
                ok: false,
                status: None,
                content_length: None,
                error: Some(format!("Invalid URL: {error}")),
            };
        }
    };
    let host = parsed.host_str().unwrap_or_default().to_owned();
    let started = Instant::now();
    let response = match client.head(&url).send().await {
        Ok(response)
            if response.status().is_success()
                || matches!(
                    response.status(),
                    reqwest::StatusCode::METHOD_NOT_ALLOWED
                        | reqwest::StatusCode::NOT_IMPLEMENTED
                        | reqwest::StatusCode::FORBIDDEN
                ) =>
        {
            if response.status().is_success() {
                Ok(response)
            } else {
                client
                    .get(&url)
                    .header(reqwest::header::RANGE, "bytes=0-0")
                    .send()
                    .await
            }
        }
        Ok(response) => {
            return BedrockMirrorProbe {
                url,
                host,
                latency_ms: Some(started.elapsed().as_millis() as u64),
                ok: false,
                status: Some(response.status().as_u16()),
                content_length: None,
                error: Some(format!("HTTP {}", response.status())),
            };
        }
        Err(error) => Err(error),
    };
    let latency_ms = Some(started.elapsed().as_millis() as u64);
    match response {
        Ok(response) if response.status().is_success() => {
            let content_length = response
                .headers()
                .get(reqwest::header::CONTENT_RANGE)
                .and_then(|value| value.to_str().ok())
                .and_then(parse_content_range_total)
                .or_else(|| response.content_length());
            BedrockMirrorProbe {
                url,
                host,
                latency_ms,
                ok: true,
                status: Some(response.status().as_u16()),
                content_length,
                error: None,
            }
        }
        Ok(response) => BedrockMirrorProbe {
            url,
            host,
            latency_ms,
            ok: false,
            status: Some(response.status().as_u16()),
            content_length: None,
            error: Some(format!("HTTP {}", response.status())),
        },
        Err(error) => BedrockMirrorProbe {
            url,
            host,
            latency_ms,
            ok: false,
            status: None,
            content_length: None,
            error: Some(error.to_string()),
        },
    }
}

fn parse_content_range_total(value: &str) -> Option<u64> {
    value.split_once('/')?.1.parse().ok()
}

fn mirror_probe_client(timeout_ms: u64) -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent("SLH/0.1.2 (portable Minecraft launcher)")
        .connect_timeout(Duration::from_millis(timeout_ms.min(60_000)))
        .timeout(Duration::from_millis(timeout_ms.max(1_000)))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let url = attempt.url();
            if matches!(url.scheme(), "http" | "https")
                && url
                    .host_str()
                    .is_some_and(|host| is_microsoft_package_host(&host.to_ascii_lowercase()))
            {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .build()
        .map_err(AppError::Network)
}

async fn download_from_mirrors<F>(
    client: &reqwest::Client,
    mirrors: &[String],
    md5: Option<&str>,
    destination: &std::path::Path,
    mut on_progress: F,
) -> AppResult<u64>
where
    F: FnMut(u64, Option<u64>, &str) + Send,
{
    let mut failures = Vec::new();
    for mirror in mirrors {
        let host = url::Url::parse(mirror)
            .ok()
            .and_then(|url| url.host_str().map(str::to_owned))
            .unwrap_or_else(|| "unknown mirror".into());
        match download_resumable_verified_with_progress(
            client,
            &ResumableDownloadPlan {
                url: mirror.clone(),
                destination: destination.to_path_buf(),
                md5: md5.map(str::to_owned),
                max_bytes: Some(MAX_BEDROCK_PACKAGE_BYTES),
            },
            |completed, total| on_progress(completed, total, &host),
        )
        .await
        {
            Ok(bytes) => return Ok(bytes),
            Err(error) => {
                tracing::warn!(mirror = %host, %error, "Bedrock mirror download failed");
                failures.push(format!("{host}: {error}"));
            }
        }
    }
    Err(AppError::Unavailable(format!(
        "All official Bedrock download mirrors failed: {}",
        failures.join("; ")
    )))
}

async fn resolve_uwp_package_url(state: &AppState, update_id: &str) -> AppResult<String> {
    let endpoints = [
        MICROSOFT_UPDATE_SERVICE_URL,
        MICROSOFT_UPDATE_SERVICE_FALLBACK_URL,
    ];
    let mut last_status = None;
    let mut last_error = None;
    let mut response_text = None;

    'endpoints: for endpoint in endpoints {
        let xml = build_uwp_request_xml(update_id, endpoint);
        for attempt in 0..3_u32 {
            match state
                .http
                .post(endpoint)
                .header(
                    reqwest::header::CONTENT_TYPE,
                    "application/soap+xml; charset=utf-8",
                )
                .body(xml.clone())
                .send()
                .await
            {
                Ok(response) if response.status().is_success() => {
                    response_text = Some(response.text().await?);
                    break 'endpoints;
                }
                Ok(response) => {
                    let status = response.status();
                    last_status = Some(status.to_string());
                    let body = response.text().await.unwrap_or_default();
                    tracing::warn!(
                        endpoint,
                        attempt = attempt + 1,
                        %status,
                        response = %body.chars().take(256).collect::<String>(),
                        "Microsoft Bedrock package lookup failed"
                    );
                    let retryable = status.is_server_error()
                        || status == reqwest::StatusCode::TOO_MANY_REQUESTS
                        || status == reqwest::StatusCode::REQUEST_TIMEOUT;
                    if !retryable {
                        break;
                    }
                }
                Err(error) => {
                    last_error = Some(error.to_string());
                    tracing::warn!(endpoint, attempt = attempt + 1, %error, "Microsoft Bedrock package lookup request failed");
                }
            }
            if attempt < 2 {
                tokio::time::sleep(std::time::Duration::from_millis(300 * (1_u64 << attempt)))
                    .await;
            }
        }
    }

    let response = response_text.ok_or_else(|| {
        let detail = last_status
            .map(|status| format!("HTTP {status}"))
            .or(last_error)
            .unwrap_or_else(|| "no response".into());
        AppError::Unavailable(format!(
            "Microsoft package service did not return a URL for Bedrock update {update_id} ({detail})"
        ))
    })?;
    select_uwp_package_url(&response)
}

fn select_uwp_package_url(response: &str) -> AppResult<String> {
    let location_pattern = Regex::new(
        r"(?is)<(?:[A-Za-z0-9_.-]+:)?FileLocation\b[^>]*>(.*?)</(?:[A-Za-z0-9_.-]+:)?FileLocation>",
    )
    .expect("FileLocation expression is valid");
    let url_pattern =
        Regex::new(r"(?is)<(?:[A-Za-z0-9_.-]+:)?Url(?:\s[^>]*)?>(.*?)</(?:[A-Za-z0-9_.-]+:)?Url>")
            .expect("URL expression is valid");

    let mut candidates = Vec::new();
    for location in location_pattern.captures_iter(response) {
        let Some(body) = location.get(1) else {
            continue;
        };
        let Some(url_match) = url_pattern.captures(body.as_str()) else {
            continue;
        };
        let Some(raw_url) = url_match.get(1) else {
            continue;
        };
        let raw_url = decode_xml_entities(raw_url.as_str().trim());
        let Ok(url) = secure_microsoft_url(&raw_url) else {
            continue;
        };
        let score = uwp_package_url_score(&url);
        if score >= 0 {
            candidates.push((score, url));
        }
    }

    candidates
        .into_iter()
        .max_by_key(|(score, url)| (*score, url.len()))
        .map(|(_, url)| url)
        .ok_or_else(|| AppError::NotFound("Microsoft Bedrock package URL".into()))
}

fn uwp_package_url_score(raw_url: &str) -> i32 {
    let lower = raw_url.to_ascii_lowercase();
    if lower.contains("blockmap") || lower.contains("pieces") || lower.contains(".psf") {
        return -1;
    }
    if lower.contains(".appx") || lower.contains(".msix") {
        return 100;
    }
    if lower.contains("appxbundle") || lower.contains("msixbundle") {
        return 100;
    }
    0
}

fn build_uwp_request_xml(update_id: &str, endpoint: &str) -> String {
    let now = Utc::now();
    let expires = now + chrono::Duration::minutes(5);
    let message_id = format!("urn:uuid:{}", Uuid::new_v4());
    format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://www.w3.org/2005/08/addressing">
  <s:Header>
    <a:Action s:mustUnderstand="1">http://www.microsoft.com/SoftwareDistribution/Server/ClientWebService/GetExtendedUpdateInfo2</a:Action>
    <a:MessageID>{message_id}</a:MessageID>
    <a:To s:mustUnderstand="1">{endpoint}</a:To>
    <o:Security s:mustUnderstand="1" xmlns:o="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">
      <Timestamp xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">
        <Created>{}</Created><Expires>{}</Expires>
      </Timestamp>
      <wuws:WindowsUpdateTicketsToken wsu:id="ClientMSA" xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd" xmlns:wuws="http://schemas.microsoft.com/msus/2014/10/WindowsUpdateAuthorization">
        <TicketType Name="AAD" Version="1.0" Policy="MBI_SSL" />
      </wuws:WindowsUpdateTicketsToken>
    </o:Security>
  </s:Header>
  <s:Body>
    <GetExtendedUpdateInfo2 xmlns="http://www.microsoft.com/SoftwareDistribution/Server/ClientWebService">
      <updateIDs><UpdateIdentity><UpdateID>{}</UpdateID><RevisionNumber>1</RevisionNumber></UpdateIdentity></updateIDs>
      <infoTypes><XmlUpdateFragmentType>FileUrl</XmlUpdateFragmentType></infoTypes>
      <deviceAttributes>{}</deviceAttributes>
    </GetExtendedUpdateInfo2>
  </s:Body>
</s:Envelope>"#,
        now.to_rfc3339_opts(SecondsFormat::Millis, true),
        expires.to_rfc3339_opts(SecondsFormat::Millis, true),
        xml_escape(update_id),
        xml_escape(&device_attributes()),
    )
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn decode_xml_entities(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

fn device_attributes() -> String {
    let architecture = bedrock_runtime::current_architecture();
    let os_architecture = if architecture == "x86" {
        "X86"
    } else {
        "AMD64"
    };
    DEVICE_ATTRIBUTES.replace(
        "OSArchitecture=AMD64",
        &format!("OSArchitecture={os_architecture}"),
    )
}

fn secure_microsoft_url(raw: &str) -> AppResult<String> {
    let url = url::Url::parse(raw)
        .map_err(|error| AppError::InvalidInput(format!("Invalid Bedrock package URL: {error}")))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(AppError::Security(
            "Bedrock package URL must use HTTP or HTTPS".into(),
        ));
    }
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    if !is_microsoft_package_host(&host) {
        return Err(AppError::Security(format!(
            "Untrusted Bedrock package host: {host}"
        )));
    }
    // The current Microsoft package catalogue advertises these CDN objects
    // over HTTP and the corresponding HTTPS endpoint returns 421. Keep the
    // exact host allow-list above; do not accept arbitrary HTTP redirects.
    Ok(url.to_string())
}

fn is_microsoft_package_host(host: &str) -> bool {
    matches!(
        host,
        "assets1.xboxlive.com"
            | "assets2.xboxlive.com"
            | "assets1.xboxlive.cn"
            | "assets2.xboxlive.cn"
            | "d1.xboxlive.com"
            | "d2.xboxlive.com"
            | "d1.xboxlive.cn"
            | "d2.xboxlive.cn"
            | "xvcf1.xboxlive.com"
            | "xvcf2.xboxlive.com"
            | "dl.delivery.mp.microsoft.com"
            | "tlu.dl.delivery.mp.microsoft.com"
    )
}

fn microsoft_download_client() -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent("SLH/0.1.2 (portable Minecraft launcher)")
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(6 * 60 * 60))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let url = attempt.url();
            if matches!(url.scheme(), "http" | "https")
                && url
                    .host_str()
                    .is_some_and(|host| is_microsoft_package_host(&host.to_ascii_lowercase()))
            {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .build()
        .map_err(AppError::Network)
}

fn normalize_version(value: &str) -> String {
    value
        .trim()
        .strip_prefix("Release ")
        .or_else(|| value.trim().strip_prefix("Preview "))
        .unwrap_or(value.trim())
        .to_owned()
}

fn version_cmp(left: &str, right: &str) -> Ordering {
    let left = version_key(left);
    let right = version_key(right);
    left.cmp(&right)
}

fn version_key(value: &str) -> Vec<u32> {
    value
        .split('.')
        .map(|part| {
            part.chars()
                .take_while(char::is_ascii_digit)
                .collect::<String>()
                .parse::<u32>()
                .unwrap_or(0)
        })
        .collect()
}

fn emit_progress(
    app: &Host,
    operation_id: &str,
    instance_id: &str,
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
            operation: "install".into(),
            stage: stage.into(),
            message: message.into(),
            completed,
            total,
            downloaded_bytes: None,
            total_bytes: None,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_catalog_release_prefixes() {
        assert_eq!(normalize_version("Release 26.51.01"), "26.51.01");
        assert_eq!(normalize_version("Preview 26.60.21"), "26.60.21");
        assert_eq!(normalize_version("1.21.120.20"), "1.21.120.20");
    }

    #[test]
    fn sorts_numeric_bedrock_versions() {
        assert_eq!(version_cmp("26.51.01", "26.50.04"), Ordering::Greater);
        assert_eq!(version_cmp("1.21.120.20", "1.21.9"), Ordering::Greater);
    }

    #[test]
    fn only_allows_microsoft_package_hosts() {
        for host in [
            "assets1.xboxlive.com",
            "assets2.xboxlive.com",
            "assets1.xboxlive.cn",
            "assets2.xboxlive.cn",
            "d1.xboxlive.com",
            "d2.xboxlive.com",
            "d1.xboxlive.cn",
            "d2.xboxlive.cn",
            "xvcf1.xboxlive.com",
            "xvcf2.xboxlive.com",
        ] {
            assert!(
                secure_microsoft_url(&format!("http://{host}/example/Minecraft.msixvc")).is_ok()
            );
        }
        assert!(secure_microsoft_url("http://dl.delivery.mp.microsoft.com/example.appx").is_ok());
        assert!(secure_microsoft_url("https://example.com/minecraft.msixvc").is_err());
    }

    #[test]
    fn keeps_all_valid_gdk_mirrors_and_drops_untrusted_urls() {
        let mirrors = normalize_gdk_mirrors(&[
            "http://assets1.xboxlive.com/file.msixvc".into(),
            "http://assets2.xboxlive.com/file.msixvc".into(),
            "http://xvcf1.xboxlive.com/file.msixvc".into(),
            "https://example.invalid/file.msixvc".into(),
            "http://assets1.xboxlive.com/file.msixvc".into(),
        ]);
        assert_eq!(mirrors.len(), 3);
        assert!(
            mirrors
                .iter()
                .all(|mirror| !mirror.contains("example.invalid"))
        );
    }

    #[test]
    fn accepts_only_real_md5_values_from_catalogue() {
        assert_eq!(
            normalize_md5(Some("5EB63BBBE01EEED093CB22BB8F5ACDC3")),
            Some("5eb63bbbe01eeed093cb22bb8f5acdc3".into()),
        );
        assert_eq!(normalize_md5(Some("not-a-checksum")), None);
        assert_eq!(normalize_md5(None), None);
    }

    #[test]
    fn classifies_1265101_as_native_retail_msixvc() {
        let identity = classify_msixvc_url(
            "https://assets1.xboxlive.com/file/Microsoft.MinecraftUWP_1.26.5101.0_x64__8wekyb3d8bbwe.msixvc",
        )
        .expect("retail MSIXVC identity");
        assert_eq!(
            identity.package_family_name,
            "Microsoft.MinecraftUWP_8wekyb3d8bbwe"
        );
        assert_eq!(identity.architecture, "x64");
    }

    #[test]
    fn prefers_a_matching_registered_store_package() {
        let mut summary = MinecraftVersionSummary {
            id: "1.26.60.24".into(),
            version_type: "snapshot".into(),
            release_time: String::new(),
            url: "https://assets1.xboxlive.com/example.msixvc".into(),
            sha1: String::new(),
            mirrors: vec!["https://assets1.xboxlive.com/example.msixvc".into()],
            md5: Some("67562f5c5b097f7a29e94f7ca70b9b5f".into()),
            size_bytes: None,
            package_type: Some("gdk".into()),
            install_method: Some("native_msixvc".into()),
            package_family_name: Some("Microsoft.MinecraftWindowsBeta_8wekyb3d8bbwe".into()),
            channel: Some("preview".into()),
            architecture: Some("x64".into()),
            installability: Some("downloadable".into()),
            install_reason: None,
            status: Some("available".into()),
        };
        let packages = vec![bedrock_runtime::BedrockInstalledPackage {
            name: "Microsoft.MinecraftWindowsBeta".into(),
            version: "1.26.6024.0".into(),
            package_family_name: "Microsoft.MinecraftWindowsBeta_8wekyb3d8bbwe".into(),
            package_full_name: "Microsoft.MinecraftWindowsBeta_1.26.6024.0_x64__8wekyb3d8bbwe"
                .into(),
            install_location: "C:\\Program Files\\WindowsApps\\MinecraftPreview".into(),
            app_user_model_id: Some("Microsoft.MinecraftWindowsBeta_8wekyb3d8bbwe!App".into()),
            channel: "preview".into(),
            signature_kind: Some("Store".into()),
        }];

        assert!(mark_registered_store_summary(&mut summary, &packages));
        assert_eq!(summary.install_method.as_deref(), Some("registered_store"));
        assert_eq!(summary.status.as_deref(), Some("launchable"));
        assert_eq!(summary.installability.as_deref(), Some("registered"));
    }

    #[test]
    fn lists_a_registered_store_package_without_loading_the_remote_catalogue() {
        let packages = vec![bedrock_runtime::BedrockInstalledPackage {
            name: "Microsoft.MinecraftUWP".into(),
            version: "1.14.2001.0".into(),
            package_family_name: "Microsoft.MinecraftUWP_8wekyb3d8bbwe".into(),
            package_full_name: "Microsoft.MinecraftUWP_1.14.2001.0_x64__8wekyb3d8bbwe".into(),
            install_location: "C:\\Program Files\\WindowsApps\\Minecraft".into(),
            app_user_model_id: Some("Microsoft.MinecraftUWP_8wekyb3d8bbwe!App".into()),
            channel: "release".into(),
            signature_kind: Some("Store".into()),
        }];

        let summaries = registered_store_summaries(&packages);
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].id, "1.14.20.1");
        assert_eq!(
            summaries[0].install_method.as_deref(),
            Some("registered_store")
        );
        assert!(summaries[0].mirrors.is_empty());
    }

    #[test]
    fn rejects_non_retail_or_mixed_msixvc_mirrors() {
        assert!(classify_msixvc_url(
            "https://assets1.xboxlive.com/file/Microsoft.MinecraftUWP_1.26.5101.0_x86__8wekyb3d8bbwe.msixvc"
        )
        .is_none());
        assert!(classify_msixvc_mirrors(&[
            "https://assets1.xboxlive.com/file/Microsoft.MinecraftUWP_1.26.5101.0_x64__8wekyb3d8bbwe.msixvc".into(),
            "https://assets2.xboxlive.com/file/Microsoft.MinecraftWindowsBeta_1.26.5101.0_x64__8wekyb3d8bbwe.msixvc".into(),
        ])
        .is_none());
    }

    #[test]
    fn selects_the_package_url_instead_of_the_block_map_url() {
        let response = r#"
            <FileLocations>
              <FileLocation>
                <Url>http://dl.delivery.mp.microsoft.com/cache/Minecraft.BlockMap.xml</Url>
              </FileLocation>
              <FileLocation>
                <Url>http://dl.delivery.mp.microsoft.com/cache/Microsoft.MinecraftUWP.appx</Url>
              </FileLocation>
            </FileLocations>
        "#;
        let selected = select_uwp_package_url(response).unwrap();
        assert!(selected.ends_with("Microsoft.MinecraftUWP.appx"));
    }

    #[test]
    fn rejects_a_response_that_only_contains_block_map_urls() {
        let response = r#"
            <FileLocations>
              <FileLocation>
                <Url>http://dl.delivery.mp.microsoft.com/cache/Minecraft.BlockMap.xml</Url>
              </FileLocation>
            </FileLocations>
        "#;
        assert!(select_uwp_package_url(response).is_err());
    }

    #[test]
    fn escapes_update_service_xml_values() {
        let xml = build_uwp_request_xml("update&id", MICROSOFT_UPDATE_SERVICE_URL);
        assert!(xml.contains("<UpdateID>update&amp;id</UpdateID>"));
        assert!(xml.contains("E:BranchReadinessLevel=CBB&amp;DchuNvidiaGrfxExists=1"));
    }
}
