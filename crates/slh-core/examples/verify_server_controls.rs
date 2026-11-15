//! Destructive process checks are confined to an explicitly marked test server root.
use slh_core::{host::Host, local_servers::{host, runtime, store}, portable::PortablePaths, state::AppState};
use std::{path::PathBuf, process::Stdio, time::Duration};
use tokio::io::AsyncWriteExt;

#[tokio::main(flavor="multi_thread", worker_threads=2)]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    let root = std::fs::canonicalize(args.get(1).ok_or("test root required")?)?;
    if !root.join(".server-test-root").is_file() { return Err("test marker required".into()); }
    let bytes = std::fs::read(args.get(2).ok_or("host required")?)?;
    let paths = PortablePaths::from_executable(&root.join("slh-test.exe"), Some(root.clone()))?;
    let state = AppState::initialize_isolated_at(paths).await?;
    let app = Host::silent();
    let server = store::list(&state).await?.into_iter().find(|s| s.installed).ok_or("installed test server required")?;
    let mut config = server.config.clone();
    config.flags = "aikar".into();
    let port = std::net::TcpListener::bind("127.0.0.1:0")?;
    config.properties.insert("server-port".into(), port.local_addr()?.port().to_string());
    store::update(&state, &server.id, &server.name, config).await?;
    assert!(runtime::start(&app, &state, &server.id, &bytes).await.is_err());
    drop(port);
    assert!(runtime::script(&app, &state, &server.id, false).await.is_err());
    runtime::script(&app, &state, &server.id, true).await?;
    runtime::start(&app, &state, &server.id, &bytes).await?;
    for attempt in 0..150 {
        let snapshot = runtime::poll(&state, &server.id, 0).await?;
        if snapshot.state=="running" { break; }
        if snapshot.state=="failed" || attempt==149 { return Err(format!("server failed: {:?}",snapshot.error).into()); }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    let info = host::read_run(&runtime::run_file(&state, &server.id))?;
    let exe = runtime::ensure_host(&state, &bytes)?;
    let mut viewer = tokio::process::Command::new(exe);
    viewer.arg("console").arg(runtime::run_file(&state, &server.id)).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)] { viewer.creation_flags(0x08000000); }
    let mut viewer = viewer.spawn()?;
    tokio::time::sleep(Duration::from_secs(2)).await;
    viewer.stdin.take().unwrap().write_all(b"/detach\n").await?;
    assert!(tokio::time::timeout(Duration::from_secs(10),viewer.wait()).await??.success());
    assert!(runtime::java_is_alive(&state,&server.id));
    assert_eq!(runtime::poll(&state,&server.id,0).await?.state,"running");
    println!("PASS Aikar flags, occupied port rejection, script overwrite guard and closing console viewer");
    use sysinfo::{Pid, ProcessesToUpdate, ProcessRefreshKind, System, UpdateKind};
    let mut system=System::new(); let pid=Pid::from_u32(info.host_pid);
    system.refresh_processes_specifics(ProcessesToUpdate::Some(&[pid]),false,ProcessRefreshKind::nothing().with_exe(UpdateKind::Always).without_tasks());
    let process=system.process(pid).ok_or("missing test host")?;
    let host_path: PathBuf=process.exe().ok_or("test host executable unavailable")?.into();
    assert!(std::fs::canonicalize(host_path)?.starts_with(root.join("data/server-runtime")));
    assert!(process.kill());
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert!(runtime::java_is_alive(&state,&server.id));
    assert_eq!(runtime::poll(&state,&server.id,0).await?.state,"unmanaged");
    assert!(runtime::control(&state,&server.id,"stop","").await.is_err());
    runtime::control(&state,&server.id,"kill","").await?;
    for _ in 0..40 { if !runtime::java_is_alive(&state,&server.id) { break; } tokio::time::sleep(Duration::from_millis(250)).await; }
    assert!(!runtime::java_is_alive(&state,&server.id));
    println!("PASS host crash retains unmanaged Java identity; explicit force-stop terminates only that test process");
    Ok(())
}
