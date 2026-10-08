use std::io::SeekFrom;
use std::path::PathBuf;
use std::sync::Arc;

use crate::host::Host;
use chrono::{SecondsFormat, Utc};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncSeekExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;

use crate::database;
use crate::error::{AppError, AppResult};
use crate::models::{ConsoleLine, ConsoleLineEvent};
use crate::state::AppState;

const MAX_TAIL_BYTES: u64 = 2 * 1024 * 1024;

pub async fn pump<R>(
    reader: R,
    app: Host,
    launch_id: String,
    instance_id: String,
    stream: &'static str,
    log: Arc<Mutex<tokio::fs::File>>,
) -> AppResult<()>
where
    R: AsyncRead + Unpin,
{
    let mut lines = BufReader::new(reader).lines();
    while let Some(raw) = lines.next_line().await? {
        let text = crate::security::redact_secrets(&strip_ansi(&raw));
        let timestamp = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let level = classify(&text, stream);
        {
            let mut file = log.lock().await;
            // Preserve Minecraft's own log format.  The previous SLH wrapper
            // obscured thread names and levels, making the log unlike a normal
            // launcher console and significantly harder to diagnose.
            file.write_all(text.as_bytes()).await?;
            file.write_all(b"\n").await?;
        }
        let _ = app.emit(
            crate::host::EventKind::ConsoleLine,
            ConsoleLineEvent {
                launch_id: launch_id.clone(),
                instance_id: instance_id.clone(),
                timestamp: Some(timestamp),
                stream: stream.into(),
                level: level.into(),
                text,
            },
        );
    }
    Ok(())
}

pub async fn append_system_line(
    log: &Arc<Mutex<tokio::fs::File>>,
    text: impl AsRef<str>,
) -> AppResult<()> {
    let line = crate::security::redact_secrets(text.as_ref());
    let mut file = log.lock().await;
    file.write_all(format!("[SLH] {line}\n").as_bytes()).await?;
    Ok(())
}

pub async fn latest(
    state: &AppState,
    instance_id: &str,
    limit: u32,
) -> AppResult<Vec<ConsoleLine>> {
    let instance = database::instance(&state.database, instance_id).await?;
    let root = crate::instances::validated_instance_root(
        &state.paths,
        &instance.folder_name,
        &instance.game_dir,
    )?;
    let logs = root.join("logs");
    if !logs.exists() {
        return Ok(Vec::new());
    }
    let path = latest_log_path(logs).await?;
    let Some(path) = path else {
        return Ok(Vec::new());
    };
    read_tail(path, limit.clamp(1, 10_000)).await
}

async fn latest_log_path(logs: PathBuf) -> AppResult<Option<PathBuf>> {
    tokio::task::spawn_blocking(move || {
        let mut candidates = Vec::new();
        for entry in std::fs::read_dir(logs)? {
            let entry = entry?;
            let file_type = entry.file_type()?;
            if file_type.is_symlink() || !file_type.is_file() {
                continue;
            }
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.starts_with("launch-") || !name.ends_with(".log") {
                continue;
            }
            let modified = entry.metadata()?.modified().ok();
            candidates.push((modified, path));
        }
        candidates.sort_by(|left, right| left.0.cmp(&right.0));
        Ok(candidates.pop().map(|(_, path)| path))
    })
    .await
    .map_err(|error| AppError::Process(format!("Console log scan failed: {error}")))?
}

async fn read_tail(path: PathBuf, limit: u32) -> AppResult<Vec<ConsoleLine>> {
    let mut file = tokio::fs::File::open(path).await?;
    let length = file.metadata().await?.len();
    let offset = length.saturating_sub(MAX_TAIL_BYTES);
    if offset > 0 {
        file.seek(SeekFrom::Start(offset)).await?;
    }
    let mut bytes = Vec::with_capacity((length - offset).min(MAX_TAIL_BYTES) as usize);
    file.read_to_end(&mut bytes).await?;
    let text = String::from_utf8_lossy(&bytes);
    let text = if offset > 0 {
        text.split_once('\n')
            .map(|(_, tail)| tail)
            .unwrap_or_default()
    } else {
        text.as_ref()
    };
    let mut lines = text
        .lines()
        .rev()
        .take(limit as usize)
        .map(parse_record)
        .collect::<Vec<_>>();
    lines.reverse();
    Ok(lines)
}

fn parse_record(raw: &str) -> ConsoleLine {
    let raw = strip_ansi(raw);
    if let Some(rest) = raw.strip_prefix('[')
        && let Some((timestamp, rest)) = rest.split_once("] [")
        && let Some((level, rest)) = rest.split_once("] [")
        && let Some((stream, text)) = rest.split_once("] ")
        && matches!(level, "info" | "warning" | "error" | "debug")
        && matches!(stream, "stdout" | "stderr")
    {
        return ConsoleLine {
            timestamp: Some(timestamp.into()),
            stream: stream.into(),
            level: level.into(),
            text: crate::security::redact_secrets(text),
        };
    }
    ConsoleLine {
        timestamp: None,
        stream: "log".into(),
        level: classify(&raw, "log").into(),
        text: crate::security::redact_secrets(&raw),
    }
}

fn classify(text: &str, stream: &str) -> &'static str {
    let lower = text.to_ascii_lowercase();
    if lower.contains("fatal")
        || lower.contains("exception")
        || lower.contains("[error")
        || lower.contains(" error:")
    {
        "error"
    } else if lower.contains("[warn") || lower.contains("warning") || stream == "stderr" {
        "warning"
    } else if text.starts_with("[SLH]") {
        "debug"
    } else if lower.contains("[debug") || lower.contains("[trace") {
        "debug"
    } else {
        "info"
    }
}

fn strip_ansi(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut output = String::with_capacity(value.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == 0x1b && bytes.get(index + 1) == Some(&b'[') {
            index += 2;
            while index < bytes.len() {
                let byte = bytes[index];
                index += 1;
                if (0x40..=0x7e).contains(&byte) {
                    break;
                }
            }
            continue;
        }
        let character = value[index..].chars().next().expect("valid UTF-8 boundary");
        output.push(character);
        index += character.len_utf8();
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn console_records_round_trip_and_legacy_lines_are_supported() {
        let record = parse_record("[2026-08-09T20:00:00.000Z] [warning] [stderr] Example warning");
        assert_eq!(record.level, "warning");
        assert_eq!(record.stream, "stderr");
        assert_eq!(
            record.timestamp.as_deref(),
            Some("2026-08-09T20:00:00.000Z")
        );
        let legacy = parse_record("[Render thread/INFO]: Ready");
        assert_eq!(legacy.stream, "log");
    }

    #[test]
    fn ansi_sequences_are_removed_from_console_text() {
        assert_eq!(strip_ansi("\u{1b}[31mError\u{1b}[0m"), "Error");
    }
}
