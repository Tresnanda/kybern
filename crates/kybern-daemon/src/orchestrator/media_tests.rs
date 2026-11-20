// Media outside the event log (#298). Included into `orchestrator::tests` for its fixture.

fn pasted_png(size: usize) -> String {
    use base64::Engine;
    let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
    bytes.extend((0..size).map(|i| (i % 251) as u8));
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

#[tokio::test]
async fn a_large_pasted_image_reaches_the_agent_inline_is_stored_as_a_reference_and_a_retry_is_the_same_send() {
    let fixture = Fixture::new();
    let thread = fixture.thread(ThreadStatus::Idle);
    fixture.store.thread_upsert(&thread).unwrap();
    let (_live, _, messages) = fixture.park_recording(&thread, Instant::now()).await;
    let message = UserMessage {
        parts: vec![
            ContentPart::Text { text: "what is wrong here?".into() },
            ContentPart::Image { media_type: "image/png".into(), data: pasted_png(60_000) },
        ],
    };
    let params = || methods::ThreadsSendParams { thread_id: thread.id, message: message.clone(), message_id: None };
    let message_id = Uuid::now_v7();
    let send = |id: Uuid| {
        let mut params = params();
        params.message_id = Some(id);
        fixture.orchestrator.send_client_message(params)
    };
    let first = send(message_id).await.unwrap();
    eventually(|| async { (!messages.lock().await.is_empty()).then_some(()) }).await;
    // The agent got the picture itself.
    assert_eq!(messages.lock().await[0].parts[1], message.parts[1]);
    // The event holds a reference, and the file is in the data folder's assets.
    let stored = fixture
        .store
        .events_for_thread(thread.id)
        .unwrap()
        .into_iter()
        .find_map(|event| match event.payload {
            EventPayload::TurnStarted { message, .. } => Some(message),
            _ => None,
        })
        .unwrap();
    let ContentPart::Media { media } = &stored.parts[1] else { panic!("expected a stored reference, got {:?}", stored.parts[1]) };
    assert!(fixture.store.media_dir().unwrap().file(&media.hash).unwrap().exists());
    // A client that lost the reply sends the same message again: it is the same send, not a conflict.
    let again = send(message_id).await.unwrap();
    assert_eq!(again.turn_id, first.turn_id);
    assert_eq!(messages.lock().await.len(), 1);
}

#[tokio::test]
async fn an_unchanged_command_list_is_stored_once_per_session() {
    let fixture = Fixture::new();
    let thread = fixture.thread(ThreadStatus::Idle);
    fixture.store.thread_upsert(&thread).unwrap();
    let commands = vec![ProviderCommand { name: "review".into(), description: "Review the diff".into(), ..Default::default() }];
    let count = || {
        fixture
            .store
            .events_for_thread(thread.id)
            .unwrap()
            .iter()
            .filter(|event| matches!(event.payload, EventPayload::ProviderCommandsUpdated { .. }))
            .count()
    };
    let (live, _, _) = fixture.park_recording(&thread, Instant::now()).await;
    for _ in 0..3 {
        fixture.orchestrator.handle_driver_event(thread.id, &live, DriverEvent::CommandsUpdated(commands.clone())).await.unwrap();
    }
    assert_eq!(count(), 1);
    let instance = ProviderInstance::default_for(ProviderKind::ClaudeCode);
    let transition = EventPayload::SessionTransitioned { from: instance.clone(), to: instance, native_resume: false, text: "switched".into() };
    fixture.orchestrator.emit(thread.id, None, transition).unwrap();
    fixture.orchestrator.handle_driver_event(thread.id, &live, DriverEvent::CommandsUpdated(commands.clone())).await.unwrap();
    assert_eq!(count(), 2, "the first list after a session transition is written");
}

#[test]
fn a_moved_or_forked_thread_carries_no_media_reference() {
    // Moves and forks carry text (design §7.2): an image is "[image]", never a hash the other machine lacks.
    let media = MediaRef { hash: "a".repeat(64), mime: "image/png".into(), size: 1, encoding: Default::default() };
    let message = UserMessage { parts: vec![ContentPart::Text { text: "see ".into() }, ContentPart::Media { media }] };
    assert_eq!(message.plain_text(), "see [image]");
}

#[tokio::test]
async fn an_attached_document_reaches_the_agent_as_a_readable_file_and_stays_a_chip_in_the_thread() {
    let fixture = Fixture::new();
    let thread = fixture.thread(ThreadStatus::Idle);
    fixture.store.thread_upsert(&thread).unwrap();
    let (_live, _, messages) = fixture.park_recording(&thread, Instant::now()).await;
    // What the desktop's upload leaves on the machine that runs the chat (`POST /assets`).
    let id = Uuid::now_v7();
    let assets = &fixture.orchestrator.inner.paths.assets;
    std::fs::create_dir_all(assets).unwrap();
    std::fs::write(assets.join(id.to_string()), "# Handoff\n").unwrap();
    let info = methods::AssetInfo { id, name: "HANDOFF.md".into(), media_type: "text/markdown".into(), size: 10, created_at: chrono::Utc::now() };
    fixture.store.asset_insert(&info).unwrap();
    let attachment = ContentPart::Attachment { asset_id: id, name: info.name.clone(), media_type: info.media_type.clone(), size: info.size };
    let message = UserMessage { parts: vec![ContentPart::Text { text: "continue from this".into() }, attachment.clone()] };
    fixture
        .orchestrator
        .send_client_message(methods::ThreadsSendParams { thread_id: thread.id, message, message_id: None })
        .await
        .unwrap();
    eventually(|| async { (!messages.lock().await.is_empty()).then_some(()) }).await;
    // The agent gets a path it can open, named with the file's own extension.
    let ContentPart::Text { text } = &messages.lock().await[0].parts[1] else { panic!("expected the file's path") };
    let path = assets.join(format!("{id}.md"));
    assert!(text.contains("HANDOFF.md") && text.contains(&path.display().to_string()), "{text}");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "# Handoff\n");
    // The thread keeps the chip.
    let stored = fixture
        .store
        .events_for_thread(thread.id)
        .unwrap()
        .into_iter()
        .find_map(|event| match event.payload {
            EventPayload::TurnStarted { message, .. } => Some(message),
            _ => None,
        })
        .unwrap();
    assert_eq!(stored.parts[1], attachment);
}
