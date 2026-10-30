use super::store;
use crate::{error::AppResult, state::AppState};
pub async fn get(state: &AppState, id: &str) -> AppResult<Option<String>> {
    use base64::Engine;
    let s = store::get(state, id).await?;
    let p = std::path::Path::new(&s.path).join("server-icon.png");
    store::plain_path(&p)?;
    if !p.is_file() || p.metadata()?.len() > 2 * 1024 * 1024 {
        return Ok(None);
    }
    let data = std::fs::read(p)?;
    Ok(Some(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(data)
    )))
}
pub async fn set(state: &AppState, id: &str, path: &str) -> AppResult<()> {
    let s = store::idle(state, id).await?;
    let p = std::path::Path::new(path);
    store::plain_path(p)?;
    if p.metadata()?.len() > 2 * 1024 * 1024 {
        return Err(crate::error::AppError::InvalidInput(
            "Server icon exceeds 2 MiB".into(),
        ));
    }
    let bytes = std::fs::read(p)?;
    let img = image::load_from_memory(&bytes)
        .map_err(|e| crate::error::AppError::InvalidInput(e.to_string()))?;
    if img.width() != 64 || img.height() != 64 {
        return Err(crate::error::AppError::InvalidInput(
            "Server icon must be 64 × 64 pixels".into(),
        ));
    }
    let target = std::path::Path::new(&s.path).join("server-icon.png");
    store::plain_path(&target)?;
    if target.exists() {
        let backup = state
            .paths
            .backups
            .join("server-icons")
            .join(uuid::Uuid::new_v4().to_string())
            .join("server-icon.png");
        store::atomic_write(&backup, &std::fs::read(&target)?)?;
    }
    let mut png = std::io::Cursor::new(Vec::new());
    img.write_to(&mut png, image::ImageFormat::Png)
        .map_err(|e| crate::error::AppError::InvalidInput(e.to_string()))?;
    store::atomic_write(&target, &png.into_inner())?;
    Ok(())
}
