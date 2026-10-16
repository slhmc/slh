//! Background lifecycle; Windows COM stays inside the platform adapter.
use std::sync::{Arc, atomic::{AtomicBool, AtomicU64, Ordering}};
use tauri::Manager;
#[derive(Clone)]
pub struct Activity { pub active: Arc<AtomicBool>, generation: Arc<AtomicU64>, suspensions: Arc<AtomicU64> }
impl Default for Activity {
    fn default() -> Self { Self { active: Arc::new(AtomicBool::new(true)), generation: Arc::new(AtomicU64::new(0)), suspensions: Arc::new(AtomicU64::new(0)) } }
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityStatus { active: bool, successful_suspensions: u64 }
#[tauri::command]
pub fn get_window_activity(activity: tauri::State<'_, Activity>) -> ActivityStatus {
    ActivityStatus { active: activity.active.load(Ordering::Acquire), successful_suspensions: activity.suspensions.load(Ordering::Acquire) }
}
#[tauri::command]
pub fn ui_paused(window: tauri::WebviewWindow, activity: tauri::State<'_, Activity>, generation: u64) {
    if activity.current_hidden(generation) {
        platform(&window, false, true);
    }
}
impl Activity {
    fn current_hidden(&self, generation: u64) -> bool {
        !self.active.load(Ordering::Acquire) && self.generation.load(Ordering::Acquire) == generation
    }
}
#[tauri::command]
pub fn scenes_released(window: tauri::WebviewWindow, activity: tauri::State<'_, Activity>, generation: u64) {
    if activity.current_hidden(generation) { platform(&window, false, true); }
}
pub fn attach(window: &tauri::WebviewWindow) {
    let current = window.clone();
    let activity = window.state::<Activity>().inner().clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Focused(_)) { refresh(&current, &activity); }
    });
}
pub fn refresh(window: &tauri::WebviewWindow, activity: &Activity) {
        let active = window.is_visible().unwrap_or(true) && !window.is_minimized().unwrap_or(false);
        if activity.active.swap(active, Ordering::AcqRel) == active { return; }
        let generation = activity.generation.fetch_add(1, Ordering::AcqRel) + 1;
        if active { platform(window, true, false); }
        let pause = if active { String::new() } else { format!("window.dispatchEvent(new CustomEvent('slh-ui-pause',{{detail:{generation}}}));") };
        let _ = window.eval(&format!("window.dispatchEvent(new CustomEvent('slh-native-activity',{{detail:{active}}}));{pause}"));
        let view: &tauri::Webview = window.as_ref();
        let result = if active { view.show() } else { view.hide() };
        if let Err(error) = result { tracing::warn!(%error, "webview visibility update failed"); }
        if active { return; }
        platform(window, false, false);
        suspend_after_pause(window, activity, generation);
}

fn suspend_after_pause(window: &tauri::WebviewWindow, activity: &Activity, generation: u64) {
    let current = window.clone();
    let activity = activity.clone();
    tauri::async_runtime::spawn(async move {
        // Fallback if the UI cannot acknowledge its stopped animations.
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        if activity.current_hidden(generation) { platform(&current, false, true); }
    });
}

#[cfg(not(windows))]
fn platform(_window: &tauri::WebviewWindow, _active: bool, _suspend: bool) {}
#[cfg(windows)]
fn platform(window: &tauri::WebviewWindow, active: bool, suspend: bool) {
    use windows_core_webview::Interface;
    use webview2_com::{TrySuspendCompletedHandler, Microsoft::Web::WebView2::Win32::*};
    let activity = window.state::<Activity>().inner().clone();
    let generation = activity.generation.load(Ordering::Acquire);
    if let Err(error) = window.with_webview(move |view| unsafe {
        if activity.active.load(Ordering::Acquire) != active || activity.generation.load(Ordering::Acquire) != generation { return; }
        let Ok(webview) = view.controller().CoreWebView2() else { return; };
        // Use suspend/resume rather than mixing it with MemoryUsageTargetLevel,
        // as recommended by WebView2's lifecycle contract.
        if let Ok(lifecycle) = webview.cast::<ICoreWebView2_3>() {
            if active {
                if let Err(error) = lifecycle.Resume() { tracing::warn!(%error, "webview resume failed"); }
            } else if suspend {
                let activity = activity.clone();
                let lifecycle_on_completion = lifecycle.clone();
                let callback = TrySuspendCompletedHandler::create(Box::new(move |result, success| {
                    if result.is_err() || !success { tracing::debug!(?result, success, "webview could not suspend"); }
                    if success && !activity.current_hidden(generation) {
                        // A delayed completion must not leave a restored window paused.
                        let _ = lifecycle_on_completion.Resume();
                    } else if success {
                        activity.suspensions.fetch_add(1, Ordering::AcqRel);
                    }
                    Ok(())
                }));
                if let Err(error) = lifecycle.TrySuspend(&callback) { tracing::debug!(%error, "webview suspend unavailable"); }
            }
        }
    }) { tracing::warn!(%error, "webview lifecycle dispatch failed"); }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stale_release_cannot_suspend_a_restored_window() {
        let activity = Activity::default();
        activity.active.store(false, Ordering::Release);
        activity.generation.store(1, Ordering::Release);
        assert!(activity.current_hidden(1));
        activity.active.store(true, Ordering::Release);
        assert!(!activity.current_hidden(1));
        activity.active.store(false, Ordering::Release);
        activity.generation.store(3, Ordering::Release);
        assert!(!activity.current_hidden(1));
        assert!(activity.current_hidden(3));
    }
}
