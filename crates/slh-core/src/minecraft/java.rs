use std::collections::{BTreeSet, HashSet};
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;

use crate::host::Host;
use futures_util::StreamExt;
use regex::Regex;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use uuid::Uuid;

use crate::database;
use crate::error::{AppError, AppResult};
use crate::models::{JavaInstallation, ProgressEvent};
use crate::state::AppState;

const MAX_MANAGED_JAVA_ARCHIVE_BYTES: u64 = 16 * 1024 * 1024 * 1024;

#[derive(Deserialize)]
struct AdoptiumAsset {
    binary: AdoptiumBinary,
    version: AdoptiumVersion,
}

#[derive(Deserialize)]
struct AdoptiumBinary {
    package: AdoptiumPackage,
}

#[derive(Deserialize)]
struct AdoptiumPackage {
    checksum: String,
    link: String,
    size: u64,
}

#[derive(Deserialize)]
struct AdoptiumVersion {
    semver: String,
}

pub async fn discover(
    app: Option<&Host>,
    state: &AppState,
    required_major: Option<u32>,
) -> AppResult<Vec<JavaInstallation>> {
    let _scan = state
        .java_scan_lock
        .try_lock()
        .map_err(|_| AppError::Conflict("Java disk search is already running".into()))?;
    let managed_roots = managed_roots(state).await?;
    state.java_scan_cancelled.store(false, Ordering::Relaxed);
    let mut installations = discover_in_roots(&managed_roots, required_major).await?;
    let scan_roots = local_drive_roots();
    let scan_total = scan_roots.len() as u64;
    for (index, root) in scan_roots.into_iter().enumerate() {
        if state.java_scan_cancelled.load(Ordering::Relaxed) {
            break;
        }
        if let Some(app) = app {
            let _ = app.emit(
                crate::host::EventKind::OperationProgress,
                ProgressEvent {
                    operation_id: "java-disk-scan".into(),
                    instance_id: None,
                    operation: "java".into(),
                    stage: "scan".into(),
                    message: format!("Scanning {} for Java", root.display()),
                    completed: index as u64,
                    total: Some(scan_total),
                    downloaded_bytes: None,
                    total_bytes: None,
                },
            );
        }
        let candidates = scan_drive_for_java(&root, state.java_scan_cancelled.clone()).await;
        let seen: HashSet<_> = installations
            .iter()
            .map(|java| runtime_key(&java.path))
            .collect();
        let verified = futures_util::stream::iter(candidates)
            .map(|candidate| {
                let cancelled = &state.java_scan_cancelled;
                let seen = &seen;
                async move {
                    if cancelled.load(Ordering::Relaxed) {
                        return None;
                    }
                    let canonical = candidate.canonicalize().unwrap_or(candidate.clone());
                    if seen.contains(&runtime_key(&canonical.to_string_lossy())) {
                        return None;
                    }
                    let mut java = inspect(&candidate).await.ok()?;
                    java.source = "disk scan".into();
                    java.compatible = automatic_major_matches(required_major, java.major_version);
                    Some(java)
                }
            })
            .buffer_unordered(4)
            .filter_map(|runtime| async { runtime })
            .collect::<Vec<_>>()
            .await;
        installations.extend(verified);
    }
    normalize_installations(&mut installations);
    if let Some(best) = installations.iter().find(|candidate| candidate.compatible) {
        remember_detected_path(state, best).await?;
    }
    if let Some(app) = app {
        let _ = app.emit(
            crate::host::EventKind::OperationProgress,
            ProgressEvent {
                operation_id: "java-disk-scan".into(),
                instance_id: None,
                operation: "java".into(),
                stage: if state.java_scan_cancelled.load(Ordering::Relaxed) {
                    "cancelled"
                } else {
                    "complete"
                }
                .into(),
                message: "Java disk scan complete".into(),
                completed: scan_total,
                total: Some(scan_total),
                downloaded_bytes: None,
                total_bytes: None,
            },
        );
    }
    Ok(installations)
}

/// Fast discovery for the launch path. Full fixed-disk enumeration is an
/// explicit Settings action because walking a large HDD can take minutes and
/// must never delay the Play button. Managed Java, JAVA_HOME and PATH still
/// cover the normal launch cases; when none is suitable the launcher installs
/// its verified managed runtime.
pub async fn discover_fast(
    state: &AppState,
    required_major: Option<u32>,
) -> AppResult<Vec<JavaInstallation>> {
    if let Some(cached) = cached_installation(state, required_major).await? {
        return Ok(vec![cached]);
    }
    discover_available(state, required_major).await
}

/// Settings needs the complete quick list, rather than the launch cache's
/// single preferred runtime. Neither path traverses entire drives.
pub async fn discover_available(
    state: &AppState,
    required_major: Option<u32>,
) -> AppResult<Vec<JavaInstallation>> {
    let mut installations = discover_in_roots(&managed_roots(state).await?, required_major).await?;
    for installation in &mut installations {
        installation.compatible =
            automatic_major_matches(required_major, installation.major_version);
    }
    normalize_installations(&mut installations);
    if let Some(best) = installations.iter().find(|candidate| candidate.compatible) {
        remember_detected_path(state, best).await?;
    }
    Ok(installations)
}

/// Return the last verified runtime without enumerating every configured
/// location again. The executable is still checked with `java -version` so a
/// removed or replaced runtime is never trusted blindly.
async fn cached_installation(
    state: &AppState,
    required_major: Option<u32>,
) -> AppResult<Option<JavaInstallation>> {
    let settings = database::setting(&state.database, "java").await?;
    let Some(path) = settings
        .get("detectedPath")
        .and_then(serde_json::Value::as_str)
        .map(PathBuf::from)
    else {
        return Ok(None);
    };
    if !path.is_file() {
        return Ok(None);
    }
    let mut installation = match inspect(&path).await {
        Ok(installation) => installation,
        Err(_) => return Ok(None),
    };
    installation.compatible = automatic_major_matches(required_major, installation.major_version);
    if !installation.compatible {
        return Ok(None);
    }
    installation.source = "saved".into();
    Ok(Some(installation))
}

async fn remember_detected_path(
    state: &AppState,
    installation: &JavaInstallation,
) -> AppResult<()> {
    let mut settings = database::setting(&state.database, "java").await?;
    let Some(values) = settings.as_object_mut() else {
        return Err(AppError::InvalidInput(
            "Java settings must be a JSON object".into(),
        ));
    };
    if values
        .get("detectedPath")
        .and_then(serde_json::Value::as_str)
        == Some(installation.path.as_str())
    {
        return Ok(());
    }
    values.insert(
        "detectedPath".into(),
        serde_json::Value::String(installation.path.clone()),
    );
    database::set_setting(&state.database, "java", &settings).await
}

async fn scan_drive_for_java(
    root: &Path,
    cancelled: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Vec<PathBuf> {
    let root = root.to_path_buf();
    tokio::task::spawn_blocking(move || {
        const SKIP: &[&str] = &[
            "windows",
            "programdata",
            "system volume information",
            "$recycle.bin",
            "recovery",
            "node_modules", ".git", "target", "assets", "libraries",
        ];
        walkdir::WalkDir::new(root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| {
                if cancelled.load(Ordering::Relaxed) {
                    return false;
                }
                !entry.file_type().is_symlink()
                    // Isolated test copies are not installed user runtimes.
                    && !(entry.file_type().is_dir() && entry.path().join("native-prototype.json").is_file())
                    && !entry
                        .file_name()
                        .to_string_lossy()
                        .eq_ignore_ascii_case("Windows")
                    && !SKIP.iter().any(|name| {
                        entry
                            .file_name()
                            .to_string_lossy()
                            .eq_ignore_ascii_case(name)
                    })
            })
            .filter_map(Result::ok)
            .filter(|entry| {
                entry.file_type().is_file()
                    && entry.file_name().to_string_lossy().eq_ignore_ascii_case(
                        crate::platform::OperatingSystem::current().java_executable(),
                    )
            })
            .map(|entry| entry.into_path())
            .collect()
    })
    .await
    .unwrap_or_default()
}

#[cfg(windows)]
fn local_drive_roots() -> Vec<PathBuf> {
    use windows::Win32::Storage::FileSystem::GetDriveTypeW;
    (b'A'..=b'Z')
        .filter_map(|letter| {
            let root = format!("{}:\\", letter as char);
            let wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
            // Win32 DRIVE_FIXED is the documented numeric value 3.
            (unsafe { GetDriveTypeW(windows::core::PCWSTR(wide.as_ptr())) } == 3)
                .then_some(PathBuf::from(root))
        })
        .collect()
}

#[cfg(not(windows))]
fn local_drive_roots() -> Vec<PathBuf> {
    Vec::new()
}

async fn discover_in_roots(
    managed_roots: &[PathBuf],
    required_major: Option<u32>,
) -> AppResult<Vec<JavaInstallation>> {
    let mut candidates = BTreeSet::<PathBuf>::new();
    if let Some(java_home) = std::env::var_os("JAVA_HOME") {
        candidates.insert(
            PathBuf::from(java_home)
                .join("bin")
                .join(crate::platform::OperatingSystem::current().java_executable()),
        );
    }
    for root in managed_roots {
        for managed in managed_candidates(root) {
            candidates.insert(managed);
        }
    }
    for root in system_java_roots() {
        candidates.extend(managed_candidates(&root));
    }
    let mut where_java = Command::new(if cfg!(windows) { "where.exe" } else { "which" });
    let mut path_candidates = BTreeSet::new();
    where_java.arg(crate::platform::OperatingSystem::current().java_executable());
    hide_console_window(&mut where_java);
    where_java.kill_on_drop(true);
    if let Ok(Ok(output)) =
        tokio::time::timeout(std::time::Duration::from_secs(3), where_java.output()).await
    {
        if output.status.success() {
            for line in String::from_utf8_lossy(&output.stdout).lines() {
                let path = PathBuf::from(line.trim());
                path_candidates.insert(path.clone());
                candidates.insert(path);
            }
        }
    }

    let mut installations = futures_util::stream::iter(candidates)
        .map(|candidate| {
            let path_candidates = &path_candidates;
            async move {
                if !candidate.is_file() {
                    return None;
                }
                if let Ok(mut java) = inspect(&candidate).await {
                    java.source = if managed_roots.iter().any(|root| candidate.starts_with(root)) {
                        "managed".into()
                    } else if std::env::var_os("JAVA_HOME")
                        .map(PathBuf::from)
                        .is_some_and(|home| candidate.starts_with(home))
                    {
                        "JAVA_HOME".into()
                    } else if path_candidates.contains(&candidate) {
                        "PATH".into()
                    } else {
                        "system".into()
                    };
                    java.compatible = automatic_major_matches(required_major, java.major_version);
                    return Some(java);
                }
                None
            }
        })
        .buffer_unordered(4)
        .filter_map(|runtime| async { runtime })
        .collect::<Vec<_>>()
        .await;
    normalize_installations(&mut installations);
    Ok(installations)
}

fn system_java_roots() -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        ["ProgramFiles", "ProgramFiles(x86)"]
            .into_iter()
            .filter_map(std::env::var_os)
            .map(PathBuf::from)
            .flat_map(|root| {
                [
                    root.join("Java"),
                    root.join("Eclipse Adoptium"),
                    root.join("Microsoft"),
                    root.join("Amazon Corretto"),
                    root.join("Zulu"),
                ]
            })
            .collect()
    }
    #[cfg(not(windows))]
    {
        vec![
            PathBuf::from("/usr/lib/jvm"),
            PathBuf::from("/Library/Java/JavaVirtualMachines"),
        ]
    }
}

fn runtime_key(path: &str) -> String {
    if cfg!(windows) {
        path.replace('/', "\\")
            .trim_start_matches("\\\\?\\")
            .to_lowercase()
    } else {
        path.to_owned()
    }
}

fn normalize_installations(installations: &mut Vec<JavaInstallation>) {
    // Prefer meaningful provenance when a runtime was found through several
    // sources. Deduplication must not depend on equal paths being adjacent.
    installations.sort_by_key(|java| match java.source.as_str() {
        "managed" => 0,
        "JAVA_HOME" => 1,
        "PATH" => 2,
        _ => 3,
    });
    let mut seen = HashSet::new();
    installations.retain(|java| seen.insert(runtime_key(&java.path)));
    installations.sort_by(|left, right| {
        right
            .compatible
            .cmp(&left.compatible)
            .then(right.major_version.cmp(&left.major_version))
            .then(left.path.cmp(&right.path))
    });
}

/// The configured directory is the preferred destination for future downloads.
/// The portable default remains a discovery root so moving the setting never
/// makes already downloaded runtimes disappear from the launcher.
pub async fn managed_root(state: &AppState) -> AppResult<PathBuf> {
    let setting = database::setting(&state.database, "java").await?;
    let configured = setting
        .get("installDirectory")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_absolute());
    Ok(configured.unwrap_or_else(|| state.paths.java.clone()))
}

async fn managed_roots(state: &AppState) -> AppResult<Vec<PathBuf>> {
    let preferred = managed_root(state).await?;
    let mut roots = vec![preferred];
    if !roots.iter().any(|root| root == &state.paths.java) {
        roots.push(state.paths.java.clone());
    }
    Ok(roots)
}

pub fn compatible_managed_major(required_major: Option<u32>) -> AppResult<u32> {
    let required = required_major.unwrap_or(8);
    [8, 17, 21, 25]
        .into_iter()
        .find(|major| *major >= required)
        .ok_or_else(|| {
            AppError::Unavailable(format!(
                "Minecraft requires Java {required} or newer, but SLH can manage Java 8, 17, 21, and 25"
            ))
        })
}

/// A newer JVM is not necessarily compatible with a game's loader and mixins.
/// Automatic launch uses the version requested by Minecraft (or the closest
/// managed version, e.g. 17 for a Java 16 requirement), never the newest JVM.
fn automatic_major_matches(required_major: Option<u32>, actual_major: u32) -> bool {
    required_major.is_none_or(|required| {
        actual_major == required
            || compatible_managed_major(Some(required)).is_ok_and(|managed| actual_major == managed)
    })
}

pub async fn install_compatible_managed(
    app: &Host,
    state: &AppState,
    required_major: Option<u32>,
) -> AppResult<JavaInstallation> {
    install_managed(app, state, compatible_managed_major(required_major)?).await
}

/// Shared by installation and launch: prepare the game's requested Java before
/// selecting native libraries, and download it when automatic mode permits.
pub async fn resolve_automatic(
    app: &Host,
    state: &AppState,
    required_major: Option<u32>,
) -> AppResult<JavaInstallation> {
    // Older Minecraft metadata omits javaVersion; its runtime line is Java 8.
    let required_major = Some(required_major.unwrap_or(8));
    let settings = database::setting(&state.database, "java").await?;
    if settings["autoDetect"].as_bool() == Some(false) {
        return Err(AppError::Unavailable(
            "Choose a Java executable or enable automatic Java detection".into(),
        ));
    }
    if let Some(java) = discover_fast(state, required_major)
        .await?
        .into_iter()
        .find(|java| java.compatible)
    {
        return Ok(java);
    }
    if settings["autoDownload"].as_bool() == Some(false) {
        return Err(AppError::Unavailable("No compatible Java runtime was found; enable automatic Java download or install Java in Settings".into()));
    }
    install_compatible_managed(app, state, required_major).await
}

fn managed_candidates(root: &Path) -> Vec<PathBuf> {
    if !root.exists() {
        return Vec::new();
    }
    walkdir::WalkDir::new(root)
        .max_depth(8)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry.file_type().is_file()
                && entry.file_name().to_string_lossy().eq_ignore_ascii_case(
                    crate::platform::OperatingSystem::current().java_executable(),
                )
        })
        .map(|entry| entry.into_path())
        .collect()
}

pub async fn inspect(path: &Path) -> AppResult<JavaInstallation> {
    let mut command = Command::new(path);
    command.args(["-XshowSettings:properties", "-version"]);
    hide_console_window(&mut command);
    command.kill_on_drop(true);
    let output = tokio::time::timeout(std::time::Duration::from_secs(15), command.output())
        .await
        .map_err(|_| AppError::Process(format!("Java verification timed out: {}", path.display())))?
        .map_err(|error| AppError::Process(format!("Unable to run {}: {error}", path.display())))?;
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if !output.status.success() {
        return Err(AppError::Process(format!(
            "{} -version failed: {}",
            path.display(),
            text.trim()
        )));
    }
    let pattern = Regex::new(r#"version\s+\"([^\"]+)\""#).expect("java version regex is valid");
    let version = pattern
        .captures(&text)
        .and_then(|captures| captures.get(1))
        .map(|value| value.as_str().to_owned())
        .ok_or_else(|| AppError::Process(format!("Could not parse Java version from: {text}")))?;
    let major_version = parse_major(&version)?;
    let architecture = text
        .lines()
        .find_map(|line| line.trim().strip_prefix("os.arch = "))
        .unwrap_or(std::env::consts::ARCH)
        .trim()
        .to_owned();
    // Oracle PATH shims and java/javaw aliases report the real runtime home.
    // Use it as identity instead of listing each shim as another installation.
    let executable = text
        .lines()
        .find_map(|line| line.trim().strip_prefix("java.home = "))
        .map(|home| {
            PathBuf::from(home.trim())
                .join("bin")
                .join(crate::platform::OperatingSystem::current().java_executable())
        })
        .filter(|executable| executable.is_file())
        .unwrap_or_else(|| path.to_path_buf());
    let executable = executable.canonicalize().unwrap_or(executable);
    let canonical_path = executable.to_string_lossy();
    Ok(JavaInstallation {
        architecture,
        path: canonical_path
            .strip_prefix("\\\\?\\")
            .unwrap_or(&canonical_path)
            .to_owned(),
        version,
        major_version,
        source: "custom".into(),
        compatible: true,
    })
}

fn hide_console_window(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.as_std_mut().creation_flags(0x08000000);
    }
}

pub async fn install_managed(
    app: &Host,
    state: &AppState,
    major_version: u32,
) -> AppResult<JavaInstallation> {
    let operation_id = Uuid::new_v4().to_string();
    let result = install_managed_inner(app, state, major_version, &operation_id).await;
    finish_java_install(app, &operation_id, &result);
    result
}

fn finish_java_install(app: &Host, operation_id: &str, result: &AppResult<JavaInstallation>) {
    match result {
        Ok(java) => emit_java_progress(app, operation_id, "complete", format!("Temurin Java {} is ready", java.version), 1, Some(1)),
        Err(error) => emit_java_progress(app, operation_id, "failed", error.to_string(), 0, None),
    }
}

async fn install_managed_inner(
    app: &Host,
    state: &AppState,
    major_version: u32,
    operation_id: &str,
) -> AppResult<JavaInstallation> {
    if ![8, 17, 21, 25].contains(&major_version) {
        return Err(AppError::InvalidInput(
            "Managed Java supports the Minecraft runtime lines 8, 17, 21, and 25".into(),
        ));
    }
    let managed_root = managed_root(state).await?;
    emit_java_progress(
        app,
        operation_id,
        "metadata",
        format!("Java {major_version} is downloading"),
        0,
        None,
    );
    let endpoint = format!("https://api.adoptium.net/v3/assets/latest/{major_version}/hotspot");
    let assets: Vec<AdoptiumAsset> = state
        .http
        .get(endpoint)
        .query(&[
            ("architecture", managed_architecture()),
            ("image_type", "jre"),
            (
                "os",
                crate::platform::OperatingSystem::current().adoptium_name(),
            ),
            ("vendor", "eclipse"),
        ])
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let asset = assets.into_iter().next().ok_or_else(|| {
        AppError::Unavailable(format!(
            "Adoptium did not return a compatible {} JRE for Java {major_version}",
            managed_architecture()
        ))
    })?;
    if asset.binary.package.size > MAX_MANAGED_JAVA_ARCHIVE_BYTES {
        return Err(AppError::Security(
            "Managed Java archive exceeds the 16 GiB per-file safety limit".into(),
        ));
    }
    let archive_path = state.paths.downloads.join(format!(
        "temurin-{major_version}-{}.{}",
        Uuid::new_v4(),
        crate::platform::OperatingSystem::current().archive_extension()
    ));
    download_sha256(
        app,
        state,
        operation_id,
        &asset.binary.package.link,
        &asset.binary.package.checksum,
        asset.binary.package.size,
        &archive_path,
        major_version,
    )
    .await?;
    emit_java_progress(
        app,
        operation_id,
        "extract",
        format!("Installing Temurin {}", asset.version.semver),
        0,
        None,
    );
    tokio::fs::create_dir_all(&managed_root).await?;
    let staging = managed_root.join(format!(".install-{}", Uuid::new_v4()));
    tokio::fs::create_dir_all(&staging).await?;
    let archive_for_task = archive_path.clone();
    let staging_for_task = staging.clone();
    let extraction = tokio::task::spawn_blocking(move || {
        extract_java_archive(&archive_for_task, &staging_for_task)
    })
    .await
    .map_err(|error| AppError::Process(format!("Java extraction task failed: {error}")))?;
    if let Err(error) = extraction {
        let _ = tokio::fs::remove_dir_all(&staging).await;
        let _ = tokio::fs::remove_file(&archive_path).await;
        return Err(error);
    }
    let java_in_staging = managed_candidates(&staging)
        .into_iter()
        .next()
        .ok_or_else(|| AppError::Security("Temurin archive contained no Java executable".into()))?;
    // Keep the complete macOS bundle: Contents/Home can reference Contents/MacOS.
    let relative_java = java_in_staging.strip_prefix(&staging)
        .map_err(|_| AppError::Security("Java executable escaped staging".into()))?;
    let bundle = relative_java.components().next()
        .ok_or_else(|| AppError::Security("Temurin runtime layout is invalid".into()))?;
    let runtime_root = staging.join(bundle.as_os_str());
    let executable_relative = java_in_staging.strip_prefix(&runtime_root)
        .map_err(|_| AppError::Security("Temurin runtime layout is invalid".into()))?;
    // Verify before committing the directory, so a failed install is retryable.
    if let Err(error) = inspect(&java_in_staging).await {
        let _ = tokio::fs::remove_dir_all(&staging).await;
        let _ = tokio::fs::remove_file(&archive_path).await;
        return Err(error);
    }
    let safe_version = asset
        .version
        .semver
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    let destination = managed_root.join(format!("temurin-{major_version}-{safe_version}"));
    if destination.exists() {
        let existing = destination.join(executable_relative);
        if existing.is_file() {
            let _ = tokio::fs::remove_dir_all(&staging).await;
            let _ = tokio::fs::remove_file(&archive_path).await;
            let mut java = inspect(&existing).await?;
            java.source = "managed".into();
            remember_detected_path(state, &java).await?;
            emit_java_progress(
                app,
                operation_id,
                "complete",
                format!("Temurin Java {} is ready", java.version),
                1,
                Some(1),
            );
            return Ok(java);
        }
        return Err(AppError::Conflict(format!(
            "Managed Java destination already exists but is incomplete: {}",
            destination.display()
        )));
    }
    tokio::fs::rename(runtime_root, &destination).await?;
    let _ = tokio::fs::remove_dir_all(&staging).await;
    let _ = tokio::fs::remove_file(&archive_path).await;
    let mut installed = inspect(
        &destination.join(executable_relative),
    )
    .await?;
    installed.source = "managed".into();
    remember_detected_path(state, &installed).await?;
    Ok(installed)
}

#[allow(clippy::too_many_arguments)]
async fn download_sha256(
    app: &Host,
    state: &AppState,
    operation_id: &str,
    url: &str,
    expected: &str,
    expected_size: u64,
    destination: &Path,
    major_version: u32,
) -> AppResult<()> {
    // The shared metadata client has a 60-second deadline. Runtime archives
    // need longer on older Macs and slow connections, while stalled chunks fail.
    let response = state.http.get(url)
        .timeout(std::time::Duration::from_secs(15 * 60))
        .send().await?.error_for_status()?;
    let mut stream = response.bytes_stream();
    let temporary = destination.with_extension("zip.slh-part");
    let mut output = tokio::fs::File::create(&temporary).await?;
    let mut digest = Sha256::new();
    let mut written = 0_u64;
    while let Some(chunk) = tokio::time::timeout(std::time::Duration::from_secs(45), stream.next())
        .await.map_err(|_| AppError::Unavailable("Java download stalled; retry the installation".into()))? {
        let chunk = chunk?;
        written = written.saturating_add(chunk.len() as u64);
        if written > MAX_MANAGED_JAVA_ARCHIVE_BYTES {
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err(AppError::Security(
                "Managed Java download exceeded the 16 GiB per-file safety limit".into(),
            ));
        }
        digest.update(&chunk);
        output.write_all(&chunk).await?;
        emit_java_progress(
            app,
            operation_id,
            "download",
            format!("Downloading Java {major_version}"),
            written,
            Some(expected_size),
        );
    }
    output.flush().await?;
    drop(output);
    let actual = hex::encode(digest.finalize());
    if !actual.eq_ignore_ascii_case(expected) {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(AppError::Security(format!(
            "Managed Java SHA-256 mismatch: expected {expected}, received {actual}"
        )));
    }
    tokio::fs::rename(temporary, destination).await?;
    Ok(())
}

fn managed_architecture() -> &'static str {
    crate::platform::Architecture::host().adoptium_name()
}

fn extract_java_archive(archive_path: &Path, output: &Path) -> AppResult<()> {
    if !cfg!(windows) {
        return extract_java_tar(archive_path, output);
    }
    let file = File::open(archive_path)?;
    let mut archive = zip::ZipArchive::new(file)?;
    let mut expanded = 0_u64;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        let relative = entry.enclosed_name().ok_or_else(|| {
            AppError::Security(format!(
                "Java archive contains an unsafe path: {}",
                entry.name()
            ))
        })?;
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(AppError::Security(format!(
                "Java archive contains a symbolic link: {}",
                entry.name()
            )));
        }
        expanded = expanded.saturating_add(entry.size());
        if expanded > 1024 * 1024 * 1024 {
            return Err(AppError::Security(
                "Managed Java expands beyond the 1 GiB safety limit".into(),
            ));
        }
        let target = output.join(relative);
        if entry.is_dir() {
            std::fs::create_dir_all(target)?;
        } else {
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut file = File::create(target)?;
            std::io::copy(&mut entry, &mut file)?;
        }
    }
    Ok(())
}

fn emit_java_progress(
    app: &Host,
    operation_id: &str,
    stage: &str,
    message: String,
    completed: u64,
    total: Option<u64>,
) {
    let _ = app.emit(
        crate::host::EventKind::OperationProgress,
        ProgressEvent {
            operation_id: operation_id.into(),
            instance_id: None,
            operation: "java".into(),
            stage: stage.into(),
            message,
            completed,
            total,
            downloaded_bytes: None,
            total_bytes: None,
        },
    );
}

fn parse_major(version: &str) -> AppResult<u32> {
    let parts: Vec<&str> = version.split(['.', '_', '-']).collect();
    let first = parts
        .first()
        .and_then(|value| value.parse::<u32>().ok())
        .ok_or_else(|| AppError::Process(format!("Unsupported Java version string: {version}")))?;
    if first == 1 {
        parts
            .get(1)
            .and_then(|value| value.parse().ok())
            .ok_or_else(|| AppError::Process(format!("Unsupported Java version string: {version}")))
    } else {
        Ok(first)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_existing_runtime_also_completes_the_java_progress_operation() {
        let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured = events.clone();
        let host = Host::new(move |event| { captured.lock().unwrap().push(event); Ok(()) });
        let runtime = JavaInstallation { path: "cached-runtime".into(), version: "21.0.8".into(), major_version: 21, architecture: "amd64".into(), source: "managed".into(), compatible: true };
        finish_java_install(&host, "existing-runtime-install", &Ok(runtime));
        let events = events.lock().unwrap();
        assert!(events.iter().any(|event| matches!(event,
            crate::host::CoreEvent::Progress(progress) if progress.operation_id == "existing-runtime-install" && progress.stage == "complete" && progress.completed == 1 && progress.total == Some(1))));
    }

    #[tokio::test]
    async fn failed_java_installation_ends_its_progress_operation() {
        let directory = tempfile::tempdir().unwrap();
        let paths = crate::portable::PortablePaths::from_executable(&directory.path().join("slh"), Some(directory.path().to_path_buf())).unwrap();
        let state = crate::state::AppState::initialize_isolated_at(paths).await.unwrap();
        let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured = events.clone();
        let host = Host::new(move |event| { captured.lock().unwrap().push(event); Ok(()) });
        assert!(install_managed(&host, &state, 99).await.is_err());
        let events = events.lock().unwrap();
        assert!(events.iter().any(|event| matches!(event,
            crate::host::CoreEvent::Progress(progress) if progress.operation == "java" && progress.stage == "failed" && !progress.operation_id.is_empty())));
    }

    #[test]
    fn discovers_deep_macos_runtime_layout() {
        let directory = tempfile::tempdir().unwrap();
        let java = directory.path().join("jdk-21.jre/Contents/Home/bin")
            .join(crate::platform::OperatingSystem::current().java_executable());
        std::fs::create_dir_all(java.parent().unwrap()).unwrap();
        std::fs::write(&java, "fixture").unwrap();
        assert_eq!(managed_candidates(directory.path()), vec![java]);
    }

    #[test]
    fn extracts_macos_bundle_without_losing_executable_mode() {
        let directory = tempfile::tempdir().unwrap();
        let archive_path = directory.path().join("runtime.tar.gz");
        let encoder = flate2::write::GzEncoder::new(File::create(&archive_path).unwrap(), flate2::Compression::default());
        let mut archive = tar::Builder::new(encoder);
        for name in ["jdk.jre/Contents/Home/bin/java", "jdk.jre/Contents/MacOS/libjli.dylib"] {
            let mut header = tar::Header::new_gnu();
            header.set_size(7); header.set_mode(0o755); header.set_cksum();
            archive.append_data(&mut header, name, &b"fixture"[..]).unwrap();
        }
        archive.into_inner().unwrap().finish().unwrap();
        let output = directory.path().join("extracted");
        std::fs::create_dir_all(&output).unwrap();
        extract_java_tar(&archive_path, &output).unwrap();
        let java = output.join("jdk.jre/Contents/Home/bin/java");
        assert!(java.is_file());
        assert!(output.join("jdk.jre/Contents/MacOS/libjli.dylib").is_file());
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            assert_ne!(java.metadata().unwrap().permissions().mode() & 0o111, 0);
        }
    }



    #[test]
    fn merges_non_adjacent_duplicates_and_keeps_managed_provenance() {
        let runtime = |path: &str, source: &str| JavaInstallation {
            path: path.into(),
            source: source.into(),
            version: "17.0.20".into(),
            major_version: 17,
            architecture: "amd64".into(),
            compatible: true,
        };
        let mut list = vec![
            runtime("/java/a", "disk scan"),
            runtime("/java/b", "PATH"),
            runtime("/java/a", "managed"),
        ];
        normalize_installations(&mut list);
        assert_eq!(list.len(), 2);
        assert_eq!(
            list.iter()
                .find(|java| java.path == "/java/a")
                .unwrap()
                .source,
            "managed"
        );
    }

    #[test]
    fn preserves_distinct_installations_of_same_major() {
        let mut list = vec![
            JavaInstallation {
                path: "/java/17-a".into(),
                version: "17.0.18".into(),
                major_version: 17,
                architecture: "amd64".into(),
                source: "PATH".into(),
                compatible: true,
            },
            JavaInstallation {
                path: "/java/17-b".into(),
                version: "17.0.20".into(),
                major_version: 17,
                architecture: "amd64".into(),
                source: "managed".into(),
                compatible: true,
            },
        ];
        normalize_installations(&mut list);
        assert_eq!(list.len(), 2);
    }

    #[tokio::test]
    #[ignore = "Read-only host diagnostic; run explicitly to measure quick discovery"]
    async fn quick_discovery_host_diagnostic() {
        let started = std::time::Instant::now();
        let installations = discover_in_roots(&[], None).await.unwrap();
        let keys: HashSet<_> = installations
            .iter()
            .map(|java| runtime_key(&java.path))
            .collect();
        assert_eq!(keys.len(), installations.len());
        eprintln!(
            "Quick discovery: {} installations in {:.3}s",
            installations.len(),
            started.elapsed().as_secs_f64()
        );
        for java in installations {
            eprintln!(
                "{} {} {} {}",
                java.version, java.architecture, java.source, java.path
            );
        }
    }

    #[test]
    fn parses_legacy_and_modern_java_versions() {
        assert_eq!(parse_major("1.8.0_402").unwrap(), 8);
        assert_eq!(parse_major("17.0.11").unwrap(), 17);
        assert_eq!(parse_major("21").unwrap(), 21);
        assert_eq!(parse_major("25.0.1").unwrap(), 25);
    }

    #[test]
    fn chooses_the_smallest_supported_runtime_for_minecraft() {
        assert_eq!(compatible_managed_major(None).unwrap(), 8);
        assert_eq!(compatible_managed_major(Some(16)).unwrap(), 17);
        assert_eq!(compatible_managed_major(Some(21)).unwrap(), 21);
        assert!(compatible_managed_major(Some(26)).is_err());
    }

    #[test]
    fn automatic_selection_keeps_the_game_runtime_instead_of_newest_java() {
        assert!(automatic_major_matches(Some(17), 17));
        assert!(!automatic_major_matches(Some(17), 25));
        assert!(!automatic_major_matches(Some(17), 21));
        assert!(automatic_major_matches(Some(21), 21));
        assert!(!automatic_major_matches(Some(21), 25));
        assert!(automatic_major_matches(Some(25), 25));
        assert!(automatic_major_matches(Some(8), 8));
        assert!(!automatic_major_matches(Some(8), 17));
        assert!(automatic_major_matches(Some(16), 16));
        assert!(automatic_major_matches(Some(16), 17));
        assert!(!automatic_major_matches(Some(16), 25));
        assert!(automatic_major_matches(None, 25));
    }
}

fn extract_java_tar(path: &Path, output: &Path) -> AppResult<()> {
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(File::open(path)?));
    let mut expanded = 0u64;
    let mut links = Vec::new();
    for entry in archive.entries()? {
        let mut entry = entry?;
        let relative: PathBuf = entry
            .path()?
            .components()
            .filter(|c| !matches!(c, std::path::Component::CurDir))
            .collect();
        if relative.as_os_str().is_empty() && entry.header().entry_type().is_dir() {
            continue;
        }
        crate::security::validate_relative_path(&relative)?;
        let kind = entry.header().entry_type();
        if kind.is_symlink() || kind.is_hard_link() {
            let target = entry
                .link_name()?
                .ok_or_else(|| AppError::Security("Java link has no target".into()))?
                .into_owned();
            links.push((relative, target, kind.is_symlink()));
            continue;
        }
        if !kind.is_file() && !kind.is_dir() {
            return Err(AppError::Security(
                "Java tar contains a special file".into(),
            ));
        }
        expanded = expanded.saturating_add(entry.size());
        if expanded > 1024 * 1024 * 1024 {
            return Err(AppError::Security(
                "Managed Java exceeds 1 GiB expanded".into(),
            ));
        }
        if !entry.unpack_in(output)? {
            return Err(AppError::Security("Java tar path escaped staging".into()));
        }
    }
    let root = output.canonicalize()?;
    for (relative, target, symlink) in links {
        if target.is_absolute() {
            return Err(AppError::Security("Absolute Java archive link".into()));
        }
        let destination = output.join(&relative);
        let target_path = if symlink {
            destination.parent().unwrap().join(&target)
        } else {
            output.join(&target)
        };
        let resolved = target_path.canonicalize()?;
        if !resolved.starts_with(&root) {
            return Err(AppError::Security("Java link escaped staging".into()));
        }
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)?;
        }
        if symlink {
            #[cfg(unix)]
            std::os::unix::fs::symlink(target, destination)?;
            #[cfg(not(unix))]
            return Err(AppError::Unavailable(
                "Java tar symlinks require a Unix platform".into(),
            ));
        } else {
            std::fs::hard_link(resolved, destination)?;
        }
    }
    Ok(())
}
