// Included into the parent fixture module: Older threads and unarchive (`older.rs`).

/// A thread whose last activity was `days` ago: created then, with no turn since.
fn idle_for_days(fixture: &Fixture, days: i64) -> Thread {
    // An upsert never rewrites `created_at`, so the backdated thread is a new row; the archived template is no candidate.
    let mut thread = fixture.thread(ThreadStatus::Archived);
    thread.id = Uuid::now_v7();
    thread.status = ThreadStatus::Idle;
    thread.created_at = chrono::Utc::now() - chrono::Duration::days(days);
    thread.updated_at = thread.created_at;
    fixture.store.thread_upsert(&thread).unwrap();
    thread
}

fn older_update(thread: &Thread, keep_out_of_older: Option<bool>, move_out_of_older: bool) -> methods::ThreadsUpdateParams {
    methods::ThreadsUpdateParams {
        thread_id: thread.id,
        title: None,
        pinned: None,
        permission_mode: None,
        model: None,
        effort: None,
        keep_out_of_older,
        move_out_of_older,
    }
}

const OLDER_WEEK: Option<chrono::Duration> = Some(chrono::Duration::days(7));

#[tokio::test]
async fn an_inactive_thread_moves_to_older_quietly_and_a_new_turn_brings_it_back() {
    let fixture = Fixture::new();
    let o = &fixture.orchestrator;
    let thread = idle_for_days(&fixture, 10);
    let recent = idle_for_days(&fixture, 2);
    let mut pinned = idle_for_days(&fixture, 10);
    pinned.pinned = true;
    fixture.store.thread_upsert(&pinned).unwrap();
    let head = fixture.store.thread_head_seq(thread.id).unwrap();

    assert_eq!(o.apply_older(OLDER_WEEK, chrono::Utc::now()).unwrap(), 1);
    let moved = fixture.store.thread_get(thread.id).unwrap().unwrap();
    assert!(moved.older_at.is_some());
    assert_eq!(moved.updated_at, thread.updated_at, "the move keeps the thread's last-change time");
    assert!(fixture.store.threads_changed_since(head, None).unwrap().iter().any(|t| t.id == thread.id), "lists see the move");
    assert!(fixture.store.events_for_thread(thread.id).unwrap().iter().any(|event| matches!(&event.payload,
        EventPayload::ThreadUpdated { thread } if thread.older_at.is_some())));
    assert!(fixture.store.thread_get(recent.id).unwrap().unwrap().older_at.is_none());
    assert!(fixture.store.thread_get(pinned.id).unwrap().unwrap().older_at.is_none());
    assert_eq!(o.apply_older(OLDER_WEEK, chrono::Utc::now()).unwrap(), 0, "a second pass changes nothing");

    // A stale copy written by another path (a rename) cannot take it out.
    let mut stale = thread.clone();
    stale.title = "Renamed".into();
    o.update_thread(stale).unwrap();
    assert!(fixture.store.thread_get(thread.id).unwrap().unwrap().older_at.is_some());

    let (live, _) = fixture.park(&moved, Instant::now()).await;
    o.send(thread.id, UserMessage::text("back to it")).await.unwrap();
    live.turn_ready.notified().await;
    let back = fixture.store.thread_get(thread.id).unwrap().unwrap();
    assert!(back.older_at.is_none(), "a new turn brings it back");
    assert!(back.updated_at > thread.updated_at, "at the top of the list");
    let candidates = fixture.store.older_candidates().unwrap();
    assert!(candidates.iter().find(|row| row.thread_id == thread.id).unwrap().active_at > chrono::Utc::now() - chrono::Duration::minutes(1));
}

#[tokio::test]
async fn move_out_of_older_restarts_the_clock_and_the_opt_out_keeps_a_thread_out() {
    let fixture = Fixture::new();
    let o = &fixture.orchestrator;
    let thread = idle_for_days(&fixture, 10);
    let kept = idle_for_days(&fixture, 10);
    o.apply_older(OLDER_WEEK, chrono::Utc::now()).unwrap();

    o.update_thread_fields(older_update(&thread, None, true)).unwrap();
    let out = fixture.store.thread_get(thread.id).unwrap().unwrap();
    assert!(out.older_at.is_none() && out.updated_at > thread.updated_at, "out of Older and at the top");
    assert_eq!(o.apply_older(OLDER_WEEK, chrono::Utc::now()).unwrap(), 0, "its clock started again");
    assert_eq!(o.apply_older(OLDER_WEEK, chrono::Utc::now() + chrono::Duration::days(7)).unwrap(), 1, "until a week passes");

    o.update_thread_fields(older_update(&kept, Some(true), false)).unwrap();
    let kept_now = fixture.store.thread_get(kept.id).unwrap().unwrap();
    assert!(kept_now.keep_out_of_older && kept_now.older_at.is_none());
    assert_eq!(o.apply_older(OLDER_WEEK, chrono::Utc::now() + chrono::Duration::days(60)).unwrap(), 0);
    o.update_thread_fields(older_update(&kept, Some(false), false)).unwrap();
    o.apply_older(OLDER_WEEK, chrono::Utc::now()).unwrap();
    assert!(fixture.store.thread_get(kept.id).unwrap().unwrap().older_at.is_some(), "turning the opt-out off lets it move again");
}

#[tokio::test]
async fn children_coordinators_and_waiting_threads_are_never_moved() {
    let fixture = Fixture::new();
    let o = &fixture.orchestrator;
    let parent = idle_for_days(&fixture, 10);
    let mut child = idle_for_days(&fixture, 10);
    child.parent_thread_id = Some(parent.id);
    fixture.store.thread_upsert(&child).unwrap();
    let mut lead = idle_for_days(&fixture, 10);
    lead.coordinator_project_id = Some(fixture.project.id);
    fixture.store.thread_upsert(&lead).unwrap();
    let queued = idle_for_days(&fixture, 10);
    o.enqueue(methods::QueuedMessage { id: Uuid::now_v7(), thread_id: queued.id, message: UserMessage::text("later") }).unwrap();

    o.apply_older(OLDER_WEEK, chrono::Utc::now()).unwrap();
    let older = |id| fixture.store.thread_get(id).unwrap().unwrap().older_at.is_some();
    assert!(older(parent.id));
    assert!(!older(child.id) && !older(lead.id) && !older(queued.id));
}

// Successful cleanup requires the lsof or /proc process-ownership backend.
#[cfg(unix)]
#[tokio::test]
async fn unarchive_brings_a_thread_back_and_its_cleaned_worktree_returns_with_the_next_message() {
    let (fixture, thread) = ordinary_worktree_fixture().await;
    let o = &fixture.orchestrator;
    let mut settings = o.inner.settings.get();
    settings.automatic_worktree_cleanup = true;
    o.inner.settings.set(settings).unwrap();
    fixture.store.thread_set_older(thread.id, Some(chrono::Utc::now())).unwrap();

    o.archive_thread(thread.id).await.unwrap();
    assert!(!PathBuf::from(&thread.cwd).exists(), "cleanup removed the clean, merged worktree");
    let refused = o.send(thread.id, UserMessage::text("hi")).await.unwrap_err().to_string();
    assert!(refused.contains("archived"), "{refused}");

    let back = o.unarchive_thread(thread.id).unwrap();
    assert_eq!(back.status, ThreadStatus::Idle);
    assert!(back.older_at.is_none(), "unarchiving does not land it in Older");
    assert_eq!(fixture.store.thread_get(thread.id).unwrap().unwrap().status, ThreadStatus::Idle);
    assert!(fixture.store.events_for_thread(thread.id).unwrap().iter().any(|event| matches!(&event.payload,
        EventPayload::ThreadUpdated { thread } if thread.status == ThreadStatus::Idle)));
    assert!(fixture.store.threads_list(Some(fixture.project.id), false).unwrap().iter().any(|t| t.id == thread.id));
    assert_eq!(o.apply_older(OLDER_WEEK, chrono::Utc::now()).unwrap(), 0);

    // Continuing restores the folder (the send path's first step).
    o.restore_worktree_if_cleaned(&back).await.unwrap();
    assert!(PathBuf::from(&thread.cwd).exists());
    assert_eq!(o.unarchive_thread(thread.id).unwrap().status, ThreadStatus::Idle, "unarchiving twice is harmless");
}

#[tokio::test]
async fn unarchive_leaves_subagent_threads_archived_and_refuses_them() {
    let (fixture, thread, live) = subagent_fixture().await;
    let o = &fixture.orchestrator;
    o.handle_driver_event(thread.id, &live, DriverEvent::RuntimeTaskStarted(agent_task("task-1", Some("toolu_1"), None)))
        .await
        .unwrap();
    let child = child_of(&fixture, thread.id, "task-1");
    o.archive_thread(thread.id).await.unwrap();
    assert_eq!(fixture.store.thread_get(child.id).unwrap().unwrap().status, ThreadStatus::Archived);

    assert_eq!(o.unarchive_thread(thread.id).unwrap().status, ThreadStatus::Idle);
    assert_eq!(fixture.store.thread_get(child.id).unwrap().unwrap().status, ThreadStatus::Archived, "children stay archived");
    assert!(o.unarchive_thread(child.id).is_err(), "a subagent thread is read-only");
}
