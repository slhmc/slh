use crate::error::{AppError, AppResult};

const APP_USER_MODEL_ID: &str = "com.smilelauncher.slh";

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
    let shortcut_path = start_menu.join("Smile LauncHer.lnk");
    let legacy_path = start_menu.join("SLH Notifications.lnk");
    let executable = std::env::current_exe()?;
    let executable_wide: Vec<u16> = executable.as_os_str().encode_wide().chain(Some(0)).collect();
    let shortcut_wide: Vec<u16> = shortcut_path.as_os_str().encode_wide().chain(Some(0)).collect();
    let app_id_wide: Vec<u16> = APP_USER_MODEL_ID.encode_utf16().chain(Some(0)).collect();
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
