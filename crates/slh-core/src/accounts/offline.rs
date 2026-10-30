//! Local appearance storage for identities without a remote skin profile.
use base64::{Engine, engine::general_purpose::STANDARD};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{error::{AppError, AppResult}, models::{Account, AccountAppearance, AccountTexture}, state::AppState};

pub async fn appearance(state: &AppState, account: &Account) -> AppResult<AccountAppearance> {
    let mut value = super::cached_appearance(state, &account.id).await.unwrap_or(AccountAppearance {
        account_id: account.id.clone(), provider: account.provider.clone(), username: account.username.clone(),
        can_change_skin: true, can_change_cape: false, message: None, skins: vec![], capes: vec![],
    });
    value.account_id = account.id.clone();
    value.provider = account.provider.clone();
    value.username = account.username.clone();
    value.can_change_skin = true;
    value.can_change_cape = false;
    value.capes.clear();
    value.message = None;
    Ok(value)
}

fn validated_png(bytes: &[u8], variant: &str) -> AppResult<Vec<u8>> {
    if !matches!(variant, "classic" | "slim") {
        return Err(AppError::InvalidInput("Skin model must be classic or slim".into()));
    }
    if bytes.len() > 2 * 1024 * 1024 || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err(AppError::InvalidInput("Skin must be a PNG file no larger than 2 MB".into()));
    }
    let image = image::load_from_memory_with_format(bytes, image::ImageFormat::Png)
        .map_err(|_| AppError::InvalidInput("Skin PNG could not be decoded".into()))?;
    if !matches!((image.width(), image.height()), (64, 64) | (64, 32)) {
        return Err(AppError::InvalidInput("Skin dimensions must be 64x64 or legacy 64x32".into()));
    }
    // Drop arbitrary PNG metadata before retaining gallery entries.
    let mut png = std::io::Cursor::new(Vec::new());
    image.write_to(&mut png, image::ImageFormat::Png)
        .map_err(|_| AppError::InvalidInput("Skin PNG could not be encoded".into()))?;
    Ok(png.into_inner())
}

pub async fn upload(state: &AppState, account: &Account, bytes: Vec<u8>, file_name: &str, variant: &str, existing_id: Option<&str>) -> AppResult<AccountAppearance> {
    let bytes = validated_png(&bytes, variant)?;
    let mut value = appearance(state, account).await?;
    let id = existing_id.filter(|id| value.skins.iter().any(|skin| skin.id == *id)).map(str::to_owned)
        .unwrap_or_else(|| format!("local-{}", hex::encode(Sha256::digest(&bytes))));
    let alias = std::path::Path::new(file_name).file_stem().and_then(|name| name.to_str()).unwrap_or("Custom skin").chars().take(48).collect();
    let texture = AccountTexture { id: id.clone(), data_url: Some(format!("data:image/png;base64,{}", STANDARD.encode(&bytes))),
        thumbnail_data_url: None, variant: Some(variant.into()), alias: Some(alias), active: true };
    for skin in &mut value.skins { skin.active = false; }
    if let Some(skin) = value.skins.iter_mut().find(|skin| skin.id == id) { *skin = texture; }
    else { value.skins.push(texture); }
    persist(state, account, &value).await?;
    Ok(value)
}

pub async fn delete(state: &AppState, account: &Account, skin_id: &str) -> AppResult<AccountAppearance> {
    let mut value = appearance(state, account).await?;
    let active_removed = value.skins.iter().any(|skin| skin.id == skin_id && skin.active);
    value.skins.retain(|skin| skin.id != skin_id);
    if active_removed { for (index, skin) in value.skins.iter_mut().enumerate() { skin.active = index == 0; } }
    persist(state, account, &value).await?;
    Ok(value)
}

async fn persist(state: &AppState, account: &Account, value: &AccountAppearance) -> AppResult<()> {
    super::cache_appearance(state, value).await?;
    let path = state.paths.accounts.join(format!("{}.skin.png", account.id));
    if let Some(data) = value.skins.iter().find(|skin| skin.active).and_then(|skin| skin.data_url.as_deref()) {
        let encoded = data.strip_prefix("data:image/png;base64,").ok_or_else(|| AppError::InvalidInput("Skin texture is invalid".into()))?;
        let bytes = STANDARD.decode(encoded).map_err(|_| AppError::InvalidInput("Skin texture is invalid".into()))?;
        let temporary = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
        tokio::fs::write(&temporary, bytes).await?;
        if path.exists() { tokio::fs::remove_file(&path).await?; }
        tokio::fs::rename(temporary, &path).await?;
        sqlx::query("UPDATE accounts SET avatar_cache_path = ? WHERE id = ?").bind(path.to_string_lossy().as_ref()).bind(&account.id).execute(&state.database).await?;
    } else {
        match tokio::fs::remove_file(&path).await { Ok(()) => (), Err(error) if error.kind() == std::io::ErrorKind::NotFound => (), Err(error) => return Err(error.into()) }
        sqlx::query("UPDATE accounts SET avatar_cache_path = NULL WHERE id = ?").bind(&account.id).execute(&state.database).await?;
    }
    // Invalidate the last home-model snapshot after a texture/model change.
    let _ = tokio::fs::remove_file(state.paths.accounts.join(format!("{}.home-skin.json", account.id))).await;
    Ok(())
}
