//! Thin native shell. The React frontend talks to `kybernd` directly over
//! WebSocket; this crate only resolves (or starts) the daemon and hands the
//! endpoint to the webview.

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use kybern_client::Endpoint;
use serde::Serialize;
use tauri::Manager;

#[derive(Debug, Clone, Serialize)]
pub struct EndpointInfo {
    /// WebSocket URL, e.g. `ws://127.0.0.1:4173/ws`.
    pub url: String,
    /// HTTP origin for uploads, e.g. `http://127.0.0.1:4173`.
    pub http_base: String,
    pub token: String,
    /// True when this process started the daemon.
    pub spawned: bool,
}

fn data_dir() -> Option<PathBuf> {
    Endpoint::data_dir(std::env::var_os("KYBERN_DATA_DIR").map(PathBuf::from))
}

fn resolve() -> Result<Endpoint> {
    Endpoint::resolve(None, None, data_dir())
}

fn http_base(url: &str) -> String {
    url.replace("ws://", "http://").replace("wss://", "https://").trim_end_matches("/ws").to_string()
}

async fn reachable(url: &str) -> bool {
    let Some(rest) = url.split("://").nth(1) else { return false };
    let host = rest.split('/').next().unwrap_or_default();
    matches!(tokio::time::timeout(Duration::from_millis(400), tokio::net::TcpStream::connect(host)).await, Ok(Ok(_)))
}

fn daemon_binary() -> Result<PathBuf> {
    if let Some(p) = std::env::var_os("KYBERND").map(PathBuf::from) {
        if p.is_file() {
            return Ok(p);
        }
    }
    let exe = std::env::current_exe()?;
    let dir = exe.parent().context("exe dir")?;
    for name in ["kybernd", "kybernd.exe"] {
        let p = dir.join(name);
        if p.is_file() {
            return Ok(p);
        }
    }
    std::env::var_os("PATH")
        .and_then(|paths| std::env::split_paths(&paths).map(|d| d.join("kybernd")).find(|p| p.is_file()))
        .ok_or_else(|| anyhow!("kybernd not found next to the app or on PATH"))
}

fn spawn_daemon() -> Result<()> {
    let bin = daemon_binary()?;
    let root = data_dir();
    let mut cmd = std::process::Command::new(&bin);
    if let Some(r) = &root {
        std::fs::create_dir_all(r)?;
        cmd.arg("--data-dir").arg(r);
        let log = std::fs::File::create(r.join("daemon.log"))?;
        let log2 = log.try_clone()?;
        cmd.stdout(log).stderr(log2);
    } else {
        cmd.stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    }
    cmd.stdin(std::process::Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    cmd.spawn().with_context(|| format!("start {}", bin.display()))?;
    log::info!("started {}", bin.display());
    Ok(())
}

/// Resolve the daemon endpoint, starting `kybernd` when nothing is listening.
#[tauri::command]
async fn endpoint() -> Result<EndpointInfo, String> {
    async fn inner() -> Result<EndpointInfo> {
        if let Ok(ep) = resolve() {
            if reachable(&ep.url).await {
                return Ok(EndpointInfo { http_base: http_base(&ep.url), url: ep.url, token: ep.token, spawned: false });
            }
        }
        spawn_daemon()?;
        for _ in 0..100 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            if let Ok(ep) = resolve() {
                if reachable(&ep.url).await {
                    return Ok(EndpointInfo { http_base: http_base(&ep.url), url: ep.url, token: ep.token, spawned: true });
                }
            }
        }
        Err(anyhow!("kybernd started but did not come up in time"))
    }
    inner().await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
fn data_dir_path() -> Option<String> {
    data_dir().map(|p| p.display().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())?;
            }
            if let Some(w) = app.get_webview_window("main") {
                if std::env::var_os("KYBERN_NO_ACTIVATE").is_none() {
                    let _ = w.set_focus();
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![endpoint, data_dir_path])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
