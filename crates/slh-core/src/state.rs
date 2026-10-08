use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use reqwest::header::{HeaderMap, HeaderValue, USER_AGENT};
use sqlx::SqlitePool;
use tokio::sync::{Mutex, RwLock};
use tracing_appender::non_blocking::WorkerGuard;

use crate::database;
use crate::error::{AppError, AppResult};
use crate::logging;
use crate::portable::PortablePaths;

fn locale_for_system_language(
    available: &[crate::models::LocaleDescriptor],
    system_locale: Option<&str>,
) -> String {
    let english = available
        .iter()
        .find(|locale| locale.code.eq_ignore_ascii_case("en-US"))
        .map(|locale| locale.code.clone())
        .unwrap_or_else(|| "en-US".to_owned());
    let Some(system_locale) = system_locale else {
        return english;
    };
    if let Some(locale) = available
        .iter()
        .find(|locale| locale.code.eq_ignore_ascii_case(system_locale))
    {
        return locale.code.clone();
    }
    let language = system_locale.split(['-', '_']).next().unwrap_or_default();
    available
        .iter()
        .find(|locale| {
            locale
                .code
                .split('-')
                .next()
                .is_some_and(|candidate| candidate.eq_ignore_ascii_case(language))
        })
        .map(|locale| locale.code.clone())
        .unwrap_or(english)
}

#[cfg(windows)]
fn system_locale_name() -> Option<String> {
    use windows::Win32::Globalization::GetUserDefaultLocaleName;

    let mut buffer = [0_u16; 85];
    let count = unsafe { GetUserDefaultLocaleName(&mut buffer) };
    if count <= 1 {
        return None;
    }
    String::from_utf16(&buffer[..count as usize - 1]).ok()
}

#[cfg(not(windows))]
fn system_locale_name() -> Option<String> {
    std::env::var("LANG")
        .ok()
        .and_then(|value| value.split('.').next().map(str::to_owned))
}

async fn set_first_run_system_language(
    database: &SqlitePool,
    paths: &PortablePaths,
) -> AppResult<()> {
    let onboarding = database::setting(database, "onboarding").await?;
    if onboarding
        .get("completed")
        .and_then(serde_json::Value::as_bool)
        == Some(true)
    {
        return Ok(());
    }
    let available = crate::localization::list_locales(paths)?;
    let selected = locale_for_system_language(&available, system_locale_name().as_deref());
    let mut general = database::setting(database, "general").await?;
    if general.get("language").and_then(serde_json::Value::as_str) == Some(selected.as_str()) {
        return Ok(());
    }
    if let Some(values) = general.as_object_mut() {
        values.insert("language".to_owned(), serde_json::Value::String(selected));
        database::set_setting(database, "general", &general).await?;
    }
    Ok(())
}

#[derive(Clone)]
pub struct AppState {
    pub paths: PortablePaths,
    pub database: SqlitePool,
    pub http: reqwest::Client,
    pub running_instances: Arc<RwLock<HashSet<String>>>,
    /// OS process IDs for the Java process belonging to each running instance.
    /// Kept separately from `running_instances` so a kill request can target
    /// the process tree without taking ownership away from the launch task.
    pub launch_processes: Arc<RwLock<HashMap<String, u32>>>,
    pub kill_requested: Arc<RwLock<HashSet<String>>>,
    pub curseforge_api_key: Arc<RwLock<Option<String>>>,
    pub curseforge_key_source: Arc<RwLock<String>>,
    pub java_scan_cancelled: Arc<AtomicBool>,
    /// A Bedrock process owns the user's registered LocalState. Keep this
    /// lock for the complete launch lifetime so two profiles can never swap
    /// the same Windows package data concurrently.
    pub bedrock_profile_lock: Arc<Mutex<()>>,
    _log_guard: Arc<WorkerGuard>,
}

impl AppState {
    pub async fn initialize() -> AppResult<Self> {
        Self::initialize_at(PortablePaths::resolve()?).await
    }

    pub async fn initialize_at(paths: PortablePaths) -> AppResult<Self> {
        Self::initialize_with_external_recovery(paths, true).await
    }
    pub async fn initialize_isolated_at(paths: PortablePaths) -> AppResult<Self> {
        Self::initialize_with_external_recovery(paths, false).await
    }
    async fn initialize_with_external_recovery(
        paths: PortablePaths,
        external_recovery: bool,
    ) -> AppResult<Self> {
        paths.initialize()?;
        let log_guard = Arc::new(logging::initialize(&paths)?);
        tracing::info!(portable_root = %paths.root.display(), "initializing SLH");

        let database = database::connect(&paths).await?;
        set_first_run_system_language(&database, &paths).await?;
        // A child Java process cannot be awaited after SLH itself is terminated.
        // Treat any persisted running state as interrupted on the next startup so a
        // closed game never remains locked in the library forever.
        let recovered_processes = crate::database::recover_interrupted_launches(&database).await?;
        // Installation tasks live in this process as well. A force-close or
        // crash can otherwise leave an instance permanently stuck on the
        // Install button even though no worker is still downloading it.
        crate::database::recover_interrupted_installations(&database).await?;
        crate::instances::migrate_legacy_instance_folders(&database, &paths).await?;
        let mut headers = HeaderMap::new();
        headers.insert(
            USER_AGENT,
            HeaderValue::from_static("SLH/0.1.2 (portable Minecraft launcher)"),
        );
        let http = reqwest::Client::builder()
            .default_headers(headers)
            .connect_timeout(std::time::Duration::from_secs(15))
            .timeout(std::time::Duration::from_secs(60))
            // Keep connections warm while a pack fans out to Mojang/Modrinth
            // and CurseForge. This avoids a new TCP/TLS handshake for every
            // small library, asset or metadata request.
            .pool_max_idle_per_host(32)
            .tcp_nodelay(true)
            .https_only(true)
            .build()
            .map_err(AppError::Network)?;

        let environment_key = crate::content::curseforge::environment_api_key();
        let (curseforge_api_key, curseforge_key_source) = if let Some(key) = environment_key {
            (Some(key), "environment".to_owned())
        } else {
            match crate::content::curseforge::load_portable_key(&paths) {
                Ok(Some(key)) => (Some(key), "portable".to_owned()),
                Ok(None) => (None, "none".to_owned()),
                Err(error) => {
                    tracing::warn!(%error, "stored CurseForge API key is unavailable on this Windows profile");
                    (None, "unavailable".to_owned())
                }
            }
        };

        let running_instances = recovered_processes
            .iter()
            .map(|(instance_id, _)| instance_id.clone())
            .collect();
        let launch_processes = recovered_processes.into_iter().collect();
        let state = Self {
            paths,
            database,
            http,
            running_instances: Arc::new(RwLock::new(running_instances)),
            launch_processes: Arc::new(RwLock::new(launch_processes)),
            kill_requested: Arc::new(RwLock::new(HashSet::new())),
            curseforge_api_key: Arc::new(RwLock::new(curseforge_api_key)),
            curseforge_key_source: Arc::new(RwLock::new(curseforge_key_source)),
            java_scan_cancelled: Arc::new(AtomicBool::new(false)),
            bedrock_profile_lock: Arc::new(Mutex::new(())),
            _log_guard: log_guard,
        };
        if external_recovery
            && let Err(error) =
                crate::minecraft::bedrock_runtime::recover_profile_journals(&state.paths)
        {
            tracing::error!(%error, "Bedrock profile recovery failed; leaving the journal for manual recovery");
        }
        Ok(state)
    }
}
