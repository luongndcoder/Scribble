//! On-demand download of optional local STT models (Nemotron 3.5 streaming).
//!
//! The bundled Zipformer ships inside the app; Nemotron (~683 MB) is fetched
//! only when the user picks it in Settings. Files land in
//! `<data dir>/models/<package dir>/`. Each file is written to `*.part` and
//! renamed only when complete, so a cancelled or failed download can never
//! look like a usable model.

use std::path::PathBuf;
use std::sync::Mutex;

use futures_util::StreamExt;
use tokio::io::AsyncWriteExt;

/// A downloadable model package.
pub struct Package {
    /// Directory name under `<data dir>/models/`.
    pub dir: &'static str,
    base_url: &'static str,
    /// Files with approximate sizes (bytes) — sizes only weight the progress
    /// bar; the real length comes from the response.
    files: &'static [(&'static str, u64)],
    pub size_mb: u64,
    pub display_name: &'static str,
    /// MLX only: also fetch the Metal shader library from this app version's
    /// GitHub Release (it must match the MLX compiled into the binary).
    pub with_metallib: bool,
}

/// sherpa-onnx export of `nvidia/nemotron-3.5-asr-streaming-0.6b`, 560 ms
/// chunks, int8 (licence: OpenMDW-1.1). Every platform without MLX.
pub const ONNX_PACKAGE: Package = Package {
    dir: "nemotron-3.5-560ms-int8",
    base_url: "https://huggingface.co/csukuangfj2/\
sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-int8-2026-06-11/resolve/main",
    files: &[
        ("tokens.txt", 131_000),
        ("decoder.int8.onnx", 15_000_000),
        ("joiner.int8.onnx", 9_500_000),
        ("encoder.int8.onnx", 657_600_000),
    ],
    size_mb: 683,
    display_name: "NVIDIA Nemotron 3.5 ASR Streaming 0.6B (ONNX)",
    with_metallib: false,
};

/// `mlx-community/nemotron-3.5-asr-streaming-0.6b` (bf16) for the MLX engine —
/// macOS builds with the `mlx` feature (Apple GPU).
pub const MLX_PACKAGE: Package = Package {
    dir: "nemotron-3.5-mlx",
    base_url: "https://huggingface.co/mlx-community/nemotron-3.5-asr-streaming-0.6b/resolve/main",
    files: &[("config.json", 160_000), ("model.safetensors", 1_276_100_000)],
    size_mb: 1_217 + 174, // checkpoint + Metal shaders
    display_name: "NVIDIA Nemotron 3.5 ASR Streaming 0.6B (MLX, GPU)",
    with_metallib: true,
};

/// The Nemotron package this build runs: MLX on macOS+mlx, else ONNX.
pub fn package() -> &'static Package {
    if cfg!(all(target_os = "macos", feature = "mlx")) {
        &MLX_PACKAGE
    } else {
        &ONNX_PACKAGE
    }
}

/// Languages the Settings picker offers for Nemotron (subset of its 40
/// locales that the UI has labels for) plus auto-detect.
pub const NEMOTRON_LANGUAGES: &[&str] = &[
    "auto", "vi", "en", "zh", "ja", "ko", "fr", "de", "es", "th", "id", "ru", "pt", "it",
];

#[derive(Debug, Clone, serde::Serialize)]
pub struct DownloadState {
    /// `idle` | `downloading` | `done` | `error`
    pub status: &'static str,
    pub progress: f64,
    pub error: Option<String>,
}

static STATE: Mutex<DownloadState> = Mutex::new(DownloadState {
    status: "idle",
    progress: 0.0,
    error: None,
});

fn set_state(status: &'static str, progress: f64, error: Option<String>) {
    if let Ok(mut s) = STATE.lock() {
        *s = DownloadState { status, progress, error };
    }
}

pub fn download_state() -> DownloadState {
    STATE.lock().map(|s| s.clone()).unwrap_or(DownloadState {
        status: "idle",
        progress: 0.0,
        error: None,
    })
}

/// `<data dir>/models/<package dir>` (whether or not it exists yet).
pub fn nemotron_target_dir() -> PathBuf {
    crate::db::default_data_dir().join("models").join(package().dir)
}

/// The Nemotron model dir when every file is fully downloaded.
pub fn nemotron_model_dir() -> Option<PathBuf> {
    let complete = |dir: &std::path::Path| package_files(package()).iter().all(|(f, _, _)| dir.join(f).is_file());
    if let Ok(p) = std::env::var("VOICESCRIBE_NEMOTRON_DIR") {
        let p = PathBuf::from(p);
        if complete(&p) {
            return Some(p);
        }
    }
    let dir = nemotron_target_dir();
    complete(&dir).then_some(dir)
}

/// Metal shader library for THIS app version (built with the MLX inside the
/// binary). `SCRIBBLE_METALLIB_URL` overrides it for testing.
pub fn metallib_url() -> String {
    std::env::var("SCRIBBLE_METALLIB_URL").unwrap_or_else(|_| {
        format!(
            "https://github.com/luongndcoder/Scribble/releases/download/v{}/mlx.metallib",
            env!("CARGO_PKG_VERSION")
        )
    })
}

/// `(file name, url, approx bytes)` for every file of `pkg`.
fn package_files(pkg: &Package) -> Vec<(String, String, u64)> {
    let mut v: Vec<(String, String, u64)> = pkg
        .files
        .iter()
        .map(|(f, s)| (f.to_string(), format!("{}/{f}", pkg.base_url), *s))
        .collect();
    if pkg.with_metallib {
        v.push(("mlx.metallib".to_string(), metallib_url(), 182_000_000));
    }
    v
}

/// Start the Nemotron download in the background (no-op if already running or
/// already present). Returns the state right after the call.
pub fn start_nemotron_download() -> DownloadState {
    if nemotron_model_dir().is_some() {
        set_state("done", 1.0, None);
        return download_state();
    }
    {
        let Ok(mut s) = STATE.lock() else { return download_state() };
        if s.status == "downloading" {
            return s.clone();
        }
        *s = DownloadState { status: "downloading", progress: 0.0, error: None };
    }
    tokio::spawn(async {
        match download_all().await {
            Ok(()) => set_state("done", 1.0, None),
            Err(e) => {
                log::warn!("[model-download] FAILED: nemotron: {e}");
                let p = download_state().progress;
                set_state("error", p, Some(e));
            }
        }
    });
    download_state()
}

async fn download_all() -> Result<(), String> {
    let dir = nemotron_target_dir();
    tokio::fs::create_dir_all(&dir).await.map_err(|e| format!("create {dir:?}: {e}"))?;
    let files = package_files(package());
    let total: u64 = files.iter().map(|(_, _, s)| s).sum();
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;

    let mut done_before: u64 = 0;
    for (name, url, approx) in &files {
        let dest = dir.join(name);
        if dest.is_file() {
            done_before += approx;
            continue;
        }
        let part = dir.join(format!("{name}.part"));
        let resp = client
            .get(url)
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| format!("{name}: {e}"))?;
        let len = resp.content_length().unwrap_or(*approx).max(1);
        let mut file = tokio::fs::File::create(&part).await.map_err(|e| format!("{part:?}: {e}"))?;
        let mut got: u64 = 0;
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("{name}: {e}"))?;
            file.write_all(&chunk).await.map_err(|e| format!("{part:?}: {e}"))?;
            got += chunk.len() as u64;
            let file_share = (got as f64 / len as f64).min(1.0) * *approx as f64;
            set_state("downloading", ((done_before as f64 + file_share) / total as f64).min(0.999), None);
        }
        file.flush().await.map_err(|e| e.to_string())?;
        drop(file);
        tokio::fs::rename(&part, &dest).await.map_err(|e| format!("rename {name}: {e}"))?;
        done_before += approx;
    }
    log::info!("[model-download] COMPLETED: nemotron -> {}", dir.display());
    Ok(())
}
