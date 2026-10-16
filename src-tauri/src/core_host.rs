use tauri::{AppHandle, Manager};
use slh_core::host::{CoreEvent, Host, WindowAction};
pub fn host(app: &AppHandle) -> Host {
    let app = app.clone();
    Host::new(move |event| {
        if let CoreEvent::Window(action) = event {
            if matches!(action, WindowAction::Quit) { app.exit(0); return Ok(()); }
            if let Some(window) = app.get_webview_window("main") {
                let result = match action { WindowAction::Quit => unreachable!(), WindowAction::Hide => window.hide(), WindowAction::Show => window.show(), WindowAction::Focus => window.set_focus() };
                result.map_err(|error| slh_core::error::AppError::Window(error.to_string()))?;
                if let Some(activity) = app.try_state::<crate::window_activity::Activity>() {
                    crate::window_activity::refresh(&window, &activity);
                }
            }
        } else {
            crate::ui_events::deliver(&app, event)?;
        }
        Ok(())
    })
}

#[cfg(test)]mod tests { #[test]fn allows_curseforge_images(){let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap(); let csp = config["app"]["security"]["csp"].as_str().unwrap(); let images = csp.split(';').find(|directive| directive.trim().starts_with("img-src ")).unwrap(); assert!(images.split_whitespace().any(|source| source == "https:" || source == "https://media.forgecdn.net"));} }
