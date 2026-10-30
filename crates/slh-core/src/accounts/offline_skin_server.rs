//! Read-only loopback skin service consumed by authlib-injector. It never
//! authenticates accounts, joins servers, or exposes account credentials.
use std::{path::PathBuf, sync::Arc};
use base64::{Engine, engine::general_purpose::STANDARD};
use rsa::{RsaPrivateKey, RsaPublicKey, pkcs1v15::SigningKey, pkcs8::{EncodePublicKey, LineEnding}, signature::{Signer, SignatureEncoding}};
use sha2::{Digest, Sha256};
use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::{TcpListener, TcpStream}, task::{JoinHandle, JoinSet}};
use crate::{error::{AppError, AppResult}, models::AccountAppearance, state::AppState};

pub(crate) struct SkinServer { url: String, task: JoinHandle<()> }
impl Drop for SkinServer { fn drop(&mut self) { self.task.abort(); } }

struct Context {
    database: sqlx::SqlitePool,
    accounts: PathBuf,
    url: String,
    path: String,
    key: SigningKey<sha1::Sha1>,
    public_key: String,
}

pub async fn launch_arguments(state: &AppState) -> AppResult<Vec<String>> {
    let injector = super::elyby::ensure_injector(state).await?;
    let url = start(state).await?;
    Ok(vec!["-Dauthlibinjector.noLogFile".into(), format!("-javaagent:{}={url}", injector.to_string_lossy())])
}

async fn start(state: &AppState) -> AppResult<String> {
    let mut guard = state.offline_skin_server.lock().await;
    if guard.as_ref().is_none_or(|server| server.task.is_finished()) {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
        let path = format!("/{}/", uuid::Uuid::new_v4().simple());
        let url = format!("http://127.0.0.1:{}{}", listener.local_addr()?.port(), path);
        let private_key = tokio::task::spawn_blocking(|| RsaPrivateKey::new(&mut rsa::rand_core::OsRng, 2048)).await
            .map_err(|error| AppError::Unavailable(error.to_string()))?
            .map_err(|error| AppError::Unavailable(error.to_string()))?;
        let public_key = RsaPublicKey::from(&private_key).to_public_key_pem(LineEnding::LF)
            .map_err(|error| AppError::Unavailable(error.to_string()))?;
        let context = Arc::new(Context { database: state.database.clone(), accounts: state.paths.accounts.clone(),
            url: url.clone(), path, key: SigningKey::new(private_key), public_key });
        let task = tokio::spawn(async move {
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {
                    result = listener.accept() => {
                        let Ok((stream, _)) = result else { break; };
                        if connections.len() >= 32 { drop(stream); continue; }
                        let context = context.clone();
                        connections.spawn(async move {
                            let _ = tokio::time::timeout(std::time::Duration::from_secs(5), handle(stream, &context)).await;
                        });
                    }
                    _ = connections.join_next(), if !connections.is_empty() => {}
                }
            }
        });
        *guard = Some(SkinServer { url, task });
    }
    Ok(guard.as_ref().unwrap().url.clone())
}

async fn handle(mut stream: TcpStream, context: &Context) -> AppResult<()> {
    let mut request = Vec::new();
    let (header_end, content_length) = loop {
        if request.len() >= 8192 { return Ok(()); }
        let mut buffer = [0; 1024];
        let count = stream.read(&mut buffer).await?;
        if count == 0 { return Ok(()); }
        request.extend_from_slice(&buffer[..count]);
        if let Some(index) = request.windows(4).position(|v| v == b"\r\n\r\n") {
            let header = String::from_utf8_lossy(&request[..index]);
            let length = header.lines().find_map(|line| line.split_once(':').filter(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                .and_then(|(_, length)| length.trim().parse::<usize>().ok())).unwrap_or(0);
            if length > 4096 { return Ok(()); }
            break (index + 4, length);
        }
    };
    while request.len() < header_end + content_length {
        let mut buffer = [0; 1024];
        let count = stream.read(&mut buffer).await?;
        if count == 0 { return Ok(()); }
        request.extend_from_slice(&buffer[..count]);
    }
    let header = String::from_utf8_lossy(&request[..header_end]);
    let mut parts = header.lines().next().unwrap_or_default().split_whitespace();
    let method = parts.next().unwrap_or_default();
    let target = parts.next().unwrap_or_default().split('?').next().unwrap_or_default();
    let Some(route) = target.strip_prefix(&context.path) else { return respond(&mut stream, 404, "text/plain", b"").await; };
    if method == "GET" && route.is_empty() {
        let value = serde_json::json!({"meta":{"serverName":"SLH local offline skins","implementationName":"SLH","feature.non_email_login":true},
            "skinDomains":["127.0.0.1"],"signaturePublickey":context.public_key});
        return respond(&mut stream, 200, "application/json", &serde_json::to_vec(&value)?).await;
    }
    if method == "GET" {
        if let Some(id) = route.strip_prefix("sessionserver/session/minecraft/profile/") {
            if let Some((name, appearance)) = profile(context, id).await? {
                if let Some(skin) = appearance.skins.iter().find(|skin| skin.active) {
                    let bytes = texture_bytes(skin.data_url.as_deref())?;
                    let hash = hex::encode(Sha256::digest(&bytes));
                    let textures = serde_json::json!({"timestamp":chrono::Utc::now().timestamp_millis(),"profileId":id,"profileName":name,"signatureRequired":true,
                        "textures":{"SKIN":{"url":format!("{}textures/{id}/{hash}.png",context.url),"metadata":{"model":skin.variant.as_deref().unwrap_or("classic")}}}});
                    let value = STANDARD.encode(serde_json::to_vec(&textures)?);
                    let signature = STANDARD.encode(context.key.sign(value.as_bytes()).to_bytes());
                    let result = serde_json::json!({"id":id,"name":name,"properties":[{"name":"textures","value":value,"signature":signature}]});
                    return respond(&mut stream, 200, "application/json", &serde_json::to_vec(&result)?).await;
                }
            }
            return respond(&mut stream, 204, "application/json", b"").await;
        }
        if let Some((id, hash)) = route.strip_prefix("textures/").and_then(|route| route.split_once('/')) {
            if let Some((_, appearance)) = profile(context, id).await? {
                for skin in appearance.skins.iter().filter(|skin| skin.active) {
                    let bytes = texture_bytes(skin.data_url.as_deref())?;
                    if hash == format!("{}.png", hex::encode(Sha256::digest(&bytes))) {
                        return respond(&mut stream, 200, "image/png", &bytes).await;
                    }
                }
            }
        }
    }
    if method == "POST" && route == "api/profiles/minecraft" {
        if let Ok(names) = serde_json::from_slice::<Vec<String>>(&request[header_end..header_end + content_length]) {
            let mut profiles = Vec::new();
            for name in names.into_iter().take(32) {
                let row: Option<(String, String)> = sqlx::query_as("SELECT provider_uuid, username FROM accounts WHERE provider='offline' AND username = ? COLLATE NOCASE")
                    .bind(name).fetch_optional(&context.database).await?;
                if let Some((id, name)) = row { profiles.push(serde_json::json!({"id":id.replace('-',""),"name":name})); }
            }
            return respond(&mut stream, 200, "application/json", &serde_json::to_vec(&profiles)?).await;
        }
    }
    // No login/session-join endpoint is implemented by this skin service.
    respond(&mut stream, 404, "application/json", b"{}").await
}

async fn profile(context: &Context, id: &str) -> AppResult<Option<(String, AccountAppearance)>> {
    if id.len() != 32 || !id.bytes().all(|c| c.is_ascii_hexdigit()) { return Ok(None); }
    let row: Option<(String, String)> = sqlx::query_as("SELECT id, username FROM accounts WHERE provider='offline' AND REPLACE(provider_uuid,'-','') = ?")
        .bind(id).fetch_optional(&context.database).await?;
    let Some((account_id, name)) = row else { return Ok(None); };
    // Database account IDs, rather than URL paths, select the cache file.
    let path = context.accounts.join(format!("{account_id}.appearance.json"));
    let Ok(metadata) = tokio::fs::metadata(&path).await else { return Ok(None); };
    if metadata.len() > 8 * 1024 * 1024 { return Ok(None); }
    let value = serde_json::from_slice(&tokio::fs::read(path).await?)?;
    Ok(Some((name, value)))
}

fn texture_bytes(value: Option<&str>) -> AppResult<Vec<u8>> {
    let encoded = value.and_then(|value| value.strip_prefix("data:image/png;base64,")).ok_or_else(|| AppError::InvalidInput("Skin texture is invalid".into()))?;
    STANDARD.decode(encoded).map_err(|_| AppError::InvalidInput("Skin texture is invalid".into()))
}

async fn respond(stream: &mut TcpStream, status: u16, content_type: &str, body: &[u8]) -> AppResult<()> {
    let header = format!("HTTP/1.1 {status} OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n", body.len());
    stream.write_all(header.as_bytes()).await?;
    stream.write_all(body).await?;
    stream.shutdown().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rsa::{pkcs8::DecodePublicKey, signature::Verifier};

    #[tokio::test]
    async fn offline_gallery_persists_and_serves_signed_skin_without_authentication_endpoints() {
        let temp = tempfile::tempdir().unwrap();
        let paths = crate::portable::PortablePaths::from_executable(&std::env::current_exe().unwrap(), Some(temp.path().to_path_buf())).unwrap();
        let state = AppState::initialize_isolated_at(paths).await.unwrap();
        let account = crate::accounts::create_offline_account(&state.database, crate::models::CreateOfflineAccountRequest { username: "LocalSkinTest".into(), allow_invalid_username: false }).await.unwrap();
        let original = include_bytes!("../../../../src/assets/skins/Alex.png").to_vec();
        let appearance = crate::accounts::upload_skin_bytes(&state, &account.id, original.clone(), "Alex.png", "slim", None).await.unwrap();
        assert!(appearance.can_change_skin);
        assert!(!appearance.can_change_cape);
        let skin_id = &appearance.skins[0].id;
        let selected = crate::accounts::upload_skin_bytes(&state, &account.id, original.clone(), "Alex.png", "classic", Some(skin_id)).await.unwrap();
        assert_eq!(selected.skins.len(), 1);
        assert_eq!(selected.skins[0].variant.as_deref(), Some("classic"));
        assert!(crate::accounts::upload_skin_bytes(&state, &account.id, b"not a PNG".to_vec(), "bad.png", "classic", None).await.is_err());
        assert!(crate::accounts::select_cape(&state, &account.id, None).await.is_err());
        let home = crate::accounts::home_skin(&state, &account.id).await.unwrap();
        assert!(home["dataUrl"].is_string());
        assert_eq!(home["model"], "classic");

        let url = start(&state).await.unwrap();
        assert_eq!(start(&state).await.unwrap(), url);
        let http = reqwest::Client::new();
        let metadata: serde_json::Value = http.get(&url).send().await.unwrap().json().await.unwrap();
        let public_key = RsaPublicKey::from_public_key_pem(metadata["signaturePublickey"].as_str().unwrap()).unwrap();
        let id = account.provider_uuid.replace('-', "");
        let response: serde_json::Value = http.get(format!("{url}sessionserver/session/minecraft/profile/{id}?unsigned=false")).send().await.unwrap().json().await.unwrap();
        let property = &response["properties"][0];
        let value = property["value"].as_str().unwrap();
        let signature = STANDARD.decode(property["signature"].as_str().unwrap()).unwrap();
        rsa::pkcs1v15::VerifyingKey::<sha1::Sha1>::new(public_key).verify(value.as_bytes(), &rsa::pkcs1v15::Signature::try_from(signature.as_slice()).unwrap()).unwrap();
        let textures: serde_json::Value = serde_json::from_slice(&STANDARD.decode(value).unwrap()).unwrap();
        assert_eq!(textures["profileId"], id);
        assert_eq!(textures["textures"]["SKIN"]["metadata"]["model"], "classic");
        let png = http.get(textures["textures"]["SKIN"]["url"].as_str().unwrap()).send().await.unwrap();
        assert_eq!(png.headers()["content-type"], "image/png");
        assert!(png.bytes().await.unwrap().starts_with(b"\x89PNG"));
        assert_eq!(http.post(format!("{url}authserver/authenticate")).send().await.unwrap().status(), 404);
        assert_eq!(http.get(format!("{url}textures/../../secret")).send().await.unwrap().status(), 404);
        let names: serde_json::Value = http.post(format!("{url}api/profiles/minecraft")).json(&vec!["LocalSkinTest"]).send().await.unwrap().json().await.unwrap();
        assert_eq!(names[0]["id"], id);

        // Optional live compatibility probe with an unmodified Mojang authlib.
        // Normal unit tests remain independent of Java and external downloads.
        if let Ok(classpath) = std::env::var("SLH_LOCAL_SKIN_JAVA_CLASSPATH") {
            let java = std::env::var("SLH_LOCAL_SKIN_JAVA").unwrap_or_else(|_| "java".into());
            let output = tokio::time::timeout(std::time::Duration::from_secs(30), tokio::process::Command::new(java)
                .args(launch_arguments(&state).await.unwrap()).args(["-cp", &classpath, "SkinProbe", &id]).output()).await.unwrap().unwrap();
            assert!(output.status.success(), "Java probe failed: {}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
            assert!(String::from_utf8_lossy(&output.stdout).contains("OFFLINE_SKIN_OK"));
        }

        let cleared = crate::accounts::delete_saved_skin(&state, &account.id, skin_id).await.unwrap();
        assert!(cleared.skins.is_empty());
        assert!(!state.paths.accounts.join(format!("{}.skin.png", account.id)).exists());
        assert!(crate::accounts::home_skin(&state, &account.id).await.unwrap()["dataUrl"].is_null());
        assert_eq!(http.get(format!("{url}sessionserver/session/minecraft/profile/{id}")).send().await.unwrap().status(), 204);
        drop(state);
    }
}
