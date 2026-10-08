use std::path::{Path, PathBuf};

use futures_util::StreamExt;
use sha1::{Digest, Sha1};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::error::{AppError, AppResult};

/// No launcher-managed artifact is expected to be this large. This is a
/// final per-file safety net for servers that omit or lie about Content-Length.
/// It is a size check, not a quota and therefore has no time-based reset.
const MAX_DOWNLOAD_BYTES: u64 = 16 * 1024 * 1024 * 1024;

/// The default is deliberately high enough to keep the Mojang asset CDN busy
/// while still being reasonable on slower connections. Users can lower or
/// raise it from Settings (the value is capped by `MAX_DOWNLOAD_CONCURRENCY`).
pub const DEFAULT_DOWNLOAD_CONCURRENCY: usize = 16;
pub const MAX_DOWNLOAD_CONCURRENCY: usize = 32;

#[derive(Clone, Debug)]
pub struct DownloadPlan {
    pub url: String,
    pub destination: PathBuf,
    pub sha1: Option<String>,
    /// Optional per-download override for a source-specific ceiling.
    pub max_bytes: Option<u64>,
}

/// A Bedrock package can be resumed from another official CDN mirror. This
/// plan is intentionally separate from `DownloadPlan` so Java's existing
/// installer keeps its established transfer semantics.
#[derive(Clone, Debug)]
pub struct ResumableDownloadPlan {
    pub url: String,
    pub destination: PathBuf,
    pub md5: Option<String>,
    pub max_bytes: Option<u64>,
}

pub async fn download_verified(client: &reqwest::Client, plan: &DownloadPlan) -> AppResult<u64> {
    download_verified_inner(client, plan, |_completed, _total| {}).await
}

/// Downloads a verified file and reports byte progress after each received chunk.
/// The callback is deliberately synchronous so callers can forward lightweight
/// Tauri progress events without creating an unbounded task per chunk.
pub async fn download_verified_with_progress<F>(
    client: &reqwest::Client,
    plan: &DownloadPlan,
    on_progress: F,
) -> AppResult<u64>
where
    F: FnMut(u64, Option<u64>) + Send,
{
    download_verified_inner(client, plan, on_progress).await
}

/// Return the configured transfer parallelism. Older databases may not have
/// the setting (or may contain a malformed value), so a safe default is used
/// in those cases. Keeping this in one place makes every installer path obey
/// the same limit instead of silently using a hard-coded value.
pub async fn configured_concurrency(pool: &sqlx::SqlitePool) -> usize {
    crate::database::setting(pool, "downloads")
        .await
        .ok()
        .and_then(|value| value.get("concurrency").and_then(serde_json::Value::as_u64))
        .map(|value| value as usize)
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_DOWNLOAD_CONCURRENCY)
        .clamp(1, MAX_DOWNLOAD_CONCURRENCY)
}

/// Download independent plans concurrently while keeping completion results
/// ordered by their input index. The callback runs as each transfer finishes,
/// so callers can update progress without spawning one task per chunk/file.
/// A failed transfer stops the batch and drops the remaining in-flight work.
pub async fn download_many<F>(
    client: &reqwest::Client,
    plans: Vec<DownloadPlan>,
    concurrency: usize,
    mut on_complete: F,
) -> AppResult<Vec<u64>>
where
    F: FnMut(usize, u64) + Send,
{
    let total = plans.len();
    if total == 0 {
        return Ok(Vec::new());
    }
    let concurrency = concurrency.clamp(1, MAX_DOWNLOAD_CONCURRENCY);
    let mut pending =
        futures_util::stream::iter(plans.into_iter().enumerate().map(|(index, plan)| {
            let client = client.clone();
            async move {
                let bytes = download_verified(&client, &plan).await?;
                Ok::<(usize, u64), AppError>((index, bytes))
            }
        }))
        .buffer_unordered(concurrency);
    let mut results = vec![0_u64; total];
    while let Some(result) = pending.next().await {
        let (index, bytes) = result?;
        results[index] = bytes;
        on_complete(index, bytes);
    }
    Ok(results)
}

async fn download_verified_inner<F>(
    client: &reqwest::Client,
    plan: &DownloadPlan,
    mut on_progress: F,
) -> AppResult<u64>
where
    F: FnMut(u64, Option<u64>) + Send,
{
    if plan.destination.is_file() {
        if let Some(expected) = &plan.sha1 {
            if verify_sha1(&plan.destination, expected).await? {
                let bytes = std::fs::metadata(&plan.destination)?.len();
                on_progress(bytes, Some(bytes));
                return Ok(bytes);
            }
        } else {
            let bytes = std::fs::metadata(&plan.destination)?.len();
            on_progress(bytes, Some(bytes));
            return Ok(bytes);
        }
    }
    if let Some(parent) = plan.destination.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let temporary = temporary_path(&plan.destination);
    let mut last_error = None;
    for attempt in 1..=3 {
        match download_once(client, plan, &temporary, &mut on_progress).await {
            Ok(bytes) => {
                if plan.destination.exists() {
                    tokio::fs::remove_file(&plan.destination).await?;
                }
                tokio::fs::rename(&temporary, &plan.destination).await?;
                return Ok(bytes);
            }
            Err(error) => {
                last_error = Some(error);
                let _ = tokio::fs::remove_file(&temporary).await;
                if attempt < 3 {
                    tokio::time::sleep(std::time::Duration::from_millis(250 * (1 << attempt)))
                        .await;
                }
            }
        }
    }
    Err(last_error
        .unwrap_or_else(|| AppError::Process("Download failed without a detailed error".into())))
}

async fn download_once(
    client: &reqwest::Client,
    plan: &DownloadPlan,
    temporary: &Path,
    on_progress: &mut impl FnMut(u64, Option<u64>),
) -> AppResult<u64> {
    let max_bytes = plan.max_bytes.unwrap_or(MAX_DOWNLOAD_BYTES);
    let response = client.get(&plan.url).send().await?.error_for_status()?;
    let total = response.content_length();
    if total.is_some_and(|length| length > max_bytes) {
        return Err(AppError::Security(format!(
            "Download exceeds the {} GiB per-file safety limit; this is not a time-based quota",
            max_bytes / 1024 / 1024 / 1024
        )));
    }
    let mut stream = response.bytes_stream();
    let mut file = tokio::fs::File::create(temporary).await?;
    let mut digest = Sha1::new();
    let mut written = 0_u64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        digest.update(&chunk);
        file.write_all(&chunk).await?;
        written = written.saturating_add(chunk.len() as u64);
        if written > max_bytes {
            return Err(AppError::Security(format!(
                "Download exceeds the {} GiB per-file safety limit; this is not a time-based quota",
                max_bytes / 1024 / 1024 / 1024
            )));
        }
        on_progress(written, total);
    }
    file.flush().await?;
    drop(file);
    if let Some(expected) = &plan.sha1 {
        let actual = hex::encode(digest.finalize());
        if !actual.eq_ignore_ascii_case(expected) {
            return Err(AppError::Security(format!(
                "Checksum mismatch for {}: expected {expected}, received {actual}",
                plan.destination.display()
            )));
        }
    }
    Ok(written)
}

/// Download a large package using HTTP Range requests and keep the partial
/// file when a connection drops. The caller may retry this same destination
/// with another URL because all Bedrock mirrors contain the same object.
pub async fn download_resumable_verified_with_progress<F>(
    client: &reqwest::Client,
    plan: &ResumableDownloadPlan,
    on_progress: F,
) -> AppResult<u64>
where
    F: FnMut(u64, Option<u64>) + Send,
{
    download_resumable_inner(client, plan, on_progress).await
}

async fn download_resumable_inner<F>(
    client: &reqwest::Client,
    plan: &ResumableDownloadPlan,
    mut on_progress: F,
) -> AppResult<u64>
where
    F: FnMut(u64, Option<u64>) + Send,
{
    let max_bytes = plan.max_bytes.unwrap_or(MAX_DOWNLOAD_BYTES);
    if plan.destination.is_file() {
        let valid = if let Some(expected) = &plan.md5 {
            verify_md5(&plan.destination, expected).await?
        } else {
            tokio::fs::metadata(&plan.destination)
                .await
                .map(|metadata| metadata.len() > 0)
                .unwrap_or(false)
        };
        if valid {
            let bytes = tokio::fs::metadata(&plan.destination).await?.len();
            on_progress(bytes, Some(bytes));
            return Ok(bytes);
        }
        let _ = tokio::fs::remove_file(&plan.destination).await;
    }
    if let Some(parent) = plan.destination.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let temporary = temporary_path(&plan.destination);
    let mut last_error = None;
    for attempt in 1..=3_u32 {
        match download_resumable_once(client, plan, max_bytes, &temporary, &mut on_progress).await {
            Ok(bytes) => {
                if plan.destination.exists() {
                    tokio::fs::remove_file(&plan.destination).await?;
                }
                tokio::fs::rename(&temporary, &plan.destination).await?;
                return Ok(bytes);
            }
            Err(error) => {
                last_error = Some(error);
                if attempt < 3 {
                    tokio::time::sleep(std::time::Duration::from_millis(250 * (1 << attempt)))
                        .await;
                }
            }
        }
    }
    Err(last_error.unwrap_or_else(|| {
        AppError::Process("Resumable download failed without a detailed error".into())
    }))
}

async fn download_resumable_once(
    client: &reqwest::Client,
    plan: &ResumableDownloadPlan,
    max_bytes: u64,
    temporary: &Path,
    on_progress: &mut impl FnMut(u64, Option<u64>),
) -> AppResult<u64> {
    let existing = tokio::fs::metadata(temporary)
        .await
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let mut request = client.get(&plan.url);
    if existing > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={existing}-"));
    }
    let response = request.send().await?;
    let status = response.status();
    if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
        let _ = tokio::fs::remove_file(temporary).await;
        return Err(AppError::Unavailable(format!(
            "Mirror rejected the resume range for {}",
            plan.url
        )));
    }
    if !status.is_success() {
        return Err(AppError::Unavailable(format!(
            "Mirror returned HTTP {status}"
        )));
    }

    // A server that ignores Range returns 200. Start over safely instead of
    // appending a complete file to an old partial file.
    let append = existing > 0 && status == reqwest::StatusCode::PARTIAL_CONTENT;
    if append {
        let Some((range_start, _, _)) =
            parse_content_range(response.headers().get(reqwest::header::CONTENT_RANGE))
        else {
            let _ = tokio::fs::remove_file(temporary).await;
            return Err(AppError::Unavailable(
                "Mirror returned a partial response without a valid range".into(),
            ));
        };
        if range_start != existing {
            let _ = tokio::fs::remove_file(temporary).await;
            return Err(AppError::Unavailable(
                "Mirror returned a different resume offset".into(),
            ));
        }
    }
    let initial_bytes = if append { existing } else { 0 };
    let total = if append {
        parse_content_range(response.headers().get(reqwest::header::CONTENT_RANGE))
            .and_then(|(_, _, total)| total)
            .or_else(|| {
                response
                    .content_length()
                    .map(|length| initial_bytes.saturating_add(length))
            })
    } else {
        response.content_length()
    };
    if total.is_some_and(|length| length > max_bytes) {
        let _ = tokio::fs::remove_file(temporary).await;
        return Err(AppError::Security(format!(
            "Download exceeds the {} GiB per-file safety limit; this is not a time-based quota",
            max_bytes / 1024 / 1024 / 1024
        )));
    }

    let mut file = if append {
        tokio::fs::OpenOptions::new()
            .append(true)
            .open(temporary)
            .await?
    } else {
        tokio::fs::File::create(temporary).await?
    };
    let mut written = initial_bytes;
    on_progress(written, total);
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        written = written.saturating_add(chunk.len() as u64);
        if written > max_bytes {
            return Err(AppError::Security(format!(
                "Download exceeds the {} GiB per-file safety limit; this is not a time-based quota",
                max_bytes / 1024 / 1024 / 1024
            )));
        }
        file.write_all(&chunk).await?;
        on_progress(written, total);
    }
    file.flush().await?;
    drop(file);
    if total.is_some_and(|length| written < length) {
        return Err(AppError::Unavailable(
            "Mirror closed before the package was complete".into(),
        ));
    }
    if let Some(expected) = &plan.md5 {
        if !verify_md5(temporary, expected).await? {
            let _ = tokio::fs::remove_file(temporary).await;
            return Err(AppError::Security(format!(
                "MD5 checksum mismatch for {}",
                plan.destination.display()
            )));
        }
    }
    Ok(written)
}

fn parse_content_range(
    value: Option<&reqwest::header::HeaderValue>,
) -> Option<(u64, u64, Option<u64>)> {
    let value = value?.to_str().ok()?.strip_prefix("bytes ")?;
    let (range, total) = value.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    Some((
        start.parse().ok()?,
        end.parse().ok()?,
        (total != "*").then(|| total.parse().ok()).flatten(),
    ))
}

pub async fn verify_md5(path: &Path, expected: &str) -> AppResult<bool> {
    let mut file = tokio::fs::File::open(path).await?;
    let mut digest = md5::Context::new();
    let mut buffer = vec![0_u8; 128 * 1024];
    loop {
        let read = file.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        digest.consume(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()).eq_ignore_ascii_case(expected))
}

pub async fn verify_sha1(path: &Path, expected: &str) -> AppResult<bool> {
    let mut file = tokio::fs::File::open(path).await?;
    let mut digest = Sha1::new();
    let mut buffer = vec![0_u8; 128 * 1024];
    loop {
        let read = tokio::io::AsyncReadExt::read(&mut file, &mut buffer).await?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(hex::encode(digest.finalize()).eq_ignore_ascii_case(expected))
}

fn temporary_path(destination: &Path) -> PathBuf {
    let file_name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("download");
    destination.with_file_name(format!(".{file_name}.slh-part"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_http_content_ranges() {
        let first = reqwest::header::HeaderValue::from_static("bytes 128-255/1024");
        let open = reqwest::header::HeaderValue::from_static("bytes 0-0/*");
        let invalid = reqwest::header::HeaderValue::from_static("invalid");
        assert_eq!(
            parse_content_range(Some(&first)),
            Some((128, 255, Some(1024)))
        );
        assert_eq!(parse_content_range(Some(&open)), Some((0, 0, None)));
        assert_eq!(parse_content_range(Some(&invalid)), None);
    }

    #[tokio::test]
    async fn verifies_md5_for_a_completed_package() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("package.msixvc");
        tokio::fs::write(&path, b"hello world")
            .await
            .expect("write package");
        assert!(
            verify_md5(&path, "5eb63bbbe01eeed093cb22bb8f5acdc3")
                .await
                .expect("verify md5")
        );
        assert!(
            !verify_md5(&path, "00000000000000000000000000000000")
                .await
                .expect("verify md5")
        );
    }

    #[tokio::test]
    async fn resumes_a_partial_package_with_range() {
        use httpmock::prelude::*;

        let server = MockServer::start_async().await;
        let mock = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/package.msixvc")
                    .header("range", "bytes=5-");
                then.status(206)
                    .header("Content-Range", "bytes 5-10/11")
                    .body(" world");
            })
            .await;
        let directory = tempfile::tempdir().expect("temporary directory");
        let destination = directory.path().join("package.msixvc");
        let partial = directory.path().join(".package.msixvc.slh-part");
        tokio::fs::write(&partial, b"hello")
            .await
            .expect("write partial");
        let bytes = download_resumable_verified_with_progress(
            &reqwest::Client::new(),
            &ResumableDownloadPlan {
                url: server.url("/package.msixvc"),
                destination: destination.clone(),
                md5: Some("5eb63bbbe01eeed093cb22bb8f5acdc3".into()),
                max_bytes: Some(1024),
            },
            |_completed, _total| {},
        )
        .await
        .expect("resume package");
        assert_eq!(bytes, 11);
        assert_eq!(
            tokio::fs::read(&destination).await.expect("read package"),
            b"hello world"
        );
        mock.assert_async().await;
    }
}
