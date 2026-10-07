// Included inside orchestrator::tests to reuse the native-session fixture.
fn add_test_account(fixture: &Fixture, kind: ProviderKind, id: &str) {
    let mut settings = fixture.orchestrator.inner.settings.get();
    let provider = settings.providers.entry(kind).or_default();
    provider
        .accounts
        .insert(id.into(), ProviderAccount { name: id.into(), directory: fixture.root.join(id).to_string_lossy().into_owned() });
    fixture.orchestrator.inner.settings.set(settings).unwrap();
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
        started_at: Utc::now(),
        updated_at: Utc::now(),
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
