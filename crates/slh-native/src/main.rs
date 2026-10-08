#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod activity;
mod character;
use activity::Activity;
use character::{Scene, Skin};
use slh_core::{
    database,
    host::{CoreEvent, Host, WindowAction},
    portable::PortablePaths,
    state::AppState,
};
use slint::winit_030::{WinitWindowAccessor, winit};
use slint::{ComponentHandle, Timer, TimerMode};
use std::{
    cell::RefCell,
    path::PathBuf,
    rc::Rc,
    sync::Arc,
    time::{Duration, Instant},
};
slint::include_modules!();
struct Graphics {
    scene: Option<Scene>,
    skin: Skin,
    activity: Activity,
    start: Instant,
    last_frame: Instant,
    frames: u64,
    allocations: u64,
    releases: u64,
}
fn refresh_timer(ui: &Launcher, graphics: &Rc<RefCell<Graphics>>, timer: &Rc<Timer>) {
    timer.stop();
    let state = graphics.borrow();
    if state.activity.animating() {
        let interval = state.activity.interval();
        drop(state);
        let weak = ui.as_weak();
        let g = graphics.clone();
        timer.start(TimerMode::Repeated, interval, move || {
            g.borrow_mut().activity.dirty = true;
            if let Some(ui) = weak.upgrade() {
                ui.window().request_redraw();
            }
        });
    }
}
fn main() {
    if let Err(error) = run() {
        let message = slh_core::security::redact_secrets(&error.to_string());
        if let Ok(exe) = std::env::current_exe() {
            let _ = std::fs::write(exe.with_extension("error.log"), &message);
        }
        slh_core::platform::show_error(&message);
        std::process::exit(1);
    }
}
fn run() -> Result<(), Box<dyn std::error::Error>> {
    let startup = Instant::now();
    let args: Vec<String> = std::env::args().collect();
    let value = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let root_value = value("--data-root").or_else(|| {
        std::env::current_exe().ok().and_then(|exe| {
            std::fs::read_to_string(exe.parent()?.join("prototype-data-root.txt")).ok()
        })
    });
    let root = slh_core::platform::canonical_path(&PathBuf::from(
        root_value
            .ok_or("Use --data-root pointing to a prepared isolated copy")?
            .trim(),
    ))?;
    let marker: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.join("native-prototype.json"))?)?;
    if marker["isolated"] != true
        || slh_core::platform::canonical_path(&PathBuf::from(
            marker["root"].as_str().ok_or("Missing copy root")?,
        ))? != root
    {
        return Err("Data copy marker does not match root".into());
    }
    let production = slh_core::platform::canonical_path(&PathBuf::from(
        marker["source"].as_str().ok_or("Missing source root")?,
    ))?;
    if root == production || root.starts_with(&production) {
        return Err("Prototype cannot use production data".into());
    }
    let data_lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(root.join("native-prototype.lock"))?;
    data_lock.try_lock()?;
    let runtime = Arc::new(
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()?,
    );
    let _runtime_guard = runtime.enter();
    let state = Arc::new(runtime.block_on(AppState::initialize_isolated_at(
        PortablePaths::from_executable(&std::env::current_exe()?, Some(root.clone()))?,
    ))?);
    let accounts = runtime.block_on(database::accounts(&state.database))?;
    let instances = runtime.block_on(database::instances(&state.database))?;
    // Reject copied databases whose game directories still escape the isolated root.
    for instance in &instances {
        if !slh_core::platform::canonical_path(&PathBuf::from(&instance.game_dir))?
            .starts_with(&root)
        {
            return Err(format!("Unmapped game path for {}", instance.name).into());
        }
    }
    let appearance = runtime.block_on(database::setting(&state.database, "appearance"))?;
    let fps = value("--fps")
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or_else(|| appearance["homeCharacterFps"].as_u64().unwrap_or(30) as u32)
        .min(60);
    slint::BackendSelector::new()
        .backend_name("winit".into())
        .require_wgpu_30(slint::wgpu_30::WGPUConfiguration::default())
        .select()?;
    let ui = Launcher::new()?;
    ui.set_fps(fps as i32);
    ui.set_economy(args.iter().any(|v| v == "--economy") || appearance["nativeEconomy"] == true);
    if let Some(account) = accounts.iter().find(|a| a.active).or(accounts.first()) {
        ui.set_username(account.username.clone().into());
        ui.set_account_id(account.id.clone().into());
    }
    ui.set_instances(
        Rc::new(slint::VecModel::from(
            instances
                .iter()
                .filter(|i| i.loader_type != "bedrock")
                .map(|i| InstanceRow {
                    id: i.id.clone().into(),
                    name: i.name.clone().into(),
                    detail: format!("Minecraft {} · {}", i.minecraft_version, i.loader_type).into(),
                })
                .collect::<Vec<_>>(),
        ))
        .into(),
    );
    if let Some((index, _)) = instances
        .iter()
        .filter(|i| i.loader_type != "bedrock")
        .enumerate()
        .max_by(|(_, a), (_, b)| a.last_played_at.cmp(&b.last_played_at))
    {
        ui.set_selected(index as i32);
    }
    ui.set_status("Готово · отдельная копия данных".into());
    let graphics = Rc::new(RefCell::new(Graphics {
        scene: None,
        skin: Skin::fallback(),
        activity: Activity {
            fps,
            economy: ui.get_economy(),
            ..Default::default()
        },
        start: Instant::now(),
        last_frame: Instant::now() - Duration::from_secs(2),
        frames: 0,
        allocations: 0,
        releases: 0,
    }));
    let timer = Rc::new(Timer::default());
    let release_timer = Rc::new(Timer::default());
    let frame_timer = Rc::new(Timer::default());
    let wake = frame_timer.clone();
    let ready_path = value("--ready-report");
    let weak = ui.as_weak();
    let g = graphics.clone();
    ui.window()
        .set_rendering_notifier(move |render_state, api| {
            let Some(ui) = weak.upgrade() else { return };
            let mut g = g.borrow_mut();
            if matches!(render_state, slint::RenderingState::RenderingTeardown) {
                g.scene = None;
                return;
            }
            let slint::GraphicsAPI::WGPU30 { device, queue, .. } = api else {
                return;
            };
            if !matches!(
                render_state,
                slint::RenderingState::BeforeRendering | slint::RenderingState::RenderingSetup
            ) || !g.activity.frame_needed()
            {
                return;
            }
            if g.activity.fps > 0 && g.scene.is_some() {
                let remaining = g.activity.interval().saturating_sub(g.last_frame.elapsed());
                if !remaining.is_zero() {
                    let weak = ui.as_weak();
                    wake.start(TimerMode::SingleShot, remaining, move || {
                        if let Some(ui) = weak.upgrade() {
                            ui.window().request_redraw();
                        }
                    });
                    return;
                }
            }
            let scale = ui.window().scale_factor();
            let w = (ui.get_scene_width() * scale).max(1.);
            let h = (ui.get_scene_height() * scale).max(1.);
            let resolution = (1200. / w.max(h)).min(1.);
            let width = (w * resolution).round().max(1.) as u32;
            let height = (h * resolution).round().max(1.) as u32;
            if g.scene.is_none() {
                g.scene = Some(Scene::new(device, queue, &g.skin, width, height));
                g.allocations += 1;
            }
            let activity = g.activity.clone();
            let elapsed = g.start.elapsed().as_secs_f32();
            let scene = g.scene.as_mut().unwrap();
            scene.resize(width, height);
            scene.render(
                activity.yaw,
                activity.pitch,
                activity.zoom,
                if activity.economy {
                    None
                } else {
                    Some(elapsed)
                },
            );
            match slint::Image::try_from(scene.texture.clone()) {
                Ok(image) => ui.set_character(image),
                Err(e) => ui.set_status(format!("Ошибка импорта GPU: {e}").into()),
            }
            if g.frames == 0 {
                if let Some(path) = &ready_path {
                    let _ = std::fs::write(
                        path,
                        serde_json::json!({"firstFrameSeconds":startup.elapsed().as_secs_f64()})
                            .to_string(),
                    );
                }
            }
            g.frames += 1;
            g.last_frame = Instant::now();
            g.activity.dirty = false;
        })?;
    let weak = ui.as_weak();
    let g = graphics.clone();
    let t = timer.clone();
    ui.on_navigate(move |page| {
        g.borrow_mut().activity.home = page == 0;
        g.borrow_mut().activity.dirty = true;
        if let Some(ui) = weak.upgrade() {
            refresh_timer(&ui, &g, &t);
            ui.window().request_redraw();
        }
    });
    let weak = ui.as_weak();
    let g = graphics.clone();
    let t = timer.clone();
    let state_save = state.clone();
    let rt = runtime.clone();
    ui.on_settings_changed(move |economy, fps| {
        {
            let mut g = g.borrow_mut();
            g.activity.economy = economy;
            g.activity.fps = fps.max(0) as u32;
            g.activity.dirty = true;
        }
        if let Some(ui) = weak.upgrade() {
            refresh_timer(&ui, &g, &t);
            ui.window().request_redraw();
        }
        let state = state_save.clone();
        rt.spawn(async move {
            if let Ok(mut value) = database::setting(&state.database, "appearance").await {
                value["homeCharacterFps"] = fps.into();
                value["nativeEconomy"] = economy.into();
                let _ = database::set_setting(&state.database, "appearance", &value).await;
            }
        });
    });
    let weak = ui.as_weak();
    let g = graphics.clone();
    let drag = Rc::new(RefCell::new((0f32, 0f32)));
    let d = drag.clone();
    ui.on_drag_start(move || {
        *d.borrow_mut() = (0., 0.);
    });
    ui.on_rotate(move |x, y| {
        let mut last = drag.borrow_mut();
        let dx = x - last.0;
        let dy = y - last.1;
        *last = (x, y);
        let mut g = g.borrow_mut();
        g.activity.yaw += dx * 0.008;
        g.activity.pitch = (g.activity.pitch + dy * 0.004).clamp(-0.65, 0.65);
        g.activity.dirty = true;
        drop(g);
        if let Some(ui) = weak.upgrade() {
            ui.window().request_redraw();
        }
    });
    let weak = ui.as_weak();
    let g = graphics.clone();
    ui.on_zoom(move |delta| {
        let mut g = g.borrow_mut();
        g.activity.zoom = (g.activity.zoom * (1. + delta * 0.001)).clamp(0.5, 1.8);
        g.activity.dirty = true;
        drop(g);
        if let Some(ui) = weak.upgrade() {
            ui.window().request_redraw();
        }
    });
    let weak = ui.as_weak();
    ui.on_minimize(move || {
        if let Some(ui) = weak.upgrade() {
            ui.invoke_window_active(false);
            ui.window().with_winit_window(|w| w.set_minimized(true));
        }
    });
    let weak = ui.as_weak();
    ui.on_fps_text(move |text| {
        if let Ok(fps) = text.parse::<i32>() {
            if (0..=60).contains(&fps) {
                if let Some(ui) = weak.upgrade() {
                    ui.set_fps(fps);
                    ui.invoke_settings_changed(ui.get_economy(), fps);
                }
            }
        }
    });
    ui.on_quit(|| {
        let _ = slint::quit_event_loop();
    });
    let weak = ui.as_weak();
    let g = graphics.clone();
    let t = timer.clone();
    let release = release_timer.clone();
    let wake = frame_timer.clone();
    ui.on_window_active(move |active| {
        let minimized = !active;
        if minimized {
            wake.stop();
        }
        let changed = g.borrow().activity.minimized != minimized;
        {
            let mut g = g.borrow_mut();
            g.activity.minimized = minimized;
            g.activity.dirty = true;
        }
        if let Some(ui) = weak.upgrade() {
            refresh_timer(&ui, &g, &t);
            if active {
                release.stop();
                ui.window().request_redraw();
            } else if changed {
                let g = g.clone();
                let weak = weak.clone();
                release.start(TimerMode::SingleShot, Duration::from_secs(30), move || {
                    {
                        let mut g = g.borrow_mut();
                        g.scene = None;
                        g.releases += 1;
                    }
                    if let Some(ui) = weak.upgrade() {
                        ui.set_character(slint::Image::default());
                    }
                });
            }
        }
    });
    let weak = ui.as_weak();
    let g = graphics.clone();
    ui.window().on_winit_window_event(move |window, event| {
        let iconic = window
            .with_winit_window(|w| w.is_minimized().unwrap_or(false))
            .unwrap_or(false);
        let active = match event {
            winit::event::WindowEvent::Resized(size) => {
                Some(!iconic && size.width > 0 && size.height > 0)
            }
            winit::event::WindowEvent::Focused(true) => Some(!iconic),
            winit::event::WindowEvent::Focused(false) if iconic => Some(false),
            winit::event::WindowEvent::Occluded(value) => Some(!iconic && !value),
            _ => None,
        };
        if let Some(active) = active {
            if let Some(ui) = weak.upgrade() {
                ui.invoke_window_active(active);
            }
            g.borrow_mut().activity.dirty = true;
        }
        slint::winit_030::EventResult::Propagate
    });
    let weak = ui.as_weak();
    let last_progress = std::sync::Mutex::new(Instant::now() - Duration::from_secs(1));
    let host = Host::new(move |event| {
        if let CoreEvent::Progress(ref progress) = event {
            let mut last = last_progress.lock().unwrap();
            let final_event = progress
                .total
                .is_some_and(|total| progress.completed >= total);
            if last.elapsed() < Duration::from_millis(100) && !final_event {
                return Ok(());
            }
            *last = Instant::now();
        }
        let weak = weak.clone();
        let _ = weak.upgrade_in_event_loop(move |ui| match event {
            CoreEvent::Window(WindowAction::Hide) => {
                ui.invoke_window_active(false);
                let _ = ui.hide();
            }
            CoreEvent::Window(WindowAction::Show | WindowAction::Focus) => {
                let _ = ui.show();
                ui.invoke_window_active(true);
            }
            CoreEvent::Launch(event) => {
                if event.state == "running" {
                    ui.set_running_instance(event.instance_id.into());
                } else if event.state != "launching" {
                    ui.set_running_instance("".into());
                }
                ui.set_status(format!("Игра: {}", event.state).into());
            }
            CoreEvent::SyncError(e) => ui.set_status(e.message.into()),
            CoreEvent::Progress(e) => ui.set_status(e.message.into()),
            CoreEvent::Console(_) => {}
        });
        Ok(())
    });
    let weak = ui.as_weak();
    let rt = runtime.clone();
    let launch_state = state.clone();
    ui.on_launch(move |id| {
        let state = launch_state.clone();
        let host = host.clone();
        let weak = weak.clone();
        rt.spawn(async move {
            let result =
                slh_core::minecraft::launcher::launch_instance(&host, &state, id.as_str(), None)
                    .await;
            if let Err(e) = result {
                let message = slh_core::security::redact_secrets(&e.to_string());
                let _ = weak.upgrade_in_event_loop(move |ui| ui.set_status(message.into()));
            }
        });
    });
    let weak = ui.as_weak();
    let rt = runtime.clone();
    let stop_state = state.clone();
    ui.on_stop(move |id| {
        let state = stop_state.clone();
        let weak = weak.clone();
        rt.spawn(async move {
            if let Err(e) = slh_core::minecraft::launcher::kill_instance(&state, id.as_str()).await
            {
                let message = slh_core::security::redact_secrets(&e.to_string());
                let _ = weak.upgrade_in_event_loop(move |ui| ui.set_status(message.into()));
            }
        });
    });
    // Account skin is fetched off the UI thread; account IDs never go into graphics code.
    let account_index = Rc::new(RefCell::new(
        accounts.iter().position(|a| a.active).unwrap_or(0),
    ));
    let load_skin = {
        let rt = runtime.clone();
        let state = state.clone();
        let weak = ui.as_weak();
        move |account: slh_core::models::Account| {
            if let Some(ui) = weak.upgrade() {
                ui.set_username(account.username.clone().into());
                ui.set_account_id(account.id.clone().into());
            }
            let state = state.clone();
            let weak = weak.clone();
            let ui_weak = weak.clone();
            rt.spawn(async move {
                let _ = slh_core::accounts::activate_account(&state.database, &account.id).await;
                let cached = tokio::fs::read(
                    state
                        .paths
                        .accounts
                        .join(format!("{}.home-skin.json", account.id)),
                )
                .await
                .ok()
                .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
                let data = match cached {
                    Some(value) => Ok(value),
                    None => slh_core::accounts::home_skin(&state, &account.id).await,
                };
                let _ = ui_weak.upgrade_in_event_loop(move |ui| {
                    if let Ok(data) = data {
                        ui.invoke_skin_loaded(
                            data["dataUrl"].as_str().unwrap_or("").into(),
                            data["model"] == "slim",
                            account.id.into(),
                        );
                    }
                });
            });
        }
    };
    let g = graphics.clone();
    let weak = ui.as_weak();
    ui.on_skin_loaded(move |data, slim, account_id| {
        if weak
            .upgrade()
            .is_none_or(|ui| ui.get_account_id() != account_id)
        {
            return;
        }
        if let Ok(skin) = Skin::decode(data.as_str(), slim) {
            let mut g = g.borrow_mut();
            g.skin = skin;
            g.scene = None;
            g.activity.dirty = true;
            drop(g);
            if let Some(ui) = weak.upgrade() {
                ui.window().request_redraw();
            }
        }
    });
    if let Some(account) = accounts.get(*account_index.borrow()) {
        load_skin(account.clone());
    }
    ui.on_account_next(move || {
        if accounts.is_empty() {
            return;
        }
        let mut index = account_index.borrow_mut();
        *index = (*index + 1) % accounts.len();
        load_skin(accounts[*index].clone());
    });
    let minimize_timer = Timer::default();
    if args.iter().any(|a| a == "--minimized") {
        let weak = ui.as_weak();
        minimize_timer.start(TimerMode::SingleShot, Duration::from_secs(2), move || {
            if let Some(ui) = weak.upgrade() {
                ui.invoke_minimize();
            }
        });
    }
    let exit_timer = Timer::default();
    if let Some(seconds) = value("--auto-exit").and_then(|v| v.parse().ok()) {
        exit_timer.start(TimerMode::SingleShot, Duration::from_secs(seconds), || {
            let _ = slint::quit_event_loop();
        });
    }
    let initial_size_timer = Timer::default();
    let weak = ui.as_weak();
    let maximize_initial = args.iter().any(|a| a == "--maximized");
    initial_size_timer.start(
        TimerMode::SingleShot,
        Duration::from_millis(100),
        move || {
            if let Some(ui) = weak.upgrade() {
                if maximize_initial {
                    ui.window().with_winit_window(|w| w.set_maximized(true));
                } else if let Some(Some(monitor)) =
                    ui.window().with_winit_window(|w| w.current_monitor())
                {
                    let size = monitor.size();
                    let scale = monitor.scale_factor() as f32;
                    let current = ui.window().size();
                    let width = (size.width as f32 / scale - 40.).min(1480.).max(900.);
                    let height = (size.height as f32 / scale - 80.).min(920.).max(560.);
                    if current.width as f32 > width * scale
                        || current.height as f32 > height * scale
                    {
                        ui.window().set_size(slint::LogicalSize::new(width, height));
                    }
                }
            }
        },
    );
    let setup_timer = Timer::default();
    let weak = ui.as_weak();
    let screenshot = value("--screenshot");
    setup_timer.start(TimerMode::SingleShot, Duration::from_secs(5), move || {
        if let Some(ui) = weak.upgrade() {
            if let Some(path) = &screenshot {
                match ui.window().take_snapshot() {
                    Ok(pixels) => {
                        let _ = image::save_buffer(
                            path,
                            pixels.as_bytes(),
                            pixels.width(),
                            pixels.height(),
                            image::ColorType::Rgba8,
                        );
                    }
                    Err(e) => eprintln!("Snapshot unavailable: {e}"),
                }
            }
        }
    });
    let test_timer = Timer::default();
    let test_step = Rc::new(RefCell::new(0));
    if args.iter().any(|a| a == "--self-test") {
        let weak = ui.as_weak();
        let step = test_step.clone();
        test_timer.start(TimerMode::Repeated, Duration::from_millis(250), move || {
            if let Some(ui) = weak.upgrade() {
                let mut step = step.borrow_mut();
                if *step < 40 {
                    let page = *step % 2;
                    ui.set_page(page);
                    ui.invoke_navigate(page);
                    ui.invoke_drag_start();
                    ui.invoke_rotate(8., 3.);
                    ui.invoke_zoom(10.);
                } else if *step == 40 {
                    ui.invoke_minimize();
                } else if *step == 180 {
                    ui.set_page(0);
                    ui.invoke_navigate(0);
                    ui.window().with_winit_window(|w| w.set_minimized(false));
                    ui.invoke_window_active(true);
                } else if *step > 190 {
                    let _ = slint::quit_event_loop();
                }
                *step += 1;
            }
        });
    }
    refresh_timer(&ui, &graphics, &timer);
    ui.window().on_close_requested(|| {
        let _ = slint::quit_event_loop();
        slint::CloseRequestResponse::HideWindow
    });
    ui.show()?;
    slint::run_event_loop_until_quit()?;
    ui.hide()?;
    if let Some(path) = value("--stats") {
        let g = graphics.borrow();
        std::fs::write(
            path,
            serde_json::to_vec_pretty(
                &serde_json::json!({"frames":g.frames,"sceneAllocations":g.allocations,"idleResourceReleases":g.releases,"sceneReleased":g.scene.is_none(),"elapsedSeconds":g.start.elapsed().as_secs_f64(),"fps":g.activity.fps,"economy":g.activity.economy}),
            )?,
        )?;
    }
    Ok(())
}
