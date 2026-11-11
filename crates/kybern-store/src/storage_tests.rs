use super::*;
use base64::Engine;
use kybern_protocol::*;
use serde_json::{Value, json};
use uuid::Uuid;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

fn png(size: usize, salt: u8) -> String {
    let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
    bytes.extend((0..size).map(|i| (i as u8).wrapping_mul(31).wrapping_add(salt).wrapping_add((i >> 8) as u8)));
    B64.encode(bytes)
}

fn fixture(store: &Store) -> Thread {
    let now = Utc::now();
    let project = Project {
        repo: None,
        repos: Vec::new(),
        id: Uuid::now_v7(),
        name: "demo".into(),
        path: format!("/tmp/demo-{}", Uuid::now_v7()),
        is_git: false,
        worktrees_default: None,
        task_prefix: None,
        brief_in_all_threads: false,
        coordinator: None,
        space_id: None,
        created_at: now,
        updated_at: now,
        kind: Default::default(),
        members: Vec::new(),
        worktree_copy: Vec::new(),
        instructions_offer_dismissed: false,
    };
    store.project_insert(&project).unwrap();
    let thread = Thread {
        id: Uuid::now_v7(),
        project_id: project.id,
        title: "hello".into(),
        provider: ProviderInstance::default_for(ProviderKind::ClaudeCode),
        model: None,
        effort: None,
        permission_mode: PermissionMode::Supervised,
        status: ThreadStatus::Idle,
        worktree: None,
        cwd: project.path.clone(),
        provider_session_id: None,
        pinned: false,
        created_at: now,
        updated_at: now,
        last_seq: 0,
        parent_thread_id: None,
        coordinator_project_id: None,
        origin: None,
        inbound: None,
        moved: None,
        subagent: None,
        delegation: None,
        members: Vec::new(),
    };
    store.thread_upsert(&thread).unwrap();
    thread
}

fn on_disk() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("state.sqlite")).unwrap();
    (dir, store)
}

fn image_result(data: &str) -> Value {
    json!([{ "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": data } }])
}

fn completed(id: &str, output: Value, is_error: bool) -> EventPayload {
    EventPayload::ToolCallCompleted { tool_call_id: id.into(), output, output_omitted: false, stream_recoverable: false, is_error }
}

fn started(id: &str) -> EventPayload {
    EventPayload::ToolCallStarted {
        call: ToolCall { id: id.into(), name: "Read".into(), input: json!({}), parent_id: None },
        origin: EventOrigin::Root,
    }
}

fn call(store: &Store, thread: ThreadId, id: &str, output: Value) -> i64 {
    let turn = Some(Uuid::now_v7());
    let message = EventPayload::TurnStarted { message_id: Uuid::now_v7(), message: UserMessage::text("go") };
    store.event_append(thread, turn, message).unwrap();
    store.event_append(thread, turn, started(id)).unwrap();
    store.event_append(thread, turn, completed(id, output, false)).unwrap().seq
}

fn stored_payload(store: &Store, seq: i64) -> String {
    store.with(|c| Ok(c.query_row("SELECT payload FROM events WHERE seq = ?1", [seq], |r| r.get(0))?)).unwrap()
}

fn count(store: &Store, sql: &str) -> i64 {
    store.with(|c| Ok(c.query_row(sql, [], |r| r.get(0))?)).unwrap()
}

fn files(dir: &tempfile::TempDir) -> usize {
    std::fs::read_dir(dir.path().join("assets")).map_or(0, |entries| entries.count())
}

/// Insert an event the way 0.23 did: media inline, no side rows.
fn legacy(store: &Store, thread: ThreadId, payload: &EventPayload) -> i64 {
    store
        .with(|c| {
            c.execute(
                "INSERT INTO events(thread_id, at, kind, payload) VALUES (?1, ?2, ?3, ?4)",
                params![thread.to_string(), Utc::now().to_rfc3339(), payload.kind(), serde_json::to_string(payload)?],
            )?;
            Ok(c.last_insert_rowid())
        })
        .unwrap()
}

#[test]
fn new_media_is_stored_once_outside_the_database_and_restores() {
    let (dir, store) = on_disk();
    let thread = fixture(&store);
    let data = png(400_000, 1);
    let first = call(&store, thread.id, "a", image_result(&data));
    let second = call(&store, thread.id, "b", image_result(&data));
    for seq in [first, second] {
        let payload = stored_payload(&store, seq);
        assert!(payload.len() < 1_000, "{} bytes stored", payload.len());
        assert!(payload.contains(MEDIA_REF_KEY));
    }
    assert_eq!(files(&dir), 1, "the same image is one file");
    let stats = store.storage_stats().unwrap();
    assert_eq!((stats.media_files, stats.media_bytes), (1, 400_008));
    // The full output comes back with the reference; inlining restores the original.
    let (mut output, _) = store.tool_call_output_through(thread.id, "a", None, i64::MAX).unwrap().unwrap();
    crate::inline_value(&mut output, store.media_dir().unwrap()).unwrap();
    assert_eq!(output, image_result(&data));
}

#[test]
fn prompt_images_are_stored_as_references_and_the_queue_keeps_them() {
    let (_dir, store) = on_disk();
    let thread = fixture(&store);
    let data = png(50_000, 2);
    let message = UserMessage { parts: vec![ContentPart::Image { media_type: "image/png".into(), data: data.clone() }] };
    let id = Uuid::now_v7();
    let queued = methods::QueuedMessage { id, thread_id: thread.id, message: message.clone() };
    store.event_append(thread.id, None, EventPayload::MessageQueued { message: queued }).unwrap();
    let queued = store.queue_list(Some(thread.id)).unwrap();
    let mut stored = queued[0].message.clone();
    assert!(matches!(stored.parts[0], ContentPart::Media { .. }));
    store.inline_message(&mut stored).unwrap();
    assert_eq!(stored, message);
    // A retried request compares equal once stored the same way.
    let mut retried = message.clone();
    store.externalize_message(&mut retried).unwrap();
    assert_eq!(retried, queued[0].message);
}

#[test]
fn history_pages_read_large_results_as_stubs_and_tool_output_reads_them_whole() {
    let (_dir, store) = on_disk();
    let thread = fixture(&store);
    let text = json!({ "content": "y".repeat(3_000_000) });
    let small = json!("ok");
    call(&store, thread.id, "big", text.clone());
    call(&store, thread.id, "small", small.clone());
    assert_eq!(count(&store, "SELECT COUNT(*) FROM event_output_stubs"), 1);
    let mut entries = store.project_transcript_through(thread.id, i64::MAX).unwrap();
    let outputs: Vec<_> = entries
        .iter()
        .filter_map(|entry| match entry {
            TranscriptEntry::ToolCall { call, output, output_omitted, .. } => Some((call.id.clone(), output.clone(), *output_omitted)),
            _ => None,
        })
        .collect();
    assert_eq!(outputs, vec![("big".to_string(), None, true), ("small".to_string(), Some(small), false)]);
    // The compact replay a client subscribes with leaves it out the same way.
    let replay = store.events_after_bounded_compact(Some(thread.id), 0, 100, 1 << 20).unwrap();
    assert!(replay.iter().any(
        |event| matches!(&event.payload, EventPayload::ToolCallCompleted { tool_call_id, output_omitted: true, .. } if tool_call_id == "big")
    ));
    store.hydrate_tool_outputs_through(thread.id, &mut entries, i64::MAX).unwrap();
    assert!(entries.iter().any(|entry| matches!(entry, TranscriptEntry::ToolCall { output: Some(value), .. } if *value == text)));
}

#[test]
fn projections_read_inline_and_referenced_shapes_alike() {
    let (_dir, store) = on_disk();
    let thread = fixture(&store);
    let data = png(30_000, 3);
    let turn = Uuid::now_v7();
    let inline = UserMessage { parts: vec![ContentPart::Image { media_type: "image/png".into(), data: data.clone() }] };
    let old = EventPayload::TurnStarted { message_id: Uuid::now_v7(), message: inline.clone() };
    store
        .with(|c| {
            c.execute(
                "INSERT INTO events(thread_id, turn_id, at, kind, payload) VALUES (?1, ?2, ?3, 'turn_started', ?4)",
                params![thread.id.to_string(), turn.to_string(), Utc::now().to_rfc3339(), serde_json::to_string(&old)?],
            )?;
            Ok(())
        })
        .unwrap();
    let image = |id: &str, source: String| EventPayload::ImageReceived { id: id.into(), origin: EventOrigin::Root, source, media: None };
    store.event_append(thread.id, Some(turn), image("old", "https://example.com/a.png".into())).unwrap();
    store.event_append(thread.id, Some(turn), image("new", format!("data:image/png;base64,{data}"))).unwrap();
    store.event_append(thread.id, Some(turn), EventPayload::TurnStarted { message_id: Uuid::now_v7(), message: inline }).unwrap();
    let entries = store.project_transcript_through(thread.id, i64::MAX).unwrap();
    let users: Vec<_> = entries
        .iter()
        .filter_map(|entry| match entry {
            TranscriptEntry::User { message, .. } => Some(message.parts[0].clone()),
            _ => None,
        })
        .collect();
    assert!(matches!(users[0], ContentPart::Image { .. }));
    assert!(matches!(users[1], ContentPart::Media { .. }));
    let images: Vec<_> = entries
        .iter()
        .filter_map(|entry| match entry {
            TranscriptEntry::Image { source, media, .. } => Some((source.clone(), media.is_some())),
            _ => None,
        })
        .collect();
    assert_eq!(images, vec![("https://example.com/a.png".to_string(), false), (String::new(), true)]);
}

#[test]
fn the_rewrite_moves_old_rows_in_resumable_idempotent_steps() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.sqlite");
    let (thread, seqs, big_text) = {
        let store = Store::open(&path).unwrap();
        let thread = fixture(&store);
        let mut seqs = Vec::new();
        for i in 0..6u8 {
            legacy(&store, thread.id, &started(&format!("c{i}")));
            seqs.push(legacy(&store, thread.id, &completed(&format!("c{i}"), image_result(&png(60_000, i % 3)), false)));
        }
        let big_text = json!("z".repeat(10_000));
        legacy(&store, thread.id, &started("text"));
        seqs.push(legacy(&store, thread.id, &completed("text", big_text.clone(), true)));
        legacy(
            &store,
            thread.id,
            &EventPayload::ProviderNotice { level: NoticeLevel::Info, text: "x".repeat(40_000), data: None, problem: None },
        );
        // Counting, then two rows per step; stop part way, as a quit would.
        let mut progress = store.media_rewrite_step(2, 1 << 30).unwrap();
        while progress.counting {
            progress = store.media_rewrite_step(2, 1 << 30).unwrap();
        }
        assert_eq!(progress.total, 6);
        let progress = store.media_rewrite_step(2, 1 << 30).unwrap();
        assert_eq!((progress.processed, progress.done), (2, false));
        // A crash after a step wrote its files but before it changed its rows:
        // the files are there, the rows still inline. The next run reuses them.
        let mut payload: EventPayload = serde_json::from_str(&stored_payload(&store, seqs[2])).unwrap();
        crate::media::Externalizer::new(store.media_dir().unwrap()).payload(&mut payload).unwrap();
        (thread, seqs, big_text)
    };
    let store = Store::open(&path).unwrap();
    let mut progress = store.media_rewrite_progress().unwrap();
    while !progress.done {
        progress = store.media_rewrite_step(2, 1 << 30).unwrap();
    }
    assert_eq!(progress.processed, 6);
    for (i, seq) in seqs.iter().take(6).enumerate() {
        let payload = stored_payload(&store, *seq);
        assert!(payload.len() < 1_000 && payload.contains(MEDIA_REF_KEY), "row {i} stays at seq {seq}");
    }
    assert_eq!(files(&dir), 3, "three distinct images");
    assert_eq!(count(&store, "SELECT COUNT(*) FROM media_refs"), 6);
    // The large text result got a stub; it is still read whole on demand.
    let stub: bool =
        store.with(|c| Ok(c.query_row("SELECT is_error FROM event_output_stubs WHERE seq = ?1", [seqs[6]], |r| r.get(0))?)).unwrap();
    assert!(stub);
    assert_eq!(store.tool_call_output_through(thread.id, "text", None, i64::MAX).unwrap().unwrap().0, big_text);
    // Running it again changes nothing.
    let before: Vec<_> = seqs.iter().map(|seq| stored_payload(&store, *seq)).collect();
    assert!(store.media_rewrite_step(10, 1 << 30).unwrap().done);
    assert_eq!(before, seqs.iter().map(|seq| stored_payload(&store, *seq)).collect::<Vec<_>>());
    // Images of old threads still come back.
    let (mut output, _) = store.tool_call_output_through(thread.id, "c0", None, i64::MAX).unwrap().unwrap();
    crate::inline_value(&mut output, store.media_dir().unwrap()).unwrap();
    assert_eq!(output, image_result(&png(60_000, 0)));
}

#[test]
fn the_sweep_removes_files_of_deleted_threads_and_keeps_archived_ones() {
    let (dir, store) = on_disk();
    let kept = fixture(&store);
    let deleted = fixture(&store);
    call(&store, kept.id, "a", image_result(&png(30_000, 7)));
    call(&store, deleted.id, "b", image_result(&png(30_000, 8)));
    call(&store, deleted.id, "c", image_result(&png(30_000, 7)));
    // A file written by a step that never finished.
    let orphan = store.media_dir().unwrap().write(b"%PDF-1.4 orphan").unwrap();
    store.event_append(kept.id, None, EventPayload::ThreadArchived).unwrap();
    assert_eq!(files(&dir), 3);
    // Young files are left alone.
    assert_eq!(store.media_sweep(MEDIA_SWEEP_GRACE).unwrap().removed_files, 0);
    store.project_delete(deleted.project_id).unwrap();
    let report = store.media_sweep(std::time::Duration::ZERO).unwrap();
    assert_eq!(report.removed_files, 2, "the deleted thread's own image and the orphan");
    let left: Vec<_> =
        std::fs::read_dir(dir.path().join("assets")).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(left.len(), 1);
    assert!(!left.contains(&orphan));
    let (mut output, _) = store.tool_call_output_through(kept.id, "a", None, i64::MAX).unwrap().unwrap();
    crate::inline_value(&mut output, store.media_dir().unwrap()).unwrap();
}

#[test]
fn provider_commands_are_written_only_when_they_change_within_a_session() {
    let store = Store::open_in_memory().unwrap();
    let thread = fixture(&store);
    let list = |names: &[&str]| -> Vec<ProviderCommand> {
        names.iter().map(|name| serde_json::from_value(json!({ "name": name, "description": "d" })).unwrap()).collect()
    };
    assert!(store.provider_commands_changed(thread.id, &list(&["a"])).unwrap());
    store.event_append(thread.id, None, EventPayload::ProviderCommandsUpdated { commands: list(&["a"]) }).unwrap();
    assert!(!store.provider_commands_changed(thread.id, &list(&["a"])).unwrap());
    assert!(store.provider_commands_changed(thread.id, &list(&["a", "b"])).unwrap());
    let instance = ProviderInstance::default_for(ProviderKind::ClaudeCode);
    let transition =
        EventPayload::SessionTransitioned { from: instance.clone(), to: instance, native_resume: false, text: "switched".into() };
    store.event_append(thread.id, None, transition).unwrap();
    assert!(store.provider_commands_changed(thread.id, &list(&["a"])).unwrap(), "a transition cleared the list");
}

#[test]
fn reclaim_compacts_the_database_and_keeps_writes_made_meanwhile() {
    let (dir, store) = on_disk();
    let thread = fixture(&store);
    for i in 0..100u8 {
        legacy(&store, thread.id, &completed(&format!("c{i}"), image_result(&png(300_000, i)), false));
    }
    assert!(matches!(store.reclaim(u64::MAX, &|_| {}), Err(ReclaimError::MediaMoving)));
    while !store.media_rewrite_step(8, 1 << 30).unwrap().done {}
    let before = store.storage_stats().unwrap();
    assert!(before.reclaimable_bytes > NOTHING_TO_RECLAIM_BYTES, "{before:?}");
    let low = store.reclaim(1024, &|_| {});
    assert!(matches!(low, Err(ReclaimError::LowDisk { need, free: 1024 }) if need >= before.compacted_bytes), "{low:?}");
    // A write while the copy is being written is carried over.
    let wrote = AtomicBool::new(false);
    let writer = store.clone();
    let freed = store
        .reclaim(u64::MAX, &|phase| {
            if matches!(phase, ReclaimPhase::Writing { .. }) && !wrote.swap(true, Ordering::AcqRel) {
                let notice = EventPayload::ProviderNotice { level: NoticeLevel::Info, text: "during".into(), data: None, problem: None };
                writer.event_append(thread.id, None, notice).unwrap();
            }
        })
        .unwrap();
    assert!(freed > NOTHING_TO_RECLAIM_BYTES, "freed {freed}");
    let after = store.storage_stats().unwrap();
    assert!(after.database_bytes < before.database_bytes / 4, "{before:?} → {after:?}");
    let events = store.events_for_thread(thread.id).unwrap();
    assert!(events.iter().any(|event| matches!(&event.payload, EventPayload::ProviderNotice { text, .. } if text == "during")));
    assert_eq!(events.iter().filter(|event| matches!(event.payload, EventPayload::ToolCallCompleted { .. })).count(), 100);
    // The store keeps working on the new file.
    store.event_append(thread.id, None, EventPayload::ThreadArchived).unwrap();
    assert!(!dir.path().join("state.sqlite.compact").exists());
    assert!(!dir.path().join("state.sqlite.before-reclaim").exists());
    assert!(matches!(store.reclaim(u64::MAX, &|_| {}), Err(ReclaimError::NothingToReclaim)));
    drop(store);
    drop(writer);
    let reopened = Store::open(&dir.path().join("state.sqlite")).unwrap();
    assert_eq!(reopened.events_for_thread(thread.id).unwrap().len(), events.len() + 1);
}

fn file_bytes(path: &std::path::Path) -> u64 {
    let wal = std::path::PathBuf::from(format!("{}-wal", path.display()));
    std::fs::metadata(path).map_or(0, |m| m.len()) + std::fs::metadata(wal).map_or(0, |m| m.len())
}

fn random_bytes(len: usize, seed: u64, header: &[u8]) -> Vec<u8> {
    let mut state = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
    let mut out = header.to_vec();
    while out.len() < len {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        out.extend_from_slice(&state.to_le_bytes());
    }
    out.truncate(len);
    out
}

/// Measurement for the PR: how much `state.sqlite` grows for N image and PDF tool results, inline (0.23) and stored
/// outside (0.24). `cargo test -p kybern-store --lib measure_db_growth -- --ignored --nocapture`
#[test]
#[ignore]
fn measure_db_growth() {
    for outside in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.sqlite");
        let mut store = Store::open(&path).unwrap();
        if !outside {
            store.media = None;
        }
        let thread = fixture(&store);
        store.with(|c| Ok(c.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?)).unwrap();
        let before = file_bytes(&path);
        for i in 0..40u64 {
            let png = B64.encode(random_bytes(500_000, i, b"\x89PNG\r\n\x1a\n"));
            call(&store, thread.id, &format!("img{i}"), image_result(&png));
        }
        for i in 0..10u64 {
            let pdf = B64.encode(random_bytes(2_000_000, 1000 + i, b"%PDF-1.7\n"));
            let output = json!([{ "type": "document", "source": { "type": "base64", "media_type": "application/pdf", "data": pdf } }]);
            call(&store, thread.id, &format!("pdf{i}"), output);
        }
        store.with(|c| Ok(c.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?)).unwrap();
        let after = file_bytes(&path);
        let assets: u64 =
            std::fs::read_dir(dir.path().join("assets")).map_or(0, |e| e.flatten().map(|f| f.metadata().unwrap().len()).sum());
        println!(
            "{}: 40 × 500 KB PNG + 10 × 2 MB PDF results → state.sqlite +{:.1} MB, assets/ {:.1} MB",
            if outside { "0.24 (outside)" } else { "0.23 (inline)" },
            (after - before) as f64 / 1e6,
            assets as f64 / 1e6
        );
    }
}

/// Writes a database the way 0.23 left it (media inline, schema before #298) at `KYBERN_LEGACY_DB`, for measuring the
/// daemon: `KYBERN_LEGACY_THREADS` threads × `KYBERN_LEGACY_IMAGES` image results of `KYBERN_LEGACY_IMAGE_KB` KB each,
/// plus one thread ("heavy") with 8 results of 6 MB. Prints the heavy thread's id.
#[test]
#[ignore]
fn generate_legacy_database() {
    let path = std::path::PathBuf::from(std::env::var("KYBERN_LEGACY_DB").expect("KYBERN_LEGACY_DB"));
    let var = |name: &str, default: u64| std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default);
    let (threads, images, kb) = (var("KYBERN_LEGACY_THREADS", 20), var("KYBERN_LEGACY_IMAGES", 50), var("KYBERN_LEGACY_IMAGE_KB", 600));
    let mut store = Store::open(&path).unwrap();
    store.media = None;
    let commands: Vec<ProviderCommand> = (0..400)
        .map(|i| serde_json::from_value(json!({ "name": format!("command-{i}"), "description": "x".repeat(300) })).unwrap())
        .collect();
    let insert = |store: &Store, thread: ThreadId, turn: Uuid, payload: &EventPayload| {
        store
            .with(|c| {
                c.execute(
                    "INSERT INTO events(thread_id, turn_id, at, kind, payload) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![thread.to_string(), turn.to_string(), Utc::now().to_rfc3339(), payload.kind(), serde_json::to_string(payload)?],
                )?;
                Ok(())
            })
            .unwrap()
    };
    let heavy = fixture(&store);
    let turn = Uuid::now_v7();
    insert(&store, heavy.id, turn, &EventPayload::TurnStarted { message_id: Uuid::now_v7(), message: UserMessage::text("read the scans") });
    for i in 0..8u64 {
        insert(&store, heavy.id, turn, &started(&format!("h{i}")));
        let png = B64.encode(random_bytes(6_000_000, 90_000 + i, b"\x89PNG\r\n\x1a\n"));
        insert(&store, heavy.id, turn, &completed(&format!("h{i}"), image_result(&png), false));
        let text = EventPayload::AssistantMessageCompleted {
            message_id: Uuid::now_v7(),
            origin: Default::default(),
            text: format!("Page {i} read."),
            thinking: None,
        };
        insert(&store, heavy.id, turn, &text);
    }
    for t in 0..threads {
        let thread = fixture(&store);
        let turn = Uuid::now_v7();
        insert(&store, thread.id, turn, &EventPayload::TurnStarted { message_id: Uuid::now_v7(), message: UserMessage::text("go") });
        insert(&store, thread.id, turn, &EventPayload::ProviderCommandsUpdated { commands: commands.clone() });
        for i in 0..images {
            let id = format!("t{t}i{i}");
            insert(&store, thread.id, turn, &started(&id));
            let png = B64.encode(random_bytes((kb * 1000) as usize, t * 100_000 + i, b"\x89PNG\r\n\x1a\n"));
            insert(&store, thread.id, turn, &completed(&id, image_result(&png), false));
        }
    }
    let version: i64 = store.with(|c| Ok(c.query_row("PRAGMA user_version", [], |r| r.get(0))?)).unwrap();
    store
        .with(|c| {
            c.execute_batch("DROP TABLE event_output_stubs; DROP TABLE media_refs; DROP TABLE media;")?;
            c.pragma_update(None, "user_version", version - 1)?;
            c.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
            Ok(())
        })
        .unwrap();
    println!("heavy thread {}; {} threads; {:.2} GB", heavy.id, threads + 1, file_bytes(&path) as f64 / 1e9);
}

#[test]
fn a_reused_file_is_not_swept_before_its_event_is_written() {
    let (dir, store) = on_disk();
    let thread = fixture(&store);
    let bytes = B64.decode(png(30_000, 3)).unwrap();
    let media = store.media_dir().unwrap().clone();
    let hash = media.write(&bytes).unwrap();
    let file = dir.path().join("assets").join(&hash);
    let aged = |path: &std::path::Path| {
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(2 * 60 * 60);
        std::fs::OpenOptions::new().write(true).open(path).unwrap().set_modified(old).unwrap();
    };
    // No event refers to the file and it is old: the sweep takes it.
    aged(&file);
    assert_eq!(store.media_sweep(MEDIA_SWEEP_GRACE).unwrap().removed_files, 1);
    assert!(!file.exists());
    // The same bytes again, from a write whose event is not stored yet: the reused file is touched,
    // so a sweep in between leaves it for the event about to refer to it.
    media.write(&bytes).unwrap();
    aged(&file);
    assert_eq!(media.write(&bytes).unwrap(), hash);
    assert_eq!(store.media_sweep(MEDIA_SWEEP_GRACE).unwrap().removed_files, 0);
    call(&store, thread.id, "a", image_result(&B64.encode(&bytes)));
    let (mut output, _) = store.tool_call_output_through(thread.id, "a", None, i64::MAX).unwrap().unwrap();
    crate::inline_value(&mut output, &media).unwrap();
    assert_eq!(output, image_result(&B64.encode(&bytes)));
}

#[test]
fn a_compaction_stopped_at_any_point_leaves_a_whole_database() {
    let (dir, store) = on_disk();
    let thread = fixture(&store);
    for i in 0..3u8 {
        call(&store, thread.id, &format!("c{i}"), json!({ "text": i }));
    }
    let events = store.events_for_thread(thread.id).unwrap().len();
    drop(store);
    let path = dir.path().join("state.sqlite");
    let side = |suffix: &str| std::path::PathBuf::from(format!("{}{suffix}", path.display()));
    // Stopped while the copy was written: the partial copy goes.
    std::fs::write(side(".compact"), b"partial").unwrap();
    // Stopped after the copy moved in, before the old file was removed.
    std::fs::hard_link(&path, side(".before-reclaim")).unwrap();
    let store = Store::open(&path).unwrap();
    assert_eq!(store.events_for_thread(thread.id).unwrap().len(), events);
    assert!(!side(".compact").exists() && !side(".before-reclaim").exists());
    drop(store);
    // The old file moved aside and the new one not yet in: the old one comes back, not an empty database.
    std::fs::rename(&path, side(".before-reclaim")).unwrap();
    let store = Store::open(&path).unwrap();
    assert_eq!(store.events_for_thread(thread.id).unwrap().len(), events);
}

#[test]
fn a_compacted_copy_that_went_missing_never_replaces_the_database() {
    let (dir, store) = on_disk();
    let thread = fixture(&store);
    for i in 0..100u8 {
        legacy(&store, thread.id, &completed(&format!("c{i}"), image_result(&png(300_000, i)), false));
    }
    while !store.media_rewrite_step(8, 1 << 30).unwrap().done {}
    let compact = dir.path().join("state.sqlite.compact");
    let result = store.reclaim(u64::MAX, &|phase| {
        if matches!(phase, ReclaimPhase::Finishing) {
            std::fs::remove_file(&compact).unwrap();
        }
    });
    assert!(matches!(result, Err(ReclaimError::Failed(_))), "{result:?}");
    assert!(!compact.exists());
    assert_eq!(store.events_for_thread(thread.id).unwrap().len(), 100);
    store.event_append(thread.id, None, EventPayload::ThreadArchived).unwrap();
    // A later run still works.
    store.reclaim(u64::MAX, &|_| {}).unwrap();
    assert_eq!(store.events_for_thread(thread.id).unwrap().len(), 101);
}
