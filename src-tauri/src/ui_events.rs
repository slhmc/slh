//! Bounded UI state survives a suspended webview. Full console logs stay on disk.
use std::{collections::{HashMap, VecDeque}, sync::Mutex};
use serde::Serialize;
use slh_core::{host::CoreEvent, models::ProgressEvent};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Envelope { pub sequence: u64, pub name: String, pub payload: serde_json::Value, pub notified: bool }
#[derive(Default)]
struct Book {
    sequence: u64,
    active: HashMap<String, Envelope>,
    recent: VecDeque<Envelope>,
    pending: Vec<Envelope>,
    scheduled: bool,
}
#[derive(Default)]
pub struct UiEvents(Mutex<Book>);
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot { pub events: Vec<Envelope>, pub sequence: u64 }

fn terminal(event: &ProgressEvent) -> bool {
    event.stage == "complete" || event.stage == "failed"
        || (event.operation == "content" && event.stage == "install"
            && event.total.is_some_and(|total| total > 0 && event.completed >= total))
}
fn active(app: &AppHandle) -> bool {
    app.try_state::<crate::window_activity::Activity>()
        .is_none_or(|state| state.active.load(std::sync::atomic::Ordering::Acquire))
}
fn emit(app: &AppHandle, event: &Envelope) {
    // Existing event consumers keep their original contract.
    if let Err(error) = app.emit(&event.name, &event.payload) { tracing::warn!(%error, "UI event failed"); }
    if event.name != "slh-console-line" {
        let _ = app.emit("slh-ui-event", event);
    }
}
fn flush(app: &AppHandle, book: &mut Book) {
    if active(app) {
        for event in book.pending.drain(..) { emit(app, &event); }
    } else { book.pending.clear(); }
}
pub fn deliver(app: &AppHandle, event: CoreEvent) -> slh_core::error::AppResult<()> {
    if matches!(event, CoreEvent::Console(_)) && !active(app) { return Ok(()); }
    let Some((name, payload)) = event.wire()? else { return Ok(()); };
    let state = app.state::<UiEvents>();
    let mut book = state.0.lock().unwrap_or_else(|poison| poison.into_inner());
    if matches!(event, CoreEvent::Console(_)) {
        if active(app) { let _ = app.emit(name, payload); }
        return Ok(());
    }
    book.sequence += 1;
    let envelope = Envelope { sequence: book.sequence, name: name.into(), payload, notified: false };
    let progress = if let CoreEvent::Progress(ref progress) = event { Some(progress) } else { None };
    let coalesced = progress.is_some_and(|progress| !terminal(progress)
        && book.active.get(&progress.operation_id).is_some_and(|previous| previous.payload["stage"] == progress.stage));
    if let Some(progress) = progress {
        if terminal(progress) { book.active.remove(&progress.operation_id); }
        else { book.active.insert(progress.operation_id.clone(), envelope.clone()); }
    }
    if progress.is_none_or(terminal) {
        book.recent.push_back(envelope.clone());
        while book.recent.len() > 64 { book.recent.pop_front(); }
    }
    if !active(app) {
        book.pending.clear();
        if !coalesced { background_notification(app, &event, envelope.sequence); }
        return Ok(());
    }
    if coalesced {
        let id = progress.unwrap().operation_id.as_str();
        book.pending.retain(|item| item.payload["operationId"].as_str() != Some(id));
        book.pending.push(envelope);
        if !book.scheduled {
            book.scheduled = true;
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                let state = app.state::<UiEvents>();
                let mut book = state.0.lock().unwrap_or_else(|poison| poison.into_inner());
                flush(&app, &mut book);
                book.scheduled = false;
            });
        }
    } else { flush(app, &mut book); emit(app, &envelope); }
    Ok(())
}
fn background_notification(app: &AppHandle, event: &CoreEvent, sequence: u64) {
    let (title, error) = match event {
        CoreEvent::Progress(progress) if progress.stage == "complete" => (match progress.operation.as_str() { "java" => "Java runtime ready", "install" => "Installation complete", _ => "Instance ready" }, false),
        CoreEvent::Progress(progress) if progress.stage == "failed" => ("Operation failed", true),
        CoreEvent::Launch(launch) if launch.state == "crashed" => ("Minecraft crashed", true),
        CoreEvent::SyncError(_) => ("Sync failed", true),
        _ => return,
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        use tauri_plugin_notification::NotificationExt;
        let state = app.state::<crate::state::AppState>();
        let Ok(settings) = crate::database::setting(&state.database, "notifications").await else { return; };
        if active(&app) || settings["enabled"] == false || settings["destination"] != "windows"
            || settings[if error { "showErrors" } else { "showSuccess" }] == false { return; }
        let general = crate::database::setting(&state.database, "general").await.unwrap_or_default();
        let locale = crate::localization::load_locale(&state.paths, general["language"].as_str().unwrap_or("en-US")).unwrap_or_default();
        let title = locale["legacy"][title].as_str().unwrap_or(title);
        #[cfg(windows)]
        if let Err(error) = crate::windows_notifications::ensure_start_menu_shortcut() { tracing::warn!(%error, "background notification setup failed"); return; }
        // Never forward arbitrary operation messages containing paths or tokens.
        if let Err(error) = app.notification().builder().title(title).show() { tracing::warn!(%error, "background notification failed"); return; }
        let events = app.state::<UiEvents>();
        let mut book = events.0.lock().unwrap_or_else(|poison| poison.into_inner());
        if let Some(event) = book.recent.iter_mut().find(|event| event.sequence == sequence) { event.notified = true; }
    });
}
#[tauri::command]
pub fn get_ui_snapshot(state: tauri::State<'_, UiEvents>) -> Snapshot {
    let book = state.0.lock().unwrap_or_else(|poison| poison.into_inner());
    let mut events: Vec<_> = book.recent.iter().chain(book.active.values()).cloned().collect();
    events.sort_by_key(|event| event.sequence);
    Snapshot { events, sequence: book.sequence }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn content_install_completion_is_terminal_but_metadata_is_not() {
        let mut event = ProgressEvent { operation_id: "a".into(), instance_id: None,
            operation: "content".into(), stage: "metadata".into(), message: String::new(),
            completed: 1, total: Some(1), downloaded_bytes: None, total_bytes: None };
        assert!(!terminal(&event));
        event.stage = "install".into(); assert!(terminal(&event));
        event.total = Some(0); assert!(!terminal(&event));
        event.stage = "failed".into(); assert!(terminal(&event));
    }
}
