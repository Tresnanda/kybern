// Claude Code session lifecycle: live target changes, background subagents across a retirement, decline
// feedback, and a conversation Claude Code no longer has. Included into `orchestrator::tests`.

/// How a scripted Claude session answers its first message.
#[derive(Clone, Copy, PartialEq)]
enum ScriptedAnswer {
    /// Bind a fresh session and complete the turn.
    Answer,
    /// Fail the turn with Claude Code's "no conversation" result, then exit.
    MissingConversationResult,
    /// Exit with Claude Code's "no conversation" stderr, without a result.
    MissingConversationExit,
    /// Exit with the phrase in its stderr tail, naming a session that is not the thread's.
    MissingOtherConversationExit,
    /// Bind `fresh-session`, then answer that Claude Code has no conversation for it either.
    BindThenMissing,
    /// Bind `fresh-session` and keep working until interrupted. As in Claude Code, an interrupt that comes
    /// before the message is lost.
    Hang,
}

/// How a scripted Claude session takes live model and effort changes.
#[derive(Clone, Copy, PartialEq, Default)]
enum TargetScript {
    #[default]
    Accept,
    /// Every change is refused, as an older Claude Code would.
    RejectAll,
    /// The model changes; the effort does not.
    RejectEffort,
    /// The first model change works; effort and any later model change are refused.
    RejectEffortAndModelBack,
    /// The process exits when asked to change effort.
    ExitOnEffort,
}

/// One session the scripted driver started.
struct ScriptedLaunch {
    config: kybern_drivers::SessionConfig,
    messages: Arc<Mutex<Vec<UserMessage>>>,
    closes: Arc<AtomicUsize>,
    interrupts: Arc<AtomicUsize>,
    target_changes: Arc<std::sync::Mutex<Vec<String>>>,
}

/// A Claude driver whose sessions resume conversations Claude Code no longer has when `missing` is set.
#[derive(Default)]
struct ScriptedClaude {
    launches: Arc<std::sync::Mutex<Vec<ScriptedLaunch>>>,
    /// How a session that resumes answers; `None`: as a fresh one.
    missing: Option<ScriptedAnswer>,
    /// How a fresh session (no `--resume`) answers; `None`: [`ScriptedAnswer::Answer`].
    fresh: Option<ScriptedAnswer>,
    target: TargetScript,
    /// Closing a session that resumed waits for this, holding the gap between two sessions open.
    hold_close: Option<Arc<tokio::sync::Semaphore>>,
    /// Closing a session that resumed panics.
    panic_close: bool,
    /// A fresh session takes its message only once this has a permit.
    hold_send: Option<Arc<tokio::sync::Semaphore>>,
}

struct ScriptedClaudeSession {
    inner: TestSession,
    events: tokio::sync::mpsc::Sender<DriverEvent>,
    answer: ScriptedAnswer,
    target: TargetScript,
    model_changes: AtomicUsize,
    hold_close: Option<Arc<tokio::sync::Semaphore>>,
    panic_close: bool,
    hold_send: Option<Arc<tokio::sync::Semaphore>>,
    interrupts: Arc<AtomicUsize>,
    /// The message arrived, so an interrupt ends the turn ([`ScriptedAnswer::Hang`]).
    working: AtomicBool,
}

const GONE: &str = "No conversation found with session ID: provider-session";

#[async_trait::async_trait]
impl AgentSession for ScriptedClaudeSession {
    async fn send_message(&self, message_id: &str, message: &UserMessage) -> kybern_drivers::Result<()> {
        if let Some(hold) = &self.hold_send {
            let _ = hold.acquire().await;
        }
        self.inner.send_message(message_id, message).await?;
        self.working.store(true, Ordering::SeqCst);
        let (events, answer) = (self.events.clone(), self.answer);
        tokio::spawn(async move {
            let exit = |error: &str| DriverEvent::Exited { code: Some(1), error: Some(error.into()) };
            let script = match answer {
                ScriptedAnswer::Answer => vec![
                    DriverEvent::SessionBound { session_id: "fresh-session".into(), model: None },
                    DriverEvent::MessageCompleted {
                        message_id: "reply".into(),
                        origin: EventOrigin::Root,
                        text: "Answered on a fresh session".into(),
                        thinking: None,
                    },
                    DriverEvent::TurnCompleted {
                        stop_reason: StopReason::Completed,
                        usage: Usage::default(),
                        cost_usd: None,
                        duration_ms: 1,
                        anchors: TurnAnchors::default(),
                    },
                ],
                ScriptedAnswer::MissingConversationResult => {
                    vec![DriverEvent::TurnFailed { error: GONE.into(), problem: None }, exit(GONE)]
                }
                ScriptedAnswer::MissingConversationExit => vec![exit(GONE)],
                ScriptedAnswer::MissingOtherConversationExit => {
                    vec![exit("a reviewer subagent wrote:\nNo conversation found with session ID: some-other-session")]
                }
                ScriptedAnswer::BindThenMissing => {
                    let gone = "No conversation found with session ID: fresh-session";
                    vec![
                        DriverEvent::SessionBound { session_id: "fresh-session".into(), model: None },
                        DriverEvent::TurnFailed { error: gone.into(), problem: None },
                        exit(gone),
                    ]
                }
                ScriptedAnswer::Hang => vec![DriverEvent::SessionBound { session_id: "fresh-session".into(), model: None }],
            };
            for event in script {
                let _ = events.send(event).await;
            }
        });
        Ok(())
    }
    async fn interrupt(&self) -> kybern_drivers::Result<()> {
        self.interrupts.fetch_add(1, Ordering::SeqCst);
        if self.answer == ScriptedAnswer::Hang && self.working.swap(false, Ordering::SeqCst) {
            let _ = self
                .events
                .send(DriverEvent::TurnCompleted {
                    stop_reason: StopReason::Interrupted,
                    usage: Usage::default(),
                    cost_usd: None,
                    duration_ms: 1,
                    anchors: TurnAnchors::default(),
                })
                .await;
        }
        self.inner.interrupt().await
    }
    async fn set_permission_mode(&self, mode: PermissionMode) -> kybern_drivers::Result<()> {
        self.inner.set_permission_mode(mode).await
    }
    async fn set_model(&self, model: &str) -> kybern_drivers::Result<()> {
        let earlier = self.model_changes.fetch_add(1, Ordering::SeqCst);
        if self.target == TargetScript::RejectEffortAndModelBack && earlier > 0 {
            return Err(kybern_drivers::DriverError::ProcessExited("claude exited while waiting for a control response".into()));
        }
        self.inner.set_model(model).await
    }
    async fn set_effort(&self, effort: &str) -> kybern_drivers::Result<()> {
        if self.target == TargetScript::ExitOnEffort {
            return Err(kybern_drivers::DriverError::ProcessExited("claude exited while waiting for a control response".into()));
        }
        if matches!(self.target, TargetScript::RejectEffort | TargetScript::RejectEffortAndModelBack) {
            return Err(kybern_drivers::DriverError::Unsupported("Claude Code kept effort high".into()));
        }
        self.inner.set_effort(effort).await
    }
    async fn respond_permission(&self, request_id: &str, decision: &ApprovalDecision) -> kybern_drivers::Result<()> {
        self.inner.respond_permission(request_id, decision).await
    }
    async fn close(&self) -> kybern_drivers::Result<()> {
        if let Some(hold) = &self.hold_close {
            let _ = hold.acquire().await;
        }
        assert!(!self.panic_close, "the scripted session panics while closing");
        self.inner.close().await
    }
}

#[async_trait::async_trait]
impl kybern_drivers::AgentDriver for ScriptedClaude {
    fn kind(&self) -> ProviderKind {
        ProviderKind::ClaudeCode
    }

    async fn probe(&self, _binary: Option<&PathBuf>) -> ProviderStatus {
        ProviderStatus {
            kind: ProviderKind::ClaudeCode,
            display_name: "Claude Code".into(),
            available: true,
            binary_path: None,
            version: None,
            unavailable_reason: None,
            supported_permission_modes: PermissionMode::ALL.to_vec(),
            supports_fork: true,
            supports_model_switch: true,
            supports_effort_switch: true,
            supported_efforts: vec![],
            models: vec![],
            instances: vec![],
        }
    }

    async fn spawn(&self, config: kybern_drivers::SessionConfig) -> kybern_drivers::Result<kybern_drivers::SpawnedSession> {
        let (tx, events) = tokio::sync::mpsc::channel(16);
        let inner = TestSession { reject_target: self.target == TargetScript::RejectAll, ..Default::default() };
        let resumes = config.resume_session_id.is_some();
        let answer = match (resumes, self.missing) {
            (true, Some(missing)) => missing,
            _ => self.fresh.unwrap_or(ScriptedAnswer::Answer),
        };
        let hold_close = self.hold_close.clone().filter(|_| resumes);
        let hold_send = self.hold_send.clone().filter(|_| !resumes);
        let interrupts = Arc::new(AtomicUsize::new(0));
        self.launches.lock().unwrap().push(ScriptedLaunch {
            config,
            messages: inner.messages.clone(),
            closes: inner.closes.clone(),
            interrupts: interrupts.clone(),
            target_changes: inner.target_changes.clone(),
        });
        let session = ScriptedClaudeSession {
            inner,
            events: tx,
            answer,
            target: self.target,
            model_changes: AtomicUsize::new(0),
            hold_close,
            panic_close: self.panic_close && resumes,
            hold_send,
            interrupts,
            working: AtomicBool::new(false),
        };
        Ok(kybern_drivers::SpawnedSession { session: Box::new(session), events })
    }
}

fn scripted_claude(missing: Option<ScriptedAnswer>, reject_target: bool) -> (Fixture, Arc<std::sync::Mutex<Vec<ScriptedLaunch>>>) {
    let target = if reject_target { TargetScript::RejectAll } else { TargetScript::Accept };
    scripted_claude_with(ScriptedClaude { missing, target, ..Default::default() })
}

fn scripted_claude_with(driver: ScriptedClaude) -> (Fixture, Arc<std::sync::Mutex<Vec<ScriptedLaunch>>>) {
    let launches = driver.launches.clone();
    let mut drivers = DriverRegistry::default();
    drivers.register(Arc::new(driver));
    (Fixture::with_drivers(drivers), launches)
}

/// A running background subagent, launched by `toolu_launch`.
fn background_agent(thread: &Thread) -> RuntimeTask {
    RuntimeTask {
        id: "background-reviewer".into(),
        thread_id: thread.id,
        origin_turn_id: Uuid::now_v7(),
        started_seq: 0,
        updated_seq: 0,
        kind: RuntimeTaskKind::Agent,
        status: RuntimeTaskStatus::Running,
        title: "Review the diff".into(),
        detail: None,
        provider_type: Some("general-purpose".into()),
        parent_id: None,
        tool_call_id: Some("toolu_launch".into()),
        provider_thread_id: None,
        model: None,
        effort: None,
        backgrounded: true,
        last_tool_name: None,
        usage: None,
        stats: RuntimeTaskStats::default(),
        capabilities: RuntimeTaskCapabilities { stop: true, background: false },
        started_at: chrono::Utc::now(),
        updated_at: chrono::Utc::now(),
        completed_at: None,
    }
}

fn notices(fixture: &Fixture, thread: &Thread) -> Vec<String> {
    fixture
        .store
        .events_for_thread(thread.id)
        .unwrap()
        .into_iter()
        .filter_map(|event| match event.payload {
            EventPayload::ProviderNotice { text, .. } => Some(text),
            _ => None,
        })
        .collect()
}

async fn settled(fixture: &Fixture, thread: &Thread) -> Thread {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let current = fixture.store.thread_get(thread.id).unwrap().unwrap();
        if !matches!(current.status, ThreadStatus::Running | ThreadStatus::AwaitingApproval) {
            return current;
        }
        assert!(Instant::now() < deadline, "the turn never settled");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// Wait until `ready` holds; `what` says what never happened.
async fn claude_waits_for(what: &str, mut ready: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !ready() {
        assert!(Instant::now() < deadline, "{what}");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

/// A turn of `thread` that started and runs: its id, message id and message, and the running thread.
fn running_turn(fixture: &Fixture, thread: &Thread, text: &str) -> (Thread, TurnId, MessageId, UserMessage) {
    let (turn_id, message_id, message) = (Uuid::now_v7(), Uuid::now_v7(), UserMessage::text(text));
    fixture.orchestrator.emit(thread.id, Some(turn_id), EventPayload::TurnStarted { message_id, message: message.clone() }).unwrap();
    let mut running = fixture.store.thread_get(thread.id).unwrap().unwrap();
    running.status = ThreadStatus::Running;
    fixture.store.thread_upsert(&running).unwrap();
    (running, turn_id, message_id, message)
}

/// The turns of `thread` that ended as interrupted, in order.
fn interrupted_turns(fixture: &Fixture, thread: &Thread) -> Vec<Option<TurnId>> {
    fixture
        .store
        .events_for_thread(thread.id)
        .unwrap()
        .into_iter()
        .filter(|event| matches!(event.payload, EventPayload::TurnCompleted { stop_reason: StopReason::Interrupted, .. }))
        .map(|event| event.turn_id)
        .collect()
}

fn failures(fixture: &Fixture, thread: &Thread) -> usize {
    fixture.store.events_for_thread(thread.id).unwrap().iter().filter(|event| matches!(event.payload, EventPayload::TurnFailed { .. })).count()
}

/// Whether `thread` has no live session in the foreground (`false` while the map is busy).
fn no_live_session(fixture: &Fixture, thread: &Thread) -> bool {
    fixture.orchestrator.inner.sessions.try_lock().is_ok_and(|sessions| !sessions.contains_key(&thread.id))
}

/// Send a message whose resumed session finds its conversation gone, and wait until the turn is between the
/// two sessions (the old one let go of it).
async fn send_into_resend(fixture: &Fixture, thread: &Thread) {
    fixture.orchestrator.send(thread.id, UserMessage::text("Next question")).await.unwrap();
    claude_waits_for("the turn never moved to a new session", || {
        fixture.orchestrator.inner.resends.get(thread.id).is_some() && no_live_session(fixture, thread)
    })
    .await;
}

/// Changing model or effort keeps the Claude process (and what runs in its background) and changes them in
/// place; nothing else restarts it, and a later message with the same target leaves it alone.
#[tokio::test]
async fn a_model_or_effort_change_applies_to_the_live_claude_session() {
    let (fixture, launches) = scripted_claude(None, false);
    let mut thread = fixture.thread(ThreadStatus::Idle);
    thread.effort = Some("high".into());
    fixture.store.thread_upsert(&thread).unwrap();
    let (live, reused) = fixture.orchestrator.ensure_session(&thread).await.unwrap();
    assert!(!reused);

    thread.model = Some("sonnet".into());
    thread.effort = Some("low".into());
    let (switched, reused) = fixture.orchestrator.ensure_session(&thread).await.unwrap();
    assert!(reused && Arc::ptr_eq(&live, &switched), "the same process carries on");
    assert_eq!(launches.lock().unwrap().len(), 1, "no restart");
    assert_eq!(*launches.lock().unwrap()[0].target_changes.lock().unwrap(), ["model:sonnet", "effort:low"]);

    // The new target is the session's own now.
    let (again, reused) = fixture.orchestrator.ensure_session(&thread).await.unwrap();
    assert!(reused && Arc::ptr_eq(&live, &again));
    assert_eq!(launches.lock().unwrap()[0].target_changes.lock().unwrap().len(), 2);

    // Back to the Agent default model works live; back to Claude Code's default effort needs a new process.
    thread.model = None;
    let (_, reused) = fixture.orchestrator.ensure_session(&thread).await.unwrap();
    assert!(reused);
    assert_eq!(launches.lock().unwrap()[0].target_changes.lock().unwrap().last().map(String::as_str), Some("model:default"));
    thread.effort = None;
    let (restarted, reused) = fixture.orchestrator.ensure_session(&thread).await.unwrap();
    assert!(!reused && !Arc::ptr_eq(&live, &restarted));
    assert_eq!(launches.lock().unwrap().len(), 2);
}

/// A Claude Code that refuses the change keeps today's path: the session restarts on the new target.
#[tokio::test]
async fn a_refused_live_change_restarts_the_session() {
    let (fixture, launches) = scripted_claude(None, true);
    let mut thread = fixture.thread(ThreadStatus::Idle);
    let (live, _) = fixture.orchestrator.ensure_session(&thread).await.unwrap();
    thread.model = Some("not-a-model".into());
    let (restarted, reused) = fixture.orchestrator.ensure_session(&thread).await.unwrap();
    assert!(!reused && !Arc::ptr_eq(&live, &restarted));
    let launches = launches.lock().unwrap();
    assert_eq!(launches.len(), 2);
    assert_eq!(launches[0].closes.load(Ordering::SeqCst), 1, "the refused process is closed");
    assert_eq!(launches[1].config.model.as_deref(), Some("not-a-model"));
}

/// A permission mode Claude Code took live is the session's own: the next message keeps the process.
#[tokio::test]
async fn a_permission_mode_applied_live_does_not_restart_claude_on_the_next_message() {
    let (fixture, launches) = scripted_claude(None, false);
    let thread = fixture.thread(ThreadStatus::Idle);
    let (live, _) = fixture.orchestrator.ensure_session(&thread).await.unwrap();
    let updated = fixture.orchestrator.update_session_fields(set_mode(&thread, PermissionMode::AcceptEdits)).await.unwrap();
    assert_eq!(updated.permission_mode, PermissionMode::AcceptEdits);
    let (again, reused) = fixture.orchestrator.ensure_session(&updated).await.unwrap();
    assert!(reused && Arc::ptr_eq(&live, &again));
    assert_eq!(launches.lock().unwrap().len(), 1);
}

/// A session retired for another account or permissions keeps running while a background subagent works.
#[tokio::test]
async fn a_retired_session_keeps_running_for_its_background_subagent() {
    let (fixture, launches) = scripted_claude(None, false);
    let mut thread = fixture.thread(ThreadStatus::Idle);
    let (live, _) = fixture.orchestrator.ensure_session(&thread).await.unwrap();
    let task = background_agent(&thread);
    live.tasks.lock().await.insert(task.id.clone(), task.clone());
    // Full access is a launch flag for Claude Code, so it needs a new process.
    thread.permission_mode = PermissionMode::FullAccess;
    let (receiving, reused) = fixture.orchestrator.ensure_session(&thread).await.unwrap();
    assert!(!reused && !Arc::ptr_eq(&live, &receiving));
    assert_eq!(launches.lock().unwrap()[0].closes.load(Ordering::SeqCst), 0, "the subagent's process keeps running");
    assert!(live.retained.load(Ordering::Relaxed));
    assert!(Arc::ptr_eq(&fixture.orchestrator.task_session(thread.id, &task.id).await.unwrap(), &live));
}

/// The reason a person gives for declining reaches Claude marked as their reply; other harnesses get it as
/// it is, a declined form is declined without one (with a reason, Claude Code would read it as Kybern
/// cancelling the form), and the record keeps the person's words.
#[tokio::test]
async fn decline_feedback_reaches_claude_as_the_users_reply() {
    for (provider, tool, expected) in [
        (ProviderKind::ClaudeCode, "Bash", Some("The user declined this tool call and said:\nuse rg instead")),
        (ProviderKind::ClaudeCode, "mcp_elicitation", None),
        (ProviderKind::Codex, "shell", Some("use rg instead")),
    ] {
        let fixture = Fixture::new();
        let thread = fixture.thread_with_provider(ThreadStatus::Idle, provider);
        let session = TestSession::default();
        let responses = session.permission_responses.clone();
        let live = fixture.active_session(&thread, session).await;
        let request = DriverEvent::PermissionRequest {
            request_id: "p1".into(),
            tool_call_id: Some("call-p1".into()),
            tool_name: tool.into(),
            input: json!({"command": "grep -r foo ."}),
            summary: "run grep".into(),
            suggestions: vec![],
        };
        fixture.orchestrator.handle_driver_event(thread.id, &live, request).await.unwrap();
        let approval = fixture.store.approvals_pending(Some(thread.id)).unwrap().remove(0);
        let decision = ApprovalDecision::Deny { reason: Some("use rg instead".into()) };
        fixture.orchestrator.respond_approval(approval.id, decision.clone()).await.unwrap();
        assert_eq!(*responses.lock().await, [ApprovalDecision::Deny { reason: expected.map(str::to_string) }], "{provider} {tool}");
        let recorded = fixture.store.events_for_thread(thread.id).unwrap().into_iter().find_map(|event| match event.payload {
            EventPayload::ApprovalResolved { decision, .. } => Some(decision),
            _ => None,
        });
        assert_eq!(recorded, Some(decision));
    }
}

/// Claude Code deleted the conversation a thread resumes. The turn is sent once more to a fresh session that
/// gets the conversation so far, the thread moves to that session, and the user sends nothing again: both
/// when Claude Code answers with a failed result and when it only exits.
#[tokio::test]
async fn a_conversation_claude_lost_continues_on_a_fresh_session() {
    for missing in [ScriptedAnswer::MissingConversationResult, ScriptedAnswer::MissingConversationExit] {
        let (fixture, launches) = scripted_claude(Some(missing), false);
        let thread = fixture.thread(ThreadStatus::Idle);
        fixture
            .orchestrator
            .emit(
                thread.id,
                Some(Uuid::now_v7()),
                EventPayload::TurnStarted { message_id: Uuid::now_v7(), message: UserMessage::text("Earlier question about the parser") },
            )
            .unwrap();
        fixture.orchestrator.send(thread.id, UserMessage::text("Next question")).await.unwrap();
        let after = settled(&fixture, &thread).await;

        assert_eq!(after.status, ThreadStatus::Idle, "the turn completes instead of failing");
        assert_eq!(after.provider_session_id.as_deref(), Some("fresh-session"));
        let launches = launches.lock().unwrap();
        assert_eq!(launches.len(), 2);
        assert_eq!(launches[0].config.resume_session_id.as_deref(), Some("provider-session"));
        assert_eq!(launches[1].config.resume_session_id, None, "the dead id is not resumed again");
        let sent = launches[1].messages.try_lock().unwrap()[0].plain_text();
        assert!(sent.contains("Earlier question about the parser"), "the fresh session gets the conversation so far: {sent}");
        assert_eq!(sent.matches("Next question").count(), 1, "the message itself is sent once: {sent}");
        let events = fixture.store.events_for_thread(thread.id).unwrap();
        assert!(events.iter().any(|event| matches!(event.payload, EventPayload::SessionTransitioned { native_resume: false, .. })));
        assert!(!events.iter().any(|event| matches!(event.payload, EventPayload::TurnFailed { .. })));
        assert!(
            !events.iter().any(|event| matches!(&event.payload, EventPayload::ProviderNotice { text, .. } if text.contains("No conversation"))),
            "the dead session's exit is no error row"
        );
    }
}

/// Retire the scripted session for Full access (a launch flag) while `task` runs in its background.
async fn retire_with_background(fixture: &Fixture, thread: &mut Thread, task: &RuntimeTask) -> Arc<LiveSession> {
    let (live, _) = fixture.orchestrator.ensure_session(thread).await.unwrap();
    live.tasks.lock().await.insert(task.id.clone(), task.clone());
    fixture.orchestrator.subagent_sync(thread.id, task, Some(live.session_instance_id)).unwrap();
    thread.permission_mode = PermissionMode::FullAccess;
    let (receiving, _) = fixture.orchestrator.ensure_session(thread).await.unwrap();
    assert!(!Arc::ptr_eq(&live, &receiving) && live.retained.load(Ordering::Relaxed));
    live
}

/// Claude Code took the model but refused the effort: the process gets its own model back before it is kept
/// for its background agent, so returning to the old target reuses a process that really runs it.
#[tokio::test]
async fn a_refused_effort_switches_the_model_back_before_the_process_is_kept() {
    let (fixture, launches) = scripted_claude_with(ScriptedClaude { target: TargetScript::RejectEffort, ..Default::default() });
    let mut thread = fixture.thread(ThreadStatus::Idle);
    thread.effort = Some("high".into());
    fixture.store.thread_upsert(&thread).unwrap();
    let original = thread.clone();
    let (live, _) = fixture.orchestrator.ensure_session(&thread).await.unwrap();
    let task = background_agent(&thread);
    live.tasks.lock().await.insert(task.id.clone(), task);

    thread.model = Some("sonnet".into());
    thread.effort = Some("low".into());
    let (receiving, reused) = fixture.orchestrator.ensure_session(&thread).await.unwrap();
    assert!(!reused && !Arc::ptr_eq(&live, &receiving), "the refused change restarts");
    assert_eq!(*launches.lock().unwrap()[0].target_changes.lock().unwrap(), ["model:sonnet", "model:default"]);
    assert!(live.retained.load(Ordering::Relaxed), "kept for its subagent");

    let (back, reused) = fixture.orchestrator.ensure_session(&original).await.unwrap();
    assert!(reused && Arc::ptr_eq(&live, &back), "the old target reuses the kept process");
    assert_eq!(launches.lock().unwrap().len(), 2);
}

/// When the model can't be switched back either, nothing knows what the process runs: it is closed, its
/// background work with it, instead of kept under an identity it no longer has.
#[tokio::test]
async fn a_process_that_cant_switch_back_is_closed_not_kept() {
    let (fixture, launches) =
        scripted_claude_with(ScriptedClaude { target: TargetScript::RejectEffortAndModelBack, ..Default::default() });
    let mut thread = fixture.thread(ThreadStatus::Idle);
    thread.effort = Some("high".into());
    fixture.store.thread_upsert(&thread).unwrap();
    let (live, _) = fixture.orchestrator.ensure_session(&thread).await.unwrap();
    let task = background_agent(&thread);
    live.tasks.lock().await.insert(task.id.clone(), task.clone());

    thread.model = Some("sonnet".into());
    thread.effort = Some("low".into());
    let (receiving, reused) = fixture.orchestrator.ensure_session(&thread).await.unwrap();
    assert!(!reused && !Arc::ptr_eq(&live, &receiving));
    assert_eq!(launches.lock().unwrap()[0].closes.load(Ordering::SeqCst), 1, "the process on an unknown model is closed");
    assert!(fixture.orchestrator.inner.retained_sessions.lock().await.is_empty(), "and not kept");
    assert_eq!(live.tasks.lock().await[&task.id].status, RuntimeTaskStatus::Interrupted);
}

/// A send records the new model on the thread before the process switches to it. A permission change in
/// between must not make the old process look like it already runs that model.
#[tokio::test]
async fn a_permission_change_before_the_switch_keeps_the_identity_of_what_runs() {
    let (fixture, launches) = scripted_claude(None, false);
    let thread = fixture.thread(ThreadStatus::Idle);
    let (live, _) = fixture.orchestrator.ensure_session(&thread).await.unwrap();
    let mut sent = thread.clone();
    sent.model = Some("sonnet".into());
    fixture.store.thread_upsert(&sent).unwrap();

    let updated = fixture.orchestrator.update_session_fields(set_mode(&sent, PermissionMode::AcceptEdits)).await.unwrap();
    assert_eq!(updated.model.as_deref(), Some("sonnet"));
    let (again, reused) = fixture.orchestrator.ensure_session(&updated).await.unwrap();
    assert!(reused && Arc::ptr_eq(&live, &again));
    assert_eq!(*launches.lock().unwrap()[0].target_changes.lock().unwrap(), ["model:sonnet"], "the process is switched");
}

/// A background agent that finishes in a retired session reports to that session only; the thread shows
/// its result, so the person sees what the agent in the new session never got.
#[tokio::test]
async fn a_retained_agents_result_is_shown_in_the_thread() {
    let (fixture, launches) = scripted_claude(None, false);
    let mut thread = fixture.thread(ThreadStatus::Idle);
    let task = background_agent(&thread);
    let live = retire_with_background(&fixture, &mut thread, &task).await;

    let said = |text: &str| DriverEvent::MessageCompleted {
        message_id: "agent-reply".into(),
        origin: EventOrigin::Agent { task_id: task.id.clone(), provider_thread_id: None },
        text: text.into(),
        thinking: None,
    };
    fixture.orchestrator.handle_driver_event(thread.id, &live, said("Found two bugs in parser.rs: an off-by-one and a leak.")).await.unwrap();
    let completed = DriverEvent::RuntimeTaskCompleted(DriverRuntimeTaskUpdate {
        id: task.id.clone(),
        status: Some(RuntimeTaskStatus::Completed),
        detail: None,
        backgrounded: None,
        last_tool_name: None,
        usage: None,
        stats: None,
        capabilities: None,
    });
    fixture.orchestrator.handle_driver_event(thread.id, &live, completed).await.unwrap();

    let shown = notices(&fixture, &thread);
    assert!(
        shown.iter().any(|text| text.contains("“Review the diff” finished") && text.contains("Found two bugs in parser.rs")),
        "{shown:?}"
    );
    assert_eq!(launches.lock().unwrap()[0].closes.load(Ordering::SeqCst), 1, "its last work done, the process closes");
}

/// A retired session kept only for background agents that send nothing for half an hour is closed with a
/// notice; one that also runs a process (a dev server) is left for the person to stop.
#[tokio::test]
async fn retained_agents_that_go_quiet_are_stopped() {
    for kind in [RuntimeTaskKind::Agent, RuntimeTaskKind::Process] {
        let (fixture, launches) = scripted_claude(None, false);
        let mut thread = fixture.thread(ThreadStatus::Idle);
        let task = RuntimeTask { kind, ..background_agent(&thread) };
        let live = retire_with_background(&fixture, &mut thread, &task).await;

        fixture.orchestrator.close_quiet_retained_sessions(Instant::now()).await;
        assert_eq!(launches.lock().unwrap()[0].closes.load(Ordering::SeqCst), 0, "{kind:?}: not quiet yet");

        let later = super::claude_sessions::RETAINED_QUIET_LIMIT + Duration::from_secs(1);
        fixture.orchestrator.close_quiet_retained_sessions(Instant::now() + later).await;
        let shown = notices(&fixture, &thread);
        if kind == RuntimeTaskKind::Agent {
            let closes = launches.lock().unwrap()[0].closes.clone();
            claude_waits_for("the quiet agent's process is closed", || closes.load(Ordering::SeqCst) == 1).await;
            assert!(fixture.orchestrator.inner.retained_sessions.lock().await.is_empty());
            assert_eq!(live.tasks.lock().await[&task.id].status, RuntimeTaskStatus::Interrupted);
            assert!(shown.iter().any(|text| text.contains("sent nothing for 30 minutes")), "{shown:?}");
        } else {
            assert_eq!(launches.lock().unwrap()[0].closes.load(Ordering::SeqCst), 0, "a background process is the person's to stop");
            assert!(shown.is_empty(), "{shown:?}");
        }
    }
}

/// Stop while a turn moves from a session whose conversation is gone to a fresh one: there is no live
/// session to interrupt, so Stop is recorded and the turn ends instead of being sent.
#[tokio::test]
async fn stop_while_the_turn_moves_to_a_fresh_session_ends_it() {
    let hold = Arc::new(tokio::sync::Semaphore::new(0));
    let (fixture, launches) = scripted_claude_with(ScriptedClaude {
        missing: Some(ScriptedAnswer::MissingConversationResult),
        hold_close: Some(hold.clone()),
        ..Default::default()
    });
    let thread = fixture.thread(ThreadStatus::Idle);
    send_into_resend(&fixture, &thread).await;

    fixture.orchestrator.stop_thread(thread.id, "test").await.expect("Stop works between two sessions");
    // Stop ends the turn itself; it does not wait for the old session to close.
    assert_eq!(fixture.store.thread_get(thread.id).unwrap().unwrap().status, ThreadStatus::Idle);
    hold.add_permits(16);
    let closes = launches.lock().unwrap()[0].closes.clone();
    claude_waits_for("the old session closes", || closes.load(Ordering::SeqCst) == 1).await;
    assert_eq!(launches.lock().unwrap().len(), 1, "nothing is sent after Stop");
    assert!(fixture.orchestrator.inner.resends.is_empty());
    let events = fixture.store.events_for_thread(thread.id).unwrap();
    assert!(events.iter().any(|event| matches!(event.payload, EventPayload::TurnCompleted { stop_reason: StopReason::Interrupted, .. })));
    assert!(!events.iter().any(|event| matches!(event.payload, EventPayload::TurnFailed { .. })));
}

/// A fresh session that also finds no conversation fails the turn: the message is sent once more, not again.
#[tokio::test]
async fn a_fresh_session_that_also_fails_does_not_loop() {
    let (fixture, launches) = scripted_claude_with(ScriptedClaude {
        missing: Some(ScriptedAnswer::MissingConversationResult),
        fresh: Some(ScriptedAnswer::BindThenMissing),
        ..Default::default()
    });
    let thread = fixture.thread(ThreadStatus::Idle);
    fixture.orchestrator.send(thread.id, UserMessage::text("Next question")).await.unwrap();
    let after = settled(&fixture, &thread).await;
    assert_eq!(after.status, ThreadStatus::Failed);
    // A loop would have registered another resend before the turn could fail, and started a third session
    // from it: the fresh session's exit is handled once its pump lets go of it.
    claude_waits_for("the fresh session's exit is handled", || no_live_session(&fixture, &thread)).await;
    assert!(fixture.orchestrator.inner.resends.is_empty(), "no resend waits");
    assert_eq!(launches.lock().unwrap().len(), 2, "one fresh session, no more");
    assert_eq!(failures(&fixture, &thread), 1);
}

/// The phrase in an exit's stderr tail naming another session (a subagent's words, a tool's output) is
/// not this thread's conversation going missing: the turn fails as it is and the session id stays.
#[tokio::test]
async fn an_exit_naming_another_session_keeps_the_conversation() {
    let (fixture, launches) = scripted_claude(Some(ScriptedAnswer::MissingOtherConversationExit), false);
    let thread = fixture.thread(ThreadStatus::Idle);
    fixture.orchestrator.send(thread.id, UserMessage::text("Next question")).await.unwrap();
    let after = settled(&fixture, &thread).await;
    assert_eq!(after.status, ThreadStatus::Failed);
    assert_eq!(after.provider_session_id.as_deref(), Some("provider-session"), "the conversation is not forgotten");
    assert_eq!(launches.lock().unwrap().len(), 1, "and the turn is not sent again");
}

/// Stop after the new session is registered but before the resent turn holds it (`ensure_session` inserts the
/// session first): the live session has no turn to interrupt, so Stop ends the turn through the resend, and
/// the turn's start sends nothing.
#[tokio::test]
async fn stop_while_the_resent_turn_starts_sends_nothing() {
    let (fixture, launches) = scripted_claude(None, false);
    let thread = fixture.thread(ThreadStatus::Idle);
    let (running, turn_id, message_id, message) = running_turn(&fixture, &thread, "Next question");
    let guard = fixture.orchestrator.begin_resend(thread.id, turn_id, super::resend::ResendReason::MissingConversation);
    let (live, _) = fixture.orchestrator.ensure_session(&running).await.unwrap();
    assert!(live.turn.lock().await.is_none(), "registered, without the turn yet");

    fixture.orchestrator.stop_thread(thread.id, "test").await.expect("Stop ends the turn");
    assert_eq!(fixture.store.thread_get(thread.id).unwrap().unwrap().status, ThreadStatus::Idle);
    fixture.orchestrator.start_resent_turn(&guard, running, message_id, message).await.unwrap();
    drop(guard);

    assert!(launches.lock().unwrap()[0].messages.try_lock().unwrap().is_empty(), "the message is not sent after Stop");
    assert!(live.turn.lock().await.is_none());
    assert_eq!(interrupted_turns(&fixture, &thread), [Some(turn_id)]);
    assert_eq!(failures(&fixture, &thread), 0);
    assert_eq!(fixture.store.thread_get(thread.id).unwrap().unwrap().status, ThreadStatus::Idle);
}

/// Stop waits for `live.turn` while the failed turn registers its resend under it: once Stop has the lock
/// there is no turn left in the session, and Stop ends the turn through the resend instead of finding nothing.
#[tokio::test]
async fn stop_that_waited_for_the_failed_turn_ends_its_resend() {
    let (fixture, _launches) = scripted_claude(None, false);
    let thread = fixture.thread(ThreadStatus::Idle);
    let (running, turn_id, _, _) = running_turn(&fixture, &thread, "Next question");
    let (live, _) = fixture.orchestrator.ensure_session(&running).await.unwrap();

    // The event pump holds `live.turn` while it handles the failure.
    let pump = live.turn.lock().await;
    let mut stop = Box::pin(fixture.orchestrator.interrupt_turn(thread.id, "test"));
    assert!(futures::poll!(stop.as_mut()).is_pending(), "Stop found no resend and waits for the turn");
    let guard = fixture.orchestrator.begin_resend(thread.id, turn_id, super::resend::ResendReason::MissingConversation);
    drop(pump);

    stop.await.expect("Stop ends the turn");
    assert!(!guard.is_pending(), "the resend sends nothing");
    assert_eq!(interrupted_turns(&fixture, &thread), [Some(turn_id)]);
    assert_eq!(fixture.store.thread_get(thread.id).unwrap().unwrap().status, ThreadStatus::Idle);
}

/// Stop comes while the resent message is on its way to the new session, after the resend claimed the turn.
/// Claude Code loses an interrupt that arrives before the message, so the turn is interrupted again as soon
/// as the message is delivered: it ends as interrupted without Kybern closing the process after the grace.
#[tokio::test]
async fn stop_while_the_resent_message_is_delivered_interrupts_it_on_arrival() {
    let hold = Arc::new(tokio::sync::Semaphore::new(0));
    let (fixture, launches) = scripted_claude_with(ScriptedClaude {
        missing: Some(ScriptedAnswer::MissingConversationResult),
        fresh: Some(ScriptedAnswer::Hang),
        hold_send: Some(hold.clone()),
        ..Default::default()
    });
    let thread = fixture.thread(ThreadStatus::Idle);
    fixture.orchestrator.send(thread.id, UserMessage::text("Next question")).await.unwrap();
    claude_waits_for("the resend never claimed the turn", || {
        fixture.orchestrator.inner.resends.get(thread.id).is_some_and(|entry| entry.outcome() == super::resend::ResendOutcome::Sent)
    })
    .await;

    let (orchestrator, thread_id) = (fixture.orchestrator.clone(), thread.id);
    let stop = tokio::spawn(async move { orchestrator.stop_thread(thread_id, "test").await });
    let interrupts = launches.lock().unwrap()[1].interrupts.clone();
    claude_waits_for("Stop never reached the new session", || interrupts.load(Ordering::SeqCst) >= 1).await;
    hold.add_permits(1);
    stop.await.unwrap().expect("Stop ends the turn");

    let after = settled(&fixture, &thread).await;
    assert_eq!(after.status, ThreadStatus::Idle);
    assert_eq!(interrupted_turns(&fixture, &thread).len(), 1);
    assert_eq!(launches.lock().unwrap()[1].closes.load(Ordering::SeqCst), 0, "not closed for failing to stop");
    assert!(!notices(&fixture, &thread).iter().any(|text| text.contains("did not finish stopping")));
    // Stop's own interrupt came before the message and was lost; the one after delivery ended the turn.
    assert_eq!(interrupts.load(Ordering::SeqCst), 2);
}

/// Stop while the resent turn, already holding its place in the new session, waits for its before snapshot;
/// the message then can't be prepared (an unreadable handoff). The turn Stop ended does not fail on top.
#[tokio::test]
async fn a_resent_turn_stop_ended_does_not_fail_afterwards() {
    let (fixture, launches) = scripted_claude(None, false);
    let thread = fixture.thread(ThreadStatus::Idle);
    let (running, turn_id, message_id, message) = running_turn(&fixture, &thread, "Next question");
    let guard = fixture.orchestrator.begin_resend(thread.id, turn_id, super::resend::ResendReason::MissingConversation);
    let (live, _) = fixture.orchestrator.ensure_session(&running).await.unwrap();
    fixture.store.meta_set(&format!("handoff:{}", thread.id), "not a range").unwrap();
    // A slow snapshot of a large tree holds the checkpoint lock.
    let lock = fixture.orchestrator.checkpoint_lock(thread.id);
    let slow = lock.clone().lock_owned().await;
    let orchestrator = fixture.orchestrator.clone();
    let start = tokio::spawn(async move {
        let started = orchestrator.start_resent_turn(&guard, running, message_id, message).await;
        (started, guard)
    });
    // The map, `lock` and `slow` hold three references; the turn's start waiting for the lock holds a fourth.
    claude_waits_for("the resent turn never reached its snapshot", || Arc::strong_count(&lock) > 3).await;

    fixture.orchestrator.stop_thread(thread.id, "test").await.expect("Stop ends the turn");
    drop(slow);
    let (started, guard) = start.await.unwrap();
    started.expect("a turn Stop ended has nothing left to fail");
    drop(guard);

    assert_eq!(interrupted_turns(&fixture, &thread), [Some(turn_id)]);
    assert_eq!(failures(&fixture, &thread), 0);
    assert_eq!(fixture.store.thread_get(thread.id).unwrap().unwrap().status, ThreadStatus::Idle);
    assert!(live.turn.lock().await.is_none(), "the ended turn gave up its place");
    assert!(launches.lock().unwrap()[0].messages.try_lock().unwrap().is_empty(), "nothing is sent after Stop");
    assert!(fixture.orchestrator.inner.resends.is_empty());
}

/// Stop just after the resent turn took its place in the new session: the turn takes no before snapshot.
#[tokio::test]
async fn a_resent_turn_stop_ended_takes_no_checkpoint() {
    let (fixture, launches) = scripted_claude(None, false);
    let git = |args: &[&str]| assert!(std::process::Command::new("git").arg("-C").arg(&fixture.root).args(args).status().unwrap().success());
    git(&["init", "-q"]);
    git(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
    let thread = fixture.thread(ThreadStatus::Idle);
    let (running, turn_id, message_id, message) = running_turn(&fixture, &thread, "Next question");
    let guard = fixture.orchestrator.begin_resend(thread.id, turn_id, super::resend::ResendReason::MissingConversation);
    let (live, _) = fixture.orchestrator.ensure_session(&running).await.unwrap();
    // The turn's start stops right after taking its place, before the snapshot.
    let held = live.last_turn_id.lock().await;
    let orchestrator = fixture.orchestrator.clone();
    let start = tokio::spawn(async move {
        let started = orchestrator.start_resent_turn(&guard, running, message_id, message).await;
        (started, guard)
    });
    claude_waits_for("the resent turn never took its place", || live.turn.try_lock().is_ok_and(|turn| turn.is_some())).await;

    fixture.orchestrator.stop_thread(thread.id, "test").await.expect("Stop ends the turn");
    drop(held);
    let (started, guard) = start.await.unwrap();
    started.unwrap();
    drop(guard);

    assert!(fixture.store.checkpoint_get(turn_id).unwrap().is_none(), "no snapshot for a stopped turn");
    assert_eq!(interrupted_turns(&fixture, &thread), [Some(turn_id)]);
    assert!(live.turn.lock().await.is_none());
    assert!(launches.lock().unwrap()[0].messages.try_lock().unwrap().is_empty());
}

/// A new turn after Stop ended a turn that waited for its new session: the old resend wakes later and leaves
/// the new turn alone, instead of ending it and setting the thread idle in its middle.
#[tokio::test]
async fn a_late_resend_leaves_the_next_turn_alone() {
    let hold = Arc::new(tokio::sync::Semaphore::new(0));
    let (fixture, launches) = scripted_claude_with(ScriptedClaude {
        missing: Some(ScriptedAnswer::MissingConversationResult),
        fresh: Some(ScriptedAnswer::Hang),
        hold_close: Some(hold.clone()),
        ..Default::default()
    });
    let thread = fixture.thread(ThreadStatus::Idle);
    send_into_resend(&fixture, &thread).await;
    fixture.orchestrator.stop_thread(thread.id, "test").await.unwrap();
    let stopped = interrupted_turns(&fixture, &thread);
    assert_eq!(stopped.len(), 1);

    fixture.orchestrator.send(thread.id, UserMessage::text("Second question")).await.unwrap();
    claude_waits_for("the next turn never reached its session", || {
        launches.lock().unwrap().get(1).is_some_and(|launch| launch.messages.try_lock().is_ok_and(|messages| messages.len() == 1))
    })
    .await;
    // The old resend wakes now.
    hold.add_permits(16);
    let closes = launches.lock().unwrap()[0].closes.clone();
    claude_waits_for("the old session closes", || closes.load(Ordering::SeqCst) == 1).await;

    assert_eq!(fixture.store.thread_get(thread.id).unwrap().unwrap().status, ThreadStatus::Running, "the next turn still runs");
    assert_eq!(interrupted_turns(&fixture, &thread), stopped, "nothing ended the next turn");
    assert_eq!(launches.lock().unwrap().len(), 2, "the stopped turn was not sent");
    assert!(launches.lock().unwrap()[1].messages.try_lock().unwrap()[0].plain_text().contains("Second question"));

    fixture.orchestrator.stop_thread(thread.id, "test").await.unwrap();
    assert_eq!(settled(&fixture, &thread).await.status, ThreadStatus::Idle);
    assert_eq!(interrupted_turns(&fixture, &thread).len(), 2);
}

/// A resend left behind (a turn that no longer runs) is no reason for Stop to say it stopped anything.
#[tokio::test]
async fn a_stale_resend_does_not_answer_stop() {
    for provider in [ProviderKind::ClaudeCode, ProviderKind::Codex] {
        let fixture = Fixture::new();
        let thread = fixture.thread_with_provider(ThreadStatus::Idle, provider);
        let (_, old_turn, _, _) = running_turn(&fixture, &thread, "First question");
        let stale = fixture.orchestrator.begin_resend(thread.id, old_turn, super::resend::ResendReason::RejectedLogin);
        // A newer turn runs now, with no live session.
        let (_, current_turn, _, _) = running_turn(&fixture, &thread, "Second question");

        let stopped = fixture.orchestrator.interrupt_turn(thread.id, "test").await;
        assert!(stopped.is_err(), "{provider}: Stop must not report a turn it did not end");
        assert!(fixture.orchestrator.inner.resends.is_empty(), "{provider}: the stale resend is dropped");
        drop(stale);
        assert!(interrupted_turns(&fixture, &thread).is_empty(), "{provider}: neither turn is ended by it");
        let after = fixture.store.thread_get(thread.id).unwrap().unwrap();
        assert_eq!(after.status, ThreadStatus::Running, "{provider}: {current_turn} still runs");
    }
}

/// The task sending a turn again panics: the guard it held ends the turn as interrupted, so the thread is not
/// left running with no session.
#[tokio::test]
async fn a_resend_that_panics_ends_its_turn() {
    let (fixture, launches) = scripted_claude_with(ScriptedClaude {
        missing: Some(ScriptedAnswer::MissingConversationResult),
        panic_close: true,
        ..Default::default()
    });
    let thread = fixture.thread(ThreadStatus::Idle);
    fixture.orchestrator.send(thread.id, UserMessage::text("Next question")).await.unwrap();
    let after = settled(&fixture, &thread).await;
    assert_eq!(after.status, ThreadStatus::Idle);
    assert_eq!(interrupted_turns(&fixture, &thread).len(), 1);
    assert_eq!(failures(&fixture, &thread), 0);
    assert_eq!(launches.lock().unwrap().len(), 1, "nothing was sent");
    assert!(fixture.orchestrator.inner.resends.is_empty());
}

/// A rejected login is renewed before the turn is sent again. Stop while it renews ends the turn: whatever
/// the renewal says afterwards, nothing is sent and nothing fails. Without Stop, a failed renewal fails it.
#[tokio::test]
async fn stop_while_a_rejected_login_renews_ends_the_turn() {
    for (stop, renewed) in [(true, Ok(())), (true, Err("Sign in to Claude Code on the lending machine again.")), (false, Err("Sign in to Claude Code on the lending machine again."))] {
        let (fixture, launches) = scripted_claude(None, false);
        let thread = fixture.thread(ThreadStatus::Idle);
        let (running, turn_id, message_id, message) = running_turn(&fixture, &thread, "Next question");
        let (live, _) = fixture.orchestrator.ensure_session(&running).await.unwrap();
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        let renewal_done = Arc::new(AtomicBool::new(false));
        let renew: super::resend::LoginRenewal = Box::pin({
            let (gate, done) = (gate.clone(), renewal_done.clone());
            async move {
                let _ = gate.acquire().await;
                done.store(true, Ordering::SeqCst);
                renewed.map_err(str::to_string)
            }
        });
        let guard = fixture.orchestrator.begin_resend(thread.id, turn_id, super::resend::ResendReason::RejectedLogin);
        let plan = super::resend::PlannedResend { guard, message_id, message, login: Some((ProviderKind::ClaudeCode, renew)) };
        fixture.orchestrator.run_resend(thread.id, &live, plan).await;
        let closes = launches.lock().unwrap()[0].closes.clone();
        claude_waits_for("the old session closes", || closes.load(Ordering::SeqCst) == 1).await;

        if stop {
            fixture.orchestrator.stop_thread(thread.id, "test").await.expect("Stop ends the turn while the login renews");
        }
        gate.add_permits(1);
        claude_waits_for("the renewal finishes", || renewal_done.load(Ordering::SeqCst)).await;
        let after = settled(&fixture, &thread).await;

        assert_eq!(launches.lock().unwrap().len(), 1, "nothing is sent: {renewed:?}");
        if stop {
            assert_eq!(after.status, ThreadStatus::Idle, "{renewed:?}");
            assert_eq!(interrupted_turns(&fixture, &thread), [Some(turn_id)]);
            assert_eq!(failures(&fixture, &thread), 0, "{renewed:?}");
        } else {
            assert_eq!(after.status, ThreadStatus::Failed);
            assert_eq!(failures(&fixture, &thread), 1);
            assert!(interrupted_turns(&fixture, &thread).is_empty());
        }
        assert!(fixture.orchestrator.inner.resends.is_empty());
    }
}

/// A retained agent that failed is reported in a plain sentence, the harness's error behind details; a long
/// result is cut, with its own thread holding the rest.
#[tokio::test]
async fn a_retained_agents_failure_and_long_result_stay_readable() {
    let fixture = Fixture::new();
    let thread = fixture.thread(ThreadStatus::Idle);
    let raw = "API Error: 529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\"}}";
    let failed = RuntimeTask { status: RuntimeTaskStatus::Failed, detail: Some(raw.into()), ..background_agent(&thread) };
    fixture.orchestrator.report_retained_agent(thread.id, &failed);
    let long = "word ".repeat(1000);
    let finished = RuntimeTask { status: RuntimeTaskStatus::Completed, detail: Some(long), ..background_agent(&thread) };
    fixture.orchestrator.report_retained_agent(thread.id, &finished);

    let shown = fixture
        .store
        .events_for_thread(thread.id)
        .unwrap()
        .into_iter()
        .filter_map(|event| match event.payload {
            EventPayload::ProviderNotice { level, text, problem, .. } => Some((level, text, problem)),
            _ => None,
        })
        .collect::<Vec<_>>();
    let (level, text, problem) = &shown[0];
    assert_eq!(*level, NoticeLevel::Warning);
    assert_eq!(text, "“Review the diff” failed in the session this thread had before. Its own thread shows how far it got.");
    assert_eq!(problem.as_ref().and_then(|problem| problem.detail.as_deref()), Some(raw), "the error is behind details");

    let (_, text, problem) = &shown[1];
    assert!(problem.is_none());
    let result = text.split_once("\n\n").unwrap().1;
    assert!(result.ends_with('…'), "{result}");
    assert!(result.chars().count() <= super::claude_sessions::RETAINED_RESULT_CHARS + 1, "{}", result.chars().count());
}

/// Quiet time is monotonic: a laptop asleep for an hour (the wall clock moved, the monotonic clock did not)
/// does not stop the retained agents on wake, and an agent's progress counts as a word from it.
#[tokio::test]
async fn retained_agents_survive_sleep_and_progress_resets_their_quiet_time() {
    let (fixture, launches) = scripted_claude(None, false);
    let mut thread = fixture.thread(ThreadStatus::Idle);
    let task = background_agent(&thread);
    let live = retire_with_background(&fixture, &mut thread, &task).await;
    live.last_activity.lock().unwrap().wall -= Duration::from_secs(60 * 60);
    fixture.orchestrator.close_quiet_retained_sessions(Instant::now()).await;
    assert!(!fixture.orchestrator.inner.retained_sessions.lock().await.is_empty(), "sleep is not quiet time");

    // Just past the limit from the last word: quiet. A progress report after it resets the clock.
    let quiet_since = live.last_activity().monotonic;
    let past_limit = quiet_since + super::claude_sessions::RETAINED_QUIET_LIMIT + Duration::from_millis(1);
    claude_waits_for("the clock never moved", || Instant::now() > quiet_since + Duration::from_millis(2)).await;
    let progress = DriverEvent::RuntimeTaskUpdated(DriverRuntimeTaskUpdate {
        id: task.id.clone(),
        status: Some(RuntimeTaskStatus::Running),
        detail: None,
        backgrounded: None,
        last_tool_name: Some("Read".into()),
        usage: None,
        stats: None,
        capabilities: None,
    });
    fixture.orchestrator.handle_driver_event(thread.id, &live, progress).await.unwrap();
    fixture.orchestrator.close_quiet_retained_sessions(past_limit).await;
    assert!(!fixture.orchestrator.inner.retained_sessions.lock().await.is_empty(), "progress is a word from the agent");
    assert_eq!(launches.lock().unwrap()[0].closes.load(Ordering::SeqCst), 0);
}

/// Claude Code that exits while taking an effort change is not kept for its background work: there is no
/// process left to keep.
#[tokio::test]
async fn a_process_that_exits_during_an_effort_change_is_closed() {
    let (fixture, launches) = scripted_claude_with(ScriptedClaude { target: TargetScript::ExitOnEffort, ..Default::default() });
    let mut thread = fixture.thread(ThreadStatus::Idle);
    thread.effort = Some("high".into());
    fixture.store.thread_upsert(&thread).unwrap();
    let (live, _) = fixture.orchestrator.ensure_session(&thread).await.unwrap();
    let task = background_agent(&thread);
    live.tasks.lock().await.insert(task.id.clone(), task.clone());

    thread.effort = Some("low".into());
    let (receiving, reused) = fixture.orchestrator.ensure_session(&thread).await.unwrap();
    assert!(!reused && !Arc::ptr_eq(&live, &receiving));
    assert_eq!(launches.lock().unwrap()[0].closes.load(Ordering::SeqCst), 1, "the exited process is closed");
    assert!(fixture.orchestrator.inner.retained_sessions.lock().await.is_empty(), "and not kept");
    assert_eq!(live.tasks.lock().await[&task.id].status, RuntimeTaskStatus::Interrupted);
}

/// The markers earlier builds kept in `meta` are removed on startup.
#[tokio::test]
async fn retired_resend_markers_are_removed_on_startup() {
    let fixture = Fixture::new();
    let thread = fixture.thread(ThreadStatus::Idle);
    fixture.store.meta_set(&format!("resend:{}", thread.id), &Uuid::now_v7().to_string()).unwrap();
    fixture.store.meta_set(&format!("resend_stopped:{}", Uuid::now_v7()), "1").unwrap();
    fixture.orchestrator.recover_after_restart().await.unwrap();
    assert_eq!(fixture.store.meta_get(&format!("resend:{}", thread.id)).unwrap(), None);
}
