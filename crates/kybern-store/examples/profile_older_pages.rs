//! Time each stage of an older `threads.get` page against a scratch copy.
//! Run only against a database copy whose path contains `gpuix-scratch`.
use kybern_protocol::ThreadId;
use kybern_store::{Store, transcript_page_ref};
use std::{path::PathBuf, time::Instant};

fn ms(start: Instant) -> f64 {
    (start.elapsed().as_secs_f64() * 10_000.0).round() / 10.0
}

fn main() -> anyhow::Result<()> {
    let args: Vec<_> = std::env::args().collect();
    anyhow::ensure!(args.len() >= 3, "usage: profile_older_pages gpuix-scratch/state.sqlite thread-id...");
    let path = PathBuf::from(&args[1]).canonicalize()?;
    anyhow::ensure!(path.to_string_lossy().contains("gpuix-scratch"), "use a gpuix-scratch database copy");
    let store = Store::open(&path)?;
    for id in &args[2..] {
        let thread: ThreadId = id.parse()?;
        let head = store.thread_get(thread)?.ok_or_else(|| anyhow::anyhow!("missing thread"))?.last_seq;
        let start = Instant::now();
        let fold_state = store.project_transcript_fold_through(thread, head)?;
        let entries = fold_state.rows().to_vec();
        let fold = ms(start);
        let start = Instant::now();
        let tasks = store.runtime_tasks_for_thread_through(thread, head)?.len();
        store.provider_usage_through(thread, head)?;
        store.provider_commands_through(thread, head)?;
        store.pending_questions_through(thread, head)?;
        let side = ms(start);
        let (_, mut cursor) = transcript_page_ref(&entries, Some(120), None);
        let mut pages = Vec::new();
        for _ in 0..3 {
            let Some(before) = cursor else { break };
            let start = Instant::now();
            let (mut page, next) = transcript_page_ref(&entries, Some(120), Some(before));
            let slice = ms(start);
            let start = Instant::now();
            fold_state.mark_tool_streams_omitted(&mut page);
            let streams = ms(start);
            let start = Instant::now();
            let bytes = serde_json::to_vec(&page)?.len();
            let encode = ms(start);
            pages.push(serde_json::json!({"slice_ms": slice, "streams_ms": streams, "encode_ms": encode, "kb": bytes / 1024}));
            cursor = next;
        }
        println!(
            "{}",
            serde_json::json!({"thread": &id[..8], "rows": entries.len(), "fold_ms": fold, "side_state_ms": side, "runtime_tasks": tasks, "pages": pages})
        );
    }
    Ok(())
}
