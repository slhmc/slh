use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use crate::host::Host;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{Duration as ChronoDuration, Utc};
use reqwest::header::AUTHORIZATION;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::models::{Account, AccountAppearance, AccountTexture};
use crate::security::{decrypt_for_current_user, encrypt_for_current_user};
use crate::state::AppState;

const AUTHORIZE_URL: &str = "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize";
const TOKEN_URL: &str = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
const SCOPE: &str = "XboxLive.signin offline_access";
const MINECRAFT_XSTS_RELYING_PARTY: &str = "rp://api.minecraftservices.com/";
// Minecraft's XSTS relying party exposes the user hash needed for Java login,
// but not necessarily the Xbox user id. Obtain the latter from the standard
// Xbox Live profile relying party, just as the native Windows path does.
const XBOX_PROFILE_XSTS_RELYING_PARTY: &str = "http://xboxlive.com";

#[derive(Deserialize)]
struct OAuthToken {
    access_token: String,
    refresh_token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct XboxToken {
    token: String,
    display_claims: XboxClaims,
}

#[derive(Deserialize)]
struct XboxClaims {
    xui: Vec<XboxUserClaim>,
}

#[derive(Deserialize)]
struct XboxUserClaim {
    uhs: String,
    #[serde(default)]
    xid: Option<String>,
}

#[derive(Deserialize)]
struct MinecraftToken {
    access_token: String,
    expires_in: i64,
}

#[derive(Deserialize)]
struct MinecraftProfile {
    id: String,
    name: String,
    #[serde(default)]
    skins: Vec<MinecraftSkin>,
    #[serde(default)]
    capes: Vec<MinecraftCape>,
}

#[derive(Deserialize)]
struct MinecraftSkin {
    id: String,
    url: String,
    #[serde(default)]
    state: String,
    variant: Option<String>,
    alias: Option<String>,
}

#[derive(Deserialize)]
struct MinecraftCape {
    id: String,
    url: String,
    #[serde(default)]
    state: String,
    alias: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct MicrosoftTokenBlob {
    refresh_token: String,
    minecraft_access_token: String,
    minecraft_expires_at: String,
}

pub fn client_id() -> Option<String> {
    std::env::var("SLH_MICROSOFT_CLIENT_ID")
        .ok()
        .or_else(|| option_env!("SLH_MICROSOFT_CLIENT_ID").map(str::to_owned))
        // A public OAuth client identifier is configuration, not a secret.
        // Forks can override it through the environment at build or run time.
        .or_else(|| Some(include_str!("../../../../resources/microsoft-client-id.txt").to_owned()))
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

pub async fn login(app: &Host, state: &AppState) -> AppResult<Account> {
    let client_id = client_id().ok_or_else(|| {
        AppError::Unavailable(
            "Microsoft authentication requires SLH_MICROSOFT_CLIENT_ID for a registered public client"
                .into(),
        )
    })?;
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let redirect_uri = format!("http://localhost:{port}");
    let verifier = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let state_value = Uuid::new_v4().simple().to_string();
    let mut authorize = url::Url::parse(AUTHORIZE_URL)
        .map_err(|error| AppError::InvalidInput(format!("Invalid Microsoft URL: {error}")))?;
    authorize
        .query_pairs_mut()
        .append_pair("client_id", &client_id)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("response_mode", "query")
        .append_pair("scope", SCOPE)
        .append_pair("prompt", "select_account")
        .append_pair("state", &state_value)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256");
    app.opener()
        .open_url(authorize.as_str(), None::<&str>)
        .map_err(|error| {
            AppError::Process(format!("Could not open the system browser: {error}"))
        })?;
    let code = receive_authorization_code(listener, &state_value).await?;
    let oauth = exchange_code(&state.http, &client_id, &redirect_uri, &code, &verifier).await?;
    let refresh_token = oauth.refresh_token.ok_or_else(|| {
        AppError::Security("Microsoft did not return the requested refresh token".into())
    })?;
    let (minecraft, profile, xbox_xuid) =
        minecraft_session(&state.http, &oauth.access_token).await?;
    save_account(state, refresh_token, minecraft, profile, xbox_xuid).await
}

pub async fn launch_credentials(
    state: &AppState,
    account: &Account,
) -> AppResult<super::AccountLaunchCredentials> {
    let encrypted = tokio::fs::read(token_path(state, &account.id))
        .await
        .map_err(|_| {
            AppError::Security(
                "Microsoft token is unavailable on this Windows profile; sign in again".into(),
            )
        })?;
    let mut blob: MicrosoftTokenBlob =
        serde_json::from_slice(&decrypt_for_current_user(&encrypted)?)?;
    let expires_at = chrono::DateTime::parse_from_rfc3339(&blob.minecraft_expires_at)
        .map_err(|_| AppError::Security("Stored Microsoft token expiry is invalid".into()))?
        .with_timezone(&Utc);
    // Accounts created before Bedrock support did not have an Xbox XUID stored
    // in the database. Refreshing their Microsoft session once repairs that
    // migration gap even if the short-lived Minecraft token still happens to
    // be valid.
    if should_refresh_microsoft_session(expires_at, account.xbox_xuid.as_deref(), Utc::now()) {
        let client_id = client_id().ok_or_else(|| {
            AppError::Unavailable(
                "This build no longer has its Microsoft public client ID; sign-in cannot refresh"
                    .into(),
            )
        })?;
        let oauth = refresh_oauth(&state.http, &client_id, &blob.refresh_token).await?;
        let (minecraft, profile, xbox_xuid) =
            minecraft_session(&state.http, &oauth.access_token).await?;
        if normalize_uuid(&profile.id) != account.provider_uuid {
            return Err(AppError::Security(
                "Refreshed Microsoft profile does not match the selected account".into(),
            ));
        }
        blob.refresh_token = oauth.refresh_token.unwrap_or(blob.refresh_token);
        blob.minecraft_access_token = minecraft.access_token;
        blob.minecraft_expires_at =
            (Utc::now() + ChronoDuration::seconds(minecraft.expires_in)).to_rfc3339();
        write_blob(state, &account.id, &blob).await?;
        sqlx::query(
            "UPDATE accounts SET xbox_xuid = ?, auth_status = 'ready', last_auth_at = ? WHERE id = ?",
        )
            .bind(xbox_xuid)
            .bind(Utc::now().to_rfc3339())
            .bind(&account.id)
            .execute(&state.database)
            .await?;
    }
    Ok(super::AccountLaunchCredentials {
        username: account.username.clone(),
        uuid: account.provider_uuid.clone(),
        access_token: blob.minecraft_access_token,
        user_type: "msa".into(),
        extra_jvm_arguments: Vec::new(),
    })
}

fn should_refresh_microsoft_session(
    expires_at: chrono::DateTime<Utc>,
    xbox_xuid: Option<&str>,
    now: chrono::DateTime<Utc>,
) -> bool {
    expires_at <= now + ChronoDuration::minutes(2)
        || xbox_xuid
            .map(|value| value.trim().is_empty())
            .unwrap_or(true)
}

async fn receive_authorization_code(
    listener: TcpListener,
    expected_state: &str,
) -> AppResult<String> {
    let (mut stream, _) = tokio::time::timeout(Duration::from_secs(300), listener.accept())
        .await
        .map_err(|_| {
            AppError::Process("Microsoft sign-in timed out after five minutes".into())
        })??;
    let mut request = Vec::new();
    let mut buffer = [0_u8; 2048];
    loop {
        let read = stream.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        request.extend_from_slice(&buffer[..read]);
        if request.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
        if request.len() > 16 * 1024 {
            return Err(AppError::Security(
                "Microsoft callback request exceeded the safety limit".into(),
            ));
        }
    }
    let request = String::from_utf8_lossy(&request);
    let target = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .ok_or_else(|| AppError::InvalidInput("Microsoft callback was malformed".into()))?;
    let callback = url::Url::parse(&format!("http://localhost{target}"))
        .map_err(|_| AppError::InvalidInput("Microsoft callback URL was malformed".into()))?;
    let query: HashMap<String, String> = callback.query_pairs().into_owned().collect();
    let valid = query
        .get("state")
        .is_some_and(|state| state == expected_state);
    let result = if !valid {
        Err(AppError::Security(
            "Microsoft callback state did not match the sign-in request".into(),
        ))
    } else if let Some(error) = query.get("error") {
        Err(AppError::Conflict(format!(
            "Microsoft sign-in was not completed: {error}"
        )))
    } else {
        query
            .get("code")
            .cloned()
            .ok_or_else(|| AppError::InvalidInput("Microsoft callback had no code".into()))
    };
    let (status, message) = if result.is_ok() {
        (
            "200 OK",
            "Microsoft sign-in completed. You can close this tab and return to SLH.",
        )
    } else {
        (
            "400 Bad Request",
            "Microsoft sign-in could not be completed. Return to SLH for details.",
        )
    };
    let body = format!(
        "<!doctype html><meta charset=utf-8><title>SLH sign-in</title><style>body{{font:16px system-ui;background:#1f2226;color:#fff;padding:48px}}main{{max-width:560px;margin:auto}}</style><main><h1>SLH</h1><p>{message}</p></main>"
    );
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(response.as_bytes()).await?;
    result
}

async fn exchange_code(
    http: &reqwest::Client,
    client_id: &str,
    redirect_uri: &str,
    code: &str,
    verifier: &str,
) -> AppResult<OAuthToken> {
    token_request(
        http,
        &[
            ("client_id", client_id),
            ("scope", SCOPE),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("grant_type", "authorization_code"),
            ("code_verifier", verifier),
        ],
    )
    .await
}

async fn refresh_oauth(
    http: &reqwest::Client,
    client_id: &str,
    refresh_token: &str,
) -> AppResult<OAuthToken> {
    token_request(
        http,
        &[
            ("client_id", client_id),
            ("scope", SCOPE),
            ("refresh_token", refresh_token),
            ("grant_type", "refresh_token"),
        ],
    )
    .await
}

async fn token_request(http: &reqwest::Client, form: &[(&str, &str)]) -> AppResult<OAuthToken> {
    let response = http.post(TOKEN_URL).form(form).send().await?;
    if !response.status().is_success() {
        return Err(AppError::Conflict(format!(
            "Microsoft token exchange returned HTTP {}",
            response.status()
        )));
    }
    Ok(response.json().await?)
}

async fn minecraft_session(
    http: &reqwest::Client,
    microsoft_access_token: &str,
) -> AppResult<(MinecraftToken, MinecraftProfile, String)> {
    let xbox: XboxToken = post_json(
        http,
        "https://user.auth.xboxlive.com/user/authenticate",
        serde_json::json!({
            "Properties": {
                "AuthMethod": "RPS",
                "SiteName": "user.auth.xboxlive.com",
                "RpsTicket": format!("d={microsoft_access_token}")
            },
            "RelyingParty": "http://auth.xboxlive.com",
            "TokenType": "JWT"
        }),
        None,
    )
    .await?;
    let user_hash = xbox
        .display_claims
        .xui
        .first()
        .map(|claim| claim.uhs.as_str())
        .ok_or_else(|| AppError::Security("Xbox token did not contain a user hash".into()))?;
    let profile_xsts = authorize_xsts(http, &xbox.token, XBOX_PROFILE_XSTS_RELYING_PARTY).await?;
    let xbox_xuid = xbox_xuid_from_token(&profile_xsts)?;

    let minecraft_xsts = authorize_xsts(http, &xbox.token, MINECRAFT_XSTS_RELYING_PARTY).await?;
    let identity = format!("XBL3.0 x={user_hash};{}", minecraft_xsts.token);
    let minecraft: MinecraftToken = post_json(
        http,
        "https://api.minecraftservices.com/authentication/login_with_xbox",
        serde_json::json!({ "identityToken": identity }),
        None,
    )
    .await?;
    let response = http
        .get("https://api.minecraftservices.com/minecraft/profile")
        .header(AUTHORIZATION, format!("Bearer {}", minecraft.access_token))
        .send()
        .await?;
    if !response.status().is_success() {
        return Err(AppError::Unavailable(format!(
            "Minecraft Java profile is unavailable (HTTP {}); verify game ownership and family settings",
            response.status()
        )));
    }
    let profile = response.json().await?;
    Ok((minecraft, profile, xbox_xuid))
}

async fn authorize_xsts(
    http: &reqwest::Client,
    user_token: &str,
    relying_party: &str,
) -> AppResult<XboxToken> {
    post_json(
        http,
        "https://xsts.auth.xboxlive.com/xsts/authorize",
        serde_json::json!({
            "Properties": { "SandboxId": "RETAIL", "UserTokens": [user_token] },
            "RelyingParty": relying_party,
            "TokenType": "JWT"
        }),
        None,
    )
    .await
}

fn xbox_xuid_from_token(token: &XboxToken) -> AppResult<String> {
    token
        .display_claims
        .xui
        .first()
        .and_then(|claim| claim.xid.clone())
        .filter(|xuid| !xuid.trim().is_empty())
        .ok_or_else(|| {
            AppError::Security(
                "The active Xbox account did not expose an XUID. Open Xbox and finish the profile setup, then retry Bedrock.".into(),
            )
        })
}

async fn post_json<T: for<'de> Deserialize<'de>>(
    http: &reqwest::Client,
    url: &str,
    body: serde_json::Value,
    authorization: Option<&str>,
) -> AppResult<T> {
    let mut request = http.post(url).json(&body);
    if let Some(authorization) = authorization {
        request = request.header(AUTHORIZATION, authorization);
    }
    let response = request.send().await?;
    if !response.status().is_success() {
        return Err(AppError::Conflict(format!(
            "Account service {url} returned HTTP {}",
            response.status()
        )));
    }
    Ok(response.json().await?)
}

async fn save_account(
    state: &AppState,
    refresh_token: String,
    minecraft: MinecraftToken,
    profile: MinecraftProfile,
    xbox_xuid: String,
) -> AppResult<Account> {
    let account_id = Uuid::new_v4().to_string();
    let skin_url = profile.skins.first().map(|skin| skin.url.clone());
    let profile_uuid = normalize_uuid(&profile.id);
    let blob = MicrosoftTokenBlob {
        refresh_token,
        minecraft_access_token: minecraft.access_token,
        minecraft_expires_at: (Utc::now() + ChronoDuration::seconds(minecraft.expires_in))
            .to_rfc3339(),
    };
    write_blob(state, &account_id, &blob).await?;
    let new_path = token_path(state, &account_id);
    let mut transaction = state.database.begin().await?;
    sqlx::query(
        "UPDATE accounts SET active = 0 \
         WHERE LOWER(TRIM(CAST(active AS TEXT))) IN ('1', 'true', 'yes', 'on')",
    )
    .execute(&mut *transaction)
    .await?;
    let insert = sqlx::query(
        "INSERT INTO accounts(id, provider, provider_uuid, xbox_xuid, username, auth_status, last_auth_at, active) \
         VALUES (?, 'microsoft', ?, ?, ?, 'ready', ?, 1) \
         ON CONFLICT(provider, provider_uuid) DO UPDATE SET username = excluded.username, \
         xbox_xuid = excluded.xbox_xuid, \
         auth_status = 'ready', last_auth_at = excluded.last_auth_at, active = 1",
    )
        .bind(&account_id)
        .bind(&profile_uuid)
        .bind(&xbox_xuid)
        .bind(&profile.name)
    .bind(Utc::now().to_rfc3339())
    .execute(&mut *transaction)
    .await;
    if let Err(error) = insert {
        let _ = tokio::fs::remove_file(new_path).await;
        return Err(error.into());
    }
    transaction.commit().await?;
    let account = sqlx::query_as::<_, Account>(
        "SELECT id, provider, provider_uuid, xbox_xuid, username, avatar_cache_path, auth_status, \
         last_auth_at, active, created_at FROM accounts \
         WHERE provider = 'microsoft' AND provider_uuid = ?",
    )
    .bind(&profile_uuid)
    .fetch_one(&state.database)
    .await?;
    if account.id != account_id {
        // Windows cannot rename a file over an existing token file. Re-write
        // the encrypted blob through the atomic replacement helper instead
        // of making re-login fail for an already saved account.
        write_blob(state, &account.id, &blob).await?;
        let _ = tokio::fs::remove_file(new_path).await;
    }
    if let Some(url) = skin_url {
        if let Err(error) = super::cache_skin_texture(state, &account.id, &url).await {
            tracing::warn!(%error, account_id = %account.id, "Microsoft skin cache failed");
        }
    }
    Ok(sqlx::query_as::<_, Account>(
        "SELECT id, provider, provider_uuid, xbox_xuid, username, avatar_cache_path, auth_status, \
         last_auth_at, active, created_at FROM accounts WHERE id = ?",
    )
    .bind(&account.id)
    .fetch_one(&state.database)
    .await?)
}

pub async fn refresh_avatar(state: &AppState, account: &Account) -> AppResult<()> {
    let credentials = launch_credentials(state, account).await?;
    let response = state
        .http
        .get("https://api.minecraftservices.com/minecraft/profile")
        .header(
            AUTHORIZATION,
            format!("Bearer {}", credentials.access_token),
        )
        .send()
        .await?
        .error_for_status()?;
    let profile: MinecraftProfile = response.json().await?;
    if let Some(skin) = profile.skins.first() {
        super::cache_skin_texture(state, &account.id, &skin.url).await?;
    }
    Ok(())
}

async fn profile(state: &AppState, account: &Account) -> AppResult<(String, MinecraftProfile)> {
    let access_token = access_token(state, account).await?;
    let response = state
        .http
        .get("https://api.minecraftservices.com/minecraft/profile")
        .bearer_auth(&access_token)
        .send()
        .await?
        .error_for_status()?;
    Ok((access_token, response.json().await?))
}

/// Get a valid Minecraft access token without also loading the public profile.
/// Profile reads are rate-limited independently, so mutations must not make an
/// unnecessary extra `/minecraft/profile` request immediately before writing.
async fn access_token(state: &AppState, account: &Account) -> AppResult<String> {
    Ok(launch_credentials(state, account).await?.access_token)
}

pub async fn appearance(state: &AppState, account: &Account) -> AppResult<AccountAppearance> {
    let (_, profile) = profile(state, account).await?;
    appearance_from_profile(state, account, profile).await
}

/// Home needs only the active skin, never the cape or saved-skin gallery.
pub(super) async fn home_skin(state: &AppState, account: &Account) -> AppResult<serde_json::Value> {
    let (_, profile) = profile(state, account).await?;
    let skin = profile
        .skins
        .iter()
        .find(|skin| skin.state == "ACTIVE")
        .or(profile.skins.first());
    if let Some(skin) = skin {
        super::cache_skin_texture(state, &account.id, &skin.url).await?;
        Ok(
            serde_json::json!({ "dataUrl": super::cached_texture_data_url(state, &account.id).await,
            "model": if skin.variant.as_deref().is_some_and(|variant| variant.eq_ignore_ascii_case("slim")) { "slim" } else { "classic" } }),
        )
    } else {
        Ok(serde_json::json!({ "dataUrl": null, "model": "classic" }))
    }
}

async fn appearance_from_profile(
    state: &AppState,
    account: &Account,
    profile: MinecraftProfile,
) -> AppResult<AccountAppearance> {
    let cached_active_skin = super::cached_texture_data_url(state, &account.id).await;
    if let Some(active) = profile
        .skins
        .iter()
        .find(|skin| skin.state == "ACTIVE")
        .or(profile.skins.first())
    {
        if let Err(error) = super::cache_skin_texture(state, &account.id, &active.url).await {
            tracing::warn!(%error, account_id = %account.id, "Microsoft skin cache refresh failed");
        }
    }
    let mut skins = Vec::new();
    for skin in profile.skins.into_iter().take(24) {
        let active = skin.state == "ACTIVE";
        skins.push(AccountTexture {
            id: skin.id,
            data_url: super::texture_data_url(&skin.url)
                .await?
                .or_else(|| active.then(|| cached_active_skin.clone()).flatten()),
            thumbnail_data_url: None,
            variant: skin.variant.map(|variant| variant.to_lowercase()),
            alias: skin.alias,
            active,
        });
    }
    let mut capes = Vec::new();
    for cape in profile.capes.into_iter().take(24) {
        let (data_url, thumbnail_data_url) = super::cape_texture_data_urls(&cape.url).await?;
        capes.push(AccountTexture {
            id: cape.id,
            data_url,
            thumbnail_data_url,
            variant: None,
            alias: cape.alias,
            active: cape.state == "ACTIVE",
        });
    }
    let mut appearance = AccountAppearance {
        account_id: account.id.clone(),
        provider: account.provider.clone(),
        username: account.username.clone(),
        can_change_skin: true,
        can_change_cape: true,
        message: None,
        skins,
        capes,
    };
    merge_cached_skin_library(state, &mut appearance).await;
    if let Err(error) = super::cache_appearance(state, &appearance).await {
        tracing::warn!(%error, account_id = %account.id, "Microsoft appearance cache refresh failed");
    }
    Ok(appearance)
}

/// Minecraft Services keeps only the active custom skin in the profile. Keep
/// the remaining locally uploaded textures in the public appearance cache so
/// the launcher's “saved skins” gallery behaves like an actual gallery.
async fn merge_cached_skin_library(state: &AppState, appearance: &mut AccountAppearance) {
    let Some(cached) = super::cached_appearance(state, &appearance.account_id).await else {
        return;
    };
    let mut kept_unnamed = false;
    let mut library = cached
        .skins
        .into_iter()
        .filter_map(|mut saved| {
            if saved.alias.is_some() {
                return Some(saved);
            }
            // Old caches had no file name for the skin that was active before the
            // gallery was introduced. Keep one such card as “Saved skin”; discard
            // the rest because they are duplicate remote upload IDs.
            if kept_unnamed {
                return None;
            }
            kept_unnamed = true;
            saved.alias = Some("Saved skin".into());
            Some(saved)
        })
        .collect::<Vec<_>>();
    if library.is_empty() {
        if !appearance.skins.iter().any(|skin| skin.active) {
            if let Some(skin) = appearance.skins.first_mut() {
                skin.active = true;
            }
        }
        return;
    }
    // Once a local gallery exists, it is authoritative. Minecraft Services
    // exposes only the current remote skin and assigns a new ID on every
    // upload, so merging that transient ID back into the gallery creates a
    // duplicate card after each switch.
    let active_id = library
        .iter()
        .find(|skin| skin.active)
        .map(|skin| skin.id.clone())
        .unwrap_or_else(|| library[0].id.clone());
    for skin in &mut library {
        skin.active = skin.id == active_id;
    }
    appearance.skins = library;
    // Keep the cache and therefore the editor bounded even after many uploads.
    if appearance.skins.len() > 24 {
        let active_id = appearance
            .skins
            .iter()
            .find(|skin| skin.active)
            .map(|skin| skin.id.clone());
        appearance
            .skins
            .retain(|skin| Some(&skin.id) == active_id.as_ref() || skin.id.starts_with("local-"));
        appearance.skins.truncate(24);
    }
}

fn file_alias(file_name: &str) -> String {
    std::path::Path::new(file_name)
        .file_stem()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("Custom skin")
        .chars()
        .take(48)
        .collect()
}

async fn update_skin_library(
    state: &AppState,
    mut appearance: AccountAppearance,
    bytes: &[u8],
    file_name: &str,
    variant: &str,
    existing_skin_id: Option<&str>,
) -> AccountAppearance {
    let data_url = format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    );
    let alias = file_alias(file_name);
    for skin in &mut appearance.skins {
        skin.active = false;
    }
    if let Some(existing_skin_id) = existing_skin_id {
        if let Some(skin) = appearance
            .skins
            .iter_mut()
            .find(|skin| skin.id == existing_skin_id)
        {
            // Mojang assigns a fresh remote skin ID for every upload, but a
            // launcher gallery entry is a stable local item. Update its PNG
            // in place so a texture replacement never creates a duplicate.
            skin.data_url = Some(data_url);
            skin.thumbnail_data_url = None;
            skin.variant = Some(variant.to_owned());
            skin.active = true;
        } else {
            // The source card is gone only when a stale UI action races with
            // cleanup. Preserve the selected texture instead of creating a
            // second card with a remote Mojang ID.
            appearance.skins.push(AccountTexture {
                id: existing_skin_id.to_owned(),
                data_url: Some(data_url),
                thumbnail_data_url: None,
                variant: Some(variant.to_owned()),
                alias: Some(alias),
                active: true,
            });
        }
    } else if let Some(skin) = appearance
        .skins
        .iter_mut()
        .find(|skin| skin.id == format!("local-{}", hex::encode(Sha256::digest(bytes))))
    {
        skin.active = true;
        skin.alias = Some(alias);
    } else {
        appearance.skins.push(AccountTexture {
            id: format!("local-{}", hex::encode(Sha256::digest(bytes))),
            data_url: Some(data_url),
            thumbnail_data_url: None,
            variant: Some(variant.to_owned()),
            alias: Some(alias),
            active: true,
        });
    }
    if let Err(error) = super::cache_appearance(state, &appearance).await {
        tracing::warn!(%error, account_id = %appearance.account_id, "Uploaded skin library cache could not be updated");
    }
    appearance
}

pub async fn upload_skin(
    state: &AppState,
    account: &Account,
    source_path: &str,
    variant: &str,
) -> AppResult<AccountAppearance> {
    if !matches!(variant, "classic" | "slim") {
        return Err(AppError::InvalidInput(
            "Skin model must be classic or slim".into(),
        ));
    }
    let path = std::fs::canonicalize(source_path)?;
    if !path.is_file() {
        return Err(AppError::InvalidInput("Selected skin is not a file".into()));
    }
    let bytes = tokio::fs::read(&path).await?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("skin.png");
    upload_skin_bytes(state, account, bytes, file_name, variant, None).await
}

pub async fn upload_skin_bytes(
    state: &AppState,
    account: &Account,
    bytes: Vec<u8>,
    file_name: &str,
    variant: &str,
    existing_skin_id: Option<&str>,
) -> AppResult<AccountAppearance> {
    if !matches!(variant, "classic" | "slim") {
        return Err(AppError::InvalidInput(
            "Skin model must be classic or slim".into(),
        ));
    }
    if bytes.len() > 2 * 1024 * 1024 || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err(AppError::InvalidInput(
            "Skin must be a PNG file no larger than 2 MB".into(),
        ));
    }
    let image = image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)
        .map_err(|_| AppError::InvalidInput("Skin PNG could not be decoded".into()))?;
    if !matches!((image.width(), image.height()), (64, 64) | (64, 32)) {
        return Err(AppError::InvalidInput(
            "Skin dimensions must be 64x64 or legacy 64x32".into(),
        ));
    }
    let token = access_token(state, account).await?;
    let part = reqwest::multipart::Part::bytes(bytes.clone())
        .file_name(file_name.to_owned())
        .mime_str("image/png")?;
    state
        .http
        .post("https://api.minecraftservices.com/minecraft/profile/skins")
        .bearer_auth(token)
        .multipart(
            reqwest::multipart::Form::new()
                .text("variant", variant.to_owned())
                .part("file", part),
        )
        .send()
        .await?
        .error_for_status()?;
    let appearance = super::cached_appearance(state, &account.id)
        .await
        .ok_or_else(|| {
            AppError::Unavailable(
                "Skin gallery cache is not ready; reopen the skin selector and retry".into(),
            )
        })?;
    Ok(update_skin_library(
        state,
        appearance,
        &bytes,
        file_name,
        variant,
        existing_skin_id,
    )
    .await)
}

pub async fn select_cape(
    state: &AppState,
    account: &Account,
    cape_id: Option<&str>,
) -> AppResult<AccountAppearance> {
    let token = access_token(state, account).await?;
    let request = if let Some(cape_id) = cape_id {
        state
            .http
            .put("https://api.minecraftservices.com/minecraft/profile/capes/active")
            .bearer_auth(token)
            // Mojang's cape endpoint accepts `capeId`, unlike the skin
            // endpoint which uses `id`. Sending the skin-shaped payload
            // caused server-side failures and made the editor refresh empty.
            .json(&serde_json::json!({ "capeId": cape_id }))
    } else {
        state
            .http
            .delete("https://api.minecraftservices.com/minecraft/profile/capes/active")
            .bearer_auth(token)
    };
    request
        .send()
        .await
        .and_then(|response| response.error_for_status())?;
    appearance_or_cached(state, account, None, Some(cape_id)).await
}

pub async fn delete_saved_skin(
    state: &AppState,
    account: &Account,
    skin_id: &str,
) -> AppResult<AccountAppearance> {
    let mut appearance = super::cached_appearance(state, &account.id)
        .await
        .ok_or_else(|| AppError::NotFound("Saved skin gallery".into()))?;
    let removed_active = appearance
        .skins
        .iter()
        .any(|skin| skin.id == skin_id && skin.active);
    let original_len = appearance.skins.len();
    appearance.skins.retain(|skin| skin.id != skin_id);
    if appearance.skins.len() == original_len {
        // Local gallery IDs are intentionally not Minecraft Services IDs.
        // A cache written by an older launcher build may already have lost
        // that entry, in which case deletion is correctly idempotent.
        return Ok(appearance);
    }
    if removed_active {
        for (index, skin) in appearance.skins.iter_mut().enumerate() {
            skin.active = index == 0;
        }
    }
    super::cache_appearance(state, &appearance).await?;
    Ok(appearance)
}

fn apply_requested_selection(
    appearance: &mut AccountAppearance,
    selected_skin: Option<&str>,
    selected_cape: Option<Option<&str>>,
) {
    if let Some(skin_id) = selected_skin {
        for skin in &mut appearance.skins {
            skin.active = skin.id == skin_id;
        }
    }
    if let Some(cape_id) = selected_cape {
        for cape in &mut appearance.capes {
            cape.active = cape_id.is_some_and(|id| id == cape.id.as_str());
        }
    }
}

/// Return a fresh appearance when possible, but never turn a successful skin
/// or cape mutation into an editor failure just because the following profile
/// refresh is rate-limited. The cached metadata contains no tokens and keeps
/// the picker usable until Microsoft accepts the next profile request.
async fn appearance_or_cached(
    state: &AppState,
    account: &Account,
    selected_skin: Option<&str>,
    selected_cape: Option<Option<&str>>,
) -> AppResult<AccountAppearance> {
    match appearance(state, account).await {
        Ok(mut appearance) => {
            apply_requested_selection(&mut appearance, selected_skin, selected_cape);
            if let Err(error) = super::cache_appearance(state, &appearance).await {
                tracing::warn!(%error, account_id = %account.id, "Microsoft appearance cache update failed");
            }
            Ok(appearance)
        }
        Err(error) => {
            let Some(mut cached) = super::cached_appearance(state, &account.id).await else {
                return Err(error);
            };
            apply_requested_selection(&mut cached, selected_skin, selected_cape);
            cached.message = Some(format!(
                "Changes were saved. Microsoft profile refresh is temporarily unavailable: {error}"
            ));
            if let Err(cache_error) = super::cache_appearance(state, &cached).await {
                tracing::warn!(%cache_error, account_id = %account.id, "Microsoft appearance cache update failed");
            }
            Ok(cached)
        }
    }
}

async fn write_blob(
    state: &AppState,
    account_id: &str,
    blob: &MicrosoftTokenBlob,
) -> AppResult<()> {
    let encrypted = encrypt_for_current_user(&serde_json::to_vec(blob)?)?;
    let destination = token_path(state, account_id);
    let previous = tokio::fs::read(&destination).await.ok();
    let temporary = destination.with_extension(format!("{}.tmp", Uuid::new_v4()));
    tokio::fs::write(&temporary, encrypted).await?;
    if destination.exists() {
        tokio::fs::remove_file(&destination).await?;
    }
    tokio::fs::rename(temporary, destination).await?;
    if let Some(previous) = previous {
        let _ = crate::security::delete_credential_reference(&previous);
    }
    Ok(())
}

fn token_path(state: &AppState, account_id: &str) -> PathBuf {
    state.paths.accounts.join(format!("{account_id}.dpapi"))
}

fn normalize_uuid(value: &str) -> String {
    let compact = value.replace('-', "");
    if compact.len() == 32 {
        format!(
            "{}-{}-{}-{}-{}",
            &compact[0..8],
            &compact[8..12],
            &compact[12..16],
            &compact[16..20],
            &compact[20..32]
        )
    } else {
        value.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minecraft_profile_uuid_is_normalized() {
        assert_eq!(
            normalize_uuid("069a79f444e94726a5befca90e38aaf5"),
            "069a79f4-44e9-4726-a5be-fca90e38aaf5"
        );
    }

    #[test]
    fn refreshes_a_pre_bedrock_account_without_an_xbox_xuid() {
        let now = Utc::now();
        let valid_token = now + ChronoDuration::minutes(30);

        assert!(should_refresh_microsoft_session(valid_token, None, now));
        assert!(should_refresh_microsoft_session(
            valid_token,
            Some("   "),
            now
        ));
        assert!(!should_refresh_microsoft_session(
            valid_token,
            Some("123"),
            now
        ));
        assert!(should_refresh_microsoft_session(
            now + ChronoDuration::minutes(1),
            Some("123"),
            now
        ));
    }

    #[test]
    fn reads_xuid_from_the_xbox_profile_xsts_response() {
        let profile_token = XboxToken {
            token: "opaque".into(),
            display_claims: XboxClaims {
                xui: vec![XboxUserClaim {
                    uhs: "user-hash".into(),
                    xid: Some("2533274991020393".into()),
                }],
            },
        };

        assert_eq!(
            xbox_xuid_from_token(&profile_token).unwrap(),
            "2533274991020393"
        );
        assert_eq!(XBOX_PROFILE_XSTS_RELYING_PARTY, "http://xboxlive.com");
        assert_eq!(
            MINECRAFT_XSTS_RELYING_PARTY,
            "rp://api.minecraftservices.com/"
        );
    }
}
