use std::cmp::Ordering;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::host::Host;
use async_trait::async_trait;
use serde::Deserialize;
use tokio::process::Command;
use walkdir::WalkDir;

use crate::error::{AppError, AppResult};
use crate::minecraft::download::{
    DownloadPlan, configured_concurrency, download_many, download_verified,
};
use crate::minecraft::types::{Library, VersionArguments, VersionDetails, maven_download};
use crate::models::{Instance, LoaderVersion, ProgressEvent};
use crate::state::AppState;

#[allow(dead_code)]
#[async_trait]
pub trait LoaderProvider: Send + Sync {
    fn loader_type(&self) -> &'static str;
    async fn versions(&self, state: &AppState, minecraft: &str) -> AppResult<Vec<LoaderVersion>>;
}

#[derive(Deserialize)]
struct LoaderListEntry {
    loader: LoaderMetadata,
}

#[derive(Deserialize)]
struct LoaderMetadata {
    version: String,
    #[serde(default)]
    stable: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoaderProfile {
    id: String,
    main_class: String,
    arguments: Option<VersionArguments>,
    #[serde(default)]
    libraries: Vec<Library>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstalledLoaderProfile {
    id: String,
    inherits_from: Option<String>,
    main_class: String,
    arguments: Option<VersionArguments>,
    minecraft_arguments: Option<String>,
    java_version: Option<crate::minecraft::types::JavaVersionRequirement>,
    #[serde(default)]
    libraries: Vec<Library>,
}

pub async fn list_versions(
    state: &AppState,
    loader_type: &str,
    minecraft_version: &str,
) -> AppResult<Vec<LoaderVersion>> {
    let endpoint = match loader_type {
        "fabric" => Some(format!(
            "https://meta.fabricmc.net/v2/versions/loader/{minecraft_version}"
        )),
        "quilt" => Some(format!(
            "https://meta.quiltmc.org/v3/versions/loader/{minecraft_version}"
        )),
        "vanilla" => return Ok(Vec::new()),
        "forge" => return maven_versions(state, loader_type, minecraft_version).await,
        "neoforge" => return maven_versions(state, loader_type, minecraft_version).await,
        _ => {
            return Err(AppError::InvalidInput(format!(
                "Unknown loader type: {loader_type}"
            )));
        }
    };
    let response = state
        .http
        .get(endpoint.expect("metadata endpoint is present"))
        .send()
        .await?
        .error_for_status()?;
    let entries: Vec<LoaderListEntry> = response.json().await?;
    Ok(entries
        .into_iter()
        .enumerate()
        .map(|(index, entry)| LoaderVersion {
            id: entry.loader.version,
            stable: entry.loader.stable || loader_type == "quilt",
            recommended: index == 0,
        })
        .collect())
}

pub async fn install_profile(
    app: &Host,
    state: &AppState,
    instance: &Instance,
    operation_id: &str,
) -> AppResult<()> {
    let loader_version = instance.loader_version.as_deref().ok_or_else(|| {
        AppError::InvalidInput(format!(
            "{} loader version is required",
            instance.loader_type
        ))
    })?;
    if matches!(instance.loader_type.as_str(), "forge" | "neoforge") {
        return install_processor_profile(app, state, instance, operation_id, loader_version).await;
    }
    let profile_url = match instance.loader_type.as_str() {
        "fabric" => format!(
            "https://meta.fabricmc.net/v2/versions/loader/{}/{}/profile/json",
            instance.minecraft_version, loader_version
        ),
        "quilt" => format!(
            "https://meta.quiltmc.org/v3/versions/loader/{}/{}/profile/json",
            instance.minecraft_version, loader_version
        ),
        _ => {
            return Err(AppError::InvalidInput(format!(
                "Unknown loader type: {}",
                instance.loader_type
            )));
        }
    };
    let profile: LoaderProfile = state
        .http
        .get(profile_url)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let instance_root = PathBuf::from(&instance.game_dir)
        .parent()
        .ok_or_else(|| AppError::InvalidInput("Instance game directory has no parent".into()))?
        .to_path_buf();
    let version_path = instance_root
        .join("versions")
        .join(&instance.minecraft_version)
        .join("version.json");
    let mut details: VersionDetails =
        serde_json::from_slice(&tokio::fs::read(&version_path).await?)?;
    details.main_class = profile.main_class;
    merge_arguments(&mut details.arguments, profile.arguments);

    let libraries_root = state.paths.cache.join("minecraft").join("libraries");
    let mut libraries = Vec::with_capacity(profile.libraries.len());
    let mut plans = Vec::new();
    let mut planned_destinations = HashSet::new();
    for mut library in profile.libraries {
        if library.downloads.artifact.is_none() {
            library.downloads.artifact =
                maven_download(&library.name, library.url.as_deref(), None);
        }
        if let Some(artifact) = &library.downloads.artifact {
            let path = artifact.path.as_deref().ok_or_else(|| {
                AppError::InvalidInput(format!("Loader library {} has no path", library.name))
            })?;
            let destination = libraries_root.join(path);
            if planned_destinations.insert(destination.clone()) {
                plans.push(DownloadPlan {
                    url: artifact.url.clone(),
                    destination,
                    sha1: artifact.sha1.clone(),
                    max_bytes: None,
                });
            }
        }
        libraries.push(library);
    }
    let total = plans.len() as u64;
    let app = app.clone();
    let operation_id = operation_id.to_owned();
    let instance_id = instance.id.clone();
    let mut completed = 0_u64;
    let concurrency = configured_concurrency(&state.database).await;
    download_many(&state.http, plans, concurrency, move |_index, _bytes| {
        completed += 1;
        let _ = app.emit(
            crate::host::EventKind::OperationProgress,
            ProgressEvent {
                operation_id: operation_id.clone(),
                instance_id: Some(instance_id.clone()),
                operation: "install".into(),
                stage: "loader".into(),
                message: format!("Installing {} {}", instance.loader_type, loader_version),
                completed,
                total: Some(total),
                downloaded_bytes: None,
                total_bytes: None,
            },
        );
    })
    .await?;
    details.libraries.extend(libraries);
    tracing::info!(
        loader = %instance.loader_type,
        loader_version,
        profile_id = %profile.id,
        "loader profile installed"
    );
    tokio::fs::write(version_path, serde_json::to_vec_pretty(&details)?).await?;
    Ok(())
}

async fn maven_versions(
    state: &AppState,
    loader_type: &str,
    minecraft_version: &str,
) -> AppResult<Vec<LoaderVersion>> {
    let (metadata_url, prefix) = match loader_type {
        "forge" => (
            "https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml",
            format!("{minecraft_version}-"),
        ),
        "neoforge" => (
            "https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml",
            neoforge_prefix(minecraft_version)?,
        ),
        _ => {
            return Err(AppError::InvalidInput(
                "Expected Forge-family loader".into(),
            ));
        }
    };
    let xml = state
        .http
        .get(metadata_url)
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;
    let pattern =
        regex::Regex::new(r"<version>([^<]+)</version>").expect("Maven metadata regex is valid");
    let mut versions = pattern
        .captures_iter(&xml)
        .filter_map(|capture| capture.get(1).map(|value| value.as_str().to_owned()))
        .filter_map(|version| {
            if loader_type == "forge" {
                version.strip_prefix(&prefix).map(str::to_owned)
            } else {
                version.starts_with(&prefix).then_some(version)
            }
        })
        .collect::<Vec<_>>();
    versions.sort_by(|left, right| compare_versions(right, left));
    versions.dedup();
    let recommended = versions
        .iter()
        .find(|version| is_stable(version))
        .cloned()
        .or_else(|| versions.first().cloned());
    Ok(versions
        .into_iter()
        .take(120)
        .map(|id| LoaderVersion {
            stable: is_stable(&id),
            recommended: recommended.as_deref() == Some(id.as_str()),
            id,
        })
        .collect())
}

async fn install_processor_profile(
    app: &Host,
    state: &AppState,
    instance: &Instance,
    operation_id: &str,
    loader_version: &str,
) -> AppResult<()> {
    let (coordinate_version, installer_url) = match instance.loader_type.as_str() {
        "forge" => {
            let coordinate = format!("{}-{loader_version}", instance.minecraft_version);
            let url = format!(
                "https://maven.minecraftforge.net/net/minecraftforge/forge/{coordinate}/forge-{coordinate}-installer.jar"
            );
            (coordinate, url)
        }
        "neoforge" => {
            let url = format!(
                "https://maven.neoforged.net/releases/net/neoforged/neoforge/{loader_version}/neoforge-{loader_version}-installer.jar"
            );
            (loader_version.to_owned(), url)
        }
        _ => {
            return Err(AppError::InvalidInput(
                "Expected Forge-family loader".into(),
            ));
        }
    };
    let sha1_response = state
        .http
        .get(format!("{installer_url}.sha1"))
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;
    let expected_sha1 = sha1_response.trim();
    if expected_sha1.len() != 40
        || !expected_sha1
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err(AppError::Security(
            "Loader Maven repository returned an invalid SHA-1 sidecar".into(),
        ));
    }
    let installer = state
        .paths
        .cache
        .join("loaders")
        .join(&instance.loader_type)
        .join(&coordinate_version)
        .join("installer.jar");
    emit_loader_progress(
        app,
        operation_id,
        instance,
        "Downloading the official loader installer",
        0,
        Some(3),
    );
    download_verified(
        &state.http,
        &DownloadPlan {
            url: installer_url,
            destination: installer.clone(),
            sha1: Some(expected_sha1.to_owned()),
            max_bytes: None,
        },
    )
    .await?;
    let detected_java = crate::minecraft::java::discover_fast(state, Some(17))
        .await?
        .into_iter()
        .find(|candidate| candidate.compatible);
    let java = match detected_java {
        Some(runtime) => runtime,
        None => crate::minecraft::java::install_compatible_managed(app, state, Some(17)).await?,
    };
    let instance_root = PathBuf::from(&instance.game_dir)
        .parent()
        .ok_or_else(|| AppError::InvalidInput("Instance game directory has no parent".into()))?
        .to_path_buf();
    let launcher_profiles = instance_root.join("launcher_profiles.json");
    if !launcher_profiles.exists() {
        tokio::fs::write(&launcher_profiles, b"{\"profiles\":{},\"settings\":{}}").await?;
    }
    emit_loader_progress(
        app,
        operation_id,
        instance,
        "Running loader processors",
        1,
        Some(3),
    );
    let mut installer_command = Command::new(&java.path);
    installer_command
        .arg("-jar")
        .arg(&installer)
        .arg("--installClient")
        .arg(&instance_root)
        .current_dir(&instance_root);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        installer_command.as_std_mut().creation_flags(0x08000000);
    }
    let output = tokio::time::timeout(Duration::from_secs(600), installer_command.output())
        .await
        .map_err(|_| AppError::Process("Loader installer timed out after ten minutes".into()))??;
    let installer_log = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let log_path = instance_root
        .join("logs")
        .join(format!("{}-installer.log", instance.loader_type));
    tokio::fs::write(&log_path, crate::security::redact_secrets(&installer_log)).await?;
    if !output.status.success() {
        let summary = installer_log
            .lines()
            .rev()
            .take(12)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join(" | ");
        return Err(AppError::Process(format!(
            "{} installer failed with {}: {}",
            instance.loader_type,
            output.status,
            crate::security::redact_secrets(&summary)
        )));
    }
    emit_loader_progress(
        app,
        operation_id,
        instance,
        "Merging installed loader profile",
        2,
        Some(3),
    );
    merge_installed_profile(state, instance, &instance_root, loader_version).await?;
    copy_installer_libraries(
        &instance_root.join("libraries"),
        &state.paths.cache.join("minecraft").join("libraries"),
    )?;
    emit_loader_progress(app, operation_id, instance, "Loader is ready", 3, Some(3));
    Ok(())
}

async fn merge_installed_profile(
    state: &AppState,
    instance: &Instance,
    instance_root: &Path,
    loader_version: &str,
) -> AppResult<()> {
    let base_path = instance_root
        .join("versions")
        .join(&instance.minecraft_version)
        .join("version.json");
    let mut base: VersionDetails = serde_json::from_slice(&tokio::fs::read(&base_path).await?)?;
    let versions_root = instance_root.join("versions");
    let mut profiles = Vec::new();
    for entry in WalkDir::new(&versions_root)
        .max_depth(3)
        .follow_links(false)
    {
        let entry = entry.map_err(|error| AppError::Io(std::io::Error::other(error)))?;
        if !entry.file_type().is_file()
            || entry
                .path()
                .extension()
                .and_then(|extension| extension.to_str())
                .is_none_or(|extension| extension != "json")
            || entry.path() == base_path
        {
            continue;
        }
        let bytes = std::fs::read(entry.path())?;
        if let Ok(profile) = serde_json::from_slice::<InstalledLoaderProfile>(&bytes) {
            if profile
                .inherits_from
                .as_deref()
                .is_none_or(|parent| parent == instance.minecraft_version)
                && (profile.id.contains(loader_version)
                    || profile
                        .id
                        .to_ascii_lowercase()
                        .contains(&instance.loader_type))
            {
                profiles.push(profile);
            }
        }
    }
    let profile = profiles.into_iter().next().ok_or_else(|| {
        AppError::Process(format!(
            "{} installer completed but produced no compatible version profile",
            instance.loader_type
        ))
    })?;
    base.main_class = profile.main_class;
    merge_arguments(&mut base.arguments, profile.arguments);
    if let Some(arguments) = profile.minecraft_arguments {
        base.minecraft_arguments = Some(match base.minecraft_arguments.take() {
            Some(existing) => format!("{existing} {arguments}"),
            None => arguments,
        });
    }
    if profile.java_version.is_some() {
        base.java_version = profile.java_version;
    }
    base.libraries.extend(profile.libraries);
    tokio::fs::write(base_path, serde_json::to_vec_pretty(&base)?).await?;
    tracing::info!(loader_profile = %profile.id, "installed loader profile merged");
    let _ = state;
    Ok(())
}

fn copy_installer_libraries(source: &Path, destination: &Path) -> AppResult<()> {
    if !source.exists() {
        return Err(AppError::Process(
            "Loader installer produced no libraries directory".into(),
        ));
    }
    for entry in WalkDir::new(source).follow_links(false) {
        let entry = entry.map_err(|error| AppError::Io(std::io::Error::other(error)))?;
        if entry.file_type().is_symlink() {
            return Err(AppError::Security(format!(
                "Loader installer produced a symbolic link: {}",
                entry.path().display()
            )));
        }
        let relative = entry
            .path()
            .strip_prefix(source)
            .map_err(|_| AppError::Security("Loader library escaped its root".into()))?;
        let target = destination.join(relative);
        if entry.file_type().is_dir() {
            std::fs::create_dir_all(&target)?;
        } else if entry.file_type().is_file() {
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

fn emit_loader_progress(
    app: &Host,
    operation_id: &str,
    instance: &Instance,
    message: &str,
    completed: u64,
    total: Option<u64>,
) {
    let _ = app.emit(
        crate::host::EventKind::OperationProgress,
        ProgressEvent {
            operation_id: operation_id.into(),
            instance_id: Some(instance.id.clone()),
            operation: "install".into(),
            stage: "loader".into(),
            message: format!("{}: {message}", instance.loader_type),
            completed,
            total,
            downloaded_bytes: None,
            total_bytes: None,
        },
    );
}

fn neoforge_prefix(minecraft_version: &str) -> AppResult<String> {
    let parts = minecraft_version.split('.').collect::<Vec<_>>();
    if parts.first() != Some(&"1") {
        return Err(AppError::InvalidInput(format!(
            "NeoForge does not recognize Minecraft version {minecraft_version}"
        )));
    }
    let minor = parts
        .get(1)
        .and_then(|part| part.parse::<u32>().ok())
        .ok_or_else(|| AppError::InvalidInput("Minecraft minor version is invalid".into()))?;
    let patch = parts
        .get(2)
        .and_then(|part| part.parse::<u32>().ok())
        .unwrap_or(0);
    Ok(format!("{minor}.{patch}."))
}

fn is_stable(version: &str) -> bool {
    let lower = version.to_ascii_lowercase();
    !["alpha", "beta", "rc", "snapshot"]
        .iter()
        .any(|marker| lower.contains(marker))
}

fn compare_versions(left: &str, right: &str) -> Ordering {
    let numbers = |value: &str| {
        regex::Regex::new(r"\d+")
            .expect("version regex is valid")
            .find_iter(value)
            .filter_map(|item| item.as_str().parse::<u64>().ok())
            .collect::<Vec<_>>()
    };
    numbers(left)
        .cmp(&numbers(right))
        .then_with(|| is_stable(left).cmp(&is_stable(right)))
        .then_with(|| left.cmp(right))
}

fn merge_arguments(base: &mut Option<VersionArguments>, loader: Option<VersionArguments>) {
    let Some(loader) = loader else {
        return;
    };
    match base {
        Some(base) => {
            base.game.extend(loader.game);
            base.jvm.extend(loader.jvm);
        }
        None => *base = Some(loader),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn neoforge_versions_follow_minecraft_minor_and_patch() {
        assert_eq!(neoforge_prefix("1.21.1").unwrap(), "21.1.");
        assert_eq!(neoforge_prefix("1.21").unwrap(), "21.0.");
        assert_eq!(neoforge_prefix("1.20.4").unwrap(), "20.4.");
    }

    #[test]
    fn natural_version_sort_compares_numeric_components() {
        assert_eq!(compare_versions("21.1.10", "21.1.9"), Ordering::Greater);
        assert!(is_stable("21.1.10"));
        assert!(!is_stable("21.1.10-beta"));
    }
}
