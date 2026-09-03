//! Thin native shell. The React frontend talks to `kybernd` directly over
//! WebSocket; this crate only resolves (or starts) the daemon and hands the
//! endpoint to the webview.

use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow};
use kybern_client::{Client, Endpoint};
use kybern_protocol::PROTOCOL_VERSION;
use kybern_protocol::methods::{DaemonInfo, DaemonInfoMethod, DaemonShutdown, Empty};
use serde::Serialize;
use tauri::Manager;

static ENDPOINT_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

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

async fn daemon_info(endpoint: &Endpoint) -> Option<DaemonInfo> {
    tokio::time::timeout(Duration::from_millis(750), async {
        let client = Client::connect(endpoint).await?;
        client.call::<DaemonInfoMethod>(Empty {}).await
    })
    .await
    .ok()?
    .ok()
}

fn ensure_compatible(info: &DaemonInfo) -> Result<()> {
    if info.protocol_version != PROTOCOL_VERSION {
        return Err(anyhow!(
            "kybernd protocol v{} is incompatible with desktop protocol v{}; stop the existing daemon and reopen kybern",
            info.protocol_version,
            PROTOCOL_VERSION
        ));
    }
    if info.version != env!("CARGO_PKG_VERSION") {
        log::warn!("using compatible kybernd {} with desktop {}", info.version, env!("CARGO_PKG_VERSION"));
    }
    Ok(())
}

fn daemon_needs_restart(info: &DaemonInfo, binary_modified: Option<SystemTime>) -> bool {
    if info.protocol_version != PROTOCOL_VERSION || info.version != env!("CARGO_PKG_VERSION") {
        return true;
    }
    let Some(modified_ms) =
        binary_modified.and_then(|time| time.duration_since(UNIX_EPOCH).ok()).and_then(|duration| i64::try_from(duration.as_millis()).ok())
    else {
        return false;
    };
    modified_ms > info.started_at.timestamp_millis()
}

async fn stop_daemon(endpoint: &Endpoint) -> Result<()> {
    tokio::time::timeout(Duration::from_secs(2), async {
        let client = Client::connect(endpoint).await?;
        client.call::<DaemonShutdown>(Empty {}).await
    })
    .await
    .context("timed out while stopping the stale daemon")??;

    for _ in 0..100 {
        if daemon_info(endpoint).await.is_none() {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Err(anyhow!("the stale daemon did not stop in time"))
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
    // Launch the bundled externalBin directly instead of through the shell
    // plugin: shell-plugin children are killed with the app, while kybernd is
    // shared by the CLI and mobile clients and intentionally outlives it.
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
    // Let the OS select an unused port for app-managed daemons. The daemon
    // records the selected port under its data directory for every client.
    if std::env::var_os("KYBERN_PORT").is_none() {
        cmd.arg("--port").arg("0");
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
        // HMR or two frontend callers must not race each other into spawning
        // more than one daemon from this app process.
        let _guard = ENDPOINT_LOCK.lock().await;
        if let Ok(ep) = resolve() {
            if let Some(info) = daemon_info(&ep).await {
                let externally_managed = std::env::var_os("KYBERN_URL").is_some();
                let binary = (!externally_managed).then(daemon_binary).transpose()?;
                let binary_modified = binary.as_ref().and_then(|path| std::fs::metadata(path).ok()?.modified().ok());
                if !externally_managed && daemon_needs_restart(&info, binary_modified) {
                    log::info!(
                        "restarting stale kybernd {} (started {}) from {}",
                        info.version,
                        info.started_at,
                        binary.as_ref().map_or_else(|| "the bundled daemon".into(), |path| path.display().to_string())
                    );
                    stop_daemon(&ep).await?;
                } else {
                    ensure_compatible(&info)?;
                    return Ok(EndpointInfo { http_base: http_base(&ep.url), url: ep.url, token: ep.token, spawned: false });
                }
            }
        }
        if std::env::var_os("KYBERN_URL").is_some() {
            return Err(anyhow!("the daemon configured by KYBERN_URL is not reachable or rejected the configured token"));
        }
        spawn_daemon()?;
        for _ in 0..100 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            if let Ok(ep) = resolve() {
                if let Some(info) = daemon_info(&ep).await {
                    ensure_compatible(&info)?;
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

#[cfg(test)]
mod tests {
    use super::daemon_needs_restart;
    use kybern_protocol::PROTOCOL_VERSION;
    use kybern_protocol::methods::DaemonInfo;
    use std::time::{Duration, UNIX_EPOCH};

    fn daemon(version: &str) -> DaemonInfo {
        DaemonInfo {
            version: version.into(),
            protocol_version: PROTOCOL_VERSION,
            environment_id: "test".into(),
            hostname: "test".into(),
            os: "test".into(),
            arch: "test".into(),
            data_dir: "/tmp/kybern-test".into(),
            scopes: vec![],
            started_at: "2026-09-04T00:00:00Z".parse().unwrap(),
        }
    }

    #[test]
    fn restarts_when_the_local_daemon_binary_was_rebuilt() {
        let rebuilt = UNIX_EPOCH + Duration::from_secs(1_788_480_001);
        assert!(daemon_needs_restart(&daemon(env!("CARGO_PKG_VERSION")), Some(rebuilt)));
    }

    #[test]
    fn keeps_the_daemon_started_after_the_local_binary() {
        let older_binary = UNIX_EPOCH + Duration::from_secs(1_788_479_999);
        assert!(!daemon_needs_restart(&daemon(env!("CARGO_PKG_VERSION")), Some(older_binary)));
    }

    #[test]
    fn restarts_a_different_daemon_version_even_without_metadata() {
        assert!(daemon_needs_restart(&daemon("0.0.0-stale"), None));
    }
}
