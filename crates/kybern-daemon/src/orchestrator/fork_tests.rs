// Fork to a machine scenarios (ADE-86 F1, design §7.1, §11.2). Included into `orchestrator::tests`,
// after `remote_delegation_tests.rs`, so they share its two-daemon `Pair`: machine "a" has the thread
// that is forked and machine "b" receives it. They skip on a computer without the `127.x.0.n` loopback
// aliases.

impl Pair {
    fn fork_params(&self, push_origin: bool) -> ThreadsForkToMachineParams {
        ThreadsForkToMachineParams {
            thread_id: self.parent.id,
            machine: self.b.id(),
            project: None,
            push_origin,
            handoff_note: None,
            title: None,
            provider: None,
            model: None,
            effort: None,
            permission_mode: None,
            operation_id: None,
        }
    }

    /// An unpushed commit, edits to a tracked file, an untracked file and an ignored `.env` on machine a.
    fn make_dirty(&self) {
        std::fs::write(self.repo_a.join(".gitignore"), ".env\n").unwrap();
        std::fs::write(self.repo_a.join("tracked.txt"), "one\ntwo\n").unwrap();
        run_git(&self.repo_a, &["add", ".gitignore", "tracked.txt"]);
        run_git(&self.repo_a, &["commit", "-q", "-m", "unpushed"]);
        std::fs::write(self.repo_a.join("tracked.txt"), "one\ntwo\nthree\n").unwrap();
        std::fs::write(self.repo_a.join("new.txt"), "untracked work\n").unwrap();
        std::fs::write(self.repo_a.join(".env"), "SECRET=1\n").unwrap();
    }

    fn origin_dir(&self) -> PathBuf {
        self.cluster.dir.path().join("origin.git")
    }

    /// The threads on machine b that came from a fork.
    fn forks_on_b(&self) -> Vec<Thread> {
        self.b
            .state
            .store
            .threads_list(None, true)
            .unwrap()
            .into_iter()
            .filter(|thread| thread.origin.as_ref().is_some_and(|origin| origin.kind == OriginKind::Fork))
            .collect()
    }

    fn fork_item(&self, operation_id: Uuid) -> OutboxItem {
        self.a.state.store.outbox_get_by_operation(operation_id).unwrap().expect("the fork's outbox item")
    }

    fn user_messages_on_b(&self, thread_id: Uuid) -> Vec<String> {
        let events = self.b.state.store.events_for_thread(thread_id).unwrap();
        kybern_store::project_transcript(&events)
            .into_iter()
            .filter_map(|entry| match entry {
                TranscriptEntry::User { message, .. } => Some(message.plain_text()),
                _ => None,
            })
            .collect()
    }

    fn notices_on_a(&self) -> Vec<(String, Option<serde_json::Value>)> {
        self.a
            .state
            .store
            .events_for_thread(self.parent.id)
            .unwrap()
            .into_iter()
            .filter_map(|event| match event.payload {
                EventPayload::ProviderNotice { text, data, .. } => Some((text, data)),
                _ => None,
            })
            .collect()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_fork_carries_the_branch_and_the_work_in_progress_and_keeps_both_threads_live() {
    let Some(p) = Pair::new().await else { return };
    p.make_dirty();
    let remote_before = run_git(&p.repo_a, &["ls-remote", "origin"]);
    let status_before = run_git(&p.repo_a, &["status", "--porcelain"]);
    let origin_branches_before = run_git(&p.origin_dir(), &["for-each-ref"]);

    let fork = p.a.state.orchestrator.fork_to_machine(p.fork_params(false)).await.unwrap();
    assert!(fork.branch.starts_with("kybern/fork-"), "{}", fork.branch);
    assert!(fork.handoff_note.contains("# Hand-off:"), "{}", fork.handoff_note);
    assert!(fork.handoff_note.contains("coordinate the work"), "the goal is the first message: {}", fork.handoff_note);
    assert!(fork.handoff_note.contains("tracked.txt") && fork.handoff_note.contains("new.txt"), "{}", fork.handoff_note);

    // The thread opens on b with the note and the way back as its first message.
    let thread = eventually(|| async { p.forks_on_b().into_iter().next() }).await;
    eventually(|| async { (p.fork_item(fork.operation_id).state == OutboxState::Delivered).then_some(()) }).await;
    let origin = thread.origin.clone().unwrap();
    assert_eq!((origin.machine_id.as_str(), origin.thread_id, origin.operation_id), (p.a.id().as_str(), Some(p.parent.id), fork.operation_id));
    assert_eq!(origin.permission_cap, p.parent.permission_mode, "the cap defaults to the source's mode");
    assert_eq!(thread.permission_mode, p.parent.permission_mode);
    let worktree = thread.worktree.clone().expect("the fork gets a worktree");
    assert_eq!(worktree.branch, fork.branch);
    assert_eq!(thread.cwd, worktree.path);
    let messages = p.user_messages_on_b(thread.id);
    assert_eq!(messages.len(), 1, "{messages:?}");
    assert!(messages[0].contains("# Hand-off:"), "{}", messages[0]);
    assert!(messages[0].contains(&format!("kybern://thread/{}/{}", p.a.id(), p.parent.id)), "the link back is machine-qualified: {}", messages[0]);
    assert!(messages[0].contains(&fork.branch), "{}", messages[0]);
    p.agent("# Hand-off:").await;

    // The branch carries the unpushed commit, the edits and the untracked file, and leaves the ignored file behind.
    let dir = std::path::Path::new(&thread.cwd);
    assert_eq!(std::fs::read_to_string(dir.join("tracked.txt")).unwrap(), "one\ntwo\nthree\n");
    assert_eq!(std::fs::read_to_string(dir.join("new.txt")).unwrap(), "untracked work\n");
    assert!(dir.join(".gitignore").exists());
    assert!(!dir.join(".env").exists(), "ignored files stay behind");
    assert_eq!(run_git(dir, &["rev-parse", "HEAD"]), fork.commit);
    assert_eq!(run_git(dir, &["log", "-1", "--format=%s"]), "WIP from a");

    // Machine a: the branch exists, its working tree and index are as they were, and nothing was pushed.
    assert_eq!(run_git(&p.repo_a, &["rev-parse", &format!("refs/heads/{}", fork.branch)]), fork.commit);
    assert_eq!(run_git(&p.repo_a, &["status", "--porcelain"]), status_before);
    assert!(run_git(&p.repo_a, &["diff", "--cached", "--name-only"]).is_empty(), "the user's index is untouched");
    assert_eq!(std::fs::read_to_string(p.repo_a.join(".env")).unwrap(), "SECRET=1\n");
    assert_eq!(run_git(&p.repo_a, &["ls-remote", "origin"]), remote_before);
    assert_eq!(run_git(&p.origin_dir(), &["for-each-ref"]), origin_branches_before, "the shared remote never saw the branch");
    assert_eq!(run_git(&p.repo_b, &["ls-remote", "origin"]), remote_before);

    // Both threads stay live, and a's thread says where the fork went.
    let source = p.a.state.store.thread_get(p.parent.id).unwrap().unwrap();
    assert_ne!(source.status, ThreadStatus::Archived);
    let notices = p.notices_on_a();
    let (text, data) = notices.iter().find(|(text, _)| text.starts_with("Forked to")).expect("a notice on the source thread");
    assert_eq!(text, "Forked to b · open");
    let data = data.clone().unwrap();
    assert_eq!(data["thread_id"], json!(thread.id));
    assert_eq!(data["machine_id"], json!(p.b.id()));
    let item = p.fork_item(fork.operation_id);
    let result: PeerForkResult = serde_json::from_value(item.result.unwrap()).unwrap();
    assert_eq!((result.thread_id, result.branch.as_str()), (thread.id, fork.branch.as_str()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_fork_pushes_to_origin_only_when_asked() {
    let Some(p) = Pair::new().await else { return };
    p.make_dirty();
    let fork = p.a.state.orchestrator.fork_to_machine(p.fork_params(true)).await.unwrap();
    eventually(|| async { (p.fork_item(fork.operation_id).state == OutboxState::Delivered).then_some(()) }).await;
    assert_eq!(run_git(&p.origin_dir(), &["rev-parse", &format!("refs/heads/{}", fork.branch)]), fork.commit, "the branch is on origin");
    assert_eq!(p.forks_on_b().len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_push_that_origin_refuses_fails_the_fork_with_the_reason_and_sends_nothing() {
    let Some(p) = Pair::new().await else { return };
    p.make_dirty();
    run_git(&p.repo_a, &["remote", "set-url", "origin", "/nonexistent/origin.git"]);
    let fork = p.a.state.orchestrator.fork_to_machine(p.fork_params(true)).await.unwrap();
    let item = eventually(|| async { Some(p.fork_item(fork.operation_id)).filter(|item| item.state == OutboxState::Failed) }).await;
    assert!(item.last_error.unwrap().contains("push"), "the error says what to do");
    assert!(p.forks_on_b().is_empty(), "nothing was sent");
    assert!(p.notices_on_a().iter().any(|(text, _)| text.starts_with("The fork to b did not arrive")));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_repeated_fork_is_the_same_fork_and_a_repeated_delivery_is_the_same_thread() {
    let Some(p) = Pair::new().await else { return };
    p.make_dirty();
    let operation_id = Uuid::now_v7();
    let mut params = p.fork_params(false);
    params.operation_id = Some(operation_id);
    let first = p.a.state.orchestrator.fork_to_machine(params.clone()).await.unwrap();
    let thread = eventually(|| async { p.forks_on_b().into_iter().next() }).await;
    eventually(|| async { (p.fork_item(operation_id).state == OutboxState::Delivered).then_some(()) }).await;

    // The same request again: the same item, branch and commit, no second snapshot.
    std::fs::write(p.repo_a.join("later.txt"), "after the fork\n").unwrap();
    let again = p.a.state.orchestrator.fork_to_machine(params.clone()).await.unwrap();
    assert_eq!((again.item.id, again.branch.as_str(), again.commit.as_str()), (first.item.id, first.branch.as_str(), first.commit.as_str()));
    // Another thread's fork may not reuse the key.
    let mut other = params.clone();
    other.thread_id = Uuid::now_v7();
    assert!(p.a.state.orchestrator.fork_to_machine(other).await.is_err());

    // The same delivery again, as after a lost acknowledgement: b answers with the thread it made.
    let item = p.fork_item(operation_id);
    match p.a.state.orchestrator.remote_deliver_fork(&item).await {
        Delivery::Delivered(value) => assert_eq!(serde_json::from_value::<PeerForkResult>(value).unwrap().thread_id, thread.id),
        other => panic!("expected the delivery to be answered, got {other:?}"),
    }
    assert_eq!(p.forks_on_b().len(), 1, "one thread");
    assert_eq!(p.user_messages_on_b(thread.id).len(), 1, "one note");
    assert_eq!(p.a.state.store.outbox_list(None, None).unwrap().len(), 1, "one outbox item");

    // A second fork of the same thread is a second thread.
    let second = p.a.state.orchestrator.fork_to_machine(p.fork_params(false)).await.unwrap();
    assert_ne!(second.branch, first.branch);
    eventually(|| async { (p.forks_on_b().len() == 2).then_some(()) }).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_fork_for_an_offline_machine_waits_in_the_outbox_and_arrives_when_it_returns() {
    let Some(p) = Pair::new().await else { return };
    p.make_dirty();
    p.b_offline().await;
    let fork = p.a.state.orchestrator.fork_to_machine(p.fork_params(false)).await.unwrap();
    // Queued and visible, nothing on b, and the source says it is waiting.
    let item = p.fork_item(fork.operation_id);
    assert_eq!((item.kind, item.state, item.target.as_str()), (OutboxKind::Fork, OutboxState::Queued, p.b.id().as_str()));
    assert_eq!(item.origin.as_ref().unwrap().kind, OriginKind::Fork);
    assert!(p.forks_on_b().is_empty());
    assert!(p.notices_on_a().iter().any(|(text, _)| text.contains("waiting for it to come online")));
    // The snapshot is already taken: changing the files now does not change what is sent.
    std::fs::write(p.repo_a.join("new.txt"), "changed while b was away\n").unwrap();

    p.b_online().await;
    let thread = eventually(|| async { p.forks_on_b().into_iter().next() }).await;
    eventually(|| async { (p.fork_item(fork.operation_id).state == OutboxState::Delivered).then_some(()) }).await;
    assert_eq!(std::fs::read_to_string(std::path::Path::new(&thread.cwd).join("new.txt")).unwrap(), "untracked work\n");
    assert_eq!(p.forks_on_b().len(), 1);
    assert!(p.notices_on_a().iter().any(|(text, _)| text == "Forked to b · open"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_fork_can_be_queued_through_the_outbox_like_any_other_operation() {
    let Some(p) = Pair::new().await else { return };
    p.make_dirty();
    p.b_offline().await;
    let mut params = p.fork_params(false);
    params.machine = String::new();
    let operation_id = Uuid::now_v7();
    let item = crate::orchestrator::fork_machine::serve_fork_enqueue(
        &p.a.state,
        OutboxEnqueueParams {
            target: p.b.id(),
            operation: OutboxOp { kind: OutboxKind::Fork, payload: serde_json::to_value(&params).unwrap(), operation_id: Some(operation_id) },
        },
    )
    .await
    .unwrap();
    assert_eq!((item.operation_id, item.kind, item.state), (operation_id, OutboxKind::Fork, OutboxState::Queued));
    p.b_online().await;
    eventually(|| async { p.forks_on_b().into_iter().next() }).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_forked_thread_is_the_users_own_and_other_threads_are_not_forkable_onward() {
    let Some(p) = Pair::new().await else { return };
    p.make_dirty();
    let fork = p.a.state.orchestrator.fork_to_machine(p.fork_params(false)).await.unwrap();
    let thread = eventually(|| async { p.forks_on_b().into_iter().next() }).await;
    eventually(|| async { (p.fork_item(fork.operation_id).state == OutboxState::Delivered).then_some(()) }).await;
    assert!(!super::fork_machine::second_hop(&thread), "a fork can use the machine tools and delegate like any thread");

    // A thread another machine started cannot be forked to a third.
    let mut inbound = p.a.state.store.thread_get(p.parent.id).unwrap().unwrap();
    inbound.origin = Some(Origin {
        machine_id: p.b.id(),
        machine_name: "b".into(),
        thread_id: None,
        operation_id: Uuid::now_v7(),
        kind: OriginKind::Delegation { task_id: Uuid::now_v7().to_string() },
        permission_cap: PermissionMode::Supervised,
        hops: vec![p.b.id()],
    });
    p.a.state.store.thread_upsert(&inbound).unwrap();
    let error = p.a.state.orchestrator.fork_to_machine(p.fork_params(false)).await.unwrap_err();
    assert_eq!(error.code, codes::CONFLICT, "{}", error.message);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_machine_without_the_repository_refuses_the_fork_and_the_item_fails_with_why() {
    let Some(p) = Pair::new().await else { return };
    for project in p.b.state.store.projects_list().unwrap() {
        p.b.state.store.project_delete(project.id).unwrap();
    }
    let fork = p.a.state.orchestrator.fork_to_machine(p.fork_params(false)).await.unwrap();
    let item = eventually(|| async { Some(p.fork_item(fork.operation_id)).filter(|item| item.state == OutboxState::Failed) }).await;
    assert!(item.last_error.unwrap().contains("no checkout"), "names the problem");
    assert!(p.forks_on_b().is_empty());
}
