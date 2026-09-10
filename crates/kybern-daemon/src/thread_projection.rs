//! Sequence-keyed, byte-bounded read cache. No mutable controls or credentials.
use std::collections::HashMap;
use std::io::Write;
use std::sync::Arc;

use anyhow::Result;
use kybern_protocol::*;
use serde::Serialize;
use tokio::sync::{Mutex, OnceCell, Semaphore};

type Key = (ThreadId, EventSeq);
const MAX_ENTRIES: usize = 16;
const MAX_BYTES: usize = 32 * 1024 * 1024;

#[derive(Serialize)]
pub struct ThreadProjection {
    pub transcript: Vec<TranscriptEntry>,
    pub runtime_tasks: Vec<RuntimeTask>,
    pub provider_usage: ProviderUsage,
    pub provider_commands: Vec<ProviderCommand>,
    pub pending_questions: Vec<AsyncQuestionRequest>,
}
impl ThreadProjection {
    pub fn from_events(events: &[ThreadEvent]) -> Self {
        Self {
            transcript: kybern_store::project_transcript(events),
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
        }
    }
}
struct Cached {
    projection: Arc<ThreadProjection>,
    bytes: usize,
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
    pub async fn get_or_build<F>(&self, key: Key, build: F) -> Result<Arc<ThreadProjection>>
    where
        F: FnOnce() -> Result<ThreadProjection> + Send + 'static,
    {
        let cell = {
            let mut entries = self.entries.lock().await;
            entries.clock += 1;
            let touched = entries.clock;
            if let Some(slot) = entries.slots.get_mut(&key) {
                slot.touched = touched;
                slot.value.clone()
            } else {
                // Pending builds can be evicted from the index, but their callers
                // retain the cell and the shared build semaphore still bounds CPU.
                if entries.slots.len() >= MAX_ENTRIES {
                    let oldest = *entries.slots.iter().min_by_key(|(_, slot)| slot.touched).unwrap().0;
                    entries.slots.remove(&oldest);
                }
                let value = Arc::new(OnceCell::new());
                entries.slots.insert(key, Slot { value: value.clone(), touched });
                value
            }
        };
        let result = cell
            .get_or_try_init(|| async {
                let permit = self.builds.clone().acquire_owned().await?;
                tokio::task::spawn_blocking(move || -> Result<Cached> {
                    let _permit = permit;
                    let projection = build()?;
                    let mut size = Size(0);
                    serde_json::to_writer(&mut size, &projection)?;
                    // Include row storage as well as encoded data; avoid allocating
                    // another full JSON string just to enforce the cache budget.
                    let bytes = size.0
                        + projection.transcript.capacity() * std::mem::size_of::<TranscriptEntry>()
                        + projection.runtime_tasks.capacity() * std::mem::size_of::<RuntimeTask>();
                    Ok(Cached { projection: Arc::new(projection), bytes })
                })
                .await?
            })
            .await;
        let mut entries = self.entries.lock().await;
        match result {
            Ok(value) => {
                let projection = value.projection.clone();
                while entries.slots.values().filter_map(|slot| slot.value.get()).map(|value| value.bytes).sum::<usize>() > MAX_BYTES {
                    let oldest = entries
                        .slots
                        .iter()
                        .filter(|(_, slot)| slot.value.get().is_some())
                        .min_by_key(|(_, slot)| slot.touched)
                        .map(|(key, _)| *key);
                    if let Some(oldest) = oldest {
                        entries.slots.remove(&oldest);
                    } else {
                        break;
                    }
                }
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
    #[tokio::test]
    async fn same_sequence_shares_projection_but_new_heads_rebuild() {
        let cache = ThreadProjectionCache::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let build = || {
            let calls = calls.clone();
            move || {
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
        assert!(cache.get_or_build((key.0, 12), || anyhow::bail!("read failed")).await.is_err());
        cache.get_or_build((key.0, 12), build()).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }
    #[tokio::test]
    async fn cache_bounds_entries_and_does_not_retain_oversized_projections() {
        let cache = ThreadProjectionCache::default();
        for seq in 0..20 {
            cache.get_or_build((ThreadId::nil(), seq), || Ok(ThreadProjection::from_events(&[]))).await.unwrap();
        }
        assert_eq!(cache.entries.lock().await.slots.len(), MAX_ENTRIES);
        let value = cache
            .get_or_build((ThreadId::nil(), 21), || {
                let mut projection = ThreadProjection::from_events(&[]);
                projection.transcript.push(TranscriptEntry::Notice {
                    turn_id: ThreadId::nil(),
                    seq: 1,
                    at: chrono::Utc::now(),
                    level: NoticeLevel::Info,
                    text: "x".repeat(MAX_BYTES + 1),
                });
                Ok(projection)
            })
            .await
            .unwrap();
        assert_eq!(value.transcript.len(), 1);
        assert!(!cache.entries.lock().await.slots.contains_key(&(ThreadId::nil(), 21)));
    }
}
