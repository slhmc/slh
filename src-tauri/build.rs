fn main() {
    let build_unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock is before the Unix epoch")
        .as_secs();
    println!("cargo:rustc-env=SLH_BUILD_UNIX={build_unix}");
    let root = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap())
        .parent()
        .unwrap()
        .to_path_buf();
    let name = if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        "slh-server-host.exe"
    } else {
        "slh-server-host"
    };
    let target = std::env::var("TARGET").unwrap();
    let host = root.join(".generated/server-host").join(&target).join(name);
    if !host.is_file() {
        let status = std::process::Command::new("node")
            .arg(root.join("scripts/build-server-host.mjs"))
            .arg("--target")
            .arg(&target)
            .current_dir(&root)
            .status()
            .expect("build server-host");
        assert!(status.success(), "server-host build failed");
    }
    println!("cargo:rustc-env=SLH_SERVER_HOST_PATH={}", host.display());
    println!("cargo:rerun-if-changed={}", host.display());
    tauri_build::build()
}
