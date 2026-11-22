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
}

/// One session the scripted driver started.
struct ScriptedLaunch {
    config: kybern_drivers::SessionConfig,
    messages: Arc<Mutex<Vec<UserMessage>>>,
    closes: Arc<AtomicUsize>,
    target_changes: Arc<std::sync::Mutex<Vec<String>>>,
}

/// A Claude driver whose sessions resume conversations Claude Code no longer has when `missing` is set.
struct ScriptedClaude {
    launches: Arc<std::sync::Mutex<Vec<ScriptedLaunch>>>,
    missing: Option<ScriptedAnswer>,
    reject_target: bool,
}

struct ScriptedClaudeSession {
    inner: TestSession,
    events: tokio::sync::mpsc::Sender<DriverEvent>,
    answer: ScriptedAnswer,
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
        self.inner.set_model(model).await
    }
    async fn set_effort(&self, effort: &str) -> kybern_drivers::Result<()> {
        self.inner.set_effort(effort).await
    }
    async fn respond_permission(&self, request_id: &str, decision: &ApprovalDecision) -> kybern_drivers::Result<()> {
        self.inner.respond_permission(request_id, decision).await
    }
    async fn close(&self) -> kybern_drivers::Result<()> {
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
        let inner = TestSession { reject_target: self.reject_target, ..Default::default() };
        let answer = match (&config.resume_session_id, self.missing) {
            (Some(_), Some(missing)) => missing,
            _ => ScriptedAnswer::Answer,
        };
        self.launches.lock().unwrap().push(ScriptedLaunch {
            config,
            messages: inner.messages.clone(),
            closes: inner.closes.clone(),
            target_changes: inner.target_changes.clone(),
        });
        Ok(kybern_drivers::SpawnedSession { session: Box::new(ScriptedClaudeSession { inner, events: tx, answer }), events })
    }
}

fn scripted_claude(missing: Option<ScriptedAnswer>, reject_target: bool) -> (Fixture, Arc<std::sync::Mutex<Vec<ScriptedLaunch>>>) {
    let launches = Arc::new(std::sync::Mutex::new(Vec::new()));
    let mut drivers = DriverRegistry::default();
    drivers.register(Arc::new(ScriptedClaude { launches: launches.clone(), missing, reject_target }));
    (Fixture::with_drivers(drivers), launches)
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
    let task = RuntimeTask {
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
    };
    live.tasks.lock().await.insert(task.id.clone(), task.clone());
    // Full access is a launch flag for Claude Code, so it needs a new process.
    thread.permission_mode = PermissionMode::FullAccess;
    let (receiving, reused) = fixture.orchestrator.ensure_session(&thread).await.unwrap();
    assert!(!reused && !Arc::ptr_eq(&live, &receiving));
    assert_eq!(launches.lock().unwrap()[0].closes.load(Ordering::SeqCst), 0, "the subagent's process keeps running");
    assert!(live.retained.load(Ordering::Relaxed));
    assert!(Arc::ptr_eq(&fixture.orchestrator.task_session(thread.id, &task.id).await.unwrap(), &live));
}

/// The reason a person gives for declining reaches Claude marked as their reply; the reasons Kybern gives
/// itself, other harnesses and declined forms go as they are, and the record keeps the person's words.
#[tokio::test]
async fn decline_feedback_reaches_claude_as_the_users_reply() {
    for (provider, tool, expected) in [
        (ProviderKind::ClaudeCode, "Bash", "The user declined this tool call and said:\nuse rg instead"),
        (ProviderKind::ClaudeCode, "mcp_elicitation", "use rg instead"),
        (ProviderKind::Codex, "shell", "use rg instead"),
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
        assert_eq!(*responses.lock().await, [ApprovalDecision::Deny { reason: Some(expected.into()) }], "{provider} {tool}");
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
