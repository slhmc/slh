#[tokio::main]
async fn main() {
    if let Err(error)=slh_core::local_servers::host::entry().await {
        eprintln!("{error}");std::process::exit(1);
    }
}
