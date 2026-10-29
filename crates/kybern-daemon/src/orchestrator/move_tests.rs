// Continue on another machine scenarios (ADE-86 F2, design §7.2, §11.2). Included into
// `orchestrator::tests`, after `fork_tests.rs`, so they share the two-daemon `Pair`: machine "a" has the
// thread that moves and machine "b" receives it. They skip on a computer without the `127.x.0.n`
// loopback aliases.

use kybern_protocol::methods::{Method as _, PeerMoveAbort, PeerMoveCommit, PeerMoveGet, PeerMovePrepare};

impl Pair {
    fn move_params(&self) -> ThreadsMoveToMachineParams {
        ThreadsMoveToMachineParams {
            thread_id: self.parent.id,
            machine: self.b.id(),
            project: None,
            handoff_note: None,
            title: None,
            provider: None,
            model: None,
            effort: None,
            permission_mode: None,
            operation_id: None,
            provision: None,
        }
    }

    /// The parent's turn ends and the thread is idle, which is when it may move.
    async fn idle_parent(&self) {
        self.end_parent_turn().await;
        eventually(|| async { (self.parent_now().status == ThreadStatus::Idle).then_some(()) }).await;
    }

    /// A message the thread takes: it is not refused by the move.
    async fn send_ok(&self, text: &str) {
        tokio::time::timeout(Duration::from_secs(20), self.a.state.orchestrator.send(self.parent.id, UserMessage::text(text)))
            .await
            .expect("the send finished")
            .unwrap();
    }

    fn parent_now(&self) -> Thread {
        self.a.state.store.thread_get(self.parent.id).unwrap().unwrap()
    }

    fn move_item(&self, operation_id: Uuid) -> OutboxItem {
        self.a.state.store.outbox_get_by_operation(operation_id).unwrap().expect("the move's outbox item")
    }

    /// The threads on machine b that came from a move.
    fn moves_on_b(&self) -> Vec<Thread> {
        self.b
            .state
            .store
            .threads_list(None, true)
            .unwrap()
            .into_iter()
            .filter(|thread| thread.origin.as_ref().is_some_and(|origin| origin.kind == OriginKind::Move))
            .collect()
    }

    fn history_on_b(&self, thread_id: Uuid) -> Vec<(String, Uuid, Vec<HistoryItem>)> {
        self.b
            .state
            .store
            .events_for_thread(thread_id)
            .unwrap()
            .into_iter()
            .filter_map(|event| match event.payload {
                EventPayload::HistoryImported { from_machine, from_thread, items, .. } => Some((from_machine, from_thread, items)),
                _ => None,
            })
            .collect()
    }

    /// `peer.move.*` as machine a would send it, straight to machine b's orchestrator.
    async fn b_peer<T: serde::de::DeserializeOwned>(&self, method: &str, params: impl serde::Serialize) -> Result<T, RpcError> {
        let value = self.b.state.orchestrator.peer_dispatch(&self.a.id(), method, serde_json::to_value(params).unwrap()).await?;
        Ok(serde_json::from_value(value).unwrap())
    }

    async fn prepare_params(&self, operation_id: Uuid) -> PeerMovePrepareParams {
        PeerMovePrepareParams {
            operation_id,
            origin: Origin {
                machine_id: self.a.id(),
                machine_name: "a".into(),
                thread_id: Some(self.parent.id),
                operation_id,
                kind: OriginKind::Move,
                permission_cap: PermissionMode::Supervised,
                hops: vec![self.a.id()],
            },
            source_title: self.parent.title.clone(),
            repo: crate::network::git_transfer::identity_of(&self.repo_a).await,
            project: None,
            branch: format!("kybern/move-{}", &operation_id.simple().to_string()[24..]),
            commit: run_git(&self.repo_a, &["rev-parse", "HEAD"]),
            group: None,
            provider: self.parent.provider.kind,
            provider_chosen: false,
            model: None,
            effort: None,
            permission_mode: PermissionMode::Supervised,
            history_bytes: 0,
        }
    }

    fn commit_params(&self, operation_id: Uuid) -> PeerMoveCommitParams {
        PeerMoveCommitParams {
            operation_id,
            handoff_note: "# Hand-off: by hand".into(),
            title: None,
            from_thread: self.parent.id,
            from_title: self.parent.title.clone(),
            items: vec![HistoryItem { role: HistoryRole::User, text: "an earlier question".into(), at: None, tool: None }],
            omitted: 0,
        }
    }

    fn ref_params(&self, operation_id: Uuid) -> PeerMoveRefParams {
        PeerMoveRefParams { operation_id, from_thread: self.parent.id }
    }

    /// A lease on the parent that is `departing`, as if an attempt had taken it.
    fn lease(&self, operation_id: Uuid, lease_until: Option<chrono::DateTime<chrono::Utc>>, uncertain: bool) -> MoveInfo {
        MoveInfo {
            state: MoveState::Departing,
            peer: self.b.id(),
            peer_name: self.b_name(),
            peer_thread_id: None,
            lease_until,
            operation_id,
            branch: Some("kybern/move-test".into()),
            commit: Some(run_git(&self.repo_a, &["rev-parse", "HEAD"])),
            uncertain,
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_move_carries_the_work_and_the_conversation_and_leaves_a_read_only_source() {
    let Some(p) = Pair::new().await else { return };
    p.make_dirty();
    p.idle_parent().await;
    let status_before = run_git(&p.repo_a, &["status", "--porcelain"]);

    let queued = p.a.state.orchestrator.move_to_machine(p.move_params()).await.unwrap();
    assert!(queued.handoff_note.contains("# Hand-off:"), "{}", queued.handoff_note);
    let thread = eventually(|| async { p.moves_on_b().into_iter().next() }).await;
    eventually(|| async { (p.move_item(queued.operation_id).state == OutboxState::Delivered).then_some(()) }).await;

    // The new thread: an origin of kind move, the worktree on the move branch, the work in it.
    let origin = thread.origin.clone().unwrap();
    assert_eq!((origin.machine_id.as_str(), origin.thread_id, origin.operation_id), (p.a.id().as_str(), Some(p.parent.id), queued.operation_id));
    assert!(!super::fork_machine::second_hop(&thread), "a moved thread is the user's own");
    let worktree = thread.worktree.clone().expect("the moved thread gets a worktree");
    assert!(worktree.branch.starts_with("kybern/move-"), "{}", worktree.branch);
    let dir = std::path::Path::new(&thread.cwd);
    assert_eq!(std::fs::read_to_string(dir.join("tracked.txt")).unwrap(), "one\ntwo\nthree\n");
    assert_eq!(std::fs::read_to_string(dir.join("new.txt")).unwrap(), "untracked work\n");
    assert!(!dir.join(".env").exists(), "ignored files stay behind");

    // The conversation arrives as history ahead of the first turn; the note is the first message.
    let history = p.history_on_b(thread.id);
    assert_eq!(history.len(), 1, "{history:?}");
    assert_eq!((history[0].0.as_str(), history[0].1), (p.a.id().as_str(), p.parent.id));
    assert!(history[0].2.iter().any(|item| item.role == HistoryRole::User && item.text.contains("coordinate the work")), "{:?}", history[0].2);
    let events = p.b.state.store.events_for_thread(thread.id).unwrap();
    let transcript = kybern_store::project_transcript(&events);
    assert!(matches!(transcript.first(), Some(TranscriptEntry::History { from_machine_name, .. }) if !from_machine_name.is_empty()), "{transcript:?}");
    let messages: Vec<String> = transcript
        .iter()
        .filter_map(|entry| match entry {
            TranscriptEntry::User { message, .. } => Some(message.plain_text()),
            _ => None,
        })
        .collect();
    assert_eq!(messages.len(), 1, "{messages:?}");
    assert!(messages[0].contains("# Hand-off:") && messages[0].contains(&format!("kybern://thread/{}/{}", p.a.id(), p.parent.id)), "{}", messages[0]);
    p.agent("# Hand-off:").await;

    // The source is read-only with a link, its files are as they were, and it says where the work went.
    let source = p.parent_now();
    let moved = source.moved.clone().expect("the source records the move");
    assert_eq!((moved.state, moved.peer.as_str(), moved.peer_thread_id), (MoveState::Departed, p.b.id().as_str(), Some(thread.id)));
    assert!(moved.lease_until.is_none() && !moved.uncertain);
    let refused = p.a.state.orchestrator.send(p.parent.id, UserMessage::text("one more thing")).await.unwrap_err();
    assert!(format!("{refused:#}").contains("continues on"), "{refused:#}");
    assert_eq!(run_git(&p.repo_a, &["status", "--porcelain"]), status_before);
    assert!(run_git(&p.repo_a, &["diff", "--cached", "--name-only"]).is_empty(), "the user's index is untouched");
    assert_eq!(std::fs::read_to_string(p.repo_a.join(".env")).unwrap(), "SECRET=1\n");
    let (text, data) = p.notice_on_a(|text| text.starts_with("Continued on")).await;
    assert_eq!(text, format!("Continued on {} · open", p.b_name()));
    let data = data.unwrap();
    assert_eq!((data["thread_id"].clone(), data["machine_id"].clone(), data["kind"].clone()), (json!(thread.id), json!(p.b.id()), json!("move")));
    let published = p.a.state.store.events_for_thread(p.parent.id).unwrap().into_iter().any(|event| {
        matches!(event.payload, EventPayload::ThreadUpdated { thread } if thread.moved.as_ref().is_some_and(|moved| moved.state == MoveState::Departed))
    });
    assert!(published, "clients learn about the move through ThreadUpdated");
    let result: PeerMoveCommitResult = serde_json::from_value(p.move_item(queued.operation_id).result.unwrap()).unwrap();
    assert_eq!(result.thread_id, thread.id);

    // It does not move twice, and the move is not repeated.
    let again = p.a.state.orchestrator.move_to_machine(p.move_params()).await.unwrap_err();
    assert_eq!(again.code, codes::CONFLICT, "{}", again.message);
    assert_eq!(p.moves_on_b().len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_running_thread_moves_only_when_its_turn_ends() {
    let Some(p) = Pair::new().await else { return };
    p.make_dirty();
    assert!(matches!(p.parent_now().status, ThreadStatus::Running | ThreadStatus::AwaitingApproval), "{:?}", p.parent_now().status);

    let queued = p.a.state.orchestrator.move_to_machine(p.move_params()).await.unwrap();
    eventually(|| async { (p.move_item(queued.operation_id).attempts > 0).then_some(()) }).await;
    // The attempt found a running turn: no lease, nothing sent, and the thread works as usual.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(p.parent_now().moved.is_none(), "no lease while a turn runs");
    assert!(p.moves_on_b().is_empty());
    assert_eq!(p.move_item(queued.operation_id).state, OutboxState::Queued);
    assert!(p.notices_on_a().iter().any(|(text, _)| text.contains("this turn to finish")));

    // The turn ends and the move goes by itself.
    p.end_parent_turn().await;
    let thread = eventually(|| async { p.moves_on_b().into_iter().next() }).await;
    eventually(|| async { (p.move_item(queued.operation_id).state == OutboxState::Delivered).then_some(()) }).await;
    assert_eq!(p.parent_now().moved.unwrap().peer_thread_id, Some(thread.id));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_move_for_an_offline_machine_waits_in_the_outbox_without_locking_the_thread() {
    let Some(p) = Pair::new().await else { return };
    p.make_dirty();
    p.idle_parent().await;
    p.b_offline().await;

    let queued = p.a.state.orchestrator.move_to_machine(p.move_params()).await.unwrap();
    let item = p.move_item(queued.operation_id);
    assert_eq!((item.kind, item.state, item.target.as_str()), (OutboxKind::Move, OutboxState::Queued, p.b.id().as_str()));
    assert_eq!(item.origin.as_ref().unwrap().kind, OriginKind::Move);
    assert!(p.notices_on_a().iter().any(|(text, _)| text.contains("waiting for it to come online")));
    // Nothing is held while it waits: the thread is writable and the files can change.
    assert!(p.parent_now().moved.is_none());
    std::fs::write(p.repo_a.join("new.txt"), "changed while b was away\n").unwrap();
    assert!(p.moves_on_b().is_empty());

    p.b_online().await;
    let thread = eventually(|| async { p.moves_on_b().into_iter().next() }).await;
    eventually(|| async { (p.move_item(queued.operation_id).state == OutboxState::Delivered).then_some(()) }).await;
    // The snapshot is taken when the move goes, so it carries the work as it stands then.
    assert_eq!(std::fs::read_to_string(std::path::Path::new(&thread.cwd).join("new.txt")).unwrap(), "changed while b was away\n");
    assert_eq!(p.parent_now().moved.unwrap().state, MoveState::Departed);

    // A move can be queued through the outbox like any other operation.
    let other = Uuid::now_v7();
    let mut params = p.move_params();
    params.machine = String::new();
    let error = crate::orchestrator::move_thread::serve_move_enqueue(
        &p.a.state,
        OutboxEnqueueParams {
            target: p.b.id(),
            operation: OutboxOp { kind: OutboxKind::Move, payload: serde_json::to_value(&params).unwrap(), operation_id: Some(other) },
        },
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, codes::CONFLICT, "the thread has moved already: {}", error.message);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_refusal_releases_the_lease_and_the_thread_works_again() {
    let Some(p) = Pair::new().await else { return };
    p.make_dirty();
    p.idle_parent().await;
    let mut params = p.move_params();
    // Machine b has no such agent, and the user named it, so b must not swap it.
    params.provider = Some(ProviderKind::Pi);
    let queued = p.a.state.orchestrator.move_to_machine(params).await.unwrap();
    let item = eventually(|| async { Some(p.move_item(queued.operation_id)).filter(|item| item.state == OutboxState::Failed) }).await;
    assert!(item.last_error.unwrap().contains("not available"));

    let source = p.parent_now();
    assert!(source.moved.is_none(), "the lease is released: {:?}", source.moved);
    assert!(p.moves_on_b().is_empty());
    let expected = format!("Couldn't move to {}", p.b_name());
    let (_, data) = p.notice_on_a(|text| text.starts_with(&expected)).await;
    assert_eq!(data.unwrap()["item_id"], json!(item.id));
    // Retry is the ordinary outbox retry; Keep here is cancel. The thread takes messages meanwhile.
    p.send_ok("carry on here").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_lease_that_runs_out_releases_the_thread_but_an_unsure_move_stays() {
    let Some(p) = Pair::new().await else { return };
    p.idle_parent().await;
    let orchestrator = &p.a.state.orchestrator;
    let op = Uuid::now_v7();

    // While the lease is held the thread takes no messages.
    orchestrator.move_set(p.parent.id, Some(p.lease(op, Some(chrono::Utc::now() + chrono::Duration::minutes(5)), false))).unwrap();
    let refused = orchestrator.send(p.parent.id, UserMessage::text("while leased")).await.unwrap_err();
    assert!(format!("{refused:#}").contains(&format!("Moving to {}", p.b_name())), "{refused:#}");
    orchestrator.move_sweep();
    assert!(p.parent_now().moved.is_some(), "a live lease stays");

    // The same lease, run out, with nobody renewing it.
    orchestrator.move_set(p.parent.id, Some(p.lease(op, Some(chrono::Utc::now() - chrono::Duration::seconds(1)), false))).unwrap();
    orchestrator.move_sweep();
    assert!(p.parent_now().moved.is_none(), "an expired lease is released");
    let (_, data) = p.notice_on_a(|text| text.contains("didn't finish")).await;
    assert_eq!(data.unwrap()["kind"], json!("move_released"));
    p.send_ok("writable again").await;

    // A move whose commit may have gone out never expires on its own: only the target can say what happened.
    orchestrator.move_set(p.parent.id, Some(p.lease(op, None, true))).unwrap();
    orchestrator.move_sweep();
    assert!(p.parent_now().moved.is_some_and(|moved| moved.uncertain));

    // A stale copy of the thread, saved by something else, cannot undo the lease or the release.
    let mut stale = p.parent_now();
    stale.moved = None;
    stale.title = "Renamed while leased".into();
    orchestrator.update_thread(stale).unwrap();
    assert!(p.parent_now().moved.is_some(), "only the move code writes the lease");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_target_holds_a_slot_until_commit_abort_or_expiry() {
    let Some(p) = Pair::new().await else { return };
    let op = Uuid::now_v7();
    let status = |state| (state, None::<Uuid>);

    // Unknown, then prepared.
    let got: PeerMoveStatus = p.b_peer(PeerMoveGet::NAME, p.ref_params(op)).await.unwrap();
    assert_eq!(got.state, PeerMoveState::Unknown);
    let prepare = p.prepare_params(op).await;
    let prepared: PeerMovePrepareResult = p.b_peer(PeerMovePrepare::NAME, &prepare).await.unwrap();
    assert!(prepared.lease_until > chrono::Utc::now());
    let got: PeerMoveStatus = p.b_peer(PeerMoveGet::NAME, p.ref_params(op)).await.unwrap();
    assert_eq!(status(got.state), status(PeerMoveState::Prepared));

    // Abort drops the slot; a commit after it is refused and creates nothing.
    let aborted: PeerMoveStatus = p.b_peer(PeerMoveAbort::NAME, p.ref_params(op)).await.unwrap();
    assert_eq!(aborted.state, PeerMoveState::Aborted);
    let error = p.b_peer::<PeerMoveCommitResult>(PeerMoveCommit::NAME, p.commit_params(op)).await.unwrap_err();
    assert_eq!(error.code, codes::CONFLICT, "{}", error.message);
    assert!(p.moves_on_b().is_empty());

    // A slot whose own lease copy ran out is gone as well.
    let op = Uuid::now_v7();
    let _: PeerMovePrepareResult = p.b_peer(PeerMovePrepare::NAME, p.prepare_params(op).await).await.unwrap();
    let key = format!(
        "move_in:{}",
        crate::orchestrator::remote_delegation::namespaced_operation(&p.a.id(), Some(p.parent.id), op)
    );
    let mut slot: serde_json::Value = serde_json::from_str(&p.b.state.store.meta_get(&key).unwrap().unwrap()).unwrap();
    slot["lease_until"] = json!(chrono::Utc::now() - chrono::Duration::seconds(5));
    p.b.state.store.meta_set(&key, &slot.to_string()).unwrap();
    let got: PeerMoveStatus = p.b_peer(PeerMoveGet::NAME, p.ref_params(op)).await.unwrap();
    assert_eq!(got.state, PeerMoveState::Aborted);
    let error = p.b_peer::<PeerMoveCommitResult>(PeerMoveCommit::NAME, p.commit_params(op)).await.unwrap_err();
    assert_eq!(error.code, codes::CONFLICT, "{}", error.message);

    // A commit nobody prepared is refused.
    let error = p.b_peer::<PeerMoveCommitResult>(PeerMoveCommit::NAME, p.commit_params(Uuid::now_v7())).await.unwrap_err();
    assert_eq!(error.code, codes::CONFLICT, "{}", error.message);
    // A move claiming a hop or a kind it does not have is refused.
    let mut forged = p.prepare_params(Uuid::now_v7()).await;
    forged.origin.hops = vec![p.a.id(), "elsewhere".into()];
    let error = p.b_peer::<PeerMovePrepareResult>(PeerMovePrepare::NAME, forged).await.unwrap_err();
    assert_eq!(error.code, codes::FORBIDDEN, "{}", error.message);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn importing_the_same_move_twice_gives_the_same_thread() {
    let Some(p) = Pair::new().await else { return };
    let op = Uuid::now_v7();
    let _: PeerMovePrepareResult = p.b_peer(PeerMovePrepare::NAME, p.prepare_params(op).await).await.unwrap();
    let first: PeerMoveCommitResult = p.b_peer(PeerMoveCommit::NAME, p.commit_params(op)).await.unwrap();
    let again: PeerMoveCommitResult = p.b_peer(PeerMoveCommit::NAME, p.commit_params(op)).await.unwrap();
    assert_eq!(first.thread_id, again.thread_id);
    assert_eq!(p.moves_on_b().len(), 1, "one thread");
    assert_eq!(p.history_on_b(first.thread_id).len(), 1, "one history block");
    let notes = kybern_store::project_transcript(&p.b.state.store.events_for_thread(first.thread_id).unwrap())
        .into_iter()
        .filter(|entry| matches!(entry, TranscriptEntry::User { .. }))
        .count();
    assert_eq!(notes, 1, "one hand-off note");
    let got: PeerMoveStatus = p.b_peer(PeerMoveGet::NAME, p.ref_params(op)).await.unwrap();
    assert_eq!((got.state, got.thread_id), (PeerMoveState::Committed, Some(first.thread_id)));
    // An abort that arrives late does not undo it; it answers with the thread.
    let late: PeerMoveStatus = p.b_peer(PeerMoveAbort::NAME, p.ref_params(op)).await.unwrap();
    assert_eq!((late.state, late.thread_id), (PeerMoveState::Committed, Some(first.thread_id)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_move_that_may_have_landed_is_resolved_by_asking_the_target() {
    // The commit went out, the answer never came back, and machine a restarted: it asks b.
    let Some(p) = Pair::new().await else { return };
    p.idle_parent().await;
    p.b_offline().await;
    let queued = p.a.state.orchestrator.move_to_machine(p.move_params()).await.unwrap();
    let op = queued.operation_id;
    // What b did while a was not listening: it took the commit.
    let _: PeerMovePrepareResult = p.b_peer(PeerMovePrepare::NAME, p.prepare_params(op).await).await.unwrap();
    let landed: PeerMoveCommitResult = p.b_peer(PeerMoveCommit::NAME, p.commit_params(op)).await.unwrap();
    p.a.state.orchestrator.move_set(p.parent.id, Some(p.lease(op, None, true))).unwrap();

    p.b_online().await;
    eventually(|| async { (p.move_item(op).state == OutboxState::Delivered).then_some(()) }).await;
    let moved = p.parent_now().moved.unwrap();
    assert_eq!((moved.state, moved.peer_thread_id, moved.uncertain), (MoveState::Departed, Some(landed.thread_id), false));
    assert_eq!(p.moves_on_b().len(), 1, "no second thread");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_move_the_target_never_saw_starts_over_after_an_unsure_commit() {
    let Some(p) = Pair::new().await else { return };
    p.make_dirty();
    p.idle_parent().await;
    p.b_offline().await;
    let queued = p.a.state.orchestrator.move_to_machine(p.move_params()).await.unwrap();
    let op = queued.operation_id;
    // a believes it sent the commit; b never heard of it.
    p.a.state.orchestrator.move_set(p.parent.id, Some(p.lease(op, None, true))).unwrap();

    p.b_online().await;
    let thread = eventually(|| async { p.moves_on_b().into_iter().next() }).await;
    eventually(|| async { (p.move_item(op).state == OutboxState::Delivered).then_some(()) }).await;
    let moved = p.parent_now().moved.unwrap();
    assert_eq!((moved.state, moved.peer_thread_id), (MoveState::Departed, Some(thread.id)));
    assert_eq!(p.moves_on_b().len(), 1);
    assert_eq!(std::fs::read_to_string(std::path::Path::new(&thread.cwd).join("new.txt")).unwrap(), "untracked work\n");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn abandoning_an_unsure_move_asks_the_target_first() {
    let Some(p) = Pair::new().await else { return };
    p.idle_parent().await;
    let orchestrator = &p.a.state.orchestrator;

    // b has nothing: the thread is released.
    let op = Uuid::now_v7();
    orchestrator.move_set(p.parent.id, Some(p.lease(op, None, true))).unwrap();
    let result = orchestrator.move_abandon(ThreadsMoveAbandonParams { thread_id: p.parent.id, force: false }).await.unwrap();
    assert_eq!(result.outcome, MoveAbandonOutcome::Released);
    assert!(p.parent_now().moved.is_none());

    // b already made the thread: the move is done after all.
    let op = Uuid::now_v7();
    let _: PeerMovePrepareResult = p.b_peer(PeerMovePrepare::NAME, p.prepare_params(op).await).await.unwrap();
    let landed: PeerMoveCommitResult = p.b_peer(PeerMoveCommit::NAME, p.commit_params(op)).await.unwrap();
    orchestrator.move_set(p.parent.id, Some(p.lease(op, None, true))).unwrap();
    let result = orchestrator.move_abandon(ThreadsMoveAbandonParams { thread_id: p.parent.id, force: false }).await.unwrap();
    assert_eq!(result.outcome, MoveAbandonOutcome::Completed);
    let moved = p.parent_now().moved.unwrap();
    assert_eq!((moved.state, moved.peer_thread_id), (MoveState::Departed, Some(landed.thread_id)));
    let nothing = orchestrator.move_abandon(ThreadsMoveAbandonParams { thread_id: p.parent.id, force: false }).await.unwrap();
    assert_eq!(nothing.outcome, MoveAbandonOutcome::Nothing, "a departed thread has nothing to abandon");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn abandoning_needs_force_when_the_target_cannot_be_asked() {
    let Some(p) = Pair::new().await else { return };
    p.idle_parent().await;
    let orchestrator = &p.a.state.orchestrator;
    p.b_offline().await;
    orchestrator.move_set(p.parent.id, Some(p.lease(Uuid::now_v7(), None, true))).unwrap();
    let error = orchestrator.move_abandon(ThreadsMoveAbandonParams { thread_id: p.parent.id, force: false }).await.unwrap_err();
    assert_eq!(error.code, codes::CONFLICT, "{}", error.message);
    assert!(p.parent_now().moved.is_some_and(|moved| moved.uncertain), "still unsure");
    let result = orchestrator.move_abandon(ThreadsMoveAbandonParams { thread_id: p.parent.id, force: true }).await.unwrap();
    assert_eq!(result.outcome, MoveAbandonOutcome::Released);
    p.send_ok("mine again").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_lease_left_by_a_dead_attempt_is_replaced_by_the_next_attempt() {
    // The daemon died after taking the lease and before sending the commit: the lease is still on the thread,
    // nothing is uncertain, and the next attempt starts the move over instead of waiting for the lease to run out.
    let Some(p) = Pair::new().await else { return };
    p.make_dirty();
    p.idle_parent().await;
    p.b_offline().await;
    let queued = p.a.state.orchestrator.move_to_machine(p.move_params()).await.unwrap();
    p.a.state.orchestrator.move_set(p.parent.id, Some(p.lease(queued.operation_id, Some(chrono::Utc::now() + chrono::Duration::minutes(9)), false))).unwrap();
    assert!(p.a.state.orchestrator.send(p.parent.id, UserMessage::text("while the lease is held")).await.is_err());

    p.b_online().await;
    let thread = eventually(|| async { p.moves_on_b().into_iter().next() }).await;
    eventually(|| async { (p.move_item(queued.operation_id).state == OutboxState::Delivered).then_some(()) }).await;
    let moved = p.parent_now().moved.unwrap();
    assert_eq!((moved.state, moved.peer_thread_id), (MoveState::Departed, Some(thread.id)));
    assert_ne!(moved.branch.as_deref(), Some("kybern/move-test"), "the move took a fresh snapshot");
    assert_eq!(std::fs::read_to_string(std::path::Path::new(&thread.cwd).join("new.txt")).unwrap(), "untracked work\n");
    assert_eq!(p.moves_on_b().len(), 1);
}
