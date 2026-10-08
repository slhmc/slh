//! Background lifecycle; Windows COM stays inside the platform adapter.
use std::sync::{Arc, atomic::{AtomicBool, AtomicU64, Ordering}};
use tauri::Manager;
#[derive(Clone)]
pub struct Activity { pub active: Arc<AtomicBool>, generation: Arc<AtomicU64> }
impl Default for Activity {
    fn default() -> Self { Self { active: Arc::new(AtomicBool::new(true)), generation: Arc::new(AtomicU64::new(0)) } }
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
        let _ = window.eval(&format!("window.dispatchEvent(new CustomEvent('slh-native-activity',{{detail:{active}}}));"));
        let view: &tauri::Webview = window.as_ref();
        let result = if active { view.show() } else { view.hide() };
        if let Err(error) = result { tracing::warn!(%error, "webview visibility update failed"); }
        if active { return; }
        platform(window, false, false);
        let current = window.clone();
        let activity = activity.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            if !activity.current_hidden(generation) { return; }
            let _ = current.eval(&format!("window.dispatchEvent(new CustomEvent('slh-release-scenes',{{detail:{generation}}}));"));
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
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
        if let Ok(memory) = webview.cast::<ICoreWebView2_19>() {
            let level = if active { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL } else { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW };
            if let Err(error) = memory.SetMemoryUsageTargetLevel(level) { tracing::debug!(%error, "webview memory target unavailable"); }
        }
        if let Ok(lifecycle) = webview.cast::<ICoreWebView2_3>() {
            if active {
                if let Err(error) = lifecycle.Resume() { tracing::warn!(%error, "webview resume failed"); }
            } else if suspend {
                let callback = TrySuspendCompletedHandler::create(Box::new(|result, success| {
                    if result.is_err() || !success { tracing::debug!(?result, success, "webview could not suspend"); }
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
