fn main() {
    let build_unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock is before the Unix epoch")
        .as_secs();
    println!("cargo:rustc-env=SLH_BUILD_UNIX={build_unix}");
    tauri_build::build()
}
