//! Windows Bedrock deployment and launch support.
//!
//! Bedrock is not a Java distribution. The launcher therefore treats a
//! downloaded package, a registered Windows package, and a launchable Store
//! entitlement as different states. Retail MSIXVC packages are extracted by
//! the GPL-licensed LeviLauncher native helper using the user's Windows Store
//! entitlement; they are never sent to `wdapp`.

use std::collections::HashSet;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use crate::host::Host;
use chrono::Utc;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use uuid::Uuid;

use crate::database;
use crate::error::{AppError, AppResult};
use crate::models::{Instance, LaunchResponse};
use crate::portable::PortablePaths;
use crate::state::AppState;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const PROFILE_JOURNAL_NAME: &str = "profile-journal.json";
const MAX_APPX_ENTRIES: usize = 100_000;
const GAMING_SERVICES_STORE_ID: &str = "9MWPM2CQNLHN";
const GAMING_REPAIR_TOOL_URL: &str =
    "https://dlassets-ssl.xboxlive.com/public/content/XboxInstaller/GamingRepairTool.exe";
const GAMING_REPAIR_TOOL_SHA256: &str =
    "4f175be219413f28a45937a5d590852910e0cf04da66268aa94cd0d2bda75c89";
const MAX_REPAIR_TOOL_BYTES: u64 = 100 * 1024 * 1024;
#[cfg(windows)]
const GDK_WINGET_PACKAGE_ID: &str = "Microsoft.Gaming.GDK";

#[cfg(windows)]
const FILE_ATTRIBUTE_ENCRYPTED: u32 = 0x0000_4000;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BedrockInstalledPackage {
    pub name: String,
    pub version: String,
    pub package_family_name: String,
    pub package_full_name: String,
    pub install_location: String,
    pub app_user_model_id: Option<String>,
    pub channel: String,
    pub signature_kind: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BedrockRuntimeStatus {
    pub microsoft_authenticated: bool,
    /// Windows does not expose the Store account entitlement as a reusable
    /// launcher token. The final check remains in Store/Xbox/Gaming Services.
    pub store_session: String,
    pub xbox_session: String,
    pub minecraft_license: String,
    pub native_installer_available: bool,
    pub store_account_status: String,
    pub store_account_xuid: Option<String>,
    pub store_account_gamertag: Option<String>,
    pub gaming_services_installed: bool,
    pub game_input_installed: bool,
    pub developer_mode: bool,
    pub wdapp_available: bool,
    pub wdapp_path: Option<String>,
    pub architecture: String,
    pub installed_packages: Vec<BedrockInstalledPackage>,
    pub launch_ready: bool,
    pub message: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BedrockStoreAccountBinding {
    pub xuid: String,
    pub gamertag: String,
    pub release: String,
    pub preview: String,
    pub market: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
struct NativeAccountReport {
    #[serde(default)]
    stage: String,
    #[serde(default)]
    xuid: String,
    #[serde(default)]
    gamertag: String,
    #[serde(default)]
    release: String,
    #[serde(default)]
    preview: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BedrockPackageMetadata {
    pub version: String,
    pub package_type: String,
    pub channel: String,
    pub architecture: String,
    pub package_path: Option<String>,
    #[serde(default = "default_install_method")]
    pub install_method: String,
    pub package_family_name: Option<String>,
    pub app_user_model_id: Option<String>,
    pub install_location: Option<String>,
    pub launch_ready: bool,
    pub status: String,
    pub reason: Option<String>,
    pub profile_mode: String,
    pub registered_by_slh: bool,
    #[serde(default)]
    pub extracted_root: Option<String>,
    #[serde(default)]
    pub xbox_xuid: Option<String>,
}

fn default_install_method() -> String {
    "registered_store".into()
}

#[allow(dead_code)]
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeInstallReport {
    #[serde(default, alias = "ContentID")]
    content_id: String,
    #[serde(default, alias = "KeyID")]
    key_id: String,
    #[serde(default, alias = "LicenseType")]
    license_type: String,
    #[serde(default, alias = "OutputDir")]
    output_dir: String,
    #[serde(default, alias = "FileCount")]
    file_count: u64,
    #[serde(default, alias = "Bytes")]
    bytes: u64,
}

#[derive(Clone, Debug)]
pub struct BedrockInstallOutcome {
    pub launchable: bool,
    pub reason: Option<String>,
}

/// A UWP package is an AppX/MSIX ZIP archive. Microsoft Update can also
/// return a CAB block-map artifact for the same update; that file is not a
/// package and must not be reused as a successful download on retry.
pub fn is_valid_downloaded_uwp_package(path: &Path) -> bool {
    read_appx_manifest(path).is_ok()
}

#[derive(Clone, Debug)]
struct AppxManifestInfo {
    name: String,
    version: String,
    processor_architecture: String,
    application_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileJournal {
    instance_id: String,
    system_profile: String,
    instance_profile: String,
    backup_profile: String,
    had_original: bool,
    phase: String,
}

#[derive(Clone, Debug)]
struct ProfileSession {
    journal_path: PathBuf,
    system_profile: PathBuf,
    instance_profile: PathBuf,
    backup_profile: PathBuf,
    had_original: bool,
}

pub fn current_architecture() -> String {
    if cfg!(target_arch = "x86_64") {
        "x64".into()
    } else if cfg!(target_arch = "x86") {
        "x86".into()
    } else if cfg!(target_arch = "aarch64") {
        "arm64".into()
    } else {
        std::env::consts::ARCH.into()
    }
}

/// Convert the package version Windows reports into the familiar Minecraft
/// display form.  Store packages encode the last two game-version components
/// together (for example `1.26.6024.0` becomes `1.26.60.24`).
pub(crate) fn display_store_version(package_version: &str) -> String {
    let parts = package_version.trim().split('.').collect::<Vec<_>>();
    let Some(encoded) = parts.get(2).copied() else {
        return package_version.trim().to_owned();
    };
    if parts.len() < 3
        || encoded.len() < 3
        || !parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return package_version.trim().to_owned();
    }
    let split_at = encoded.len() - 2;
    let (build, revision) = encoded.split_at(split_at);
    let (Ok(build), Ok(revision)) = (build.parse::<u32>(), revision.parse::<u32>()) else {
        return package_version.trim().to_owned();
    };
    format!("{}.{}.{}.{}", parts[0], parts[1], build, revision)
}

pub(crate) fn is_registered_store_package(package: &BedrockInstalledPackage) -> bool {
    package.app_user_model_id.is_some()
        && package
            .signature_kind
            .as_deref()
            .is_some_and(|kind| kind.eq_ignore_ascii_case("Store"))
        && [
            "Microsoft.MinecraftUWP",
            "Microsoft.MinecraftWindows",
            "Microsoft.MinecraftWindowsBeta",
        ]
        .iter()
        .any(|name| package.name.eq_ignore_ascii_case(name))
}

/// Normalize the two-letter country code accepted by the Microsoft Store
/// endpoints. Keeping this separate from the Windows API call makes the
/// fallback deterministic and prevents an invalid locale from reaching the
/// native helper command line.
fn normalize_store_market(value: &str) -> Option<String> {
    let value = value.trim();
    (value.len() == 2 && value.bytes().all(|byte| byte.is_ascii_alphabetic()))
        .then(|| value.to_ascii_uppercase())
}

/// Uses the current Windows user's configured home country, which is the
/// closest local source for the Microsoft Store market. The launcher used to
/// hard-code US, causing otherwise valid Store entitlements to be checked
/// against the wrong market for users outside the United States.
#[cfg(windows)]
fn system_store_market() -> String {
    use windows::Win32::Globalization::{
        GEO_ISO2, GEOCLASS_NATION, GEOID_NOT_AVAILABLE, GetGeoInfoW, GetUserGeoID,
    };

    let geo_id = unsafe { GetUserGeoID(GEOCLASS_NATION) };
    if geo_id <= 0 || geo_id == GEOID_NOT_AVAILABLE {
        return "US".into();
    }
    let required = unsafe { GetGeoInfoW(geo_id, GEO_ISO2, None, 0) };
    if !(2..=16).contains(&required) {
        return "US".into();
    }
    let mut buffer = vec![0_u16; required as usize];
    let written = unsafe { GetGeoInfoW(geo_id, GEO_ISO2, Some(&mut buffer), 0) };
    if written <= 1 || written > required {
        return "US".into();
    }
    String::from_utf16(&buffer[..written as usize - 1])
        .ok()
        .and_then(|value| normalize_store_market(&value))
        .unwrap_or_else(|| "US".into())
}

pub fn catalog_architecture(url: &str) -> String {
    let lower = url.to_ascii_lowercase();
    ["arm64", "x64", "x86"]
        .iter()
        .find(|arch| lower.contains(**arch))
        .copied()
        .map(str::to_owned)
        .unwrap_or_else(current_architecture)
}

pub async fn get_runtime_status(state: &AppState) -> AppResult<BedrockRuntimeStatus> {
    let store_binding = read_store_account_binding(&state.paths).await?;
    let store_account_xuid = store_binding.as_ref().map(|binding| binding.xuid.clone());
    let store_account_gamertag = store_binding
        .as_ref()
        .map(|binding| binding.gamertag.clone())
        .filter(|gamertag| !gamertag.trim().is_empty());
    // A Java Microsoft OAuth account does not prove which Xbox player the
    // Bedrock game will use. Report only the separately bound Xbox identity.
    let microsoft_authenticated = store_binding.is_some();
    let native_installer_available =
        current_architecture() == "x64" && find_native_installer(&state.paths).is_some();

    #[cfg(windows)]
    let (gaming_services_installed, game_input_installed, developer_mode, wdapp_path, packages) = {
        let (gaming, game_input, developer, wdapp, packages) = tokio::join!(
            appx_package_present("Microsoft.GamingServices"),
            game_input_present(),
            developer_mode_enabled(),
            find_wdapp(),
            discover_registered_packages(),
        );
        (
            gaming?,
            game_input?,
            developer?,
            wdapp?,
            packages?.unwrap_or_default(),
        )
    };
    #[cfg(not(windows))]
    let (gaming_services_installed, game_input_installed, developer_mode, wdapp_path, packages) =
        (false, false, false, None, Vec::new());

    let release_package = packages
        .iter()
        .any(|package| is_registered_store_package(package) && package.channel == "release");
    let preview_package = packages
        .iter()
        .any(|package| is_registered_store_package(package) && package.channel == "preview");
    let store_package = packages.iter().any(is_registered_store_package);
    let minecraft_license = if store_binding
        .as_ref()
        .is_some_and(|binding| binding.release == "authorized")
    {
        "release"
    } else if store_binding
        .as_ref()
        .is_some_and(|binding| binding.preview == "authorized")
    {
        "preview"
    } else if store_package && release_package {
        "release"
    } else if store_package && preview_package {
        "preview"
    } else {
        "unknown"
    }
    .into();
    let wdapp_available = wdapp_path.is_some();
    let binding = observe_native_bindings(&state.paths, store_account_xuid.as_deref());
    // A registered Store package is Windows' direct proof that this account
    // can attempt to run it.  Do not let a stale native-extractor binding
    // override that fact: those bindings concern archival MSIXVC installs,
    // not the normal Store app.
    let store_account_status = if store_binding.is_some() || store_package {
        "ready"
    } else if binding.account_mismatch {
        "account_mismatch"
    } else if binding.license_missing {
        "license_missing"
    } else if store_account_xuid.is_none() {
        "interaction_required"
    } else if store_package || binding.native_ready {
        "ready"
    } else if native_installer_available {
        // A native extraction is the operation that proves the full Store
        // entitlement. Before that succeeds, Windows may not expose a
        // Store-signed package to Get-AppxPackage.
        "interaction_required"
    } else {
        "unavailable"
    }
    .into();
    let launch_ready = store_package || (binding.native_ready && store_binding.is_some());
    let message = if store_package {
        None
    } else if store_account_xuid.is_none() {
        Some(
            "Bind the Windows Store/Xbox account that owns Minecraft before downloading Bedrock."
                .into(),
        )
    } else if binding.account_mismatch {
        Some("The active Microsoft/Xbox account does not match a Bedrock version already installed by SLH.".into())
    } else if binding.license_missing {
        Some("Microsoft Store did not grant a full Minecraft license to the selected account. Check Store/Xbox ownership and retry the installation.".into())
    } else if current_architecture() != "x64" {
        Some("Full native Bedrock installation is supported on Windows x64 only. This launcher build remains Java-only on x86.".into())
    } else if !native_installer_available && !store_package {
        Some("The licensed Bedrock native installer is not bundled with this build. Rebuild SLH with the pinned LeviLauncher helper, or install Minecraft for Windows through Microsoft Store.".into())
    } else if !gaming_services_installed {
        Some("Microsoft Gaming Services is not installed or is not visible to the current Windows user.".into())
    } else if !game_input_installed {
        Some(
            "Microsoft GameInput is not installed or is not visible to the current Windows user."
                .into(),
        )
    } else if packages.is_empty() && !binding.native_ready {
        Some("Choose a Bedrock version to download, or install the current release from Microsoft Store.".into())
    } else if !store_package {
        Some("A Microsoft Store-signed Minecraft package was not detected for this Windows user. Sideloaded packages cannot satisfy the Bedrock license check.".into())
    } else {
        None
    };
    Ok(BedrockRuntimeStatus {
        microsoft_authenticated,
        store_session: if store_binding.is_some() || store_package {
            "detected"
        } else {
            "required"
        }
        .into(),
        xbox_session: if store_binding.is_some() {
            "wam"
        } else {
            "required"
        }
        .into(),
        minecraft_license,
        native_installer_available,
        store_account_status,
        store_account_xuid,
        store_account_gamertag,
        gaming_services_installed,
        game_input_installed,
        developer_mode,
        wdapp_available,
        wdapp_path,
        architecture: current_architecture(),
        installed_packages: packages,
        launch_ready,
        message,
    })
}

pub async fn refresh_entitlements(state: &AppState) -> AppResult<BedrockRuntimeStatus> {
    bind_store_account(state).await?;
    get_runtime_status(state).await
}

fn native_account_cache_dir(paths: &PortablePaths) -> PathBuf {
    paths.accounts.join("bedrock-native")
}

fn store_account_binding_path(paths: &PortablePaths) -> PathBuf {
    native_account_cache_dir(paths).join("account.json")
}

async fn read_store_account_binding(
    paths: &PortablePaths,
) -> AppResult<Option<BedrockStoreAccountBinding>> {
    let path = store_account_binding_path(paths);
    let bytes = match tokio::fs::read(path).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let binding: BedrockStoreAccountBinding = match serde_json::from_slice(&bytes) {
        Ok(binding) => binding,
        Err(error) => {
            tracing::warn!(%error, "ignoring invalid Bedrock Store account status cache");
            return Ok(None);
        }
    };
    if binding.xuid.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(binding))
}

#[cfg(windows)]
pub async fn bind_store_account(state: &AppState) -> AppResult<BedrockStoreAccountBinding> {
    let helper = find_native_installer(&state.paths).ok_or_else(|| {
        AppError::Unavailable(
            "The licensed Bedrock native installer is not bundled with this SLH build.".into(),
        )
    })?;
    let cache_dir = native_account_cache_dir(&state.paths);
    tokio::fs::create_dir_all(&cache_dir).await?;
    let market = system_store_market();
    let mut command = hidden_command(&helper.to_string_lossy());
    command
        .args([
            "-bind",
            "-cache",
            &cache_dir.to_string_lossy(),
            "-market",
            &market,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let output = tokio::time::timeout(Duration::from_secs(180), command.output())
        .await
        .map_err(|_| {
            AppError::Process(
                "Windows Store/Xbox account authorization timed out after three minutes.".into(),
            )
        })??;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut report = None;
    let mut helper_error = None;
    for line in stdout.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if let Some(code) = value.get("error").and_then(serde_json::Value::as_str) {
            helper_error = Some(code.to_owned());
        }
        if let Ok(candidate) = serde_json::from_value::<NativeAccountReport>(value)
            && candidate.stage == "account"
            && !candidate.xuid.trim().is_empty()
        {
            report = Some(candidate);
        }
    }
    if !output.status.success() || helper_error.is_some() {
        return Err(native_helper_error(
            helper_error.as_deref().unwrap_or("ERR_AUTH_FAILED"),
            &market,
        ));
    }
    let report = report.ok_or_else(|| {
        AppError::Process("The Bedrock account helper finished without an account report.".into())
    })?;
    let binding = BedrockStoreAccountBinding {
        xuid: report.xuid,
        gamertag: report.gamertag,
        release: report.release,
        preview: report.preview,
        market,
        updated_at: Utc::now().to_rfc3339(),
    };
    let path = store_account_binding_path(&state.paths);
    let temporary = path.with_extension("json.slh-part");
    tokio::fs::write(&temporary, serde_json::to_vec_pretty(&binding)?).await?;
    if path.exists() {
        tokio::fs::remove_file(&path).await?;
    }
    tokio::fs::rename(temporary, path).await?;
    Ok(binding)
}

#[cfg(not(windows))]
pub async fn bind_store_account(_state: &AppState) -> AppResult<BedrockStoreAccountBinding> {
    Err(AppError::Unavailable(
        "Bedrock Store/Xbox authorization is available only on Windows.".into(),
    ))
}

pub async fn ensure_store_account_preflight(
    app: &Host,
    state: &AppState,
    channel: &str,
    requires_developer_mode: bool,
) -> AppResult<BedrockStoreAccountBinding> {
    if current_architecture() != "x64" {
        return Err(AppError::Unavailable(
            "Historical Bedrock installation requires Windows x64.".into(),
        ));
    }
    let runtime = get_runtime_status(state).await?;
    if !runtime.native_installer_available {
        return Err(AppError::Unavailable(
            "The licensed Bedrock native installer is missing from this SLH build.".into(),
        ));
    }
    if !runtime.gaming_services_installed || !runtime.game_input_installed {
        return Err(AppError::Unavailable(
            "Install Microsoft Gaming Services and GameInput before downloading this Bedrock version.".into(),
        ));
    }
    if requires_developer_mode && !runtime.developer_mode {
        return Err(AppError::Unavailable(
            "Windows Developer Mode is required to register historical Bedrock versions. Enable it in Windows settings, then retry; the package has not been downloaded yet.".into(),
        ));
    }
    emit_runtime_progress(app, "Проверка аккаунта Microsoft Store/Xbox", 0, 1);
    let binding = bind_store_account(state).await?;
    let entitlement = if channel == "preview" {
        binding.preview.as_str()
    } else {
        binding.release.as_str()
    };
    if entitlement != "authorized" {
        return Err(AppError::Unavailable(format!(
            "Microsoft Store did not confirm a full {channel} Minecraft license for Xbox account {} (status: {entitlement}). The package has not been downloaded.",
            if binding.gamertag.is_empty() {
                &binding.xuid
            } else {
                &binding.gamertag
            }
        )));
    }
    emit_runtime_progress(app, "Лицензия Minecraft подтверждена", 1, 1);
    Ok(binding)
}

/// Download and install the official Windows prerequisites needed by Bedrock.
///
/// GameInput is provisioned through Microsoft's WinGet package. Gaming Services
/// has no supported silent desktop installer, so SLH downloads the official
/// Microsoft/Xbox repair tool, verifies its pinned SHA-256, and starts it with
/// a normal UAC prompt. The tool owns the Store/system installation flow; SLH
/// never modifies Gaming Services registry keys or service registrations.
pub async fn prepare_runtime(
    app: &Host,
    state: &AppState,
    instance_id: Option<&str>,
) -> AppResult<BedrockRuntimeStatus> {
    #[cfg(not(windows))]
    {
        let _ = (app, instance_id);
        return get_runtime_status(state).await;
    }
    #[cfg(windows)]
    {
        let mut errors = Vec::new();
        let mut status = get_runtime_status(state).await?;
        let needs_gdk_tools = if let Some(id) = instance_id {
            instance_requires_gdk_tools(state, id).await?
        } else {
            false
        };
        let total_steps = if needs_gdk_tools { 4 } else { 3 };
        if !status.game_input_installed {
            emit_runtime_progress(app, "Downloading Microsoft GameInput", 1, total_steps);
            if let Err(error) = install_game_input().await {
                tracing::warn!(%error, "automatic GameInput installation failed");
                errors.push(error.to_string());
            }
            status = get_runtime_status(state).await?;
        }
        if !status.gaming_services_installed {
            emit_runtime_progress(app, "Preparing Microsoft Gaming Services", 2, total_steps);
            match download_gaming_repair_tool(state).await {
                Ok(tool) => {
                    if let Err(error) = run_elevated_program(&tool.to_string_lossy(), &[]).await {
                        tracing::warn!(%error, "Gaming Services Repair Tool failed");
                        errors.push(error.to_string());
                    }
                }
                Err(error) => {
                    tracing::warn!(%error, "Gaming Services Repair Tool download failed");
                    errors.push(error.to_string());
                }
            }
            status = get_runtime_status(state).await?;
        }
        if needs_gdk_tools && !status.wdapp_available {
            emit_runtime_progress(app, "Installing Microsoft GDK tools", 3, total_steps);
            if let Err(error) = install_gdk_tools().await {
                tracing::warn!(%error, "automatic Microsoft GDK installation failed");
                errors.push(error.to_string());
            }
            status = get_runtime_status(state).await?;
        }
        if !status.gaming_services_installed {
            // The official tool may defer Store installation until the user
            // confirms it. Open the exact Gaming Services product page so the
            // player sees the native install action instead of a dead-end hint.
            let _ = open_gaming_services_store(app);
        }
        emit_runtime_progress(
            app,
            "Bedrock prerequisites checked",
            total_steps,
            total_steps,
        );
        if let Some(error) = errors.into_iter().next() {
            status.message = Some(
                format!("{} {}", status.message.unwrap_or_default(), error)
                    .trim()
                    .to_owned(),
            );
        }
        Ok(status)
    }
}

#[cfg(windows)]
async fn instance_requires_gdk_tools(state: &AppState, instance_id: &str) -> AppResult<bool> {
    let instance = database::instance(&state.database, instance_id).await?;
    if instance.loader_type != "bedrock" {
        return Ok(false);
    }
    let instance_root = PathBuf::from(&instance.game_dir)
        .parent()
        .ok_or_else(|| AppError::InvalidInput("Instance game directory has no parent".into()))?
        .to_path_buf();
    let version_root = instance_root
        .join("bedrock")
        .join(&instance.minecraft_version);
    for path in [
        version_root.join("runtime.json"),
        version_root.join("package.json"),
    ] {
        if let Ok(bytes) = tokio::fs::read(path).await {
            if let Ok(metadata) = serde_json::from_slice::<BedrockPackageMetadata>(&bytes) {
                return Ok(metadata.package_type == "gdk" && metadata.install_method == "wdapp");
            }
        }
    }
    Ok(false)
}

pub fn open_store(app: &Host) -> AppResult<()> {
    app.opener()
        .open_url(
            "ms-windows-store://pdp/?productid=9NBLGGH2JHXJ",
            None::<&str>,
        )
        .map_err(|error| AppError::Process(format!("Could not open Microsoft Store: {error}")))
}

pub fn open_xbox(app: &Host) -> AppResult<()> {
    let _ = app;
    std::process::Command::new("explorer.exe")
        .arg("shell:AppsFolder\\Microsoft.GamingApp_8wekyb3d8bbwe!Microsoft.Xbox.App")
        .spawn()
        .map(|_| ())
        .map_err(|error| AppError::Process(format!("Could not open the Xbox app: {error}")))
}

fn emit_runtime_progress(app: &Host, message: &str, completed: u64, total: u64) {
    let _ = app.emit(
        crate::host::EventKind::OperationProgress,
        crate::models::ProgressEvent {
            operation_id: "bedrock-runtime".into(),
            instance_id: None,
            operation: "prepare".into(),
            stage: "dependencies".into(),
            message: message.into(),
            completed,
            total: Some(total),
            downloaded_bytes: None,
            total_bytes: None,
        },
    );
}

#[cfg(windows)]
fn open_gaming_services_store(app: &Host) -> AppResult<()> {
    app.opener()
        .open_url(
            &format!("ms-windows-store://pdp/?ProductId={GAMING_SERVICES_STORE_ID}"),
            None::<&str>,
        )
        .map_err(|error| {
            AppError::Process(format!(
                "Could not open Gaming Services in Microsoft Store: {error}"
            ))
        })
}

#[cfg(not(windows))]
fn open_gaming_services_store(_app: &Host) -> AppResult<()> {
    Ok(())
}

pub async fn deploy_downloaded_package(
    app: &Host,
    state: &AppState,
    instance: &Instance,
    package_type: &str,
    install_method: &str,
    channel: &str,
    expected_family_name: Option<&str>,
    package_path: &Path,
    expected_store_xuid: Option<&str>,
) -> AppResult<BedrockPackageMetadata> {
    let architecture = if install_method == "native_msixvc" {
        "x64".into()
    } else if package_type == "gdk" {
        catalog_architecture(&package_path.to_string_lossy())
    } else {
        "bundle".into()
    };
    let base = BedrockPackageMetadata {
        version: instance.minecraft_version.clone(),
        package_type: package_type.into(),
        channel: channel.into(),
        architecture,
        package_path: Some(package_path.to_string_lossy().into_owned()),
        install_method: install_method.into(),
        package_family_name: None,
        app_user_model_id: None,
        install_location: None,
        launch_ready: false,
        status: "downloaded".into(),
        reason: None,
        profile_mode: normalize_profile_mode(&instance.bedrock_profile_mode),
        registered_by_slh: false,
        extracted_root: None,
        xbox_xuid: None,
    };

    if !package_path.is_file() {
        return Err(AppError::NotFound(format!(
            "Bedrock package {}",
            package_path.display()
        )));
    }
    if install_method == "native_msixvc" && current_architecture() != "x64" {
        let mut pending = base;
        pending.reason = Some("Full Bedrock installation supports Windows x64 only; this Windows x86 build remains Java-only.".into());
        return Ok(pending);
    }

    #[cfg(not(windows))]
    {
        let mut pending = base;
        pending.reason = Some("Bedrock packages can only be registered on Windows.".into());
        return Ok(pending);
    }

    #[cfg(windows)]
    {
        if package_type == "uwp" {
            let manifest = match read_appx_manifest(package_path) {
                Ok(manifest) => manifest,
                Err(error) => {
                    let mut pending = base;
                    pending.reason = Some(error.to_string());
                    return Ok(pending);
                }
            };
            tracing::debug!(
                package = %manifest.name,
                version = %manifest.version,
                application_id = %manifest.application_id,
                "validated UWP manifest"
            );
            if !processor_architecture_compatible(&manifest.processor_architecture) {
                let mut pending = base;
                pending.reason = Some(format!(
                    "The UWP package architecture {} is not compatible with {}.",
                    manifest.processor_architecture,
                    current_architecture()
                ));
                return Ok(pending);
            }
            if let Err(error) = install_uwp_package_with_conflict_resolution(
                package_path,
                &manifest.name,
                &manifest.version,
            )
            .await
            {
                let mut pending = base;
                pending.reason = Some(error.to_string());
                return Ok(pending);
            }
            let Some(package) =
                discover_package_by_name_and_version(&manifest.name, &manifest.version).await?
            else {
                let mut pending = base;
                pending.reason = Some("Windows installed the UWP package, but the requested package version could not be read back.".into());
                return Ok(pending);
            };
            return Ok(metadata_from_registered_package(&base, package, false));
        }

        if install_method == "native_msixvc" {
            let expected_family_name = expected_family_name.ok_or_else(|| {
                AppError::InvalidInput(
                    "The native Bedrock package has no expected package family identity.".into(),
                )
            })?;
            let mut runtime = get_runtime_status(state).await?;
            if !runtime.gaming_services_installed || !runtime.game_input_installed {
                runtime = prepare_runtime(app, state, Some(&instance.id)).await?;
            }
            if !runtime.gaming_services_installed {
                let mut pending = base;
                pending.reason = Some(
                    "Microsoft Gaming Services is required before native Bedrock extraction. Install it from Microsoft Store, then retry.".into(),
                );
                return Ok(pending);
            }
            if !runtime.game_input_installed {
                let mut pending = base;
                pending.reason = Some(
                    "Microsoft GameInput is required before native Bedrock extraction. Update Gaming Services or restart Windows, then retry.".into(),
                );
                return Ok(pending);
            }
            let expected_store_xuid = expected_store_xuid.filter(|value| !value.trim().is_empty());
            let Some(expected_store_xuid) = expected_store_xuid else {
                let mut pending = base;
                pending.reason = Some(
                    "The Windows Store/Xbox account was not bound before Bedrock extraction."
                        .into(),
                );
                return Ok(pending);
            };

            let version_root = package_path.parent().ok_or_else(|| {
                AppError::InvalidInput("Bedrock package path has no version directory.".into())
            })?;
            let extracted_root = version_root.join("extracted");
            let report = match extract_native_msixvc(
                app,
                state,
                package_path,
                &extracted_root,
                expected_store_xuid,
            )
            .await
            {
                Ok(report) => report,
                Err(error) => {
                    let mut pending = base;
                    pending.status = "failed".into();
                    pending.reason = Some(error.to_string());
                    return Ok(pending);
                }
            };
            if !report.license_type.eq_ignore_ascii_case("full") {
                let mut pending = base;
                pending.status = "failed".into();
                pending.reason = Some("Microsoft Store returned a non-full Minecraft license. The trial or wrong account cannot install Bedrock.".into());
                return Ok(pending);
            }
            if let Err(error) =
                register_native_msixvc_folder(app, &extracted_root, expected_family_name).await
            {
                let mut pending = base;
                pending.status = "failed".into();
                pending.reason = Some(error.to_string());
                return Ok(pending);
            }
            let Some(package) = discover_package_by_family_and_version(
                expected_family_name,
                &instance.minecraft_version,
                channel,
            )
            .await?
            else {
                let mut pending = base;
                pending.status = "failed".into();
                pending.reason = Some("Windows registered the extracted Bedrock files, but the expected package identity was not found afterwards.".into());
                return Ok(pending);
            };
            let mut installed = metadata_from_registered_package(&base, package, true);
            installed.install_method = "native_msixvc".into();
            installed.package_family_name = Some(expected_family_name.into());
            installed.extracted_root = Some(extracted_root.to_string_lossy().into_owned());
            installed.xbox_xuid = Some(expected_store_xuid.to_owned());
            installed.package_path = Some(package_path.to_string_lossy().into_owned());
            installed.reason = if installed.launch_ready {
                None
            } else {
                Some("The extracted Bedrock package has no launchable application identity.".into())
            };
            installed.status = if installed.launch_ready {
                "launchable".into()
            } else {
                "installed".into()
            };
            return Ok(installed);
        }

        if package_type == "gdk" && install_method == "wdapp" {
            let mut runtime = get_runtime_status(state).await?;
            if !runtime.gaming_services_installed || !runtime.game_input_installed {
                runtime = prepare_runtime(app, state, Some(&instance.id)).await?;
            }
            if !runtime.gaming_services_installed {
                let mut pending = base;
                pending.reason = Some(
                    "Microsoft Gaming Services is required before a GDK package can be installed."
                        .into(),
                );
                return Ok(pending);
            }
            let wdapp = if let Some(path) = runtime.wdapp_path {
                path
            } else {
                emit_runtime_progress(app, "Installing Microsoft GDK tools", 1, 1);
                if let Err(error) = install_gdk_tools().await {
                    let mut pending = base;
                    pending.reason = Some(error.to_string());
                    return Ok(pending);
                }
                let Some(path) = find_wdapp().await? else {
                    let mut pending = base;
                    pending.reason = Some(
                        "Microsoft GDK was installed, but wdapp.exe could not be found. Restart SLH and retry.".into(),
                    );
                    return Ok(pending);
                };
                path
            };
            if !gaming_services_present().await? {
                let mut pending = base;
                pending.reason = Some(
                    "Microsoft Gaming Services is required before a GDK package can be installed."
                        .into(),
                );
                return Ok(pending);
            }
            if let Err(error) = install_gdk_package(&wdapp, package_path).await {
                let mut pending = base;
                if is_store_submission_package_error(&error.to_string()) {
                    pending.status = "unavailable".into();
                }
                pending.reason = Some(error.to_string());
                return Ok(pending);
            }
            let packages = discover_registered_packages().await?.unwrap_or_default();
            let package = packages.into_iter().find(|package| {
                package.channel == channel
                    && versions_match(&instance.minecraft_version, &package.version)
            });
            let Some(package) = package else {
                let mut pending = base;
                pending.reason = Some(
                    "wdapp completed, but Windows did not register the requested Minecraft Bedrock version.".into(),
                );
                return Ok(pending);
            };
            let mut installed = base;
            installed.package_family_name = Some(package.package_family_name);
            installed.app_user_model_id = package.app_user_model_id;
            installed.install_location = Some(package.install_location);
            installed.launch_ready = installed.app_user_model_id.is_some();
            installed.status = if installed.launch_ready {
                "launchable"
            } else {
                "installed"
            }
            .into();
            installed.reason = (!installed.launch_ready)
                .then(|| "The GDK package has no launchable application identity.".into());
            return Ok(installed);
        }
    }

    Err(AppError::InvalidInput(format!(
        "Unsupported Bedrock package type: {package_type}"
    )))
}

/// Adopt the exact package that Microsoft Store has already registered for
/// this Windows user.  This is the ordinary Bedrock path: no package download,
/// no `wdapp`, no loose-file registration, and no launcher-side entitlement
/// guesswork.  Windows and Microsoft Store enforce ownership when the app is
/// activated.
pub async fn adopt_registered_store_package(
    instance: &Instance,
    version_root: &Path,
) -> AppResult<Option<BedrockPackageMetadata>> {
    #[cfg(not(windows))]
    {
        let _ = (instance, version_root);
        return Ok(None);
    }
    #[cfg(windows)]
    {
        let packages = discover_registered_packages().await?.unwrap_or_default();
        let Some(package) = packages.into_iter().find(|package| {
            is_registered_store_package(package)
                && (instance.minecraft_version == display_store_version(&package.version)
                    || versions_match(&instance.minecraft_version, &package.version))
        }) else {
            return Ok(None);
        };
        let metadata = BedrockPackageMetadata {
            version: instance.minecraft_version.clone(),
            package_type: if package.name.eq_ignore_ascii_case("Microsoft.MinecraftUWP") {
                "uwp".into()
            } else {
                "gdk".into()
            },
            channel: package.channel.clone(),
            architecture: current_architecture(),
            package_path: None,
            install_method: "registered_store".into(),
            package_family_name: Some(package.package_family_name),
            app_user_model_id: package.app_user_model_id,
            install_location: Some(package.install_location),
            launch_ready: true,
            status: "launchable".into(),
            reason: None,
            // Store-owned data is already managed and updated by Windows.
            // Moving LocalState for an isolated launcher profile can prevent
            // the official application from starting, so keep this path
            // shared and predictable.
            profile_mode: "shared".into(),
            registered_by_slh: false,
            extracted_root: None,
            xbox_xuid: None,
        };
        tokio::fs::create_dir_all(version_root).await?;
        write_metadata(version_root, &metadata).await?;
        Ok(Some(metadata))
    }
}

pub async fn launch_instance(
    app: &Host,
    state: &AppState,
    instance_id: &str,
) -> AppResult<LaunchResponse> {
    let instance = database::instance(&state.database, instance_id).await?;
    if instance.status != "installed" && instance.status != "launching" {
        return Err(AppError::Conflict(format!(
            "{} is not installed yet. Current status: {}",
            instance.name, instance.status
        )));
    }
    // Bedrock authenticates through the Windows Store/Xbox session, not the
    // Java launcher token. Keep an active launcher account only as optional
    // launch-history attribution.
    let account_id = database::active_account(&state.database)
        .await?
        .filter(|account| account.provider == "microsoft")
        .map(|account| account.id);

    let bedrock_guard = state
        .bedrock_profile_lock
        .clone()
        .try_lock_owned()
        .map_err(|_| {
            AppError::Conflict(
                "Another Bedrock instance is already using the Windows profile data.".into(),
            )
        })?;
    {
        let mut running = state.running_instances.write().await;
        if !running.insert(instance.id.clone()) {
            return Err(AppError::Conflict(
                "This instance is already running.".into(),
            ));
        }
    }
    sqlx::query("UPDATE instances SET status = 'launching' WHERE id = ? AND status = 'installed'")
        .bind(&instance.id)
        .execute(&state.database)
        .await?;
    let _ = app.emit(
        crate::host::EventKind::LaunchState,
        serde_json::json!({ "instanceId": instance.id, "state": "launching" }),
    );
    let setup_result = prepare_launch(app, state, &instance).await;
    let prepared = match setup_result {
        Ok(prepared) => prepared,
        Err(error) => {
            state.running_instances.write().await.remove(&instance.id);
            drop(bedrock_guard);
            let _ = sqlx::query(
                "UPDATE instances SET status = 'installed' WHERE id = ? AND status = 'launching'",
            )
            .bind(&instance.id)
            .execute(&state.database)
            .await;
            return Err(error);
        }
    };

    let PreparedLaunch {
        launch_id,
        log_path,
        process_id,
        started_at,
        profile_session,
        hide_on_launch,
        restore_on_exit,
    } = prepared;
    state
        .launch_processes
        .write()
        .await
        .insert(instance.id.clone(), process_id);
    sqlx::query(
        "INSERT INTO launch_history(id, instance_id, account_id, started_at, result, log_path, process_id) VALUES (?, ?, ?, ?, 'running', ?, ?)",
    )
    .bind(&launch_id)
    .bind(&instance.id)
    .bind(account_id.as_deref())
    .bind(started_at.to_rfc3339())
    .bind(log_path.to_string_lossy().into_owned())
    .bind(i64::from(process_id))
    .execute(&state.database)
    .await?;
    sqlx::query("UPDATE instances SET status = 'running', last_launched_at = ? WHERE id = ?")
        .bind(started_at.to_rfc3339())
        .bind(&instance.id)
        .execute(&state.database)
        .await?;
    let _ = app.emit(
        crate::host::EventKind::LaunchState,
        serde_json::json!({ "launchId": launch_id, "instanceId": instance.id, "state": "running" }),
    );

    if hide_on_launch {
        if let Some(window) = app.window() {
            let _ = window.hide();
        }
    }
    let response = LaunchResponse {
        launch_id: launch_id.clone(),
        instance_id: instance.id.clone(),
        status: "running".into(),
        log_path: log_path.to_string_lossy().into_owned(),
        used_offline_fallback: false,
    };

    let app = app.clone();
    let state = state.clone();
    let instance_id = instance.id.clone();
    tokio::spawn(async move {
        monitor_bedrock_process(
            app,
            state,
            instance_id,
            launch_id,
            process_id,
            started_at,
            log_path,
            profile_session,
            hide_on_launch,
            restore_on_exit,
            bedrock_guard,
        )
        .await;
    });
    Ok(response)
}

struct PreparedLaunch {
    launch_id: String,
    log_path: PathBuf,
    process_id: u32,
    started_at: chrono::DateTime<Utc>,
    profile_session: Option<ProfileSession>,
    hide_on_launch: bool,
    restore_on_exit: bool,
}

async fn prepare_launch(
    app: &Host,
    state: &AppState,
    instance: &Instance,
) -> AppResult<PreparedLaunch> {
    let general = database::setting(&state.database, "general").await?;
    let hide_on_launch = general
        .get("hideOnLaunch")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let restore_on_exit = general
        .get("restoreOnExit")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(true);
    let root = PathBuf::from(&instance.game_dir)
        .parent()
        .ok_or_else(|| AppError::InvalidInput("Instance game directory has no parent".into()))?
        .to_path_buf();
    let version_root = root.join("bedrock").join(&instance.minecraft_version);
    let metadata_path = version_root.join("runtime.json");
    let metadata = if let Ok(bytes) = tokio::fs::read(&metadata_path).await {
        serde_json::from_slice::<BedrockPackageMetadata>(&bytes)?
    } else if let Ok(bytes) = tokio::fs::read(version_root.join("package.json")).await {
        serde_json::from_slice::<BedrockPackageMetadata>(&bytes).map_err(|_| {
            AppError::Unavailable("This Bedrock package was downloaded by an older SLH build and must be installed again.".into())
        })?
    } else {
        return Err(AppError::Unavailable(
            "Bedrock package metadata is missing. Install this version before launching.".into(),
        ));
    };
    if !metadata.launch_ready || metadata.app_user_model_id.is_none() {
        return Err(AppError::Unavailable(metadata.reason.unwrap_or_else(
            || "Bedrock is downloaded but not registered for this Windows user.".into(),
        )));
    }
    if metadata.package_type == "uwp" && metadata.registered_by_slh {
        #[cfg(windows)]
        if !developer_mode_enabled().await? {
            return Err(AppError::Unavailable(
                "Windows Developer Mode is required for this downloaded UWP package.".into(),
            ));
        }
    }
    let registered_store_package = metadata.install_method == "registered_store";
    if !registered_store_package {
        let runtime = get_runtime_status(state).await?;
        if !runtime.gaming_services_installed {
            return Err(AppError::Unavailable(
                "Microsoft Gaming Services is required for Bedrock. Open Microsoft Store and install it.".into(),
            ));
        }
        if !runtime.game_input_installed {
            return Err(AppError::Unavailable(
                "Microsoft GameInput is required for Bedrock. Update Gaming Services, then retry."
                    .into(),
            ));
        }
        if metadata.install_method == "native_msixvc" {
            let binding = read_store_account_binding(&state.paths).await?.ok_or_else(|| {
                AppError::Unavailable(
                    "This Bedrock version is bound to a Windows Store/Xbox account. Bind that account again before launching.".into(),
                )
            })?;
            let expected_xuid = metadata.xbox_xuid.as_deref().ok_or_else(|| {
                AppError::Unavailable(
                    "This native Bedrock installation has no Xbox account binding. Reinstall it after binding Store/Xbox.".into(),
                )
            })?;
            if binding.xuid != expected_xuid {
                return Err(AppError::Conflict(
                    "The bound Windows Store/Xbox account does not match the account that installed this Bedrock version.".into(),
                ));
            }
        } else if runtime.store_session != "detected" || runtime.minecraft_license == "unknown" {
            return Err(AppError::Unavailable(
                "Microsoft Store did not confirm a Minecraft license for this Windows user. Open Store/Xbox with the licensed Microsoft account, then refresh Bedrock status.".into(),
            ));
        }
    }
    #[cfg(windows)]
    {
        let existing = list_bedrock_pids().await?;
        if !existing.is_empty() {
            return Err(AppError::Conflict(
                "Minecraft for Windows is already running. Close it before launching another Bedrock profile.".into(),
            ));
        }
    }

    let profile_session = if !registered_store_package
        && normalize_profile_mode(&instance.bedrock_profile_mode) == "isolated"
    {
        let package_family_name = metadata.package_family_name.as_deref().ok_or_else(|| {
            AppError::Unavailable(
                "The registered Bedrock package has no Package Family Name.".into(),
            )
        })?;
        prepare_profile_session(
            &root,
            &instance.id,
            package_family_name,
            &instance.minecraft_version,
        )
        .await?
    } else {
        None
    };

    let launch_id = Uuid::new_v4().to_string();
    let log_path = root
        .join("logs")
        .join(format!("launch-{}.log", Utc::now().format("%Y%m%d-%H%M%S")));
    if let Some(parent) = log_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let _ = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .await?;
    let before = list_bedrock_pids().await.unwrap_or_default();
    let activation_result = activate_package(&metadata).await;
    let activated_pid = match activation_result {
        Ok(pid) => pid,
        Err(error) => {
            if let Some(session) = &profile_session {
                let _ = restore_profile_session(session).await;
            }
            return Err(error);
        }
    };
    // ActivateApplication can return a broker/runtime PID before the actual
    // Minecraft.Windows.exe process exists. Treating any live PID as the game
    // made SLH show “running” forever when the app itself had immediately
    // failed to start. Accept the PID only after it is confirmed to belong to
    // the Bedrock executable; otherwise wait for the real process.
    let current_bedrock_pids = list_bedrock_pids().await.unwrap_or_default();
    let process_id = if activated_pid.is_some_and(|pid| current_bedrock_pids.contains(&pid)) {
        activated_pid.expect("checked above")
    } else {
        match wait_for_new_bedrock_pid(&before, Duration::from_secs(120)).await {
            Ok(process_id) => process_id,
            Err(error) => {
                if let Some(session) = &profile_session {
                    let _ = restore_profile_session(session).await;
                }
                return Err(error);
            }
        }
    };
    let started_at = Utc::now();
    let _ = app.emit(
        crate::host::EventKind::LaunchState,
        serde_json::json!({ "instanceId": instance.id, "state": "launching" }),
    );
    Ok(PreparedLaunch {
        launch_id,
        log_path,
        process_id,
        started_at,
        profile_session,
        hide_on_launch,
        restore_on_exit,
    })
}

async fn monitor_bedrock_process(
    app: Host,
    state: AppState,
    instance_id: String,
    launch_id: String,
    process_id: u32,
    started_at: chrono::DateTime<Utc>,
    log_path: PathBuf,
    profile_session: Option<ProfileSession>,
    hide_on_launch: bool,
    restore_on_exit: bool,
    _bedrock_guard: tokio::sync::OwnedMutexGuard<()>,
) {
    loop {
        if !process_is_alive(process_id) {
            break;
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    let ended_at = Utc::now();
    let duration = (ended_at - started_at).num_seconds().max(0);
    let was_killed = state.kill_requested.write().await.remove(&instance_id);
    let result = if was_killed { "killed" } else { "exited" };
    if let Some(session) = profile_session {
        if let Err(error) = restore_profile_session(&session).await {
            tracing::error!(%error, %instance_id, "Bedrock profile restoration failed");
            let _ = app.emit(
                crate::host::EventKind::SyncError,
                serde_json::json!({ "instanceId": instance_id, "message": error.to_string() }),
            );
        }
    }
    let _ = append_log_line(&log_path, &format!("Bedrock process ended: {result}."));
    let _ = sqlx::query(
        "UPDATE launch_history SET ended_at = ?, duration_seconds = ?, result = ? WHERE id = ?",
    )
    .bind(ended_at.to_rfc3339())
    .bind(duration)
    .bind(result)
    .bind(&launch_id)
    .execute(&state.database)
    .await;
    let _ = sqlx::query(
        "UPDATE instances SET status = 'installed', last_played_at = ?, playtime_seconds = playtime_seconds + ? WHERE id = ?",
    )
    .bind(ended_at.to_rfc3339())
    .bind(duration)
    .bind(&instance_id)
    .execute(&state.database)
    .await;
    state.running_instances.write().await.remove(&instance_id);
    state.launch_processes.write().await.remove(&instance_id);
    let _ = app.emit(
        crate::host::EventKind::LaunchState,
        serde_json::json!({
            "launchId": launch_id,
            "instanceId": instance_id,
            "state": result,
            "durationSeconds": duration
        }),
    );
    if hide_on_launch && restore_on_exit {
        if let Some(window) = app.window() {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

async fn activate_package(metadata: &BedrockPackageMetadata) -> AppResult<Option<u32>> {
    let aumid = metadata
        .app_user_model_id
        .as_deref()
        .ok_or_else(|| AppError::Unavailable("Bedrock package has no AUMID.".into()))?;
    #[cfg(not(windows))]
    {
        let _ = aumid;
        return Err(AppError::Unavailable(
            "Bedrock can only launch on Windows.".into(),
        ));
    }
    #[cfg(windows)]
    {
        // A catalog GDK version can be adopted from an already registered
        // Microsoft Store package. Such metadata has no local .msixvc path
        // and must use the normal Windows AUMID activation path. wdapp is
        // only allowed for explicitly marked development packages.
        if gdk_package_requires_wdapp(metadata) {
            let Some(wdapp) = find_wdapp().await? else {
                return Err(AppError::Unavailable(
                    "wdapp is required to launch this GDK package.".into(),
                ));
            };
            let mut command = hidden_command(&wdapp);
            command.args(["launch", aumid]);
            let mut child = command
                .spawn()
                .map_err(|error| AppError::Process(format!("Could not start wdapp: {error}")))?;
            let status = tokio::time::timeout(Duration::from_secs(30), child.wait()).await;
            if matches!(status, Ok(Ok(status)) if !status.success()) {
                let aumid = aumid.to_owned();
                let pid = tokio::task::spawn_blocking(move || activate_application_com(&aumid))
                    .await
                    .map_err(|error| {
                        AppError::Process(format!("Activation worker failed: {error}"))
                    })??;
                return Ok(Some(pid));
            }
            return Ok(None);
        }
        let activation = tokio::task::spawn_blocking({
            let aumid = aumid.to_owned();
            move || activate_application_com(&aumid)
        })
        .await
        .map_err(|error| AppError::Process(format!("Activation worker failed: {error}")))?;
        match activation {
            Ok(pid) => Ok(Some(pid)),
            // Explorer uses the same registered AUMID path as the Start menu.
            // It is a safe fallback for Store-owned packages when a local COM
            // activation broker is temporarily unavailable.
            Err(error) if metadata.install_method == "registered_store" => {
                tracing::warn!(%error, %aumid, "COM Bedrock activation failed; retrying through AppsFolder");
                let mut command = hidden_command("explorer.exe");
                command.arg(format!("shell:AppsFolder\\{aumid}"));
                command.spawn().map_err(|spawn_error| {
                    AppError::Process(format!(
                        "Windows could not activate the registered Minecraft Store package: {spawn_error}"
                    ))
                })?;
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }
}

fn gdk_package_requires_wdapp(metadata: &BedrockPackageMetadata) -> bool {
    metadata.package_type == "gdk" && metadata.install_method == "wdapp"
}

#[cfg(windows)]
fn activate_application_com(aumid: &str) -> AppResult<u32> {
    use windows::Win32::System::Com::{
        CLSCTX_LOCAL_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize,
    };
    use windows::Win32::UI::Shell::{
        AO_NONE, ApplicationActivationManager, IApplicationActivationManager,
    };
    use windows::core::HSTRING;

    let initialized = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    if initialized.is_err() {
        return Err(AppError::Process(format!(
            "COM initialization failed: {initialized:?}"
        )));
    }
    let result = (|| unsafe {
        let manager: IApplicationActivationManager =
            CoCreateInstance(&ApplicationActivationManager, None, CLSCTX_LOCAL_SERVER).map_err(
                |error| {
                    AppError::Process(format!("Could not create app activation manager: {error}"))
                },
            )?;
        manager
            .ActivateApplication(&HSTRING::from(aumid), &HSTRING::new(), AO_NONE)
            .map_err(|error| {
                AppError::Process(format!("Windows rejected Bedrock activation: {error}"))
            })
    })();
    unsafe {
        CoUninitialize();
    }
    result
}

async fn prepare_profile_session(
    instance_root: &Path,
    instance_id: &str,
    package_family_name: &str,
    version: &str,
) -> AppResult<Option<ProfileSession>> {
    let local_app_data = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .ok_or_else(|| AppError::Unavailable("LOCALAPPDATA is not available.".into()))?;
    let system_profile = local_app_data
        .join("Packages")
        .join(package_family_name)
        .join("LocalState")
        .join("games")
        .join("com.mojang");
    let profile_root = instance_root.join("bedrock").join("profiles").join(version);
    let instance_profile = profile_root.join("com.mojang");
    let official_package = package_family_name
        .to_ascii_lowercase()
        .ends_with("_8wekyb3d8bbwe");
    if official_package
        || contains_windows_protected_files(&system_profile)?
        || contains_windows_protected_files(&instance_profile)?
    {
        tracing::info!(
            package_family_name,
            "Using the shared Bedrock LocalState because Windows protects official package data"
        );
        return Ok(None);
    }
    let backup_profile = instance_root
        .join("bedrock")
        .join("profile-backups")
        .join(format!(
            "{}-{}",
            Utc::now().format("%Y%m%d-%H%M%S"),
            Uuid::new_v4()
        ));
    let journal_path = instance_root.join("bedrock").join(PROFILE_JOURNAL_NAME);
    tokio::fs::create_dir_all(&profile_root).await?;
    if !instance_profile.exists() {
        tokio::fs::create_dir_all(&instance_profile).await?;
    }
    let had_original = system_profile.exists();
    let mut journal = ProfileJournal {
        instance_id: instance_id.into(),
        system_profile: system_profile.to_string_lossy().into_owned(),
        instance_profile: instance_profile.to_string_lossy().into_owned(),
        backup_profile: backup_profile.to_string_lossy().into_owned(),
        had_original,
        phase: "prepared".into(),
    };
    write_journal(&journal_path, &journal).await?;
    if had_original {
        copy_tree(&system_profile, &backup_profile).await?;
    }
    journal.phase = "backed_up".into();
    write_journal(&journal_path, &journal).await?;
    if system_profile.exists() {
        tokio::fs::remove_dir_all(&system_profile).await?;
    }
    copy_tree(&instance_profile, &system_profile).await?;
    journal.phase = "swapped".into();
    write_journal(&journal_path, &journal).await?;
    Ok(Some(ProfileSession {
        journal_path,
        system_profile,
        instance_profile,
        backup_profile,
        had_original,
    }))
}

async fn restore_profile_session(session: &ProfileSession) -> AppResult<()> {
    if session.system_profile.exists() {
        let current = session
            .instance_profile
            .with_file_name("com.mojang.after-launch");
        if current.exists() {
            tokio::fs::remove_dir_all(&current).await?;
        }
        copy_tree(&session.system_profile, &current).await?;
        tokio::fs::remove_dir_all(&session.system_profile).await?;
        if session.instance_profile.exists() {
            tokio::fs::remove_dir_all(&session.instance_profile).await?;
        }
        tokio::fs::rename(&current, &session.instance_profile).await?;
    }
    if session.system_profile.exists() {
        tokio::fs::remove_dir_all(&session.system_profile).await?;
    }
    if session.had_original {
        copy_tree(&session.backup_profile, &session.system_profile).await?;
    }
    if session.backup_profile.exists() {
        tokio::fs::remove_dir_all(&session.backup_profile).await?;
    }
    if session.journal_path.exists() {
        tokio::fs::remove_file(&session.journal_path).await?;
    }
    Ok(())
}

pub fn recover_profile_journals(paths: &PortablePaths) -> AppResult<()> {
    if !paths.instances.is_dir() {
        return Ok(());
    }
    #[cfg(windows)]
    let mut bedrock_running = None;
    for entry in std::fs::read_dir(&paths.instances)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let journal_path = entry.path().join("bedrock").join(PROFILE_JOURNAL_NAME);
        if !journal_path.is_file() {
            continue;
        }
        #[cfg(windows)]
        if *bedrock_running.get_or_insert_with(bedrock_process_exists_sync) {
            // Only inspect the OS process list when a recovery journal exists.
            // Never swap a profile still in use by a surviving Bedrock process.
            return Ok(());
        }
        let bytes = std::fs::read(&journal_path)?;
        let journal: ProfileJournal = serde_json::from_slice(&bytes)?;
        if matches!(journal.phase.as_str(), "backed_up" | "swapped") {
            let system = PathBuf::from(&journal.system_profile);
            let profile = PathBuf::from(&journal.instance_profile);
            let backup = PathBuf::from(&journal.backup_profile);
            if journal.phase == "swapped" && system.exists() {
                let recovered = profile.with_file_name("com.mojang.crash-recovery");
                if recovered.exists() {
                    std::fs::remove_dir_all(&recovered)?;
                }
                copy_tree_sync(&system, &recovered)?;
                std::fs::remove_dir_all(&system)?;
                if profile.exists() {
                    std::fs::remove_dir_all(&profile)?;
                }
                std::fs::rename(&recovered, &profile)?;
            }
            if journal.had_original && backup.exists() && !system.exists() {
                copy_tree_sync(&backup, &system)?;
            }
            if backup.exists() {
                std::fs::remove_dir_all(&backup)?;
            }
        }
        std::fs::remove_file(journal_path)?;
    }
    Ok(())
}

#[cfg(windows)]
fn bedrock_process_exists_sync() -> bool {
    use std::os::windows::process::CommandExt;
    std::process::Command::new("tasklist")
        .args(["/FI", "IMAGENAME eq Minecraft.Windows.exe", "/NH"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()
        .is_some_and(|output| {
            output.status.success()
                && String::from_utf8_lossy(&output.stdout)
                    .to_ascii_lowercase()
                    .contains("minecraft.windows.exe")
        })
}

fn contains_windows_protected_files(root: &Path) -> AppResult<bool> {
    if !root.is_dir() {
        return Ok(false);
    }
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(directory)? {
            let entry = entry?;
            let path = entry.path();
            if entry.file_type()?.is_dir() {
                pending.push(path);
            } else if entry.file_type()?.is_file() && is_windows_protected_file(&path) {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

fn is_windows_protected_file(path: &Path) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        return std::fs::metadata(path)
            .map(|metadata| metadata.file_attributes() & FILE_ATTRIBUTE_ENCRYPTED != 0)
            .unwrap_or(false);
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        false
    }
}

async fn copy_tree(source: &Path, destination: &Path) -> AppResult<()> {
    if !source.exists() {
        tokio::fs::create_dir_all(destination).await?;
        return Ok(());
    }
    let mut pending = vec![(source.to_path_buf(), destination.to_path_buf())];
    while let Some((source_dir, destination_dir)) = pending.pop() {
        tokio::fs::create_dir_all(&destination_dir).await?;
        let mut entries = tokio::fs::read_dir(&source_dir).await?;
        while let Some(entry) = entries.next_entry().await? {
            let source_path = entry.path();
            let destination_path = destination_dir.join(entry.file_name());
            let file_type = entry.file_type().await?;
            if file_type.is_dir() {
                pending.push((source_path, destination_path));
            } else if file_type.is_file() && !is_windows_protected_file(&source_path) {
                if let Some(parent) = destination_path.parent() {
                    tokio::fs::create_dir_all(parent).await?;
                }
                tokio::fs::copy(&source_path, &destination_path).await?;
            }
        }
    }
    Ok(())
}

fn copy_tree_sync(source: &Path, destination: &Path) -> AppResult<()> {
    if !source.exists() {
        std::fs::create_dir_all(destination)?;
        return Ok(());
    }
    std::fs::create_dir_all(destination)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let from = entry.path();
        let to = destination.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree_sync(&from, &to)?;
        } else if entry.file_type()?.is_file() && !is_windows_protected_file(&from) {
            std::fs::copy(from, to)?;
        }
    }
    Ok(())
}

async fn write_journal(path: &Path, journal: &ProfileJournal) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let temp = path.with_extension("json.tmp");
    tokio::fs::write(&temp, serde_json::to_vec_pretty(journal)?).await?;
    replace_journal_file(&temp, path)?;
    Ok(())
}

#[cfg(windows)]
fn replace_journal_file(temp: &Path, destination: &Path) -> AppResult<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };
    let source = temp
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let target = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    unsafe {
        MoveFileExW(
            windows::core::PCWSTR(source.as_ptr()),
            windows::core::PCWSTR(target.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    }
    .map_err(|error| {
        AppError::Io(std::io::Error::other(format!(
            "Could not replace Bedrock profile journal: {error}"
        )))
    })
}

#[cfg(not(windows))]
fn replace_journal_file(temp: &Path, destination: &Path) -> AppResult<()> {
    std::fs::rename(temp, destination)?;
    Ok(())
}

async fn write_metadata(version_root: &Path, metadata: &BedrockPackageMetadata) -> AppResult<()> {
    tokio::fs::create_dir_all(version_root).await?;
    let bytes = serde_json::to_vec_pretty(metadata)?;
    tokio::fs::write(version_root.join("runtime.json"), &bytes).await?;
    tokio::fs::write(version_root.join("package.json"), bytes).await?;
    Ok(())
}

pub async fn write_download_metadata(
    version_root: &Path,
    metadata: &BedrockPackageMetadata,
) -> AppResult<()> {
    write_metadata(version_root, metadata).await
}

fn normalize_profile_mode(value: &str) -> String {
    if value == "isolated" {
        "isolated".into()
    } else {
        "shared".into()
    }
}

fn processor_architecture_compatible(value: &str) -> bool {
    let value = value.to_ascii_lowercase();
    value == "neutral"
        || value == "msil"
        || value == current_architecture()
        || (current_architecture() == "x64" && value == "x86")
        || (current_architecture() == "arm64" && matches!(value.as_str(), "x64" | "x86"))
}

pub(crate) fn versions_match(requested: &str, installed: &str) -> bool {
    let requested = version_variants(requested);
    let installed = version_variants(installed);
    !requested.is_empty()
        && !installed.is_empty()
        && requested.iter().any(|left| {
            installed
                .iter()
                .any(|right| right.contains(left) || left.contains(right))
        })
}

fn version_variants(value: &str) -> Vec<String> {
    let parts = value
        .split('.')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    let digits: String = value.chars().filter(char::is_ascii_digit).collect();
    let mut variants = Vec::new();
    if !digits.is_empty() {
        variants.push(digits);
    }
    let trimmed_compact = parts
        .iter()
        .copied()
        .rev()
        .skip_while(|part| *part == "0")
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>();
    let trimmed_compact = trimmed_compact.join("");
    if !trimmed_compact.is_empty() && !variants.contains(&trimmed_compact) {
        variants.push(trimmed_compact);
    }
    if parts.len() >= 4 {
        let compact_tail = parts[2..].join("");
        let prefix = parts[..2].join("");
        let compact = format!("{prefix}{compact_tail}");
        if !compact.is_empty() && !variants.contains(&compact) {
            variants.push(compact);
        }
        let legacy = format!("{prefix}{}0{}", parts[2], parts[3]);
        if !legacy.is_empty() && !variants.contains(&legacy) {
            variants.push(legacy);
        }
    }
    if parts.len() >= 3
        && parts[0]
            .parse::<u32>()
            .ok()
            .is_some_and(|major| major >= 20)
    {
        let shifted = format!("1{}{}", parts[0], parts[1..].join(""));
        if !shifted.is_empty() && !variants.contains(&shifted) {
            variants.push(shifted);
        }
    }
    variants
}

fn manifest_attribute(tag: &str, name: &str) -> Option<String> {
    let double = Regex::new(&format!(
        r#"(?is)\b{}\s*=\s*"([^"]*)""#,
        regex::escape(name)
    ))
    .ok()?;
    if let Some(value) = double.captures(tag).and_then(|capture| capture.get(1)) {
        return Some(value.as_str().to_owned());
    }
    let single = Regex::new(&format!(
        r#"(?is)\b{}\s*=\s*'([^']*)'"#,
        regex::escape(name)
    ))
    .ok()?;
    single
        .captures(tag)
        .and_then(|capture| capture.get(1))
        .map(|value| value.as_str().to_owned())
}

fn parse_appx_manifest(xml: &str) -> AppResult<AppxManifestInfo> {
    let identity = Regex::new(r"(?is)<Identity\b[^>]*>")
        .expect("identity expression is valid")
        .find(xml)
        .map(|match_| match_.as_str())
        .ok_or_else(|| {
            AppError::InvalidInput("AppxManifest.xml has no Identity element.".into())
        })?;
    let application = Regex::new(r"(?is)<Application\b[^>]*>")
        .expect("application expression is valid")
        .find(xml)
        .map(|match_| match_.as_str())
        .ok_or_else(|| {
            AppError::InvalidInput("AppxManifest.xml has no Application element.".into())
        })?;
    Ok(AppxManifestInfo {
        name: manifest_attribute(identity, "Name")
            .ok_or_else(|| AppError::InvalidInput("UWP identity has no package name.".into()))?,
        version: manifest_attribute(identity, "Version").unwrap_or_default(),
        processor_architecture: manifest_attribute(identity, "ProcessorArchitecture")
            .unwrap_or_else(|| "neutral".into()),
        application_id: manifest_attribute(application, "Id")
            .ok_or_else(|| AppError::InvalidInput("UWP application has no Id.".into()))?,
    })
}

fn read_appx_manifest(package_path: &Path) -> AppResult<AppxManifestInfo> {
    let file = File::open(package_path)?;
    let mut archive = zip::ZipArchive::new(file)?;
    if archive.len() == 0 || archive.len() > MAX_APPX_ENTRIES {
        return Err(AppError::Security(
            "The AppX package contains an invalid number of files.".into(),
        ));
    }
    let mut entry = archive.by_name("AppxManifest.xml")?;
    let mut xml = String::new();
    entry.read_to_string(&mut xml)?;
    parse_appx_manifest(&xml)
}

fn find_native_installer(paths: &PortablePaths) -> Option<PathBuf> {
    let target_name = if cfg!(target_arch = "x86") {
        "slh-bedrock-native-i686-pc-windows-msvc.exe"
    } else {
        "slh-bedrock-native-x86_64-pc-windows-msvc.exe"
    };
    let mut candidates = Vec::new();
    if let Ok(path) = std::env::var("SLH_BEDROCK_NATIVE") {
        candidates.push(PathBuf::from(path));
    }
    let mut directories = Vec::new();
    if let Some(resources) = &paths.bundled_resources {
        directories.push(resources.join("binaries"));
        directories.push(resources.clone());
    }
    directories.extend([
        paths.executable_dir.clone(),
        paths.executable_dir.join("binaries"),
        paths.root.join("resources"),
        paths
            .root
            .join("resources")
            .join("../../src-tauri/binaries"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../src-tauri/binaries"),
    ]);
    for directory in directories {
        candidates.push(directory.join("slh-bedrock-native.exe"));
        candidates.push(directory.join(target_name));
    }
    candidates.into_iter().find(|path| path.is_file())
}

#[derive(Default)]
struct NativeBindingObservation {
    account_mismatch: bool,
    license_missing: bool,
    native_ready: bool,
}

fn observe_native_bindings(
    paths: &PortablePaths,
    active_xuid: Option<&str>,
) -> NativeBindingObservation {
    let mut observation = NativeBindingObservation::default();
    if !paths.instances.is_dir() {
        return observation;
    }
    for entry in walkdir::WalkDir::new(&paths.instances)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file() && entry.file_name() == "runtime.json")
    {
        let Ok(bytes) = std::fs::read(entry.path()) else {
            continue;
        };
        let Ok(metadata) = serde_json::from_slice::<BedrockPackageMetadata>(&bytes) else {
            continue;
        };
        if metadata.install_method != "native_msixvc" {
            continue;
        }
        if let (Some(expected), Some(active)) = (metadata.xbox_xuid.as_deref(), active_xuid) {
            if expected != active {
                observation.account_mismatch = true;
                continue;
            }
        }
        if metadata.launch_ready && metadata.status == "launchable" {
            observation.native_ready = true;
        }
        if metadata.status == "failed"
            && metadata.reason.as_deref().is_some_and(|reason| {
                let lower = reason.to_ascii_lowercase();
                lower.contains("license")
                    || lower.contains("store/xbox")
                    || lower.contains("microsoft store")
            })
        {
            observation.license_missing = true;
        }
    }
    observation
}

#[cfg(windows)]
#[derive(Debug)]
struct NativeConfig {
    identity_name: String,
    publisher: String,
    version: String,
    display_name: String,
    publisher_display_name: String,
    store_logo: String,
    square_150_logo: String,
    square_44_logo: String,
    description: String,
    foreground_text: String,
    background_color: String,
    splash_screen: String,
    application_id: String,
    executable: String,
    resources: Vec<String>,
    package_dependencies: Vec<NativePackageDependency>,
}

#[cfg(windows)]
#[derive(Debug)]
struct NativePackageDependency {
    name: String,
    min_version: String,
    publisher: String,
}

#[cfg(windows)]
async fn extract_native_msixvc(
    app: &Host,
    state: &AppState,
    source_path: &Path,
    output_path: &Path,
    expected_xuid: &str,
) -> AppResult<NativeInstallReport> {
    let helper = find_native_installer(&state.paths).ok_or_else(|| {
        AppError::Unavailable(
            "The licensed Bedrock native installer is not bundled with this SLH build. Build slh-bedrock-native with Go before installing retail MSIXVC.".into(),
        )
    })?;
    if current_architecture() != "x64" {
        return Err(AppError::Unavailable(
            "The native Bedrock extractor supports Windows x64 only; this build remains Java-only on x86.".into(),
        ));
    }
    let cache_dir = native_account_cache_dir(&state.paths);
    tokio::fs::create_dir_all(&cache_dir).await?;
    let parent = output_path.parent().ok_or_else(|| {
        AppError::InvalidInput("Native Bedrock extraction path has no parent directory.".into())
    })?;
    tokio::fs::create_dir_all(parent).await?;
    let staging_path = parent.join(format!(
        ".bedrock-native-staging-{}",
        Uuid::new_v4().simple()
    ));
    if staging_path.exists() {
        tokio::fs::remove_dir_all(&staging_path).await?;
    }

    let market = system_store_market();
    emit_runtime_progress(
        app,
        &format!("Проверка лицензии Microsoft Store ({market})"),
        0,
        1,
    );
    let mut command = hidden_command(&helper.to_string_lossy());
    command
        .args([
            "-cache",
            &cache_dir.to_string_lossy(),
            "-market",
            &market,
            "-xuid",
            expected_xuid,
            "-require-full",
            &source_path.to_string_lossy(),
            &staging_path.to_string_lossy(),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        // The helper intentionally emits allow-listed JSON diagnostics on
        // stdout. Never capture raw Store/Xbox stderr into launcher logs.
        .stderr(Stdio::null());
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let _ = tokio::fs::remove_dir_all(&staging_path).await;
            return Err(AppError::Process(format!(
                "Could not start the Bedrock native installer: {error}"
            )));
        }
    };
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill().await;
        let _ = tokio::fs::remove_dir_all(&staging_path).await;
        return Err(AppError::Process(
            "The Bedrock native installer did not expose its JSON output.".into(),
        ));
    };
    let mut lines = BufReader::new(stdout).lines();
    let mut report = None;
    let mut helper_error = None;
    loop {
        let line = match lines.next_line().await {
            Ok(Some(line)) => line,
            Ok(None) => break,
            Err(error) => {
                let _ = child.kill().await;
                let _ = tokio::fs::remove_dir_all(&staging_path).await;
                return Err(error.into());
            }
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if let Some(error) = value.get("error").and_then(serde_json::Value::as_str) {
            helper_error = Some(error.to_owned());
            continue;
        }
        if value.get("stage").and_then(serde_json::Value::as_str) == Some("extract") {
            let bytes = value
                .get("bytes")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or_default();
            let total = value
                .get("total")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(1)
                .max(1);
            emit_runtime_progress(app, "Извлечение Bedrock", bytes, total);
            continue;
        }
        if let Ok(candidate) = serde_json::from_value::<NativeInstallReport>(value.clone()) {
            if !candidate.output_dir.is_empty()
                || !candidate.license_type.is_empty()
                || candidate.file_count > 0
            {
                report = Some(candidate);
            }
        }
    }
    let status = match child.wait().await {
        Ok(status) => status,
        Err(error) => {
            let _ = tokio::fs::remove_dir_all(&staging_path).await;
            return Err(error.into());
        }
    };
    if !status.success() {
        let code = helper_error.unwrap_or_else(|| "ERR_NATIVE_MSIXVC".into());
        let _ = tokio::fs::remove_dir_all(&staging_path).await;
        return Err(native_helper_error(&code, &market));
    }
    if let Some(code) = helper_error {
        let _ = tokio::fs::remove_dir_all(&staging_path).await;
        return Err(native_helper_error(&code, &market));
    }
    let report = report.ok_or_else(|| {
        let _ = std::fs::remove_dir_all(&staging_path);
        AppError::Process(
            "The Bedrock native installer finished without a verification report.".into(),
        )
    })?;
    if !report.license_type.eq_ignore_ascii_case("full") {
        let _ = tokio::fs::remove_dir_all(&staging_path).await;
        return Err(AppError::Unavailable(
            "Microsoft Store did not return a full Minecraft license for the active Xbox account."
                .into(),
        ));
    }
    if !staging_path.join("MicrosoftGame.Config").is_file() {
        let _ = tokio::fs::remove_dir_all(&staging_path).await;
        return Err(AppError::Security(
            "The native helper reported success, but MicrosoftGame.Config is missing from the extracted package.".into(),
        ));
    }

    let backup_path = parent.join(format!(
        ".bedrock-native-previous-{}",
        Uuid::new_v4().simple()
    ));
    let had_previous = output_path.exists();
    if had_previous {
        if let Err(error) = tokio::fs::rename(output_path, &backup_path).await {
            let _ = tokio::fs::remove_dir_all(&staging_path).await;
            return Err(error.into());
        }
    }
    if let Err(error) = tokio::fs::rename(&staging_path, output_path).await {
        if had_previous {
            let _ = tokio::fs::rename(&backup_path, output_path).await;
        }
        let _ = tokio::fs::remove_dir_all(&staging_path).await;
        return Err(error.into());
    }
    if had_previous {
        let _ = tokio::fs::remove_dir_all(&backup_path).await;
    }
    emit_runtime_progress(app, "Извлечение Bedrock завершено", 1, 1);
    Ok(report)
}

#[cfg(windows)]
fn native_helper_error(code: &str, market: &str) -> AppError {
    let upper = code.to_ascii_uppercase();
    let market = normalize_store_market(market).unwrap_or_else(|| "US".into());
    if upper == "ERR_CANCELED" {
        return AppError::Conflict("Установка Bedrock отменена.".into());
    }
    match upper.as_str() {
        "ERR_AUTH_INTERACTION_REQUIRED" | "ERR_AUTH_ACCOUNT_SELECTION" => {
            return AppError::Unavailable(
                "Windows could not silently select a Microsoft account. Sign in to Microsoft Store and Xbox with the account that owns Minecraft, launch Minecraft for Windows once, then choose Bind Store/Xbox account again.".into(),
            );
        }
        "ERR_AUTH_ACCOUNT_CHANGED" => {
            return AppError::Conflict(
                "The Windows Store/Xbox account changed during authorization. Bind the intended account again and retry.".into(),
            );
        }
        "ERR_LICENSE_NOT_ENTITLED" => {
            return AppError::Unavailable(format!(
                "Microsoft Store не выдал лицензию для этого Bedrock-пакета в регионе {market}. Это не доказывает отсутствие покупки: убедитесь, что Store, Xbox и активный аккаунт SLH совпадают, а страна Store соответствует Windows, затем повторите установку."
            ));
        }
        "ERR_LICENSE_FULL_REQUIRED" => {
            return AppError::Unavailable(
                "Microsoft Store вернул пробную, а не полную лицензию Minecraft. SLH не будет использовать trial-лицензию; откройте Minecraft for Windows в Store под аккаунтом-владельцем и повторите установку.".into(),
            );
        }
        "ERR_LICENSE_MISSING_KEY" => {
            return AppError::Unavailable(format!(
                "Microsoft Store не выдал ключ для этого конкретного Bedrock-архива в регионе {market}. Это бывает у старых версий, недоступных в регионе: попробуйте версию, уже установленную через Store, или другую версию каталога."
            ));
        }
        "ERR_LICENSE_CATALOG" => {
            return AppError::Unavailable(format!(
                "Каталог Microsoft Store не вернул совместимый retail-пакет для региона {market}. Проверьте страну/регион в Windows и Microsoft Store, затем повторите установку."
            ));
        }
        "ERR_LICENSE_HTTP" => {
            return AppError::Process(
                "Сервис лицензирования Microsoft Store не ответил корректно. Проверьте сеть и повторите установку позже.".into(),
            );
        }
        "ERR_LICENSE_DEVICE_MISMATCH" => {
            return AppError::Unavailable(
                "Microsoft Store вернул лицензию, привязанную к другому устройству. Перезапустите Store и Xbox под тем же аккаунтом, затем повторите установку.".into(),
            );
        }
        _ => {}
    }
    if upper.contains("LICENSE") || upper.contains("AUTH") || upper.contains("ACCOUNT") {
        return AppError::Unavailable(
            "Microsoft Store/Xbox не подтвердил полную лицензию Minecraft для активного аккаунта. Откройте Store и Xbox под аккаунтом владельца игры и повторите установку.".into(),
        );
    }
    if upper.contains("MSIXVC") || upper.contains("XVD") || upper.contains("FORMAT") {
        return AppError::Security(
            "Пакет MSIXVC повреждён, неполон или имеет неподдерживаемую архитектуру. Повторите загрузку после проверки MD5.".into(),
        );
    }
    AppError::Process(format!("Bedrock native installer failed ({code})."))
}

#[cfg(windows)]
async fn register_native_msixvc_folder(
    app: &Host,
    folder: &Path,
    expected_family: &str,
) -> AppResult<()> {
    if !developer_mode_enabled().await? {
        return Err(AppError::Unavailable(
            "Для регистрации извлечённого Bedrock-пакета Windows требует Developer Mode. Включите его только для этой регистрации и повторите установку.".into(),
        ));
    }
    let config = read_native_config(folder).await?;
    let expected_name = expected_family
        .split_once('_')
        .map(|(name, _)| name)
        .unwrap_or(expected_family);
    if !config.identity_name.eq_ignore_ascii_case(expected_name) {
        return Err(AppError::Security(format!(
            "Extracted package identity {} does not match expected Bedrock identity {}.",
            config.identity_name, expected_name
        )));
    }
    for path in [
        config.executable.as_str(),
        config.store_logo.as_str(),
        config.square_150_logo.as_str(),
        config.square_44_logo.as_str(),
        config.splash_screen.as_str(),
        "resources.pri",
    ] {
        let relative = safe_relative_package_path(path)?;
        if !folder.join(relative).is_file() {
            return Err(AppError::Security(format!(
                "Extracted Bedrock package is missing required file {path}."
            )));
        }
    }
    let manifest = render_native_appx_manifest(&config)?;
    let manifest_path = folder.join("AppXManifest.xml");
    let original = match tokio::fs::read(&manifest_path).await {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    tokio::fs::write(&manifest_path, manifest).await?;
    emit_runtime_progress(app, "Регистрация Bedrock", 0, 1);
    let result = register_loose_package(&manifest_path).await;
    match original {
        Some(bytes) => tokio::fs::write(&manifest_path, bytes).await?,
        None => {
            let _ = tokio::fs::remove_file(&manifest_path).await;
        }
    }
    result
}

#[cfg(windows)]
async fn read_native_config(folder: &Path) -> AppResult<NativeConfig> {
    let xml = tokio::fs::read_to_string(folder.join("MicrosoftGame.Config")).await?;
    let identity = xml_tag(&xml, "Identity").ok_or_else(|| {
        AppError::InvalidInput("MicrosoftGame.Config has no Identity element.".into())
    })?;
    let shell = xml_tag(&xml, "ShellVisuals").ok_or_else(|| {
        AppError::InvalidInput("MicrosoftGame.Config has no ShellVisuals element.".into())
    })?;
    let executable = xml_tags(&xml, "Executable")
        .into_iter()
        .find(|tag| {
            manifest_attribute(tag, "TargetDeviceFamily")
                .is_some_and(|value| value.eq_ignore_ascii_case("PC"))
        })
        .ok_or_else(|| {
            AppError::InvalidInput("MicrosoftGame.Config has no PC executable.".into())
        })?;
    let resources = xml_tags(&xml, "Resource")
        .into_iter()
        .filter_map(|tag| manifest_attribute(&tag, "Language"))
        .filter(|value| !value.trim().is_empty())
        .collect::<Vec<_>>();
    let required = |tag: &str, attr: &str, message: &str| {
        manifest_attribute(tag, attr)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| AppError::InvalidInput(message.into()))
    };
    let display_name = required(
        &shell,
        "DefaultDisplayName",
        "MicrosoftGame.Config has no display name.",
    )?;
    let publisher_display_name = required(
        &shell,
        "PublisherDisplayName",
        "MicrosoftGame.Config has no publisher display name.",
    )?;
    let description = manifest_attribute(&shell, "Description")
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| display_name.clone());
    let foreground_text = manifest_attribute(&shell, "ForegroundText")
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "light".into());
    let background_color = manifest_attribute(&shell, "BackgroundColor")
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "#000000".into());
    let config = NativeConfig {
        identity_name: required(
            &identity,
            "Name",
            "MicrosoftGame.Config identity has no name.",
        )?,
        publisher: required(
            &identity,
            "Publisher",
            "MicrosoftGame.Config identity has no publisher.",
        )?,
        version: required(
            &identity,
            "Version",
            "MicrosoftGame.Config identity has no version.",
        )?,
        display_name,
        publisher_display_name,
        store_logo: required(
            &shell,
            "StoreLogo",
            "MicrosoftGame.Config has no StoreLogo.",
        )?,
        square_150_logo: required(
            &shell,
            "Square150x150Logo",
            "MicrosoftGame.Config has no Square150x150Logo.",
        )?,
        square_44_logo: required(
            &shell,
            "Square44x44Logo",
            "MicrosoftGame.Config has no Square44x44Logo.",
        )?,
        description,
        foreground_text,
        background_color,
        splash_screen: required(
            &shell,
            "SplashScreenImage",
            "MicrosoftGame.Config has no SplashScreenImage.",
        )?,
        application_id: required(
            &executable,
            "Id",
            "MicrosoftGame.Config PC executable has no Id.",
        )?,
        executable: required(
            &executable,
            "Name",
            "MicrosoftGame.Config PC executable has no path.",
        )?,
        resources,
        package_dependencies: native_package_dependencies(&xml),
    };
    if config.resources.is_empty() {
        return Err(AppError::InvalidInput(
            "MicrosoftGame.Config has no resource languages.".into(),
        ));
    }
    Ok(config)
}

#[cfg(windows)]
fn native_package_dependencies(xml: &str) -> Vec<NativePackageDependency> {
    const MICROSOFT_PUBLISHER: &str =
        "CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US";
    let mut dependencies = Vec::new();
    let mut append = |name: String, min_version: String| {
        if name.trim().is_empty() || min_version.trim().is_empty() {
            return;
        }
        if dependencies
            .iter()
            .any(|dependency: &NativePackageDependency| {
                dependency.name.eq_ignore_ascii_case(&name)
                    && dependency.min_version.eq_ignore_ascii_case(&min_version)
            })
        {
            return;
        }
        dependencies.push(NativePackageDependency {
            name,
            min_version,
            publisher: MICROSOFT_PUBLISHER.into(),
        });
    };
    for tag in xml_tags(xml, "KnownDependency") {
        if manifest_attribute(&tag, "Name")
            .is_some_and(|name| name.trim().eq_ignore_ascii_case("VC14"))
        {
            append(
                "Microsoft.VCLibs.140.00.UWPDesktop".into(),
                "14.0.33728.0".into(),
            );
        }
    }
    for tag in xml_tags(xml, "Dependency") {
        let (Some(name), Some(min_version)) = (
            manifest_attribute(&tag, "Name"),
            manifest_attribute(&tag, "MinVersion"),
        ) else {
            continue;
        };
        append(name.trim().into(), min_version.trim().into());
    }
    dependencies
}

#[cfg(windows)]
fn render_native_appx_manifest(config: &NativeConfig) -> AppResult<String> {
    for value in [
        &config.identity_name,
        &config.publisher,
        &config.version,
        &config.application_id,
    ] {
        if value.contains(['\r', '\n']) {
            return Err(AppError::Security(
                "The extracted Bedrock identity contains a newline.".into(),
            ));
        }
    }
    let paths = [
        &config.store_logo,
        &config.square_150_logo,
        &config.square_44_logo,
        &config.splash_screen,
        &config.executable,
    ];
    for path in paths {
        safe_relative_package_path(path)?;
    }
    let resources = config
        .resources
        .iter()
        .map(|language| format!("    <Resource Language=\"{}\" />", xml_escape(language)))
        .collect::<Vec<_>>()
        .join("\n");
    let dependencies = config
        .package_dependencies
        .iter()
        .map(|dependency| {
            format!(
                "    <PackageDependency Name=\"{}\" MinVersion=\"{}\" Publisher=\"{}\" />",
                xml_escape(&dependency.name),
                xml_escape(&dependency.min_version),
                xml_escape(&dependency.publisher),
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    Ok(format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10" xmlns:desktop="http://schemas.microsoft.com/appx/manifest/desktop/windows10" xmlns:desktop6="http://schemas.microsoft.com/appx/manifest/desktop/windows10/6" xmlns:uap3="http://schemas.microsoft.com/appx/manifest/uap/windows10/3" xmlns:wincap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/windowscapabilities" xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities" IgnorableNamespaces="uap uap3 desktop desktop6 wincap rescap" xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10">
  <Identity Name="{}" Publisher="{}" Version="{}" ProcessorArchitecture="x64" />
  <Properties>
    <DisplayName>{}</DisplayName>
    <PublisherDisplayName>{}</PublisherDisplayName>
    <Logo>{}</Logo>
    <Description>{}</Description>
    <desktop6:RegistryWriteVirtualization>disabled</desktop6:RegistryWriteVirtualization>
    <desktop6:FileSystemWriteVirtualization>disabled</desktop6:FileSystemWriteVirtualization>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.18362.0" MaxVersionTested="10.0.18362.0" />
{}
  </Dependencies>
  <Resources>
{}
  </Resources>
  <Applications>
    <Application Id="{}" Executable="{}" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements DisplayName="{}" Square150x150Logo="{}" Square44x44Logo="{}" Description="{}" ForegroundText="{}" BackgroundColor="{}">
        <uap:SplashScreen Image="{}" />
      </uap:VisualElements>
    </Application>
  </Applications>
  <Capabilities>
    <Capability Name="internetClient" />
    <rescap:Capability Name="runFullTrust" />
    <rescap:Capability Name="appLicensing" />
    <rescap:Capability Name="unvirtualizedResources" />
  </Capabilities>
</Package>
"#,
        xml_escape(&config.identity_name),
        xml_escape(&config.publisher),
        xml_escape(&config.version),
        xml_escape_text(&config.display_name),
        xml_escape_text(&config.publisher_display_name),
        xml_escape_text(&config.store_logo),
        xml_escape_text(&config.description),
        dependencies,
        resources,
        xml_escape(&config.application_id),
        xml_escape(&config.executable),
        xml_escape(&config.display_name),
        xml_escape(&config.square_150_logo),
        xml_escape(&config.square_44_logo),
        xml_escape(&config.description),
        xml_escape(&config.foreground_text),
        xml_escape(&config.background_color),
        xml_escape(&config.splash_screen),
    ))
}

#[cfg(windows)]
async fn register_loose_package(manifest_path: &Path) -> AppResult<()> {
    let script = format!(
        "Add-AppxPackage -ForceApplicationShutdown -Register {} -ErrorAction Stop",
        ps_literal(&manifest_path.to_string_lossy())
    );
    let output = powershell(&script).await?;
    if output.status.success() {
        return Ok(());
    }
    let detail = redact_process_output(&output);
    if detail.to_ascii_lowercase().contains("0x80073cf3")
        || detail.to_ascii_lowercase().contains("conflicting package")
    {
        tracing::warn!(detail = %detail, "Bedrock registration conflicts with an installed Store package");
        return Err(AppError::Unavailable(
            "Windows found a conflicting Minecraft Store package. Select the installed Store version in SLH or resolve the package conflict before retrying. No Store package was removed.".into(),
        ));
    }
    Err(AppError::Process(format!(
        "Extracted Bedrock package registration failed: {}",
        detail
    )))
}

#[cfg(windows)]
fn xml_tag(xml: &str, name: &str) -> Option<String> {
    xml_tags(xml, name).into_iter().next()
}

#[cfg(windows)]
fn xml_tags(xml: &str, name: &str) -> Vec<String> {
    let expression = Regex::new(&format!(r"(?is)<{}\b[^>]*>", regex::escape(name)))
        .expect("XML tag expression is valid");
    expression
        .find_iter(xml)
        .map(|match_| match_.as_str().to_owned())
        .collect()
}

#[cfg(windows)]
fn safe_relative_package_path(value: &str) -> AppResult<PathBuf> {
    let normalized = value.trim().replace('\\', "/");
    if normalized.is_empty()
        || normalized.starts_with('/')
        || normalized.contains(':')
        || normalized
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(AppError::Security(format!(
            "Unsafe path in extracted Bedrock package: {value}"
        )));
    }
    Ok(PathBuf::from(normalized))
}

#[cfg(windows)]
fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(windows)]
fn xml_escape_text(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[cfg(windows)]
fn hidden_command(program: &str) -> Command {
    let mut command = Command::new(program);
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(not(windows))]
fn hidden_command(program: &str) -> Command {
    Command::new(program)
}

#[cfg(windows)]
async fn powershell(script: &str) -> AppResult<std::process::Output> {
    let mut command = hidden_command("powershell.exe");
    command
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    Ok(command.output().await?)
}

#[cfg(windows)]
fn ps_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(windows)]
async fn appx_package_present(name: &str) -> AppResult<bool> {
    let script = format!(
        "[bool](Get-AppxPackage -Name {} -ErrorAction SilentlyContinue)",
        ps_literal(name)
    );
    let output = powershell(&script).await?;
    Ok(output.status.success()
        && String::from_utf8_lossy(&output.stdout)
            .trim()
            .eq_ignore_ascii_case("true"))
}

#[cfg(windows)]
async fn game_input_present() -> AppResult<bool> {
    let script = r#"
$paths = @(
  "$env:WINDIR\System32\GameInput.dll",
  "$env:WINDIR\System32\GameInputRedist.dll",
  "$env:WINDIR\SysWOW64\GameInput.dll",
  "$env:WINDIR\SysWOW64\GameInputRedist.dll"
)
$registry = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\GameInput' -ErrorAction SilentlyContinue
if($registry.RedistDir){ $paths += (Join-Path $registry.RedistDir 'GameInputRedist.dll') }
[bool](
  (Get-AppxPackage -Name 'Microsoft.GameInput' -ErrorAction SilentlyContinue) -or
  ($paths | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1)
)
"#;
    let output = powershell(script).await?;
    Ok(output.status.success()
        && String::from_utf8_lossy(&output.stdout)
            .trim()
            .eq_ignore_ascii_case("true"))
}

#[cfg(windows)]
async fn gaming_services_present() -> AppResult<bool> {
    appx_package_present("Microsoft.GamingServices").await
}

#[cfg(windows)]
async fn developer_mode_enabled() -> AppResult<bool> {
    let script = "$p=Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AppModelUnlock' -ErrorAction SilentlyContinue; [bool]($p.AllowDevelopmentWithoutDevLicense -eq 1)";
    let output = powershell(script).await?;
    Ok(output.status.success()
        && String::from_utf8_lossy(&output.stdout)
            .trim()
            .eq_ignore_ascii_case("true"))
}

#[cfg(windows)]
async fn find_wdapp() -> AppResult<Option<String>> {
    if let Ok(path) = std::env::var("SLH_WDAPP") {
        if Path::new(&path).is_file() {
            return Ok(Some(path));
        }
    }
    let script = r#"
$command = Get-Command wdapp.exe -ErrorAction SilentlyContinue
if($command){
  $command.Source
  exit 0
}
$roots = @(
  (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'),
  (Join-Path $env:ProgramData 'Microsoft\WinGet\Packages'),
  (Join-Path $env:ProgramFiles 'Microsoft GDK'),
  (Join-Path ${env:ProgramFiles(x86)} 'Microsoft GDK'),
  (Join-Path $env:ProgramFiles 'Microsoft Gaming GDK'),
  (Join-Path ${env:ProgramFiles(x86)} 'Microsoft Gaming GDK')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
$found = foreach($root in $roots){
  Get-ChildItem -LiteralPath $root -Filter 'wdapp.exe' -File -Recurse -ErrorAction SilentlyContinue
}
if($found){ $found | Select-Object -First 1 -ExpandProperty FullName }
"#;
    let output = powershell(script).await?;
    if !output.status.success() {
        return Ok(None);
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    Ok((!path.is_empty() && Path::new(&path).is_file()).then_some(path))
}

#[cfg(windows)]
async fn find_winget() -> AppResult<Option<String>> {
    let output =
        powershell("$c=Get-Command winget.exe -ErrorAction SilentlyContinue; if($c){$c.Source}")
            .await?;
    if !output.status.success() {
        return Ok(None);
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    Ok((!path.is_empty() && Path::new(&path).is_file()).then_some(path))
}

#[cfg(windows)]
async fn install_game_input() -> AppResult<()> {
    let Some(winget) = find_winget().await? else {
        return Err(AppError::Unavailable(
            "Microsoft GameInput needs Windows Package Manager (winget), which is not available on this Windows installation.".into(),
        ));
    };
    let args = [
        "install",
        "--id",
        "Microsoft.GameInput",
        "--exact",
        "--source",
        "winget",
        "--accept-source-agreements",
        "--accept-package-agreements",
        "--silent",
    ];
    let _ = run_elevated_program(&winget, &args).await?;
    if game_input_present().await? {
        Ok(())
    } else {
        Err(AppError::Unavailable(
            "WinGet finished, but GameInputRedist.dll is still unavailable. Windows may need a restart before Bedrock can use it.".into(),
        ))
    }
}

#[cfg(windows)]
async fn install_gdk_tools() -> AppResult<()> {
    if find_wdapp().await?.is_some() {
        return Ok(());
    }
    let Some(winget) = find_winget().await? else {
        return Err(AppError::Unavailable(
            "Microsoft GDK needs Windows Package Manager (winget), which is not available on this Windows installation.".into(),
        ));
    };
    let args = [
        "install",
        "--id",
        GDK_WINGET_PACKAGE_ID,
        "--exact",
        "--source",
        "winget",
        "--accept-source-agreements",
        "--accept-package-agreements",
        "--silent",
        "--disable-interactivity",
    ];
    let exit_code = run_elevated_program(&winget, &args).await?;
    if exit_code != 0 {
        return Err(AppError::Process(format!(
            "Microsoft GDK installation failed with exit code {exit_code}."
        )));
    }
    if find_wdapp().await?.is_some() {
        Ok(())
    } else {
        Err(AppError::Unavailable(
            "Microsoft GDK was installed, but wdapp.exe could not be found. Restart Windows and retry Bedrock setup.".into(),
        ))
    }
}

#[cfg(windows)]
async fn run_elevated_program(program: &str, args: &[&str]) -> AppResult<i32> {
    let argument_list = args
        .iter()
        .map(|argument| ps_literal(argument))
        .collect::<Vec<_>>()
        .join(",");
    let script = format!(
        "$p=Start-Process -FilePath {} -ArgumentList @({}) -Verb RunAs -Wait -PassThru; exit [int]$p.ExitCode",
        ps_literal(program),
        argument_list
    );
    let output = powershell(&script).await?;
    if !output.status.success() {
        return Err(AppError::Process(format!(
            "Elevated Microsoft prerequisite installer failed: {}",
            redact_process_output(&output)
        )));
    }
    Ok(output.status.code().unwrap_or(0))
}

#[cfg(windows)]
async fn download_gaming_repair_tool(state: &AppState) -> AppResult<PathBuf> {
    let directory = state.paths.cache.join("bedrock");
    let destination = directory.join("GamingRepairTool.exe");
    if destination.is_file() && verify_sha256(&destination).await? {
        return Ok(destination);
    }
    tokio::fs::create_dir_all(&directory).await?;
    let response = state
        .http
        .get(GAMING_REPAIR_TOOL_URL)
        .send()
        .await?
        .error_for_status()?;
    let final_host = response.url().host_str().unwrap_or_default();
    if !final_host.eq_ignore_ascii_case("dlassets-ssl.xboxlive.com") {
        return Err(AppError::Security(format!(
            "Unexpected Gaming Services Repair Tool host: {final_host}"
        )));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_REPAIR_TOOL_BYTES)
    {
        return Err(AppError::Security(
            "Gaming Services Repair Tool download is unexpectedly large.".into(),
        ));
    }
    let bytes = response.bytes().await?;
    if bytes.len() as u64 > MAX_REPAIR_TOOL_BYTES {
        return Err(AppError::Security(
            "Gaming Services Repair Tool download is unexpectedly large.".into(),
        ));
    }
    let actual = hex::encode(Sha256::digest(&bytes));
    if !actual.eq_ignore_ascii_case(GAMING_REPAIR_TOOL_SHA256) {
        return Err(AppError::Security(format!(
            "Gaming Services Repair Tool checksum mismatch: expected {GAMING_REPAIR_TOOL_SHA256}, received {actual}"
        )));
    }
    let temporary = destination.with_extension("exe.slh-part");
    tokio::fs::write(&temporary, &bytes).await?;
    if destination.exists() {
        tokio::fs::remove_file(&destination).await?;
    }
    tokio::fs::rename(&temporary, &destination).await?;
    Ok(destination)
}

#[cfg(windows)]
async fn verify_sha256(path: &Path) -> AppResult<bool> {
    let mut file = tokio::fs::File::open(path).await?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; 128 * 1024];
    loop {
        let read = tokio::io::AsyncReadExt::read(&mut file, &mut buffer).await?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(hex::encode(digest.finalize()).eq_ignore_ascii_case(GAMING_REPAIR_TOOL_SHA256))
}

/// Return only packages that Windows has already registered for the current
/// user.  Selecting one of these versions is the supported no-sideloading
/// path: SLH adopts the Store package and never downloads, extracts, or
/// registers loose files.
#[cfg(windows)]
pub(crate) async fn registered_store_packages() -> AppResult<Vec<BedrockInstalledPackage>> {
    Ok(discover_registered_packages().await?.unwrap_or_default())
}

#[cfg(not(windows))]
pub(crate) async fn registered_store_packages() -> AppResult<Vec<BedrockInstalledPackage>> {
    Ok(Vec::new())
}

#[cfg(windows)]
async fn discover_registered_packages() -> AppResult<Option<Vec<BedrockInstalledPackage>>> {
    let script = r#"
$items = @(
  Get-AppxPackage -Name 'Microsoft.MinecraftUWP' -ErrorAction SilentlyContinue
  Get-AppxPackage -Name 'Microsoft.MinecraftWindows' -ErrorAction SilentlyContinue
  Get-AppxPackage -Name 'Microsoft.MinecraftWindowsBeta' -ErrorAction SilentlyContinue
) | Sort-Object Version -Descending
$rows = @($items | ForEach-Object {
  $manifest = [xml](Get-AppxPackageManifest $_).OuterXml
  $application = $manifest.Package.Applications.Application | Select-Object -First 1
  $channel = if ($_.Name -like '*Beta*') { 'preview' } else { 'release' }
  [pscustomobject]@{
    name=$_.Name
    version=$_.Version.ToString()
    packageFamilyName=$_.PackageFamilyName
    packageFullName=$_.PackageFullName
    installLocation=$_.InstallLocation
    appUserModelId=if($application){ "$($_.PackageFamilyName)!$($application.Id)" } else { $null }
    channel=$channel
    signatureKind=$_.SignatureKind.ToString()
  }
})
if($rows.Count -gt 0){ $rows | ConvertTo-Json -Compress }
"#;
    let output = powershell(script).await?;
    if !output.status.success() {
        return Ok(None);
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if text.is_empty() {
        return Ok(Some(Vec::new()));
    }
    let value: serde_json::Value = serde_json::from_str(&text)?;
    let values = match value {
        serde_json::Value::Array(values) => values,
        value => vec![value],
    };
    let mut packages = Vec::new();
    for value in values {
        if let Ok(package) = serde_json::from_value::<BedrockInstalledPackage>(value) {
            packages.push(package);
        }
    }
    Ok(Some(packages))
}

#[cfg(windows)]
async fn discover_package_by_name(name: &str) -> AppResult<Option<BedrockInstalledPackage>> {
    let script = format!(
        "$name={}; $item=Get-AppxPackage -Name $name -ErrorAction SilentlyContinue | Sort-Object Version -Descending | Select-Object -First 1; if($item){{ $manifest=[xml](Get-AppxPackageManifest $item).OuterXml; $application=$manifest.Package.Applications.Application | Select-Object -First 1; [pscustomobject]@{{ name=$item.Name; version=$item.Version.ToString(); packageFamilyName=$item.PackageFamilyName; packageFullName=$item.PackageFullName; installLocation=$item.InstallLocation; appUserModelId=if($application){{ \"$($item.PackageFamilyName)!$($application.Id)\" }}else{{ $null }}; channel=if($item.Name -like '*Beta*'){{'preview'}}else{{'release'}}; signatureKind=$item.SignatureKind.ToString() }} | ConvertTo-Json -Compress }}",
        ps_literal(name)
    );
    let output = powershell(&script).await?;
    if !output.status.success() {
        return Ok(None);
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if text.is_empty() {
        return Ok(None);
    }
    Ok(serde_json::from_str(&text).ok())
}

#[cfg(windows)]
async fn discover_package_by_name_and_version(
    name: &str,
    version: &str,
) -> AppResult<Option<BedrockInstalledPackage>> {
    let packages = discover_registered_packages().await?.unwrap_or_default();
    Ok(packages.into_iter().find(|package| {
        package.name.eq_ignore_ascii_case(name) && versions_match(version, &package.version)
    }))
}

#[cfg(windows)]
async fn discover_package_by_family_and_version(
    family_name: &str,
    version: &str,
    channel: &str,
) -> AppResult<Option<BedrockInstalledPackage>> {
    let packages = discover_registered_packages().await?.unwrap_or_default();
    Ok(packages.into_iter().find(|package| {
        package
            .package_family_name
            .eq_ignore_ascii_case(family_name)
            && package.channel == channel
            && versions_match(version, &package.version)
    }))
}

fn metadata_from_registered_package(
    base: &BedrockPackageMetadata,
    package: BedrockInstalledPackage,
    registered_by_slh: bool,
) -> BedrockPackageMetadata {
    let mut installed = base.clone();
    installed.package_family_name = Some(package.package_family_name);
    installed.app_user_model_id = package.app_user_model_id;
    installed.install_location = Some(package.install_location);
    installed.launch_ready = installed.app_user_model_id.is_some();
    installed.status = if installed.launch_ready {
        "launchable"
    } else {
        "installed"
    }
    .into();
    installed.reason = (!installed.launch_ready)
        .then(|| "The UWP package has no launchable application identity.".into());
    installed.registered_by_slh = registered_by_slh;
    installed
}

#[cfg(windows)]
async fn install_uwp_package(package_path: &Path) -> AppResult<()> {
    let script = format!(
        "Add-AppxPackage -Path {} -ForceUpdateFromAnyVersion -ErrorAction Stop",
        ps_literal(&package_path.to_string_lossy())
    );
    let output = powershell(&script).await?;
    if output.status.success() {
        return Ok(());
    }
    Err(AppError::Process(format!(
        "Add-AppxPackage installation failed: {}",
        redact_process_output(&output)
    )))
}

#[cfg(windows)]
async fn install_uwp_package_with_conflict_resolution(
    package_path: &Path,
    package_name: &str,
    package_version: &str,
) -> AppResult<()> {
    match install_uwp_package(package_path).await {
        Ok(()) => Ok(()),
        Err(first_error) => {
            let existing = discover_package_by_name(package_name).await?;
            if existing
                .as_ref()
                .is_some_and(|package| versions_match(package_version, &package.version))
            {
                return Ok(());
            }
            if !is_uwp_package_conflict(&first_error) {
                return Err(first_error);
            }
            let Some(existing) = existing else {
                return Err(first_error);
            };
            remove_uwp_package(&existing.package_full_name).await?;
            install_uwp_package(package_path).await.map_err(|retry_error| {
                AppError::Process(format!(
                    "The existing Minecraft Windows package was removed, but the requested Bedrock version could not be installed: {retry_error}"
                ))
            })
        }
    }
}

#[cfg(windows)]
fn is_uwp_package_conflict(error: &AppError) -> bool {
    let message = error.to_string().to_ascii_lowercase();
    message.contains("0x80073cfb")
        || message.contains("0x80073cf3")
        || message.contains("already installed")
        || message.contains("higher version")
        || message.contains("packaged version")
        || message.contains("unpackaged version")
}

#[cfg(windows)]
async fn remove_uwp_package(package_full_name: &str) -> AppResult<()> {
    let script = format!(
        "Remove-AppxPackage -Package {} -PreserveApplicationData -ErrorAction Stop",
        ps_literal(package_full_name)
    );
    let output = powershell(&script).await?;
    if output.status.success() {
        return Ok(());
    }
    Err(AppError::Process(format!(
        "The installed Minecraft Windows package could not be replaced: {}",
        redact_process_output(&output)
    )))
}

#[cfg(windows)]
async fn install_gdk_package(wdapp: &str, package_path: &Path) -> AppResult<()> {
    let package = package_path.to_string_lossy().into_owned();
    // The normal wdapp flow is the plain install command. /AllChunks is a
    // useful retry for packages that have optional chunks; /bootstrapper is
    // deliberately last because it changes the installation flow and is not
    // required for ordinary local MSIXVC testing.
    let attempts = [
        vec!["install".to_owned(), package.clone()],
        vec![
            "install".to_owned(),
            package.clone(),
            "/AllChunks".to_owned(),
        ],
        vec![
            "install".to_owned(),
            package.clone(),
            "/bootstrapper".to_owned(),
        ],
    ];
    let mut failures = Vec::new();
    for args in attempts {
        let mut command = hidden_command(wdapp);
        command.args(&args);
        let output = command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .await?;
        if output.status.success() {
            return Ok(());
        }
        let detail = redact_process_output(&output);
        if is_store_submission_package_error(&detail) {
            return Err(AppError::Unavailable(
                "This GDK package is signed for Microsoft Store submission, not local sideloading. Windows wdapp cannot install it. Install the same version through Microsoft Store/Xbox, or use a version already registered there. SLH cannot convert or decrypt retail MSIXVC packages.".into(),
            ));
        }
        failures.push(detail);
    }
    let last = failures
        .into_iter()
        .rev()
        .find(|message| !message.trim().is_empty())
        .unwrap_or_else(|| "wdapp returned an unknown error".into());
    Err(AppError::Process(format!(
        "wdapp could not install the GDK package: {last}"
    )))
}

pub(crate) fn is_store_submission_package_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("signed for microsoft store submission")
        || lower.contains("signed for store submission")
        || lower.contains("signed for submission")
        || lower.contains("not valid for submission")
        || lower.contains("not local sideloading")
        || lower.contains("local sideload")
        || lower.contains("makepkg.exe")
        || lower.contains("makepkg")
}

#[cfg(windows)]
fn redact_process_output(output: &std::process::Output) -> String {
    let text = String::from_utf8_lossy(&output.stderr);
    let text = if text.trim().is_empty() {
        String::from_utf8_lossy(&output.stdout).into_owned()
    } else {
        text.into_owned()
    };
    text.trim().chars().take(1_000).collect()
}

async fn append_log_line(path: &Path, line: &str) -> AppResult<()> {
    use tokio::io::AsyncWriteExt;
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .await?;
    file.write_all(format!("{} {}\n", Utc::now().to_rfc3339(), line).as_bytes())
        .await?;
    Ok(())
}

async fn wait_for_new_bedrock_pid(before: &HashSet<u32>, timeout: Duration) -> AppResult<u32> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let current = list_bedrock_pids().await?;
        if let Some(pid) = current.into_iter().find(|pid| !before.contains(pid)) {
            return Ok(pid);
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(AppError::Process("Bedrock activation completed, but Minecraft.Windows.exe did not appear within two minutes.".into()));
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

async fn list_bedrock_pids() -> AppResult<HashSet<u32>> {
    #[cfg(windows)]
    {
        let mut command = hidden_command("tasklist");
        let output = command
            .args([
                "/FI",
                "IMAGENAME eq Minecraft.Windows.exe",
                "/FO",
                "CSV",
                "/NH",
            ])
            .output()
            .await?;
        if !output.status.success() {
            return Ok(HashSet::new());
        }
        let text = String::from_utf8_lossy(&output.stdout);
        let mut pids = HashSet::new();
        for line in text.lines() {
            let parts: Vec<&str> = line.split('"').collect();
            if let Some(pid) = parts
                .get(3)
                .and_then(|value| value.trim().parse::<u32>().ok())
            {
                pids.insert(pid);
            }
        }
        return Ok(pids);
    }
    #[cfg(not(windows))]
    Ok(HashSet::new())
}

fn process_is_alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        return std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()
            .is_some_and(|output| {
                output.status.success()
                    && String::from_utf8_lossy(&output.stdout).contains(&format!("\"{pid}\""))
            });
    }
    #[cfg(unix)]
    {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .is_ok_and(|status| status.success())
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = pid;
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_installer_is_found_in_packaged_resources() {
        let directory = tempfile::tempdir().unwrap();
        let resources = directory.path().join("bundle");
        std::fs::create_dir_all(resources.join("binaries")).unwrap();
        let name = if cfg!(target_arch = "x86") {
            "slh-bedrock-native-i686-pc-windows-msvc.exe"
        } else { "slh-bedrock-native-x86_64-pc-windows-msvc.exe" };
        let helper = resources.join("binaries").join(name);
        std::fs::write(&helper, "test helper location").unwrap();
        let mut paths = PortablePaths::from_executable(
            &directory.path().join("slh.exe"), Some(directory.path().to_path_buf()),
        ).unwrap();
        paths.bundled_resources = Some(resources);
        assert_eq!(find_native_installer(&paths), Some(helper));
    }

    #[test]
    fn parses_manifest_identity_and_application() {
        let xml = r#"<Package><Identity Version='1.2.3.4' Name='Microsoft.MinecraftUWP' Publisher='CN=Microsoft' ProcessorArchitecture='x64'/><Applications><Application Id='App' Executable='Minecraft.Windows.exe'/></Applications></Package>"#;
        let manifest = parse_appx_manifest(xml).unwrap();
        assert_eq!(manifest.name, "Microsoft.MinecraftUWP");
        assert_eq!(manifest.version, "1.2.3.4");
        assert_eq!(manifest.processor_architecture, "x64");
        assert_eq!(manifest.application_id, "App");
    }

    #[test]
    fn matches_catalog_and_store_versions_without_accepting_empty_values() {
        assert!(versions_match("26.51.01", "1.26.5101.0"));
        assert!(versions_match("1.26.60.24", "1.26.6024.0"));
        assert!(versions_match("1.21.120.20", "1.21.12020.0"));
        assert!(versions_match("1.21.43.1", "1.21.4301.0"));
        assert!(!versions_match("", "1.26.5101.0"));
    }

    #[test]
    fn displays_store_versions_in_minecraft_format() {
        assert_eq!(display_store_version("1.14.2001.0"), "1.14.20.1");
        assert_eq!(display_store_version("1.21.12402.0"), "1.21.124.2");
        assert_eq!(display_store_version("1.26.6024.0"), "1.26.60.24");
        assert_eq!(display_store_version("not-a-version"), "not-a-version");
    }

    #[test]
    fn recognizes_only_registered_minecraft_store_packages() {
        let package = BedrockInstalledPackage {
            name: "MICROSOFT.MINECRAFTUWP".into(),
            version: "1.14.2001.0".into(),
            package_family_name: "Microsoft.MinecraftUWP_8wekyb3d8bbwe".into(),
            package_full_name: "Microsoft.MinecraftUWP_1.14.2001.0_x64__8wekyb3d8bbwe".into(),
            install_location: "C:\\Program Files\\WindowsApps\\Minecraft".into(),
            app_user_model_id: Some("Microsoft.MinecraftUWP_8wekyb3d8bbwe!App".into()),
            channel: "release".into(),
            signature_kind: Some("Store".into()),
        };
        assert!(is_registered_store_package(&package));
        let mut unsigned = package;
        unsigned.signature_kind = Some("Developer".into());
        assert!(!is_registered_store_package(&unsigned));
    }

    #[test]
    fn validates_package_architecture_for_current_process() {
        assert!(processor_architecture_compatible(&current_architecture()));
        assert!(processor_architecture_compatible("neutral"));
        assert!(!processor_architecture_compatible("arm"));
    }

    #[test]
    fn normalizes_store_market_to_iso_country_code() {
        assert_eq!(normalize_store_market("de"), Some("DE".into()));
        assert_eq!(normalize_store_market(" DE "), Some("DE".into()));
        assert_eq!(normalize_store_market("Germany"), None);
        assert_eq!(normalize_store_market("D1"), None);
    }

    #[cfg(windows)]
    #[test]
    fn keeps_native_license_failures_distinct() {
        let no_entitlement = native_helper_error("ERR_LICENSE_NOT_ENTITLED", "de").to_string();
        let missing_key = native_helper_error("ERR_LICENSE_MISSING_KEY", "de").to_string();
        let trial = native_helper_error("ERR_LICENSE_FULL_REQUIRED", "de").to_string();
        assert!(no_entitlement.contains("регионе DE"));
        assert!(missing_key.contains("конкретного Bedrock-архива"));
        assert!(trial.contains("пробную"));
    }

    #[cfg(windows)]
    #[test]
    fn rejects_unsafe_extracted_package_paths() {
        assert!(safe_relative_package_path("Minecraft.Windows.exe").is_ok());
        assert!(safe_relative_package_path("images\\logo.png").is_ok());
        assert!(safe_relative_package_path("..\\outside.exe").is_err());
        assert!(safe_relative_package_path("C:\\outside.exe").is_err());
        assert!(safe_relative_package_path("/outside.exe").is_err());
    }

    #[test]
    fn normalizes_profile_mode_to_safe_values() {
        assert_eq!(normalize_profile_mode("isolated"), "isolated");
        assert_eq!(normalize_profile_mode("other"), "shared");
    }

    #[test]
    fn registered_store_gdk_packages_do_not_require_wdapp() {
        let registered = BedrockPackageMetadata {
            version: "26.51.01".into(),
            package_type: "gdk".into(),
            channel: "release".into(),
            architecture: "x64".into(),
            package_path: None,
            install_method: "registered_store".into(),
            package_family_name: Some("Microsoft.MinecraftUWP_8wekyb3d8bbwe".into()),
            app_user_model_id: Some("Microsoft.MinecraftUWP_8wekyb3d8bbwe!Game".into()),
            install_location: Some("C:\\Program Files\\WindowsApps\\Minecraft".into()),
            launch_ready: true,
            status: "launchable".into(),
            reason: None,
            profile_mode: "isolated".into(),
            registered_by_slh: false,
            extracted_root: None,
            xbox_xuid: None,
        };
        assert!(!gdk_package_requires_wdapp(&registered));
        let mut downloaded = registered;
        downloaded.package_path = Some("C:\\SLH\\MinecraftBedrock.msixvc".into());
        downloaded.install_method = "native_msixvc".into();
        assert!(!gdk_package_requires_wdapp(&downloaded));
        downloaded.install_method = "wdapp".into();
        assert!(gdk_package_requires_wdapp(&downloaded));
    }

    #[test]
    fn identifies_submission_only_gdk_errors() {
        assert!(is_store_submission_package_error(
            "This package is signed for submission. Please invoke MakePkg.exe without the '/l' flag."
        ));
        assert!(is_store_submission_package_error(
            "This capability is unavailable: This GDK package is signed for Microsoft Store submission, not local sideloading."
        ));
        assert!(is_store_submission_package_error(
            "This package is not valid for submission. MakePkg.exe was used for a sideload package."
        ));
        assert!(!is_store_submission_package_error(
            "Gaming Services is not installed"
        ));
    }
}
