//! Sequence-keyed, byte-bounded read cache. No mutable controls or credentials.
use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};

use anyhow::Result;
use kybern_protocol::*;
use kybern_store::{Store, TranscriptFold};
use serde::Serialize;
use tokio::sync::{Mutex, OnceCell, Semaphore};

type Key = (ThreadId, EventSeq);
const MAX_ENTRIES: usize = 16;
const MAX_BYTES: usize = 32 * 1024 * 1024;

/// Thread-wide state returned with a first page. Older pages do not need it,
/// so it is read only when a request asks for it.
#[derive(Serialize)]
pub struct ThreadSideState {
    pub runtime_tasks: Vec<RuntimeTask>,
    pub provider_usage: ProviderUsage,
    pub provider_commands: Vec<ProviderCommand>,
    pub pending_questions: Vec<AsyncQuestionRequest>,
}

/// The transcript fold at one sequence, kept whole so a newer snapshot of the
/// same thread can clone and extend it instead of replaying every event.
pub struct ThreadProjection {
    pub transcript: TranscriptFold,
    side: OnceLock<Arc<ThreadSideState>>,
    side_bytes: AtomicUsize,
}
impl ThreadProjection {
    pub fn new(transcript: TranscriptFold) -> Self {
        Self { transcript, side: OnceLock::new(), side_bytes: AtomicUsize::new(0) }
    }
    #[cfg(test)]
    pub fn from_events(events: &[ThreadEvent]) -> Self {
        let mut transcript = TranscriptFold::default();
        for event in events {
            transcript.apply(event);
        }
        let projection = Self::new(transcript);
        let _ = projection.side.set(Arc::new(ThreadSideState {
            runtime_tasks: kybern_store::project_runtime_tasks(events),
            provider_usage: kybern_store::project_provider_usage(events),
            provider_commands: events
                .iter()
                .rev()
                .find_map(|event| match &event.payload {
                    EventPayload::ProviderCommandsUpdated { commands } => Some(commands.clone()),
                    _ => None,
                })
                .unwrap_or_default(),
            pending_questions: kybern_store::project_pending_questions(events),
        }));
        projection
    }
}
struct Cached {
    projection: Arc<ThreadProjection>,
    bytes: usize,
}
impl Cached {
    fn bytes(&self) -> usize {
        self.bytes + self.projection.side_bytes.load(Ordering::Relaxed)
    }
}
struct Slot {
    value: Arc<OnceCell<Cached>>,
    touched: u64,
}
#[derive(Default)]
struct Entries {
    slots: HashMap<Key, Slot>,
    clock: u64,
}
impl Entries {
    /// Evict least recently used built projections until the byte budget holds.
    /// One projection over the budget is returned to its caller but not kept.
    fn evict(&mut self) {
        while self.slots.values().filter_map(|slot| slot.value.get()).map(Cached::bytes).sum::<usize>() > MAX_BYTES {
            let oldest =
                self.slots.iter().filter(|(_, slot)| slot.value.get().is_some()).min_by_key(|(_, slot)| slot.touched).map(|(key, _)| *key);
            match oldest {
                Some(oldest) => self.slots.remove(&oldest),
                None => break,
            };
        }
    }
}
pub struct ThreadProjectionCache {
    entries: Mutex<Entries>,
    builds: Arc<Semaphore>,
}
impl Default for ThreadProjectionCache {
    fn default() -> Self {
        Self { entries: Mutex::new(Entries::default()), builds: Arc::new(Semaphore::new(2)) }
    }
}

impl ThreadProjectionCache {
    /// The thread's transcript fold through `through_seq`. A live thread moves
    /// its head between older-page requests; folding its whole history again
    /// for each one took ~0.3 s per page on a 47k-event thread. Extending the
    /// newest cached fold below the requested head reads only the new events.
    pub async fn transcript(&self, store: Store, thread_id: ThreadId, through_seq: EventSeq) -> Result<Arc<ThreadProjection>> {
        self.get_or_build((thread_id, through_seq), move |base| {
            let (mut fold, after) = match base {
                Some((seq, projection)) => (projection.transcript.clone(), seq),
                None => (TranscriptFold::omitting_tool_outputs(), 0),
            };
            store.extend_transcript_fold(thread_id, &mut fold, after, through_seq)?;
            Ok(ThreadProjection::new(fold))
        })
        .await
    }

    /// Runtime tasks, provider usage and commands and pending questions at the
    /// projection's sequence, read once per projection and only on demand.
    pub async fn side_state(
        &self,
        projection: &Arc<ThreadProjection>,
        store: Store,
        thread_id: ThreadId,
        through_seq: EventSeq,
    ) -> Result<Arc<ThreadSideState>> {
        if let Some(side) = projection.side.get() {
            return Ok(side.clone());
        }
        let permit = self.builds.clone().acquire_owned().await?;
        let target = projection.clone();
        let side = tokio::task::spawn_blocking(move || -> Result<Arc<ThreadSideState>> {
            let _permit = permit;
            if let Some(side) = target.side.get() {
                return Ok(side.clone());
            }
            let side = ThreadSideState {
                runtime_tasks: store.runtime_tasks_for_thread_through(thread_id, through_seq)?,
                provider_usage: store.provider_usage_through(thread_id, through_seq)?,
                provider_commands: store.provider_commands_through(thread_id, through_seq)?,
                pending_questions: store.pending_questions_through(thread_id, through_seq)?,
            };
            let mut size = Size(0);
            serde_json::to_writer(&mut size, &side)?;
            let bytes = size.0 + side.runtime_tasks.capacity() * std::mem::size_of::<RuntimeTask>();
            if target.side.set(Arc::new(side)).is_ok() {
                target.side_bytes.store(bytes, Ordering::Relaxed);
            }
            Ok(target.side.get().expect("side state was just set").clone())
        })
        .await??;
        self.entries.lock().await.evict();
        Ok(side)
    }

    /// `build` receives the newest built projection of the same thread below the
    /// requested sequence, if one is cached, to extend instead of starting over.
    pub async fn get_or_build<F>(&self, key: Key, build: F) -> Result<Arc<ThreadProjection>>
    where
        F: FnOnce(Option<(EventSeq, Arc<ThreadProjection>)>) -> Result<ThreadProjection> + Send + 'static,
    {
        let (cell, base) = {
            let mut entries = self.entries.lock().await;
            entries.clock += 1;
            let touched = entries.clock;
            if let Some(slot) = entries.slots.get_mut(&key) {
                slot.touched = touched;
                (slot.value.clone(), None)
            } else {
                let base = entries
                    .slots
                    .iter()
                    .filter(|((thread, seq), _)| *thread == key.0 && *seq < key.1)
                    .filter_map(|((_, seq), slot)| slot.value.get().map(|cached| (*seq, cached.projection.clone())))
                    .max_by_key(|(seq, _)| *seq);
                // Pending builds can be evicted from the index, but their callers
                // retain the cell and the shared build semaphore still bounds CPU.
                if entries.slots.len() >= MAX_ENTRIES {
                    let oldest = *entries.slots.iter().min_by_key(|(_, slot)| slot.touched).unwrap().0;
                    entries.slots.remove(&oldest);
                }
                let value = Arc::new(OnceCell::new());
                entries.slots.insert(key, Slot { value: value.clone(), touched });
                (value, base)
            }
        };
        let result = cell
            .get_or_try_init(|| async {
                let permit = self.builds.clone().acquire_owned().await?;
                tokio::task::spawn_blocking(move || -> Result<Cached> {
                    let _permit = permit;
                    let projection = build(base)?;
                    let mut size = Size(0);
                    serde_json::to_writer(&mut size, projection.transcript.rows())?;
                    // Include row storage as well as encoded data; avoid allocating
                    // another full JSON string just to enforce the cache budget.
                    let bytes = size.0 + std::mem::size_of_val(projection.transcript.rows());
                    Ok(Cached { projection: Arc::new(projection), bytes })
                })
                .await?
            })
            .await;
        let mut entries = self.entries.lock().await;
        match result {
            Ok(value) => {
                let projection = value.projection.clone();
                entries.evict();
                Ok(projection)
            }
            Err(error) => {
                if entries.slots.get(&key).is_some_and(|slot| Arc::ptr_eq(&slot.value, &cell)) {
                    entries.slots.remove(&key);
                }
                Err(error)
            }
        }
    }
}
struct Size(usize);
impl Write for Size {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0 += bytes.len();
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn notice(seq: EventSeq, text: String) -> ThreadEvent {
        ThreadEvent {
            seq,
            thread_id: ThreadId::nil(),
            turn_id: Some(TurnId::nil()),
            at: chrono::Utc::now(),
            payload: EventPayload::ProviderNotice { level: NoticeLevel::Info, text, data: None },
        }
    }

    #[tokio::test]
    async fn same_sequence_shares_projection_but_new_heads_rebuild() {
        let cache = ThreadProjectionCache::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let build = || {
            let calls = calls.clone();
            move |_| {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(ThreadProjection::from_events(&[]))
            }
        };
        let key = (ThreadId::nil(), 10);
        let (a, b) = tokio::join!(cache.get_or_build(key, build()), cache.get_or_build(key, build()));
        assert!(Arc::ptr_eq(&a.unwrap(), &b.unwrap()));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        cache.get_or_build((key.0, 11), build()).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert!(cache.get_or_build((key.0, 12), |_| anyhow::bail!("read failed")).await.is_err());
        cache.get_or_build((key.0, 12), build()).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn a_newer_head_extends_the_newest_older_fold_of_the_same_thread() {
        let cache = ThreadProjectionCache::default();
        let other = ThreadId::new_v4();
        cache
            .get_or_build((ThreadId::nil(), 5), |base| {
                assert!(base.is_none());
                Ok(ThreadProjection::from_events(&[notice(5, "a".into())]))
            })
            .await
            .unwrap();
        cache.get_or_build((ThreadId::nil(), 8), |_| Ok(ThreadProjection::from_events(&[notice(8, "b".into())]))).await.unwrap();
        cache
            .get_or_build((other, 9), |base| {
                assert!(base.is_none(), "another thread is never a base");
                Ok(ThreadProjection::from_events(&[]))
            })
            .await
            .unwrap();
        cache
            .get_or_build((ThreadId::nil(), 12), |base| {
                let (seq, projection) = base.expect("an older fold of the same thread");
                assert_eq!(seq, 8);
                assert_eq!(projection.transcript.rows().len(), 1);
                Ok(ThreadProjection::new(projection.transcript.clone()))
            })
            .await
            .unwrap();
        // An older snapshot cannot be derived from a newer one.
        cache
            .get_or_build((ThreadId::nil(), 3), |base| {
                assert!(base.is_none());
                Ok(ThreadProjection::from_events(&[]))
            })
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn cache_bounds_entries_and_does_not_retain_oversized_projections() {
        let cache = ThreadProjectionCache::default();
        for seq in 0..20 {
            cache.get_or_build((ThreadId::nil(), seq), |_| Ok(ThreadProjection::from_events(&[]))).await.unwrap();
        }
        assert_eq!(cache.entries.lock().await.slots.len(), MAX_ENTRIES);
        let value = cache
            .get_or_build((ThreadId::nil(), 21), |_| Ok(ThreadProjection::from_events(&[notice(1, "x".repeat(MAX_BYTES + 1))])))
            .await
            .unwrap();
        assert_eq!(value.transcript.rows().len(), 1);
        assert!(!cache.entries.lock().await.slots.contains_key(&(ThreadId::nil(), 21)));
    }
}
