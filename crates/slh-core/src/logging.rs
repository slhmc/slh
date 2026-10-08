use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::EnvFilter;

use std::time::{Duration, SystemTime};

use crate::error::AppResult;
use crate::portable::PortablePaths;

pub fn initialize(paths: &PortablePaths) -> AppResult<WorkerGuard> {
    prune_logs(paths, 30)?;
    let appender = tracing_appender::rolling::daily(&paths.logs, "slh.log");
    let (writer, guard) = tracing_appender::non_blocking(appender);
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(writer)
        .with_ansi(false)
        .try_init();
    Ok(guard)
}

fn prune_logs(paths: &PortablePaths, retention_days: u64) -> AppResult<()> {
    let cutoff = Duration::from_secs(retention_days.saturating_mul(24 * 60 * 60));
    for entry in std::fs::read_dir(&paths.logs)? {
        let entry = entry?;
        if !entry.file_type()?.is_file()
            || !is_managed_log_name(&entry.file_name().to_string_lossy())
        {
            continue;
        }
        let expired = entry
            .metadata()?
            .modified()
            .ok()
            .and_then(|modified| SystemTime::now().duration_since(modified).ok())
            .is_some_and(|age| age > cutoff);
        if expired {
            std::fs::remove_file(entry.path())?;
        }
    }
    Ok(())
}

fn is_managed_log_name(name: &str) -> bool {
    name == "slh.log" || name.starts_with("slh.log.")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_rotation_only_targets_launcher_logs() {
        assert!(is_managed_log_name("slh.log"));
        assert!(is_managed_log_name("slh.log.2026-08-09"));
        assert!(!is_managed_log_name("minecraft.log"));
        assert!(!is_managed_log_name("slh.log-export.zip"));
    }
}
