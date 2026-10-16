mod core_host;
mod ui_events;
mod updates;
mod accounts;
mod archives;
mod commands;
mod console;
mod content;
mod database;
mod error;
mod instances;
mod loaders;
mod localization;
mod minecraft;
mod models;
mod portable;
mod servers;
mod settings;
mod state;
mod storage;
mod system_metrics;
mod sync;
mod version_migration;
mod window_state;
mod window_activity;
mod webview_runtime;
mod webview_profile;
mod windows_notifications;

use tauri::Manager;
#[cfg(windows)]
use tauri_plugin_prevent_default::PlatformOptions;

fn prevent_default() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    let builder = tauri_plugin_prevent_default::Builder::new();
    #[cfg(windows)]
    let builder = builder.platform(PlatformOptions::new()
        .browser_accelerator_keys(false).built_in_error_page(false)
        .default_context_menus(false).default_script_dialogs(false)
        .dev_tools(false).general_autofill(false).password_autosave(false)
        .swipe_navigation(false).zoom_control(false));
    builder.build()
}

fn startup_instance_argument() -> Option<String> {
    instance_argument(std::env::args().skip(1))
}

fn instance_argument(args: impl IntoIterator<Item = String>) -> Option<String> {
    let mut args = args.into_iter();
    while let Some(argument) = args.next() {
        if argument == "--launch-instance" || argument == "--instance" {
            return args.next().filter(|value| !value.trim().is_empty());
        }
    }
    None
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    windows_notifications::repair_existing_shortcut();
    #[cfg(windows)]
    if !webview_runtime::ensure_available() { return; }

    let mut context = tauri::generate_context!();
    // Absolute per-installation browser paths require the runtime window builder.
    for window in &mut context.config_mut().app.windows {
        window.create = false;
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(instance_id) = instance_argument(args) {
                if let Some(state) = app.try_state::<state::AppState>() {
                    let state = state.inner().clone();
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(error) = crate::minecraft::launcher::launch_instance(
                            &core_host::host(&app), &state, &instance_id, None,
                        ).await {
                            tracing::error!(%error, %instance_id, "desktop shortcut launch failed");
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    });
                    return;
                }
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(prevent_default())
        .setup(|app| {
            let state = tauri::async_runtime::block_on(async {
                let mut paths = crate::portable::PortablePaths::resolve()?;
                paths.bundled_resources = app.path().resource_dir().ok();
                if std::env::args().any(|arg| arg == "--isolated") {
                    if !std::env::args().any(|arg| arg == "--data-dir") {
                        return Err(crate::error::AppError::Unavailable("--isolated requires an explicit --data-dir copy".into()));
                    }
                    state::AppState::initialize_isolated_at(paths).await
                } else { state::AppState::initialize_at(paths).await }
            })?;
            app.manage(window_activity::Activity::default());
            app.manage(ui_events::UiEvents::default());
            let updater = tauri_plugin_updater::Builder::new();
            #[cfg(windows)]
            let updater = updater.installer_arg(format!("/D={}", state.paths.executable_dir.display()));
            app.handle().plugin(updater.build())?;
            app.manage(state.clone());
            let config = app.config().app.windows.iter().find(|window| window.label == "main")
                .ok_or_else(|| std::io::Error::other("main window configuration is missing"))?;
            webview_profile::preserve_legacy_local_storage(app.handle(), &state.paths.cache.join("webview2"))?;
            let main_window = tauri::WebviewWindowBuilder::from_config(app, config)?
                .data_directory(state.paths.cache.join("webview2"))
                .build()?;
            tauri::async_runtime::block_on(window_state::restore(&main_window, &state.database))?;
            window_activity::attach(&main_window);
            let startup_instance = startup_instance_argument();
            let startup_state = state.clone();
            let startup_app = app.handle().clone();
            let avatar_state = state.clone();
            let monitor_state = state.clone();
            let monitor_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(std::time::Duration::from_secs(10));
                loop {
                    interval.tick().await;
                    if monitor_state.running_instances.read().await.is_empty() { continue; }
                    if let Err(error) = crate::minecraft::launcher::reconcile_running_instances(
                        &core_host::host(&monitor_app),
                        &monitor_state,
                    )
                    .await
                    {
                        tracing::warn!(%error, "running Minecraft process reconciliation failed");
                    }
                }
            });
            if startup_instance.is_some() {
                main_window.hide()?;
            } else {
                main_window.show()?;
            }
            window_activity::refresh(&main_window, &main_window.state::<window_activity::Activity>());
            if let Some(instance_id) = startup_instance {
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = crate::minecraft::launcher::launch_instance(
                        &core_host::host(&startup_app),
                        &startup_state,
                        &instance_id,
                        None,
                    )
                    .await
                    {
                        tracing::error!(%error, %instance_id, "desktop shortcut launch failed");
                        if let Some(window) = startup_app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                });
            }
            tauri::async_runtime::spawn(async move {
                crate::accounts::hydrate_missing_avatars(&avatar_state).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            window_activity::scenes_released,
            window_activity::ui_paused,
            window_activity::get_window_activity,
            ui_events::get_ui_snapshot,
            commands::exit_app,
            commands::save_window_state,
            commands::get_bootstrap,
            commands::check_launcher_updates,
            commands::load_locale,
            commands::list_locales,
            commands::get_locale_snapshot,
            commands::get_locale_revision,
            commands::open_languages_folder,
            commands::export_language_template,
            commands::update_setting,
            commands::remember_section,
            commands::prepare_windows_notifications,
            commands::send_windows_notification,
            commands::open_bedrock_content_file,
            commands::import_local_font,
            commands::get_local_font_data,
            commands::create_group,
            commands::set_group_collapsed,
            commands::assign_instance_group,
            commands::rename_group,
            commands::delete_group,
            commands::reorder_groups,
            commands::create_offline_account,
            commands::activate_account,
            commands::delete_account,
            commands::get_account_avatar,
            commands::get_account_appearance,
            commands::get_home_account_skin,
            commands::upload_account_skin,
            commands::upload_account_skin_bytes,
            commands::delete_saved_account_skin,
            commands::select_account_cape,
            commands::login_elyby,
            commands::login_microsoft,
            commands::list_minecraft_versions,
            commands::list_bedrock_versions,
            commands::test_bedrock_mirrors,
            commands::get_bedrock_runtime_status,
            commands::refresh_bedrock_entitlements,
            commands::bind_bedrock_store_account,
            commands::prepare_bedrock_runtime,
            commands::open_bedrock_store,
            commands::open_bedrock_xbox,
            commands::discover_java,
            commands::cancel_java_discovery,
            commands::install_managed_java,
            commands::create_instance,
            commands::update_instance,
            commands::inspect_instance_version_migration,
            commands::list_instance_version_migration_entries,
            commands::create_instance_version_copy,
            commands::delete_instance,
            commands::reveal_instance_path,
            commands::install_instance,
            commands::launch_instance,
            commands::kill_instance,
            commands::list_content_categories,
            commands::search_modrinth,
            commands::search_curseforge,
            commands::search_bedrock_curseforge,
            commands::download_bedrock_curseforge,
            commands::get_modrinth_project_details,
            commands::get_curseforge_project_details,
            commands::list_content_providers,
            commands::get_curseforge_key_status,
            commands::save_curseforge_api_key,
            commands::clear_curseforge_api_key,
            commands::plan_modrinth_install,
            commands::install_modrinth_project,
            commands::install_modrinth_modpack,
            commands::run_pack_install,
            commands::cancel_pack_install,
            commands::plan_curseforge_install,
            commands::install_curseforge_project,
            commands::list_installed_content,
            commands::reconcile_installed_content,
            commands::delete_instance_content,
            commands::set_instance_content_enabled,
            commands::install_curseforge_modpack,
            commands::add_curseforge_manual_files,
            commands::scan_curseforge_downloads,
            commands::scan_curseforge_archives,
            commands::list_loader_versions,
            commands::list_sync_mappings,
            commands::create_sync_mapping,
            commands::set_sync_mapping_enabled,
            commands::delete_sync_mapping,
            commands::run_sync,
            commands::run_sync_mapping_now,
            commands::reveal_shared_path,
            commands::open_instance_screenshot,
            commands::get_screenshot_thumbnail,
            commands::get_instance_console,
            commands::list_instance_files,
            commands::get_storage_summary,
            commands::get_system_metrics,
            commands::get_launcher_storage_usage,
            commands::list_downloads,
            commands::list_servers,
            commands::add_server,
            commands::remove_server,
            commands::inspect_archive,
            commands::import_slh_archive,
            commands::import_modrinth_pack,
            commands::import_curseforge_pack,
            commands::import_instance_folder,
            commands::export_instance,
            commands::list_instance_export_entries,
            commands::create_instance_desktop_shortcut,
            commands::repair_instance,
        ])
        .run(context)
        .expect("SLH failed to start");
}

/// Diagnostic mode verifies the actual Windows toast payload without opening UI.
#[cfg(windows)]
pub fn check_system_notification() -> bool {
    windows_notifications::ensure_start_menu_shortcut()
        .and_then(|()| windows_notifications::send_native("Smile LauncHer", Some("System notification icon check")))
        .is_ok()
}
