//! Platform capabilities and runtime targets; the UI never infers them from OS strings.
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OperatingSystem {
    Windows,
    Linux,
    MacOs,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Architecture {
    X86,
    X64,
    Arm64,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeTarget {
    pub os: OperatingSystem,
    pub java_arch: Architecture,
}
impl OperatingSystem {
    pub fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::MacOs
        } else {
            Self::Linux
        }
    }
    pub fn minecraft_name(self) -> &'static str {
        match self {
            Self::Windows => "windows",
            Self::Linux => "linux",
            Self::MacOs => "osx",
        }
    }
    pub fn adoptium_name(self) -> &'static str {
        match self {
            Self::MacOs => "mac",
            _ => self.minecraft_name(),
        }
    }
    pub fn java_executable(self) -> &'static str {
        if self == Self::Windows {
            "java.exe"
        } else {
            "java"
        }
    }
    pub fn archive_extension(self) -> &'static str {
        if self == Self::Windows {
            "zip"
        } else {
            "tar.gz"
        }
    }
}
impl Architecture {
    pub fn host() -> Self {
        if cfg!(target_arch = "aarch64") {
            Self::Arm64
        } else if cfg!(target_arch = "x86") {
            Self::X86
        } else {
            Self::X64
        }
    }
    pub fn adoptium_name(self) -> &'static str {
        match self {
            Self::X86 => "x86",
            Self::X64 => "x64",
            Self::Arm64 => "aarch64",
        }
    }
    pub fn from_java(value: &str) -> AppResult<Self> {
        match value {
            "x86" | "i386" | "i686" => Ok(Self::X86),
            "x86_64" | "amd64" | "x64" => Ok(Self::X64),
            "aarch64" | "arm64" => Ok(Self::Arm64),
            _ => Err(AppError::Unavailable(format!(
                "Unsupported Java architecture: {value}"
            ))),
        }
    }
}
impl RuntimeTarget {
    pub fn host() -> Self {
        Self {
            os: OperatingSystem::current(),
            java_arch: Architecture::host(),
        }
    }
}
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub bedrock: bool,
    pub portable_default: bool,
    pub credential_store: &'static str,
}
pub fn capabilities() -> Capabilities {
    let os = OperatingSystem::current();
    Capabilities {
        bedrock: os == OperatingSystem::Windows,
        portable_default: os == OperatingSystem::Windows,
        credential_store: match os {
            OperatingSystem::Windows => "DPAPI",
            OperatingSystem::MacOs => "Keychain",
            OperatingSystem::Linux => "Secret Service",
        },
    }
}
pub fn default_data_root(executable_dir: PathBuf) -> AppResult<PathBuf> {
    let portable = executable_dir.join("portable.flag").is_file();
    let installed = executable_dir.join("_up_/resources/slh-installed.flag").is_file()
        || executable_dir.join("resources/slh-installed.flag").is_file()
        || executable_dir.join("slh-installed.flag").is_file();
    // Preserve existing portable data on upgrades. Fresh installer packages use
    // a per-user location so Program Files never needs administrator writes.
    if portable || (cfg!(windows) && (!installed || executable_dir.join("data").is_dir())) {
        Ok(executable_dir)
    } else {
        directories::ProjectDirs::from("org", "SmileLauncher", "SLH")
            .map(|p| p.data_dir().to_path_buf())
            .ok_or_else(|| {
                AppError::Unavailable(
                    "User data directory is unavailable; specify portable root".into(),
                )
            })
    }
}
pub fn open_path(path: &std::path::Path) -> AppResult<()> {
    open::that(path).map_err(AppError::Io)
}
pub fn os_version() -> &'static str {
    static VERSION: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    VERSION.get_or_init(|| {
        // Minecraft rules follow Java's os.version, not marketing names or
        // Linux distribution versions from /etc/os-release.
        #[cfg(windows)]
        { windows_os_version().unwrap_or_default() }
        #[cfg(target_os = "linux")]
        { sysinfo::System::kernel_version().unwrap_or_default() }
        #[cfg(not(any(windows, target_os = "linux")))]
        { sysinfo::System::os_version().unwrap_or_default() }
    })
}
#[cfg(windows)]
fn windows_os_version() -> Option<String> {
    #[repr(C)]
    struct OsVersion {
        size: u32, major: u32, minor: u32, build: u32, platform: u32,
        service_pack: [u16; 128],
    }
    #[link(name = "ntdll")]
    unsafe extern "system" { fn RtlGetVersion(version: *mut OsVersion) -> i32; }
    let mut version = OsVersion { size: std::mem::size_of::<OsVersion>() as u32,
        major: 0, minor: 0, build: 0, platform: 0, service_pack: [0; 128] };
    // The buffer has the documented RTL_OSVERSIONINFOW size and layout.
    if unsafe { RtlGetVersion(&mut version) } != 0 { return None; }
    Some(format!("{}.{}", version.major, version.minor))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn portable_marker_selects_the_executable_directory() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("portable.flag"), "").unwrap();
        assert_eq!(default_data_root(directory.path().to_path_buf()).unwrap(), directory.path());
    }
    #[test]
    #[cfg(windows)]
    fn fresh_installer_uses_user_data_but_preserves_legacy_data() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(directory.path().join("_up_/resources")).unwrap();
        std::fs::write(directory.path().join("_up_/resources/slh-installed.flag"), "").unwrap();
        assert_ne!(default_data_root(directory.path().to_path_buf()).unwrap(), directory.path());
        std::fs::create_dir(directory.path().join("data")).unwrap();
        assert_eq!(default_data_root(directory.path().to_path_buf()).unwrap(), directory.path());
    }
    #[test]
    fn platform_maps_are_explicit() {
        assert_eq!(OperatingSystem::MacOs.minecraft_name(), "osx");
        assert_eq!(OperatingSystem::MacOs.adoptium_name(), "mac");
        assert_eq!(OperatingSystem::Linux.java_executable(), "java");
        assert_eq!(Architecture::Arm64.adoptium_name(), "aarch64");
    }
    #[test]
    fn minecraft_os_version_has_java_compatible_shape() {
        #[cfg(windows)]
        assert!(regex::Regex::new(r"^\d+\.\d+$").unwrap().is_match(os_version()));
        #[cfg(target_os = "linux")]
        assert_eq!(os_version(), sysinfo::System::kernel_version().unwrap_or_default());
        #[cfg(target_os = "macos")]
        assert_eq!(os_version(), sysinfo::System::os_version().unwrap_or_default());
    }
    #[test]
    fn java_arch_is_distinct_from_host() {
        let target = RuntimeTarget {
            os: OperatingSystem::MacOs,
            java_arch: Architecture::from_java("amd64").unwrap(),
        };
        assert_eq!(target.java_arch, Architecture::X64);
        assert!(Architecture::from_java("mips").is_err());
    }
    #[test]
    fn arm_java_never_silently_uses_an_intel_native() {
        use crate::minecraft::types::DownloadInfo;
        use std::collections::HashMap;
        let download = DownloadInfo { sha1: None, size: None, url: "https://example.org/native.jar".into(), path: None };
        let target = RuntimeTarget { os: OperatingSystem::MacOs, java_arch: Architecture::Arm64 };
        let mut available = HashMap::from([("natives-osx".into(), download.clone())]);
        assert!(native_classifier("natives-osx", target, &available).is_err());
        available.insert("natives-osx-arm64".into(), download);
        assert_eq!(native_classifier("natives-osx", target, &available).unwrap(), "natives-osx-arm64");
        assert_eq!(native_classifier("natives-osx", RuntimeTarget { java_arch: Architecture::X64, ..target }, &available).unwrap(), "natives-osx");
    }
}

pub fn show_error(message: &str) {
    #[cfg(windows)]
    {
        use windows::{
            Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_OK, MessageBoxW},
            core::PCWSTR,
        };
        let body: Vec<u16> = message.encode_utf16().chain([0]).collect();
        let title: Vec<u16> = "SLH Native".encode_utf16().chain([0]).collect();
        unsafe {
            let _ = MessageBoxW(
                None,
                PCWSTR(body.as_ptr()),
                PCWSTR(title.as_ptr()),
                MB_OK | MB_ICONERROR,
            );
        }
    }
    #[cfg(not(windows))]
    eprintln!("SLH Native: {message}");
}

/// Compare canonical paths consistently with persisted Windows paths (without verbatim prefixes).
pub fn canonical_path(path: &std::path::Path) -> AppResult<PathBuf> {
    let resolved = path.canonicalize()?;
    #[cfg(windows)]
    {
        let text = resolved.to_string_lossy();
        if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
            return Ok(PathBuf::from(format!(r"\\{unc}")));
        }
        if let Some(disk) = text.strip_prefix(r"\\?\") {
            return Ok(PathBuf::from(disk));
        }
    }
    Ok(resolved)
}

pub fn native_classifier(
    base: &str,
    target: RuntimeTarget,
    available: &std::collections::HashMap<String, crate::minecraft::types::DownloadInfo>,
) -> AppResult<String> {
    let base = base.replace(
        "${arch}",
        if target.java_arch == Architecture::X86 {
            "32"
        } else {
            "64"
        },
    );
    if target.java_arch != Architecture::Arm64 {
        return Ok(base);
    }
    for candidate in [
        format!("{base}-arm64"),
        format!("{base}-aarch64"),
        base.clone(),
    ] {
        if (candidate.contains("arm64") || candidate.contains("aarch64"))
            && available.contains_key(&candidate)
        {
            return Ok(candidate);
        }
    }
    Err(AppError::Unavailable("This Minecraft native library has no ARM64 variant. Select an Intel Java runtime where emulation is supported".into()))
}
