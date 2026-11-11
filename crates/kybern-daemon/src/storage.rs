//! Settings → Storage and the background work behind it (issue #298).
//!
//! - Moves images of existing threads out of the database, a small batch at a
//!   time, resumable across restarts, and slower while agents are running.
//! - Sweeps media files no event refers to (a deleted thread's), hourly.
//! - `storage.stats` and `storage.reclaim`: compacting runs in the background
//!   and reports `storage.reclaim.progress`; leaving the page does not stop it.

use std::sync::Mutex;
use std::time::Duration;

use anyhow::Result;
use kybern_protocol::methods::{STORAGE_RECLAIM_PROGRESS_NOTIFICATION, StorageMediaRewrite, StorageReclaimStatus, StorageStats};
use kybern_protocol::rpc::{RpcError, codes};
use kybern_store::{ReclaimError, ReclaimPhase};
use tokio::sync::broadcast;

use crate::state::AppState;

/// One rewrite step reads at most this many rows and bytes.
const STEP_ROWS: usize = 64;
const STEP_BYTES: usize = 16 * 1024 * 1024;
/// Pause between steps; longer while a turn runs so agents keep the disk.
const STEP_PAUSE: Duration = Duration::from_millis(200);
const STEP_PAUSE_BUSY: Duration = Duration::from_secs(2);
const SWEEP_EVERY: Duration = Duration::from_secs(60 * 60);
/// Let the daemon finish starting before the first batch.
const START_DELAY: Duration = Duration::from_secs(20);

pub struct Storage {
    events: broadcast::Sender<StorageReclaimStatus>,
    reclaim: Mutex<StorageReclaimStatus>,
}

impl Default for Storage {
    fn default() -> Self {
        Self { events: broadcast::channel(16).0, reclaim: Mutex::new(StorageReclaimStatus::Idle) }
    }
}

impl Storage {
    pub fn subscribe(&self) -> broadcast::Receiver<StorageReclaimStatus> {
        self.events.subscribe()
    }

    fn status(&self) -> StorageReclaimStatus {
        self.reclaim.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
    }

    fn publish(&self, status: StorageReclaimStatus) {
        *self.reclaim.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = status.clone();
        let _ = self.events.send(status);
    }
}

/// The background loop: the rewrite until it is done, then the hourly sweep.
pub async fn run(state: AppState) {
    if sleep_or_shutdown(&state, START_DELAY).await {
        return;
    }
    let mut next_sweep = tokio::time::Instant::now();
    loop {
        let store = state.store.clone();
        let progress = tokio::task::spawn_blocking(move || store.media_rewrite_step(STEP_ROWS, STEP_BYTES)).await;
        let pause = match progress {
            Ok(Ok(progress)) if progress.done => {
                if tokio::time::Instant::now() >= next_sweep {
                    let store = state.store.clone();
                    match tokio::task::spawn_blocking(move || store.media_sweep(kybern_store::MEDIA_SWEEP_GRACE)).await {
                        Ok(Ok(report)) if report.removed_files > 0 => {
                            tracing::info!(files = report.removed_files, bytes = report.removed_bytes, "removed media no thread uses");
                        }
                        Ok(Err(error)) => tracing::warn!(%error, "the media sweep failed; it runs again later"),
                        _ => {}
                    }
                    next_sweep = tokio::time::Instant::now() + SWEEP_EVERY;
                }
                next_sweep.saturating_duration_since(tokio::time::Instant::now()).max(Duration::from_secs(60))
            }
            Ok(Ok(_)) if state.store.threads_running().is_ok_and(|running| !running.is_empty()) => STEP_PAUSE_BUSY,
            Ok(Ok(_)) => STEP_PAUSE,
            Ok(Err(error)) => {
                tracing::warn!(%error, "moving images out of the database paused; it tries again in a minute");
                Duration::from_secs(60)
            }
            Err(_) => Duration::from_secs(60),
        };
        if sleep_or_shutdown(&state, pause).await {
            return;
        }
    }
}

async fn sleep_or_shutdown(state: &AppState, pause: Duration) -> bool {
    tokio::select! {
        _ = state.shutdown.cancelled() => true,
        _ = tokio::time::sleep(pause) => false,
    }
}

pub async fn stats(state: &AppState) -> Result<StorageStats> {
    let store = state.store.clone();
    let assets = state.paths.assets.clone();
    let (stats, files_bytes) =
        tokio::task::spawn_blocking(move || -> Result<_> { Ok((store.storage_stats()?, dir_bytes(&assets))) }).await??;
    Ok(StorageStats {
        database_bytes: stats.database_bytes,
        files_bytes,
        reclaimable_bytes: stats.reclaimable_bytes,
        compacted_bytes: stats.compacted_bytes,
        needed_disk_bytes: stats.compacted_bytes.saturating_mul(2),
        free_disk_bytes: free_disk_bytes(&state.paths.db),
        media_rewrite: StorageMediaRewrite { processed: stats.rewrite.processed, total: stats.rewrite.total, done: stats.rewrite.done },
        reclaim: state.storage.status(),
    })
}

/// Start compacting. Refuses up front what cannot run, in words the person can act on.
pub async fn reclaim(state: &AppState) -> Result<StorageReclaimStatus, RpcError> {
    if matches!(state.storage.status(), StorageReclaimStatus::Running { .. }) {
        return Ok(state.storage.status());
    }
    let current = stats(state).await.map_err(|error| RpcError::new(codes::INTERNAL_ERROR, error.to_string()))?;
    if !current.media_rewrite.done {
        return Err(refusal(ReclaimError::MediaMoving));
    }
    if current.reclaimable_bytes < kybern_store::NOTHING_TO_RECLAIM_BYTES {
        return Err(refusal(ReclaimError::NothingToReclaim));
    }
    let free = current.free_disk_bytes.unwrap_or(u64::MAX);
    if free < current.needed_disk_bytes {
        return Err(refusal(ReclaimError::LowDisk { need: current.needed_disk_bytes, free }));
    }
    let running = StorageReclaimStatus::Running { written_bytes: Some(0), total_bytes: current.compacted_bytes, finishing: false };
    state.storage.publish(running.clone());
    let worker = state.clone();
    tokio::task::spawn_blocking(move || {
        let progress = |phase: ReclaimPhase| {
            let status = match phase {
                ReclaimPhase::Writing { written, total } => {
                    StorageReclaimStatus::Running { written_bytes: Some(written), total_bytes: total, finishing: false }
                }
                ReclaimPhase::Finishing => {
                    StorageReclaimStatus::Running { written_bytes: None, total_bytes: current.compacted_bytes, finishing: true }
                }
            };
            worker.storage.publish(status);
        };
        let outcome = worker.store.reclaim(free, &progress);
        let status = match outcome {
            Ok(freed) => {
                tracing::info!(freed, "compacted the database");
                StorageReclaimStatus::Done { freed_bytes: freed }
            }
            Err(ReclaimError::NothingToReclaim) => StorageReclaimStatus::Done { freed_bytes: 0 },
            // Another request started first; its run reports the outcome.
            Err(ReclaimError::Busy) => return,
            Err(error) => {
                tracing::warn!(%error, "compacting the database stopped");
                StorageReclaimStatus::Failed { message: plain(&error) }
            }
        };
        worker.storage.publish(status);
    });
    Ok(running)
}

fn refusal(error: ReclaimError) -> RpcError {
    RpcError::new(codes::INVALID_PARAMS, plain(&error))
}

fn plain(error: &ReclaimError) -> String {
    match error {
        ReclaimError::LowDisk { need, free } => format!(
            "Needs about {} free to run, and this computer has {}. Free up some space, then try again.",
            human_bytes(*need),
            human_bytes(*free)
        ),
        ReclaimError::Failed(_) => {
            "Reclaiming stopped before it finished. Your data is unchanged. Try again, and keep Kybern open until it's done.".into()
        }
        other => other.to_string(),
    }
}

pub fn human_bytes(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["KB", "MB", "GB", "TB"];
    if bytes < 1000 {
        return format!("{bytes} bytes");
    }
    let mut value = bytes as f64 / 1000.0;
    let mut unit = 0;
    while value >= 1000.0 && unit < UNITS.len() - 1 {
        value /= 1000.0;
        unit += 1;
    }
    if value >= 100.0 { format!("{value:.0} {}", UNITS[unit]) } else { format!("{value:.1} {}", UNITS[unit]) }
}

pub const NOTIFICATION: &str = STORAGE_RECLAIM_PROGRESS_NOTIFICATION;

/// Total size of the regular files directly in `dir`.
fn dir_bytes(dir: &std::path::Path) -> u64 {
    std::fs::read_dir(dir).map_or(0, |entries| {
        entries.flatten().filter_map(|entry| entry.metadata().ok()).filter(|meta| meta.is_file()).map(|meta| meta.len()).sum()
    })
}

/// Free space for an unprivileged user on the disk that holds `path`.
#[cfg(unix)]
pub fn free_disk_bytes(path: &std::path::Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let dir = path.parent().unwrap_or(path);
    let c_path = std::ffi::CString::new(dir.as_os_str().as_bytes()).ok()?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: `c_path` is a valid NUL-terminated string and `stat` a valid out pointer.
    if unsafe { libc::statvfs(c_path.as_ptr(), &mut stat) } != 0 {
        return None;
    }
    #[allow(clippy::unnecessary_cast)]
    Some(stat.f_bavail as u64 * stat.f_frsize as u64)
}

#[cfg(windows)]
pub fn free_disk_bytes(path: &std::path::Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let dir = path.parent().unwrap_or(path);
    let wide: Vec<u16> = dir.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut available = 0u64;
    // SAFETY: `wide` is NUL-terminated and the out pointer is valid; the others may be null.
    let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut available, std::ptr::null_mut(), std::ptr::null_mut()) };
    (ok != 0).then_some(available)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes_read_like_finder() {
        assert_eq!(human_bytes(512), "512 bytes");
        assert_eq!(human_bytes(4_900_000_000), "4.9 GB");
        assert_eq!(human_bytes(145_000_000), "145 MB");
    }

    #[test]
    fn free_space_is_known_for_the_data_folder() {
        let dir = std::env::temp_dir();
        assert!(free_disk_bytes(&dir.join("state.sqlite")).is_some_and(|free| free > 0));
    }
}
