use super::{config::*, store};
use crate::{portable::PortablePaths, state::AppState, storage_cleanup};
use std::path::Path;

async fn setup() -> (tempfile::TempDir, AppState) {
    let root = tempfile::tempdir().unwrap();
    let paths = PortablePaths::from_executable(
        &root.path().join("SLH.exe"),
        Some(root.path().to_path_buf()),
    )
    .unwrap();
    let state = AppState::initialize_isolated_at(paths).await.unwrap();
    (root, state)
}
fn request(group: Option<String>) -> store::CreateServer {
    store::CreateServer {
        name: "Сервер & 100%!".into(),
        folder: "Сервер & 100% ! test".into(),
        group_id: group,
        config: ServerConfig {
            minecraft_version: "1.21.4".into(),
            core_version: "1.21.4".into(),
            eula_accepted: true,
            ..Default::default()
        },
    }
}

fn recovery_jar(path: &Path, version: &str) {
    use std::io::Write;
    let mut zip = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
    zip.start_file("META-INF/MANIFEST.MF", zip::write::SimpleFileOptions::default()).unwrap();
    zip.write_all(b"Main-Class: io.papermc.paperclip.Main\n").unwrap();
    zip.start_file("version.json", zip::write::SimpleFileOptions::default()).unwrap();
    zip.write_all(format!(r#"{{"id":"{version}","java_version":25}}"#).as_bytes()).unwrap();
    zip.start_file("META-INF/versions.list", zip::write::SimpleFileOptions::default()).unwrap();
    zip.write_all(format!("hash\t{version}\t{version}/leaf-{version}.jar\n").as_bytes()).unwrap();
    zip.finish().unwrap();
}
async fn recovery_server(state: &AppState) -> store::LocalServer {
    let mut create = request(None);
    create.name = "Recovery fixture".into(); create.folder = "recovery-fixture".into();
    create.config.core = "custom".into(); create.config.minecraft_version = "26.2".into();
    create.config.flags = "custom".into(); create.config.jvm_args = vec!["-Dfixture=keep".into()];
    let server = store::create(state, create).await.unwrap();
    store::save_plan(state, &server.id, &LaunchPlan { java: String::new(), args: vec!["-jar".into(), "old.jar".into()], directory: server.path.clone(), required_java: 21 }).await.unwrap();
    store::get(state, &server.id).await.unwrap()
}
#[tokio::test]
async fn missing_core_repair_updates_version_and_plan_without_touching_server_files_or_flags() {
    let (_root, state) = setup().await;
    let server = recovery_server(&state).await;
    let dir = Path::new(&server.path);
    recovery_jar(&dir.join("server-leaf-26-3.jar"), "26.3");
    std::fs::write(dir.join("plugin.jar"), b"plugin").unwrap();
    std::fs::create_dir(dir.join("plugins")).unwrap();
    recovery_jar(&dir.join("plugins/other.jar"), "26.1");
    std::fs::write(dir.join("start.bat"), b"keep script").unwrap();
    let properties = std::fs::read(dir.join("server.properties")).unwrap();
    let check = super::recovery::inspect(&state, &server.id).await.unwrap();
    assert!(check.needs_repair && check.missing); assert_eq!(check.candidates.len(), 1);
    assert_eq!(store::get(&state, &server.id).await.unwrap().config.minecraft_version, "26.2");
    let candidate = check.candidates[0].clone();
    let fixed = super::recovery::repair(&state, &server.id, candidate.path, check.revision, candidate.fingerprint).await.unwrap();
    assert_eq!(fixed.config.minecraft_version, "26.3"); assert_eq!(fixed.config.core, "leaf");
    assert_eq!(fixed.config.jvm_args, server.config.jvm_args);
    assert_eq!(fixed.config.memory_max_mb, server.config.memory_max_mb);
    let plan = store::load_plan(&state, &server.id).await.unwrap().unwrap();
    assert_eq!(plan.args, vec!["-jar", "server-leaf-26-3.jar"]); assert_eq!(plan.required_java, 25);
    assert_eq!(std::fs::read(dir.join("server.properties")).unwrap(), properties);
    assert_eq!(std::fs::read(dir.join("start.bat")).unwrap(), b"keep script");
    assert!(!super::recovery::inspect(&state, &server.id).await.unwrap().needs_repair);
}
#[tokio::test]
async fn core_repair_rejects_changed_candidates_and_paths_outside_the_server_root() {
    let (root, state) = setup().await;
    let server = recovery_server(&state).await;
    let jar = Path::new(&server.path).join("server.jar"); recovery_jar(&jar, "26.3");
    let check = super::recovery::inspect(&state, &server.id).await.unwrap();
    let old = check.candidates[0].clone();
    use std::io::Write;
    std::fs::OpenOptions::new().append(true).open(&jar).unwrap().write_all(b"changed").unwrap();
    assert!(super::recovery::repair(&state, &server.id, old.path, check.revision, old.fingerprint).await.is_err());
    let outside = root.path().join("outside.jar"); recovery_jar(&outside, "26.3");
    assert!(super::recovery::inspect_candidate(&state, &server.id, outside.to_string_lossy().into_owned()).await.is_err());
    assert_eq!(store::get(&state, &server.id).await.unwrap().config.minecraft_version, "26.2");
}
#[tokio::test]
async fn replacing_a_core_in_place_requires_confirmation_of_its_embedded_version() {
    let (_root, state) = setup().await;
    let server = recovery_server(&state).await;
    recovery_jar(&Path::new(&server.path).join("old.jar"), "26.3");
    let check = super::recovery::inspect(&state, &server.id).await.unwrap();
    assert!(check.needs_repair); assert!(!check.missing);
    assert_eq!(check.candidates[0].minecraft_version, "26.3");
    sqlx::query("UPDATE local_servers SET config_json=json_set(config_json,'$.memoryMaxMb',8192) WHERE id=?").bind(&server.id).execute(&state.database).await.unwrap();
    let candidate = check.candidates[0].clone();
    assert!(super::recovery::repair(&state, &server.id, candidate.path, check.revision, candidate.fingerprint).await.is_err());
}

#[tokio::test]
async fn section_folders_follow_the_active_server_section() {
    let (_root, state) = setup().await;
    let server = store::create(&state, request(None)).await.unwrap();
    for (section, suffix) in [("plugins", "plugins"), ("console", "logs"), ("settings", ""), ("overview", "")] {
        let path = store::section_folder(&state, Some(&server.id), Some(section)).await.unwrap();
        assert_eq!(path, Path::new(&server.path).join(suffix));
    }
    assert!(store::section_folder(&state, Some(&server.id), Some("../outside")).await.is_err());
    assert!(store::section_folder(&state, None, Some("plugins")).await.is_err());
}

#[tokio::test]
async fn nested_folders_move_on_disk_and_defaults_do_not_mutate_existing_profiles() {
    let (_root, state) = setup().await;
    let group = store::create_group(&state, "Мои серверы", None)
        .await
        .unwrap();
    let nested = store::create_group(&state, "Тест & 100% ! test", Some(group.id.clone()))
        .await
        .unwrap();
    let server = store::create(&state, request(Some(nested.id.clone())))
        .await
        .unwrap();
    let world = Path::new(&server.path).join("world");
    std::fs::create_dir(&world).unwrap();
    std::fs::write(world.join("level.dat"), b"save").unwrap();
    store::rename_group(&state, &group.id, "Переименовано")
        .await
        .unwrap();
    let moved = store::get(&state, &server.id).await.unwrap();
    assert!(moved.path.contains("Переименовано"));
    assert_eq!(
        std::fs::read(Path::new(&moved.path).join("world/level.dat")).unwrap(),
        b"save"
    );
    let moved = store::move_server(&state, &server.id, None, "Перенесённый сервер")
        .await
        .unwrap();
    assert_eq!(
        std::fs::read(Path::new(&moved.path).join("world/level.dat")).unwrap(),
        b"save"
    );
    let mut defaults = ServerDefaults::default();
    defaults.config.memory_max_mb = 8192;
    store::save_defaults(&state, serde_json::to_value(defaults).unwrap())
        .await
        .unwrap();
    assert_eq!(
        store::get(&state, &server.id)
            .await
            .unwrap()
            .config
            .memory_max_mb,
        4096
    );
    assert!(
        store::create_group(&state, "../escape", None)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn eula_and_running_state_guard_configuration_changes() {
    let (_root, state) = setup().await;
    let mut value = request(None);
    value.config.eula_accepted = false;
    assert!(store::create(&state, value).await.is_err());
    assert!(store::list(&state).await.unwrap().is_empty());
    let server = store::create(&state, request(None)).await.unwrap();
    assert!(
        std::fs::read_to_string(Path::new(&server.path).join("eula.txt"))
            .unwrap()
            .contains("eula=true")
    );
    store::set_status(&state, &server.id, "installing")
        .await
        .unwrap();
    assert!(
        store::update(&state, &server.id, &server.name, server.config.clone())
            .await
            .is_err()
    );
    assert!(
        store::move_server(&state, &server.id, None, "new")
            .await
            .is_err()
    );
    let scan = storage_cleanup::scan(&state).await.unwrap();
    assert!(scan.busy);
    assert!(scan.entries.is_empty());
}

#[tokio::test]
async fn cleanup_rechecks_files_and_preserves_worlds_and_foreign_archives() {
    let (_root, state) = setup().await;
    let server = store::create(&state, request(None)).await.unwrap();
    let world = Path::new(&server.path).join("world");
    std::fs::create_dir(&world).unwrap();
    std::fs::write(world.join("level.dat"), b"world").unwrap();
    let manifest = state.paths.cache.join("minecraft/version_manifest_v2.json");
    std::fs::create_dir_all(manifest.parent().unwrap()).unwrap();
    std::fs::write(&manifest, b"original").unwrap();
    let foreign = state.paths.downloads.join("foreign.zip");
    std::fs::write(&foreign, b"user data").unwrap();
    let scan = storage_cleanup::scan(&state).await.unwrap();
    let entry = scan
        .entries
        .iter()
        .find(|e| e.path == manifest.to_string_lossy())
        .unwrap();
    assert!(
        !scan
            .entries
            .iter()
            .any(|e| e.path == foreign.to_string_lossy() || e.path.contains("level.dat"))
    );
    std::fs::write(&manifest, b"changed since review").unwrap();
    let result = storage_cleanup::execute(&state, &scan.id, vec![entry.id.clone()])
        .await
        .unwrap();
    assert_eq!(result.skipped, 1);
    assert_eq!(result.removed_files, 0);
    let scan = storage_cleanup::scan(&state).await.unwrap();
    let entries = scan
        .entries
        .iter()
        .filter(|e| e.path == manifest.to_string_lossy())
        .map(|e| e.id.clone())
        .collect();
    let result = storage_cleanup::execute(&state, &scan.id, entries)
        .await
        .unwrap();
    assert_eq!(result.removed_files, 1);
    assert!(!manifest.exists());
    assert!(foreign.is_file());
    assert!(world.join("level.dat").is_file());
}

#[tokio::test]
async fn cleanup_pins_inherited_libraries_and_every_platform() {
    let (_root, state) = setup().await;
    let game = state.paths.instances.join("test/game");
    std::fs::create_dir_all(&game).unwrap();
    sqlx::query("INSERT INTO instances(id,name,minecraft_version,game_dir,status) VALUES ('test','test','base',?,'installed')").bind(game.to_string_lossy().as_ref()).execute(&state.database).await.unwrap();
    let profiles = game.parent().unwrap().join("versions");
    std::fs::create_dir_all(&profiles).unwrap();
    std::fs::write(
        profiles.join("child.json"),
        br#"{"id":"child","inheritsFrom":"middle","libraries":[]}"#,
    )
    .unwrap();
    let cache = state.paths.cache.join("minecraft/versions");
    std::fs::create_dir_all(&cache).unwrap();
    std::fs::write(
        cache.join("middle.json"),
        br#"{"id":"middle","inheritsFrom":"base","libraries":[]}"#,
    )
    .unwrap();
    let lib = state.paths.cache.join("minecraft/libraries/mac-native.jar");
    std::fs::create_dir_all(lib.parent().unwrap()).unwrap();
    std::fs::write(&lib, b"keep").unwrap();
    let base = serde_json::json!({"id":"base","libraries":[{"downloads":{"classifiers":{"natives-osx":{"path":"mac-native.jar","sha1":"1264bdfe5ff3215cf6abac2152fff607f7dc78dc"}}}}]});
    std::fs::write(cache.join("base.json"), serde_json::to_vec(&base).unwrap()).unwrap();
    let scan = storage_cleanup::scan(&state).await.unwrap();
    assert!(!scan.entries.iter().any(|e| e.path.contains("base.json")
        || e.path.contains("middle.json")
        || e.path.contains("mac-native.jar")));
}

#[test]
fn canonical_windows_paths_are_accepted_without_querying_an_incomplete_drive_prefix() {
    let root = tempfile::tempdir().unwrap();
    let path = std::fs::canonicalize(root.path()).unwrap();
    store::plain_path(&path.join("Новая папка & 100%!")).unwrap();
}

#[test]
fn jar_url_delimiters_are_rejected_but_other_special_characters_are_supported() {
    let root=tempfile::tempdir().unwrap();
    assert!(store::validate_server_path("vanilla", &root.path().join("Group!").join("Server")).is_err());
    assert!(store::validate_server_path("vanilla", &root.path().join("Мои серверы & 100% ! test").join("Server")).is_ok());
    for core in ["paper","purpur","spigot","bukkit"] {
        assert!(store::validate_server_path(core, &root.path().join("My + server")).is_err());
        assert!(store::validate_server_path(core, &root.path().join("My ! server")).is_err());
    }
}

#[tokio::test]
async fn exit_zero_before_server_readiness_is_a_failed_start() {
    let root=tempfile::tempdir().unwrap();
    // The test harness lists an empty filter and exits successfully without running tests.
    let executable=std::env::current_exe().unwrap().to_string_lossy().into_owned();
    let args=vec!["--list".into(),"--exact".into(),"slh_nonexistent_server_test".into()];
    let run_file=root.path().join("run.json");
    super::host::run(super::host::HostPlan {
        server_id:"isolated-early-exit".into(),
        launch:LaunchPlan {java:executable,args,directory:root.path().to_string_lossy().into_owned(),required_java:8},
        run_file:run_file.clone(),log_file:root.path().join("console.jsonl"),
    }).await.unwrap();
    let info=super::host::read_run(&run_file).unwrap();
    assert_eq!(info.exit_code,Some(0));assert_eq!(info.state,"failed");assert!(info.error.is_some());
}

#[cfg(windows)]
#[tokio::test]
async fn cleanup_reports_locked_files_without_touching_their_contents() {
    use std::os::windows::fs::OpenOptionsExt;
    let (_root, state) = setup().await;
    let path = state.paths.cache.join("minecraft/version_manifest_v2.json");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, b"cache").unwrap();
    let scan = storage_cleanup::scan(&state).await.unwrap();
    let selected = scan
        .entries
        .iter()
        .filter(|e| e.path == path.to_string_lossy())
        .map(|e| e.id.clone())
        .collect();
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(3)
        .open(&path)
        .unwrap();
    let result = storage_cleanup::execute(&state, &scan.id, selected)
        .await
        .unwrap();
    assert_eq!(result.removed_files, 0);
    assert_eq!(result.errors.len(), 1);
    assert_eq!(std::fs::read(&path).unwrap(), b"cache");
    drop(lock);
}

#[cfg(windows)]
#[tokio::test]
async fn cleanup_does_not_enter_windows_junctions() {
    let (_root, state) = setup().await;
    let target = tempfile::tempdir().unwrap();
    let file = target.path().join("hidden.json");
    std::fs::write(&file, b"keep").unwrap();
    let parent = state.paths.cache.join("minecraft/versions");
    std::fs::create_dir_all(&parent).unwrap();
    let link = parent.join("linked");
    use std::os::windows::process::CommandExt;
    let status=std::process::Command::new("cmd.exe").args(["/d","/s","/c"]).raw_arg(format!("mklink /J \"{}\" \"{}\"",link.display(),target.path().display())).creation_flags(0x08000000).status().unwrap();
    assert!(status.success());
    assert!(store::plain_path(&link.join("hidden.json")).is_err());
    assert!(
        !storage_cleanup::scan(&state)
            .await
            .unwrap()
            .entries
            .iter()
            .any(|e| e.path.contains("hidden.json"))
    );
    assert_eq!(std::fs::read(file).unwrap(), b"keep");
}

#[tokio::test]
async fn download_batches_obey_parallelism_on_a_local_http_server() {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let active = Arc::new(AtomicUsize::new(0));
    let maximum = Arc::new(AtomicUsize::new(0));
    let a = active.clone();
    let m = maximum.clone();
    let server = tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            let active = a.clone();
            let maximum = m.clone();
            tokio::spawn(async move {
                let mut request = [0u8; 4096];
                let _ = socket.read(&mut request).await;
                let count = active.fetch_add(1, Ordering::SeqCst) + 1;
                maximum.fetch_max(count, Ordering::SeqCst);
                tokio::time::sleep(std::time::Duration::from_millis(60)).await;
                let _ = socket
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
                    )
                    .await;
                active.fetch_sub(1, Ordering::SeqCst);
            });
        }
    });
    let root = tempfile::tempdir().unwrap();
    let plans = (0..6)
        .map(|n| crate::minecraft::download::DownloadPlan {
            url: format!("http://{address}/{n}"),
            destination: root.path().join(format!("{n}.jar")),
            sha1: None,
            max_bytes: None,
        })
        .collect();
    crate::minecraft::download::download_many(&reqwest::Client::new(), plans, 2, |_, _| {})
        .await
        .unwrap();
    server.abort();
    assert_eq!(maximum.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn discovered_servers_connect_without_rewriting_user_files_and_are_not_rediscovered(){
 let (root,state)=setup().await;
 let path=root.path().join("Existing servers/Мой сервер");std::fs::create_dir_all(path.join("world")).unwrap();
 for (name,data) in [("server.properties","# user comment\nserver-port=25572\nmotd=Preserved\nunknown.setting=yes\n"),("purpur.yml","settings: {}"),("eula.txt","eula=true\n"),("purpur-1.21.4.jar","fixture"),("plugin.jar","not the server"),("start.bat","java -Xms1G -Xmx3G -jar purpur-1.21.4.jar nogui"),("world/level.dat","precious world")] {std::fs::write(path.join(name),data).unwrap();}
 let before:Vec<_>=walkdir::WalkDir::new(&path).into_iter().filter_map(Result::ok).filter(|e|e.file_type().is_file()).map(|e|(e.path().to_owned(),std::fs::read(e.path()).unwrap())).collect();
 let scan=super::discovery::scan(&state,Some(root.path().to_string_lossy().into_owned())).await.unwrap();assert_eq!(scan.len(),1);assert!(scan[0].ready);
 let s=super::discovery::connect(&state,scan[0].path.clone(),None).await.unwrap();assert!(s.installed);assert_eq!(s.config.memory_max_mb,3072);assert_eq!(s.config.properties["server-port"],"25572");
 let repeated=super::discovery::connect(&state,s.path.clone(),None).await.unwrap();assert_eq!(s.id,repeated.id);
 assert!(super::discovery::scan(&state,Some(root.path().to_string_lossy().into_owned())).await.unwrap().is_empty());
 for (path,bytes) in before {assert_eq!(std::fs::read(path).unwrap(),bytes);}
}
#[tokio::test]
async fn plugin_management_backs_up_jars_keeps_configuration_and_rejects_running_servers(){
 use std::io::Write;
 let (_root,state)=setup().await;let mut req=request(None);req.folder="plugins test".into();req.config.core="purpur".into();let server=store::create(&state,req).await.unwrap();let plugins=Path::new(&server.path).join("plugins");std::fs::create_dir(&plugins).unwrap();
 let jar=plugins.join("Example.jar");let mut zip=zip::ZipWriter::new(std::fs::File::create(&jar).unwrap());zip.start_file("plugin.yml",zip::write::SimpleFileOptions::default()).unwrap();zip.write_all(b"name: Example\nversion: 1.0\n").unwrap();zip.finish().unwrap();
 std::fs::create_dir(plugins.join("Example")).unwrap();std::fs::write(plugins.join("Example/config.yml"),"custom: true").unwrap();
 let original=std::fs::read(&jar).unwrap();assert_eq!(super::plugins::files(&state,&server.id).await.unwrap()[0].name,"Example");
 super::plugins::manage(&state,&server.id,"Example.jar","toggle").await.unwrap();assert!(!jar.exists());assert!(!super::plugins::files(&state,&server.id).await.unwrap()[0].enabled);
 super::plugins::manage(&state,&server.id,"Example.jar.disabled","toggle").await.unwrap();
 store::set_status(&state,&server.id,"installing").await.unwrap();assert!(super::plugins::manage(&state,&server.id,"Example.jar","remove").await.is_err());store::set_status(&state,&server.id,"stopped").await.unwrap();
 assert!(super::plugins::manage(&state,&server.id,"../server.properties","remove").await.is_err());
 super::plugins::manage(&state,&server.id,"Example.jar","remove").await.unwrap();assert!(!jar.exists());assert_eq!(std::fs::read_to_string(plugins.join("Example/config.yml")).unwrap(),"custom: true");
 let backup=walkdir::WalkDir::new(state.paths.backups.join("server-plugins")).into_iter().filter_map(Result::ok).find(|e|e.file_name()=="Example.jar").unwrap();assert_eq!(std::fs::read(backup.path()).unwrap(),original);
}

#[tokio::test]
async fn library_sync_persists_root_nested_groups_and_profiles_without_changing_files(){
 let (root,state)=setup().await;let directory=root.path().join("External servers");
 for folder in ["server1","gdz/gdzserver","gdz/gdz"]{let path=directory.join(folder);std::fs::create_dir_all(path.join("world")).unwrap();for (name,value) in [("server.properties","# comment\nserver-port=25565\ncustom=preserved\n"),("start.bat","java -Xms1G -Xmx2G -jar purpur-1.21.4.jar nogui"),("purpur-1.21.4.jar","fixture"),("eula.txt","eula=true"),("world/level.dat","precious world")]{std::fs::write(path.join(name),value).unwrap();}}
 let before:Vec<_>=walkdir::WalkDir::new(&directory).into_iter().filter_map(Result::ok).map(|e|{let p=e.path().to_owned();let bytes=if p.is_file(){Some(std::fs::read(&p).unwrap())}else{None};(p,bytes)}).collect();
 let first=super::library::synchronize(&state,Some(directory.to_string_lossy().into_owned())).await.unwrap();assert_eq!(first.servers.len(),3);let gdz=first.collections.iter().find(|g|g.name=="gdz").unwrap();assert_eq!(first.servers.iter().filter(|s|s.presentation["collectionId"]==gdz.id).count(),2);assert!(first.servers.iter().all(|s|s.installed&&s.presentation["readiness"]=="ready"));
 let ids:Vec<_>=first.servers.iter().map(|s|s.id.clone()).collect();assert_eq!(store::defaults(&state).await.unwrap().directory,Some(directory.to_string_lossy().into_owned()));
 super::library::edit_group(&state,"create",None,Some("Custom group".into()),None).await.unwrap();let group=super::library::collections(&state).await.unwrap().into_iter().find(|g|g.name=="Custom group").unwrap();
 let server=first.servers.iter().find(|s|s.name=="gdzserver").unwrap();super::library::organize(&state,&server.id,Some(group.id.clone()),None).await.unwrap();super::library::edit_group(&state,"rename",Some(group.id.clone()),Some("Renamed".into()),None).await.unwrap();
 super::library::save_view(&state,serde_json::json!({"view":"icons","sort":"manual","collection":group.id,"tabsPosition":"right"})).await.unwrap();
 let paths=state.paths.clone();drop(state);let reopened=AppState::initialize_isolated_at(paths).await.unwrap();let next=super::library::synchronize(&reopened,None).await.unwrap();assert_eq!(next.servers.iter().map(|s|s.id.clone()).collect::<Vec<_>>(),ids);assert_eq!(next.view["view"],"icons");assert_eq!(next.servers.iter().find(|s|s.id==server.id).unwrap().presentation["collectionId"],group.id);
 super::library::edit_group(&reopened,"delete",Some(gdz.id.clone()),None,None).await.unwrap();let refreshed=super::library::synchronize(&reopened,None).await.unwrap();assert!(!refreshed.collections.iter().any(|g|g.id==gdz.id||g.name=="gdz"));
 for (path,bytes) in before {if let Some(bytes)=bytes{assert_eq!(std::fs::read(&path).unwrap(),bytes);}else{assert!(path.is_dir());}}
 assert!(!directory.join("Custom group").exists());assert!(!directory.join("Renamed").exists());
}
#[tokio::test]
async fn ambiguous_imports_are_visible_and_cannot_install_over_existing_files(){
 let (root,state)=setup().await;let directory=root.path().join("Existing/Unknown");std::fs::create_dir_all(&directory).unwrap();std::fs::write(directory.join("server.properties"),"motd=Original").unwrap();std::fs::write(directory.join("one.jar"),"first").unwrap();std::fs::write(directory.join("two.jar"),"second").unwrap();
 let value=super::library::synchronize(&state,Some(root.path().join("Existing").to_string_lossy().into_owned())).await.unwrap();assert_eq!(value.servers.len(),1);let s=&value.servers[0];assert!(!s.installed);assert_eq!(s.presentation["readiness"],"needs_setup");assert!(super::providers::install(&crate::host::Host::silent(),&state,&s.id).await.is_err());let error=super::runtime::start(&crate::host::Host::silent(),&state,&s.id,&[]).await.err().unwrap();assert!(error.to_string().contains("requires configuration"));assert_eq!(std::fs::read_to_string(directory.join("server.properties")).unwrap(),"motd=Original");assert!(!directory.join("eula.txt").exists());assert!(!directory.join("server.jar").exists());
 std::fs::rename(&directory,directory.with_file_name("Moved")).unwrap();let updated=super::library::synchronize(&state,None).await.unwrap();assert!(updated.servers.iter().any(|profile|profile.id==s.id&&profile.presentation["readiness"]=="missing"));
}
#[tokio::test]
async fn logical_server_groups_and_order_never_move_running_server_files(){
 let (_root,state)=setup().await;let first=store::create(&state,request(None)).await.unwrap();let mut other=request(None);other.folder="second".into();let second=store::create(&state,other).await.unwrap();
 store::set_status(&state,&first.id,"installing").await.unwrap();super::library::edit_group(&state,"create",None,Some("Logical".into()),None).await.unwrap();let group=super::library::collections(&state).await.unwrap().pop().unwrap();super::library::organize(&state,&first.id,Some(group.id.clone()),None).await.unwrap();super::library::organize(&state,&second.id,Some(group.id.clone()),Some(first.id.clone())).await.unwrap();
 let a=store::get(&state,&first.id).await.unwrap();let b=store::get(&state,&second.id).await.unwrap();super::library::save_icon(&state,&first.id,serde_json::json!({"key":"coffee","background":"#123456","foreground":"#ffffff"}),Some("Display name".into())).await.unwrap();let renamed=store::get(&state,&first.id).await.unwrap();assert_eq!(renamed.name,"Display name");assert_eq!(renamed.presentation["icon"]["key"],"coffee");assert!(!Path::new(&renamed.path).join("server-icon.png").exists());assert_eq!(a.path,first.path);assert!(Path::new(&a.path).is_dir());assert!(b.presentation["sortOrder"].as_i64().unwrap()<a.presentation["sortOrder"].as_i64().unwrap());assert!(!Path::new(&first.path).parent().unwrap().join("Logical").exists());
}

#[tokio::test]
async fn library_migrates_physical_groups_without_duplication_or_moves(){
 let (_root,state)=setup().await;let group=store::create_group(&state,"Legacy group",None).await.unwrap();let server=store::create(&state,request(Some(group.id.clone()))).await.unwrap();std::fs::write(Path::new(&server.path).join("server.properties"),"motd=Preserved").unwrap();
 sqlx::raw_sql("DROP TABLE server_library_entries;DROP TABLE server_collections;").execute(&state.database).await.unwrap();sqlx::raw_sql(include_str!("../../migrations/0023_server_library.sql")).execute(&state.database).await.unwrap();
 let result=super::library::synchronize(&state,None).await.unwrap();assert_eq!(result.collections.len(),1);assert_eq!(result.collections[0].id,group.id);assert_eq!(result.servers[0].presentation["collectionId"],group.id);assert_eq!(result.servers[0].path,server.path);assert_eq!(std::fs::read_to_string(Path::new(&server.path).join("server.properties")).unwrap(),"motd=Preserved");
 assert!(super::library::synchronize(&state,Some(Path::new(&server.path).join("server.properties").to_string_lossy().into_owned())).await.is_err());assert!(store::defaults(&state).await.unwrap().directory.is_none());
}


#[tokio::test]
async fn server_settings_read_disk_and_restore_missing_form_keys_without_writing() {
    let (_root, state) = setup().await;
    let server = store::create(&state, request(None)).await.unwrap();
    let mut config = server.config.clone();
    config.properties.remove("white-list");
    sqlx::query("UPDATE local_servers SET config_json=? WHERE id=?").bind(serde_json::to_string(&config).unwrap()).bind(&server.id).execute(&state.database).await.unwrap();
    let path = Path::new(&server.path).join("server.properties");
    let text = "# external edit\nwhite-list=TRUE\npvp=false\nmotd=TRUE\ncustom-plugin-option=keep\n";
    std::fs::write(&path, text).unwrap();
    let loaded = store::read_config(&state, &server.id).await.unwrap();
    assert_eq!(loaded.config.properties["white-list"], "true");
    assert_eq!(loaded.config.properties["pvp"], "false");
    assert_eq!(loaded.config.properties["motd"], "TRUE");
    assert!(loaded.properties_revision.is_some());
    assert_eq!(std::fs::read_to_string(path).unwrap(), text);
}
#[tokio::test]
async fn stale_settings_cannot_overwrite_external_edits() {
    let (_root, state) = setup().await;
    let server = store::create(&state, request(None)).await.unwrap();
    let loaded = store::read_config(&state, &server.id).await.unwrap();
    let path = Path::new(&server.path).join("server.properties");
    let changed = "white-list=true\ncustom-option=preserved\n";
    std::fs::write(&path, changed).unwrap();
    assert!(store::update_checked(&state, &server.id, &server.name, loaded.config, loaded.properties_revision.as_deref()).await.is_err());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), changed);
    let fresh = store::read_config(&state, &server.id).await.unwrap();
    let updated = store::update_checked(&state, &server.id, &server.name, fresh.config, fresh.properties_revision.as_deref()).await.unwrap();
    assert_eq!(updated.config.properties["white-list"], "true");
    assert!(std::fs::read_to_string(path).unwrap().contains("custom-option=preserved"));
}
#[tokio::test]
async fn deletion_removes_only_confirmed_server_without_backup() {
    let (_root, state) = setup().await;
    let server = store::create(&state, request(None)).await.unwrap();
    let path = Path::new(&server.path);
    std::fs::create_dir(path.join("world")).unwrap();
    std::fs::write(path.join("world/level.dat"), b"world").unwrap();
    sqlx::query("INSERT INTO server_content VALUES (?,?,?,?,?,?,?)").bind(&server.id).bind("modrinth").bind("plugin").bind("v1").bind("Plugin").bind("plugin.jar").bind("hash").execute(&state.database).await.unwrap();
    assert!(store::delete(&state, &server.id, "wrong path").await.is_err());
    store::delete(&state, &server.id, &server.path).await.unwrap();
    assert!(!path.exists());
    assert!(store::get(&state, &server.id).await.is_err());
    assert!(!state.paths.backups.join("local-servers").exists());
}
#[tokio::test]
async fn deletion_rejects_running_servers_nested_servers_and_launcher_data() {
    let (_root, state) = setup().await;
    let server = store::create(&state, request(None)).await.unwrap();
    store::set_status(&state, &server.id, "running").await.unwrap();
    assert!(store::delete(&state, &server.id, &server.path).await.is_err());
    store::set_status(&state, &server.id, "stopped").await.unwrap();
    let mut other = request(None); other.name = "Other".into(); other.folder = "other".into();
    let other = store::create(&state, other).await.unwrap();
    let nested = Path::new(&server.path).join("nested"); std::fs::create_dir(&nested).unwrap();
    sqlx::query("UPDATE local_servers SET path=?,data_relative=NULL WHERE id=?").bind(nested.to_string_lossy().as_ref()).bind(&other.id).execute(&state.database).await.unwrap();
    assert!(store::delete(&state, &server.id, &server.path).await.is_err());
    assert!(Path::new(&server.path).exists());
    sqlx::query("UPDATE local_servers SET path=?,data_relative=NULL WHERE id=?").bind(state.paths.data.to_string_lossy().as_ref()).bind(&server.id).execute(&state.database).await.unwrap();
    assert!(store::delete(&state, &server.id, state.paths.data.to_string_lossy().as_ref()).await.is_err());
    assert!(state.paths.data.join("app.db").exists());
}


#[tokio::test]
async fn players_lists_roundtrip_preserve_identity_permissions_and_unknown_fields() {
    use super::players::{self, PlayerEdit};
    let (_root, state) = setup().await;
    let mut req = request(None); req.config.properties.insert("online-mode".into(), "false".into());
    let server = store::create(&state, req).await.unwrap();
    let first = players::list(&state, &server.id).await.unwrap();
    let edit = |kind: &str, action: &str, name: &str, id: Option<String>, revision: String| PlayerEdit {
        kind: kind.into(), action: action.into(), name: name.into(), uuid: id, identity_provider: None, level: Some(3), reason: Some("Test reason".into()), expected_revision: revision,
    };
    let list = players::edit(&state, &server.id, edit("whitelist", "add", "Notch", None, first.revisions["whitelist"].clone())).await.unwrap();
    let id = crate::accounts::offline_uuid("Notch").to_string();
    assert_eq!(list.whitelist[0]["uuid"], id);
    let mut list = players::edit(&state, &server.id, edit("operators", "add", "Notch", Some(id.clone()), list.revisions["operators"].clone())).await.unwrap();
    assert_eq!(list.operators[0]["level"], 3);
    assert_eq!(list.operators[0]["bypassesPlayerLimit"], false);
    let path = Path::new(&server.path).join("ops.json");
    list.operators[0]["custom"] = serde_json::json!("keep"); list.operators[0]["bypassesPlayerLimit"] = serde_json::json!(true);
    std::fs::write(&path, serde_json::to_vec(&list.operators).unwrap()).unwrap();
    let list = players::list(&state, &server.id).await.unwrap();
    let list = players::edit(&state, &server.id, edit("operators", "add", "Notch", Some(id.clone()), list.revisions["operators"].clone())).await.unwrap();
    assert_eq!(list.operators.len(), 1); assert_eq!(list.operators[0]["custom"], "keep"); assert_eq!(list.operators[0]["bypassesPlayerLimit"], true);
    let list = players::edit(&state, &server.id, edit("bannedPlayers", "add", "Notch", Some(id.clone()), list.revisions["bannedPlayers"].clone())).await.unwrap();
    assert_eq!(list.banned_players[0]["reason"], "Test reason"); assert_eq!(list.banned_players[0]["expires"], "forever");
    let list = players::edit(&state, &server.id, edit("bannedIps", "add", "2001:0db8::1", None, list.revisions["bannedIps"].clone())).await.unwrap();
    assert_eq!(list.banned_ips[0]["ip"], "2001:db8::1");
    let list = players::edit(&state, &server.id, edit("whitelist", "remove", "Notch", Some(id), list.revisions["whitelist"].clone())).await.unwrap();
    assert!(list.whitelist.is_empty());
}

#[tokio::test]
async fn explicit_offline_player_uses_offline_identity_even_with_cached_online_profile() {
    use super::players::{self, PlayerEdit};
    let (_root, state) = setup().await;
    let server = store::create(&state, request(None)).await.unwrap();
    std::fs::write(Path::new(&server.path).join("usercache.json"), r#"[{"name":"Alex","uuid":"00000000-0000-4000-8000-000000000001"}]"#).unwrap();
    let list = players::edit(&state, &server.id, PlayerEdit {
        kind: "operators".into(), action: "add".into(), name: "Alex".into(), uuid: None,
        identity_provider: Some("offline".into()), level: Some(4), reason: None, expected_revision: "missing".into(),
    }).await.unwrap();
    assert_eq!(list.operators[0]["uuid"], crate::accounts::offline_uuid("Alex").to_string());
    assert_eq!(list.operators[0]["name"], "Alex");
}

#[tokio::test]
async fn players_lists_reject_stale_corrupt_running_and_invalid_edits() {
    use super::players::{self, PlayerEdit};
    let (_root, state) = setup().await;
    let server = store::create(&state, request(None)).await.unwrap();
    let edit = |kind: &str, name: &str, revision: &str| PlayerEdit { kind: kind.into(), action: "add".into(), name: name.into(), uuid: Some(crate::accounts::offline_uuid("Test").to_string()), identity_provider: None, level: Some(4), reason: None, expected_revision: revision.into() };
    let path = Path::new(&server.path).join("whitelist.json");
    std::fs::write(&path, "[]").unwrap();
    assert!(players::edit(&state, &server.id, edit("whitelist", "Test", "missing")).await.is_err());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "[]");
    let list = players::list(&state, &server.id).await.unwrap();
    assert!(players::edit(&state, &server.id, edit("../ops", "Test", "missing")).await.is_err());
    assert!(players::edit(&state, &server.id, edit("whitelist", "Bad\nstop", &list.revisions["whitelist"])).await.is_err());
    assert!(players::edit(&state, &server.id, edit("bannedIps", "host.example.com", "missing")).await.is_err());
    store::set_status(&state, &server.id, "starting").await.unwrap();
    assert!(players::edit(&state, &server.id, edit("operators", "Test", "missing")).await.is_err());
    assert!(!Path::new(&server.path).join("ops.json").exists());
    store::set_status(&state, &server.id, "stopped").await.unwrap();
    std::fs::write(&path, "broken json").unwrap();
    assert!(players::list(&state, &server.id).await.is_err());
    assert!(players::edit(&state, &server.id, edit("whitelist", "Test", "missing")).await.is_err());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "broken json");
}

#[tokio::test]
async fn live_players_use_host_commands_and_wait_for_server_persistence() {
    use super::{host, players::{self, PlayerEdit}, runtime};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let (_root, state) = setup().await;
    let server = store::create(&state, request(None)).await.unwrap();
    let properties = Path::new(&server.path).join("server.properties");
    let original = "# custom operator default\nop-permission-level: 2\nforeign-setting=keep\n";
    std::fs::write(&properties, original).unwrap();
    assert_eq!(players::list(&state, &server.id).await.unwrap().operator_level, 2);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let run_file = runtime::run_file(&state, &server.id);
    std::fs::create_dir_all(run_file.parent().unwrap()).unwrap();
    let info = host::RunInfo { server_id: server.id.clone(), host_pid: 0, java_pid: 0, java_started: 0,
        endpoint: listener.local_addr().unwrap().to_string(), token: "test-only".into(), state: "running".into(), exit_code: None, error: None };
    std::fs::write(&run_file, serde_json::to_vec(&info).unwrap()).unwrap();
    let path = Path::new(&server.path).join("whitelist.json");
    let output = path.clone();
    let host = tokio::spawn(async move {
        let mut commands = vec![];
        loop {
            let (socket, _) = listener.accept().await.unwrap();
            let mut socket = BufReader::new(socket);
            let mut line = String::new(); socket.read_line(&mut line).await.unwrap();
            let request: host::Request = serde_json::from_str(&line).unwrap();
            assert_eq!(request.token, "test-only");
            if request.action == "command" {
                commands.push(request.command.clone());
                assert_eq!(request.command, "whitelist add Alex");
                // Only the simulated Minecraft process writes the cached list.
                assert!(!output.exists());
                std::fs::write(&output, serde_json::to_vec(&serde_json::json!([{
                    "name":"Alex", "uuid":crate::accounts::offline_uuid("Alex").to_string(), "fromServer":true
                }])).unwrap()).unwrap();
            }
            let snapshot = host::HostSnapshot { run_id: None, state: "running".into(), lines: vec![], last_seq: 0, exit_code: None, error: None };
            socket.get_mut().write_all(format!("{}\n", serde_json::to_string(&snapshot).unwrap()).as_bytes()).await.unwrap();
            if !commands.is_empty() { return commands; }
        }
    });
    let result = players::edit(&state, &server.id, PlayerEdit { kind: "whitelist".into(), action: "add".into(), name: "Alex".into(), uuid: None, identity_provider: None, level: None, reason: None, expected_revision: "missing".into() }).await.unwrap();
    assert_eq!(result.whitelist[0]["fromServer"], true);
    assert_eq!(host.await.unwrap(), ["whitelist add Alex"]);
    assert!(path.exists());
    assert_eq!(std::fs::read_to_string(properties).unwrap(), original);
}

#[tokio::test]
async fn memory_can_be_saved_while_running_without_touching_server_files() {
    let (_root, state) = setup().await;
    let server = store::create(&state, request(None)).await.unwrap();
    let path = Path::new(&server.path).join("server.properties");
    let original = std::fs::read(&path).unwrap();
    let plan = store::load_plan(&state, &server.id).await.unwrap();
    store::set_status(&state, &server.id, "running").await.unwrap();
    let saved = store::update_memory(&state, &server.id, 128, 2048).await.unwrap();
    assert_eq!(saved.config.memory_min_mb, 128);
    assert_eq!(saved.config.memory_max_mb, 2048);
    assert_eq!(saved.status, "running");
    assert_eq!(std::fs::read(&path).unwrap(), original);
    assert_eq!(serde_json::to_value(store::load_plan(&state, &server.id).await.unwrap()).unwrap(), serde_json::to_value(plan).unwrap());
    assert!(store::update_memory(&state, &server.id, 127, 2048).await.is_err());
    assert!(store::update_memory(&state, &server.id, 4096, 2048).await.is_err());
    assert!(store::update_memory(&state, &server.id, 128, 1_048_577).await.is_err());
    assert_eq!(store::get(&state, &server.id).await.unwrap().config.memory_max_mb, 2048);
}

#[tokio::test]
async fn access_change_waits_for_startup_and_accepts_empty_list_initialization() {
    use super::{host, players::{self, PlayerEdit}, runtime};
    use std::sync::{Arc, atomic::{AtomicBool, AtomicUsize, Ordering}};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let (_root, state) = setup().await;
    let server = store::create(&state, request(None)).await.unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let descriptor = runtime::run_file(&state, &server.id);
    std::fs::create_dir_all(descriptor.parent().unwrap()).unwrap();
    let info = host::RunInfo { server_id: server.id.clone(), host_pid: 0, java_pid: 0, java_started: 0,
        endpoint: listener.local_addr().unwrap().to_string(), token: "startup-test".into(), state: "starting".into(), exit_code: None, error: None };
    std::fs::write(&descriptor, serde_json::to_vec(&info).unwrap()).unwrap();
    store::set_status(&state, &server.id, "starting").await.unwrap();
    let ready = Arc::new(AtomicBool::new(false)); let commands = Arc::new(AtomicUsize::new(0));
    let flag = ready.clone(); let count = commands.clone();
    let path = Path::new(&server.path).join("whitelist.json"); let output = path.clone();
    let host_task = tokio::spawn(async move {
        loop {
            let (socket, _) = listener.accept().await.unwrap(); let mut socket = BufReader::new(socket);
            let mut text = String::new(); socket.read_line(&mut text).await.unwrap();
            let request: host::Request = serde_json::from_str(&text).unwrap();
            let is_command = request.action == "command";
            if is_command {
                assert!(flag.load(Ordering::SeqCst)); assert_eq!(request.command, "whitelist add Alex");
                count.fetch_add(1, Ordering::SeqCst);
                std::fs::write(&output, serde_json::to_vec(&serde_json::json!([{"name":"Alex", "uuid":crate::accounts::offline_uuid("Alex").to_string()}])).unwrap()).unwrap();
            }
            let snapshot = host::HostSnapshot { run_id: None, state: if flag.load(Ordering::SeqCst) { "running" } else { "starting" }.into(), lines: vec![], last_seq: 0, exit_code: None, error: None };
            socket.get_mut().write_all(format!("{}\n", serde_json::to_string(&snapshot).unwrap()).as_bytes()).await.unwrap();
            if is_command { break; }
        }
    });
    let edit = players::edit(&state, &server.id, PlayerEdit { kind: "whitelist".into(), action: "add".into(), name: "Alex".into(), uuid: None, identity_provider: None, level: None, reason: None, expected_revision: "missing".into() });
    let finish_startup = async {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        assert_eq!(commands.load(Ordering::SeqCst), 0);
        std::fs::write(&path, "[]").unwrap(); ready.store(true, Ordering::SeqCst);
    };
    let (result, _) = tokio::join!(edit, finish_startup);
    assert_eq!(result.unwrap().whitelist[0]["name"], "Alex");
    host_task.await.unwrap(); assert_eq!(commands.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn world_setting_goes_through_host_and_returns_only_new_output() {
    use super::{host, live, runtime};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let (_root, state) = setup().await;
    let server = store::create(&state, request(None)).await.unwrap();
    let properties = Path::new(&server.path).join("server.properties");
    let original = std::fs::read(&properties).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let descriptor = runtime::run_file(&state, &server.id);
    std::fs::create_dir_all(descriptor.parent().unwrap()).unwrap();
    let info = host::RunInfo { server_id: server.id.clone(), host_pid: 0, java_pid: 0, java_started: 0,
        endpoint: listener.local_addr().unwrap().to_string(), token: "live-test".into(), state: "running".into(), exit_code: None, error: None };
    std::fs::write(&descriptor, serde_json::to_vec(&info).unwrap()).unwrap();
    let host_task = tokio::spawn(async move {
        let mut applied = false;
        loop {
            let (socket, _) = listener.accept().await.unwrap(); let mut socket = BufReader::new(socket);
            let mut text = String::new(); socket.read_line(&mut text).await.unwrap();
            let request: host::Request = serde_json::from_str(&text).unwrap();
            assert_eq!(request.token, "live-test");
            if request.action == "command" { assert_eq!(request.command, "difficulty hard"); applied = true; }
            let reply = applied && request.action == "status" && request.cursor == 7;
            let lines = if reply { vec![host::ServerLine { seq: 8, text: "Difficulty changed by server".into(), stream: "stdout".into(), timestamp: "test".into() }] } else { vec![] };
            let snapshot = host::HostSnapshot { run_id: None, state: "running".into(), lines, last_seq: if applied { 8 } else { 7 }, exit_code: None, error: None };
            socket.get_mut().write_all(format!("{}\n", serde_json::to_string(&snapshot).unwrap()).as_bytes()).await.unwrap();
            if reply { break; }
        }
    });
    let result = live::apply(&state, &server.id, live::LiveEdit { kind: "difficulty".into(), value: "hard".into(), rule: None }).await.unwrap();
    assert_eq!(result.command, "difficulty hard");
    assert_eq!(result.lines, ["Difficulty changed by server"]);
    assert_eq!(std::fs::read(&properties).unwrap(), original);
    host_task.await.unwrap();
}

#[tokio::test]
async fn leaf_catalog_pins_channels_and_download_checksums_and_discovers_existing_servers() {
    use super::{providers, discovery};
    let (root, state) = setup().await;
    let data = serde_json::json!({"builds":[{"build":5,"channel":"default"},{"build":8,"channel":"experimental"},{"build":7,"channel":"unknown"}]});
    let builds = providers::leaf_builds(&data, 25);
    assert_eq!(builds[0].id, "8"); assert!(!builds[0].stable); assert!(!builds[1].stable); assert!(builds[2].stable); assert_eq!(builds[0].java_major, 25);
    let metadata = serde_json::json!({"downloads":{"primary":{"name":"leaf-26.3-8.jar","sha256":"a".repeat(64)}}});
    let (url, hash) = providers::leaf_download(&metadata, "26.3", "8").unwrap();
    assert_eq!(url, "https://api.leafmc.one/v2/projects/leaf/versions/26.3/builds/8/downloads/leaf-26.3-8.jar"); assert_eq!(hash, "a".repeat(64));
    let bad = serde_json::json!({"downloads":{"primary":{"name":"../bad.jar","sha256":"a".repeat(64)}}});
    assert!(providers::leaf_download(&bad, "26.3", "8").is_err());
    let mut config = ServerConfig::default(); config.core="leaf".into(); assert!(validate(&config).is_ok());
    assert!(store::validate_server_path("leaf", &root.path().join("bad+path")).is_err());
    let folder = root.path().join("leaf-test"); std::fs::create_dir(&folder).unwrap();
    std::fs::write(folder.join("server.properties"), "white-list=true").unwrap();
    std::fs::write(folder.join("leaf-26.3-8.jar"), "fixture").unwrap();
    std::fs::write(folder.join("leaf.yml"), "{}").unwrap();
    let server = discovery::connect(&state, folder.to_string_lossy().into_owned(), None).await.unwrap();
    assert_eq!(server.config.core, "leaf");
}
#[cfg(target_os = "macos")]
#[test]
fn macos_system_temp_aliases_allow_real_files_but_reject_nested_symlinks() {
    let root = tempfile::tempdir().unwrap();
    super::store::plain_path(root.path()).unwrap();
    let directory = root.path().join("actual");
    std::fs::create_dir(&directory).unwrap();
    super::store::plain_path(&directory.join("new-file.jar")).unwrap();
    let linked = root.path().join("linked");
    std::os::unix::fs::symlink(&directory, &linked).unwrap();
    assert!(super::store::plain_path(&linked.join("new-file.jar")).is_err());
}

