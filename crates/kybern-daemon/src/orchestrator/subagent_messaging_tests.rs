#[tokio::test]
async fn native_child_messages_acknowledge_once_in_the_child_and_keep_root_input_isolated() {
    let (fixture, root, live) = subagent_fixture().await;
    let o = &fixture.orchestrator;
    o.handle_driver_event(root.id, &live, DriverEvent::RuntimeTaskStarted(agent_task("native-child", Some("launch-child"), None)))
        .await
        .unwrap();
    let child = child_of(&fixture, root.id, "native-child");
    let root_seq = fixture.store.thread_get(root.id).unwrap().unwrap().last_seq;
    let input =
        methods::QueuedMessage { id: Uuid::now_v7(), thread_id: child.id, message: UserMessage::text("Only the child should read this.") };
    let queued = o.send_subagent_message(input.clone()).await.unwrap();
    assert_eq!(queued.status, SubagentMessageStatus::Pending);
    assert_eq!(queued.session_instance_id, live.session_instance_id);
    assert_eq!(fixture.store.thread_get(root.id).unwrap().unwrap().last_seq, root_seq);
    assert_eq!(o.send_subagent_message(input.clone()).await.unwrap().id, queued.id);
    assert!(
        o.send_subagent_message(methods::QueuedMessage { message: UserMessage::text("Changed input"), ..input.clone() }).await.is_err()
    );
    // Another process or child cannot claim this pending delivery.
    o.acknowledge_subagent_message(root.id, Uuid::now_v7(), "native-child", &queued.id.to_string()).unwrap();
    o.acknowledge_subagent_message(root.id, live.session_instance_id, "other-child", &queued.id.to_string()).unwrap();
    assert_eq!(fixture.store.subagent_message_get(queued.id).unwrap().unwrap().status, SubagentMessageStatus::Pending);
    for _ in 0..2 {
        o.handle_driver_event(
            root.id,
            &live,
            DriverEvent::SubagentMessageDelivered { task_id: "native-child".into(), message_id: queued.id.to_string() },
        )
        .await
        .unwrap();
    }
    assert_eq!(fixture.store.subagent_message_get(queued.id).unwrap().unwrap().status, SubagentMessageStatus::Delivered);
    assert_eq!(fixture.store.events_for_thread(child.id).unwrap().iter().filter(|event| matches!(&event.payload, EventPayload::SubagentMessageUpdated {message} if message.status == SubagentMessageStatus::Delivered)).count(),1);
    assert_eq!(
        fixture
            .store
            .events_for_thread(child.id)
            .unwrap()
            .iter()
            .filter(|event| matches!(&event.payload, EventPayload::MessageSteered {message_id,..} if *message_id == queued.id))
            .count(),
        1
    );
    assert!(
        o.send_subagent_message_to_parent(methods::SubagentMessageActionParams { thread_id: child.id, message_id: queued.id })
            .await
            .is_err()
    );
}

#[tokio::test]
async fn finished_child_keeps_failed_input_and_explicit_parent_forward_is_idempotent() {
    let (fixture, root, live) = subagent_fixture().await;
    let o = &fixture.orchestrator;
    o.handle_driver_event(root.id, &live, DriverEvent::RuntimeTaskStarted(agent_task("child", Some("launch"), None))).await.unwrap();
    let child = child_of(&fixture, root.id, "child");
    let input = methods::QueuedMessage { id: Uuid::now_v7(), thread_id: child.id, message: UserMessage::text("Keep the original input.") };
    o.send_subagent_message(input.clone()).await.unwrap();
    o.handle_driver_event(
        root.id,
        &live,
        DriverEvent::RuntimeTaskCompleted(DriverRuntimeTaskUpdate::status("child", RuntimeTaskStatus::Completed)),
    )
    .await
    .unwrap();
    let failed = o.subagent_messages(child.id).await.unwrap().remove(0);
    assert_eq!(failed.status, SubagentMessageStatus::Failed);
    assert_eq!(failed.error.as_deref(), Some("Not delivered — subagent finished."));
    assert!(fixture.store.queue_list(Some(root.id)).unwrap().is_empty());
    let action = methods::SubagentMessageActionParams { thread_id: child.id, message_id: input.id };
    let forwarded = o.send_subagent_message_to_parent(action.clone()).await.unwrap();
    assert!(forwarded.parent_queued);
    assert_eq!(o.send_subagent_message_to_parent(action).await.unwrap().parent_message_id, forwarded.parent_message_id);
    let parent_queue = fixture.store.queue_list(Some(root.id)).unwrap();
    assert_eq!(parent_queue.len(), 1);
    assert_eq!(parent_queue[0].message, input.message);
    assert!(o.send_subagent_message(methods::QueuedMessage { id: Uuid::now_v7(), ..input }).await.is_err());
}

#[tokio::test]
async fn replacement_session_cannot_receive_the_original_child_inbox() {
    let (fixture, root, live) = subagent_fixture().await;
    let o = &fixture.orchestrator;
    o.handle_driver_event(root.id, &live, DriverEvent::RuntimeTaskStarted(agent_task("child", Some("launch"), None))).await.unwrap();
    let child = child_of(&fixture, root.id, "child");
    let queued = o
        .send_subagent_message(methods::QueuedMessage {
            id: Uuid::now_v7(),
            thread_id: child.id,
            message: UserMessage::text("Original account only."),
        })
        .await
        .unwrap();
    let (replacement, _) = fixture.park(&root, Instant::now()).await;
    replacement.tasks.lock().await.insert("child".into(), live.tasks.lock().await["child"].clone());
    assert!(
        o.send_subagent_message(methods::QueuedMessage {
            id: Uuid::now_v7(),
            thread_id: child.id,
            message: UserMessage::text("Never redirect.")
        })
        .await
        .is_err()
    );
    let before_read = fixture.store.thread_get(child.id).unwrap().unwrap().last_seq;
    assert_eq!(o.subagent_messages(child.id).await.unwrap()[0].status, SubagentMessageStatus::Pending);
    assert_eq!(fixture.store.thread_get(child.id).unwrap().unwrap().last_seq, before_read);
    o.revoke_native_session(&live);
    assert_eq!(o.subagent_messages(child.id).await.unwrap()[0].status, SubagentMessageStatus::Failed);
    o.acknowledge_subagent_message(root.id, replacement.session_instance_id, "child", &queued.id.to_string()).unwrap();
    assert_eq!(fixture.store.subagent_message_get(queued.id).unwrap().unwrap().status, SubagentMessageStatus::Failed);
}

#[tokio::test]
async fn lifecycle_cleanup_settles_pending_beyond_the_ui_window_in_owner_scoped_batches() {
    let (fixture, root, live) = subagent_fixture().await;
    let o = &fixture.orchestrator;
    o.handle_driver_event(root.id, &live, DriverEvent::RuntimeTaskStarted(agent_task("child", Some("launch"), None))).await.unwrap();
    let child = child_of(&fixture, root.id, "child");
    let first = o
        .send_subagent_message(methods::QueuedMessage {
            id: Uuid::now_v7(),
            thread_id: child.id,
            message: UserMessage::text("Accepted before later failed sends."),
        })
        .await
        .unwrap();
    let mut pending_ids = vec![first.id];
    for _ in 0..205 {
        let mut record = first.clone();
        record.id = Uuid::now_v7();
        fixture.store.subagent_message_insert(&record).unwrap();
        pending_ids.push(record.id);
    }
    for _ in 0..101 {
        let mut record = first.clone();
        record.id = Uuid::now_v7();
        record.status = SubagentMessageStatus::Failed;
        record.error = Some("Native inbox was full.".into());
        fixture.store.subagent_message_insert(&record).unwrap();
    }
    assert!(!fixture.store.subagent_messages(child.id).unwrap().iter().any(|record| record.id == first.id));
    let mut another_owner = first.clone();
    another_owner.id = Uuid::now_v7();
    another_owner.session_instance_id = Uuid::now_v7();
    fixture.store.subagent_message_insert(&another_owner).unwrap();
    o.fail_session_subagent_messages(live.session_instance_id).unwrap();
    for id in &pending_ids {
        assert_eq!(fixture.store.subagent_message_get(*id).unwrap().unwrap().status, SubagentMessageStatus::Failed);
    }
    assert_eq!(fixture.store.subagent_message_get(another_owner.id).unwrap().unwrap().status, SubagentMessageStatus::Pending);
    let updates = fixture
        .store
        .events_for_thread(child.id)
        .unwrap()
        .iter()
        .filter(|event| {
            matches!(&event.payload,
        EventPayload::SubagentMessageUpdated { message } if message.status == SubagentMessageStatus::Failed)
        })
        .count();
    assert_eq!(updates, pending_ids.len());
    o.fail_session_subagent_messages(live.session_instance_id).unwrap();
    assert_eq!(
        fixture
            .store
            .events_for_thread(child.id)
            .unwrap()
            .iter()
            .filter(|event| matches!(&event.payload,
        EventPayload::SubagentMessageUpdated { message } if message.status == SubagentMessageStatus::Failed))
            .count(),
        updates
    );
    o.fail_subagent_messages(child.id, "Not delivered — subagent finished.").unwrap();
    assert_eq!(fixture.store.subagent_message_get(another_owner.id).unwrap().unwrap().status, SubagentMessageStatus::Failed);
    assert!(fixture.store.subagent_messages_pending(Some(child.id), None).unwrap().is_empty());
}
