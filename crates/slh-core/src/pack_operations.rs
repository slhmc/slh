//! Cancellation owns the complete pack future, including its active downloads.
use std::{collections::HashMap, future::Future, sync::{Arc, Mutex, OnceLock}};
use futures_util::future::{AbortHandle, Abortable};
use crate::{error::{AppError, AppResult}, host::{CoreEvent, Host}, models::{Instance, ProgressEvent}, state::AppState};

static RUNNING: OnceLock<Mutex<HashMap<String, AbortHandle>>> = OnceLock::new();
fn running() -> &'static Mutex<HashMap<String, AbortHandle>> {
    RUNNING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// A cancelled archive request has no instance yet. Retire its download row
/// when its future is dropped so the Downloads settings do not remain busy.
pub(crate) struct ArchiveDownloadGuard(pub sqlx::SqlitePool, pub String);
impl Drop for ArchiveDownloadGuard {
    fn drop(&mut self) {
        let database = self.0.clone();
        let id = self.1.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let _ = sqlx::query("UPDATE downloads SET status='failed', error_message='Installation cancelled' WHERE id=? AND status='running'")
                    .bind(id).execute(&database).await;
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    struct Dropped(Arc<AtomicBool>);
    impl Drop for Dropped { fn drop(&mut self) { self.0.store(true, Ordering::SeqCst); } }

    #[tokio::test]
    async fn cancellation_drops_installation_and_releases_the_instance() {
        let directory = tempfile::tempdir().unwrap();
        let paths = crate::portable::PortablePaths::from_executable(
            &directory.path().join("SLH.exe"), Some(directory.path().to_path_buf()),
        ).unwrap();
        let state = AppState::initialize_isolated_at(paths).await.unwrap();
        let instance = crate::instances::create_instance(&state.database, &state.paths, crate::models::CreateInstanceRequest {
            name: "Cancelled pack".into(), group_id: None, minecraft_version: "1.20.1".into(),
            loader_type: "vanilla".into(), loader_version: None, java_path: None,
            memory_min_mb: 512, memory_max_mb: 4096, icon_key: None, icon_background: None,
            icon_foreground: None, bedrock_profile_mode: None,
        }).await.unwrap();
        sqlx::query("UPDATE instances SET status='installing' WHERE id=?").bind(&instance.id).execute(&state.database).await.unwrap();
        let destination = format!("{}{}test.jar", instance.game_dir, std::path::MAIN_SEPARATOR);
        sqlx::query("INSERT INTO downloads(id, source, url, destination, status) VALUES ('test', 'curseforge', 'https://example.com/test.jar', ?, 'running')")
            .bind(destination).execute(&state.database).await.unwrap();
        let dropped = Arc::new(AtomicBool::new(false));
        let dropped_future = dropped.clone();
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        let host = Host::new(move |event| { captured.lock().unwrap().push(event); Ok(()) });
        let (ready, started) = tokio::sync::oneshot::channel();
        let cancel_task = async { started.await.unwrap(); assert!(cancel("cancel-test")); assert!(!cancel("another-pack")); };
        let install = run(&host, &state, "cancel-test".into(), |host| async move {
            let _drop = Dropped(dropped_future);
            host.send(CoreEvent::Progress(ProgressEvent {
                operation_id: "internal-id".into(), instance_id: Some(instance.id), operation: "import".into(),
                stage: "pack-files".into(), message: "Downloading".into(), completed: 0, total: Some(1),
                downloaded_bytes: None, total_bytes: None,
            })).unwrap();
            ready.send(()).unwrap();
            std::future::pending::<AppResult<Instance>>().await
        });
        let (result, _) = tokio::join!(install, cancel_task);
        assert!(matches!(result, Err(AppError::Cancelled)));
        assert!(dropped.load(Ordering::SeqCst));
        assert!(!cancel("cancel-test"));
        let status: String = sqlx::query_scalar("SELECT status FROM instances").fetch_one(&state.database).await.unwrap();
        assert_eq!(status, "error");
        let status: String = sqlx::query_scalar("SELECT status FROM downloads WHERE id='test'").fetch_one(&state.database).await.unwrap();
        assert_eq!(status, "failed");
        assert!(events.lock().unwrap().iter().any(|event| matches!(event, CoreEvent::Progress(p) if p.operation_id == "cancel-test" && p.stage == "cancelled")));
    }
}

pub fn cancel(key: &str) -> bool {
    let guard = running().lock().unwrap_or_else(|error| error.into_inner());
    if let Some(handle) = guard.get(key) { handle.abort(); true } else { false }
}

struct Registration(String);
impl Drop for Registration {
    fn drop(&mut self) {
        running().lock().unwrap_or_else(|error| error.into_inner()).remove(&self.0);
    }
}

pub async fn run<F, Fut>(host: &Host, state: &AppState, key: String, install: F) -> AppResult<Instance>
where F: FnOnce(Host) -> Fut, Fut: Future<Output = AppResult<Instance>> {
    let (handle, registration) = AbortHandle::new_pair();
    {
        let mut guard = running().lock().unwrap_or_else(|error| error.into_inner());
        if guard.contains_key(&key) { return Err(AppError::Conflict("This modpack is already being installed".into())); }
        guard.insert(key.clone(), handle);
    }
    let _registration = Registration(key.clone());
    let instance_id = Arc::new(Mutex::new(None::<String>));
    let tracked_id = instance_id.clone();
    let destination = host.clone();
    let progress_key = key.clone();
    let tracked = Host::new(move |mut event| {
        if let CoreEvent::Progress(progress) = &mut event {
            if let Some(id) = &progress.instance_id {
                *tracked_id.lock().unwrap_or_else(|error| error.into_inner()) = Some(id.clone());
            }
            progress.operation_id = progress_key.clone();
        }
        destination.send(event)
    });
    match Abortable::new(install(tracked), registration).await {
        Ok(result) => result,
        Err(_) => {
            let id = instance_id.lock().unwrap_or_else(|error| error.into_inner()).clone();
            if let Some(id) = &id {
                // Keep verified files for a deliberate retry, but never report this pack as ready.
                sqlx::query("UPDATE instances SET status = 'error' WHERE id = ? AND status NOT IN ('running', 'launching')")
                    .bind(id).execute(&state.database).await?;
                let instance = crate::database::instance(&state.database, id).await?;
                let prefix = format!("{}{}", instance.game_dir, std::path::MAIN_SEPARATOR);
                sqlx::query("UPDATE downloads SET status='failed', error_message='Installation cancelled' WHERE status IN ('running', 'queued') AND substr(destination, 1, length(?)) = ?")
                    .bind(&prefix).bind(&prefix).execute(&state.database).await?;
            }
            let _ = host.send(CoreEvent::Progress(ProgressEvent {
                operation_id: key, instance_id: id, operation: "import".into(), stage: "cancelled".into(),
                message: "Installation cancelled".into(), completed: 0, total: None,
                downloaded_bytes: None, total_bytes: None,
            }));
            Err(AppError::Cancelled)
        }
    }
}
