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
        .admit_target(
            &mut thread,
            SessionTarget { provider: ProviderInstance::default_for(thread.provider.kind), model: None, effort: None },
        )
        .unwrap();
    assert_eq!(thread.provider_session_id.as_deref(), Some("provider-session"));
    fixture
        .orchestrator
        .admit_target(
            &mut thread,
            SessionTarget { provider: ProviderInstance { kind: thread.provider.kind, instance: "work".into() }, model: None, effort: None },
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
