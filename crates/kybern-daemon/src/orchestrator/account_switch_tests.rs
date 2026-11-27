// Included inside orchestrator::tests to reuse its fixture. Codex with a binary that does not
// exist: limit reads and sessions fail at once, and nothing touches a real login.
fn codex_accounts(fixture: &Fixture) -> Thread {
    let home = fixture.root.join("home");
    std::fs::create_dir_all(home.join(".codex")).unwrap();
    let mut settings = fixture.orchestrator.inner.settings.get();
    let provider = settings.providers.entry(ProviderKind::Codex).or_default();
    provider.binary = Some(fixture.root.join("missing/codex").to_string_lossy().into_owned());
    provider.env.insert("HOME".into(), home.to_string_lossy().into_owned());
    provider.env.insert("CODEX_HOME".into(), home.join(".codex").to_string_lossy().into_owned());
    for (id, name) in [("work", "Work"), ("spare", "Spare")] {
        let directory = fixture.root.join("accounts").join(id);
        std::fs::create_dir_all(&directory).unwrap();
        provider.accounts.insert(
            id.into(),
            ProviderAccount {
                name: name.into(),
                directory: directory.to_string_lossy().into_owned(),
                email: Some(format!("{id}@example.com")),
                ..Default::default()
            },
        );
    }
    fixture.orchestrator.inner.settings.set(settings).unwrap();
    let thread = fixture.thread_with_provider(ThreadStatus::Failed, ProviderKind::Codex);
    for instance in ["default", "work", "spare"] {
        fixture.orchestrator.set_probe_for_test(&codex(instance), true, None);
    }
    let turn = Uuid::now_v7();
    fixture
        .orchestrator
        .emit(thread.id, Some(turn), EventPayload::TurnStarted { message_id: Uuid::now_v7(), message: UserMessage::text("task") })
        .unwrap();
    fixture
        .orchestrator
        .emit(thread.id, Some(turn), EventPayload::TurnFailed { error: "You've hit your usage limit for the 5-hour window.".into(), problem: None })
        .unwrap();
    fixture.store.thread_get(thread.id).unwrap().unwrap()
}

fn codex(instance: &str) -> ProviderInstance {
    ProviderInstance { kind: ProviderKind::Codex, instance: instance.into() }
}

fn five_hours(used: f64, resets_in: i64) -> UsageLimit {
    UsageLimit {
        name: "5 hours".into(),
        used_percent: used,
        window_minutes: Some(300),
        resets_at: Some(chrono::Utc::now().timestamp() + resets_in),
    }
}

fn weekly(used: f64) -> UsageLimit {
    UsageLimit { name: "Weekly".into(), used_percent: used, window_minutes: Some(10080), resets_at: Some(chrono::Utc::now().timestamp() + 86_400) }
}

fn set_limits(fixture: &Fixture, instance: &str, limits: Vec<UsageLimit>) {
    fixture.orchestrator.inner.usage.observe_account(&codex(instance), &limits);
}

async fn wait_for_event(fixture: &Fixture, thread_id: ThreadId, matches: impl Fn(&EventPayload) -> bool) -> ThreadEvent {
    for _ in 0..200 {
        if let Some(event) = fixture.store.events_for_thread(thread_id).unwrap().into_iter().find(|event| matches(&event.payload)) {
            return event;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("the event never came: {:#?}", fixture.store.events_for_thread(thread_id).unwrap().iter().map(|e| e.payload.kind()).collect::<Vec<_>>());
}

fn count(fixture: &Fixture, thread_id: ThreadId, matches: impl Fn(&EventPayload) -> bool) -> usize {
    fixture.store.events_for_thread(thread_id).unwrap().iter().filter(|event| matches(&event.payload)).count()
}

const CONTINUE: &str = "Continue the interrupted task";

#[tokio::test]
async fn a_limit_offers_the_account_with_most_room_and_switches_only_on_a_tap() {
    let fixture = Fixture::new();
    let thread = codex_accounts(&fixture);
    set_limits(&fixture, "default", vec![five_hours(100.0, 3600), weekly(20.0)]);
    set_limits(&fixture, "work", vec![five_hours(30.0, 3600), weekly(10.0)]);
    set_limits(&fixture, "spare", vec![five_hours(60.0, 3600), weekly(10.0)]);
    let state = fixture.orchestrator.thread_target(thread.id).unwrap();
    assert!(state.quota_limited);
    assert_eq!(state.suggested_account.as_deref(), Some("work"));

    // "Only when I choose" is never suggested; an account almost out of its week neither.
    let mut settings = fixture.orchestrator.inner.settings.get();
    settings.accounts_shared.profiles.insert(
        AccountsShared::key(ProviderKind::Codex, "Work@Example.com"),
        AccountProfile { name: "Work".into(), color: None, manual_only: true },
    );
    fixture.orchestrator.inner.settings.set(settings).unwrap();
    assert_eq!(fixture.orchestrator.thread_target(thread.id).unwrap().suggested_account.as_deref(), Some("spare"));
    set_limits(&fixture, "spare", vec![five_hours(60.0, 3600), weekly(95.0)]);
    assert_eq!(fixture.orchestrator.thread_target(thread.id).unwrap().suggested_account, None);
    set_limits(&fixture, "spare", vec![five_hours(60.0, 3600), weekly(10.0)]);

    // Settling the turn never moves the thread: it waits on its own account and offers the switch.
    fixture.orchestrator.recover_limited_turn(thread.id).await.unwrap();
    assert_eq!(count(&fixture, thread.id, |p| matches!(p, EventPayload::AccountSwitched { .. })), 0);
    let state = fixture.orchestrator.thread_target(thread.id).unwrap();
    assert_eq!(state.target.provider, codex("default"));
    assert_eq!(state.waiting_account, Some(codex("default")));
    assert_eq!(state.suggested_account.as_deref(), Some("spare"));

    // One tap without an account uses the suggestion, and ends the wait.
    fixture
        .orchestrator
        .switch_continue(methods::ThreadsSwitchContinueParams { thread_id: thread.id, provider: None, message_id: Uuid::now_v7() })
        .await
        .unwrap();
    let switched = wait_for_event(&fixture, thread.id, |p| matches!(p, EventPayload::AccountSwitched { .. })).await;
    let EventPayload::AccountSwitched { from, to, reason, text } = switched.payload else { unreachable!() };
    assert_eq!((from, to.clone(), reason), (codex("default"), codex("spare"), AccountSwitchReason::Limit));
    assert!(text.contains("Spare"), "{text}");
    assert_eq!(fixture.orchestrator.thread_target(thread.id).unwrap().target.provider, to);
    wait_for_event(&fixture, thread.id, |p| matches!(p, EventPayload::AccountWaitEnded { cancelled: true, .. })).await;
    assert!(fixture.orchestrator.pending_wait(thread.id).unwrap().is_none());
    wait_for_event(&fixture, thread.id, |p| matches!(p, EventPayload::TurnStarted { message, .. } if message.plain_text().starts_with(CONTINUE))).await;

    // Undo is a normal target change back to the account it came from.
    let mut target = fixture.orchestrator.thread_target(thread.id).unwrap().target;
    target.provider = codex("default");
    fixture.orchestrator.set_thread_target(methods::ThreadTargetParams { thread_id: thread.id, target, inherit_account: false }).await.unwrap();
    assert_eq!(fixture.orchestrator.thread_target(thread.id).unwrap().target.provider, codex("default"));
}

#[tokio::test]
async fn a_wait_survives_a_restart_continues_on_its_own_account_and_stop_cancels_it() {
    let fixture = Fixture::new();
    let thread = codex_accounts(&fixture);
    let reset_in = 3600;
    set_limits(&fixture, "default", vec![five_hours(100.0, reset_in)]);
    for other in ["work", "spare"] {
        set_limits(&fixture, other, vec![five_hours(100.0, 600)]);
    }
    fixture.orchestrator.recover_limited_turn(thread.id).await.unwrap();
    let wait = fixture.orchestrator.pending_wait(thread.id).unwrap().expect("a wait");
    // Its own account, even though the others reset sooner.
    assert_eq!(wait.account, codex("default"));
    let expected = chrono::Utc::now().timestamp() + reset_in + 60;
    assert!((wait.until.timestamp() - expected).abs() <= 5, "{} vs {expected}", wait.until);
    assert_eq!(fixture.orchestrator.thread_target(thread.id).unwrap().waiting_until, Some(wait.until));
    let event = wait_for_event(&fixture, thread.id, |p| matches!(p, EventPayload::AccountWait { .. })).await;
    assert!(matches!(event.payload, EventPayload::AccountWait { ref account, .. } if *account == Some(codex("default"))));
    // Deciding again (a second settled event) does not add a second wait.
    fixture.orchestrator.recover_limited_turn(thread.id).await.unwrap();
    assert_eq!(count(&fixture, thread.id, |p| matches!(p, EventPayload::AccountWait { .. })), 1);

    // A restart forgets the timers; recovery arms them again from the store.
    let waits = |fixture: &Fixture| fixture.orchestrator.inner.account_switch.waits.lock().unwrap().len();
    for (_, handle) in fixture.orchestrator.inner.account_switch.waits.lock().unwrap().drain() {
        handle.abort();
    }
    fixture.orchestrator.account_waits_recover_after_restart().unwrap();
    assert_eq!(waits(&fixture), 1);

    // Stop cancels it.
    fixture.orchestrator.stop_thread(thread.id, "test").await.unwrap();
    assert!(fixture.orchestrator.pending_wait(thread.id).unwrap().is_none());
    assert_eq!(waits(&fixture), 0);
    assert_eq!(count(&fixture, thread.id, |p| matches!(p, EventPayload::AccountWaitEnded { cancelled: true, .. })), 1);
    assert_eq!(count(&fixture, thread.id, |p| matches!(p, EventPayload::TurnStarted { message, .. } if message.plain_text().starts_with(CONTINUE))), 0);

    // A wait whose time passed while the daemon was down continues at once, on the same account.
    let due = methods::ThreadsSwitchContinueParams { thread_id: thread.id, provider: None, message_id: Uuid::now_v7() };
    let wait = super::account_switch::PendingWait { until: chrono::Utc::now() - chrono::Duration::minutes(1), account: codex("default"), message_id: due.message_id };
    fixture.store.meta_set(&format!("account_wait:{}", thread.id), &serde_json::to_string(&wait).unwrap()).unwrap();
    fixture.orchestrator.account_waits_recover_after_restart().unwrap();
    wait_for_event(&fixture, thread.id, |p| matches!(p, EventPayload::AccountWaitEnded { cancelled: false, .. })).await;
    let started = wait_for_event(&fixture, thread.id, |p| matches!(p, EventPayload::TurnStarted { message, .. } if message.plain_text().starts_with(CONTINUE))).await;
    assert!(matches!(started.payload, EventPayload::TurnStarted { message_id, .. } if message_id == due.message_id));
    assert_eq!(count(&fixture, thread.id, |p| matches!(p, EventPayload::AccountSwitched { .. })), 0);
    assert_eq!(fixture.orchestrator.thread_target(thread.id).unwrap().target.provider, codex("default"));
}

#[tokio::test]
async fn a_new_message_ends_the_wait() {
    let fixture = Fixture::new();
    let thread = codex_accounts(&fixture);
    set_limits(&fixture, "default", vec![five_hours(100.0, 3600)]);
    fixture.orchestrator.recover_limited_turn(thread.id).await.unwrap();
    assert!(fixture.orchestrator.pending_wait(thread.id).unwrap().is_some());
    fixture
        .orchestrator
        .send_client_message(methods::ThreadsSendParams { thread_id: thread.id, message: UserMessage::text("something else"), message_id: None })
        .await
        .unwrap();
    assert!(fixture.orchestrator.pending_wait(thread.id).unwrap().is_none());
    assert_eq!(count(&fixture, thread.id, |p| matches!(p, EventPayload::AccountWaitEnded { cancelled: true, .. })), 1);
}

#[tokio::test]
async fn an_account_missing_here_is_offered_never_replaced() {
    let fixture = Fixture::new();
    let thread = codex_accounts(&fixture);
    set_limits(&fixture, "spare", vec![five_hours(10.0, 3600)]);
    let mut target = fixture.orchestrator.thread_target(thread.id).unwrap().target;
    target.provider = codex("work");
    fixture.orchestrator.set_thread_target(methods::ThreadTargetParams { thread_id: thread.id, target, inherit_account: false }).await.unwrap();
    fixture.orchestrator.mark_account_signed_out(&codex("work"), true).unwrap();
    let state = fixture.orchestrator.thread_target(thread.id).unwrap();
    assert!(state.account_unavailable);
    assert_eq!(state.target.provider, codex("work"));
    assert_eq!(state.suggested_account.as_deref(), Some("spare"));
    let error = fixture
        .orchestrator
        .send_client_message(methods::ThreadsSendParams { thread_id: thread.id, message: UserMessage::text("hi"), message_id: None })
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("Work is signed out on this machine") && error.contains("Use Spare here"), "{error}");
    assert_eq!(fixture.orchestrator.thread_target(thread.id).unwrap().target.provider, codex("work"), "never switched by itself");
    assert_eq!(count(&fixture, thread.id, |p| matches!(p, EventPayload::AccountSwitched { .. })), 0);

    // An account not set up on this machine at all reads the same way.
    fixture.store.meta_set(&format!("account_override:{}", thread.id), "elsewhere").unwrap();
    let state = fixture.orchestrator.thread_target(thread.id).unwrap();
    assert!(state.account_unavailable && state.target.provider.instance == "elsewhere");
    fixture.store.meta_set(&format!("account_override:{}", thread.id), "work").unwrap();

    // The person's tap ("Use Spare here") is recorded.
    let mut target = state.target;
    target.provider = codex("spare");
    fixture.orchestrator.set_thread_target(methods::ThreadTargetParams { thread_id: thread.id, target, inherit_account: false }).await.unwrap();
    let event = wait_for_event(&fixture, thread.id, |p| matches!(p, EventPayload::AccountSwitched { .. })).await;
    assert!(matches!(
        event.payload,
        EventPayload::AccountSwitched { ref from, ref to, reason: AccountSwitchReason::Unavailable, .. } if *from == codex("work") && *to == codex("spare")
    ));
    assert!(!fixture.orchestrator.thread_target(thread.id).unwrap().account_unavailable);
}

#[cfg(unix)]
#[tokio::test]
async fn accounts_sharing_codex_history_resume_the_same_native_session() {
    let fixture = Fixture::new();
    let mut thread = codex_accounts(&fixture);
    assert_eq!(thread.provider_session_id.as_deref(), Some("provider-session"));
    // Preparing the accounts links their conversation folders to the terminal login's.
    let receiving = codex("work");
    assert!(fixture.orchestrator.shares_history(&thread, &receiving));
    assert!(std::fs::symlink_metadata(fixture.root.join("accounts/work/sessions")).unwrap().file_type().is_symlink());
    let mut target = fixture.orchestrator.thread_target(thread.id).unwrap().target;
    target.provider = receiving.clone();
    fixture.orchestrator.set_thread_target(methods::ThreadTargetParams { thread_id: thread.id, target: target.clone(), inherit_account: false }).await.unwrap();
    assert_eq!(fixture.orchestrator.thread_target(thread.id).unwrap().native_session_id.as_deref(), Some("provider-session"));
    fixture.orchestrator.admit_target(&mut thread, target).unwrap();
    assert_eq!(thread.provider, receiving);
    assert_eq!(thread.provider_session_id.as_deref(), Some("provider-session"), "the same native session resumes");
    let (after, through): (EventSeq, EventSeq) =
        serde_json::from_str(&fixture.store.meta_get(&format!("handoff:{}", thread.id)).unwrap().unwrap()).unwrap();
    assert_eq!(after, through, "nothing to hand over: the account reads the same conversation");
    let transition = fixture.store.events_for_thread(thread.id).unwrap().into_iter().rev().find_map(|event| match event.payload {
        EventPayload::SessionTransitioned { native_resume, .. } => Some(native_resume),
        _ => None,
    });
    assert_eq!(transition, Some(true));
    // The named account opens the terminal login's databases.
    let env = fixture.orchestrator.account_environment(&thread).unwrap();
    assert_eq!(std::path::Path::new(&env["CODEX_SQLITE_HOME"]), fixture.root.join("home/.codex"));
}
