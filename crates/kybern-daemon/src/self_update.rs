//! The daemon's own updater. It reads the GitHub release feed, downloads the
//! archive for this platform, verifies the published checksum, swaps the
//! binary next to the running one and restarts under the service manager.
//! It runs on the maintenance cadence when `auto_update_daemon` is on, or on
//! request from a client, and only while no turn, approval, background task or
//! queued message is in flight. A daemon the desktop app started is left
//! alone: that binary lives in the app bundle and updates with the app.
use crate::state::AppState;
use anyhow::{Context, Result, anyhow, bail};
use chrono::Utc;
use kybern_protocol::{DaemonUpdate, DaemonUpdateStatus as Status};
use kybern_store::Store;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

const REPO: &str = "Tresnanda/kybern";
const META_KEY: &str = "daemon_update";
pub const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");
/// Exit status after a successful swap under systemd, so `Restart=on-failure`
/// starts the new binary.
pub const RESTART_EXIT_CODE: i32 = 75;

pub struct DaemonUpdates {
    record: Mutex<DaemonUpdate>,
    requested: AtomicBool,
    worker: tokio::sync::Mutex<()>,
}

impl DaemonUpdates {
    pub fn new(store: &Store) -> Result<Self> {
        let mut record =
            store.meta_get(META_KEY)?.and_then(|value| serde_json::from_str::<DaemonUpdate>(&value).ok()).unwrap_or_else(|| DaemonUpdate {
                status: Status::NotChecked,
                message: "Not checked yet".into(),
                current_version: CURRENT_VERSION.into(),
                latest_version: None,
                checked_at: None,
            });
        if record.current_version != CURRENT_VERSION {
            // The previous binary wrote this record; we are the update it installed.
            record = DaemonUpdate {
                status: Status::Current,
                message: format!("Updated from {}", record.current_version),
                current_version: CURRENT_VERSION.into(),
                latest_version: Some(CURRENT_VERSION.into()),
                checked_at: Some(Utc::now()),
            };
        } else if matches!(record.status, Status::Checking | Status::Waiting | Status::Updating | Status::Restarting) {
            record.status = Status::Failed;
            record.message = "The daemon restarted during an update. Retry the update.".into();
            record.checked_at = Some(Utc::now());
        }
        Ok(Self { record: Mutex::new(record), requested: AtomicBool::new(false), worker: tokio::sync::Mutex::new(()) })
    }

    pub fn get(&self) -> DaemonUpdate {
        self.record.lock().unwrap().clone()
    }

    fn save(&self, store: &Store, record: DaemonUpdate) {
        if let Err(error) = store.meta_set(META_KEY, &serde_json::to_string(&record).expect("serializable record")) {
            tracing::error!(%error, "could not persist daemon update status");
        }
        *self.record.lock().unwrap() = record;
    }

    /// Queue an install; the worker picks it up on its next pass.
    pub fn request(&self, store: &Store) -> DaemonUpdate {
        let mut record = self.get();
        if matches!(record.status, Status::Updating | Status::Restarting) {
            return record;
        }
        self.requested.store(true, Ordering::SeqCst);
        record.status = Status::Waiting;
        record.message = "Waiting for running work to finish".into();
        self.save(store, record.clone());
        record
    }
}

// ---- release feed ----------------------------------------------------------

fn http() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .user_agent(format!("kybernd/{CURRENT_VERSION}"))
        .timeout(Duration::from_secs(120))
        .connect_timeout(Duration::from_secs(15))
        .build()?)
}

async fn latest_version(client: &reqwest::Client) -> Result<String> {
    let manifest: serde_json::Value = client
        .get(format!("https://github.com/{REPO}/releases/latest/download/dist-manifest.json"))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await
        .context("read the release manifest")?;
    let tag = manifest["announcement_tag"].as_str().context("the release manifest has no version")?;
    Ok(tag.trim_start_matches('v').to_string())
}

fn parse_version(version: &str) -> Option<(u64, u64, u64)> {
    let core = version.trim().trim_start_matches('v').split(['-', '+']).next()?;
    let mut parts = core.split('.').map(|part| part.parse::<u64>().ok());
    Some((parts.next()??, parts.next()??, parts.next()??))
}

/// Whether `latest` is a newer release than `current`.
pub fn newer(latest: &str, current: &str) -> bool {
    match (parse_version(latest), parse_version(current)) {
        (Some(a), Some(b)) => a > b,
        _ => false,
    }
}

fn archive_name() -> Result<String> {
    let arch = match std::env::consts::ARCH {
        arch @ ("x86_64" | "aarch64") => arch,
        other => bail!("No published build for {other}. Install from source instead."),
    };
    let (os, extension) = match std::env::consts::OS {
        "macos" => ("apple-darwin", "tar.xz"),
        "linux" => ("unknown-linux-musl", "tar.xz"),
        "windows" if arch == "x86_64" => ("pc-windows-msvc", "zip"),
        other => bail!("No published build for {other} {arch}. Install from source instead."),
    };
    Ok(format!("kybern-{arch}-{os}.{extension}"))
}

// ---- install -----------------------------------------------------------------

/// Why this daemon must not replace itself, if it must not.
fn unsupported(state: &AppState) -> Option<String> {
    if state.desktop_managed.load(Ordering::SeqCst) {
        return Some("Managed by the Kybern desktop app on this machine; updating the app updates it.".into());
    }
    if cfg!(debug_assertions) {
        return Some("Development build; rebuild it instead.".into());
    }
    let exe = std::env::current_exe().ok()?;
    if exe.components().any(|part| part.as_os_str().to_string_lossy().ends_with(".app")) {
        return Some("Runs from an app bundle; update the app instead.".into());
    }
    None
}

fn find_binary(root: &Path, name: &str) -> Option<PathBuf> {
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(dir).ok()?.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.file_name().is_some_and(|file| file == name) {
                return Some(path);
            }
        }
    }
    None
}

/// Atomically put `source` in place of `dest`, which may be the running binary.
fn replace_binary(source: &Path, dest: &Path) -> Result<()> {
    let dir = dest.parent().context("binary has no parent directory")?;
    let staged = dir.join(format!(".{}.new", dest.file_name().unwrap_or_default().to_string_lossy()));
    std::fs::copy(source, &staged).with_context(|| format!("write {}", staged.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755))?;
    }
    #[cfg(windows)]
    {
        // A running executable cannot be overwritten, but it can be renamed away.
        let old = dir.join(format!(".{}.old", dest.file_name().unwrap_or_default().to_string_lossy()));
        let _ = std::fs::remove_file(&old);
        if dest.exists() {
            std::fs::rename(dest, &old)?;
        }
    }
    std::fs::rename(&staged, dest).with_context(|| format!("replace {}", dest.display()))?;
    Ok(())
}

async fn install(client: &reqwest::Client, version: &str) -> Result<()> {
    let exe = std::env::current_exe()?.canonicalize()?;
    let dir = exe.parent().context("binary has no parent directory")?.to_path_buf();
    let probe = dir.join(".kybern-update-probe");
    std::fs::write(&probe, b"").with_context(|| format!("{} is not writable by this user", dir.display()))?;
    let _ = std::fs::remove_file(&probe);

    let name = archive_name()?;
    let base = format!("https://github.com/{REPO}/releases/download/v{version}");
    let archive =
        client.get(format!("{base}/{name}")).send().await?.error_for_status()?.bytes().await.context("download the release archive")?;
    let published =
        client.get(format!("{base}/{name}.sha256")).send().await?.error_for_status()?.text().await.context("download the checksum")?;
    let expected = published.split_whitespace().next().unwrap_or("").to_ascii_lowercase();
    let actual = Sha256::digest(&archive).iter().map(|byte| format!("{byte:02x}")).collect::<String>();
    if expected.is_empty() || expected != actual {
        bail!("The downloaded archive does not match its published checksum. Try again later.");
    }

    let stage = std::env::temp_dir().join(format!("kybern-update-{}", uuid::Uuid::now_v7()));
    std::fs::create_dir_all(&stage)?;
    let result = async {
        let archive_path = stage.join(&name);
        std::fs::write(&archive_path, &archive)?;
        let output = tokio::process::Command::new("tar")
            .arg("-xf")
            .arg(&archive_path)
            .arg("-C")
            .arg(&stage)
            .output()
            .await
            .context("run tar; install tar and xz on this machine")?;
        if !output.status.success() {
            bail!("Unable to unpack the release archive: {}", String::from_utf8_lossy(&output.stderr).trim());
        }
        let daemon_name = exe.file_name().context("binary name")?.to_string_lossy().to_string();
        let new_daemon = find_binary(&stage, &daemon_name).with_context(|| format!("the archive has no {daemon_name}"))?;
        replace_binary(&new_daemon, &exe)?;
        // The CLI ships in the same archive; keep it in step when it sits next to us.
        let cli_name = if cfg!(windows) { "kybern.exe" } else { "kybern" };
        if dir.join(cli_name).exists()
            && let Some(new_cli) = find_binary(&stage, cli_name)
        {
            replace_binary(&new_cli, &dir.join(cli_name))?;
        }
        Ok::<_, anyhow::Error>(())
    }
    .await;
    let _ = std::fs::remove_dir_all(&stage);
    result
}

// ---- scheduling --------------------------------------------------------------

fn due(record: &DaemonUpdate) -> bool {
    record.checked_at.is_none_or(|at| Utc::now().signed_duration_since(at).num_hours() >= 24)
}

/// Anything a restart would interrupt. Automatic updates also wait for open
/// terminals; a requested update treats those as the user's call.
async fn busy(state: &AppState, automatic: bool) -> Result<bool> {
    let activity = crate::maintenance::activity(state).await?;
    Ok(activity.running_threads > 0
        || activity.live_sessions != activity.idle_sessions
        || activity.queued_messages > 0
        || (automatic && activity.terminals > 0))
}

/// Ask the feed for the newest version and record whether it is newer.
pub async fn check(state: &AppState) -> DaemonUpdate {
    let mut record = state.daemon_updates.get();
    if let Some(reason) = unsupported(state) {
        record.status = Status::Unsupported;
        record.message = reason;
        record.checked_at = Some(Utc::now());
        state.daemon_updates.save(&state.store, record.clone());
        return record;
    }
    record.status = Status::Checking;
    record.message = "Checking the release feed…".into();
    state.daemon_updates.save(&state.store, record.clone());
    let latest = async { latest_version(&http()?).await }.await;
    record.checked_at = Some(Utc::now());
    match latest {
        Ok(latest) => {
            if newer(&latest, CURRENT_VERSION) {
                record.status = Status::Available;
                record.message = format!("{latest} is available");
            } else {
                record.status = Status::Current;
                record.message = "Up to date".into();
            }
            record.latest_version = Some(latest);
        }
        Err(error) => {
            record.status = Status::Failed;
            record.message = format!("Unable to check the release feed: {error:#}");
        }
    }
    state.daemon_updates.save(&state.store, record.clone());
    record
}

pub async fn tick(state: AppState) {
    let Ok(_worker) = state.daemon_updates.worker.try_lock() else { return };
    let manual = state.daemon_updates.requested.load(Ordering::SeqCst);
    let settings = state.settings.get();
    let record = state.daemon_updates.get();
    if !manual && (!settings.auto_update_daemon || !due(&record) || state.saving_power() || unsupported(&state).is_some()) {
        return;
    }
    let finish = |record: DaemonUpdate| {
        state.daemon_updates.save(&state.store, record);
        state.daemon_updates.requested.store(false, Ordering::SeqCst);
    };
    let mut record = check(&state).await;
    let Some(latest) = record.latest_version.clone().filter(|_| record.status == Status::Available) else {
        finish(record);
        return;
    };
    if !manual && !state.settings.get().auto_update_daemon {
        finish(record);
        return;
    }
    match busy(&state, !manual).await {
        Ok(false) => {}
        Ok(true) => {
            record.status = Status::Waiting;
            record.message = format!("{latest} is ready. Waiting for running work to finish");
            state.daemon_updates.save(&state.store, record);
            if !manual {
                state.daemon_updates.requested.store(true, Ordering::SeqCst);
            }
            return;
        }
        Err(error) => {
            record.status = Status::Failed;
            record.message = format!("{error:#}");
            finish(record);
            return;
        }
    }
    record.status = Status::Updating;
    record.message = format!("Installing {latest}…");
    state.daemon_updates.save(&state.store, record.clone());
    let result = tokio::select! {
        result = async { install(&http()?, &latest).await } => result,
        _ = state.shutdown.cancelled() => Err(anyhow!("Update interrupted by daemon shutdown. Retry the update.")),
    };
    match result {
        Ok(()) => {
            record.status = Status::Restarting;
            record.message = format!("Restarting on {latest}");
            finish(record);
            tracing::info!(version = %latest, "daemon updated; restarting");
            state.restart_pending.store(true, Ordering::SeqCst);
            state.shutdown.cancel();
        }
        Err(error) => {
            record.status = Status::Failed;
            record.message = format!("{error:#}");
            finish(record);
        }
    }
}

pub async fn run(state: AppState) {
    let mut interval = tokio::time::interval(Duration::from_secs(30));
    loop {
        tokio::select! {
            _ = state.shutdown.cancelled() => break,
            _ = interval.tick() => tick(state.clone()).await,
        }
    }
}

/// Hand over to the freshly installed binary after the graceful shutdown.
/// Under systemd the unit restarts us on a non-zero exit; anywhere else we
/// start the replacement ourselves with the same arguments and log file.
pub fn restart(log_file: &Path) -> ! {
    if std::env::var_os("INVOCATION_ID").is_some() {
        std::process::exit(RESTART_EXIT_CODE);
    }
    let exe = std::env::current_exe().expect("current executable");
    let mut command = std::process::Command::new(exe);
    command.args(std::env::args_os().skip(1)).stdin(std::process::Stdio::null());
    match std::fs::OpenOptions::new().append(true).create(true).open(log_file) {
        Ok(log) => {
            let err = log.try_clone().expect("clone log handle");
            command.stdout(log).stderr(err);
        }
        Err(_) => {
            command.stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    match command.spawn() {
        Ok(_) => std::process::exit(0),
        Err(error) => {
            tracing::error!(%error, "could not start the updated daemon");
            std::process::exit(RESTART_EXIT_CODE)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_release_versions() {
        assert!(newer("0.1.4", "0.1.3"));
        assert!(newer("v1.0.0", "0.9.9"));
        assert!(!newer("0.1.3", "0.1.3"));
        assert!(!newer("0.1.3-rc.1", "0.1.3"));
        assert!(!newer("garbage", "0.1.3"));
    }

    #[test]
    fn names_the_archive_for_this_platform() {
        let name = archive_name().unwrap();
        assert!(name.starts_with("kybern-"));
        assert!(name.ends_with(".tar.xz") || name.ends_with(".zip"));
    }

    #[test]
    fn replaces_a_binary_in_place() {
        let dir = std::env::temp_dir().join(format!("kybern-replace-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("kybernd");
        let source = dir.join("incoming");
        std::fs::write(&dest, b"old").unwrap();
        std::fs::write(&source, b"new").unwrap();
        replace_binary(&source, &dest).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"new");
        assert!(!dir.join(".kybernd.new").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
