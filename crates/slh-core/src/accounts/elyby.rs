use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::models::{Account, LoginElyByRequest};
use crate::security::{decrypt_for_current_user, encrypt_for_current_user};
use crate::state::AppState;

const AUTH_URL: &str = "https://authserver.ely.by/auth/authenticate";
const DEFAULT_INJECTOR_URL: &str = "https://github.com/yushijinhun/authlib-injector/releases/download/v1.2.8/authlib-injector-1.2.8.jar";
const DEFAULT_INJECTOR_SHA256: &str =
    "9c7f4343e6c82034958ffb48c14a2cb0c85928be7283103ce17da00c6d5a7b10";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ElyAuthResponse {
    access_token: String,
    client_token: String,
    selected_profile: ElyProfile,
}

#[derive(Deserialize)]
struct ElyError {
    #[serde(rename = "errorMessage")]
    message: Option<String>,
}

#[derive(Deserialize)]
struct ElyProfile {
    id: String,
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ElyAuthRequest<'a> {
    username: &'a str,
    password: &'a str,
    client_token: &'a str,
    request_user: bool,
}

#[derive(Serialize, Deserialize)]
struct ElyTokenBlob {
    access_token: String,
    client_token: String,
}

pub async fn login(state: &AppState, request: LoginElyByRequest) -> AppResult<Account> {
    let username = request.username.trim();
    if username.is_empty() || request.password.is_empty() {
        return Err(AppError::InvalidInput(
            "Ely.by username and password are required".into(),
        ));
    }
    let client_token = Uuid::new_v4().to_string();
    let password = match request.totp.as_deref().map(str::trim) {
        Some(totp) if !totp.is_empty() => {
            if !totp.chars().all(|character| character.is_ascii_digit()) {
                return Err(AppError::InvalidInput(
                    "The Ely.by two-factor code must contain only digits".into(),
                ));
            }
            format!("{}:{totp}", request.password)
        }
        _ => request.password,
    };
    let response = state
        .http
        .post(AUTH_URL)
        .json(&ElyAuthRequest {
            username,
            password: &password,
            client_token: &client_token,
            request_user: true,
        })
        .send()
        .await?;
    if !response.status().is_success() {
        let status = response.status();
        let error: ElyError = response.json().await.unwrap_or(ElyError { message: None });
        let message = error
            .message
            .unwrap_or_else(|| format!("Ely.by returned HTTP {status}"));
        if message.to_ascii_lowercase().contains("two factor") {
            return Err(AppError::TwoFactorRequired(message));
        }
        return Err(AppError::Conflict(message));
    }
    let auth: ElyAuthResponse = response.json().await?;
    let account_id = Uuid::new_v4().to_string();
    let blob = encrypt_for_current_user(&serde_json::to_vec(&ElyTokenBlob {
        access_token: auth.access_token,
        client_token: auth.client_token,
    })?)?;
    let token_file = token_path(state, &account_id);
    write_secret_atomic(&token_file, &blob).await?;

    let mut transaction = state.database.begin().await?;
    sqlx::query(
        "UPDATE accounts SET active = 0 \
         WHERE LOWER(TRIM(CAST(active AS TEXT))) IN ('1', 'true', 'yes', 'on')",
    )
    .execute(&mut *transaction)
    .await?;
    let insert = sqlx::query(
        "INSERT INTO accounts(id, provider, provider_uuid, username, auth_status, last_auth_at, active) \
         VALUES (?, 'elyby', ?, ?, 'ready', ?, 1) \
         ON CONFLICT(provider, provider_uuid) DO UPDATE SET username = excluded.username, \
         auth_status = 'ready', last_auth_at = excluded.last_auth_at, active = 1",
    )
    .bind(&account_id)
    .bind(normalize_uuid(&auth.selected_profile.id))
    .bind(&auth.selected_profile.name)
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(&mut *transaction)
    .await;
    if let Err(error) = insert {
        let _ = tokio::fs::remove_file(&token_file).await;
        return Err(error.into());
    }
    transaction.commit().await?;
    let account = sqlx::query_as::<_, Account>(
        "SELECT id, provider, provider_uuid, xbox_xuid, username, avatar_cache_path, auth_status, \
         last_auth_at, active, created_at FROM accounts \
         WHERE provider = 'elyby' AND provider_uuid = ?",
    )
    .bind(normalize_uuid(&auth.selected_profile.id))
    .fetch_one(&state.database)
    .await?;
    if account.id != account_id {
        let existing_path = token_path(state, &account.id);
        if existing_path != token_file {
            // `rename` cannot replace an existing file on Windows. Store the
            // fresh DPAPI blob through the same replacement helper used for
            // the initial login, then remove its now-unneeded staging file.
            write_secret_atomic(&existing_path, &blob).await?;
            let _ = tokio::fs::remove_file(&token_file).await;
        }
    }
    let encoded =
        url::form_urlencoded::byte_serialize(account.username.as_bytes()).collect::<String>();
    if let Err(error) = super::cache_skin_texture(
        state,
        &account.id,
        &format!("https://skinsystem.ely.by/skins/{encoded}.png"),
    )
    .await
    {
        tracing::warn!(%error, account_id = %account.id, "Ely.by skin cache failed");
    }
    Ok(sqlx::query_as::<_, Account>(
        "SELECT id, provider, provider_uuid, xbox_xuid, username, avatar_cache_path, auth_status, \
         last_auth_at, active, created_at FROM accounts WHERE id = ?",
    )
    .bind(&account.id)
    .fetch_one(&state.database)
    .await?)
}

pub async fn launch_credentials(
    state: &AppState,
    account: &Account,
) -> AppResult<super::AccountLaunchCredentials> {
    let encrypted = tokio::fs::read(token_path(state, &account.id))
        .await
        .map_err(|_| {
            AppError::Security(
                "Ely.by token is unavailable on this Windows profile; sign in again".into(),
            )
        })?;
    let token: ElyTokenBlob = serde_json::from_slice(&decrypt_for_current_user(&encrypted)?)?;
    let injector = ensure_injector(state).await?;
    Ok(super::AccountLaunchCredentials {
        username: account.username.clone(),
        uuid: account.provider_uuid.clone(),
        access_token: token.access_token,
        user_type: "legacy".into(),
        extra_jvm_arguments: vec![
            "-Dauthlibinjector.noLogFile".into(),
            format!("-javaagent:{}=ely.by", injector.to_string_lossy()),
        ],
    })
}

fn token_path(state: &AppState, account_id: &str) -> PathBuf {
    state.paths.accounts.join(format!("{account_id}.dpapi"))
}

async fn write_secret_atomic(path: &PathBuf, bytes: &[u8]) -> AppResult<()> {
    let temporary = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    tokio::fs::write(&temporary, bytes).await?;
    if path.exists() {
        tokio::fs::remove_file(path).await?;
    }
    tokio::fs::rename(temporary, path).await?;
    Ok(())
}

fn normalize_uuid(value: &str) -> String {
    Uuid::parse_str(value)
        .or_else(|_| {
            Uuid::parse_str(&format!(
                "{}-{}-{}-{}-{}",
                &value.get(0..8).unwrap_or_default(),
                &value.get(8..12).unwrap_or_default(),
                &value.get(12..16).unwrap_or_default(),
                &value.get(16..20).unwrap_or_default(),
                &value.get(20..32).unwrap_or_default()
            ))
        })
        .map(|uuid| uuid.to_string())
        .unwrap_or_else(|_| value.to_owned())
}

async fn ensure_injector(state: &AppState) -> AppResult<PathBuf> {
    let custom_url = configured(
        "SLH_ELY_AUTHLIB_INJECTOR_URL",
        option_env!("SLH_ELY_AUTHLIB_INJECTOR_URL"),
    );
    let custom_sha256 = configured(
        "SLH_ELY_AUTHLIB_INJECTOR_SHA256",
        option_env!("SLH_ELY_AUTHLIB_INJECTOR_SHA256"),
    );
    let (url, expected) = injector_source(custom_url, custom_sha256)?;
    let destination = state
        .paths
        .cache
        .join("auth")
        .join("elyby")
        .join("authlib-injector.jar");
    if destination.is_file() {
        let bytes = tokio::fs::read(&destination).await?;
        if hex::encode(Sha256::digest(&bytes)).eq_ignore_ascii_case(&expected) {
            return Ok(destination);
        }
    }
    let response = state.http.get(&url).send().await?.error_for_status()?;
    let bytes = response.bytes().await?;
    let actual = hex::encode(Sha256::digest(&bytes));
    if !actual.eq_ignore_ascii_case(&expected) {
        return Err(AppError::Security(format!(
            "authlib-injector SHA-256 mismatch: expected {expected}, received {actual}"
        )));
    }
    if let Some(parent) = destination.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let temporary = destination.with_extension(format!("{}.tmp", Uuid::new_v4()));
    tokio::fs::write(&temporary, &bytes).await?;
    if destination.exists() {
        tokio::fs::remove_file(&destination).await?;
    }
    tokio::fs::rename(temporary, &destination).await?;
    Ok(destination)
}

fn configured(name: &str, compiled: Option<&'static str>) -> Option<String> {
    std::env::var(name)
        .ok()
        .or_else(|| compiled.map(str::to_owned))
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn injector_source(
    custom_url: Option<String>,
    custom_sha256: Option<String>,
) -> AppResult<(String, String)> {
    match (custom_url, custom_sha256) {
        (None, None) => Ok((DEFAULT_INJECTOR_URL.into(), DEFAULT_INJECTOR_SHA256.into())),
        (Some(url), Some(sha256))
            if sha256.len() == 64
                && sha256
                    .chars()
                    .all(|character| character.is_ascii_hexdigit()) =>
        {
            Ok((url, sha256.to_ascii_lowercase()))
        }
        (Some(_), Some(_)) => Err(AppError::InvalidInput(
            "SLH_ELY_AUTHLIB_INJECTOR_SHA256 must contain exactly 64 hexadecimal characters".into(),
        )),
        _ => Err(AppError::InvalidInput(
            "A custom Ely.by authlib-injector URL and SHA-256 must be configured together".into(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_injector_is_pinned_to_an_exact_digest() {
        let (url, digest) = injector_source(None, None).expect("default source should be valid");
        assert!(url.ends_with("authlib-injector-1.2.8.jar"));
        assert_eq!(digest, DEFAULT_INJECTOR_SHA256);
    }

    #[test]
    fn custom_injector_requires_a_url_and_valid_digest() {
        assert!(injector_source(Some("https://example.com/injector.jar".into()), None).is_err());
        assert!(
            injector_source(
                Some("https://example.com/injector.jar".into()),
                Some("not-a-sha256".into()),
            )
            .is_err()
        );
    }
}
