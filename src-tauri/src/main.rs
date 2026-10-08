// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(all(not(debug_assertions), dev))]
compile_error!("Release SLH must embed its frontend: build with `npx tauri build --no-bundle` (tauri/custom-protocol).");

fn main() {
    if std::env::args().any(|arg| arg == "--check-build-mode") {
        std::process::exit(if cfg!(dev) { 3 } else { 0 });
    }
    #[cfg(windows)]
    if std::env::args().any(|arg| arg == "--check-webview-runtime") {
        std::process::exit(if tauri::webview_version().is_ok() { 0 } else { 2 });
    }
    slh_lib::run()
}
