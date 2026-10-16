use crate::error::{AppError, AppResult};

const APP_USER_MODEL_ID: &str = "com.smilelauncher.slh";
const NOTIFICATION_MODEL_ID: &str = "com.smilelauncher.slh.notifications";

/// Windows requires an unpackaged desktop app to have a Start menu shortcut
/// carrying its AppUserModelID before the notification service will display
/// native toasts. Portable SLH creates a per-user shortcut only when Windows
/// notifications are enabled.
pub fn ensure_start_menu_shortcut() -> AppResult<()> {
    #[cfg(windows)]
    {
        std::thread::spawn(create_start_menu_shortcut)
            .join()
            .map_err(|_| AppError::Process("Windows notification setup thread failed".into()))?
    }
    #[cfg(not(windows))]
    {
        // macOS/Linux notifications do not require a Windows Start menu link.
        Ok(())
    }
}

/// Repair an existing portable shortcut even when native toasts are disabled.
/// Fresh installations still create a shortcut only when notifications need one.
pub fn repair_existing_shortcut() {
    #[cfg(windows)]
    if let Some(app_data) = std::env::var_os("APPDATA") {
        let programs = std::path::PathBuf::from(app_data)
            .join("Microsoft/Windows/Start Menu/Programs");
        if programs.join("SLH Notifications.lnk").is_file()
            || programs.join("Smile LauncHer.lnk").is_file()
        {
            if let Err(error) = ensure_start_menu_shortcut() {
                tracing::warn!(%error, "Could not refresh the launcher shortcut");
            }
        }
    }
}

#[cfg(windows)]
fn create_start_menu_shortcut() -> AppResult<()> {
    create_shortcut("Smile LauncHer.lnk", APP_USER_MODEL_ID)?;
    create_shortcut("Smile LauncHer Notifications.lnk", NOTIFICATION_MODEL_ID)
}

#[cfg(windows)]
fn create_shortcut(shortcut_name: &str, app_id: &str) -> AppResult<()> {
    use std::mem::ManuallyDrop;

    use windows::Win32::Storage::EnhancedStorage::PKEY_AppUserModel_ID;
    use windows::Win32::System::Com::StructuredStorage::{
        PropVariantClear, PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0,
    };
    use windows::Win32::System::Com::{
        CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
        CoTaskMemAlloc, CoUninitialize, IPersistFile,
    };
    use windows::Win32::System::Variant::VT_LPWSTR;
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
    use windows::core::{Interface, PCWSTR, PWSTR};

    let app_data = std::env::var_os("APPDATA")
        .map(std::path::PathBuf::from)
        .ok_or_else(|| AppError::Unavailable("APPDATA is not available".into()))?;
    let start_menu = app_data
        .join("Microsoft")
        .join("Windows")
        .join("Start Menu")
        .join("Programs");
    std::fs::create_dir_all(&start_menu)?;
    let shortcut_path = start_menu.join(shortcut_name);
    let legacy_path = start_menu.join("SLH Notifications.lnk");
    register_notification_branding(&app_data)?;
    let executable = std::env::current_exe()?;
    let executable_wide: Vec<u16> = executable.as_os_str().encode_wide().chain(Some(0)).collect();
    let shortcut_wide: Vec<u16> = shortcut_path.as_os_str().encode_wide().chain(Some(0)).collect();
    let app_id_wide: Vec<u16> = app_id.encode_utf16().chain(Some(0)).collect();
    let description_wide: Vec<u16> = "Smile LauncHer"
        .encode_utf16()
        .chain(Some(0))
        .collect();

    let initialized = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    if initialized.is_err() {
        return Err(AppError::Unavailable(format!(
            "Windows could not initialize notification setup: {initialized:?}"
        )));
    }
    let result: AppResult<()> = (|| unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
            .map_err(|error| AppError::Process(format!("Could not create a Start menu shortcut: {error}")))?;
        link.SetPath(PCWSTR(executable_wide.as_ptr()))
            .map_err(|error| AppError::Process(format!("Could not set the SLH shortcut target: {error}")))?;
        link.SetIconLocation(PCWSTR(executable_wide.as_ptr()), 0)
            .map_err(|error| AppError::Process(format!("Could not set the SLH shortcut icon: {error}")))?;
        link.SetDescription(PCWSTR(description_wide.as_ptr()))
            .map_err(|error| AppError::Process(format!("Could not label the SLH shortcut: {error}")))?;

        let property_store: IPropertyStore = link
            .cast()
            .map_err(|error| AppError::Process(format!("Could not configure the SLH notification identity: {error}")))?;
        // A VT_LPWSTR PROPVARIANT owns COM task memory. Pointing it at a Rust
        // Vec can corrupt the process heap when Windows releases the value.
        let app_id_ptr = CoTaskMemAlloc(app_id_wide.len() * size_of::<u16>()) as *mut u16;
        if app_id_ptr.is_null() {
            return Err(AppError::Process("Could not allocate the notification identity".into()));
        }
        std::ptr::copy_nonoverlapping(app_id_wide.as_ptr(), app_id_ptr, app_id_wide.len());
        let mut app_id = PROPVARIANT {
            Anonymous: PROPVARIANT_0 {
                Anonymous: ManuallyDrop::new(PROPVARIANT_0_0 {
                    vt: VT_LPWSTR,
                    wReserved1: 0,
                    wReserved2: 0,
                    wReserved3: 0,
                    Anonymous: PROPVARIANT_0_0_0 {
                        pwszVal: PWSTR(app_id_ptr),
                    },
                }),
            },
        };
        let identity_result = property_store
            .SetValue(&PKEY_AppUserModel_ID, &app_id)
            .and_then(|()| property_store.Commit())
            .map_err(|error| AppError::Process(format!("Could not save the SLH notification identity: {error}")));
        PropVariantClear(&mut app_id)
            .map_err(|error| AppError::Process(format!("Could not release the SLH notification identity: {error}")))?;
        identity_result?;

        let persist_file: IPersistFile = link
            .cast()
            .map_err(|error| AppError::Process(format!("Could not save the SLH shortcut: {error}")))?;
        persist_file
            .Save(PCWSTR(shortcut_wide.as_ptr()), true)
            .map_err(|error| AppError::Process(format!("Could not save the SLH Start menu shortcut: {error}")))?;
        Ok(())
    })();
    unsafe { CoUninitialize() };
    result?;
    // The old notification-specific label also appeared in the taskbar.
    if legacy_path.is_file() { std::fs::remove_file(legacy_path)?; }
    let legacy_pin = app_data.join("Microsoft/Internet Explorer/Quick Launch/User Pinned/TaskBar/SLH Notifications.lnk");
    let corrected_pin = legacy_pin.with_file_name("Smile LauncHer.lnk");
    if legacy_pin.is_file() && !corrected_pin.exists() {
        // Rename preserves the pinned shortcut's AppUserModelID and shell properties.
        std::fs::rename(legacy_pin, corrected_pin)?;
    }
    Ok(())
}

#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;

/// The toast header icon is resolved from the app identity, rather than the
/// image inside the toast. Keep it in a stable per-user location for portable SLH.
#[cfg(windows)]
fn register_notification_branding(app_data: &std::path::Path) -> AppResult<()> {
    use windows::core::PCWSTR;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER,
        KEY_SET_VALUE, REG_OPTION_NON_VOLATILE, REG_EXPAND_SZ,
    };
    let directory = app_data.join("Smile LauncHer").join("notifications");
    std::fs::create_dir_all(&directory)?;
    let icon = directory.join("launcher.png");
    let bytes = include_bytes!("../icons/128x128.png");
    if std::fs::read(&icon).ok().as_deref() != Some(bytes.as_slice()) {
        std::fs::write(&icon, bytes)?;
    }
    let header_icon = directory.join("launcher-header.png");
    let header_bytes = include_bytes!("../icons/32x32.png");
    if std::fs::read(&header_icon).ok().as_deref() != Some(header_bytes.as_slice()) {
        std::fs::write(&header_icon, header_bytes)?;
    }
    let key_name: Vec<u16> = format!("Software\\Classes\\AppUserModelId\\{NOTIFICATION_MODEL_ID}")
        .encode_utf16().chain(Some(0)).collect();
    let mut key = HKEY::default();
    unsafe {
        RegCreateKeyExW(HKEY_CURRENT_USER, PCWSTR(key_name.as_ptr()), None, None,
            REG_OPTION_NON_VOLATILE, KEY_SET_VALUE, None, &mut key, None)
            .ok().map_err(|error| AppError::Process(format!("Could not register notification branding: {error}")))?;
    }
    let result = (|| -> AppResult<()> {
        for (name, value) in [("DisplayName", "Smile LauncHer".to_owned()),
                              ("IconUri", header_icon.to_string_lossy().into_owned()),
                              ("IconBackgroundColor", "FF202426".to_owned())] {
            let name: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
            let value: Vec<u8> = value.encode_utf16().chain(Some(0)).flat_map(u16::to_le_bytes).collect();
            unsafe { RegSetValueExW(key, PCWSTR(name.as_ptr()), None, REG_EXPAND_SZ, Some(&value)) }
                .ok().map_err(|error| AppError::Process(format!("Could not set notification branding: {error}")))?;
        }
        Ok(())
    })();
    unsafe { let _ = RegCloseKey(key); }
    result
}

/// Use the registered app identity for the small header icon. A logo inside
/// ToastGeneric would create a separate large image alongside the message.
#[cfg(windows)]
pub fn send_native(title: &str, body: Option<&str>) -> AppResult<()> {
    let title = title.to_owned();
    let body = body.map(str::to_owned);
    std::thread::spawn(move || {
        use windows::core::HSTRING;
        use windows::Data::Xml::Dom::XmlDocument;
        use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};
        use windows::Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED};
        let app_data = std::env::var_os("APPDATA").map(std::path::PathBuf::from)
            .ok_or_else(|| AppError::Unavailable("APPDATA is not available".into()))?;
        register_notification_branding(&app_data)?;
        unsafe { RoInitialize(RO_INIT_MULTITHREADED) }
            .map_err(|error| AppError::Process(format!("Could not initialize system notifications: {error}")))?;
        let result = (|| -> windows::core::Result<()> {
            let document = XmlDocument::new()?;
            document.LoadXml(&HSTRING::from(toast_xml(&title, body.as_deref())))?;
            let toast = ToastNotification::CreateToastNotification(&document)?;
            let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(NOTIFICATION_MODEL_ID))?;
            notifier.Show(&toast)
        })();
        unsafe { RoUninitialize(); }
        result.map_err(|error| AppError::Process(format!("Could not show system notification: {error}")))
    }).join().map_err(|_| AppError::Process("System notification thread failed".into()))?
}

#[cfg(windows)]
fn toast_xml(title: &str, body: Option<&str>) -> String {
    fn escape(value: &str) -> String {
        value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
            .replace('"', "&quot;").replace('\'', "&apos;")
    }
    let body = body.filter(|value| !value.trim().is_empty())
        .map(|value| format!("<text>{}</text>", escape(value.trim()))).unwrap_or_default();
    format!("<toast><visual><binding template=\"ToastGeneric\"><text>{}</text>{}</binding></visual><audio silent=\"true\"/></toast>", escape(title), body)
}

#[cfg(all(test, windows))]
mod tests {
    #[test]
    fn compact_toast_has_no_body_image_and_escapes_text() {
        let xml = super::toast_xml("Saved <profile> & settings", Some("\"test\""));
        assert!(!xml.contains("<image"));
        assert!(xml.contains("<audio silent=\"true\"/>"));
        assert!(xml.contains("Saved &lt;profile&gt; &amp; settings"));
        assert!(xml.contains("&quot;test&quot;"));
        assert!(!super::toast_xml("Saved", Some("  ")).contains("<text></text>"));
    }
}
