//! Thin native shell. The React frontend talks to `kybernd` directly over
//! WebSocket; this crate only resolves (or starts) the daemon and hands the
//! endpoint to the webview.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow};
use kybern_client::{Client, Endpoint};
use kybern_protocol::PROTOCOL_VERSION;
use kybern_protocol::methods::{DaemonInfo, DaemonInfoMethod, DaemonShutdown, Empty};
use serde::{Deserialize, Serialize};
use tauri::Manager;

mod environments;
mod notifications;

static ENDPOINT_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static STARTING_ENDPOINT: tokio::sync::Mutex<Option<StartingEndpoint>> = tokio::sync::Mutex::const_new(None);
static STARTUP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

const STARTUP_ANNOUNCEMENT_TIMEOUT: Duration = Duration::from_secs(10);
const STARTUP_ANNOUNCEMENT_POLL: Duration = Duration::from_millis(10);

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

#[derive(Debug, Deserialize)]
struct DaemonStartupAnnouncement {
    port: u16,
    protocol_version: u32,
    version: String,
}

struct StartupAnnouncementFile {
    path: PathBuf,
}

struct StartingEndpoint {
    endpoint: EndpointInfo,
    announced_at: Instant,
    child: Option<std::process::Child>,
}

impl Drop for StartupAnnouncementFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn fresh_starting_endpoint(starting: &mut Option<StartingEndpoint>) -> Result<Option<EndpointInfo>> {
    match starting {
        Some(candidate) if candidate.announced_at.elapsed() < STARTUP_ANNOUNCEMENT_TIMEOUT => {
            if let Some(child) = &mut candidate.child
                && let Some(status) = child.try_wait()?
            {
                *starting = None;
                return Err(anyhow!("kybernd exited during startup with {status}"));
            }
            Ok(Some(candidate.endpoint.clone()))
        }
        Some(_) => {
            *starting = None;
            Ok(None)
        }
        None => Ok(None),
    }
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

fn new_startup_announcement(root: &Path) -> (String, StartupAnnouncementFile) {
    let timestamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    let sequence = STARTUP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let id = format!("{}-{timestamp}-{sequence}", std::process::id());
    let path = root.join(format!(".desktop-startup-{id}.json"));
    (id, StartupAnnouncementFile { path })
}

async fn wait_for_startup_announcement(path: &Path, child: &mut std::process::Child) -> Result<DaemonStartupAnnouncement> {
    let deadline = tokio::time::Instant::now() + STARTUP_ANNOUNCEMENT_TIMEOUT;
    let mut last_parse_error = None;
    loop {
        match std::fs::read(path) {
            Ok(contents) => match serde_json::from_slice(&contents) {
                Ok(announcement) => return Ok(announcement),
                Err(error) => last_parse_error = Some(error),
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error).with_context(|| format!("read startup announcement at {}", path.display())),
        }

        if let Some(status) = child.try_wait()? {
            return Err(anyhow!("kybernd exited before announcing its startup endpoint with {status}"));
        }
        if tokio::time::Instant::now() >= deadline {
            let detail = last_parse_error.map_or_else(String::new, |error| format!(": {error}"));
            return Err(anyhow!("kybernd did not announce its startup endpoint in time{detail}"));
        }
        tokio::time::sleep(STARTUP_ANNOUNCEMENT_POLL).await;
    }
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
    ensure_protocol_compatible(info.protocol_version)?;
    if info.version != env!("CARGO_PKG_VERSION") {
        log::warn!("using compatible kybernd {} with desktop {}", info.version, env!("CARGO_PKG_VERSION"));
    }
    Ok(())
}

fn ensure_protocol_compatible(protocol_version: u32) -> Result<()> {
    if protocol_version != PROTOCOL_VERSION {
        return Err(anyhow!(
            "kybernd protocol v{} is incompatible with desktop protocol v{}; stop the existing daemon and reopen kybern",
            protocol_version,
            PROTOCOL_VERSION
        ));
    }
    Ok(())
}

fn endpoint_from_announcement(announcement: DaemonStartupAnnouncement, token: String) -> Result<EndpointInfo> {
    ensure_protocol_compatible(announcement.protocol_version)?;
    if announcement.port == 0 {
        return Err(anyhow!("kybernd announced an invalid startup port"));
    }
    if announcement.version != env!("CARGO_PKG_VERSION") {
        log::warn!("using compatible kybernd {} with desktop {}", announcement.version, env!("CARGO_PKG_VERSION"));
    }
    let url = format!("ws://127.0.0.1:{}/ws", announcement.port);
    Ok(EndpointInfo { http_base: http_base(&url), url, token, spawned: true })
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

fn spawn_daemon(startup_id: &str) -> Result<std::process::Child> {
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
    cmd.arg("--desktop-startup-id").arg(startup_id);
    cmd.stdin(std::process::Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let child = cmd.spawn().with_context(|| format!("start {}", bin.display()))?;
    log::info!("started {}", bin.display());
    Ok(child)
}

/// Resolve the daemon endpoint, starting `kybernd` when nothing is listening.
#[tauri::command]
async fn endpoint() -> Result<EndpointInfo, String> {
    async fn inner() -> Result<EndpointInfo> {
        // HMR or two frontend callers must not race each other into spawning
        // more than one daemon from this app process.
        let _guard = ENDPOINT_LOCK.lock().await;
        if let Some(endpoint) = fresh_starting_endpoint(&mut *STARTING_ENDPOINT.lock().await)? {
            return Ok(endpoint);
        }
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
        let root = data_dir().context("no data directory for the local daemon")?;
        std::fs::create_dir_all(&root)?;
        let (startup_id, startup_file) = new_startup_announcement(&root);
        let mut child = spawn_daemon(&startup_id)?;
        let announcement = wait_for_startup_announcement(&startup_file.path, &mut child).await?;
        let token = resolve()?.token;
        let endpoint = endpoint_from_announcement(announcement, token)?;
        *STARTING_ENDPOINT.lock().await =
            Some(StartingEndpoint { endpoint: endpoint.clone(), announced_at: Instant::now(), child: Some(child) });
        Ok(endpoint)
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
            notifications::setup();
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
        .invoke_handler(tauri::generate_handler![
            endpoint,
            data_dir_path,
            notifications::notification_permission,
            notifications::send_notification,
            environments::environments_list,
            environments::environment_open,
            environments::environment_select,
            environments::environment_save,
            environments::environment_remove,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{
        DaemonStartupAnnouncement, EndpointInfo, STARTUP_ANNOUNCEMENT_TIMEOUT, StartingEndpoint, daemon_needs_restart,
        endpoint_from_announcement, fresh_starting_endpoint,
    };
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

    #[test]
    fn startup_announcement_builds_the_pre_ready_endpoint() {
        let endpoint = endpoint_from_announcement(
            DaemonStartupAnnouncement { port: 43123, protocol_version: PROTOCOL_VERSION, version: env!("CARGO_PKG_VERSION").into() },
            "kyb_test".into(),
        )
        .unwrap();

        assert_eq!(endpoint.url, "ws://127.0.0.1:43123/ws");
        assert_eq!(endpoint.http_base, "http://127.0.0.1:43123");
        assert_eq!(endpoint.token, "kyb_test");
        assert!(endpoint.spawned);
    }

    #[test]
    fn startup_announcement_rejects_an_incompatible_protocol() {
        let error = endpoint_from_announcement(
            DaemonStartupAnnouncement { port: 43123, protocol_version: PROTOCOL_VERSION + 1, version: env!("CARGO_PKG_VERSION").into() },
            "kyb_test".into(),
        )
        .unwrap_err();

        assert!(error.to_string().contains("incompatible"));
    }

    #[test]
    fn startup_endpoint_is_reused_only_during_the_recovery_window() {
        let endpoint = EndpointInfo {
            url: "ws://127.0.0.1:43123/ws".into(),
            http_base: "http://127.0.0.1:43123".into(),
            token: "kyb_test".into(),
            spawned: true,
        };
        let mut recent = Some(StartingEndpoint { endpoint: endpoint.clone(), announced_at: std::time::Instant::now(), child: None });
        assert_eq!(fresh_starting_endpoint(&mut recent).unwrap().unwrap().url, endpoint.url);

        let mut expired =
            Some(StartingEndpoint { endpoint, announced_at: std::time::Instant::now() - STARTUP_ANNOUNCEMENT_TIMEOUT, child: None });
        assert!(fresh_starting_endpoint(&mut expired).unwrap().is_none());
        assert!(expired.is_none());
    }
}
