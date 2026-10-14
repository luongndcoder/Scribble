//! Standalone runner for the Rust backend.
//!
//! Serves exactly the router that task-6 will mount inside the Tauri process,
//! so the HTTP contract can be diffed against the Python sidecar during
//! migration:
//!
//! ```text
//! VOICESCRIBE_DATA=/tmp/x SIDECAR_PORT=8902 cargo run --example api_server
//! ```

#[tokio::main]
async fn main() {
    env_logger_init();

    let port: u16 = std::env::var("SIDECAR_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8765);

    let db_path = std::env::var("VOICESCRIBE_DB").ok().map(std::path::PathBuf::from);

    let router = match db_path {
        Some(p) => voicescribe_lib::api::build_router_at(p),
        None => voicescribe_lib::api::build_router_with_default_db(),
    };

    let router = match router {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[api] database init failed: {e}");
            std::process::exit(1);
        }
    };

    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    if let Err(e) = voicescribe_lib::api::serve(router, addr).await {
        eprintln!("[api] {e}");
        std::process::exit(1);
    }
}

/// Minimal logger so `log::info!`/`warn!` reach stderr without pulling in
/// env_logger as a dependency of the library.
fn env_logger_init() {
    struct StderrLogger;

    impl log::Log for StderrLogger {
        fn enabled(&self, _: &log::Metadata) -> bool {
            true
        }
        fn log(&self, record: &log::Record) {
            eprintln!("{} {}", record.level(), record.args());
        }
        fn flush(&self) {}
    }

    static LOGGER: StderrLogger = StderrLogger;
    let _ = log::set_logger(&LOGGER);
    log::set_max_level(log::LevelFilter::Info);
}
