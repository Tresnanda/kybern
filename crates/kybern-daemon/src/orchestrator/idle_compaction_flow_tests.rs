// Idle compaction through the orchestrator: a scripted Claude Code session, the
// store, and an injected time. Included into `orchestrator::tests`.

/// A fixture on scripted Claude Code with "Compact idle threads" set to `mode`.
fn idle_fixture(mode: IdleCompaction) -> (Fixture, Arc<std::sync::Mutex<Vec<ScriptedChild>>>) {
    let spawned = Arc::new(std::sync::Mutex::new(Vec::new()));
    let mut drivers = DriverRegistry::default();
    drivers.register(Arc::new(ScriptedDriver { kind: ProviderKind::ClaudeCode, spawned: spawned.clone() }));
    let fixture = Fixture::with_drivers(drivers);
    let mut settings = fixture.orchestrator.inner.settings.get();
    settings.compaction.idle = mode;
    fixture.orchestrator.inner.settings.set(settings).unwrap();
    (fixture, spawned)
}

/// A finished turn that left `used` tokens of context and a cache expiring at `expires`.
fn finished_turn(fixture: &Fixture, thread: &Thread, text: &str, used: u64, expires: Option<chrono::DateTime<chrono::Utc>>) -> TurnId {
    let turn_id = Uuid::now_v7();
    let emit = |payload| fixture.orchestrator.emit(thread.id, Some(turn_id), payload).unwrap();
    emit(EventPayload::TurnStarted { message_id: Uuid::now_v7(), message: UserMessage::text(text) });
    emit(EventPayload::ProviderUsageUpdated {
        usage: ProviderUsage {
            context: Some(ContextUsage { used_tokens: used, window_tokens: 1_000_000 }),
            limits: None,
            prompt_cache: expires.map(|expires_at| PromptCache { ttl_seconds: Some(3600), expires_at: Some(expires_at), estimated: false }),
        },
    });
    emit(EventPayload::TurnCompleted {
        stop_reason: StopReason::Completed,
        usage: Usage::default(),
        cost_usd: None,
        duration_ms: 1,
        terminal_message_id: None,
    });
    turn_id
}

#[tokio::test]
async fn an_idle_compaction_sends_compact_inside_the_window_and_marks_its_turn() {
    let (fixture, spawned) = idle_fixture(IdleCompaction::BeforeCacheExpires);
    let thread = fixture.thread(ThreadStatus::Idle);
    let expires = chrono::Utc::now() + chrono::Duration::hours(1);
    let turn = finished_turn(&fixture, &thread, "Refactor the parser", 312_000, Some(expires));
    let facts = fixture.orchestrator.idle_compaction_facts(thread.id).await.unwrap();
    let planned = super::idle_compaction::plan(&facts, chrono::Utc::now()).unwrap();
    assert_eq!((planned.turn_id, planned.fire_at, planned.context_tokens), (turn, expires - chrono::Duration::minutes(2), 312_000));

    let compaction = fixture.orchestrator.run_idle_compaction(thread.id, &planned, planned.fire_at).await.unwrap().expect("compacted");
    let child = eventually(|| async { spawned.lock().unwrap().first().cloned() }).await;
    eventually(|| async { child.messages.lock().await.last().is_some_and(|m| m.plain_text() == "/compact").then_some(()) }).await;
    let events = fixture.store.events_for_thread(thread.id).unwrap();
    let started = events.iter().position(|e| e.turn_id == Some(compaction) && matches!(e.payload, EventPayload::TurnStarted { .. }));
    let marked = events.iter().position(|e| {
        e.turn_id == Some(compaction)
            && matches!(e.payload, EventPayload::IdleCompactionStarted { context_tokens: 312_000, cache_expires_at, cache_ttl_seconds: Some(3600) } if cache_expires_at == expires)
    });
    assert!(started.is_some() && marked.is_some() && started < marked, "the notice belongs to the compaction's own turn");

    // That turn is the compaction: one per idle spell.
    child.tx.send(completed_response(StopReason::Completed)).await.unwrap();
    eventually(|| async { (fixture.store.thread_get(thread.id).unwrap().unwrap().status == ThreadStatus::Idle).then_some(()) }).await;
    let facts = fixture.orchestrator.idle_compaction_facts(thread.id).await.unwrap();
    assert_eq!(super::idle_compaction::plan(&facts, chrono::Utc::now()).map(|_| ()), Err(super::idle_compaction::Skip::AlreadyCompacted));
}

#[tokio::test]
async fn a_planned_compaction_is_dropped_when_the_thread_moved_on() {
    let (fixture, spawned) = idle_fixture(IdleCompaction::BeforeCacheExpires);
    let mut thread = fixture.thread(ThreadStatus::Idle);
    let expires = chrono::Utc::now() + chrono::Duration::hours(1);
    finished_turn(&fixture, &thread, "first", 250_000, Some(expires));
    let planned = super::idle_compaction::plan(&fixture.orchestrator.idle_compaction_facts(thread.id).await.unwrap(), chrono::Utc::now()).unwrap();

    // A newer turn finished meanwhile: its own plan replaces this one.
    finished_turn(&fixture, &thread, "second", 260_000, Some(expires + chrono::Duration::minutes(5)));
    assert_eq!(fixture.orchestrator.run_idle_compaction(thread.id, &planned, planned.fire_at).await.unwrap(), None);

    // The thread resumed another session.
    let planned = super::idle_compaction::plan(&fixture.orchestrator.idle_compaction_facts(thread.id).await.unwrap(), chrono::Utc::now()).unwrap();
    thread.provider_session_id = Some("another-session".into());
    fixture.store.thread_upsert(&thread).unwrap();
    assert_eq!(fixture.orchestrator.run_idle_compaction(thread.id, &planned, planned.fire_at).await.unwrap(), None);

    // Archived, or the setting turned off.
    thread.provider_session_id = Some("provider-session".into());
    thread.status = ThreadStatus::Archived;
    fixture.store.thread_upsert(&thread).unwrap();
    assert_eq!(fixture.orchestrator.run_idle_compaction(thread.id, &planned, planned.fire_at).await.unwrap(), None);
    thread.status = ThreadStatus::Idle;
    fixture.store.thread_upsert(&thread).unwrap();
    let mut settings = fixture.orchestrator.inner.settings.get();
    settings.compaction.idle = IdleCompaction::WhenYouReturn;
    fixture.orchestrator.inner.settings.set(settings).unwrap();
    assert_eq!(fixture.orchestrator.run_idle_compaction(thread.id, &planned, planned.fire_at).await.unwrap(), None);
    assert!(spawned.lock().unwrap().is_empty(), "no session was resumed for a skipped compaction");
}

#[tokio::test]
async fn a_pending_question_queued_message_or_running_agent_holds_the_compaction() {
    let (fixture, _spawned) = idle_fixture(IdleCompaction::BeforeCacheExpires);
    let thread = fixture.thread(ThreadStatus::Idle);
    finished_turn(&fixture, &thread, "first", 250_000, Some(chrono::Utc::now() + chrono::Duration::hours(1)));
    let plan = |facts| super::idle_compaction::plan(&facts, chrono::Utc::now()).map(|_| ());
    assert_eq!(plan(fixture.orchestrator.idle_compaction_facts(thread.id).await.unwrap()), Ok(()));
    fixture.orchestrator.enqueue_admitted(methods::QueuedMessage { id: Uuid::now_v7(), thread_id: thread.id, message: UserMessage::text("next") }).unwrap();
    assert_eq!(plan(fixture.orchestrator.idle_compaction_facts(thread.id).await.unwrap()), Err(super::idle_compaction::Skip::BackgroundWork));
}

#[tokio::test]
async fn a_restarted_daemon_plans_again_only_while_the_cache_is_warm() {
    let (fixture, _spawned) = idle_fixture(IdleCompaction::BeforeCacheExpires);
    let warm = fixture.thread(ThreadStatus::Idle);
    finished_turn(&fixture, &warm, "warm", 250_000, Some(chrono::Utc::now() + chrono::Duration::minutes(30)));
    let cold = fixture.thread(ThreadStatus::Idle);
    finished_turn(&fixture, &cold, "cold", 250_000, Some(chrono::Utc::now() + chrono::Duration::seconds(10)));
    fixture.orchestrator.resume_idle_compactions().await.unwrap();
    eventually(|| async { fixture.orchestrator.inner.idle_compactions.planned(warm.id).then_some(()) }).await;
    // The missed window falls back to "When you return": nothing is planned.
    let facts = fixture.orchestrator.idle_compaction_facts(cold.id).await.unwrap();
    assert_eq!(super::idle_compaction::plan(&facts, chrono::Utc::now()).map(|_| ()), Err(super::idle_compaction::Skip::Missed));
}

#[tokio::test]
async fn launches_carry_the_threshold_and_never_declines_the_resume_offer_per_account() {
    let (fixture, _spawned) = idle_fixture(IdleCompaction::WhenYouReturn);
    let mut settings = fixture.orchestrator.inner.settings.get();
    settings.compaction.auto_compact_tokens.insert(ProviderKind::ClaudeCode, 400_000);
    let claude = settings.providers.entry(ProviderKind::ClaudeCode).or_default();
    claude.idle_compaction.insert("work".into(), IdleCompaction::Never);
    fixture.orchestrator.inner.settings.set(settings).unwrap();
    let default = fixture.orchestrator.compaction_launch(&ProviderInstance::default_for(ProviderKind::ClaudeCode));
    assert_eq!(default, kybern_drivers::CompactionLaunch { auto_compact_tokens: Some(400_000), decline_resume_prompt: false });
    let work = fixture.orchestrator.compaction_launch(&ProviderInstance { kind: ProviderKind::ClaudeCode, instance: "work".into() });
    assert_eq!(work, kybern_drivers::CompactionLaunch { auto_compact_tokens: Some(400_000), decline_resume_prompt: true });
}

#[tokio::test]
async fn codex_turns_record_the_estimated_cache_and_claude_turns_keep_their_own() {
    let (fixture, _spawned) = idle_fixture(IdleCompaction::WhenYouReturn);
    let codex = fixture.thread_with_provider(ThreadStatus::Idle, ProviderKind::Codex);
    let before = chrono::Utc::now();
    let cache = fixture.orchestrator.estimated_prompt_cache(&codex).expect("an estimate");
    assert_eq!((cache.ttl_seconds, cache.estimated), (Some(1800), true));
    assert!(cache.expires_at.unwrap() >= before + chrono::Duration::minutes(30));
    assert_eq!(fixture.orchestrator.estimated_prompt_cache(&fixture.thread(ThreadStatus::Idle)), None);
    let grok = fixture.thread_with_provider(ThreadStatus::Idle, ProviderKind::GrokBuild);
    assert_eq!(fixture.orchestrator.estimated_prompt_cache(&grok), None);
}
