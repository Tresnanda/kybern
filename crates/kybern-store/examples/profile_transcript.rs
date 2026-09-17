//! Run only against a sanitized scratch database. Timings are not RAM figures.
use kybern_protocol::ThreadId;
use kybern_store::{Store, transcript_page_ref};
use std::{hint::black_box, path::PathBuf, time::Instant};

fn main() -> anyhow::Result<()> {
    let args: Vec<_> = std::env::args().collect();
    anyhow::ensure!(args.len() == 3, "usage: profile_transcript scratch/state.sqlite thread-id");
    let path = PathBuf::from(&args[1]).canonicalize()?;
    anyhow::ensure!(path.components().any(|part| part.as_os_str() == ".scratch"), "use an isolated .scratch database");
    let store = Store::open(&path)?;
    let thread: ThreadId = args[2].parse()?;
    let head = store.thread_get(thread)?.ok_or_else(|| anyhow::anyhow!("missing fixture thread"))?.last_seq;
    for through in [head / 4, head / 2, head] {
        for run in 0..5 {
            let start = Instant::now();
            let entries = store.project_transcript_through(thread, through)?;
            let fold_ms = start.elapsed().as_secs_f64() * 1000.0;
            let start = Instant::now();
            let page = transcript_page_ref(&entries, Some(60), None);
            let page_ms = start.elapsed().as_secs_f64() * 1000.0;
            println!(
                "{}",
                serde_json::json!({"through_seq":through,"run":run,"folded_rows":entries.len(),"page_rows":page.0.len(),"fold_ms":fold_ms,"page_ms":page_ms})
            );
            black_box(page);
        }
    }
    Ok(())
}
