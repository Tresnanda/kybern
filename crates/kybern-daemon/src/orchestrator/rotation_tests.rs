// Coordinator context rotation tests. Included into `orchestrator::tests` so they can
// use its fixture, the scripted driver of the delegation tests and the lead helpers.

const VALID_HANDOFF: &str = "Here is the handoff.\n## Goals\nShip the importer.\n## Decisions (date, what, why, commit if any)\nNone\n\
## Reversals and removals\nThe pre-launch fallback was removed.\n## User preferences\n\"Keep commits small.\"\n## Open questions\nNone\n## Next steps\nNone";

/// A project Coordinator on scripted Claude Code and Codex sessions.
struct Lead {
    fixture: Fixture,
    spawned: Arc<std::sync::Mutex<Vec<ScriptedChild>>>,
    thread: Thread,
}

impl Lead {
    async fn new() -> Self {
        Self::build(false).await
    }

    /// A Coordinator whose project folder is a git repository with one commit.
    async fn in_git() -> Self {
        Self::build(true).await
    }

    async fn build(git: bool) -> Self {
        let spawned = Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut drivers = DriverRegistry::default();
        drivers.register(Arc::new(ScriptedDriver { kind: ProviderKind::ClaudeCode, spawned: spawned.clone() }));
        drivers.register(Arc::new(ScriptedDriver { kind: ProviderKind::Codex, spawned: spawned.clone() }));
        let fixture = Fixture::with_drivers(drivers);
        std::fs::create_dir_all(fixture.root.join("src/auth")).unwrap();
        if git {
            std::fs::write(fixture.root.join("src/auth/session.ts"), "export {}\n").unwrap();
            run_git(&fixture.root, &["init", "-q", "-b", "main"]);
            run_git(&fixture.root, &["add", "src"]);
            run_git(&fixture.root, &["commit", "-q", "-m", "init"]);
        }
        fixture.orchestrator.set_handoff_timeout(Duration::from_secs(20));
        user_note(&fixture, "Project brief", "Ship the importer.", Some(ProjectNoteRole::Brief));
        let thread = fixture.orchestrator.coordinator_open(open_params(&fixture.project, ProviderKind::ClaudeCode, None)).await.unwrap().thread;
        Self { fixture, spawned, thread }
    }

    fn set_budget(&self, tokens: u64) {
        let mut settings = self.fixture.orchestrator.inner.settings.get();
        settings.orchestration.rotation_budget_tokens = tokens;
        self.fixture.orchestrator.inner.settings.set(settings).unwrap();
    }

    fn current(&self) -> Thread {
        self.fixture.store.thread_get(self.thread.id).unwrap().unwrap()
    }

    /// The scripted process whose latest message ends with `text`.
    async fn session_with(&self, text: &str) -> ScriptedChild {
        eventually(|| async {
            let candidates: Vec<ScriptedChild> = self.spawned.lock().unwrap().clone();
            for candidate in candidates.into_iter().rev() {
                if candidate.messages.lock().await.last().is_some_and(|message| message.plain_text().ends_with(text)) {
                    return Some(candidate);
                }
            }
            None
        })
        .await
    }

    /// One user turn that reports `used` context tokens of a `window` and finishes.
    async fn turn(&self, text: &str, used: u64, window: u64) -> ScriptedChild {
        self.fixture.orchestrator.send(self.thread.id, UserMessage::text(text)).await.unwrap();
        let child = self.session_with(text).await;
        let usage = ProviderUsage { context: Some(ContextUsage { used_tokens: used, window_tokens: window }), limits: None };
        child.tx.send(DriverEvent::UsageUpdated(usage)).await.unwrap();
        child.finish(&format!("Answer to {text}")).await;
        eventually(|| async { (self.current().status == ThreadStatus::Idle).then_some(()) }).await;
        child
    }

    /// Wait until `child` has been sent `needle` `times` times in all.
    async fn wait_for_prompt(&self, child: &ScriptedChild, needle: &str, times: usize) {
        eventually(|| async {
            let count = child.messages.lock().await.iter().filter(|message| message.plain_text().contains(needle)).count();
            (count >= times).then_some(())
        })
        .await;
    }

    async fn answer_handoff(&self, child: &ScriptedChild, text: &str) {
        self.wait_for_prompt(child, "Your context is about to be refreshed", 1).await;
        child.finish(text).await;
    }

    fn events(&self) -> Vec<ThreadEvent> {
        self.fixture.store.events_for_thread(self.thread.id).unwrap()
    }

    fn started(&self) -> Vec<(String, RotationReason)> {
        self.events()
            .into_iter()
            .filter_map(|event| match event.payload {
                EventPayload::ContextRotationStarted { rotation_id, reason, .. } => Some((rotation_id, reason)),
                _ => None,
            })
            .collect()
    }

    /// The `ContextRotated` events so far: id, reason, handoff, status, from, to.
    fn rotated(&self) -> Vec<(String, RotationReason, Option<String>, HandoffStatus, HarnessRef, HarnessRef)> {
        self.events()
            .into_iter()
            .filter_map(|event| match event.payload {
                EventPayload::ContextRotated { rotation_id, reason, handoff, handoff_status, from, to, .. } => {
                    Some((rotation_id, reason, handoff, handoff_status, from, to))
                }
                _ => None,
            })
            .collect()
    }

    async fn wait_rotated(&self, count: usize) {
        eventually(|| async { (self.rotated().len() >= count && !self.fixture.orchestrator.is_rotating(self.thread.id)).then_some(()) })
            .await;
    }

    fn seed(&self) -> Option<super::rotation::RotationSeed> {
        self.fixture.orchestrator.rotation_seed(self.thread.id).unwrap()
    }
}

fn kinds_after(events: &[ThreadEvent], seq: EventSeq) -> Vec<&'static str> {
    events.iter().filter(|event| event.seq > seq).map(|event| event.payload.kind()).collect()
}

#[tokio::test]
async fn a_turn_past_the_budget_hands_off_and_the_next_message_starts_a_seeded_session() {
    let lead = Lead::new().await;
    let first = lead.turn("plan the importer", 120_000, 1_000_000).await;
    assert!(lead.started().is_empty(), "120k is under the 200k default");

    let old = lead.turn("review the parser", 250_000, 1_000_000).await;
    assert!(Arc::ptr_eq(&old.messages, &first.messages), "the same process ran both turns");
    let (rotation_id, reason) = eventually(|| async { lead.started().into_iter().next() }).await;
    assert_eq!(reason, RotationReason::Budget);
    let started_seq = lead.events().iter().find(|event| event.payload.kind() == "context_rotation_started").unwrap().seq;

    // The handoff turn is internal: tool calls, reasoning and text never reach the log.
    lead.wait_for_prompt(&old, "Your context is about to be refreshed", 1).await;
    assert!(old.messages.lock().await.last().unwrap().plain_text().starts_with(super::rotation::HANDOFF_PROMPT));
    old.tx
        .send(DriverEvent::ToolStarted(ToolCall {
            id: "t1".into(),
            name: "Read".into(),
            input: json!({}),
            parent_id: None,
        }))
        .await
        .unwrap();
    old.tx
        .send(DriverEvent::ThinkingDelta { message_id: "m".into(), origin: EventOrigin::Root, delta: "thinking".into() })
        .await
        .unwrap();
    old.tx.send(DriverEvent::TextDelta { message_id: "m".into(), origin: EventOrigin::Root, delta: "partial".into() }).await.unwrap();
    old.finish(VALID_HANDOFF).await;
    lead.wait_rotated(1).await;

    let events = lead.events();
    let after = kinds_after(&events, started_seq);
    assert_eq!(after.iter().filter(|kind| **kind == "context_rotated").count(), 1);
    for hidden in ["turn_started", "turn_completed", "assistant_text_delta", "assistant_thinking_delta", "assistant_message_completed", "tool_call_started"] {
        assert!(!after.contains(&hidden), "{hidden} leaked from the handoff turn: {after:?}");
    }
    let rows = kybern_store::project_transcript(&events);
    assert!(rows.iter().all(|row| !matches!(row, TranscriptEntry::Assistant { text, .. } if text.contains("## Goals"))));
    assert!(matches!(rows.last(), Some(TranscriptEntry::Rotation { pending: false, .. })), "{:?}", rows.last());

    let (id, _, handoff, status, from, to) = lead.rotated().remove(0);
    assert_eq!((id, status), (rotation_id.clone(), HandoffStatus::Written));
    assert!(handoff.as_deref().unwrap().starts_with("## Goals"), "the preamble before the first heading is dropped");
    assert_eq!((from.kind, to.kind), (ProviderKind::ClaudeCode, ProviderKind::ClaudeCode));
    assert_eq!(old.closes.load(Ordering::SeqCst), 1, "the old process closed");
    assert!(!lead.fixture.has_session(&lead.thread).await);
    assert_eq!(lead.current().provider_session_id, None);
    assert_eq!(lead.current().status, ThreadStatus::Idle);

    // The seed: handoff, facts and the recent messages verbatim.
    let seed = lead.seed().expect("a seed waits for the next message");
    assert_eq!(seed.rotation_id, rotation_id);
    for expected in [
        "[Kybern] This is a fresh session for this project's Coordinator.",
        "was refreshed (it used 250k tokens)",
        "## Handoff (written by the previous session)\n## Goals\nShip the importer.",
        "## Facts (from Kybern, not summarized)",
        "- Children running: none.",
        "- Pull requests: none open.",
        "- Tasks: none open.",
        "## Recent messages (verbatim)",
        "plan the importer",
        "Answer to review the parser",
    ] {
        assert!(seed.text.contains(expected), "missing {expected:?} in\n{}", seed.text);
    }
    let first_user = rows.iter().find_map(|row| match row {
        TranscriptEntry::User { seq, .. } => Some(*seq),
        _ => None,
    });
    assert!(seed.text.contains(&format!("(seq < {})", first_user.unwrap())));

    // The next message starts a fresh process whose first message carries the seed.
    lead.fixture.orchestrator.send(lead.thread.id, UserMessage::text("what next?")).await.unwrap();
    let fresh = lead.session_with("what next?").await;
    assert!(!Arc::ptr_eq(&fresh.messages, &old.messages), "a new process");
    let sent = fresh.messages.lock().await[0].plain_text();
    assert!(sent.starts_with("[Kybern] This is a fresh session") && sent.ends_with("what next?"), "{sent}");
    eventually(|| async { lead.seed().is_none().then_some(()) }).await;
    let stored = lead.events().into_iter().rev().find_map(|event| match event.payload {
        EventPayload::TurnStarted { message, .. } => Some(message.plain_text()),
        _ => None,
    });
    assert_eq!(stored.as_deref(), Some("what next?"), "the stored message has no seed");

    // Only the first message of the fresh session carries it.
    fresh.finish("ok").await;
    eventually(|| async { (lead.current().status == ThreadStatus::Idle).then_some(()) }).await;
    lead.fixture.orchestrator.send(lead.thread.id, UserMessage::text("and then?")).await.unwrap();
    lead.wait_for_prompt(&fresh, "and then?", 1).await;
    assert!(!fresh.messages.lock().await.last().unwrap().plain_text().contains("fresh session"));
}

#[tokio::test]
async fn the_budget_is_capped_at_half_the_window_and_zero_turns_it_off() {
    let lead = Lead::new().await;
    // 200k, but at most half of a 300k window: 150k.
    lead.turn("one", 140_000, 300_000).await;
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(lead.started().is_empty());
    let child = lead.turn("two", 160_000, 300_000).await;
    eventually(|| async { (!lead.started().is_empty()).then_some(()) }).await;
    lead.answer_handoff(&child, VALID_HANDOFF).await;
    lead.wait_rotated(1).await;

    // The fresh session's first turn never refreshes, even over the budget.
    lead.turn("fresh start", 900_000, 1_000_000).await;
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(lead.started().len(), 1, "a fresh session gets a second turn");

    lead.set_budget(0);
    lead.turn("three", 900_000, 1_000_000).await;
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(lead.started().len(), 1, "0 is off");

    // A project can turn it back on for itself.
    let mut project = lead.fixture.store.project_get(lead.fixture.project.id).unwrap().unwrap();
    project.coordinator = Some(CoordinatorOverrides { rotation_budget_tokens: Some(100_000), ..Default::default() });
    lead.fixture.store.project_update(&project).unwrap();
    lead.turn("four", 120_000, 1_000_000).await;
    eventually(|| async { (lead.started().len() == 2).then_some(()) }).await;

    // Settings refuse budgets between off and 50k.
    let mut settings = lead.fixture.orchestrator.inner.settings.get();
    settings.orchestration.rotation_budget_tokens = 10_000;
    let error = lead.fixture.orchestrator.inner.settings.set(settings).unwrap_err().to_string();
    assert!(error.contains("at least 50 000"), "{error}");
}

#[tokio::test]
async fn an_idle_lead_past_half_its_budget_writes_a_handoff_before_its_process_closes() {
    let lead = Lead::new().await;
    let child = lead.turn("plan", 120_000, 1_000_000).await;
    let later = Instant::now() + Duration::from_secs(3600);
    let wall = SystemTime::now() + Duration::from_secs(3600);
    let released = lead.fixture.orchestrator.release_idle_sessions_at(&policy(1, 8), false, later, wall).await.unwrap();
    assert!(released.is_empty(), "the rotation closes the process, not the sweep");
    let (_, reason) = eventually(|| async { lead.started().into_iter().next() }).await;
    assert_eq!(reason, RotationReason::Idle);
    assert_eq!(child.closes.load(Ordering::SeqCst), 0, "the handoff comes first");
    lead.answer_handoff(&child, VALID_HANDOFF).await;
    lead.wait_rotated(1).await;
    assert_eq!(child.closes.load(Ordering::SeqCst), 1);
    assert!(lead.seed().is_some());

    // Below half the budget, an idle lead is simply released.
    let next = lead.turn("again", 20_000, 1_000_000).await;
    let released = lead.fixture.orchestrator.release_idle_sessions_at(&policy(1, 8), false, later, wall).await.unwrap();
    assert_eq!(released.len(), 1);
    assert_eq!(next.closes.load(Ordering::SeqCst), 1);
    assert_eq!(lead.started().len(), 1);
}

#[tokio::test]
async fn a_manual_refresh_needs_an_idle_lead_and_messages_sent_meanwhile_wait_for_the_fresh_session() {
    let lead = Lead::new().await;
    lead.fixture.orchestrator.send(lead.thread.id, UserMessage::text("long work")).await.unwrap();
    let child = lead.session_with("long work").await;
    let refresh = || lead.fixture.orchestrator.coordinator_refresh_context(methods::CoordinatorRefreshContextParams { thread_id: lead.thread.id });
    let error = refresh().await.unwrap_err().to_string();
    assert!(error.contains("busy"), "{error}");
    child.finish("done").await;
    eventually(|| async { (lead.current().status == ThreadStatus::Idle).then_some(()) }).await;

    let rotation_id = refresh().await.unwrap().rotation_id;
    assert_eq!(lead.started(), vec![(rotation_id.clone(), RotationReason::Manual)]);
    assert!(refresh().await.unwrap_err().to_string().contains("already being refreshed"));
    let rows = kybern_store::project_transcript(&lead.events());
    assert!(matches!(rows.last(), Some(TranscriptEntry::Rotation { pending: true, .. })));

    // A message sent during the refresh queues; steering is refused.
    let sent = lead
        .fixture
        .orchestrator
        .send_client_message(methods::ThreadsSendParams {
            thread_id: lead.thread.id,
            message: UserMessage::text("queued while refreshing"),
            message_id: None,
        })
        .await
        .unwrap();
    assert_eq!(sent.turn_id, Uuid::nil());
    assert_eq!(lead.fixture.store.queue_list(Some(lead.thread.id)).unwrap().len(), 1);
    assert_eq!(lead.current().status, ThreadStatus::Idle);
    assert!(!lead.fixture.orchestrator.drain_queues().await.unwrap() || lead.fixture.store.queue_list(Some(lead.thread.id)).unwrap().len() == 1);
    let steer = lead
        .fixture
        .orchestrator
        .steer(methods::QueuedMessage { id: Uuid::now_v7(), thread_id: lead.thread.id, message: UserMessage::text("steer") })
        .await
        .unwrap_err()
        .to_string();
    assert!(steer.contains("refreshing"), "{steer}");

    lead.answer_handoff(&child, VALID_HANDOFF).await;
    lead.wait_rotated(1).await;
    lead.fixture.orchestrator.drain_queues().await.unwrap();
    let fresh = lead.session_with("queued while refreshing").await;
    let first = fresh.messages.lock().await[0].plain_text();
    assert!(first.starts_with("[Kybern] This is a fresh session") && first.contains("the user asked for it"), "{first}");
    assert!(lead.fixture.store.queue_list(Some(lead.thread.id)).unwrap().is_empty());
}

#[tokio::test]
async fn an_invalid_handoff_gets_one_correction_then_the_rotation_goes_on_without_it() {
    let lead = Lead::in_git().await;
    let head = run_git(&lead.fixture.root, &["rev-parse", "HEAD"]);
    let good = format!(
        "## Goals\nShip, as of `{}` in `src/auth/session.ts` and `src/auth/`, on `main`. Thread {}.\n## Decisions\nNone\n## Reversals and removals\nNone\n\
         ## User preferences\nNone\n## Open questions\nNone\n## Next steps\nNone",
        &head[..7],
        lead.thread.id
    );
    let bad = format!("## Goals\nSee `deadbee` and `src/missing.ts`, thread {}.\n## Next steps\nNone", Uuid::now_v7());

    // A first bad handoff, then a good correction.
    let child = lead.turn("plan", 10, 1_000_000).await;
    lead.fixture.orchestrator.coordinator_refresh_context(methods::CoordinatorRefreshContextParams { thread_id: lead.thread.id }).await.unwrap();
    lead.answer_handoff(&child, &bad).await;
    lead.wait_for_prompt(&child, "Your handoff has problems", 1).await;
    let correction = child.messages.lock().await.last().unwrap().plain_text();
    for expected in [
        "Line 2: `deadbee` is not a commit in this project.",
        "Line 2: `src/missing.ts` is not a file in this project",
        "is not a thread Kybern knows",
        "The heading \"## Decisions\" is missing.",
    ] {
        assert!(correction.contains(expected), "missing {expected:?} in\n{correction}");
    }
    child.finish(&good).await;
    lead.wait_rotated(1).await;
    let (_, _, handoff, status, ..) = lead.rotated().remove(0);
    assert_eq!(status, HandoffStatus::Written, "{handoff:?}");

    // Bad twice: no handoff, and the seed says so.
    let child = lead.turn("more", 10, 1_000_000).await;
    lead.fixture.orchestrator.coordinator_refresh_context(methods::CoordinatorRefreshContextParams { thread_id: lead.thread.id }).await.unwrap();
    lead.answer_handoff(&child, &bad).await;
    lead.wait_for_prompt(&child, "Your handoff has problems", 1).await;
    child.finish(&bad).await;
    lead.wait_rotated(2).await;
    let (_, _, handoff, status, ..) = lead.rotated().remove(1);
    assert!(handoff.is_none());
    assert!(matches!(&status, HandoffStatus::Missing { why } if why.contains("did not pass validation")), "{status:?}");
    let seed = lead.seed().unwrap();
    assert!(seed.text.contains("## Handoff (written by the previous session)\nNo handoff: The handoff did not pass validation"), "{}", seed.text);
    assert!(seed.text.contains("Rely on the facts and recent messages below."));
    assert!(seed.text.contains(&format!("as claims as of `{}`", &head[..7])), "{}", seed.text);
}

#[tokio::test]
async fn a_handoff_that_never_arrives_times_out_into_a_rotation_without_one() {
    let lead = Lead::new().await;
    lead.fixture.orchestrator.set_handoff_timeout(Duration::from_millis(300));
    lead.turn("plan", 10, 1_000_000).await;
    let child = lead.turn("build", 250_000, 1_000_000).await;
    lead.wait_for_prompt(&child, "Your context is about to be refreshed", 1).await;
    lead.wait_rotated(1).await;
    let (_, reason, handoff, status, ..) = lead.rotated().remove(0);
    assert_eq!((reason, handoff), (RotationReason::Budget, None));
    assert!(matches!(&status, HandoffStatus::Missing { why } if why.contains("did not write a handoff within")), "{status:?}");
    assert_eq!(child.closes.load(Ordering::SeqCst), 1);
    // A late answer from the closed process changes nothing.
    child.finish(VALID_HANDOFF).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(lead.rotated().len(), 1);
    assert!(lead.events().iter().all(|event| event.payload.kind() != "turn_failed"));
}

#[tokio::test]
async fn editing_the_handoff_rewrites_an_unsent_seed_or_corrects_a_sent_one_once() {
    let lead = Lead::new().await;
    let child = lead.turn("plan", 10, 1_000_000).await;
    let first = lead
        .fixture
        .orchestrator
        .coordinator_refresh_context(methods::CoordinatorRefreshContextParams { thread_id: lead.thread.id })
        .await
        .unwrap()
        .rotation_id;
    lead.answer_handoff(&child, VALID_HANDOFF).await;
    lead.wait_rotated(1).await;
    let edit = |rotation_id: &str, text: &str| {
        lead.fixture.orchestrator.coordinator_edit_handoff(methods::CoordinatorEditHandoffParams {
            thread_id: lead.thread.id,
            rotation_id: rotation_id.into(),
            text: text.into(),
        })
    };

    // Before the seed is sent: the seed itself carries the edit.
    edit(&first, "## Goals\nShip the exporter instead.").await.unwrap();
    let seed = lead.seed().unwrap();
    assert!(seed.text.contains("## Handoff (written by the previous session, edited by the user)\n## Goals\nShip the exporter instead.\n\n## Facts"));
    assert!(!seed.text.contains("Ship the importer.\n## Decisions"));
    let rows = kybern_store::project_transcript(&lead.events());
    assert!(rows.iter().any(|row| matches!(row, TranscriptEntry::Rotation { edited: true, handoff: Some(text), .. } if text.contains("exporter"))));
    let fresh = lead.turn("go", 10, 1_000_000).await;
    let sent = fresh.messages.lock().await[0].plain_text();
    assert!(sent.contains("Ship the exporter instead.") && !sent.contains("Handoff corrected by the user"), "{sent}");

    // After it was sent: the next message gets the correction once.
    edit(&first, "## Goals\nShip both.").await.unwrap();
    lead.turn("next", 10, 1_000_000).await;
    let messages = fresh.messages.lock().await.clone();
    let corrected = messages.last().unwrap().plain_text();
    assert!(corrected.starts_with("Handoff corrected by the user:\n## Goals\nShip both.") && corrected.ends_with("next"), "{corrected}");
    lead.turn("after", 10, 1_000_000).await;
    assert!(!fresh.messages.lock().await.last().unwrap().plain_text().contains("Handoff corrected"));

    // Only the latest rotation's handoff can be edited, and only with text.
    let latest = lead
        .fixture
        .orchestrator
        .coordinator_refresh_context(methods::CoordinatorRefreshContextParams { thread_id: lead.thread.id })
        .await
        .unwrap()
        .rotation_id;
    lead.answer_handoff(&fresh, VALID_HANDOFF).await;
    lead.wait_rotated(2).await;
    let error = edit(&first, "## Goals\nOld.").await.unwrap_err().to_string();
    assert!(error.contains("Only the latest"), "{error}");
    assert!(edit(&latest, "   ").await.unwrap_err().to_string().contains("Write the handoff text"));
    edit(&latest, "## Goals\nNew.").await.unwrap();
}

#[tokio::test]
async fn switching_the_harness_is_a_rotation_that_carries_the_handoff_to_the_new_harness() {
    let lead = Lead::new().await;
    let claude = lead.turn("plan", 10, 1_000_000).await;
    let orchestrator = lead.fixture.orchestrator.clone();
    let project_id = lead.fixture.project.id;
    let switching = tokio::spawn(async move {
        orchestrator
            .coordinator_switch_harness(methods::CoordinatorSwitchHarnessParams {
                project_id,
                provider: ProviderInstance::default_for(ProviderKind::Codex),
                model: Some("gpt-6".into()),
                effort: None,
                permission_mode: None,
            })
            .await
    });
    lead.answer_handoff(&claude, VALID_HANDOFF).await;
    let moved = switching.await.unwrap().unwrap();
    assert_eq!((moved.id, moved.provider.kind, moved.model.as_deref()), (lead.thread.id, ProviderKind::Codex, Some("gpt-6")));
    assert_eq!(moved.provider_session_id, None);
    let (_, reason, _, status, from, to) = lead.rotated().remove(0);
    assert_eq!((reason, status), (RotationReason::HarnessSwitch, HandoffStatus::Written));
    assert_eq!((from.kind, to.kind, to.model.as_deref()), (ProviderKind::ClaudeCode, ProviderKind::Codex, Some("gpt-6")));
    assert_eq!(claude.closes.load(Ordering::SeqCst), 1);

    lead.fixture.orchestrator.send(lead.thread.id, UserMessage::text("hello codex")).await.unwrap();
    let codex = lead.session_with("hello codex").await;
    let first = codex.messages.lock().await[0].plain_text();
    assert!(first.contains("the Coordinator moved to Codex (gpt-6)") && first.contains("Ship the importer."), "{first}");

    // Without a live process or a saved conversation there is nothing to hand off.
    codex.finish("hi").await;
    eventually(|| async { (lead.current().status == ThreadStatus::Idle).then_some(()) }).await;
    lead.fixture.orchestrator.inner.sessions.lock().await.remove(&lead.thread.id);
    let back = lead
        .fixture
        .orchestrator
        .coordinator_switch_harness(methods::CoordinatorSwitchHarnessParams {
            project_id,
            provider: ProviderInstance::default_for(ProviderKind::ClaudeCode),
            model: None,
            effort: None,
            permission_mode: None,
        })
        .await
        .unwrap();
    assert_eq!(back.provider.kind, ProviderKind::ClaudeCode);
    let (_, _, _, status, ..) = lead.rotated().remove(1);
    assert!(matches!(status, HandoffStatus::Missing { why } if why.contains("no conversation")));
}

#[tokio::test]
async fn a_rotation_cut_off_by_a_restart_finishes_without_a_handoff() {
    let lead = Lead::new().await;
    lead.turn("plan", 10, 1_000_000).await;
    lead.fixture
        .orchestrator
        .emit(
            lead.thread.id,
            None,
            EventPayload::ContextRotationStarted { rotation_id: "r1".into(), reason: RotationReason::Budget, used_tokens: 1, window_tokens: None },
        )
        .unwrap();
    lead.fixture.orchestrator.inner.sessions.lock().await.clear();
    lead.fixture.orchestrator.recover_after_restart().await.unwrap();
    let (id, _, _, status, ..) = lead.rotated().remove(0);
    assert_eq!(id, "r1");
    assert!(matches!(status, HandoffStatus::Missing { why } if why.contains("restarted")));
    assert!(lead.seed().is_some());
    let rows = kybern_store::project_transcript(&lead.events());
    assert!(rows.iter().any(|row| matches!(row, TranscriptEntry::Rotation { pending: false, .. })));
}
