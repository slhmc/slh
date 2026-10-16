//! Preserve view preferences when moving to an explicit WebView2 profile.
use tauri::Manager;

/// Preserve persisted view preferences on the first production profile split.
/// Explicit data roots are independent and must not import the user's profile.
pub fn preserve_legacy_local_storage(app: &tauri::AppHandle, destination: &std::path::Path) -> std::io::Result<()> {
    if std::env::args().any(|arg| arg == "--data-dir" || arg == "--isolated") || destination.exists() { return Ok(()); }
    let source = app.path().app_local_data_dir().map_err(std::io::Error::other)?
        .join("EBWebView").join("Default").join("Local Storage");
    if !source.is_dir() { return Ok(()); }
    let destination = destination.join("EBWebView").join("Default").join("Local Storage");
    for entry in walkdir::WalkDir::new(&source).follow_links(false) {
        let entry = entry.map_err(std::io::Error::other)?;
        if entry.file_name() == "LOCK" || entry.file_type().is_symlink() { continue; }
        let target = destination.join(entry.path().strip_prefix(&source).map_err(std::io::Error::other)?);
        if entry.file_type().is_dir() { std::fs::create_dir_all(&target)?; }
        else if entry.file_type().is_file() { std::fs::copy(entry.path(), &target)?; }
    }
    Ok(())
}

