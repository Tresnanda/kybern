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
}

/// One session the scripted driver started.
struct ScriptedLaunch {
    config: kybern_drivers::SessionConfig,
    messages: Arc<Mutex<Vec<UserMessage>>>,
    closes: Arc<AtomicUsize>,
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
}

struct ScriptedClaudeSession {
    inner: TestSession,
    events: tokio::sync::mpsc::Sender<DriverEvent>,
    answer: ScriptedAnswer,
    target: TargetScript,
    model_changes: AtomicUsize,
    hold_close: Option<Arc<tokio::sync::Semaphore>>,
}

const GONE: &str = "No conversation found with session ID: provider-session";

#[async_trait::async_trait]
impl AgentSession for ScriptedClaudeSession {
    async fn send_message(&self, message_id: &str, message: &UserMessage) -> kybern_drivers::Result<()> {
        self.inner.send_message(message_id, message).await?;
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
            };
            for event in script {
                let _ = events.send(event).await;
            }
        });
        Ok(())
    }
    async fn interrupt(&self) -> kybern_drivers::Result<()> {
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
        self.launches.lock().unwrap().push(ScriptedLaunch {
            config,
            messages: inner.messages.clone(),
            closes: inner.closes.clone(),
            target_changes: inner.target_changes.clone(),
        });
        let session = ScriptedClaudeSession { inner, events: tx, answer, target: self.target, model_changes: AtomicUsize::new(0), hold_close };
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

        fixture.orchestrator.close_quiet_retained_sessions(Instant::now(), SystemTime::now()).await.unwrap();
        assert_eq!(launches.lock().unwrap()[0].closes.load(Ordering::SeqCst), 0, "{kind:?}: not quiet yet");

        let later = super::claude_sessions::RETAINED_QUIET_LIMIT + Duration::from_secs(1);
        fixture.orchestrator.close_quiet_retained_sessions(Instant::now() + later, SystemTime::now() + later).await.unwrap();
        let closes = launches.lock().unwrap()[0].closes.load(Ordering::SeqCst);
        let shown = notices(&fixture, &thread);
        if kind == RuntimeTaskKind::Agent {
            assert_eq!(closes, 1, "the quiet agent's process is closed");
            assert!(fixture.orchestrator.inner.retained_sessions.lock().await.is_empty());
            assert_eq!(live.tasks.lock().await[&task.id].status, RuntimeTaskStatus::Interrupted);
            assert!(shown.iter().any(|text| text.contains("sent nothing for 30 minutes")), "{shown:?}");
        } else {
            assert_eq!(closes, 0, "a background process is the person's to stop");
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
    fixture.orchestrator.send(thread.id, UserMessage::text("Next question")).await.unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let waiting = fixture.store.meta_get(&format!("resend:{}", thread.id)).unwrap().is_some_and(|turn| !turn.is_empty());
        if waiting && !fixture.orchestrator.inner.sessions.lock().await.contains_key(&thread.id) {
            break;
        }
        assert!(Instant::now() < deadline, "the turn never moved");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    fixture.orchestrator.stop_thread(thread.id, "test").await.expect("Stop works between two sessions");
    hold.add_permits(16);
    let after = settled(&fixture, &thread).await;
    assert_eq!(after.status, ThreadStatus::Idle);
    assert_eq!(launches.lock().unwrap().len(), 1, "nothing is sent after Stop");
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
    // Let a loop, if there were one, start its third session.
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(launches.lock().unwrap().len(), 2, "one fresh session, no more");
    let failures = fixture.store.events_for_thread(thread.id).unwrap().into_iter().filter(|event| matches!(event.payload, EventPayload::TurnFailed { .. })).count();
    assert_eq!(failures, 1);
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
