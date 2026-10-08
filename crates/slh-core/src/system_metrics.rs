use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use sysinfo::{Disks, Networks, Pid, ProcessRefreshKind, ProcessesToUpdate, System};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemMetrics {
    cpu_percent: Option<f32>,
    launcher_cpu_percent: Option<f32>,
    launcher_memory_bytes: u64,
    launcher_gpu_percent: Option<f64>,
    launcher_io_read_per_second: Option<f64>,
    launcher_io_write_per_second: Option<f64>,
    memory_used_bytes: u64,
    memory_total_bytes: u64,
    network_received_per_second: Option<f64>,
    network_sent_per_second: Option<f64>,
    gpu_percent: Option<f64>,
    disk_available_bytes: Option<u64>,
    disk_total_bytes: Option<u64>,
}

#[derive(Clone, Copy, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MetricsScope {
    Launcher,
    System,
    #[default]
    All,
}

#[derive(Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Metric {
    Cpu,
    Memory,
    Network,
    Gpu,
    Disk,
}

#[derive(Clone, PartialEq, Eq)]
struct Request {
    scope: MetricsScope,
    metrics: Vec<Metric>,
}
impl Request {
    fn has(&self, metric: Metric) -> bool {
        self.metrics.contains(&metric)
    }
    fn launcher(&self) -> bool {
        self.scope != MetricsScope::System
    }
    fn system(&self) -> bool {
        self.scope != MetricsScope::Launcher
    }
}

fn webview_process(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "msedgewebview2.exe"
            | "msedgewebview2"
            | "webkitwebprocess"
            | "webkitnetworkprocess"
            | "webkitgpuprocess"
            | "com.apple.webkit.webcontent"
            | "com.apple.webkit.networking"
            | "com.apple.webkit.gpu"
    )
}

fn launcher_tree(
    root: Pid,
    processes: &[(Pid, Option<Pid>, String)],
) -> std::collections::HashSet<Pid> {
    let mut pids = std::collections::HashSet::from([root]);
    loop {
        let mut changed = false;
        for (pid, parent, name) in processes {
            if parent.is_some_and(|parent| pids.contains(&parent)) && webview_process(name) {
                changed |= pids.insert(*pid);
            }
        }
        if !changed {
            return pids;
        }
    }
}

struct Sampler {
    system: System,
    networks: Networks,
    disks: Disks,
    discovered: Option<Instant>,
    disk_refreshed: Option<Instant>,
    launcher_pids: std::collections::HashSet<Pid>,
    last_tick: Option<Instant>,
    last_request: Option<Request>,
    cached: Option<SystemMetrics>,
    #[cfg(windows)]
    gpu: Option<GpuCounter>,
    #[cfg(windows)]
    gpu_tick: Option<Instant>,
    #[cfg(windows)]
    gpu_value: Option<(f64, f64)>,
}

impl Sampler {
    fn new() -> Self {
        Self {
            system: System::new(),
            networks: Networks::new(),
            disks: Disks::new(),
            discovered: None,
            disk_refreshed: None,
            launcher_pids: std::collections::HashSet::new(),
            last_tick: None,
            last_request: None,
            cached: None,
            #[cfg(windows)]
            gpu: None,
            #[cfg(windows)]
            gpu_tick: None,
            #[cfg(windows)]
            gpu_value: None,
        }
    }

    fn sample(&mut self, root: &Path, request: Request) -> SystemMetrics {
        let now = Instant::now();
        let same_request = self.last_request.as_ref() == Some(&request);
        if same_request
            && self
                .last_tick
                .is_some_and(|last| now.duration_since(last) < Duration::from_millis(750))
        {
            if let Some(cached) = &self.cached {
                return cached.clone();
            }
        }
        // First samples after a scope change or a hidden window only prime counters.
        let elapsed = self
            .last_tick
            .filter(|last| same_request && now.duration_since(*last) < Duration::from_secs(10))
            .map(|last| now.duration_since(last).as_secs_f64());
        let cpu = request.has(Metric::Cpu);
        let memory = request.has(Metric::Memory);
        let io = request.has(Metric::Network);
        if cpu {
            self.system.refresh_cpu_usage();
        }
        if memory {
            self.system.refresh_memory();
        }
        if request.launcher() && (cpu || memory || io || request.has(Metric::Gpu)) {
            if self
                .discovered
                .is_none_or(|last| now.duration_since(last) >= Duration::from_secs(10))
            {
                self.system.refresh_processes_specifics(
                    ProcessesToUpdate::All,
                    true,
                    ProcessRefreshKind::nothing().without_tasks(),
                );
                let processes: Vec<_> = self
                    .system
                    .processes()
                    .iter()
                    .map(|(pid, process)| {
                        (
                            *pid,
                            process.parent(),
                            process.name().to_string_lossy().into_owned(),
                        )
                    })
                    .collect();
                self.launcher_pids = launcher_tree(Pid::from_u32(std::process::id()), &processes);
                self.discovered = Some(now);
            }
            let pids: Vec<_> = self.launcher_pids.iter().copied().collect();
            let mut refresh = ProcessRefreshKind::nothing().without_tasks();
            if cpu {
                refresh = refresh.with_cpu();
            }
            if memory {
                refresh = refresh.with_memory();
            }
            if io {
                refresh = refresh.with_disk_usage();
            }
            self.system
                .refresh_processes_specifics(ProcessesToUpdate::Some(&pids), true, refresh);
        }
        let processes: Vec<_> = self
            .launcher_pids
            .iter()
            .filter_map(|pid| self.system.process(*pid))
            .collect();
        let launcher_cpu = processes
            .iter()
            .map(|process| process.cpu_usage())
            .sum::<f32>()
            / self.system.cpus().len().max(1) as f32;
        #[cfg(windows)]
        let gpu_usage = if request.has(Metric::Gpu) {
            if elapsed.is_none() {
                self.gpu = None;
                self.gpu_tick = None;
                self.gpu_value = None;
            }
            if self
                .gpu_tick
                .is_none_or(|last| now.duration_since(last) >= Duration::from_secs(5))
            {
                if self.gpu.is_none() {
                    self.gpu = GpuCounter::new();
                }
                self.gpu_value = self
                    .gpu
                    .as_mut()
                    .and_then(|gpu| gpu.sample(&self.launcher_pids));
                self.gpu_tick = Some(now);
            }
            if elapsed.is_some() {
                self.gpu_value
            } else {
                None
            }
        } else {
            self.gpu = None;
            self.gpu_tick = None;
            self.gpu_value = None;
            None
        };
        if io && request.system() {
            self.networks.refresh(true);
        }
        if request.has(Metric::Disk)
            && self
                .disk_refreshed
                .is_none_or(|last| now.duration_since(last) >= Duration::from_secs(30))
        {
            self.disks.refresh(true);
            self.disk_refreshed = Some(now);
        }
        let disk = self
            .disks
            .iter()
            .filter(|disk| root.starts_with(disk.mount_point()))
            .max_by_key(|disk| disk.mount_point().as_os_str().len());
        let result = SystemMetrics {
            cpu_percent: (cpu && request.system())
                .then(|| elapsed.map(|_| self.system.global_cpu_usage().clamp(0., 100.)))
                .flatten(),
            launcher_cpu_percent: (cpu && request.launcher())
                .then(|| elapsed.map(|_| launcher_cpu.clamp(0., 100.)))
                .flatten(),
            launcher_memory_bytes: if memory && request.launcher() {
                processes.iter().map(|process| process.memory()).sum()
            } else {
                0
            },
            #[cfg(windows)]
            launcher_gpu_percent: if request.launcher() {
                gpu_usage.map(|(_, launcher)| launcher)
            } else {
                None
            },
            #[cfg(not(windows))]
            launcher_gpu_percent: None,
            launcher_io_read_per_second: if io && request.launcher() {
                elapsed.map(|seconds| {
                    processes
                        .iter()
                        .map(|p| p.disk_usage().read_bytes)
                        .sum::<u64>() as f64
                        / seconds
                })
            } else {
                None
            },
            launcher_io_write_per_second: if io && request.launcher() {
                elapsed.map(|seconds| {
                    processes
                        .iter()
                        .map(|p| p.disk_usage().written_bytes)
                        .sum::<u64>() as f64
                        / seconds
                })
            } else {
                None
            },
            memory_used_bytes: if memory && request.system() {
                self.system.used_memory()
            } else {
                0
            },
            memory_total_bytes: if memory {
                self.system.total_memory()
            } else {
                0
            },
            network_received_per_second: if io && request.system() {
                elapsed.map(|seconds| {
                    self.networks
                        .iter()
                        .map(|(_, data)| data.received())
                        .sum::<u64>() as f64
                        / seconds
                })
            } else {
                None
            },
            network_sent_per_second: if io && request.system() {
                elapsed.map(|seconds| {
                    self.networks
                        .iter()
                        .map(|(_, data)| data.transmitted())
                        .sum::<u64>() as f64
                        / seconds
                })
            } else {
                None
            },
            #[cfg(windows)]
            gpu_percent: if request.system() {
                gpu_usage.map(|(system, _)| system)
            } else {
                None
            },
            #[cfg(not(windows))]
            gpu_percent: None,
            disk_available_bytes: if request.has(Metric::Disk) {
                disk.map(|disk| disk.available_space())
            } else {
                None
            },
            disk_total_bytes: if request.has(Metric::Disk) {
                disk.map(|disk| disk.total_space())
            } else {
                None
            },
        };
        self.last_tick = Some(now);
        self.last_request = Some(request);
        self.cached = Some(result.clone());
        result
    }
}

pub fn sample(
    root: &Path,
    scope: Option<MetricsScope>,
    metrics: Option<Vec<Metric>>,
) -> AppResult<SystemMetrics> {
    static SAMPLER: OnceLock<Mutex<Sampler>> = OnceLock::new();
    let mut sampler = SAMPLER
        .get_or_init(|| Mutex::new(Sampler::new()))
        .lock()
        .map_err(|_| AppError::Process("System metrics sampler is unavailable".into()))?;
    Ok(sampler.sample(
        root,
        Request {
            scope: scope.unwrap_or_default(),
            metrics: metrics.unwrap_or_else(|| {
                vec![
                    Metric::Cpu,
                    Metric::Memory,
                    Metric::Network,
                    Metric::Gpu,
                    Metric::Disk,
                ]
            }),
        },
    ))
}

// PDH owns the opaque handles. Keeping their addresses lets the sampler move
// between blocking workers; its mutex serializes every use of the query.
#[cfg(windows)]
struct GpuCounter {
    query: usize,
    counter: usize,
}

#[cfg(windows)]
impl GpuCounter {
    fn new() -> Option<Self> {
        use windows::Win32::System::Performance::*;
        use windows::core::{PCWSTR, w};
        let mut query = PDH_HQUERY::default();
        let mut counter = PDH_HCOUNTER::default();
        unsafe {
            if PdhOpenQueryW(PCWSTR::null(), 0, &mut query) != 0 {
                return None;
            }
            if PdhAddEnglishCounterW(
                query,
                w!("\\GPU Engine(*)\\Utilization Percentage"),
                0,
                &mut counter,
            ) != 0
            {
                PdhCloseQuery(query);
                return None;
            }
            PdhCollectQueryData(query);
        }
        Some(Self {
            query: query.0 as usize,
            counter: counter.0 as usize,
        })
    }

    fn sample(&mut self, launcher_pids: &std::collections::HashSet<Pid>) -> Option<(f64, f64)> {
        use windows::Win32::System::Performance::*;
        let query = PDH_HQUERY(self.query as *mut _);
        let counter = PDH_HCOUNTER(self.counter as *mut _);
        unsafe {
            if PdhCollectQueryData(query) != 0 {
                return None;
            }
            // Probe afresh on a size race: Windows can add GPU process instances.
            for _ in 0..3 {
                let mut bytes = 0;
                let mut count = 0;
                if PdhGetFormattedCounterArrayW(
                    counter,
                    PDH_FMT_DOUBLE,
                    &mut bytes,
                    &mut count,
                    None,
                ) != PDH_MORE_DATA
                    || bytes == 0
                    || bytes > 16 * 1024 * 1024
                {
                    return None;
                }
                // Both the item structs and their UTF-16 names live in this buffer.
                let mut buffer = vec![0_u64; (bytes as usize).div_ceil(8)];
                let items = buffer.as_mut_ptr().cast::<PDH_FMT_COUNTERVALUE_ITEM_W>();
                let status = PdhGetFormattedCounterArrayW(
                    counter,
                    PDH_FMT_DOUBLE,
                    &mut bytes,
                    &mut count,
                    Some(items),
                );
                if status == PDH_MORE_DATA {
                    continue;
                }
                if status != 0
                    || count as usize > buffer.len() * 8 / size_of::<PDH_FMT_COUNTERVALUE_ITEM_W>()
                {
                    return None;
                }
                let mut engines = std::collections::HashMap::<String, f64>::new();
                let mut launcher_engines = std::collections::HashMap::<String, f64>::new();
                for item in std::slice::from_raw_parts(items, count as usize) {
                    if ![PDH_CSTATUS_VALID_DATA, PDH_CSTATUS_NEW_DATA]
                        .contains(&item.FmtValue.CStatus)
                    {
                        continue;
                    }
                    let name = item.szName.to_string().ok()?;
                    let Some(index) = name.find("luid_") else {
                        continue;
                    };
                    let value = item.FmtValue.Anonymous.doubleValue;
                    if value.is_finite() {
                        *engines.entry(name[index..].to_owned()).or_default() += value.max(0.);
                        let pid = name
                            .strip_prefix("pid_")
                            .and_then(|name| name.split('_').next())
                            .and_then(|pid| pid.parse::<u32>().ok())
                            .map(Pid::from_u32);
                        if pid.is_some_and(|pid| launcher_pids.contains(&pid)) {
                            *launcher_engines
                                .entry(name[index..].to_owned())
                                .or_default() += value.max(0.);
                        }
                    }
                }
                // Sum processes on each engine, then report the busiest engine.
                return engines.values().copied().reduce(f64::max).map(|value| {
                    (
                        value.clamp(0., 100.),
                        launcher_engines
                            .values()
                            .copied()
                            .reduce(f64::max)
                            .unwrap_or(0.)
                            .clamp(0., 100.),
                    )
                });
            }
        }
        None
    }
}

#[cfg(windows)]
impl Drop for GpuCounter {
    fn drop(&mut self) {
        use windows::Win32::System::Performance::{PDH_HQUERY, PdhCloseQuery};
        unsafe {
            PdhCloseQuery(PDH_HQUERY(self.query as *mut _));
        }
    }
}

/// Logical size of files actually belonging to the portable launcher folder.
/// Includes the executable, resources, instances and rollback backups; skips links.
pub fn launcher_storage_bytes(root: &Path, force: bool) -> AppResult<u64> {
    static CACHE: OnceLock<Mutex<Option<(std::path::PathBuf, Instant, u64)>>> = OnceLock::new();
    let mut cache = CACHE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| AppError::Process("Launcher storage cache is unavailable".into()))?;
    if let Some((path, created, bytes)) = &*cache {
        if !force && path == root && created.elapsed() < Duration::from_secs(60) {
            return Ok(*bytes);
        }
    }
    let mut bytes = 0_u64;
    for entry in walkdir::WalkDir::new(root).follow_links(false) {
        let entry = entry.map_err(|error| AppError::Io(std::io::Error::other(error)))?;
        if entry.file_type().is_file() && !entry.file_type().is_symlink() {
            bytes = bytes.saturating_add(
                entry
                    .metadata()
                    .map_err(|error| AppError::Io(std::io::Error::other(error)))?
                    .len(),
            );
        }
    }
    *cache = Some((root.to_owned(), Instant::now(), bytes));
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launcher_tree_excludes_minecraft_and_other_apps_webviews() {
        let pid = Pid::from_u32;
        let tree = launcher_tree(
            pid(1),
            &[
                (pid(4), Some(pid(2)), "msedgewebview2.exe".into()),
                (pid(2), Some(pid(1)), "msedgewebview2.exe".into()),
                (pid(3), Some(pid(1)), "javaw.exe".into()),
                (pid(5), Some(pid(99)), "msedgewebview2.exe".into()),
                (pid(6), Some(pid(3)), "msedgewebview2.exe".into()),
            ],
        );
        assert_eq!(
            tree,
            std::collections::HashSet::from([pid(1), pid(2), pid(4)])
        );
    }

    #[test]
    fn scope_change_does_not_reuse_launcher_cache_or_unrequested_counters() {
        let mut sampler = Sampler::new();
        let root = Path::new(".");
        let launcher = sampler.sample(
            root,
            Request {
                scope: MetricsScope::Launcher,
                metrics: vec![Metric::Memory],
            },
        );
        assert!(launcher.launcher_memory_bytes > 0);
        assert!(launcher.launcher_cpu_percent.is_none());
        assert!(launcher.launcher_gpu_percent.is_none());
        assert!(launcher.network_received_per_second.is_none());
        assert!(sampler.networks.is_empty());
        assert!(sampler.disks.is_empty());
        let system = sampler.sample(
            root,
            Request {
                scope: MetricsScope::System,
                metrics: vec![Metric::Memory],
            },
        );
        assert_eq!(system.launcher_memory_bytes, 0);
        assert!(system.memory_used_bytes > 0);
        assert!(system.launcher_io_read_per_second.is_none());
    }

    #[test]
    fn storage_cache_refreshes_after_file_operations_when_forced() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("one"), [0; 8]).unwrap();
        assert_eq!(launcher_storage_bytes(root.path(), false).unwrap(), 8);
        std::fs::write(root.path().join("two"), [0; 12]).unwrap();
        assert_eq!(launcher_storage_bytes(root.path(), false).unwrap(), 8);
        assert_eq!(launcher_storage_bytes(root.path(), true).unwrap(), 20);
    }
}
