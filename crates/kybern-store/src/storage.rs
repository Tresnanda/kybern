//! What the event log costs on disk, and getting it back (issue #298).
//!
//! - Every write records the media an event refers to (`media_refs`) and, for a
//!   tool result large enough that pages leave it out, a stub
//!   (`event_output_stubs`), so history pages never read the result itself.
//! - [`Store::media_rewrite_step`] moves the media of rows written before this
//!   existed, a small batch at a time, resumable across restarts.
//! - [`Store::media_sweep`] deletes files no event refers to any more.
//! - [`Store::reclaim`] compacts the database with `VACUUM INTO` on a second
//!   connection while the daemon keeps serving, then swaps the files.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::{Context, Result, anyhow};
use chrono::{DateTime, Utc};
use kybern_protocol::{EventPayload, MEDIA_INLINE_MAX_BASE64, MediaRef, ProviderCommand, ThreadEvent, ThreadId};
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};

use crate::media::{Externalizer, payload_refs};
use crate::projection::{json_payload_bytes, should_omit_tool_output};
use crate::{Store, other, parse_time, parse_uuid, prepare_connection, schema};

/// Kinds whose payload can carry media.
const MEDIA_KINDS: &str = "'tool_call_completed','turn_started','image_received','message_steered','message_queued',\
                           'message_queue_updated','async_questions_answered','visual_answered'";
/// The rewrite reads at most this many rows' worth of sequence numbers per step.
const REWRITE_WINDOW: i64 = 20_000;
/// Space below this is not worth a compaction.
pub const NOTHING_TO_RECLAIM_BYTES: u64 = 32 * 1024 * 1024;
/// A file younger than this may belong to an event that is still being written.
pub const MEDIA_SWEEP_GRACE: std::time::Duration = std::time::Duration::from_secs(60 * 60);

#[derive(Default)]
pub(crate) struct StorageState {
    /// Held by a rewrite step, a sweep and a compaction, so they never overlap.
    job: Mutex<()>,
    reclaiming: AtomicBool,
}

/// Where moving existing media out of the database stands.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MediaRewriteProgress {
    /// Rows that may hold media and have been checked.
    pub processed: u64,
    /// Rows that may hold media, counted when the rewrite began. 0 while counting.
    pub total: u64,
    pub done: bool,
    /// Still counting the rows to check.
    pub counting: bool,
}

#[derive(Debug, Clone, Default)]
pub struct StorageStats {
    /// The database file and its write-ahead log.
    pub database_bytes: u64,
    /// Unused pages a compaction would return to the disk.
    pub reclaimable_bytes: u64,
    /// The size the database would have after a compaction.
    pub compacted_bytes: u64,
    /// Media files the event log refers to.
    pub media_bytes: u64,
    pub media_files: u64,
    pub rewrite: MediaRewriteProgress,
    pub reclaiming: bool,
}

#[derive(Debug, Clone, Default)]
pub struct SweepReport {
    pub removed_files: u64,
    pub removed_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReclaimPhase {
    /// `written` of about `total` bytes of the compacted copy are on disk.
    Writing { written: u64, total: u64 },
    /// Checking the copy and bringing over what changed meanwhile.
    Finishing,
}

#[derive(Debug, thiserror::Error)]
pub enum ReclaimError {
    #[error("Needs about {need} bytes free to run, and the disk has {free}.")]
    LowDisk { need: u64, free: u64 },
    #[error("Nothing to reclaim. The database has no unused space.")]
    NothingToReclaim,
    #[error("Reclaiming waits until images finish moving out of the database.")]
    MediaMoving,
    #[error("Kybern is already compacting the database.")]
    Busy,
    #[error("Reclaiming stopped before it finished: {0}")]
    Failed(String),
}

impl From<anyhow::Error> for ReclaimError {
    fn from(error: anyhow::Error) -> Self {
        Self::Failed(format!("{error:#}"))
    }
}

impl From<rusqlite::Error> for ReclaimError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Failed(error.to_string())
    }
}

/// Record what an event just written refers to. Runs in the event's transaction.
pub(crate) fn record_event_media(c: &Connection, seq: i64, payload: &EventPayload, at: &DateTime<Utc>) -> Result<()> {
    for media in payload_refs(payload) {
        record_ref(c, seq, &media, at)?;
    }
    if let EventPayload::ToolCallCompleted { tool_call_id, output, is_error, .. } = payload
        && should_omit_tool_output(output)
    {
        c.execute(
            "INSERT OR REPLACE INTO event_output_stubs(seq, tool_call_id, is_error, output_bytes) VALUES (?1, ?2, ?3, ?4)",
            params![seq, tool_call_id, is_error, json_payload_bytes(output) as i64],
        )?;
    }
    Ok(())
}

fn record_ref(c: &Connection, seq: i64, media: &MediaRef, at: &DateTime<Utc>) -> Result<()> {
    c.execute(
        "INSERT OR IGNORE INTO media(hash, mime, size, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![media.hash, media.mime, media.size as i64, at.to_rfc3339()],
    )?;
    c.execute("INSERT OR IGNORE INTO media_refs(seq, hash) VALUES (?1, ?2)", params![seq, media.hash])?;
    Ok(())
}

/// History page SQL: a stubbed tool result comes back without its payload.
/// Columns: seq, thread_id, turn_id, at, kind, payload (NULL when stubbed), stub tool_call_id, stub is_error.
pub(crate) const STUBBED_EVENT_COLUMNS: &str = "e.seq, e.thread_id, e.turn_id, e.at, e.kind, \
     CASE WHEN s.seq IS NULL THEN e.payload END, s.tool_call_id, s.is_error";
pub(crate) const STUBBED_EVENTS_FROM: &str = "events e LEFT JOIN event_output_stubs s ON s.seq = e.seq";

/// The stub of a row read with [`STUBBED_EVENT_COLUMNS`], as an omitted completion.
pub(crate) fn stubbed_event(r: &rusqlite::Row<'_>) -> rusqlite::Result<Option<ThreadEvent>> {
    let Some(tool_call_id) = r.get::<_, Option<String>>(6)? else { return Ok(None) };
    let turn: Option<String> = r.get(2)?;
    Ok(Some(ThreadEvent {
        seq: r.get(0)?,
        thread_id: parse_uuid(r.get::<_, String>(1)?)?,
        turn_id: turn.map(parse_uuid).transpose()?,
        at: parse_time(r.get::<_, String>(3)?)?,
        payload: EventPayload::ToolCallCompleted {
            tool_call_id,
            output: serde_json::Value::Null,
            output_omitted: true,
            stream_recoverable: false,
            is_error: r.get(7)?,
        },
    }))
}

/// Byte length of the payload column of a stubbed row read (0 when stubbed).
pub(crate) fn stubbed_payload_len(r: &rusqlite::Row<'_>) -> rusqlite::Result<usize> {
    Ok(r.get_ref(5)?.as_bytes_or_null().map_err(other)?.map_or(0, <[u8]>::len))
}

const META_AFTER: &str = "media_rewrite.after";
const META_UNTIL: &str = "media_rewrite.until";
const META_COUNTED: &str = "media_rewrite.counted_through";
const META_TOTAL: &str = "media_rewrite.total";
const META_PROCESSED: &str = "media_rewrite.processed";
const META_DONE: &str = "media_rewrite.done";

fn meta_i64(c: &Connection, key: &str) -> Result<Option<i64>> {
    let value: Option<String> = c.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0)).optional()?;
    Ok(value.and_then(|value| value.parse().ok()))
}

fn meta_put(c: &Connection, key: &str, value: i64) -> Result<()> {
    c.execute(
        "INSERT INTO meta(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value.to_string()],
    )?;
    Ok(())
}

struct Candidate {
    seq: i64,
    payload: String,
    counted: bool,
}

struct Rewritten {
    seq: i64,
    payload: Option<String>,
    event: EventPayload,
    at: DateTime<Utc>,
}

impl Store {
    /// Move the large media of `payload` to `assets/`. Without a media folder it stays inline.
    pub(crate) fn externalize(&self, payload: &mut EventPayload) -> Result<()> {
        if let Some(dir) = &self.media {
            Externalizer::new(dir).payload(payload)?;
        }
        Ok(())
    }

    /// Store a message's large images as references, as an event would. Used
    /// to compare a retried request with the one already stored.
    pub fn externalize_message(&self, message: &mut kybern_protocol::UserMessage) -> Result<()> {
        if let Some(dir) = &self.media {
            Externalizer::new(dir).message(message)?;
        }
        Ok(())
    }

    /// Inline references again, for a provider. Missing files are an error.
    pub fn inline_message(&self, message: &mut kybern_protocol::UserMessage) -> Result<()> {
        match &self.media {
            Some(dir) => crate::media::inline_message(message, dir),
            None if message.parts.iter().any(|part| matches!(part, kybern_protocol::ContentPart::Media { .. })) => {
                Err(anyhow!("this store keeps no media files"))
            }
            None => Ok(()),
        }
    }

    pub fn media_get(&self, hash: &str) -> Result<Option<(String, u64)>> {
        self.with(|c| {
            Ok(c.query_row("SELECT mime, size FROM media WHERE hash = ?1", [hash], |r| Ok((r.get(0)?, r.get::<_, i64>(1)? as u64)))
                .optional()?)
        })
    }

    pub fn media_rewrite_progress(&self) -> Result<MediaRewriteProgress> {
        self.with(|c| {
            let done = meta_i64(c, META_DONE)?.is_some_and(|done| done == 1) || self.media.is_none();
            let counting = !done && meta_i64(c, META_TOTAL)?.is_none();
            Ok(MediaRewriteProgress {
                processed: meta_i64(c, META_PROCESSED)?.unwrap_or(0).max(0) as u64,
                total: meta_i64(c, META_TOTAL)?.unwrap_or(0).max(0) as u64,
                done,
                counting,
            })
        })
    }

    /// One bounded step of moving existing media out of the event log. Returns
    /// the progress after it; call again until `done`. Each step holds the
    /// connection only to read and to write its batch, never while it hashes and
    /// writes files. Files are on disk before any row points at them; a crash in
    /// between leaves an unreferenced file the sweep removes and the step redoes.
    pub fn media_rewrite_step(&self, max_rows: usize, max_bytes: usize) -> Result<MediaRewriteProgress> {
        let Some(dir) = self.media.clone() else { return self.media_rewrite_progress() };
        let Ok(_job) = self.storage.job.try_lock() else { return self.media_rewrite_progress() };
        if self.storage.reclaiming.load(Ordering::Acquire) {
            return self.media_rewrite_progress();
        }
        let progress = self.media_rewrite_progress()?;
        if progress.done {
            return Ok(progress);
        }
        let until = self.with(|c| {
            if let Some(until) = meta_i64(c, META_UNTIL)? {
                return Ok(until);
            }
            // Everything after this was written with media already outside.
            let until: i64 = c.query_row("SELECT COALESCE(MAX(seq), 0) FROM events", [], |r| r.get(0))?;
            meta_put(c, META_UNTIL, until)?;
            Ok(until)
        })?;
        if progress.counting {
            self.with(|c| {
                let from = meta_i64(c, META_COUNTED)?.unwrap_or(0);
                let to = (from + REWRITE_WINDOW * 5).min(until);
                let found: i64 = c.query_row(
                    &format!(
                        "SELECT COUNT(*) FROM events WHERE seq > ?1 AND seq <= ?2 AND kind IN ({MEDIA_KINDS}) AND octet_length(payload) > ?3"
                    ),
                    params![from, to, MEDIA_INLINE_MAX_BASE64 as i64],
                    |r| r.get(0),
                )?;
                let tx = c.unchecked_transaction()?;
                let partial = meta_i64(&tx, "media_rewrite.counting")?.unwrap_or(0) + found;
                meta_put(&tx, META_COUNTED, to)?;
                if to >= until {
                    meta_put(&tx, META_TOTAL, partial)?;
                } else {
                    meta_put(&tx, "media_rewrite.counting", partial)?;
                }
                tx.commit()?;
                Ok(())
            })?;
            return self.media_rewrite_progress();
        }

        let after = self.with(|c| Ok(meta_i64(c, META_AFTER)?.unwrap_or(0)))?;
        let window_end = (after + REWRITE_WINDOW).min(until);
        let (candidates, reached) = self.with(|c| {
            let mut statement = c.prepare(&format!(
                "SELECT seq, payload, octet_length(payload) > ?4 FROM events
                 WHERE seq > ?1 AND seq <= ?2 AND kind IN ({MEDIA_KINDS})
                   AND (octet_length(payload) > ?4 OR (kind = 'tool_call_completed' AND octet_length(payload) > ?5))
                 ORDER BY seq LIMIT ?3"
            ))?;
            let mut rows = statement.query(params![
                after,
                window_end,
                max_rows.max(1) as i64,
                MEDIA_INLINE_MAX_BASE64 as i64,
                crate::LARGE_TOOL_OUTPUT_BYTES as i64
            ])?;
            let (mut out, mut bytes) = (Vec::new(), 0usize);
            while let Some(row) = rows.next()? {
                let payload: String = row.get(1)?;
                bytes += payload.len();
                out.push(Candidate { seq: row.get(0)?, payload, counted: row.get(2)? });
                if bytes >= max_bytes {
                    break;
                }
            }
            let full = out.len() >= max_rows.max(1) || bytes >= max_bytes;
            let reached = if full { out.last().map_or(window_end, |last| last.seq) } else { window_end };
            Ok((out, reached))
        })?;

        let mut rewritten = Vec::with_capacity(candidates.len());
        let mut counted = 0i64;
        for candidate in candidates {
            counted += i64::from(candidate.counted);
            let mut event: EventPayload = match serde_json::from_str(&candidate.payload) {
                Ok(event) => event,
                Err(error) => {
                    tracing::warn!(seq = candidate.seq, %error, "an event could not be read to move its media; it stays as it is");
                    continue;
                }
            };
            let mut externalizer = Externalizer::new(&dir);
            externalizer.payload(&mut event)?;
            let payload = (!externalizer.made.is_empty()).then(|| serde_json::to_string(&event)).transpose()?;
            rewritten.push(Rewritten { seq: candidate.seq, payload, event, at: Utc::now() });
        }

        self.with(|c| {
            let tx = c.unchecked_transaction()?;
            for row in &rewritten {
                if let Some(payload) = &row.payload {
                    if tx.execute("UPDATE events SET payload = ?2 WHERE seq = ?1", params![row.seq, payload])? == 0 {
                        continue; // its thread was deleted meanwhile
                    }
                    rewrite_side_tables(&tx, &row.event, &dir)?;
                } else if !tx.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE seq = ?1)", [row.seq], |r| r.get::<_, bool>(0))? {
                    continue;
                }
                record_event_media(&tx, row.seq, &row.event, &row.at)?;
            }
            meta_put(&tx, META_AFTER, reached)?;
            meta_put(&tx, META_PROCESSED, meta_i64(&tx, META_PROCESSED)?.unwrap_or(0) + counted)?;
            if reached >= until {
                meta_put(&tx, META_DONE, 1)?;
            }
            tx.commit()?;
            Ok(())
        })?;
        self.media_rewrite_progress()
    }

    /// Delete media files that no event refers to, once older than `grace`.
    /// Archiving keeps a thread's events, so its files stay.
    pub fn media_sweep(&self, grace: std::time::Duration) -> Result<SweepReport> {
        let Some(dir) = self.media.clone() else { return Ok(SweepReport::default()) };
        let Ok(_job) = self.storage.job.try_lock() else { return Ok(SweepReport::default()) };
        let mut report = SweepReport::default();
        let entries = match std::fs::read_dir(dir.path()) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(report),
            Err(error) => return Err(error).with_context(|| format!("list {}", dir.path().display())),
        };
        let now = std::time::SystemTime::now();
        let mut old: Vec<(String, PathBuf, u64)> = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Ok(meta) = entry.metadata() else { continue };
            let aged = meta.modified().ok().and_then(|at| now.duration_since(at).ok()).is_some_and(|age| age >= grace);
            if !meta.is_file() || !aged {
                continue;
            }
            if crate::media::is_hash(&name) {
                old.push((name, entry.path(), meta.len()));
            } else if name.starts_with('.') && name.ends_with(".part") && std::fs::remove_file(entry.path()).is_ok() {
                report.removed_files += 1;
                report.removed_bytes += meta.len();
            }
        }
        for chunk in old.chunks(256) {
            let unused = self.with(|c| {
                let mut statement = c.prepare_cached("SELECT EXISTS(SELECT 1 FROM media_refs WHERE hash = ?1)")?;
                let mut unused = Vec::new();
                for (hash, path, size) in chunk {
                    if !statement.query_row([hash], |r| r.get::<_, bool>(0))? {
                        unused.push((hash.clone(), path.clone(), *size));
                    }
                }
                Ok(unused)
            })?;
            for (hash, path, size) in unused {
                // Re-check under the connection: an event may have taken it meanwhile.
                let removed = self.with(|c| {
                    if c.query_row("SELECT EXISTS(SELECT 1 FROM media_refs WHERE hash = ?1)", [&hash], |r| r.get::<_, bool>(0))? {
                        return Ok(false);
                    }
                    // A write that reuses a stored file touches it before its event is written
                    // (`MediaDir::write`); a file touched since the listing may be about to be used.
                    let aged = std::fs::metadata(&path)
                        .and_then(|meta| meta.modified())
                        .ok()
                        .and_then(|at| std::time::SystemTime::now().duration_since(at).ok())
                        .is_some_and(|age| age >= grace);
                    if !aged {
                        return Ok(false);
                    }
                    match std::fs::remove_file(&path) {
                        Ok(()) => {}
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                        Err(error) => {
                            tracing::warn!(path = %path.display(), %error, "an unused media file could not be removed");
                            return Ok(false);
                        }
                    }
                    c.execute("DELETE FROM media WHERE hash = ?1", [&hash])?;
                    Ok(true)
                })?;
                if removed {
                    report.removed_files += 1;
                    report.removed_bytes += size;
                }
            }
        }
        Ok(report)
    }

    pub fn storage_stats(&self) -> Result<StorageStats> {
        let (page_size, pages, free_pages, media_bytes, media_files) = self.with(|c| {
            let page_size: i64 = c.query_row("PRAGMA page_size", [], |r| r.get(0))?;
            let pages: i64 = c.query_row("PRAGMA page_count", [], |r| r.get(0))?;
            let free: i64 = c.query_row("PRAGMA freelist_count", [], |r| r.get(0))?;
            let (bytes, files): (i64, i64) =
                c.query_row("SELECT COALESCE(SUM(size), 0), COUNT(*) FROM media", [], |r| Ok((r.get(0)?, r.get(1)?)))?;
            Ok((page_size as u64, pages as u64, free as u64, bytes as u64, files as u64))
        })?;
        let database_bytes = match &self.path {
            Some(path) => file_len(path) + file_len(&sidecar(path, "-wal")),
            None => pages * page_size,
        };
        Ok(StorageStats {
            database_bytes,
            reclaimable_bytes: free_pages * page_size,
            compacted_bytes: pages.saturating_sub(free_pages) * page_size,
            media_bytes,
            media_files,
            rewrite: self.media_rewrite_progress()?,
            reclaiming: self.storage.reclaiming.load(Ordering::Acquire),
        })
    }

    /// Whether `commands` differ from what the thread last recorded for its
    /// current session. A session transition clears the list for clients, so
    /// the first list after one is always written.
    pub fn provider_commands_changed(&self, thread_id: ThreadId, commands: &[ProviderCommand]) -> Result<bool> {
        self.with(|c| {
            let latest: Option<(String, String)> = c
                .query_row(
                    "SELECT kind, payload FROM events WHERE thread_id = ?1
                       AND kind IN ('provider_commands_updated', 'session_transitioned')
                     ORDER BY seq DESC LIMIT 1",
                    [thread_id.to_string()],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            Ok(match latest {
                Some((kind, payload)) if kind == "provider_commands_updated" => match serde_json::from_str::<EventPayload>(&payload) {
                    Ok(EventPayload::ProviderCommandsUpdated { commands: stored }) => {
                        serde_json::to_value(&stored)? != serde_json::to_value(commands)?
                    }
                    _ => true,
                },
                _ => true,
            })
        })
    }

    /// Compact the database while the daemon keeps serving: `VACUUM INTO` a new
    /// file from a second connection (readers and writers carry on), then,
    /// holding the connection, bring over anything written meanwhile and swap
    /// the files. Writers wait only for that last part. `free_disk` is the free
    /// space on the database's disk; the copy needs about twice its size.
    pub fn reclaim(&self, free_disk: u64, progress: &(dyn Fn(ReclaimPhase) + Sync)) -> Result<u64, ReclaimError> {
        let path = self.path.clone().ok_or_else(|| ReclaimError::Failed("an in-memory store has no file to compact".into()))?;
        let _job = self.storage.job.try_lock().map_err(|_| ReclaimError::Busy)?;
        if self.storage.reclaiming.swap(true, Ordering::AcqRel) {
            return Err(ReclaimError::Busy);
        }
        struct Clear<'a>(&'a AtomicBool);
        impl Drop for Clear<'_> {
            fn drop(&mut self) {
                self.0.store(false, Ordering::Release);
            }
        }
        let _clear = Clear(&self.storage.reclaiming);
        let stats = self.storage_stats()?;
        if !stats.rewrite.done {
            return Err(ReclaimError::MediaMoving);
        }
        if stats.reclaimable_bytes < NOTHING_TO_RECLAIM_BYTES {
            return Err(ReclaimError::NothingToReclaim);
        }
        let need = stats.compacted_bytes.saturating_mul(2);
        if free_disk < need {
            return Err(ReclaimError::LowDisk { need, free: free_disk });
        }
        let compact = sidecar(&path, COMPACT_SUFFIX);
        remove_if_exists(&compact)?;
        let result = self.reclaim_into(&path, &compact, stats.compacted_bytes, progress);
        if result.is_err() {
            let _ = std::fs::remove_file(&compact);
        }
        result?;
        Ok(stats.database_bytes.saturating_sub(self.storage_stats()?.database_bytes))
    }

    fn reclaim_into(&self, path: &Path, compact: &Path, total: u64, progress: &(dyn Fn(ReclaimPhase) + Sync)) -> Result<(), ReclaimError> {
        // Any write after this count is brought over at the end; one before it is in the copy anyway.
        let changes = self.with(|c| Ok(c.total_changes()))?;
        let source = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
        source.busy_timeout(std::time::Duration::from_secs(30))?;
        let finished = AtomicBool::new(false);
        let vacuum = std::thread::scope(|scope| {
            scope.spawn(|| {
                while !finished.load(Ordering::Acquire) {
                    progress(ReclaimPhase::Writing { written: file_len(compact), total });
                    std::thread::sleep(std::time::Duration::from_millis(400));
                }
            });
            let result = source.execute("VACUUM INTO ?1", [compact.to_string_lossy()]);
            finished.store(true, Ordering::Release);
            result
        });
        vacuum.context("VACUUM INTO")?;
        drop(source);
        progress(ReclaimPhase::Writing { written: file_len(compact), total: file_len(compact) });
        progress(ReclaimPhase::Finishing);
        // Never create a file here: a copy that is missing must fail, not become an empty database.
        let copy = Connection::open_with_flags(compact, OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
        let check: String = copy.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
        if check != "ok" {
            return Err(ReclaimError::Failed(format!("the compacted copy failed its check: {check}")));
        }

        let mut guard = self.conn.lock().map_err(|_| anyhow!("store mutex poisoned"))?;
        if guard.total_changes() != changes {
            catch_up(&copy, path)?;
        }
        // The copy replaces the database only if it holds the same history.
        let (live, copied) = (fingerprint(&guard)?, fingerprint(&copy)?);
        if live != copied {
            return Err(ReclaimError::Failed(format!("the compacted copy does not match the database ({copied:?}, expected {live:?})")));
        }
        copy.close().map_err(|(_, error)| error)?;
        // SQLite does not flush a `VACUUM INTO` file; it must be on disk before it replaces the database.
        sync_file(compact)?;
        // Everything must be in the main file: the log is removed before the copy moves in, so a
        // stale log is never replayed into it.
        let (busy, log, done): (i64, i64, i64) =
            guard.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        if busy != 0 || log != done {
            return Err(ReclaimError::Failed("the write-ahead log could not be checkpointed".into()));
        }
        let old = std::mem::replace(&mut *guard, Connection::open_in_memory()?);
        if let Err((old, error)) = old.close() {
            *guard = old;
            return Err(error.into());
        }
        let backup = sidecar(path, BACKUP_SUFFIX);
        let swapped = swap_in(path, compact, &backup);
        // Whatever happened, the daemon gets a working connection back: the new file, or the old one.
        let reopened = match (&swapped, open_live(path)) {
            (_, Ok(conn)) => Ok(conn),
            (Ok(true), Err(error)) => {
                tracing::warn!(%error, "the compacted database did not open; putting the old one back");
                let restored = std::fs::rename(&backup, path)
                    .context("put the old database back")
                    .and_then(|()| remove_sidecars(path))
                    .and_then(|()| open_live(path));
                match restored {
                    Ok(conn) => {
                        *guard = conn;
                        return Err(ReclaimError::Failed(format!("the compacted database did not open: {error:#}")));
                    }
                    Err(restore) => Err(anyhow!("{error:#}; {restore:#}")),
                }
            }
            (_, Err(error)) => Err(error),
        };
        match reopened {
            Ok(conn) => *guard = conn,
            Err(error) => return Err(ReclaimError::Failed(format!("{error:#}"))),
        }
        drop(guard);
        let _ = std::fs::remove_file(&backup);
        swapped?;
        Ok(())
    }
}

const BACKUP_SUFFIX: &str = ".before-reclaim";
const COMPACT_SUFFIX: &str = ".compact";

/// What a compacted copy must agree on with the live database before it replaces it. Cheap on a
/// multi-gigabyte log (it runs while writers wait): the last event, and every thread's head.
fn fingerprint(c: &Connection) -> rusqlite::Result<(i64, i64, i64)> {
    c.query_row("SELECT (SELECT COALESCE(MAX(seq), 0) FROM events), COUNT(*), COALESCE(SUM(last_seq), 0) FROM threads", [], |r| {
        Ok((r.get(0)?, r.get(1)?, r.get(2)?))
    })
}

fn open_live(path: &Path) -> Result<Connection> {
    // Without CREATE: a missing database must not come back as an empty one.
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
    prepare_connection(&conn)?;
    schema::migrate(&conn)?;
    Ok(conn)
}

/// Put `compact` in place of `path` with one rename, so there is a database at `path` at every
/// moment. The old file stays reachable as `backup` (a hard link: no extra space) until the new
/// one has opened. Returns whether that backup exists.
fn swap_in(path: &Path, compact: &Path, backup: &Path) -> Result<bool> {
    // The connection checkpointed and closed: its log must be empty. A log with frames belongs to the
    // old file and stays with it.
    anyhow::ensure!(file_len(&sidecar(path, "-wal")) == 0, "the write-ahead log still holds writes");
    remove_if_exists(backup)?;
    let backed_up = std::fs::hard_link(path, backup).is_ok();
    remove_sidecars(path)?;
    std::fs::rename(compact, path).context("move the compacted database in place")?;
    sync_dir(path);
    Ok(backed_up)
}

fn remove_sidecars(path: &Path) -> Result<()> {
    for suffix in ["-wal", "-shm"] {
        remove_if_exists(&sidecar(path, suffix))?;
    }
    Ok(())
}

fn sync_file(path: &Path) -> Result<()> {
    // `sync_all` is `F_FULLFSYNC` on macOS and `FlushFileBuffers` on Windows.
    std::fs::OpenOptions::new().read(true).write(true).open(path)?.sync_all().with_context(|| format!("flush {}", path.display()))
}

#[cfg(unix)]
fn sync_dir(path: &Path) {
    if let Some(dir) = path.parent()
        && let Ok(dir) = std::fs::File::open(dir)
    {
        let _ = dir.sync_all();
    }
}

#[cfg(not(unix))]
fn sync_dir(_path: &Path) {}

/// Files a compaction leaves when the daemon stops in the middle: the partial copy, and the old
/// database kept until the new one opened. Runs before the database opens.
pub(crate) fn clear_reclaim_leftovers(path: &Path) -> Result<()> {
    let backup = sidecar(path, BACKUP_SUFFIX);
    if !path.exists() && backup.exists() {
        // Stopped between moving the old file aside and the new one in: the old one is whole.
        std::fs::rename(&backup, path).context("restore the database a compaction moved aside")?;
    }
    remove_if_exists(&backup)?;
    let compact = sidecar(path, COMPACT_SUFFIX);
    for suffix in ["", "-journal", "-wal", "-shm"] {
        remove_if_exists(&sidecar(&compact, suffix))?;
    }
    Ok(())
}

/// Bring what was written during `VACUUM INTO` into the copy. Events only
/// append (the media rewrite is paused meanwhile), so newer rows are copied by
/// sequence and the rows of deleted threads dropped. Every other table is small
/// and is copied whole. Triggers and foreign keys are off so the copy holds
/// exactly the live values.
fn catch_up(copy: &Connection, live: &Path) -> Result<()> {
    copy.pragma_update(None, "foreign_keys", "OFF")?;
    copy.execute("ATTACH DATABASE ?1 AS live", [live.to_string_lossy()])?;
    let result = (|| -> Result<()> {
        let tx = copy.unchecked_transaction()?;
        let triggers: Vec<(String, String)> = {
            let mut statement = tx.prepare("SELECT name, sql FROM main.sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL")?;
            statement.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?
        };
        for (name, _) in &triggers {
            tx.execute_batch(&format!("DROP TRIGGER main.\"{}\";", name.replace('"', "\"\"")))?;
        }
        tx.execute("DELETE FROM main.events WHERE thread_id IN (SELECT id FROM main.threads EXCEPT SELECT id FROM live.threads)", [])?;
        tx.execute("INSERT INTO main.events SELECT * FROM live.events WHERE seq > (SELECT COALESCE(MAX(seq), 0) FROM main.events)", [])?;
        let tables: Vec<String> = {
            let mut statement =
                tx.prepare("SELECT name FROM main.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'events'")?;
            statement.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?
        };
        for table in tables.iter().map(String::as_str).chain(["sqlite_sequence"]) {
            let quoted = format!("\"{}\"", table.replace('"', "\"\""));
            tx.execute_batch(&format!("DELETE FROM main.{quoted}; INSERT INTO main.{quoted} SELECT * FROM live.{quoted};"))?;
        }
        for (_, sql) in &triggers {
            tx.execute_batch(sql)?;
        }
        tx.commit()?;
        Ok(())
    })();
    copy.execute("DETACH DATABASE live", [])?;
    result
}

/// Steered and queued messages are also kept in their own tables; give those
/// rows the same references. A queued row is rewritten from its own value, as it
/// may have been edited since this event.
fn rewrite_side_tables(c: &Connection, event: &EventPayload, dir: &crate::MediaDir) -> Result<()> {
    match event {
        EventPayload::MessageSteered { message_id, message } => {
            c.execute(
                "UPDATE steered_messages SET payload = ?2 WHERE id = ?1",
                params![message_id.to_string(), serde_json::to_string(message)?],
            )?;
        }
        EventPayload::MessageQueued { message } | EventPayload::MessageQueueUpdated { message } => {
            let stored: Option<String> =
                c.query_row("SELECT payload FROM queued_messages WHERE id = ?1", [message.id.to_string()], |r| r.get(0)).optional()?;
            if let Some(stored) = stored
                && let Ok(mut current) = serde_json::from_str::<kybern_protocol::methods::QueuedMessage>(&stored)
            {
                let mut externalizer = Externalizer::new(dir);
                externalizer.message(&mut current.message)?;
                if !externalizer.made.is_empty() {
                    c.execute(
                        "UPDATE queued_messages SET payload = ?2 WHERE id = ?1",
                        params![message.id.to_string(), serde_json::to_string(&current)?],
                    )?;
                }
            }
        }
        _ => {}
    }
    Ok(())
}

fn file_len(path: &Path) -> u64 {
    std::fs::metadata(path).map_or(0, |meta| meta.len())
}

fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

fn remove_if_exists(path: &Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("remove {}", path.display())),
    }
}

#[cfg(test)]
#[path = "storage_tests.rs"]
mod tests;
