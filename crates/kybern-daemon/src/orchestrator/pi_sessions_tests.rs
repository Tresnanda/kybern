// A Pi thread an extension moved to a new session (`orchestrator::tests`, see `pi_sessions.rs`).

#[tokio::test]
async fn rewinding_to_a_turn_before_a_pi_session_switch_is_refused_before_anything_is_restored() {
    let fixture = Fixture::new();
    let thread = fixture.thread_with_provider(ThreadStatus::Idle, ProviderKind::Pi);
    let (live, _) = fixture.park(&thread, Instant::now()).await;
    let checkpoint = |turn_id: TurnId, minutes: i64| Checkpoint {
        thread_id: thread.id,
        turn_id,
        before: "0000000000000000000000000000000000000000".into(),
        after: None,
        provider_turn_id: Some(format!("entry-{minutes}")),
        provider_turn_end: None,
        created_at: chrono::Utc::now() - chrono::Duration::minutes(10 - minutes),
        repos: vec![],
        incomplete: false,
    };
    let earlier: Vec<TurnId> = (0..2).map(|_| Uuid::now_v7()).collect();
    for (minutes, turn) in earlier.iter().enumerate() {
        fixture.store.checkpoint_upsert(&checkpoint(*turn, minutes as i64)).unwrap();
    }

    // The next turn ends in a session Pi's extension started.
    fixture.orchestrator.send(thread.id, UserMessage::text("start over")).await.unwrap();
    live.turn_ready.notified().await;
    let switched_turn = live.turn.lock().await.as_ref().unwrap().id;
    fixture.store.checkpoint_upsert(&checkpoint(switched_turn, 5)).unwrap();
    let notice = DriverEvent::Notice {
        level: NoticeLevel::Info,
        text: "Pi started a new session. Turns before this one can no longer be rewound.".into(),
        data: Some(serde_json::json!({ kybern_drivers::pi::SESSION_SWITCH_KEY: { "from": "provider-session", "to": "new-session" } })),
    };
    fixture.orchestrator.handle_driver_event(thread.id, &live, notice).await.unwrap();
    fixture.orchestrator.handle_driver_event(thread.id, &live, completed_response(StopReason::Completed)).await.unwrap();
    assert_eq!(crate::pi_sessions::earlier_sessions(&fixture.store, thread.id), ["provider-session"]);

    let error = fixture.orchestrator.revert(thread.id, earlier[1]).await.unwrap_err().to_string();
    assert_eq!(error, "This turn is from an earlier Pi session. Start a new thread from here instead.");
    // Nothing was done: no revert event, and the conversation is not marked rewound.
    assert!(!fixture.store.events_for_thread(thread.id).unwrap().iter().any(|event| matches!(event.payload, EventPayload::WorkspaceReverted { .. })));
    assert!(fixture.orchestrator.inner.pending_rewinds.lock().await.is_empty());
}
