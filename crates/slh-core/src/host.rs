//! UI-neutral delivery of launcher events and window requests.
use crate::{
    error::{AppError, AppResult},
    models::{ConsoleLineEvent, ProgressEvent},
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EventKind {
    OperationProgress,
    LaunchState,
    ConsoleLine,
    SyncError,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchState {
    pub instance_id: String,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub launch_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<i64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncError {
    pub instance_id: String,
    pub message: String,
}
#[derive(Clone, Copy, Debug)]
pub enum WindowAction {
    Hide,
    Show,
    Focus,
}
#[derive(Clone, Debug)]
pub enum CoreEvent {
    Progress(ProgressEvent),
    Launch(LaunchState),
    Console(ConsoleLineEvent),
    SyncError(SyncError),
    Window(WindowAction),
}
impl CoreEvent {
    pub fn wire(&self) -> AppResult<Option<(&'static str, serde_json::Value)>> {
        Ok(Some(match self {
            Self::Progress(v) => ("slh-operation-progress", serde_json::to_value(v)?),
            Self::Launch(v) => ("slh-launch-state", serde_json::to_value(v)?),
            Self::Console(v) => ("slh-console-line", serde_json::to_value(v)?),
            Self::SyncError(v) => ("slh-sync-error", serde_json::to_value(v)?),
            Self::Window(_) => return Ok(None),
        }))
    }
}
/// Common progress/log payloads move directly into the typed event, without JSON round trips.
pub trait EventPayload {
    fn into_event(self, kind: EventKind) -> AppResult<CoreEvent>;
}
impl EventPayload for ProgressEvent {
    fn into_event(self, kind: EventKind) -> AppResult<CoreEvent> {
        if kind != EventKind::OperationProgress {
            return Err(AppError::InvalidInput("Wrong event kind".into()));
        }
        Ok(CoreEvent::Progress(self))
    }
}
impl EventPayload for ConsoleLineEvent {
    fn into_event(self, kind: EventKind) -> AppResult<CoreEvent> {
        if kind != EventKind::ConsoleLine {
            return Err(AppError::InvalidInput("Wrong event kind".into()));
        }
        Ok(CoreEvent::Console(self))
    }
}
impl EventPayload for serde_json::Value {
    fn into_event(self, kind: EventKind) -> AppResult<CoreEvent> {
        Ok(match kind {
            EventKind::OperationProgress => CoreEvent::Progress(serde_json::from_value(self)?),
            EventKind::LaunchState => CoreEvent::Launch(serde_json::from_value(self)?),
            EventKind::ConsoleLine => CoreEvent::Console(serde_json::from_value(self)?),
            EventKind::SyncError => CoreEvent::SyncError(serde_json::from_value(self)?),
        })
    }
}
#[derive(Clone)]
pub struct Host(Arc<dyn Fn(CoreEvent) -> AppResult<()> + Send + Sync>);
impl Host {
    pub fn new(deliver: impl Fn(CoreEvent) -> AppResult<()> + Send + Sync + 'static) -> Self {
        Self(Arc::new(deliver))
    }
    pub fn silent() -> Self {
        Self::new(|_| Ok(()))
    }
    pub fn emit(&self, kind: EventKind, value: impl EventPayload) -> AppResult<()> {
        (self.0)(value.into_event(kind)?)
    }
    pub fn send(&self, event: CoreEvent) -> AppResult<()> {
        (self.0)(event)
    }
    pub fn window(&self) -> Option<HostWindow> {
        Some(HostWindow(self.clone()))
    }
    pub fn opener(&self) -> NativeOpener {
        NativeOpener
    }
}
pub struct HostWindow(Host);
impl HostWindow {
    pub fn hide(&self) -> AppResult<()> {
        (self.0.0)(CoreEvent::Window(WindowAction::Hide))
    }
    pub fn show(&self) -> AppResult<()> {
        (self.0.0)(CoreEvent::Window(WindowAction::Show))
    }
    pub fn set_focus(&self) -> AppResult<()> {
        (self.0.0)(CoreEvent::Window(WindowAction::Focus))
    }
}
pub struct NativeOpener;
impl NativeOpener {
    pub fn open_url(&self, url: &str, _application: Option<&str>) -> AppResult<()> {
        if url::Url::parse(url).is_err() {
            return Err(AppError::InvalidInput("Invalid URL".into()));
        }
        open::that(url).map_err(AppError::Io)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn events_preserve_existing_frontend_contract() {
        let got = Arc::new(std::sync::Mutex::new(None));
        let output = got.clone();
        let host = Host::new(move |event| {
            *output.lock().unwrap() = event.wire()?;
            Ok(())
        });
        let payload =
            serde_json::json!({"instanceId":"test","state":"running","launchId":"launch"});
        host.emit(EventKind::LaunchState, payload.clone()).unwrap();
        let event = got.lock().unwrap().clone().unwrap();
        assert_eq!(event.0, "slh-launch-state");
        assert_eq!(event.1, payload);
    }
    #[test]
    fn window_requests_do_not_become_frontend_events() {
        assert!(
            CoreEvent::Window(WindowAction::Hide)
                .wire()
                .unwrap()
                .is_none()
        );
    }
}
