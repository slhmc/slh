//! On-demand measurements of the verified Java process; no background sampling loop.
use super::{
    host::{RunInfo, read_run},
    runtime::run_file,
    store,
};
use crate::{
    error::{AppError, AppResult},
    state::AppState,
};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use sysinfo::{CpuRefreshKind, Pid, ProcessRefreshKind, ProcessesToUpdate, System};

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerMetrics {
    pub memory_bytes: Option<u64>,
    pub cpu_percent: Option<f32>,
    pub uptime_seconds: Option<u64>,
}

struct Sampler {
    system: System,
    sampled: Option<Instant>,
    value: ServerMetrics,
}
impl Sampler {
    fn new() -> Self {
        let mut system = System::new();
        system.refresh_cpu_list(CpuRefreshKind::nothing());
        Self {
            system,
            sampled: None,
            value: ServerMetrics::default(),
        }
    }
    fn sample(&mut self, info: &RunInfo) -> ServerMetrics {
        if self
            .sampled
            .is_some_and(|time| time.elapsed() < Duration::from_secs(1))
        {
            return self.value.clone();
        }
        let pid = Pid::from_u32(info.java_pid);
        self.system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[pid]),
            true,
            ProcessRefreshKind::nothing()
                .with_cpu()
                .with_memory()
                .without_tasks(),
        );
        let value = self
            .system
            .process(pid)
            .filter(|p| p.start_time() == info.java_started)
            .map(|p| ServerMetrics {
                memory_bytes: Some(p.memory()),
                // sysinfo reports the sum across cores; match the system-wide 0–100% scale.
                cpu_percent: self
                    .sampled
                    .filter(|time| time.elapsed() < Duration::from_secs(10))
                    .map(|_| {
                        (p.cpu_usage() / self.system.cpus().len().max(1) as f32).clamp(0., 100.)
                    }),
                uptime_seconds: Some(p.run_time()),
            })
            .unwrap_or_default();
        self.sampled = Some(Instant::now());
        self.value = value.clone();
        value
    }
}

pub async fn get(state: &AppState, id: &str) -> AppResult<ServerMetrics> {
    let _ = store::get(state, id).await?;
    let path = run_file(state, id);
    tokio::task::spawn_blocking(move || {
        let Ok(info) = read_run(&path) else {
            return Ok(ServerMetrics::default());
        };
        if info.java_pid == 0 || info.java_started == 0 {
            return Ok(ServerMetrics::default());
        }
        static SAMPLERS: OnceLock<Mutex<HashMap<(u32, u64), Sampler>>> = OnceLock::new();
        let mut samplers = SAMPLERS
            .get_or_init(Mutex::default)
            .lock()
            .map_err(|_| AppError::Process("Server metrics unavailable".into()))?;
        samplers.retain(|_, s| {
            s.sampled
                .is_some_and(|time| time.elapsed() < Duration::from_secs(300))
        });
        let key = (info.java_pid, info.java_started);
        if !samplers.contains_key(&key) && samplers.len() >= 32 {
            if let Some(oldest) = samplers
                .iter()
                .min_by_key(|(_, s)| s.sampled)
                .map(|(key, _)| *key)
            {
                samplers.remove(&oldest);
            }
        }
        Ok(samplers
            .entry(key)
            .or_insert_with(Sampler::new)
            .sample(&info))
    })
    .await
    .map_err(|error| AppError::Process(error.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn current() -> RunInfo {
        let pid = std::process::id();
        RunInfo {
            server_id: "test".into(),
            host_pid: pid,
            java_pid: pid,
            java_started: super::super::host::process_identity(pid).unwrap(),
            endpoint: String::new(),
            token: String::new(),
            state: "running".into(),
            exit_code: None,
            error: None,
        }
    }
    #[test]
    fn measures_verified_process_and_warms_cpu_without_blocking() {
        let info = current();
        let mut sampler = Sampler::new();
        let first = sampler.sample(&info);
        assert!(first.memory_bytes.is_some_and(|value| value > 0));
        assert!(first.cpu_percent.is_none());
        assert!(first.uptime_seconds.is_some());
        std::thread::sleep(Duration::from_millis(1100));
        let next = sampler.sample(&info);
        assert!(
            next.cpu_percent
                .is_some_and(|value| (0.0..=100.0).contains(&value))
        );
    }
    #[test]
    fn rejects_reused_pid_and_does_not_report_zero_as_a_measurement() {
        let mut info = current();
        info.java_started += 1;
        let value = Sampler::new().sample(&info);
        assert!(value.memory_bytes.is_none());
        assert!(value.cpu_percent.is_none());
        assert!(value.uptime_seconds.is_none());
    }
}
