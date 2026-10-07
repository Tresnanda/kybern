// Included inside orchestrator::tests to reuse the native-session fixture.
fn add_test_account(fixture: &Fixture, kind: ProviderKind, id: &str) {
    let mut settings = fixture.orchestrator.inner.settings.get();
    let provider = settings.providers.entry(kind).or_default();
    provider
        .accounts
        .insert(id.into(), ProviderAccount { name: id.into(), directory: fixture.root.join(id).to_string_lossy().into_owned() });
    fixture.orchestrator.inner.settings.set(settings).unwrap();
}

#[test]
fn quota_recovery_requires_the_latest_interrupted_turn_and_its_own_report() {
    use crate::orchestrator::accounts;
    use chrono::Utc;
    let now = 1_800_000_000;
    let turn = Uuid::now_v7();
    let start = EventPayload::TurnStarted { message_id: Uuid::now_v7(), message: UserMessage::text("task") };
    let report = EventPayload::ProviderUsageUpdated {
        usage: ProviderUsage {
            context: None,
            limits: Some(vec![UsageLimit {
                name: "Weekly".into(),
                used_percent: 100.0,
                window_minutes: Some(10080),
                resets_at: Some(now + 60),
            }]),
        },
    };
    let failed = EventPayload::TurnFailed { error: "Request could not complete".into() };
    let completed = |stop_reason| EventPayload::TurnCompleted {
        stop_reason,
        usage: Usage::default(),
        cost_usd: None,
        duration_ms: 0,
        terminal_message_id: None,
    };
    let events = |payloads: Vec<EventPayload>| {
        payloads
            .into_iter()
            .enumerate()
            .map(|(index, payload)| ThreadEvent {
                seq: index as i64 + 1,
                thread_id: Uuid::nil(),
                turn_id: Some(turn),
                at: Utc::now(),
                payload,
            })
            .collect::<Vec<_>>()
    };
    let reported_failure = events(vec![start.clone(), report.clone(), failed.clone()]);
    assert!(accounts::quota_limited_turn(ThreadStatus::Failed, &reported_failure, now));
    assert!(!accounts::quota_limited_turn(ThreadStatus::Running, &reported_failure, now));
    assert!(!accounts::quota_limited_turn(ThreadStatus::AwaitingApproval, &reported_failure, now));
    assert!(!accounts::quota_limited_turn(ThreadStatus::Failed, &reported_failure, now + 60));
    assert!(!accounts::quota_limited_turn(
        ThreadStatus::Idle,
        &events(vec![start.clone(), report.clone(), completed(StopReason::Completed)]),
        now
    ));
    assert!(accounts::quota_limited_turn(
        ThreadStatus::Idle,
        &events(vec![start.clone(), report.clone(), completed(StopReason::Interrupted)]),
        now
    ));
    assert!(!accounts::quota_limited_turn(ThreadStatus::Failed, &events(vec![start.clone(), failed.clone()]), now));
    assert!(accounts::quota_limited_turn(
        ThreadStatus::Failed,
        &events(vec![start.clone(), EventPayload::TurnFailed { error: "5-hour usage limit reached".into() }]),
        now
    ));
    assert!(!accounts::quota_limited_turn(
        ThreadStatus::Failed,
        &events(vec![start.clone(), EventPayload::TurnFailed { error: "Connection rate limit exceeded".into() }]),
        now
    ));

    let mut newer = reported_failure.clone();
    let next_turn = Uuid::now_v7();
    for payload in [start.clone(), failed] {
        newer.push(ThreadEvent { seq: newer.len() as i64 + 1, thread_id: Uuid::nil(), turn_id: Some(next_turn), at: Utc::now(), payload });
    }
    assert!(!accounts::quota_limited_turn(ThreadStatus::Failed, &newer, now));
    let mut resumed = reported_failure.clone();
    resumed.extend(events(vec![EventPayload::TurnResumed]));
    assert!(!accounts::quota_limited_turn(ThreadStatus::Idle, &resumed, now));
    let mut switched = reported_failure;
    switched.extend(events(vec![EventPayload::SessionTransitioned {
        from: ProviderInstance::default_for(ProviderKind::Codex),
        to: ProviderInstance { kind: ProviderKind::Codex, instance: "work".into() },
        native_resume: false,
        text: "Switched account".into(),
    }]));
    assert!(!accounts::quota_limited_turn(ThreadStatus::Failed, &switched, now));
}

#[tokio::test]
async fn successful_quota_report_does_not_authorize_switch_continue() {
    let fixture = Fixture::new();
    let thread = fixture.thread(ThreadStatus::Idle);
    add_test_account(&fixture, thread.provider.kind, "work");
    let turn = Uuid::now_v7();
    for payload in [
        EventPayload::TurnStarted { message_id: Uuid::now_v7(), message: UserMessage::text("finished task") },
        EventPayload::ProviderUsageUpdated {
            usage: ProviderUsage {
                context: None,
                limits: Some(vec![UsageLimit { name: "5 hours".into(), used_percent: 100.0, window_minutes: Some(300), resets_at: None }]),
            },
        },
        EventPayload::TurnCompleted {
            stop_reason: StopReason::Completed,
            usage: Usage::default(),
            cost_usd: None,
            duration_ms: 0,
            terminal_message_id: None,
        },
    ] {
        fixture.orchestrator.emit(thread.id, Some(turn), payload).unwrap();
    }
    assert!(!fixture.orchestrator.thread_target(thread.id).unwrap().quota_limited);
    assert!(
        fixture
            .orchestrator
            .switch_continue(methods::ThreadsSwitchContinueParams {
                thread_id: thread.id,
                provider: ProviderInstance { kind: thread.provider.kind, instance: "work".into() },
                message_id: Uuid::now_v7(),
            })
            .await
            .is_err()
    );
    assert_eq!(fixture.orchestrator.thread_target(thread.id).unwrap().target.provider, thread.provider);
}

#[tokio::test]
async fn account_selection_does_not_mutate_running_session_and_invalid_selection_is_atomic() {
    let fixture = Fixture::new();
    let thread = fixture.thread(ThreadStatus::Running);
    add_test_account(&fixture, thread.provider.kind, "work");
    let target =
        SessionTarget { provider: ProviderInstance { kind: thread.provider.kind, instance: "work".into() }, model: None, effort: None };
    let selected = fixture
        .orchestrator
        .set_thread_target(methods::ThreadTargetParams { thread_id: thread.id, target: target.clone(), inherit_account: false })
        .await
        .unwrap();
    assert_eq!(selected.target, target);
    assert!(selected.account_override);
    assert_eq!(fixture.store.thread_get(thread.id).unwrap().unwrap().provider, thread.provider);
    let invalid = SessionTarget { provider: ProviderInstance { instance: "missing".into(), ..target.provider }, ..target };
    assert!(
        fixture
            .orchestrator
            .set_thread_target(methods::ThreadTargetParams { thread_id: thread.id, target: invalid, inherit_account: false })
            .await
            .is_err()
    );
    assert_eq!(fixture.orchestrator.thread_target(thread.id).unwrap().target.provider.instance, "work");
}

#[test]
fn default_following_threads_resolve_on_next_admission_and_account_return_restores_native_identity() {
    let fixture = Fixture::new();
    let mut thread = fixture.thread(ThreadStatus::Idle);
    let kind = thread.provider.kind;
    add_test_account(&fixture, thread.provider.kind, "work");
    let mut settings = fixture.orchestrator.inner.settings.get();
    settings.providers.entry(thread.provider.kind).or_default().default_account = Some("work".into());
    fixture.orchestrator.inner.settings.set(settings).unwrap();
    let next = fixture.orchestrator.thread_target(thread.id).unwrap();
    assert_eq!(next.target.provider.instance, "work");
    assert!(!next.account_override);
    assert_eq!(fixture.store.thread_get(thread.id).unwrap().unwrap().provider.instance, "default");
    fixture.orchestrator.admit_target(&mut thread, next.target).unwrap();
    assert!(thread.provider_session_id.is_none());
    thread.provider_session_id = Some("work-native".into());
    fixture
        .orchestrator
        .admit_target(&mut thread, SessionTarget { provider: ProviderInstance::default_for(kind), model: None, effort: None })
        .unwrap();
    assert_eq!(thread.provider_session_id.as_deref(), Some("provider-session"));
    fixture
        .orchestrator
        .admit_target(
            &mut thread,
            SessionTarget { provider: ProviderInstance { kind, instance: "work".into() }, model: None, effort: None },
        )
        .unwrap();
    assert_eq!(thread.provider_session_id.as_deref(), Some("work-native"));
    assert_eq!(thread.cwd, fixture.project.path);
}

#[tokio::test]
async fn queued_input_retains_the_account_selected_when_it_was_queued() {
    let fixture = Fixture::new();
    let thread = fixture.thread(ThreadStatus::Running);
    add_test_account(&fixture, thread.provider.kind, "work");
    let work =
        SessionTarget { provider: ProviderInstance { kind: thread.provider.kind, instance: "work".into() }, model: None, effort: None };
    fixture
        .orchestrator
        .set_thread_target(methods::ThreadTargetParams { thread_id: thread.id, target: work.clone(), inherit_account: false })
        .await
        .unwrap();
    let id = Uuid::now_v7();
    fixture
        .orchestrator
        .enqueue(methods::QueuedMessage { id, thread_id: thread.id, message: UserMessage::text("keep my target") })
        .unwrap();
    fixture
        .orchestrator
        .set_thread_target(methods::ThreadTargetParams {
            thread_id: thread.id,
            target: SessionTarget { provider: thread.provider, model: None, effort: None },
            inherit_account: false,
        })
        .await
        .unwrap();
    let saved: SessionTarget = serde_json::from_str(&fixture.store.meta_get(&format!("queue_target:{id}")).unwrap().unwrap()).unwrap();
    assert_eq!(saved, work);
}

#[tokio::test]
async fn permission_request_is_pending_during_active_turn_and_applies_at_idle() {
    let fixture = Fixture::new();
    let mut thread = fixture.thread(ThreadStatus::Running);
    let result = fixture
        .orchestrator
        .update_session_fields(methods::ThreadsUpdateParams {
            thread_id: thread.id,
            title: None,
            pinned: None,
            permission_mode: Some(PermissionMode::FullAccess),
            model: None,
            effort: None,
        })
        .await
        .unwrap();
    assert_eq!(result.permission_mode, PermissionMode::Supervised);
    assert_eq!(fixture.orchestrator.thread_target(thread.id).unwrap().pending_permission_mode, Some(PermissionMode::FullAccess));
    thread.status = ThreadStatus::Idle;
    fixture.store.thread_upsert(&thread).unwrap();
    let applied = fixture.orchestrator.apply_pending_permission(thread.id, false).await.unwrap();
    assert_eq!(applied.permission_mode, PermissionMode::FullAccess);
    assert!(fixture.orchestrator.thread_target(thread.id).unwrap().pending_permission_mode.is_none());
}

#[tokio::test]
async fn quota_continuation_retry_uses_existing_admission_receipt_without_switching_again() {
    let fixture = Fixture::new();
    let thread = fixture.thread(ThreadStatus::Running);
    let message_id = Uuid::now_v7();
    let turn_id = Uuid::now_v7();
    fixture
        .orchestrator
        .emit(thread.id, Some(turn_id), EventPayload::TurnStarted { message_id, message: UserMessage::text("continuation") })
        .unwrap();
    fixture
        .store
        .meta_set(
            &format!("quota_continue:{message_id}"),
            &serde_json::to_string(&methods::ThreadsSwitchContinueParams {
                thread_id: thread.id,
                provider: ProviderInstance { kind: thread.provider.kind, instance: "missing".into() },
                message_id,
            })
            .unwrap(),
        )
        .unwrap();
    let result = fixture
        .orchestrator
        .switch_continue(methods::ThreadsSwitchContinueParams {
            thread_id: thread.id,
            provider: ProviderInstance { kind: thread.provider.kind, instance: "missing".into() },
            message_id,
        })
        .await
        .unwrap();
    assert_eq!(result.turn_id, turn_id);
    assert_eq!(fixture.store.thread_get(thread.id).unwrap().unwrap().provider, thread.provider);
    assert_eq!(fixture.store.events_for_thread(thread.id).unwrap().len(), 1);
}

#[tokio::test]
async fn permission_restart_waits_for_workspace_and_send_admission_in_consistent_order() {
    let fixture = Fixture::new();
    let thread = fixture.thread_with_provider(ThreadStatus::Idle, ProviderKind::Codex);
    fixture
        .orchestrator
        .inner
        .store
        .meta_set(&format!("pending_permission:{}", thread.id), &serde_json::to_string(&PermissionMode::FullAccess).unwrap())
        .unwrap();
    let workspace = fixture.orchestrator.inner.workspace_ops.lock().await;
    let actor = fixture.orchestrator.clone();
    let applying = tokio::spawn(async move { actor.apply_pending_permission(thread.id, false).await });
    tokio::task::yield_now().await;
    assert!(!applying.is_finished());
    assert_eq!(fixture.store.thread_get(thread.id).unwrap().unwrap().permission_mode, PermissionMode::Supervised);
    drop(workspace);
    assert_eq!(applying.await.unwrap().unwrap().permission_mode, PermissionMode::FullAccess);
}

#[tokio::test]
async fn outgoing_background_service_keeps_original_native_owner_and_suppresses_root_prose() {
    let fixture = Fixture::new();
    let thread = fixture.thread(ThreadStatus::Idle);
    let (live, closes) = fixture.park(&thread, Instant::now()).await;
    fixture.store.meta_set(&format!("live_owner:{}", thread.id), &serde_json::to_string(&thread.provider).unwrap()).unwrap();
    let task = RuntimeTask {
        id: "server-owned-by-first-account".into(),
        thread_id: thread.id,
        origin_turn_id: Uuid::now_v7(),
        started_seq: 0,
        updated_seq: 0,
        kind: RuntimeTaskKind::Process,
        status: RuntimeTaskStatus::Running,
        title: "Development server".into(),
        detail: None,
        provider_type: None,
        parent_id: None,
        tool_call_id: None,
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
    fixture.orchestrator.retire_or_close_session(thread.id, live.clone(), "first-account-identity".into()).await.unwrap();
    assert_eq!(closes.load(Ordering::SeqCst), 0);
    assert!(live.retained.load(Ordering::Relaxed));
    assert!(Arc::ptr_eq(&fixture.orchestrator.task_session(thread.id, &task.id).await.unwrap(), &live));
    fixture
        .orchestrator
        .handle_driver_event(
            thread.id,
            &live,
            DriverEvent::TextDelta { message_id: "outgoing".into(), origin: EventOrigin::Root, delta: "old account notification".into() },
        )
        .await
        .unwrap();
    assert!(fixture.store.events_for_thread(thread.id).unwrap().is_empty());
    let stopped = fixture.orchestrator.stop_runtime_task(thread.id, &task.id).await.unwrap();
    assert_eq!(stopped.status, RuntimeTaskStatus::Stopping);
    assert_eq!(fixture.store.thread_get(thread.id).unwrap().unwrap().status, ThreadStatus::Idle);
}

#[test]
fn incompatible_target_permissions_fail_before_transition_mutation() {
    let fixture = Fixture::new();
    let mut thread = fixture.thread(ThreadStatus::Idle);
    let before = thread.clone();
    let selected = SessionTarget { provider: ProviderInstance::default_for(ProviderKind::Cursor), model: None, effort: None };
    assert!(fixture.orchestrator.admit_target(&mut thread, selected.clone()).is_err());
    assert_eq!(thread.provider, before.provider);
    assert_eq!(thread.permission_mode, PermissionMode::Supervised);
    assert_eq!(thread.provider_session_id, before.provider_session_id);
    assert!(fixture.store.events_for_thread(thread.id).unwrap().is_empty());
    thread.permission_mode = PermissionMode::Auto;
    fixture.orchestrator.admit_target(&mut thread, selected).unwrap();
    assert_eq!(thread.permission_mode, PermissionMode::Auto);
    assert!(thread.provider_session_id.is_none());
}

#[tokio::test]
async fn rejected_native_permissions_do_not_persist_or_display_requested_authority() {
    let fixture = Fixture::new();
    let thread = fixture.thread_with_provider(ThreadStatus::Idle, ProviderKind::Codex);
    let (live, _) = fixture.park(&thread, Instant::now()).await;
    fixture.orchestrator.inner.sessions.lock().await.remove(&thread.id);
    let mut live = Arc::try_unwrap(live).ok().unwrap();
    live.session = Box::new(TestSession { reject_permission: true, ..Default::default() });
    fixture.orchestrator.inner.sessions.lock().await.insert(thread.id, Arc::new(live));
    let rejected = fixture
        .orchestrator
        .update_session_fields(methods::ThreadsUpdateParams {
            thread_id: thread.id,
            title: None,
            pinned: None,
            permission_mode: Some(PermissionMode::FullAccess),
            model: None,
            effort: None,
        })
        .await;
    assert!(rejected.is_err());
    let state = fixture.orchestrator.thread_target(thread.id).unwrap();
    assert_eq!(state.effective_permission_mode, PermissionMode::Supervised);
    assert!(state.pending_permission_mode.is_none());
}

#[tokio::test]
async fn repeated_native_task_ids_keep_both_owners_and_translate_targeted_controls() {
    let fixture = Fixture::new();
    let thread = fixture.thread(ThreadStatus::Idle);
    let turn_id = Uuid::now_v7();
    let (outgoing, _) = fixture.park(&thread, Instant::now()).await;
    let mut native = agent_task("reused-native-id", None, None);
    native.kind = RuntimeTaskKind::Process;
    native.backgrounded = true;
    native.capabilities = RuntimeTaskCapabilities { stop: true, background: false };
    let old = fixture.orchestrator.persist_runtime_task_start(thread.id, &outgoing, Some(turn_id), native.clone()).await.unwrap();
    fixture.store.meta_set(&format!("live_owner:{}", thread.id), &serde_json::to_string(&thread.provider).unwrap()).unwrap();
    fixture.orchestrator.retire_or_close_session(thread.id, outgoing.clone(), "old-config".into()).await.unwrap();
    let (incoming, _) = fixture.park(&thread, Instant::now()).await;
    let new = fixture.orchestrator.persist_runtime_task_start(thread.id, &incoming, Some(Uuid::now_v7()), native).await.unwrap();
    assert_ne!(old.id, new.id);
    assert!(Arc::ptr_eq(&fixture.orchestrator.task_session(thread.id, &old.id).await.unwrap(), &outgoing));
    assert!(Arc::ptr_eq(&fixture.orchestrator.task_session(thread.id, &new.id).await.unwrap(), &incoming));
    assert_eq!(fixture.orchestrator.native_runtime_task(&incoming, &new).await.id, old.id);
    fixture
        .orchestrator
        .apply_runtime_task_update(
            thread.id,
            &incoming,
            DriverRuntimeTaskUpdate::status(old.id.clone(), RuntimeTaskStatus::Completed),
            super::RuntimeTaskUpdateKind::Complete,
        )
        .await
        .unwrap();
    assert!(outgoing.tasks.lock().await[&old.id].status.is_active());
    assert_eq!(incoming.tasks.lock().await[&new.id].status, RuntimeTaskStatus::Completed);
    assert_eq!(fixture.store.runtime_tasks_for_thread(thread.id).unwrap().len(), 2);
}

#[tokio::test]
async fn stale_quota_failure_cannot_switch_a_newer_turn() {
    let fixture = Fixture::new();
    let thread = fixture.thread(ThreadStatus::Running);
    add_test_account(&fixture, thread.provider.kind, "work");
    let failed_turn = Uuid::now_v7();
    fixture
        .orchestrator
        .emit(
            thread.id,
            Some(failed_turn),
            EventPayload::TurnStarted { message_id: Uuid::now_v7(), message: UserMessage::text("old task") },
        )
        .unwrap();
    fixture
        .orchestrator
        .emit(thread.id, Some(failed_turn), EventPayload::TurnFailed { error: "weekly usage limit exceeded".into() })
        .unwrap();
    fixture
        .orchestrator
        .emit(
            thread.id,
            Some(Uuid::now_v7()),
            EventPayload::TurnStarted { message_id: Uuid::now_v7(), message: UserMessage::text("new task") },
        )
        .unwrap();
    let request = methods::ThreadsSwitchContinueParams {
        thread_id: thread.id,
        provider: ProviderInstance { kind: thread.provider.kind, instance: "work".into() },
        message_id: Uuid::now_v7(),
    };
    assert!(fixture.orchestrator.switch_continue(request).await.is_err());
    assert_eq!(fixture.orchestrator.thread_target(thread.id).unwrap().target.provider, thread.provider);
}

#[test]
fn changed_native_directory_or_environment_invalidates_same_account_continuation() {
    let fixture = Fixture::new();
    let mut thread = fixture.thread(ThreadStatus::Idle);
    fixture.orchestrator.save_account_binding(&thread).unwrap();
    let mut settings = fixture.orchestrator.inner.settings.get();
    settings.providers.entry(thread.provider.kind).or_default().env.insert("NATIVE_PROFILE_SETTING".into(), "changed".into());
    fixture.orchestrator.inner.settings.set(settings).unwrap();
    let target = SessionTarget { provider: thread.provider.clone(), model: thread.model.clone(), effort: thread.effort.clone() };
    fixture.orchestrator.admit_target(&mut thread, target).unwrap();
    assert!(thread.provider_session_id.is_none());
    assert!(fixture.store.meta_get(&format!("handoff:{}", thread.id)).unwrap().is_some());
}

#[tokio::test]
async fn receiving_modes_are_explicit_target_bound_and_queued_without_reconfiguring_outgoing() {
    for active in [false, true] {
        for (from, to, old_mode, selected_mode) in [
            (ProviderKind::ClaudeCode, ProviderKind::Cursor, PermissionMode::Supervised, PermissionMode::Auto),
            (ProviderKind::Cursor, ProviderKind::ClaudeCode, PermissionMode::Auto, PermissionMode::Supervised),
        ] {
            let fixture = Fixture::new();
            let mut thread = fixture.thread_with_provider(if active { ThreadStatus::Running } else { ThreadStatus::Idle }, from);
            thread.permission_mode = old_mode;
            fixture.store.thread_upsert(&thread).unwrap();
            fixture
                .orchestrator
                .set_thread_target(methods::ThreadTargetParams {
                    thread_id: thread.id,
                    target: SessionTarget { provider: ProviderInstance::default_for(to), model: None, effort: None },
                    inherit_account: false,
                })
                .await
                .unwrap();
            fixture
                .orchestrator
                .update_session_fields(methods::ThreadsUpdateParams {
                    thread_id: thread.id,
                    title: None,
                    pinned: None,
                    permission_mode: Some(selected_mode),
                    model: None,
                    effort: None,
                })
                .await
                .unwrap();
            assert_eq!(fixture.store.thread_get(thread.id).unwrap().unwrap().permission_mode, old_mode);
            assert_eq!(fixture.orchestrator.thread_target(thread.id).unwrap().pending_permission_mode, Some(selected_mode));
            fixture.orchestrator.apply_pending_permission(thread.id, false).await.unwrap();
            assert_eq!(fixture.store.thread_get(thread.id).unwrap().unwrap().permission_mode, old_mode);
            if active {
                let id = Uuid::now_v7();
                fixture
                    .orchestrator
                    .enqueue(methods::QueuedMessage {
                        id,
                        thread_id: thread.id,
                        message: UserMessage::text("explicit receiving authority"),
                    })
                    .unwrap();
                assert_eq!(
                    fixture.store.meta_get(&format!("queue_permission:{id}")).unwrap().unwrap(),
                    serde_json::to_string(&selected_mode).unwrap()
                );
            }
            let selected = fixture.orchestrator.thread_target(thread.id).unwrap().target;
            thread.permission_mode = fixture.orchestrator.pending_permission_for(&thread, &selected.provider).unwrap().unwrap();
            fixture.orchestrator.admit_target(&mut thread, selected).unwrap();
            assert_eq!(thread.provider.kind, to);
            assert_eq!(thread.permission_mode, selected_mode);
        }
    }
}

#[tokio::test]
async fn outgoing_app_tool_requests_are_rejected_without_blocking_background_owner() {
    let fixture = Fixture::new();
    let thread = fixture.thread(ThreadStatus::Idle);
    let (live, _) = fixture.park(&thread, Instant::now()).await;
    fixture.orchestrator.inner.sessions.lock().await.remove(&thread.id);
    let mut live = Arc::try_unwrap(live).ok().unwrap();
    let responses = Arc::new(Mutex::new(Vec::new()));
    live.session = Box::new(TestSession { app_tool_responses: responses.clone(), ..Default::default() });
    let live = Arc::new(live);
    live.retained.store(true, Ordering::Relaxed);
    fixture
        .orchestrator
        .handle_driver_event(
            thread.id,
            &live,
            DriverEvent::AppToolRequest { request_id: "outgoing-request".into(), name: "kybern_send_message".into(), arguments: json!({}) },
        )
        .await
        .unwrap();
    let responses = responses.lock().await;
    assert_eq!(responses.len(), 1);
    assert_eq!(responses[0].0, "outgoing-request");
    assert!(responses[0].1.is_err());
    assert!(fixture.store.events_for_thread(thread.id).unwrap().is_empty());
}

#[test]
fn current_cursor_legacy_binding_loses_compatibility_when_native_configuration_changes() {
    let fixture = Fixture::new();
    let mut thread = fixture.thread_with_provider(ThreadStatus::Idle, ProviderKind::Cursor);
    thread.provider_session_id = Some("legacy-acp-native".into());
    fixture.store.thread_upsert(&thread).unwrap();
    fixture.orchestrator.save_account_binding(&thread).unwrap();
    assert_eq!(fixture.orchestrator.thread_target(thread.id).unwrap().native_session_id.as_deref(), Some("legacy-acp-native"));
    let mut settings = fixture.orchestrator.inner.settings.get();
    settings
        .providers
        .entry(ProviderKind::Cursor)
        .or_default()
        .env
        .insert("KYBERN_CURSOR_STATE_DIR".into(), "/changed-native-directory".into());
    fixture.orchestrator.inner.settings.set(settings).unwrap();
    assert!(fixture.orchestrator.thread_target(thread.id).unwrap().native_session_id.is_none());
    let target = SessionTarget { provider: thread.provider.clone(), model: thread.model.clone(), effort: thread.effort.clone() };
    assert!(fixture.orchestrator.admit_target(&mut thread, target).is_err());
    assert_eq!(thread.provider_session_id.as_deref(), Some("legacy-acp-native"));
    assert_eq!(thread.permission_mode, PermissionMode::Supervised);
}

#[tokio::test]
async fn returning_cursor_account_exposes_compatible_legacy_id_and_accepts_its_explicit_mode() {
    let fixture = Fixture::new();
    let mut thread = fixture.thread_with_provider(ThreadStatus::Idle, ProviderKind::Cursor);
    thread.provider_session_id = Some("legacy-acp-native".into());
    fixture.store.thread_upsert(&thread).unwrap();
    add_test_account(&fixture, ProviderKind::Cursor, "work");
    fixture.orchestrator.save_account_binding(&thread).unwrap();
    let work =
        SessionTarget { provider: ProviderInstance { kind: ProviderKind::Cursor, instance: "work".into() }, model: None, effort: None };
    fixture
        .orchestrator
        .set_thread_target(methods::ThreadTargetParams { thread_id: thread.id, target: work.clone(), inherit_account: false })
        .await
        .unwrap();
    assert!(fixture.orchestrator.thread_target(thread.id).unwrap().native_session_id.is_none());
    assert!(fixture.orchestrator.admit_target(&mut thread, work.clone()).is_err());
    thread.permission_mode = PermissionMode::Auto;
    fixture.orchestrator.admit_target(&mut thread, work).unwrap();
    thread.provider_session_id = Some("cursor-sdk:work-native".into());
    fixture.store.thread_upsert(&thread).unwrap();
    let original = SessionTarget { provider: ProviderInstance::default_for(ProviderKind::Cursor), model: None, effort: None };
    let selected = fixture
        .orchestrator
        .set_thread_target(methods::ThreadTargetParams { thread_id: thread.id, target: original.clone(), inherit_account: false })
        .await
        .unwrap();
    assert_eq!(selected.native_session_id.as_deref(), Some("legacy-acp-native"));
    fixture
        .orchestrator
        .update_session_fields(methods::ThreadsUpdateParams {
            thread_id: thread.id,
            title: None,
            pinned: None,
            permission_mode: Some(PermissionMode::Supervised),
            model: None,
            effort: None,
        })
        .await
        .unwrap();
    assert_eq!(fixture.store.thread_get(thread.id).unwrap().unwrap().permission_mode, PermissionMode::Auto);
    thread.permission_mode = fixture.orchestrator.pending_permission_for(&thread, &original.provider).unwrap().unwrap();
    fixture.orchestrator.admit_target(&mut thread, original).unwrap();
    assert_eq!(thread.provider_session_id.as_deref(), Some("legacy-acp-native"));
    assert_eq!(thread.permission_mode, PermissionMode::Supervised);
}

#[tokio::test]
async fn retained_child_output_keeps_its_owner_when_native_child_keys_are_reused() {
    let fixture = Fixture::new();
    let thread = fixture.thread(ThreadStatus::Idle);
    let (outgoing, _) = fixture.park(&thread, Instant::now()).await;
    let mut native = agent_task("reused-child", Some("reused-launch"), None);
    native.provider_thread_id = Some("reused-provider-child".into());
    let old = fixture.orchestrator.persist_runtime_task_start(thread.id, &outgoing, Some(Uuid::now_v7()), native.clone()).await.unwrap();
    let old_child = child_of(&fixture, thread.id, &old.id);
    outgoing.retained.store(true, Ordering::Relaxed);
    let (incoming, _) = fixture.park(&thread, Instant::now()).await;
    let new = fixture.orchestrator.persist_runtime_task_start(thread.id, &incoming, Some(Uuid::now_v7()), native).await.unwrap();
    let new_child = child_of(&fixture, thread.id, &new.id);
    assert_ne!(old_child.id, new_child.id);
    let root_count = fixture.store.events_for_thread(thread.id).unwrap().len();
    let incoming_count = fixture.store.events_for_thread(new_child.id).unwrap().len();
    for (key, text) in
        [("reused-child", "raw child reply"), ("reused-provider-child", "provider child reply"), ("reused-launch", "launch child reply")]
    {
        fixture.orchestrator.handle_driver_event(thread.id, &outgoing, agent_text(key, key, text)).await.unwrap();
    }
    fixture.orchestrator.handle_driver_event(thread.id, &outgoing, agent_text("unknown-child", "unknown", "unowned reply")).await.unwrap();
    fixture
        .orchestrator
        .handle_driver_event(
            thread.id,
            &outgoing,
            DriverEvent::TextDelta { message_id: "outgoing-root".into(), origin: EventOrigin::Root, delta: "outgoing root reply".into() },
        )
        .await
        .unwrap();
    let old_events = fixture.store.events_for_thread(old_child.id).unwrap();
    for text in ["raw child reply", "provider child reply", "launch child reply"] {
        assert!(
            old_events
                .iter()
                .any(|event| matches!(&event.payload, EventPayload::AssistantMessageCompleted { text: actual, .. } if actual == text))
        );
    }
    assert!(
        !old_events
            .iter()
            .any(|event| matches!(&event.payload, EventPayload::AssistantMessageCompleted { text, .. } if text == "unowned reply"))
    );
    assert_eq!(fixture.store.events_for_thread(thread.id).unwrap().len(), root_count);
    assert_eq!(fixture.store.events_for_thread(new_child.id).unwrap().len(), incoming_count);
}

#[tokio::test]
async fn handoff_steering_freezes_target_and_permissions_and_retries_after_admission() {
    let fixture = Fixture::new();
    let thread = fixture.thread_with_provider(ThreadStatus::Idle, ProviderKind::Codex);
    let (live, _, messages) = fixture.park_recording(&thread, Instant::now()).await;
    fixture.orchestrator.send(thread.id, UserMessage::text("initial work")).await.unwrap();
    live.turn_ready.notified().await;
    let target = SessionTarget { provider: thread.provider.clone(), model: Some("reviewed-model".into()), effort: None };
    fixture.store.meta_set(&format!("target:{}", thread.id), &serde_json::to_string(&target).unwrap()).unwrap();
    fixture
        .store
        .meta_set(&format!("pending_permission:{}", thread.id), &serde_json::to_string(&PermissionMode::FullAccess).unwrap())
        .unwrap();
    let workspace = fixture.orchestrator.inner.workspace_ops.lock().await;
    let prompt =
        methods::QueuedMessage { id: Uuid::now_v7(), thread_id: thread.id, message: UserMessage::text("continue with the selected model") };
    let actor = fixture.orchestrator.clone();
    let admitted = prompt.clone();
    let steering = tokio::spawn(async move { actor.steer(admitted).await });
    tokio::time::timeout(Duration::from_secs(2), async {
        while fixture.store.meta_get(&format!("steer_target:{}", prompt.id)).unwrap().is_none() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    // A later picker/permission change cannot retarget already admitted input.
    fixture
        .store
        .meta_set(
            &format!("target:{}", thread.id),
            &serde_json::to_string(&SessionTarget { model: Some("later-model".into()), ..target.clone() }).unwrap(),
        )
        .unwrap();
    fixture
        .store
        .meta_set(&format!("pending_permission:{}", thread.id), &serde_json::to_string(&PermissionMode::Supervised).unwrap())
        .unwrap();
    fixture.orchestrator.handle_driver_event(thread.id, &live, completed_response(StopReason::Interrupted)).await.unwrap();
    drop(workspace);
    let first = steering.await.unwrap().unwrap();
    live.turn_ready.notified().await;
    let saved = fixture.store.thread_get(thread.id).unwrap().unwrap();
    assert_eq!(saved.model.as_deref(), Some("reviewed-model"));
    assert_eq!(saved.permission_mode, PermissionMode::FullAccess);
    assert_eq!(fixture.orchestrator.pending_permission_for(&saved, &saved.provider).unwrap(), Some(PermissionMode::Supervised));
    let retry = fixture.orchestrator.steer(prompt.clone()).await.unwrap();
    assert_eq!(retry.turn_id, first.turn_id);
    assert_eq!(retry.message_id, prompt.id);
    assert_eq!(
        fixture
            .store
            .events_for_thread(thread.id)
            .unwrap()
            .iter()
            .filter(|event| matches!(event.payload, EventPayload::TurnStarted { .. }))
            .count(),
        2
    );
    assert_eq!(
        fixture
            .store
            .events_for_thread(thread.id)
            .unwrap()
            .iter()
            .filter(|event| matches!(event.payload, EventPayload::MessageSteered { .. }))
            .count(),
        0
    );
    assert!(fixture.orchestrator.steer(methods::QueuedMessage { message: UserMessage::text("different"), ..prompt }).await.is_err());
    tokio::time::timeout(Duration::from_secs(2), async {
        while messages.lock().await.len() < 2 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let delivered = messages.lock().await;
    assert_eq!(delivered.len(), 2);
    assert_eq!(delivered[1].plain_text(), "continue with the selected model");
}

#[tokio::test]
async fn target_mutations_wait_for_session_admission_and_keep_human_request_order() {
    let fixture = Fixture::new();
    let thread = fixture.thread(ThreadStatus::Running);
    add_test_account(&fixture, thread.provider.kind, "account-b");
    add_test_account(&fixture, thread.provider.kind, "account-c");
    let admission = fixture.orchestrator.session_admission(thread.id).await;
    let held = admission.lock().await;
    let select = |instance: &str| methods::ThreadTargetParams {
        thread_id: thread.id,
        target: SessionTarget {
            provider: ProviderInstance { kind: thread.provider.kind, instance: instance.into() },
            model: None,
            effort: None,
        },
        inherit_account: false,
    };
    let first_orchestrator = fixture.orchestrator.clone();
    let first = select("account-b");
    let (entered, waiting) = tokio::sync::oneshot::channel();
    let first = tokio::spawn(async move {
        entered.send(()).unwrap();
        first_orchestrator.set_thread_target(first).await
    });
    waiting.await.unwrap();
    assert!(!first.is_finished(), "target validation/persistence waits behind admission");
    let second_orchestrator = fixture.orchestrator.clone();
    let second = select("account-c");
    let second = tokio::spawn(async move { second_orchestrator.set_thread_target(second).await });
    tokio::task::yield_now().await;
    assert!(!second.is_finished());
    assert_eq!(fixture.orchestrator.thread_target(thread.id).unwrap().target.provider, thread.provider);
    drop(held);
    assert_eq!(first.await.unwrap().unwrap().target.provider.instance, "account-b");
    assert_eq!(second.await.unwrap().unwrap().target.provider.instance, "account-c");
    assert_eq!(fixture.orchestrator.thread_target(thread.id).unwrap().target.provider.instance, "account-c");
    assert_eq!(
        fixture.store.thread_get(thread.id).unwrap().unwrap().provider,
        thread.provider,
        "selection never changes the active native owner"
    );
}
