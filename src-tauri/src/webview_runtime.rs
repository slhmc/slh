//! The Windows UI uses the system Evergreen runtime. No local Fixed Runtime override.
#[cfg(windows)]
pub fn ensure_available() -> bool {
    if tauri::webview_version().is_ok() { return true; }
    use windows::core::w;
    use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_YESNO, MB_ICONINFORMATION, IDYES};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    unsafe {
        let answer = MessageBoxW(None,
            w!("SLH requires Microsoft Edge WebView2 Runtime. Install it, then start SLH again. Internet access is required for the download.\n\nSLH нужен Microsoft Edge WebView2 Runtime. Установите его и запустите SLH снова. Для скачивания нужен интернет.\n\nOpen the official download page / Открыть официальную страницу загрузки?"),
            w!("SLH — WebView2 Runtime"), MB_YESNO | MB_ICONINFORMATION);
        if answer == IDYES {
            let _ = ShellExecuteW(None, w!("open"), w!("https://developer.microsoft.com/microsoft-edge/webview2/"), None, None, SW_SHOWNORMAL);
        }
    }
    false
}
