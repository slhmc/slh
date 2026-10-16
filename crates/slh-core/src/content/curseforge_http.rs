//! A shared request queue for both direct CurseForge access and the SLH relay.
use crate::error::{AppError, AppResult};
use reqwest::{Client, RequestBuilder, StatusCode, Method, Request};
use sha2::{Digest, Sha256};
use serde_json::Value;
use sqlx::SqlitePool;
use std::{collections::{HashMap, HashSet}, time::Duration};
use tokio::{sync::Mutex, time::Instant};

struct Queue {
    next_request: Instant,
    cache: HashMap<String, (Instant, Value)>,
    batch_unavailable: HashSet<String>,
}

pub struct CurseForgeHttp {
    queue: Mutex<Queue>,
    interval: Duration,
}

impl Default for CurseForgeHttp {
    fn default() -> Self {
        Self::new(Duration::from_secs(1))
    }
}

impl CurseForgeHttp {
    fn new(interval: Duration) -> Self {
        Self {
            queue: Mutex::new(Queue {
                next_request: Instant::now(),
                cache: HashMap::new(),
                batch_unavailable: HashSet::new(),
            }),
            interval,
        }
    }

    pub async fn batch_available(&self, request: RequestBuilder) -> AppResult<bool> {
        Ok(!self.queue.lock().await.batch_unavailable.contains(&request.build()?.url().origin().ascii_serialization()))
    }

    pub async fn cached(&self, request: RequestBuilder, database: &SqlitePool) -> AppResult<bool> {
        let key = cache_key(&request.build()?)?;
        if self.queue.lock().await.cache.get(&key).is_some_and(|(expiry, _)| *expiry > Instant::now()) { return Ok(true); }
        Ok(sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM content_cache WHERE cache_key = ? AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")
            .bind(key).fetch_one(database).await? > 0)
    }

    pub async fn remember(&self, request: RequestBuilder, value: Value, database: &SqlitePool) -> AppResult<()> {
        let request = request.build()?;
        let key = cache_key(&request)?;
        let ttl = cache_seconds(request.url());
        let mut queue = self.queue.lock().await;
        if queue.cache.len() >= 512 { queue.cache.clear(); }
        queue.cache.insert(key.clone(), (Instant::now() + Duration::from_secs(ttl), value.clone()));
        drop(queue);
        let expires = (chrono::Utc::now() + chrono::Duration::seconds(ttl as i64)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        sqlx::query("INSERT INTO content_cache(cache_key, source, payload_json, expires_at) VALUES (?, 'curseforge', ?, ?) ON CONFLICT(cache_key) DO UPDATE SET payload_json = excluded.payload_json, expires_at = excluded.expires_at, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")
            .bind(key).bind(value.to_string()).bind(expires).execute(database).await?;
        Ok(())
    }

    pub async fn json(
        &self,
        client: &Client,
        request: RequestBuilder,
        database: Option<&SqlitePool>,
        personal_key: bool,
    ) -> AppResult<Value> {
        let request = request.build()?;
        let key = cache_key(&request)?;
        // Hold the queue while resolving a request: concurrent callers for the
        // same endpoint reuse its result instead of sending duplicate requests.
        let mut queue = self.queue.lock().await;
        if let Some((expires, value)) = queue.cache.get(&key) {
            if *expires > Instant::now() {
                return Ok(value.clone());
            }
        }
        if let Some(database) = database {
            let cached: Option<String> = sqlx::query_scalar(
                "SELECT payload_json FROM content_cache WHERE cache_key = ? AND source = 'curseforge' AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
            ).bind(&key).fetch_optional(database).await?;
            if let Some(value) = cached.and_then(|text| serde_json::from_str::<Value>(&text).ok()) {
                // SQLite remains the expiry authority for persisted entries.
                return Ok(value);
            }
        }
        for attempt in 0..4 {
            let now = Instant::now();
            if queue.next_request > now {
                let wait = queue.next_request - now;
                if wait > Duration::from_secs(60) {
                    return Err(rate_limit_error(wait.as_secs() + 1));
                }
                tokio::time::sleep_until(queue.next_request).await;
            }
            // Advance before awaiting the response so cancellation also respects pacing.
            queue.next_request = Instant::now() + self.interval;
            let retry = request.try_clone().ok_or_else(|| {
                AppError::InvalidInput("CurseForge request cannot be retried".into())
            })?;
            let response = match client.execute(retry).await {
                Ok(response) => response,
                Err(error) if attempt < 3 && (error.is_timeout() || error.is_connect()) => {
                    queue.next_request = Instant::now() + Duration::from_secs(2 << attempt);
                    continue;
                }
                Err(error) => return Err(error.into()),
            };
            if request.method() == Method::POST && matches!(response.status(), StatusCode::NOT_FOUND | StatusCode::METHOD_NOT_ALLOWED) {
                queue.batch_unavailable.insert(request.url().origin().ascii_serialization());
                return Err(AppError::Unavailable("CurseForge batch requests are unavailable".into()));
            }
            if response.status().is_server_error() && attempt < 3 {
                queue.next_request = Instant::now() + Duration::from_secs(2 << attempt);
                continue;
            }
            if response.status() == StatusCode::TOO_MANY_REQUESTS {
                let delay = retry_after(response.headers(), attempt);
                queue.next_request = Instant::now() + delay;
                if attempt == 3 || delay > Duration::from_secs(60) {
                    return Err(rate_limit_error(delay.as_secs()));
                }
                continue;
            }
            if !response.status().is_success() {
                if !personal_key {
                    if matches!(
                        response.status(),
                        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
                    ) {
                        return Err(AppError::Unavailable("The SLH CurseForge relay is locked by Netlify access protection. Disable Visitor Access for /api/v1/* on the relay deployment.".into()));
                    }
                    if response.status() == StatusCode::NOT_FOUND {
                        return Err(AppError::Unavailable(
                            "The SLH CurseForge relay route /api/v1/* is not deployed (HTTP 404)"
                                .into(),
                        ));
                    }
                }
                return Err(response
                    .error_for_status()
                    .expect_err("non-success response")
                    .into());
            }
            let content_type = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .to_ascii_lowercase();
            if !content_type.contains("application/json") {
                return Err(AppError::Unavailable("CurseForge returned a non-JSON response; check the relay routing and access protection".into()));
            }
            let value: Value = response.json().await?;
            let ttl = cache_seconds(request.url());
            if queue.cache.len() >= 512 {
                queue
                    .cache
                    .retain(|_, (expires, _)| *expires > Instant::now());
            }
            if queue.cache.len() >= 512 {
                queue.cache.clear();
            }
            queue.cache.insert(
                key.clone(),
                (Instant::now() + Duration::from_secs(ttl), value.clone()),
            );
            if let Some(database) = database {
                let expires = (chrono::Utc::now() + chrono::Duration::seconds(ttl as i64))
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                sqlx::query("INSERT INTO content_cache(cache_key, source, payload_json, expires_at) VALUES (?, 'curseforge', ?, ?) ON CONFLICT(cache_key) DO UPDATE SET payload_json = excluded.payload_json, expires_at = excluded.expires_at, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")
                    .bind(&key).bind(value.to_string()).bind(expires).execute(database).await?;
            }
            return Ok(value);
        }
        unreachable!("the last retry returns an error")
    }
}

fn cache_key(request: &Request) -> AppResult<String> {
    if request.method() == Method::GET { return Ok(format!("curseforge-api:{}", request.url())); }
    let body = request.body().and_then(|body| body.as_bytes()).ok_or_else(|| AppError::InvalidInput("CurseForge batch request must have a buffered body".into()))?;
    Ok(format!("curseforge-api:{}:{}:{}", request.method(), request.url(), hex::encode(Sha256::digest(body))))
}

fn cache_seconds(url: &url::Url) -> u64 {
    let path = url.path();
    if path.contains("/files/") {
        24 * 60 * 60
    } else if path.ends_with("/files") || path.ends_with("/description") {
        5 * 60
    } else if path.ends_with("/search") {
        30
    } else {
        15 * 60
    }
}

fn retry_after(headers: &reqwest::header::HeaderMap, attempt: u32) -> Duration {
    let seconds = headers
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| {
            v.parse::<u64>().ok().or_else(|| {
                chrono::DateTime::parse_from_rfc2822(v).ok().map(|date| {
                    (date.with_timezone(&chrono::Utc) - chrono::Utc::now())
                        .num_seconds()
                        .max(0) as u64
                })
            })
        })
        .unwrap_or(15 * (1 << attempt));
    // Untrusted headers must not overflow Instant when scheduling a cooldown.
    Duration::from_secs(seconds.clamp(1, 7 * 24 * 60 * 60))
}

fn rate_limit_error(seconds: u64) -> AppError {
    AppError::Unavailable(format!(
        "CurseForge is temporarily rate limited (HTTP 429). Retry in {seconds} seconds."
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn server(
        responses: Vec<&'static str>,
    ) -> (String, tokio::task::JoinHandle<Vec<Instant>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let mut starts = Vec::new();
            for response in responses {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut data = vec![0; 8192];
                socket.read(&mut data).await.unwrap();
                starts.push(Instant::now());
                socket.write_all(response.as_bytes()).await.unwrap();
            }
            starts
        });
        (url, task)
    }
    const OK: &str = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 10\r\nConnection: close\r\n\r\n{\"data\":1}";
    const OTHER: &str = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 10\r\nConnection: close\r\n\r\n{\"data\":2}";

    #[tokio::test]
    async fn batch_cache_distinguishes_bodies_and_reuses_identical_batches() {
        let (url, server) = server(vec![OK, OTHER]).await;
        let http = CurseForgeHttp::new(Duration::ZERO);
        let client = Client::new();
        for (ids, expected) in [(vec![1], 1), (vec![2], 2), (vec![1], 1)] {
            let value = http.json(&client, client.post(format!("{url}/mods/files")).json(&serde_json::json!({"fileIds": ids})), None, false).await.unwrap();
            assert_eq!(value["data"], expected);
        }
        assert_eq!(server.await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn missing_batch_support_does_not_disable_get_requests() {
        let (url, server) = server(vec!["HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", OK]).await;
        let http = CurseForgeHttp::new(Duration::ZERO);
        let client = Client::new();
        assert!(http.json(&client, client.post(format!("{url}/mods")).json(&serde_json::json!({"modIds": [1]})), None, false).await.is_err());
        assert!(!http.batch_available(client.post(format!("{url}/mods/files"))).await.unwrap());
        assert!(http.batch_available(client.post("https://api.curseforge.com/v1/mods")).await.unwrap());
        assert_eq!(http.json(&client, client.get(format!("{url}/mods/1")), None, false).await.unwrap()["data"], 1);
        assert_eq!(server.await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn temporary_server_failure_is_retried() {
        let (url, server) = server(vec!["HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", OK]).await;
        let http = CurseForgeHttp::new(Duration::ZERO);
        let client = Client::new();
        assert_eq!(http.json(&client, client.get(format!("{url}/mods/1")), None, false).await.unwrap()["data"], 1);
        assert_eq!(server.await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn concurrent_duplicate_requests_are_sent_once_and_distinct_requests_are_paced() {
        let (url, server) = server(vec![OK, OK]).await;
        let http = CurseForgeHttp::new(Duration::from_millis(60));
        let client = Client::new();
        let (a, b) = tokio::join!(
            http.json(&client, client.get(format!("{url}/mods/1")), None, false),
            http.json(&client, client.get(format!("{url}/mods/1")), None, false)
        );
        assert_eq!(a.unwrap(), b.unwrap());
        http.json(&client, client.get(format!("{url}/mods/2")), None, false)
            .await
            .unwrap();
        let starts = server.await.unwrap();
        assert!(starts[1] - starts[0] >= Duration::from_millis(50));
    }

    #[tokio::test]
    async fn rate_limited_request_waits_and_retries_then_caches_success() {
        let (url, server) = server(vec!["HTTP/1.1 429 Too Many Requests\r\nRetry-After: 1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", OK]).await;
        let http = CurseForgeHttp::new(Duration::ZERO);
        let client = Client::new();
        let request_url = format!("{url}/mods/1");
        assert_eq!(
            http.json(&client, client.get(&request_url), None, false)
                .await
                .unwrap()["data"],
            1
        );
        let starts = server.await.unwrap();
        assert!(starts[1] - starts[0] >= Duration::from_millis(950));
        assert_eq!(
            http.json(&client, client.get(&request_url), None, false)
                .await
                .unwrap()["data"],
            1
        );
    }

    #[tokio::test]
    async fn long_retry_after_stops_all_queued_network_requests() {
        let (url, server) = server(vec!["HTTP/1.1 429 Too Many Requests\r\nRetry-After: 3600\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"]).await;
        let http = CurseForgeHttp::new(Duration::ZERO);
        let client = Client::new();
        assert!(
            http.json(&client, client.get(format!("{url}/mods/1")), None, false)
                .await
                .unwrap_err()
                .to_string()
                .contains("3600")
        );
        server.await.unwrap();
        assert!(
            http.json(&client, client.get(format!("{url}/mods/2")), None, false)
                .await
                .unwrap_err()
                .to_string()
                .contains("HTTP 429")
        );
    }

    #[tokio::test]
    async fn metadata_cache_survives_restart_but_expired_data_is_refetched() {
        let database = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE content_cache(cache_key TEXT PRIMARY KEY, source TEXT, payload_json TEXT, expires_at TEXT, updated_at TEXT)").execute(&database).await.unwrap();
        let (url, server) = server(vec![OK, OTHER]).await;
        let client = Client::new();
        let request_url = format!("{url}/mods/1/files/2");
        let first = CurseForgeHttp::new(Duration::ZERO);
        assert_eq!(
            first
                .json(&client, client.get(&request_url), Some(&database), false)
                .await
                .unwrap()["data"],
            1
        );
        let restarted = CurseForgeHttp::new(Duration::ZERO);
        assert_eq!(
            restarted
                .json(&client, client.get(&request_url), Some(&database), false)
                .await
                .unwrap()["data"],
            1
        );
        sqlx::query("UPDATE content_cache SET expires_at = '2000-01-01T00:00:00.000Z'")
            .execute(&database)
            .await
            .unwrap();
        let expired = CurseForgeHttp::new(Duration::ZERO);
        assert_eq!(
            expired
                .json(&client, client.get(&request_url), Some(&database), false)
                .await
                .unwrap()["data"],
            2
        );
        assert_eq!(server.await.unwrap().len(), 2);
    }
}
