// Orchestrator V2 messaging and shared-checkout guard tests. Included into
// `orchestrator::tests`, after `delegation_tests.rs`, to reuse its scripted driver,
// `Delegating` harness and `eventually`.

/// Two or more parked threads whose sessions record what they are sent.
struct Party {
    thread: Thread,
    live: Arc<LiveSession>,
    messages: Arc<Mutex<Vec<UserMessage>>>,
}

struct Chat {
    fixture: Fixture,
}

impl Chat {
    fn new() -> Self {
        let spawned = Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut drivers = DriverRegistry::default();
        for kind in [ProviderKind::ClaudeCode, ProviderKind::Codex, ProviderKind::Opencode, ProviderKind::Pi] {
            drivers.register(Arc::new(ScriptedDriver { kind, spawned: spawned.clone() }));
        }
        let fixture = Fixture::with_drivers(drivers);
        std::fs::create_dir_all(&fixture.root).unwrap();
        Self { fixture }
    }

    /// A thread with a parked recording session; `running` starts a turn so it can use tools and be steered.
    async fn party(&self, title: &str, kind: ProviderKind, mode: PermissionMode, running: bool) -> Party {
        let mut thread = self.fixture.thread_with_provider(ThreadStatus::Idle, kind);
        thread.title = title.into();
        thread.permission_mode = mode;
        self.fixture.store.thread_upsert(&thread).unwrap();
        let (live, _, messages) = self.fixture.park_recording(&thread, Instant::now()).await;
        if running {
            self.fixture.orchestrator.send(thread.id, UserMessage::text("working")).await.unwrap();
            live.turn_ready.notified().await;
        }
        Party { thread, live, messages }
    }

    async fn send(&self, from: &Party, args: serde_json::Value) -> serde_json::Value {
        self.try_send(from, args).await.unwrap()
    }

    async fn try_send(&self, from: &Party, args: serde_json::Value) -> anyhow::Result<serde_json::Value> {
        self.fixture.tool(&from.thread, &from.live, &Uuid::now_v7().to_string(), "kybern_thread_send", args).await
    }

    fn record(&self, result: &serde_json::Value) -> ThreadMessageRecord {
        self.fixture.store.thread_message_get(Uuid::parse_str(result["message_id"].as_str().unwrap()).unwrap()).unwrap().unwrap()
    }

    fn queued_for(&self, thread: &Thread) -> Vec<methods::QueuedMessage> {
        self.fixture.store.queue_list(Some(thread.id)).unwrap()
    }

    fn events(&self, thread: &Thread) -> Vec<EventPayload> {
        self.fixture.store.events_for_thread(thread.id).unwrap().into_iter().map(|event| event.payload).collect()
    }

    /// Start the turns queued for idle threads.
    async fn drain(&self) {
        self.fixture.orchestrator.drain_queues().await.unwrap();
    }

    async fn end_turn(&self, party: &Party) {
        self.fixture
            .orchestrator
            .process_driver_event(party.thread.id, &party.live, completed_response(StopReason::Completed), false)
            .await
            .unwrap();
        assert_eq!(self.fixture.store.thread_get(party.thread.id).unwrap().unwrap().status, ThreadStatus::Idle);
    }

    async fn say(&self, party: &Party, text: &str) {
        self.fixture
            .orchestrator
            .process_driver_event(
                party.thread.id,
                &party.live,
                DriverEvent::MessageCompleted {
                    message_id: Uuid::now_v7().to_string(),
                    origin: EventOrigin::Root,
                    text: text.into(),
                    thinking: None,
                },
                false,
            )
            .await
            .unwrap();
    }

    fn state(&self, id: MessageId) -> ThreadMessageState {
        self.fixture.store.thread_message_get(id).unwrap().unwrap().state
    }
}

async fn recorded(party: &Party, needle: &str) -> bool {
    serde_json::to_string(&*party.messages.lock().await).unwrap().contains(needle)
}

fn thread_message_parts(queued: &[methods::QueuedMessage]) -> Vec<(MessageId, ThreadMessagePurpose, Option<ThreadId>, String)> {
    queued
        .iter()
        .filter_map(|item| match item.message.parts.as_slice() {
            [ContentPart::ThreadMessage { message_id, purpose, from_thread_id, body, .. }] => {
                Some((*message_id, *purpose, *from_thread_id, body.clone()))
            }
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn a_queued_message_waits_for_an_idle_recipient_and_is_delivered_when_its_turn_starts() {
    let chat = Chat::new();
    let a = chat.party("Alpha", ProviderKind::ClaudeCode, PermissionMode::Supervised, true).await;
    let b = chat.party("Beta", ProviderKind::ClaudeCode, PermissionMode::Supervised, false).await;

    let result = chat.send(&a, json!({"thread_id": b.thread.id, "body": "hello beta"})).await;
    assert_eq!((result["delivered_as"].as_str(), result["state"].as_str()), (Some("queued"), Some("queued")));
    assert_eq!((result["thread_id"].as_str().unwrap(), result["title"].as_str().unwrap()), (b.thread.id.to_string().as_str(), "Beta"));
    let record = chat.record(&result);
    assert_eq!(
        (record.from_thread_id, record.to_thread_id, record.purpose, record.delivery),
        (Some(a.thread.id), b.thread.id, ThreadMessagePurpose::Message, ThreadMessageDelivery::Queue)
    );

    // The queued message carries the thread_messages id and a ThreadMessage part from Alpha.
    let queued = chat.queued_for(&b.thread);
    assert_eq!(queued.len(), 1);
    assert_eq!(queued[0].id, record.id);
    let [ContentPart::ThreadMessage { message_id, from_thread_id, from_title, purpose, body, .. }] = queued[0].message.parts.as_slice() else {
        panic!("queued part: {:?}", queued[0].message.parts)
    };
    assert_eq!((*message_id, *from_thread_id, from_title.as_str(), *purpose, body.as_str()), (record.id, Some(a.thread.id), "Alpha", ThreadMessagePurpose::Message, "hello beta"));
    assert!(chat.queued_for(&a.thread).is_empty());

    chat.drain().await;
    eventually(|| async { (chat.state(record.id) == ThreadMessageState::Delivered).then_some(()) }).await;
    eventually(|| async { recorded(&b, "hello beta").await.then_some(()) }).await;
    let started = chat.events(&b.thread).into_iter().find_map(|event| match event {
        EventPayload::TurnStarted { message_id, .. } if message_id == record.id => Some(()),
        _ => None,
    });
    assert!(started.is_some(), "the turn started with the thread message id");
}

#[tokio::test]
async fn steer_goes_into_a_running_turn_and_falls_back_to_the_queue_when_it_cannot() {
    let chat = Chat::new();
    let a = chat.party("Alpha", ProviderKind::ClaudeCode, PermissionMode::Supervised, true).await;
    let steerable = chat.party("Steerable", ProviderKind::ClaudeCode, PermissionMode::Supervised, true).await;

    let result = chat.send(&a, json!({"thread_id": steerable.thread.id, "body": "change course", "delivery": "steer"})).await;
    assert_eq!((result["delivered_as"].as_str(), result["state"].as_str()), (Some("steered"), Some("steered")));
    let record = chat.record(&result);
    assert_eq!(record.state, ThreadMessageState::Steered);
    assert!(chat.queued_for(&steerable.thread).is_empty(), "a steered message is not queued as well");
    let sent = steerable
        .messages
        .lock()
        .await
        .iter()
        .find_map(|message| match message.parts.as_slice() {
            [ContentPart::ThreadMessage { message_id, body, .. }] => Some((*message_id, body.clone())),
            _ => None,
        })
        .expect("the running turn was steered with a thread message");
    assert_eq!(sent, (record.id, "change course".to_string()));
    assert!(chat.events(&steerable.thread).iter().any(|event| matches!(event, EventPayload::MessageSteered { message_id, .. } if *message_id == record.id)));

    // The default is the queue, even for a running recipient.
    let queued = chat.send(&a, json!({"thread_id": steerable.thread.id, "body": "later"})).await;
    assert_eq!(queued["delivered_as"], "queued");
    assert_eq!(chat.queued_for(&steerable.thread).len(), 1);

    // OpenCode cannot take a message mid-turn: a steer request queues instead.
    let opencode = chat.party("OpenCode", ProviderKind::Opencode, PermissionMode::Supervised, true).await;
    let fallback = chat.send(&a, json!({"thread_id": opencode.thread.id, "body": "please steer", "delivery": "steer"})).await;
    assert_eq!((fallback["delivered_as"].as_str(), fallback["state"].as_str()), (Some("queued"), Some("queued")));
    assert_eq!(chat.record(&fallback).delivery, ThreadMessageDelivery::Steer, "the requested delivery is kept on the record");
    assert_eq!(thread_message_parts(&chat.queued_for(&opencode.thread)).len(), 1);
    assert!(!recorded(&opencode, "please steer").await);

    // An idle recipient has no turn to steer.
    let idle = chat.party("Idle", ProviderKind::ClaudeCode, PermissionMode::Supervised, false).await;
    let idle_result = chat.send(&a, json!({"thread_id": idle.thread.id, "body": "wake up", "delivery": "steer"})).await;
    assert_eq!(idle_result["delivered_as"], "queued");
}

#[tokio::test]
async fn a_message_to_a_more_permissive_thread_is_held_until_the_user_delivers_or_dismisses_it() {
    let chat = Chat::new();
    let a = chat.party("Alpha", ProviderKind::ClaudeCode, PermissionMode::Supervised, true).await;
    let b = chat.party("Beta", ProviderKind::ClaudeCode, PermissionMode::FullAccess, true).await;

    let held = chat.send(&a, json!({"thread_id": b.thread.id, "body": "run the migration", "purpose": "question"})).await;
    assert_eq!((held["delivered_as"].as_str(), held["state"].as_str()), (Some("held"), Some("held")));
    assert!(held["note"].as_str().unwrap().contains("user must approve"), "{held}");
    let record = chat.record(&held);
    assert_eq!(record.state, ThreadMessageState::Held);
    assert!(record.held_reason.as_deref().unwrap().contains("permission"));
    assert!(chat.queued_for(&b.thread).is_empty() && !recorded(&b, "run the migration").await);
    let event = chat.events(&b.thread).into_iter().find_map(|event| match event {
        EventPayload::ThreadMessageHeld { message } => Some(message),
        _ => None,
    });
    assert_eq!(event.map(|message| (message.id, message.state)), Some((record.id, ThreadMessageState::Held)), "the held card lands on the recipient");
    let listed = chat.fixture.store.thread_message_list_for_thread(b.thread.id, Some(&[ThreadMessageState::Held]), 200).unwrap();
    assert_eq!(listed.len(), 1);

    // Deliver: it goes out with the requested delivery and is idempotent.
    let delivered = chat.fixture.orchestrator.thread_message_deliver(record.id).await.unwrap();
    assert_eq!(delivered.state, ThreadMessageState::Queued);
    assert_eq!(thread_message_parts(&chat.queued_for(&b.thread)).len(), 1);
    let again = chat.fixture.orchestrator.thread_message_deliver(record.id).await.unwrap();
    assert_eq!(again.state, ThreadMessageState::Queued);
    assert_eq!(chat.queued_for(&b.thread).len(), 1, "a second click does not queue it twice");
    let resolutions: Vec<_> = chat
        .events(&b.thread)
        .into_iter()
        .filter_map(|event| match event {
            EventPayload::ThreadMessageResolved { message_id, resolution } if message_id == record.id => Some(resolution),
            _ => None,
        })
        .collect();
    assert_eq!(resolutions, vec![HeldResolution::Delivered]);
    assert!(chat.fixture.orchestrator.thread_message_dismiss(record.id).await.unwrap_err().to_string().contains("already delivered"));

    // A held steer message goes into the running turn once approved.
    let steer = chat.send(&a, json!({"thread_id": b.thread.id, "body": "stop now", "delivery": "steer"})).await;
    assert_eq!(steer["delivered_as"], "held");
    let steer_id = chat.record(&steer).id;
    let delivered = chat.fixture.orchestrator.thread_message_deliver(steer_id).await.unwrap();
    assert_eq!(delivered.state, ThreadMessageState::Steered);
    assert!(recorded(&b, "stop now").await);

    // Dismiss: nothing reaches the recipient, and the choice sticks.
    let third = chat.send(&a, json!({"thread_id": b.thread.id, "body": "never mind"})).await;
    let third_id = chat.record(&third).id;
    let dismissed = chat.fixture.orchestrator.thread_message_dismiss(third_id).await.unwrap();
    assert_eq!(dismissed.state, ThreadMessageState::Dismissed);
    assert_eq!(chat.fixture.orchestrator.thread_message_dismiss(third_id).await.unwrap().state, ThreadMessageState::Dismissed);
    assert!(chat.fixture.orchestrator.thread_message_deliver(third_id).await.unwrap_err().to_string().contains("dismissed"));
    assert!(!recorded(&b, "never mind").await && thread_message_parts(&chat.queued_for(&b.thread)).len() == 1);
    assert!(chat.events(&b.thread).iter().any(|event| matches!(event, EventPayload::ThreadMessageResolved { message_id, resolution: HeldResolution::Dismissed } if *message_id == third_id)));
    assert!(chat.fixture.orchestrator.thread_message_deliver(Uuid::now_v7()).await.is_err(), "an unknown message is an error");
}

#[tokio::test]
async fn permissions_that_fit_are_not_held_and_an_isolated_worker_may_message_a_checkout_thread() {
    let chat = Chat::new();
    // Full access may message anyone; a supervised recipient is always safe; equal modes on one harness match.
    let full = chat.party("Full", ProviderKind::ClaudeCode, PermissionMode::FullAccess, true).await;
    let accept = chat.party("Accept", ProviderKind::Codex, PermissionMode::AcceptEdits, false).await;
    let supervised = chat.party("Supervised", ProviderKind::ClaudeCode, PermissionMode::Supervised, true).await;
    assert_eq!(chat.send(&full, json!({"thread_id": accept.thread.id, "body": "one"})).await["delivered_as"], "queued");
    assert_eq!(chat.send(&accept_sender(&chat).await, json!({"thread_id": supervised.thread.id, "body": "two"})).await["delivered_as"], "queued");

    // Worktree -> main checkout used to be refused. It is allowed now.
    let mut worker = chat.party("Worker", ProviderKind::ClaudeCode, PermissionMode::Supervised, true).await;
    worker.thread.worktree = Some(WorktreeInfo { path: chat.fixture.root.join("wt").to_string_lossy().into_owned(), branch: "kybern/worker".into() });
    chat.fixture.store.thread_upsert(&worker.thread).unwrap();
    let main_checkout = chat.party("Main", ProviderKind::ClaudeCode, PermissionMode::Supervised, false).await;
    assert!(main_checkout.thread.worktree.is_none());
    let result = chat.send(&worker, json!({"thread_id": main_checkout.thread.id, "body": "result is ready"})).await;
    assert_eq!(result["delivered_as"], "queued");
    assert_eq!(thread_message_parts(&chat.queued_for(&main_checkout.thread)).len(), 1);
}

async fn accept_sender(chat: &Chat) -> Party {
    chat.party("Accept sender", ProviderKind::ClaudeCode, PermissionMode::AcceptEdits, true).await
}

#[tokio::test]
async fn an_explicit_reply_answers_the_question_and_wakes_the_asker_once() {
    let chat = Chat::new();
    let a = chat.party("Asker", ProviderKind::ClaudeCode, PermissionMode::Supervised, true).await;
    let b = chat.party("Answerer", ProviderKind::ClaudeCode, PermissionMode::Supervised, false).await;

    let asked = chat.send(&a, json!({"thread_id": b.thread.id, "body": "Which port?", "purpose": "question"})).await;
    assert!(asked["note"].as_str().unwrap().contains("reply wakes you"));
    let question = chat.record(&asked);
    chat.drain().await;
    eventually(|| async { (chat.state(question.id) == ThreadMessageState::Delivered).then_some(()) }).await;
    // The flattened text tells the recipient how to answer.
    let text = ContentPart::ThreadMessage {
        message_id: question.id,
        from_thread_id: Some(a.thread.id),
        from_title: "Asker".into(),
        purpose: ThreadMessagePurpose::Question,
        reply_to: None,
        body: question.body.clone(),
    }
    .orchestration_text()
    .unwrap();
    assert!(text.contains("purpose \"reply\"") && text.contains(&question.id.to_string()));

    // Wrong replier, wrong target and a non-question are refused with a next step.
    let stranger = chat.party("Stranger", ProviderKind::ClaudeCode, PermissionMode::Supervised, true).await;
    let error = chat.try_send(&stranger, json!({"thread_id": a.thread.id, "body": "x", "purpose": "reply", "reply_to": question.id})).await.unwrap_err();
    assert!(error.to_string().contains("must be a question that thread asked you"), "{error}");
    let error = chat.try_send(&b, json!({"thread_id": a.thread.id, "body": "x", "purpose": "reply"})).await.unwrap_err();
    assert!(error.to_string().contains("reply_to"), "{error}");
    let error = chat.try_send(&b, json!({"thread_id": a.thread.id, "body": "x", "reply_to": question.id})).await.unwrap_err();
    assert!(error.to_string().contains("only for purpose"), "{error}");

    let replied = chat.send(&b, json!({"thread_id": a.thread.id, "body": "Port 4199", "purpose": "reply", "reply_to": question.id})).await;
    assert_eq!(replied["delivered_as"], "queued");
    assert_eq!(chat.state(question.id), ThreadMessageState::Answered);
    let reply = chat.record(&replied);
    assert_eq!((reply.purpose, reply.reply_to, reply.from_thread_id, reply.to_thread_id), (ThreadMessagePurpose::Reply, Some(question.id), Some(b.thread.id), a.thread.id));
    let waiting = thread_message_parts(&chat.queued_for(&a.thread));
    assert_eq!(waiting.len(), 1);
    assert_eq!((waiting[0].0, waiting[0].1, waiting[0].3.as_str()), (reply.id, ThreadMessagePurpose::Reply, "Port 4199"));
    let error = chat.try_send(&b, json!({"thread_id": a.thread.id, "body": "again", "purpose": "reply", "reply_to": question.id})).await.unwrap_err();
    assert!(error.to_string().contains("already has a reply"), "{error}");

    // The answerer's turn ends: no second, automatic reply.
    chat.say(&b, "I replied already").await;
    chat.end_turn(&b).await;
    tokio::time::sleep(Duration::from_millis(150)).await;
    let replies = chat.fixture.store.thread_message_list_for_thread(a.thread.id, None, 200).unwrap().into_iter().filter(|m| m.purpose == ThreadMessagePurpose::Reply).count();
    assert_eq!(replies, 1);
}

#[tokio::test]
async fn wait_for_reply_returns_the_reply_inline_without_queuing_a_turn() {
    let chat = Chat::new();
    let a = chat.party("Asker", ProviderKind::ClaudeCode, PermissionMode::Supervised, true).await;
    let b = chat.party("Answerer", ProviderKind::ClaudeCode, PermissionMode::Supervised, true).await;
    let orchestrator = chat.fixture.orchestrator.clone();
    let (asker, live, target) = (a.thread.clone(), a.live.clone(), b.thread.id);
    let waiting = tokio::spawn(async move {
        orchestrator
            .execute_native_app_tool_call(
                asker.id,
                live.session_instance_id,
                "ask",
                "kybern_thread_send",
                json!({"thread_id": target, "body": "What is the port?", "purpose": "question", "wait_for_reply": true}),
            )
            .await
    });
    let question = eventually(|| async {
        chat.fixture
            .store
            .thread_message_list_for_thread(a.thread.id, None, 200)
            .unwrap()
            .into_iter()
            .find(|message| message.purpose == ThreadMessagePurpose::Question)
    })
    .await;
    assert!(!waiting.is_finished(), "the asker is blocked until the reply comes");

    let replied = chat.send(&b, json!({"thread_id": a.thread.id, "body": "4199", "purpose": "reply", "reply_to": question.id})).await;
    let result = waiting.await.unwrap().unwrap();
    assert_eq!(result["reply"]["body"], "4199");
    assert_eq!(result["reply"]["from_thread_id"], json!(b.thread.id));
    assert_eq!(result["reply"]["message_id"], replied["message_id"]);
    assert_eq!(result["state"], "answered");
    assert!(result.get("wait_timed_out").is_none());

    // Recorded, but never queued or steered into the asker as a new turn.
    let reply = chat.record(&replied);
    assert_eq!(reply.state, ThreadMessageState::Delivered);
    assert_eq!(chat.state(question.id), ThreadMessageState::Answered);
    assert!(chat.queued_for(&a.thread).is_empty());
    assert!(!recorded(&a, "4199").await, "the asker is not steered with the reply either");
    assert!(chat.events(&a.thread).iter().all(|event| !matches!(event, EventPayload::MessageSteered { message_id, .. } if *message_id == reply.id)));
}

#[tokio::test]
async fn wait_for_reply_times_out_and_the_late_reply_arrives_as_a_message() {
    let chat = Chat::new();
    let a = chat.party("Asker", ProviderKind::ClaudeCode, PermissionMode::Supervised, true).await;
    let b = chat.party("Answerer", ProviderKind::ClaudeCode, PermissionMode::Supervised, true).await;
    let started = Instant::now();
    let result = chat.send(&a, json!({"thread_id": b.thread.id, "body": "Anyone?", "purpose": "question", "wait_for_reply": true, "timeout_ms": 60})).await;
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_eq!(result["wait_timed_out"], true);
    assert!(result.get("reply").is_none());
    assert_eq!(result["state"], "queued");
    let question = chat.record(&result);

    // Too late for the call: the reply is an ordinary message that wakes the asker.
    chat.send(&b, json!({"thread_id": a.thread.id, "body": "sorry, late", "purpose": "reply", "reply_to": question.id})).await;
    let queued = thread_message_parts(&chat.queued_for(&a.thread));
    assert_eq!(queued.len(), 1);
    assert_eq!(queued[0].3, "sorry, late");

    // wait_for_reply belongs to questions only, and held questions are not waited on.
    let error = chat.try_send(&a, json!({"thread_id": b.thread.id, "body": "x", "wait_for_reply": true})).await.unwrap_err();
    assert!(error.to_string().contains("only applies to purpose"), "{error}");
    let strict = chat.party("Full", ProviderKind::ClaudeCode, PermissionMode::FullAccess, true).await;
    let held = chat.send(&a, json!({"thread_id": strict.thread.id, "body": "may I?", "purpose": "question", "wait_for_reply": true, "timeout_ms": 30_000})).await;
    assert_eq!(held["delivered_as"], "held");
}

#[tokio::test]
async fn a_question_nobody_answers_gets_the_recipients_final_text_as_an_automatic_reply() {
    let chat = Chat::new();
    let a = chat.party("Asker", ProviderKind::ClaudeCode, PermissionMode::Supervised, true).await;
    let b = chat.party("Answerer", ProviderKind::ClaudeCode, PermissionMode::Supervised, false).await;
    let asked = chat.send(&a, json!({"thread_id": b.thread.id, "body": "Is the build green?", "purpose": "question"})).await;
    let question = chat.record(&asked);
    chat.drain().await;
    eventually(|| async { (chat.state(question.id) == ThreadMessageState::Delivered).then_some(()) }).await;

    chat.say(&b, "Yes, the build is green.").await;
    chat.end_turn(&b).await;
    let reply = eventually(|| async {
        chat.fixture
            .store
            .thread_message_list_for_thread(a.thread.id, None, 200)
            .unwrap()
            .into_iter()
            .find(|message| message.purpose == ThreadMessagePurpose::Reply)
    })
    .await;
    assert_eq!((reply.from_thread_id, reply.to_thread_id, reply.reply_to), (Some(b.thread.id), a.thread.id, Some(question.id)));
    assert_eq!(reply.body, "Yes, the build is green.");
    assert_eq!(chat.state(question.id), ThreadMessageState::Answered);
    assert_eq!(thread_message_parts(&chat.queued_for(&a.thread)).len(), 1, "the asker is woken by the reply");

    // A steered question is answered by the turn it was steered into.
    let b2 = chat.party("Steered", ProviderKind::ClaudeCode, PermissionMode::Supervised, true).await;
    let steered = chat.send(&a, json!({"thread_id": b2.thread.id, "body": "Quick check?", "purpose": "question", "delivery": "steer"})).await;
    assert_eq!(steered["delivered_as"], "steered");
    chat.say(&b2, "All good.").await;
    chat.end_turn(&b2).await;
    let steered_id = chat.record(&steered).id;
    eventually(|| async { (chat.state(steered_id) == ThreadMessageState::Answered).then_some(()) }).await;
}

#[tokio::test]
async fn a_failed_turn_still_answers_the_question_it_consumed() {
    let chat = Chat::new();
    let a = chat.party("Asker", ProviderKind::ClaudeCode, PermissionMode::Supervised, true).await;
    let b = chat.party("Answerer", ProviderKind::ClaudeCode, PermissionMode::Supervised, true).await;
    let asked = chat.send(&a, json!({"thread_id": b.thread.id, "body": "Status?", "purpose": "question", "delivery": "steer"})).await;
    let question = chat.record(&asked);
    chat.fixture
        .orchestrator
        .process_driver_event(b.thread.id, &b.live, completed_response(StopReason::Interrupted), false)
        .await
        .unwrap();
    let reply = eventually(|| async {
        chat.fixture
            .store
            .thread_message_list_for_thread(a.thread.id, None, 200)
            .unwrap()
            .into_iter()
            .find(|message| message.purpose == ThreadMessagePurpose::Reply)
    })
    .await;
    assert!(reply.body.contains("ended before it answered"), "{}", reply.body);
    assert_eq!(chat.state(question.id), ThreadMessageState::Answered);
}

#[tokio::test]
async fn a_pair_can_exchange_sixteen_messages_until_a_person_speaks() {
    let chat = Chat::new();
    let a = chat.party("Alpha", ProviderKind::ClaudeCode, PermissionMode::Supervised, true).await;
    let b = chat.party("Beta", ProviderKind::ClaudeCode, PermissionMode::Supervised, false).await;
    for index in 0..16 {
        chat.send(&a, json!({"thread_id": b.thread.id, "body": format!("note {index}")})).await;
    }
    let error = chat.try_send(&a, json!({"thread_id": b.thread.id, "body": "one more"})).await.unwrap_err().to_string();
    assert!(error.contains("16 messages") && error.contains("report to the user"), "{error}");
    // Another recipient is a different pair.
    let c = chat.party("Gamma", ProviderKind::ClaudeCode, PermissionMode::Supervised, false).await;
    chat.send(&a, json!({"thread_id": c.thread.id, "body": "hi gamma"})).await;
    // The limit is per pair, so Beta cannot push past it either.
    let b_running = chat.party("Beta 2", ProviderKind::ClaudeCode, PermissionMode::Supervised, true).await;
    for index in 0..16 {
        chat.send(&b_running, json!({"thread_id": a.thread.id, "body": format!("ping {index}")})).await;
    }
    assert!(chat.try_send(&a, json!({"thread_id": b_running.thread.id, "body": "pong"})).await.is_err(), "both directions count");

    // A person writing in the recipient starts a new budget.
    tokio::time::sleep(Duration::from_millis(5)).await;
    chat.fixture.orchestrator.send(b.thread.id, UserMessage::text("back to work")).await.unwrap();
    b.live.turn_ready.notified().await;
    chat.send(&a, json!({"thread_id": b.thread.id, "body": "after the reset"})).await;
}

#[tokio::test]
async fn recipients_must_exist_be_open_and_not_the_caller() {
    let chat = Chat::new();
    let a = chat.party("Alpha", ProviderKind::ClaudeCode, PermissionMode::Supervised, true).await;
    let missing = chat.try_send(&a, json!({"thread_id": Uuid::now_v7(), "body": "x"})).await.unwrap_err();
    assert!(missing.to_string().contains("kybern_threads_search"), "{missing}");
    let own = chat.try_send(&a, json!({"thread_id": a.thread.id, "body": "x"})).await.unwrap_err();
    assert!(own.to_string().contains("own thread"), "{own}");
    let empty = chat.try_send(&a, json!({"thread_id": a.thread.id, "body": "  "})).await.unwrap_err();
    assert!(empty.to_string().contains("body is required"), "{empty}");
    let huge = chat.try_send(&a, json!({"thread_id": Uuid::now_v7(), "body": "x".repeat(40 * 1024)})).await.unwrap_err();
    assert!(huge.to_string().contains("too long"), "{huge}");

    let mut archived = chat.party("Archived", ProviderKind::ClaudeCode, PermissionMode::Supervised, false).await;
    archived.thread.status = ThreadStatus::Archived;
    chat.fixture.store.thread_upsert(&archived.thread).unwrap();
    let error = chat.try_send(&a, json!({"thread_id": archived.thread.id, "body": "x"})).await.unwrap_err();
    assert!(error.to_string().contains("archived"), "{error}");

    let mut native = chat.party("Native subagent", ProviderKind::ClaudeCode, PermissionMode::Supervised, false).await;
    native.thread.subagent = Some(
        serde_json::from_value(json!({
            "task_id": "task", "root_thread_id": a.thread.id, "parent_turn_id": Uuid::now_v7(),
            "status": "running", "started_at": chrono::Utc::now(),
        }))
        .unwrap(),
    );
    chat.fixture.store.thread_upsert(&native.thread).unwrap();
    let error = chat.try_send(&a, json!({"thread_id": native.thread.id, "body": "x"})).await.unwrap_err();
    assert!(error.to_string().contains("read-only"), "{error}");

    // A retry with the same key is the same message.
    let b = chat.party("Beta", ProviderKind::ClaudeCode, PermissionMode::Supervised, false).await;
    let first = chat.send(&a, json!({"thread_id": b.thread.id, "body": "once", "request_key": "k1"})).await;
    let retry = chat.send(&a, json!({"thread_id": b.thread.id, "body": "once", "request_key": "k1"})).await;
    assert_eq!(first["message_id"], retry["message_id"]);
    assert_eq!(chat.queued_for(&b.thread).len(), 1);
}

#[tokio::test]
async fn a_parent_messaging_a_finished_child_reopens_it_and_the_next_completion_notifies_again() {
    let t = Delegating::new().await;
    let started = t.delegate(json!({"task": "Investigate the flaky test"})).await;
    let agent = t.agent("Investigate the flaky test").await;
    agent.finish("first findings").await;
    let child = t.delegation(&started["task_id"]);
    eventually(|| async {
        let info = t.fixture.store.thread_get(child.id).unwrap().unwrap().delegation.unwrap();
        (info.status == DelegationStatus::Completed).then_some(())
    })
    .await;
    // The parent's first notification arrives (steered into its running turn).
    eventually(|| async {
        t.parent_messages.lock().await.iter().any(|m| matches!(m.parts.as_slice(), [ContentPart::AgentResults { .. }])).then_some(())
    })
    .await;

    // A follow-up question to the finished child reopens its delegation.
    let sent = t.tool("kybern_thread_send", json!({"thread_id": child.id, "body": "Which seed fails?", "purpose": "question"})).await.unwrap();
    assert_eq!(sent["delivered_as"], "queued");
    let info = t.fixture.store.thread_get(child.id).unwrap().unwrap().delegation.unwrap();
    assert_eq!(info.status, DelegationStatus::Running);
    assert!(info.result.is_none() && info.error.is_none() && info.completed_at.is_none());
    let question = Uuid::parse_str(sent["message_id"].as_str().unwrap()).unwrap();

    t.fixture.orchestrator.drain_queues().await.unwrap();
    eventually(|| async { agent.transcript().await.contains("Which seed fails?").then_some(()) }).await;
    agent.finish("seed 42 fails").await;

    // The parent hears about it again, through the batched results.
    let second = eventually(|| async {
        t.parent_messages.lock().await.iter().find_map(|m| match m.parts.as_slice() {
            [ContentPart::AgentResults { items }] if items.iter().any(|item| item.result.as_deref() == Some("seed 42 fails")) => Some(items.clone()),
            _ => None,
        })
    })
    .await;
    assert_eq!(second[0].status, DelegationStatus::Completed);
    // The question counts as answered without a duplicate reply message.
    eventually(|| async { (t.fixture.store.thread_message_get(question).unwrap().unwrap().state == ThreadMessageState::Answered).then_some(()) }).await;
    let replies = t.fixture.store.thread_message_list_for_thread(child.id, None, 200).unwrap().into_iter().filter(|m| m.purpose == ThreadMessagePurpose::Reply).count();
    assert_eq!(replies, 0, "the batched result already carries the answer");
    let info = t.fixture.store.thread_get(child.id).unwrap().unwrap().delegation.unwrap();
    assert_eq!(info.status, DelegationStatus::Completed);
    assert_eq!(info.result.as_deref(), Some("seed 42 fails"));
}

fn edit_call(id: &str, path: &str) -> DriverEvent {
    DriverEvent::ToolStarted(ToolCall { id: id.into(), name: "Edit".into(), input: json!({"file_path": path}), parent_id: None })
}

#[tokio::test]
async fn editing_a_siblings_owned_path_records_one_conflict_and_sends_one_warning() {
    let t = Delegating::new().await;
    let api = t.delegate(json!({"task": "Build the api layer", "owns": ["src/api/**"], "title": "API"})).await;
    let ui = t.delegate(json!({"task": "Build the ui layer", "owns": ["src/ui/**"], "title": "UI"})).await;
    let (api_thread, ui_thread) = (t.delegation(&api["task_id"]), t.delegation(&ui["task_id"]));
    let (_api_agent, ui_agent) = (t.agent("Build the api layer").await, t.agent("Build the ui layer").await);
    let ui_live = t.child_session(&ui_thread).await;
    let cwd = ui_thread.cwd.clone();

    // The UI agent edits its own file, then the API agent's.
    let pump = |event| t.fixture.orchestrator.process_driver_event(ui_thread.id, &ui_live, event, false);
    pump(edit_call("e1", &format!("{cwd}/src/ui/button.rs"))).await.unwrap();
    let after_own = t.fixture.store.thread_get(ui_thread.id).unwrap().unwrap().delegation.unwrap();
    assert_eq!(after_own.files_touched, vec!["src/ui/button.rs".to_string()]);
    assert!(after_own.conflicts.is_empty());

    pump(edit_call("e2", &format!("{cwd}/src/api/routes.rs"))).await.unwrap();
    pump(edit_call("e3", "src/api/routes.rs")).await.unwrap();
    pump(edit_call("e4", &format!("{cwd}/src/ui/button.rs"))).await.unwrap();
    let info = t.fixture.store.thread_get(ui_thread.id).unwrap().unwrap().delegation.unwrap();
    assert_eq!(info.files_touched, vec!["src/ui/button.rs".to_string(), "src/api/routes.rs".to_string()], "deduped, repo-relative");
    assert_eq!(info.conflicts.len(), 1, "one conflict entry per path and owner");
    assert_eq!((info.conflicts[0].path.as_str(), info.conflicts[0].owner_thread_id), ("src/api/routes.rs", api_thread.id));

    // One Kybern warning reached the editing child, and none went to the owner.
    let warning = eventually(|| async {
        let messages = ui_agent.messages.lock().await;
        messages.iter().find_map(|m| match m.parts.as_slice() {
            [ContentPart::ThreadMessage { purpose: ThreadMessagePurpose::Warning, from_thread_id: None, body, message_id, .. }] => Some((*message_id, body.clone())),
            _ => None,
        })
    })
    .await;
    assert_eq!(warning.1, "\"src/api/routes.rs\" is owned by \"API\". Stop editing it and tell your parent if you need that change.");
    tokio::time::sleep(Duration::from_millis(100)).await;
    let warnings = ui_agent.transcript().await.matches("is owned by").count();
    assert_eq!(warnings, 1, "once per path and owner");
    let record = t.fixture.store.thread_message_get(warning.0).unwrap().unwrap();
    assert_eq!((record.purpose, record.from_thread_id, record.to_thread_id), (ThreadMessagePurpose::Warning, None, ui_thread.id));
    assert!(!t.agent("Build the api layer").await.transcript().await.contains("is owned by"));

    // The conflict travels in the parent's result for the editing child.
    ui_agent.finish("ui done").await;
    eventually(|| async {
        t.parent_messages.lock().await.iter().find_map(|m| match m.parts.as_slice() {
            [ContentPart::AgentResults { items }] => items.iter().find(|item| item.title == "UI" && !item.conflicts.is_empty()).map(|_| ()),
            _ => None,
        })
    })
    .await;
}

#[tokio::test]
async fn a_warning_reaches_a_codex_child_inside_its_running_turn() {
    let t = Delegating::new().await;
    let owner = t.delegate(json!({"task": "own the core", "owns": ["core/**"], "title": "Core"})).await;
    let other = t.delegate(json!({"task": "use codex", "provider": "codex", "title": "Codex child"})).await;
    let _ = owner;
    let codex = t.delegation(&other["task_id"]);
    let live = t.child_session(&codex).await;
    t.fixture.orchestrator.process_driver_event(codex.id, &live, edit_call("c1", &format!("{}/core/lib.rs", codex.cwd)), false).await.unwrap();
    // Codex is steerable, so the warning lands in its running turn.
    let agent = t.agent("use codex").await;
    eventually(|| async { agent.transcript().await.contains("is owned by \\\"Core\\\"").then_some(()) }).await;
}

#[tokio::test]
async fn files_touched_is_deduped_capped_and_published_at_most_about_once_a_second() {
    let t = Delegating::new().await;
    let started = t.delegate(json!({"task": "touch many files", "title": "Toucher"})).await;
    let child = t.delegation(&started["task_id"]);
    let live = t.child_session(&child).await;
    let updates = |t: &Delegating| {
        t.fixture.store.events_for_thread(child.id).unwrap().iter().filter(|event| matches!(event.payload, EventPayload::ThreadUpdated { .. })).count()
    };
    let before = updates(&t);
    let burst = Instant::now();
    for index in 0..230 {
        t.fixture
            .orchestrator
            .process_driver_event(child.id, &live, edit_call(&format!("f{index}"), &format!("{}/pkg/file{}.rs", child.cwd, index % 210)), false)
            .await
            .unwrap();
    }
    let info = t.fixture.store.thread_get(child.id).unwrap().unwrap().delegation.unwrap();
    assert_eq!(info.files_touched.len(), 200, "capped at 200 distinct files");
    assert_eq!(info.files_touched[0], "pkg/file0.rs");
    // A burst publishes immediately once, then trailing updates at most once a second, the last with the final list.
    let burst = burst.elapsed();
    tokio::time::sleep(Duration::from_millis(1400)).await;
    let published = updates(&t) - before;
    assert!(published >= 2 && published <= 2 + burst.as_secs() as usize, "{published} updates for {} events over {burst:?}", 230);
    let last = t
        .fixture
        .store
        .events_for_thread(child.id)
        .unwrap()
        .into_iter()
        .rev()
        .find_map(|event| match event.payload {
            EventPayload::ThreadUpdated { thread } => Some(thread),
            _ => None,
        })
        .unwrap();
    assert_eq!(last.delegation.unwrap().files_touched.len(), 200);
}

#[tokio::test]
async fn only_running_shared_children_are_tracked_and_paths_outside_the_checkout_are_ignored() {
    let t = Delegating::new().await;
    let started = t.delegate(json!({"task": "stay inside", "title": "Inside"})).await;
    let child = t.delegation(&started["task_id"]);
    let live = t.child_session(&child).await;
    for (id, path) in [("o1", "/etc/hosts"), ("o2", "../elsewhere/file.rs"), ("o3", "")] {
        t.fixture.orchestrator.process_driver_event(child.id, &live, edit_call(id, path), false).await.unwrap();
    }
    // Reads and shell commands never count.
    t.fixture
        .orchestrator
        .process_driver_event(
            child.id,
            &live,
            DriverEvent::ToolStarted(ToolCall { id: "r1".into(), name: "Read".into(), input: json!({"file_path": format!("{}/a.rs", child.cwd)}), parent_id: None }),
            false,
        )
        .await
        .unwrap();
    assert!(t.fixture.store.thread_get(child.id).unwrap().unwrap().delegation.unwrap().files_touched.is_empty());

    // An ordinary thread has nothing to track.
    t.fixture
        .orchestrator
        .process_driver_event(t.parent.id, &t.live, edit_call("p1", &format!("{}/x.rs", t.parent.cwd)), false)
        .await
        .unwrap();
    assert!(t.fixture.store.thread_get(t.parent.id).unwrap().unwrap().delegation.is_none());

    // A finished child stops recording.
    t.agent("stay inside").await.finish("done").await;
    eventually(|| async {
        let info = t.fixture.store.thread_get(child.id).unwrap().unwrap().delegation.unwrap();
        (info.status == DelegationStatus::Completed).then_some(())
    })
    .await;
    t.fixture.orchestrator.process_driver_event(child.id, &live, edit_call("late", &format!("{}/late.rs", child.cwd)), false).await.unwrap();
    assert!(t.fixture.store.thread_get(child.id).unwrap().unwrap().delegation.unwrap().files_touched.is_empty());
}

#[tokio::test]
async fn cursor_acp_edits_are_recorded_when_the_call_completes() {
    let spawned = Arc::new(std::sync::Mutex::new(Vec::new()));
    let mut drivers = DriverRegistry::default();
    drivers.register(Arc::new(ScriptedDriver { kind: ProviderKind::ClaudeCode, spawned: spawned.clone() }));
    drivers.register(Arc::new(ScriptedDriver { kind: ProviderKind::Cursor, spawned: spawned.clone() }));
    let fixture = Fixture::with_drivers(drivers);
    std::fs::create_dir_all(&fixture.root).unwrap();
    let mut parent = fixture.thread(ThreadStatus::Idle);
    parent.title = "Parent".into();
    fixture.store.thread_upsert(&parent).unwrap();
    let (live, _, _) = fixture.park_recording(&parent, Instant::now()).await;
    fixture.orchestrator.send(parent.id, UserMessage::text("go")).await.unwrap();
    live.turn_ready.notified().await;
    fixture.tool(&parent, &live, "d0", "kybern_agent_delegate", json!({"task": "own the sources", "title": "Owner", "owns": ["src/**"]})).await.unwrap();
    let started = fixture
        .tool(&parent, &live, "d1", "kybern_agent_delegate", json!({"task": "edit through acp", "provider": "cursor", "title": "Cursor child"}))
        .await
        .unwrap();
    let child = fixture.store.delegation_find_by_task(Uuid::parse_str(started["task_id"].as_str().unwrap()).unwrap()).unwrap().unwrap();
    let child_live = eventually(|| async { fixture.orchestrator.inner.sessions.lock().await.get(&child.id).cloned() }).await;

    let start = DriverEvent::ToolStarted(ToolCall { id: "acp1".into(), name: "edit".into(), input: json!({"title": "Edit lib.rs", "raw": {}}), parent_id: None });
    fixture.orchestrator.process_driver_event(child.id, &child_live, start, false).await.unwrap();
    assert!(fixture.store.thread_get(child.id).unwrap().unwrap().delegation.unwrap().files_touched.is_empty(), "ACP names no path at the start");
    let done = DriverEvent::ToolCompleted {
        tool_call_id: "acp1".into(),
        output: json!({"diffs": [{"path": format!("{}/src/lib.rs", child.cwd)}]}),
        is_error: false,
    };
    fixture.orchestrator.process_driver_event(child.id, &child_live, done, false).await.unwrap();
    let info = fixture.store.thread_get(child.id).unwrap().unwrap().delegation.unwrap();
    assert_eq!(info.files_touched, vec!["src/lib.rs".to_string()]);
    assert_eq!(info.conflicts.len(), 1, "the sibling owns src/**");
    // Cursor cannot take a message mid-turn, so the warning waits in its queue.
    let warning = eventually(|| async {
        let queued = fixture.store.queue_list(Some(child.id)).unwrap();
        queued.into_iter().find_map(|item| match item.message.parts.as_slice() {
            [ContentPart::ThreadMessage { purpose: ThreadMessagePurpose::Warning, from_thread_id: None, body, .. }] => Some(body.clone()),
            _ => None,
        })
    })
    .await;
    assert!(warning.contains("\"src/lib.rs\" is owned by \"Owner\""), "{warning}");
}

#[test]
fn owns_globs_match_star_double_star_and_question_mark() {
    use super::messaging::owns_path;
    let owns = |patterns: &[&str], path: &str| owns_path(&patterns.iter().map(|p| p.to_string()).collect::<Vec<_>>(), path);
    // `**` spans directories; `*` stays inside one.
    assert!(owns(&["src/api/**"], "src/api/routes.rs"));
    assert!(owns(&["src/api/**"], "src/api/v2/deep/routes.rs"));
    assert!(!owns(&["src/api/**"], "src/apix/routes.rs"));
    assert!(!owns(&["src/api/**"], "src/ui/routes.rs"));
    assert!(owns(&["src/*.rs"], "src/lib.rs"));
    assert!(!owns(&["src/*.rs"], "src/api/lib.rs"));
    assert!(owns(&["**/*.test.ts"], "a/b/c.test.ts") && owns(&["**/*.test.ts"], "c.test.ts"));
    assert!(owns(&["src/**/mod.rs"], "src/mod.rs") && owns(&["src/**/mod.rs"], "src/a/b/mod.rs"));
    assert!(!owns(&["src/**/mod.rs"], "src/a/b/lib.rs"));
    // `?` is one character, never a separator.
    assert!(owns(&["file?.rs"], "file1.rs"));
    assert!(!owns(&["file?.rs"], "file10.rs") && !owns(&["a?b"], "a/b"));
    assert!(owns(&["a*b*c"], "aXXbYYc") && !owns(&["a*b*c"], "aXXbYY"));
    // A plain path owns what is beneath it; leading ./ and / are ignored.
    assert!(owns(&["src/api"], "src/api/x.rs") && owns(&["src/api/"], "src/api/x.rs") && owns(&["./src/api"], "src/api/x.rs"));
    assert!(owns(&["Cargo.toml"], "Cargo.toml") && !owns(&["Cargo.toml"], "Cargo.lock"));
    assert!(!owns(&["src/api"], "src/apix"));
    // Any pattern may match; empty patterns own nothing.
    assert!(owns(&["docs/**", "src/api/**"], "src/api/x.rs"));
    assert!(!owns(&["", "  "], "src/api/x.rs") && !owns(&[], "src/api/x.rs"));
}

#[test]
fn the_tool_is_declared_for_agents_pi_and_native_operations() {
    let definitions = crate::app_tools::native_tool_definitions();
    let send = definitions.iter().find(|tool| tool.name == "kybern_thread_send").expect("declared");
    let properties = &send.input_schema["properties"];
    for field in ["thread_id", "body", "purpose", "reply_to", "delivery", "wait_for_reply", "timeout_ms", "request_key", "operation_id"] {
        assert!(properties.get(field).is_some(), "{field} is part of the schema");
    }
    assert_eq!(properties["purpose"]["enum"], json!(["message", "question", "reply", null]));
    assert_eq!(properties["delivery"]["enum"], json!(["queue", "steer", null]));
    assert_eq!(send.input_schema["required"], json!(["thread_id", "body"]));
    for phrase in ["question", "wait_for_reply", "steer", "held until the user approves", "16 messages", "reopens it"] {
        assert!(send.description.contains(phrase), "description mentions {phrase}");
    }
    assert!(!properties.as_object().unwrap().contains_key("to_thread_id"), "the collaboration shape is gone");

    // Mutating tools get a stable operation id; retrying a call keeps it.
    let (thread, session, turn) = (Uuid::now_v7(), Uuid::now_v7(), Uuid::now_v7());
    let mut args = json!({"thread_id": Uuid::now_v7(), "body": "x"});
    let id = crate::app_tools::prepare_native_operation(thread, session, turn, "c1", "kybern_thread_send", &mut args).unwrap();
    assert_eq!(args["operation_id"], json!(id.unwrap()));
}

#[tokio::test]
async fn thread_context_guidance_and_the_guide_describe_the_new_tools() {
    let chat = Chat::new();
    let a = chat.party("Alpha", ProviderKind::ClaudeCode, PermissionMode::Supervised, true).await;
    let context = chat.fixture.tool(&a.thread, &a.live, "ctx", "kybern_thread_context", json!({})).await.unwrap();
    let guidance = context["collaboration"]["guidance"].as_str().unwrap();
    for phrase in ["kybern_thread_send to message another thread", "kybern_agent_delegate to hand work", "end your turn", "project coordinators"] {
        assert!(guidance.contains(phrase), "guidance mentions {phrase}: {guidance}");
    }
    let golden = include_str!("../agent_guide_full.golden.txt");
    assert!(golden.contains("`kybern_agent_delegate`") && golden.contains("end your turn") && golden.contains("held until the user approves"));
    assert!(golden.len() <= 6000);
}

// ---- review fixes ----

fn updates(events: &[EventPayload], id: MessageId) -> Vec<ThreadMessageState> {
    events
        .iter()
        .filter_map(|event| match event {
            EventPayload::ThreadMessageUpdated { message } if message.id == id => Some(message.state),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn a_failed_child_is_started_directly_when_its_parent_messages_it() {
    let t = Delegating::new().await;
    let started = t.delegate(json!({"task": "Fail first"})).await;
    let child = t.delegation(&started["task_id"]);
    t.agent("Fail first").await.tx.send(DriverEvent::TurnFailed { error: "rate limited".into() }).await.unwrap();
    eventually(|| async {
        let thread = t.fixture.store.thread_get(child.id).unwrap().unwrap();
        (thread.status == ThreadStatus::Failed && thread.delegation.as_ref().unwrap().status == DelegationStatus::Failed).then_some(())
    })
    .await;

    // No queue worker runs here: the message must start the turn by itself.
    let sent = t.tool("kybern_thread_send", json!({"thread_id": child.id, "body": "Try again please"})).await.unwrap();
    let record = t.fixture.store.thread_message_get(Uuid::parse_str(sent["message_id"].as_str().unwrap()).unwrap()).unwrap().unwrap();
    assert_eq!(record.state, ThreadMessageState::Delivered, "the turn started with the message");
    assert!(t.fixture.store.queue_list(Some(child.id)).unwrap().is_empty(), "nothing waits in a queue that would never drain");
    let info = t.fixture.store.thread_get(child.id).unwrap().unwrap().delegation.unwrap();
    assert_eq!(info.status, DelegationStatus::Running, "the delegation reopened");
    t.agent("Try again please").await;
    assert_eq!(t.fixture.store.thread_get(child.id).unwrap().unwrap().status, ThreadStatus::Running);
}

#[tokio::test]
async fn a_follow_up_queued_to_a_running_child_reopens_its_delegation_when_it_is_consumed() {
    let t = Delegating::new().await;
    let started = t.delegate(json!({"task": "First round"})).await;
    let child = t.delegation(&started["task_id"]);
    let agent = t.agent("First round").await;
    // The child is still running, so the parent's message waits in its queue.
    let sent = t.tool("kybern_thread_send", json!({"thread_id": child.id, "body": "Also check the docs"})).await.unwrap();
    assert_eq!(sent["delivered_as"], "queued");
    assert_eq!(t.delegation(&started["task_id"]).delegation.unwrap().status, DelegationStatus::Running);
    agent.finish("round one").await;
    eventually(|| async { (t.delegation(&started["task_id"]).delegation.unwrap().status == DelegationStatus::Completed).then_some(()) }).await;

    t.fixture.orchestrator.drain_queues().await.unwrap();
    eventually(|| async { agent.transcript().await.contains("Also check the docs").then_some(()) }).await;
    let info = t.delegation(&started["task_id"]).delegation.unwrap();
    assert_eq!(info.status, DelegationStatus::Running, "consuming the parent's follow-up reopened it");

    agent.finish("round two").await;
    eventually(|| async {
        t.parent_messages.lock().await.iter().find_map(|m| match m.parts.as_slice() {
            [ContentPart::AgentResults { items }] if items.iter().any(|item| item.result.as_deref() == Some("round two")) => Some(()),
            _ => None,
        })
    })
    .await;
}

#[tokio::test]
async fn a_question_in_flight_at_a_restart_gets_an_interrupted_reply() {
    let chat = Chat::new();
    let a = chat.party("Asker", ProviderKind::ClaudeCode, PermissionMode::Supervised, true).await;
    let b = chat.party("Answerer", ProviderKind::ClaudeCode, PermissionMode::Supervised, false).await;
    let asked = chat.send(&a, json!({"thread_id": b.thread.id, "body": "Which seed?", "purpose": "question"})).await;
    let question = chat.record(&asked).id;
    chat.drain().await;
    eventually(|| async { (chat.state(question) == ThreadMessageState::Delivered).then_some(()) }).await;

    chat.fixture.orchestrator.messaging_recover_after_restart().await.unwrap();

    assert_eq!(chat.state(question), ThreadMessageState::Answered);
    let reply = chat.fixture.store.thread_message_find_reply(question).unwrap().expect("the asker is told");
    assert_eq!((reply.from_thread_id, reply.to_thread_id), (Some(b.thread.id), a.thread.id));
    assert_eq!(reply.body, "The recipient was interrupted by a Kybern restart before answering. Ask again if you still need this.");
    // Once is enough.
    chat.fixture.orchestrator.messaging_recover_after_restart().await.unwrap();
    let replies = chat.fixture.store.thread_message_list_for_thread(a.thread.id, None, 200).unwrap().into_iter().filter(|m| m.purpose == ThreadMessagePurpose::Reply).count();
    assert_eq!(replies, 1);
}

#[tokio::test]
async fn delivering_a_held_message_never_overwrites_a_newer_state() {
    let chat = Chat::new();
    let a = chat.party("Alpha", ProviderKind::ClaudeCode, PermissionMode::Supervised, true).await;
    let b = chat.party("Beta", ProviderKind::ClaudeCode, PermissionMode::FullAccess, false).await;
    let held = chat.send(&a, json!({"thread_id": b.thread.id, "body": "run it"})).await;
    let stale = chat.record(&held);
    assert_eq!(stale.state, ThreadMessageState::Held);
    // A turn consumed the message and the store moved on while delivery was in flight.
    chat.fixture.store.thread_message_update_state(stale.id, ThreadMessageState::Delivered).unwrap();

    chat.fixture.orchestrator.deliver_thread_message(&stale).await.unwrap();

    assert_eq!(chat.state(stale.id), ThreadMessageState::Delivered, "the newer state wins");
}

#[tokio::test]
async fn thread_message_state_changes_are_announced_on_both_threads() {
    let chat = Chat::new();
    let a = chat.party("Alpha", ProviderKind::ClaudeCode, PermissionMode::Supervised, true).await;
    let b = chat.party("Beta", ProviderKind::ClaudeCode, PermissionMode::Supervised, false).await;
    let steered_to = chat.party("Running", ProviderKind::ClaudeCode, PermissionMode::Supervised, true).await;
    let full = chat.party("Full", ProviderKind::ClaudeCode, PermissionMode::FullAccess, true).await;

    // queued -> delivered
    let queued = chat.record(&chat.send(&a, json!({"thread_id": b.thread.id, "body": "hello"})).await).id;
    chat.drain().await;
    eventually(|| async { (chat.state(queued) == ThreadMessageState::Delivered).then_some(()) }).await;
    for thread in [&a.thread, &b.thread] {
        assert_eq!(updates(&chat.events(thread), queued), vec![ThreadMessageState::Delivered], "on the sender's and the recipient's thread");
    }

    // queued -> steered
    let steered = chat.record(&chat.send(&a, json!({"thread_id": steered_to.thread.id, "body": "now", "delivery": "steer"})).await).id;
    for thread in [&a.thread, &steered_to.thread] {
        assert_eq!(updates(&chat.events(thread), steered), vec![ThreadMessageState::Steered]);
    }

    // held -> dismissed
    let held = chat.record(&chat.send(&a, json!({"thread_id": full.thread.id, "body": "risky"})).await).id;
    assert!(updates(&chat.events(&full.thread), held).is_empty(), "creating a held message is announced by thread_message_held");
    chat.fixture.orchestrator.thread_message_dismiss(held).await.unwrap();
    for thread in [&a.thread, &full.thread] {
        assert_eq!(updates(&chat.events(thread), held), vec![ThreadMessageState::Dismissed]);
    }

    // question -> answered (Beta's first turn has to end before it can start another)
    eventually(|| async { recorded(&b, "hello").await.then_some(()) }).await;
    chat.end_turn(&b).await;
    let asked = chat.record(&chat.send(&a, json!({"thread_id": b.thread.id, "body": "why?", "purpose": "question"})).await).id;
    chat.drain().await;
    eventually(|| async { (chat.state(asked) == ThreadMessageState::Delivered).then_some(()) }).await;
    eventually(|| async { recorded(&b, "why?").await.then_some(()) }).await;
    chat.say(&b, "because").await;
    chat.end_turn(&b).await;
    eventually(|| async { (chat.state(asked) == ThreadMessageState::Answered).then_some(()) }).await;
    assert_eq!(updates(&chat.events(&a.thread), asked), vec![ThreadMessageState::Delivered, ThreadMessageState::Answered]);
}

#[tokio::test]
async fn conflicts_are_capped_per_delegation() {
    let t = Delegating::new().await;
    t.delegate(json!({"task": "Own everything", "owns": ["src/**"], "title": "Owner"})).await;
    let editor = t.delegate(json!({"task": "Edit everywhere", "owns": ["docs/**"], "title": "Editor"})).await;
    let editor_thread = t.delegation(&editor["task_id"]);
    let live = t.child_session(&editor_thread).await;
    for n in 0..60 {
        t.fixture
            .orchestrator
            .process_driver_event(editor_thread.id, &live, edit_call(&format!("e{n}"), &format!("src/file{n}.rs")), false)
            .await
            .unwrap();
    }
    let info = t.fixture.store.thread_get(editor_thread.id).unwrap().unwrap().delegation.unwrap();
    assert_eq!(info.conflicts.len(), 50);
    assert_eq!(info.files_touched.len(), 60, "files are still all recorded");
}
