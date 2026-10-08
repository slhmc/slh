use async_trait::async_trait;
use base64::Engine;
use regex::Regex;
use reqwest::header::LOCATION;
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::models::{
    Account, AccountAppearance, AccountTexture, CreateOfflineAccountRequest, ProviderAvailability,
};

pub mod elyby;
pub mod microsoft;

#[derive(Clone, Debug)]
pub struct AccountLaunchCredentials {
    pub username: String,
    pub uuid: String,
    pub access_token: String,
    pub user_type: String,
    pub extra_jvm_arguments: Vec<String>,
}

#[allow(dead_code)]
#[async_trait]
pub trait AccountProvider: Send + Sync {
    fn provider_type(&self) -> &'static str;
    fn availability(&self) -> ProviderAvailability;
    async fn refresh(&self, account: &Account) -> AppResult<Account>;
    async fn logout(&self, account: &Account) -> AppResult<()>;
}

pub struct OfflineProvider;

#[async_trait]
impl AccountProvider for OfflineProvider {
    fn provider_type(&self) -> &'static str {
        "offline"
    }

    fn availability(&self) -> ProviderAvailability {
        ProviderAvailability {
            provider: "offline".into(),
            available: true,
            message: None,
        }
    }

    async fn refresh(&self, account: &Account) -> AppResult<Account> {
        Ok(account.clone())
    }

    async fn logout(&self, _account: &Account) -> AppResult<()> {
        Ok(())
    }
}

pub fn provider_availability() -> Vec<ProviderAvailability> {
    let microsoft_client_id = microsoft::client_id();
    vec![
        OfflineProvider.availability(),
        ProviderAvailability {
            provider: "microsoft".into(),
            available: microsoft_client_id.is_some(),
            message: microsoft_client_id.is_none().then(|| {
                "Microsoft authentication is not configured. Set SLH_MICROSOFT_CLIENT_ID before starting SLH; new client IDs may also require Minecraft Services approval.".into()
            }),
        },
        ProviderAvailability {
            provider: "elyby".into(),
            available: true,
            message: Some("Ely.by sign-in may request 2FA. The verified authentication agent is downloaded automatically on first launch.".into()),
        },
    ]
}

pub fn offline_uuid(username: &str) -> Uuid {
    let digest = md5::compute(format!("OfflinePlayer:{username}"));
    let mut bytes = digest.0;
    bytes[6] = (bytes[6] & 0x0f) | 0x30;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes)
}

/// Build a temporary offline identity for a single launch.  It is deliberately
/// not written to the accounts database and cannot replace the selected online
/// account, tokens, or account order.
pub fn offline_launch_credentials(username: &str) -> AppResult<AccountLaunchCredentials> {
    let username = validate_offline_username(username)?;
    Ok(AccountLaunchCredentials {
        uuid: offline_uuid(&username).to_string(),
        username,
        access_token: "0".into(),
        user_type: "legacy".into(),
        extra_jvm_arguments: Vec::new(),
    })
}

pub async fn cache_skin_texture(
    state: &crate::state::AppState,
    account_id: &str,
    url: &str,
) -> AppResult<Option<String>> {
    let Some(bytes) = download_texture(url).await? else {
        return Ok(None);
    };
    let destination = state.paths.accounts.join(format!("{account_id}.skin.png"));
    let temporary = destination.with_extension(format!("{}.tmp", Uuid::new_v4()));
    tokio::fs::write(&temporary, &bytes).await?;
    if destination.exists() {
        tokio::fs::remove_file(&destination).await?;
    }
    tokio::fs::rename(&temporary, &destination).await?;
    let path = destination.to_string_lossy().into_owned();
    sqlx::query("UPDATE accounts SET avatar_cache_path = ? WHERE id = ?")
        .bind(&path)
        .bind(account_id)
        .execute(&state.database)
        .await?;
    Ok(Some(path))
}

pub async fn texture_data_url(url: &str) -> AppResult<Option<String>> {
    // A missing skin/cape texture must not prevent the appearance editor from
    // opening. The profile metadata is still useful even when the CDN is
    // temporarily unavailable, so treat texture fetches as best-effort here.
    match download_texture(url).await {
        Ok(bytes) => Ok(bytes.map(|bytes| {
            format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            )
        })),
        Err(error) => {
            tracing::debug!(%error, url, "Account texture is temporarily unavailable");
            Ok(None)
        }
    }
}

/// Return both the original cape sheet (used by the 3D player model) and a
/// small thumbnail containing only the left-most/front face of that sheet.
/// Microsoft cape sheets hold several faces side by side; shrinking the
/// entire image makes the preview look like two broken capes.
pub async fn cape_texture_data_urls(url: &str) -> AppResult<(Option<String>, Option<String>)> {
    let bytes = match download_texture(url).await {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return Ok((None, None)),
        Err(error) => {
            tracing::debug!(%error, url, "Cape texture is temporarily unavailable");
            return Ok((None, None));
        }
    };
    let data_url = Some(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    ));
    let thumbnail_data_url =
        match image::load_from_memory_with_format(&bytes, image::ImageFormat::Png) {
            Ok(image) => {
                // Official capes are normally 64x32. Their visible front is the
                // 10x16 region at the far left. Keep a proportional fallback for
                // a non-standard cape returned by the service.
                let width = if image.width() >= 64 {
                    10
                } else {
                    (image.width() / 6).max(1)
                };
                let height = if image.height() >= 32 {
                    16
                } else {
                    (image.height() / 2).max(1)
                };
                // The first column is a seam on Minecraft cape textures. Skip it so
                // the thumbnail shows the front panel instead of the edge strip.
                let x = u32::from(image.width() > width);
                let crop_width = width.min(image.width().saturating_sub(x)).max(1);
                let thumbnail = image.crop_imm(x, 0, crop_width, height.min(image.height()));
                let mut output = std::io::Cursor::new(Vec::new());
                match thumbnail.write_to(&mut output, image::ImageFormat::Png) {
                    Ok(()) => Some(format!(
                        "data:image/png;base64,{}",
                        base64::engine::general_purpose::STANDARD.encode(output.into_inner())
                    )),
                    Err(error) => {
                        tracing::debug!(%error, url, "Cape thumbnail could not be encoded");
                        None
                    }
                }
            }
            Err(error) => {
                tracing::debug!(%error, url, "Cape thumbnail could not be decoded");
                None
            }
        };
    Ok((data_url, thumbnail_data_url))
}

pub async fn cached_texture_data_url(
    state: &crate::state::AppState,
    account_id: &str,
) -> Option<String> {
    let path = state.paths.accounts.join(format!("{account_id}.skin.png"));
    let bytes = tokio::fs::read(path).await.ok()?;
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return None;
    }
    Some(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

/// Store the last known Microsoft appearance separately from authentication
/// data. This is intentionally only public profile metadata and CDN images;
/// OAuth tokens remain in the DPAPI-encrypted token blob.
pub async fn cache_appearance(
    state: &crate::state::AppState,
    appearance: &AccountAppearance,
) -> AppResult<()> {
    let destination = state
        .paths
        .accounts
        .join(format!("{}.appearance.json", appearance.account_id));
    let temporary = destination.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let bytes = serde_json::to_vec(appearance)?;
    tokio::fs::write(&temporary, bytes).await?;
    if destination.exists() {
        tokio::fs::remove_file(&destination).await?;
    }
    tokio::fs::rename(temporary, destination).await?;
    Ok(())
}

pub async fn cached_appearance(
    state: &crate::state::AppState,
    account_id: &str,
) -> Option<AccountAppearance> {
    let path = state
        .paths
        .accounts
        .join(format!("{account_id}.appearance.json"));
    let bytes = tokio::fs::read(path).await.ok()?;
    // Do not ever load an unexpectedly large cache into the UI after a
    // damaged write. Typical skin/cape caches are far smaller than this.
    if bytes.len() > 8 * 1024 * 1024 {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

async fn download_texture(url: &str) -> AppResult<Option<Vec<u8>>> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .https_only(true)
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(30))
        .user_agent("SLH/0.1.2 (account skin cache)")
        .build()?;
    let mut current_url = secure_skin_url(url)?;
    let mut final_response = None;
    for _ in 0..5 {
        let response = client.get(current_url.clone()).send().await?;
        if !response.status().is_redirection() {
            final_response = Some(response);
            break;
        }
        let location = response
            .headers()
            .get(LOCATION)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| AppError::Security("Account skin redirect had no location".into()))?;
        let next_url = secure_skin_url(
            current_url
                .join(location)
                .map_err(|_| AppError::Security("Account skin redirect was invalid".into()))?
                .as_str(),
        )?;
        if next_url == current_url {
            return Err(AppError::Security(
                "Account skin redirect loop detected".into(),
            ));
        }
        current_url = next_url;
    }
    let response = final_response
        .ok_or_else(|| AppError::Security("Account skin used too many redirects".into()))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND
        || response.status() == reqwest::StatusCode::NO_CONTENT
    {
        return Ok(None);
    }
    let response = response.error_for_status()?;
    if response
        .content_length()
        .is_some_and(|length| length > 2 * 1024 * 1024)
    {
        return Err(AppError::Security("Account skin exceeded 2 MB".into()));
    }
    let bytes = response.bytes().await?;
    if bytes.len() > 2 * 1024 * 1024 || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err(AppError::Security(
            "Account skin is not a valid PNG texture".into(),
        ));
    }
    Ok(Some(bytes.to_vec()))
}

fn secure_skin_url(value: &str) -> AppResult<url::Url> {
    let mut parsed = url::Url::parse(value)
        .map_err(|_| AppError::Security("Account skin URL is invalid".into()))?;
    if parsed.scheme() == "http"
        && matches!(parsed.host_str(), Some("textures.minecraft.net" | "ely.by"))
    {
        parsed
            .set_scheme("https")
            .map_err(|_| AppError::Security("Account skin URL could not use HTTPS".into()))?;
    }
    if parsed.scheme() != "https" {
        return Err(AppError::Security("Account skin URL must use HTTPS".into()));
    }
    Ok(parsed)
}

pub async fn hydrate_missing_avatars(state: &crate::state::AppState) {
    let accounts = match crate::database::accounts(&state.database).await {
        Ok(accounts) => accounts,
        Err(error) => {
            tracing::warn!(%error, "could not enumerate accounts for avatar cache");
            return;
        }
    };
    for account in accounts {
        if account.provider == "offline" {
            continue;
        }
        let expected_path = state
            .paths
            .accounts
            .join(format!("{}.skin.png", account.id));
        if expected_path.is_file() {
            let expected = expected_path.to_string_lossy().into_owned();
            if account.avatar_cache_path.as_deref() != Some(expected.as_str()) {
                if let Err(error) =
                    sqlx::query("UPDATE accounts SET avatar_cache_path = ? WHERE id = ?")
                        .bind(&expected)
                        .bind(&account.id)
                        .execute(&state.database)
                        .await
                {
                    tracing::warn!(%error, account_id = %account.id, "account avatar cache path repair failed");
                }
            }
            continue;
        }
        let result = match account.provider.as_str() {
            "elyby" => {
                let username = url::form_urlencoded::byte_serialize(account.username.as_bytes())
                    .collect::<String>();
                cache_skin_texture(
                    state,
                    &account.id,
                    &format!("https://skinsystem.ely.by/skins/{username}.png"),
                )
                .await
                .map(|_| ())
            }
            "microsoft" => microsoft::refresh_avatar(state, &account).await,
            _ => Ok(()),
        };
        if let Err(error) = result {
            tracing::warn!(%error, account_id = %account.id, "account avatar refresh failed");
        }
    }
}

pub async fn launch_credentials(
    state: &crate::state::AppState,
    account: &Account,
) -> AppResult<AccountLaunchCredentials> {
    match account.provider.as_str() {
        "offline" => Ok(AccountLaunchCredentials {
            username: account.username.clone(),
            uuid: account.provider_uuid.clone(),
            access_token: "0".into(),
            user_type: "legacy".into(),
            extra_jvm_arguments: Vec::new(),
        }),
        "elyby" => elyby::launch_credentials(state, account).await,
        "microsoft" => microsoft::launch_credentials(state, account).await,
        provider => Err(AppError::InvalidInput(format!(
            "Unknown account provider: {provider}"
        ))),
    }
}

pub async fn appearance(
    state: &crate::state::AppState,
    account_id: &str,
) -> AppResult<AccountAppearance> {
    let account = crate::database::accounts(&state.database)
        .await?
        .into_iter()
        .find(|account| account.id == account_id)
        .ok_or_else(|| AppError::NotFound(format!("Account {account_id}")))?;
    match account.provider.as_str() {
        "microsoft" => match microsoft::appearance(state, &account).await {
            Ok(appearance) => Ok(appearance),
            Err(error) => {
                if let Some(mut cached) = cached_appearance(state, &account.id).await {
                    cached.message = Some(format!(
                        "Microsoft profile is temporarily unavailable: {error}"
                    ));
                    return Ok(cached);
                }
                // Keep the appearance editor usable when the remote profile
                // endpoint is temporarily unavailable.  The active skin is
                // cached after a successful profile read, so users can still
                // inspect it and prepare a new upload while the next save
                // reports the precise authentication/network failure.
                let cached_skin = cached_texture_data_url(state, &account.id).await;
                Ok(AccountAppearance {
                    account_id: account.id,
                    provider: account.provider,
                    username: account.username,
                    can_change_skin: true,
                    can_change_cape: true,
                    message: Some(format!(
                        "Microsoft profile is temporarily unavailable: {error}"
                    )),
                    skins: cached_skin
                        .map(|data_url| AccountTexture {
                            id: "cached-active-skin".into(),
                            data_url: Some(data_url),
                            thumbnail_data_url: None,
                            variant: None,
                            alias: Some("Cached skin".into()),
                            active: true,
                        })
                        .into_iter()
                        .collect(),
                    capes: Vec::new(),
                })
            }
        },
        "elyby" => {
            let encoded = url::form_urlencoded::byte_serialize(account.username.as_bytes())
                .collect::<String>();
            let skin =
                texture_data_url(&format!("https://skinsystem.ely.by/skins/{encoded}.png")).await?;
            let cape = texture_data_url(&format!("https://skinsystem.ely.by/cloaks/{encoded}.png"))
                .await?;
            Ok(AccountAppearance {
                account_id: account.id,
                provider: account.provider,
                username: account.username,
                can_change_skin: false,
                can_change_cape: false,
                message: Some("Ely.by does not document a third-party API for changing skins or capes. Manage appearance on the Ely.by website.".into()),
                skins: skin.into_iter().map(|data_url| AccountTexture { id: "ely-current".into(), data_url: Some(data_url), thumbnail_data_url: None, variant: None, alias: Some("Current skin".into()), active: true }).collect(),
                capes: cape.into_iter().map(|data_url| AccountTexture { id: "ely-current-cape".into(), data_url: Some(data_url), thumbnail_data_url: None, variant: None, alias: Some("Current cape".into()), active: true }).collect(),
            })
        }
        "offline" => Ok(AccountAppearance {
            account_id: account.id,
            provider: account.provider,
            username: account.username,
            can_change_skin: false,
            can_change_cape: false,
            message: Some("Offline accounts do not have a remote skin profile.".into()),
            skins: Vec::new(),
            capes: Vec::new(),
        }),
        provider => Err(AppError::InvalidInput(format!(
            "Unknown account provider: {provider}"
        ))),
    }
}

pub async fn home_skin(
    state: &crate::state::AppState,
    account_id: &str,
) -> AppResult<serde_json::Value> {
    let account = account_by_id(state, account_id).await?;
    let result = match account.provider.as_str() {
        "microsoft" => microsoft::home_skin(state, &account).await,
        "elyby" => {
            let encoded = url::form_urlencoded::byte_serialize(account.username.as_bytes())
                .collect::<String>();
            match cache_skin_texture(
                state,
                account_id,
                &format!("https://skinsystem.ely.by/skins/{encoded}.png"),
            )
            .await
            {
                Ok(Some(_)) => {
                    let data = cached_texture_data_url(state, account_id).await;
                    let model = data
                        .as_deref()
                        .map(infer_home_skin_model)
                        .unwrap_or("classic");
                    Ok(serde_json::json!({ "dataUrl": data, "model": model }))
                }
                _ => Err(AppError::Unavailable("Skin temporarily unavailable".into())),
            }
        }
        "offline" => return Ok(serde_json::json!({ "dataUrl": null, "model": "classic" })),
        _ => return Err(AppError::InvalidInput("Unknown account provider".into())),
    };
    let cache_path = state
        .paths
        .accounts
        .join(format!("{account_id}.home-skin.json"));
    if let Ok(value) = result {
        if value["dataUrl"].is_string() {
            let _ = tokio::fs::write(&cache_path, serde_json::to_vec(&value)?).await;
        }
        return Ok(value);
    }
    if let Ok(bytes) = tokio::fs::read(cache_path).await {
        if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
            return Ok(value);
        }
    }
    let data = cached_texture_data_url(state, account_id).await;
    let variant = cached_appearance(state, account_id)
        .await
        .and_then(|appearance| {
            appearance
                .skins
                .into_iter()
                .find(|skin| skin.active)
                .and_then(|skin| skin.variant)
        });
    let model = match variant.as_deref() {
        Some("slim") => "slim",
        Some("classic") | Some("wide") => "classic",
        _ => data
            .as_deref()
            .map(infer_home_skin_model)
            .unwrap_or("classic"),
    };
    Ok(serde_json::json!({ "dataUrl": data, "model": model }))
}

fn infer_home_skin_model(data: &str) -> &'static str {
    let Some(encoded) = data.split_once(',').map(|(_, data)| data) else {
        return "classic";
    };
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(encoded) else {
        return "classic";
    };
    let Ok(image) = image::load_from_memory(&bytes).map(|image| image.to_rgba8()) else {
        return "classic";
    };
    if image.width() < 64 || image.height() < image.width() || image.width() % 64 != 0 {
        return "classic";
    }
    let scale = image.width() / 64;
    let mut black = true;
    let mut white = true;
    for (x, y, w, h) in [
        (50, 16, 2, 4),
        (54, 20, 2, 12),
        (42, 48, 2, 4),
        (46, 52, 2, 12),
    ] {
        for py in y * scale..(y + h) * scale {
            for px in x * scale..(x + w) * scale {
                let pixel = image.get_pixel(px, py).0;
                if pixel[3] < 255 {
                    return "slim";
                }
                black &= pixel[..3] == [0, 0, 0];
                white &= pixel[..3] == [255, 255, 255];
            }
        }
    }
    if black || white { "slim" } else { "classic" }
}

async fn account_by_id(state: &crate::state::AppState, account_id: &str) -> AppResult<Account> {
    crate::database::accounts(&state.database)
        .await?
        .into_iter()
        .find(|account| account.id == account_id)
        .ok_or_else(|| AppError::NotFound(format!("Account {account_id}")))
}

pub async fn upload_skin(
    state: &crate::state::AppState,
    account_id: &str,
    source_path: &str,
    variant: &str,
) -> AppResult<AccountAppearance> {
    let account = account_by_id(state, account_id).await?;
    if account.provider != "microsoft" {
        return Err(AppError::Unavailable(
            "Skin changes are only available for Microsoft accounts".into(),
        ));
    }
    microsoft::upload_skin(state, &account, source_path, variant).await
}

pub async fn upload_skin_bytes(
    state: &crate::state::AppState,
    account_id: &str,
    bytes: Vec<u8>,
    file_name: &str,
    variant: &str,
    existing_skin_id: Option<&str>,
) -> AppResult<AccountAppearance> {
    let account = account_by_id(state, account_id).await?;
    if account.provider != "microsoft" {
        return Err(AppError::Unavailable(
            "Skin changes are only available for Microsoft accounts".into(),
        ));
    }
    microsoft::upload_skin_bytes(state, &account, bytes, file_name, variant, existing_skin_id).await
}

pub async fn select_cape(
    state: &crate::state::AppState,
    account_id: &str,
    cape_id: Option<&str>,
) -> AppResult<AccountAppearance> {
    let account = account_by_id(state, account_id).await?;
    if account.provider != "microsoft" {
        return Err(AppError::Unavailable(
            "Cape changes are only available for Microsoft accounts".into(),
        ));
    }
    microsoft::select_cape(state, &account, cape_id).await
}

pub async fn delete_saved_skin(
    state: &crate::state::AppState,
    account_id: &str,
    skin_id: &str,
) -> AppResult<AccountAppearance> {
    let account = account_by_id(state, account_id).await?;
    if account.provider != "microsoft" {
        return Err(AppError::Unavailable(
            "Saved skins are only available for Microsoft accounts".into(),
        ));
    }
    microsoft::delete_saved_skin(state, &account, skin_id).await
}

pub fn validate_offline_username(username: &str) -> AppResult<String> {
    let username = username.trim();
    let pattern = Regex::new(r"^[A-Za-z0-9_]{3,16}$").expect("username regex is valid");
    if !pattern.is_match(username) {
        return Err(AppError::InvalidInput(
            "Minecraft username must contain 3 to 16 letters, numbers, or underscores".into(),
        ));
    }
    Ok(username.to_owned())
}

fn validate_custom_offline_username(username: &str) -> AppResult<String> {
    let username = username.trim();
    if username.is_empty()
        || username.chars().count() > 64
        || username.chars().any(|c| {
            c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
        })
    {
        return Err(AppError::InvalidInput(
            "Custom nickname must be 1 to 64 characters and cannot contain control characters or path separators".into(),
        ));
    }
    Ok(username.to_owned())
}

pub async fn create_offline_account(
    pool: &SqlitePool,
    request: CreateOfflineAccountRequest,
) -> AppResult<Account> {
    let username = if request.allow_invalid_username {
        validate_custom_offline_username(&request.username)?
    } else {
        validate_offline_username(&request.username)?
    };
    let provider_uuid = offline_uuid(&username).to_string();
    let id = Uuid::new_v4().to_string();
    let mut transaction = pool.begin().await?;
    sqlx::query(
        "UPDATE accounts SET active = 0 \
         WHERE LOWER(TRIM(CAST(active AS TEXT))) IN ('1', 'true', 'yes', 'on')",
    )
    .execute(&mut *transaction)
    .await?;
    sqlx::query(
        "INSERT INTO accounts(id, provider, provider_uuid, username, auth_status, active) \
         VALUES (?, 'offline', ?, ?, 'ready', 1) \
         ON CONFLICT(provider, provider_uuid) DO UPDATE SET username = excluded.username, \
         auth_status = 'ready', active = 1",
    )
    .bind(&id)
    .bind(&provider_uuid)
    .bind(&username)
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    let account = sqlx::query_as::<_, Account>(
        "SELECT id, provider, provider_uuid, xbox_xuid, username, avatar_cache_path, auth_status, \
         last_auth_at, active, created_at FROM accounts WHERE provider = 'offline' AND provider_uuid = ?",
    )
    .bind(provider_uuid)
    .fetch_one(pool)
    .await?;
    Ok(account)
}

pub async fn activate_account(pool: &SqlitePool, account_id: &str) -> AppResult<Account> {
    let mut transaction = pool.begin().await?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM accounts WHERE id = ?)")
        .bind(account_id)
        .fetch_one(&mut *transaction)
        .await?;
    if !exists {
        return Err(AppError::NotFound(format!("Account {account_id}")));
    }
    sqlx::query(
        "UPDATE accounts SET active = 0 \
         WHERE LOWER(TRIM(CAST(active AS TEXT))) IN ('1', 'true', 'yes', 'on')",
    )
    .execute(&mut *transaction)
    .await?;
    sqlx::query("UPDATE accounts SET active = 1 WHERE id = ?")
        .bind(account_id)
        .execute(&mut *transaction)
        .await?;
    transaction.commit().await?;
    Ok(sqlx::query_as::<_, Account>(
        "SELECT id, provider, provider_uuid, xbox_xuid, username, avatar_cache_path, auth_status, \
         last_auth_at, active, created_at FROM accounts WHERE id = ?",
    )
    .bind(account_id)
    .fetch_one(pool)
    .await?)
}

pub async fn delete_account(state: &crate::state::AppState, account_id: &str) -> AppResult<()> {
    let mut transaction = state.database.begin().await?;
    let removed = sqlx::query("DELETE FROM accounts WHERE id = ?")
        .bind(account_id)
        .execute(&mut *transaction)
        .await?;
    if removed.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("Account {account_id}")));
    }
    transaction.commit().await?;

    for path in [
        state.paths.accounts.join(format!("{account_id}.dpapi")),
        state.paths.accounts.join(format!("{account_id}.skin.png")),
    ] {
        if path.extension().is_some_and(|e| e == "dpapi") {
            if let Ok(cipher) = tokio::fs::read(&path).await {
                let _ = crate::security::delete_credential_reference(&cipher);
            }
        }
        match tokio::fs::remove_file(&path).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                tracing::warn!(%error, path = %path.display(), "account credential cache could not be removed")
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn home_skin_model_detects_classic_slim_legacy_and_invalid_textures() {
        fn encoded(image: image::RgbaImage) -> String {
            let mut bytes = std::io::Cursor::new(Vec::new());
            image::DynamicImage::ImageRgba8(image)
                .write_to(&mut bytes, image::ImageFormat::Png)
                .unwrap();
            format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes.into_inner())
            )
        }
        let classic = image::RgbaImage::from_pixel(64, 64, image::Rgba([80, 110, 140, 255]));
        assert_eq!(infer_home_skin_model(&encoded(classic.clone())), "classic");
        let mut slim = classic;
        slim.put_pixel(50, 16, image::Rgba([0, 0, 0, 0]));
        assert_eq!(infer_home_skin_model(&encoded(slim)), "slim");
        assert_eq!(
            infer_home_skin_model(&encoded(image::RgbaImage::new(64, 32))),
            "classic"
        );
        assert_eq!(infer_home_skin_model("not a texture"), "classic");
        assert_eq!(
            infer_home_skin_model("data:image/png;base64,invalid"),
            "classic"
        );
    }

    #[test]
    fn standard_offline_uuid_is_stable() {
        assert_eq!(
            offline_uuid("Notch").to_string(),
            "b50ad385-829d-3141-a216-7e7d7539ba7f"
        );
    }

    #[test]
    fn username_validation_matches_minecraft_constraints() {
        assert!(validate_offline_username("Player_123").is_ok());
        assert!(validate_offline_username("ab").is_err());
        assert!(validate_offline_username("not valid").is_err());
        assert!(validate_custom_offline_username("Player with spaces").is_ok());
        assert!(validate_custom_offline_username("bad/name").is_err());
    }

    #[test]
    fn known_skin_hosts_are_upgraded_but_unknown_http_is_rejected() {
        assert_eq!(
            secure_skin_url("http://ely.by/storage/skins/example.png")
                .unwrap()
                .scheme(),
            "https"
        );
        assert!(secure_skin_url("http://example.com/skin.png").is_err());
    }
}
