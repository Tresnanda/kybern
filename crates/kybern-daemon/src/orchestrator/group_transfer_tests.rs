// Group projects across machines (ADE-92/91): fork, continue on and remote delegation of a thread whose
// project is a group of several repositories. Included into `orchestrator::tests` after `move_tests.rs`, so
// they share the two-daemon `Pair`, built here with `Pair::group`: machine "a" has the group `api` + `web`,
// machine "b" has the members listed. They skip on a computer without the `127.x.0.n` loopback aliases.

impl Pair {
    fn api_a(&self) -> PathBuf {
        self.repo_a.join("api")
    }

    fn web_a(&self) -> PathBuf {
        self.repo_a.join("web")
    }

    /// `api`: an unpushed commit, edits, an untracked file and an ignored `.env`. `web` stays clean.
    fn make_api_dirty(&self) {
        let api = self.api_a();
        std::fs::write(api.join(".gitignore"), ".env\n").unwrap();
        std::fs::write(api.join("tracked.txt"), "api\ntwo\n").unwrap();
        run_git(&api, &["add", ".gitignore", "tracked.txt"]);
        run_git(&api, &["commit", "-q", "-m", "unpushed api"]);
        std::fs::write(api.join("tracked.txt"), "api\ntwo\nthree\n").unwrap();
        std::fs::write(api.join("new.txt"), "untracked api work\n").unwrap();
        std::fs::write(api.join(".env"), "SECRET=1\n").unwrap();
    }

    /// The origins of both repositories: what a push would change.
    fn origins(&self) -> String {
        ["api", "web"].iter().map(|member| run_git(&self.cluster.dir.path().join(format!("origin-{member}.git")), &["for-each-ref"])).collect::<Vec<_>>().join("\n")
    }

    /// The branches and imported refs of a machine b member checkout: what a fork or move would leave there.
    fn kybern_refs_on_b(&self, member: &str) -> String {
        run_git(&self.repo_b.join(member), &["for-each-ref", "refs/heads", "refs/kybern"])
    }

    /// Where a member of a group thread lives on machine b.
    fn member_tree(thread: &Thread, member: &str) -> PathBuf {
        PathBuf::from(thread.members.iter().find(|m| m.path == member).and_then(|m| m.worktree.as_ref()).expect("a member worktree").path.clone())
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_group_fork_carries_each_members_branch_and_work_in_progress_and_pushes_nothing() {
    let Some(p) = Pair::group(&["api", "web"]).await else { return };
    p.make_api_dirty();
    let status_before = (run_git(&p.api_a(), &["status", "--porcelain"]), run_git(&p.web_a(), &["status", "--porcelain"]));
    let origins_before = p.origins();

    let fork = p.a.state.orchestrator.fork_to_machine(p.fork_params(false)).await.unwrap();
    assert!(fork.branch.starts_with("kybern/fork-"), "{}", fork.branch);
    assert!(fork.handoff_note.contains("api") && fork.handoff_note.contains("web"), "the note names the members: {}", fork.handoff_note);
    assert!(fork.handoff_note.contains("tracked.txt") && fork.handoff_note.contains("new.txt"), "{}", fork.handoff_note);

    let thread = eventually(|| async { p.forks_on_b().into_iter().next() }).await;
    eventually(|| async { (p.fork_item(fork.operation_id).state == OutboxState::Delivered).then_some(()) }).await;
    let worktree = thread.worktree.clone().expect("the fork gets a group worktree");
    assert_eq!((worktree.branch.as_str(), thread.cwd.as_str()), (fork.branch.as_str(), worktree.path.as_str()));
    assert_eq!(thread.members.iter().map(|m| (m.path.as_str(), m.included, m.worktree.is_some())).collect::<Vec<_>>(), [("api", true, true), ("web", true, true)]);
    assert!(thread.members.iter().all(|m| m.worktree.as_ref().is_some_and(|w| w.branch == fork.branch)));

    // api: the unpushed commit, the edits and the untracked file; the ignored file stays behind.
    let api = Pair::member_tree(&thread, "api");
    assert_eq!(api, std::path::Path::new(&thread.cwd).join("api"));
    assert_eq!(std::fs::read_to_string(api.join("tracked.txt")).unwrap(), "api\ntwo\nthree\n");
    assert_eq!(std::fs::read_to_string(api.join("new.txt")).unwrap(), "untracked api work\n");
    assert!(!api.join(".env").exists());
    assert_eq!(run_git(&api, &["rev-parse", "HEAD"]), fork.commit, "the result's commit is the first member's");
    // web was clean: its HEAD is the fork, with no snapshot commit on top.
    let web = Pair::member_tree(&thread, "web");
    assert_eq!(run_git(&web, &["rev-parse", "HEAD"]), run_git(&p.web_a(), &["rev-parse", "HEAD"]));
    assert_eq!(run_git(&web, &["rev-parse", "--abbrev-ref", "HEAD"]), fork.branch);

    // The note and the way back arrive as the first message; the agent starts in the container.
    let messages = p.user_messages_on_b(thread.id);
    assert_eq!(messages.len(), 1, "{messages:?}");
    assert!(messages[0].contains(&format!("kybern://thread/{}/{}", p.a.id(), p.parent.id)) && messages[0].contains("api and web"), "{}", messages[0]);
    assert_eq!(p.agent("# Hand-off:").await.cwd.to_string_lossy(), thread.cwd);

    // Machine a: each member has the branch, nothing in the working trees changed, and nothing was pushed.
    for (member, dir) in [("api", p.api_a()), ("web", p.web_a())] {
        assert!(!run_git(&dir, &["rev-parse", &format!("refs/heads/{}", fork.branch)]).is_empty(), "{member} has the fork branch");
    }
    assert_eq!(run_git(&p.api_a(), &["rev-parse", &format!("refs/heads/{}", fork.branch)]), fork.commit);
    assert_eq!((run_git(&p.api_a(), &["status", "--porcelain"]), run_git(&p.web_a(), &["status", "--porcelain"])), status_before);
    assert!(run_git(&p.api_a(), &["diff", "--cached", "--name-only"]).is_empty(), "the user's index is untouched");
    assert_eq!(p.origins(), origins_before, "the shared remotes never saw the branch");
    let (text, data) = p.notice_on_a(|text| text.starts_with("Forked to")).await;
    assert_eq!(text, format!("Forked to {} · open", p.b_name()));
    assert_eq!(data.unwrap()["thread_id"], json!(thread.id));
    // The transfer left no staged bundles or imported refs behind on b.
    assert!(!p.kybern_refs_on_b("api").contains("refs/kybern/incoming"), "{}", p.kybern_refs_on_b("api"));
    assert!(!p.kybern_refs_on_b("web").contains("refs/kybern/incoming"), "{}", p.kybern_refs_on_b("web"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_group_fork_pushes_every_members_branch_only_when_asked() {
    let Some(p) = Pair::group(&["api", "web"]).await else { return };
    p.make_api_dirty();
    let fork = p.a.state.orchestrator.fork_to_machine(p.fork_params(true)).await.unwrap();
    eventually(|| async { (p.fork_item(fork.operation_id).state == OutboxState::Delivered).then_some(()) }).await;
    for member in ["api", "web"] {
        let origin = p.cluster.dir.path().join(format!("origin-{member}.git"));
        assert!(!run_git(&origin, &["rev-parse", &format!("refs/heads/{}", fork.branch)]).is_empty(), "{member}'s branch is on its origin");
    }
    assert_eq!(p.forks_on_b().len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_group_missing_a_member_refuses_the_fork_by_name_and_transfers_nothing() {
    let Some(p) = Pair::group(&["api"]).await else { return };
    p.make_api_dirty();
    let refs_before = p.kybern_refs_on_b("api");
    let fork = p.a.state.orchestrator.fork_to_machine(p.fork_params(false)).await.unwrap();
    let item = eventually(|| async { Some(p.fork_item(fork.operation_id)).filter(|item| item.state == OutboxState::Failed) }).await;
    let reason = item.last_error.unwrap();
    assert!(reason.contains("missing web") && !reason.contains("missing api"), "names the missing repository: {reason}");
    assert!(p.forks_on_b().is_empty(), "no thread");
    assert_eq!(p.kybern_refs_on_b("api"), refs_before, "no bundle was imported and no branch was made");
    assert!(!p.cluster.dir.path().join("group-b").join("web").exists());
    let expected = format!("The fork to {} did not arrive", p.b_name());
    p.notice_on_a(|text| text.starts_with(&expected) && text.contains("web")).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_group_with_an_extra_member_does_not_match_either() {
    let Some(p) = Pair::group(&["api", "web"]).await else { return };
    // Machine b's group holds a repository the sender's group lacks.
    let project = p.b.state.store.projects_list().unwrap().into_iter().find(|project| project.kind == ProjectKind::Group).unwrap();
    let extra = p.repo_b.join("infra");
    std::fs::create_dir_all(&extra).unwrap();
    run_git(&extra, &["init", "-q", "-b", "main"]);
    std::fs::write(extra.join("x.txt"), "infra\n").unwrap();
    run_git(&extra, &["add", "."]);
    run_git(&extra, &["commit", "-q", "-m", "init infra"]);
    p.b.state.store.project_set_members(project.id, &["api".to_string(), "web".to_string(), "infra".to_string()]).unwrap();
    let fork = p.a.state.orchestrator.fork_to_machine(p.fork_params(false)).await.unwrap();
    let item = eventually(|| async { Some(p.fork_item(fork.operation_id)).filter(|item| item.state == OutboxState::Failed) }).await;
    let reason = item.last_error.unwrap();
    assert!(reason.contains("infra") && reason.contains("exactly the same repositories"), "{reason}");
    assert!(p.forks_on_b().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_machine_without_any_group_says_so() {
    let Some(p) = Pair::group(&["api", "web"]).await else { return };
    for project in p.b.state.store.projects_list().unwrap() {
        p.b.state.store.project_delete(project.id).unwrap();
    }
    let fork = p.a.state.orchestrator.fork_to_machine(p.fork_params(false)).await.unwrap();
    let item = eventually(|| async { Some(p.fork_item(fork.operation_id)).filter(|item| item.state == OutboxState::Failed) }).await;
    let reason = item.last_error.unwrap();
    assert!(reason.contains("no group project") && reason.contains("api and web"), "{reason}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_repeated_group_fork_and_a_repeated_delivery_are_the_same_thread() {
    let Some(p) = Pair::group(&["api", "web"]).await else { return };
    p.make_api_dirty();
    let operation_id = Uuid::now_v7();
    let mut params = p.fork_params(false);
    params.operation_id = Some(operation_id);
    let first = p.a.state.orchestrator.fork_to_machine(params.clone()).await.unwrap();
    let thread = eventually(|| async { p.forks_on_b().into_iter().next() }).await;
    eventually(|| async { (p.fork_item(operation_id).state == OutboxState::Delivered).then_some(()) }).await;

    std::fs::write(p.api_a().join("later.txt"), "after the fork\n").unwrap();
    let again = p.a.state.orchestrator.fork_to_machine(params).await.unwrap();
    assert_eq!((again.item.id, again.commit.as_str()), (first.item.id, first.commit.as_str()), "no second snapshot");

    // The same delivery again, as after a lost acknowledgement: b answers with the thread it made.
    let item = p.fork_item(operation_id);
    match p.a.state.orchestrator.remote_deliver_fork(&item).await {
        crate::orchestrator::remote_delegation::Delivery::Delivered(value) => {
            assert_eq!(serde_json::from_value::<PeerForkResult>(value).unwrap().thread_id, thread.id)
        }
        other => panic!("expected the delivery to be answered, got {other:?}"),
    }
    assert_eq!(p.forks_on_b().len(), 1);
    assert_eq!(p.user_messages_on_b(thread.id).len(), 1);
    for member in ["api", "web"] {
        let trees = run_git(&p.repo_b.join(member), &["worktree", "list", "--porcelain"]).matches("worktree ").count();
        assert_eq!(trees, 2, "{member} has its checkout and the one fork worktree");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_group_fork_for_an_offline_machine_waits_in_the_outbox_with_the_snapshot_already_taken() {
    let Some(p) = Pair::group(&["api", "web"]).await else { return };
    p.make_api_dirty();
    p.b_offline().await;
    let fork = p.a.state.orchestrator.fork_to_machine(p.fork_params(false)).await.unwrap();
    let item = p.fork_item(fork.operation_id);
    assert_eq!((item.kind, item.state), (OutboxKind::Fork, OutboxState::Queued));
    assert!(p.forks_on_b().is_empty());
    std::fs::write(p.api_a().join("new.txt"), "changed while b was away\n").unwrap();

    p.b_online().await;
    let thread = eventually(|| async { p.forks_on_b().into_iter().next() }).await;
    eventually(|| async { (p.fork_item(fork.operation_id).state == OutboxState::Delivered).then_some(()) }).await;
    assert_eq!(std::fs::read_to_string(Pair::member_tree(&thread, "api").join("new.txt")).unwrap(), "untracked api work\n");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_group_move_carries_every_member_and_the_conversation_and_leaves_a_read_only_source() {
    let Some(p) = Pair::group(&["api", "web"]).await else { return };
    p.make_api_dirty();
    p.idle_parent().await;
    let origins_before = p.origins();

    let queued = p.a.state.orchestrator.move_to_machine(p.move_params()).await.unwrap();
    let thread = eventually(|| async { p.moves_on_b().into_iter().next() }).await;
    eventually(|| async { (p.move_item(queued.operation_id).state == OutboxState::Delivered).then_some(()) }).await;

    let worktree = thread.worktree.clone().expect("the moved thread gets a group worktree");
    assert!(worktree.branch.starts_with("kybern/move-"), "{}", worktree.branch);
    assert_eq!(thread.members.iter().map(|m| (m.path.as_str(), m.included, m.worktree.is_some())).collect::<Vec<_>>(), [("api", true, true), ("web", true, true)]);
    let api = Pair::member_tree(&thread, "api");
    assert_eq!(std::fs::read_to_string(api.join("tracked.txt")).unwrap(), "api\ntwo\nthree\n");
    assert_eq!(std::fs::read_to_string(api.join("new.txt")).unwrap(), "untracked api work\n");
    assert_eq!(run_git(&Pair::member_tree(&thread, "web"), &["rev-parse", "HEAD"]), run_git(&p.web_a(), &["rev-parse", "HEAD"]));

    // The conversation is carried, and the first message is the note naming the group.
    let history = p.history_on_b(thread.id);
    assert_eq!(history.len(), 1, "{history:?}");
    assert!(history[0].2.iter().any(|item| item.role == HistoryRole::User && item.text.contains("coordinate the work")));
    let messages = p.user_messages_on_b(thread.id);
    assert_eq!(messages.len(), 1, "{messages:?}");
    assert!(messages[0].contains("api and web") && messages[0].contains(&worktree.branch), "{}", messages[0]);

    // The source is read-only with a link; its repositories are as they were; nothing was pushed.
    let moved = p.parent_now().moved.expect("the source records the move");
    assert_eq!((moved.state, moved.peer_thread_id), (MoveState::Departed, Some(thread.id)));
    let refused = p.a.state.orchestrator.send(p.parent.id, UserMessage::text("one more thing")).await.unwrap_err();
    assert!(format!("{refused:#}").contains("continues on"), "{refused:#}");
    assert_eq!(std::fs::read_to_string(p.api_a().join(".env")).unwrap(), "SECRET=1\n");
    assert!(run_git(&p.api_a(), &["diff", "--cached", "--name-only"]).is_empty());
    assert_eq!(p.origins(), origins_before);
    assert_eq!(p.moves_on_b().len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_group_move_to_a_machine_missing_a_member_is_refused_and_the_thread_stays_writable() {
    let Some(p) = Pair::group(&["web"]).await else { return };
    p.idle_parent().await;
    let queued = p.a.state.orchestrator.move_to_machine(p.move_params()).await.unwrap();
    let item = eventually(|| async { Some(p.move_item(queued.operation_id)).filter(|item| item.state == OutboxState::Failed) }).await;
    assert!(item.last_error.unwrap().contains("missing api"));
    assert!(p.moves_on_b().is_empty());
    assert!(p.parent_now().moved.is_none(), "the lease was released");
    p.send_ok("still mine").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_group_worktree_delegation_runs_in_the_matching_group_on_the_other_machine() {
    let Some(p) = Pair::group(&["api", "web"]).await else { return };
    p.make_api_dirty();
    let started = p.delegate(json!({"task": "Change both repositories", "workspace": "worktree"})).await;
    let task_id = task_id_of(&started);
    // Acceptance may outlive the call's short inline wait while member worktrees
    // are prepared. Observe the target's acknowledgement in durable task state.
    eventually(|| async { (p.row(task_id).state == RemoteChildState::Running).then_some(()) }).await;
    let status = p.tool("kybern_agent_status", json!({"task_ids": [task_id]})).await.unwrap();
    assert_eq!(status["agents"][0]["remote_state"], "running", "the target acknowledged: {status}");

    let child = eventually(|| async { p.child_on_b(task_id) }).await;
    let worktree = child.worktree.clone().expect("a worktree delegation gets a container");
    assert_eq!(worktree.branch, format!("kybern/{}", child.id));
    assert_eq!(child.cwd, worktree.path);
    assert_eq!(child.members.iter().map(|m| (m.path.as_str(), m.included, m.worktree.is_some())).collect::<Vec<_>>(), [("api", true, true), ("web", true, true)]);
    assert_eq!(child.parent_thread_id, None, "nothing on b is its parent");
    // The base is a's current state: the dirty api, the clean web.
    let api = Pair::member_tree(&child, "api");
    assert_eq!(std::fs::read_to_string(api.join("tracked.txt")).unwrap(), "api\ntwo\nthree\n");
    assert_eq!(std::fs::read_to_string(api.join("new.txt")).unwrap(), "untracked api work\n");
    assert_eq!(run_git(&Pair::member_tree(&child, "web"), &["rev-parse", "HEAD"]), run_git(&p.web_a(), &["rev-parse", "HEAD"]));
    // Nothing was pushed, and a's checkouts are untouched.
    assert_eq!(std::fs::read_to_string(p.api_a().join(".env")).unwrap(), "SECRET=1\n");

    let agent = p.agent("Change both repositories").await;
    assert_eq!(agent.cwd.to_string_lossy(), child.cwd);
    let web = Pair::member_tree(&child, "web");
    std::fs::write(web.join("b.txt"), "b\n").unwrap();
    run_git(&web, &["add", "."]);
    run_git(&web, &["commit", "-q", "-m", "web change"]);
    p.end_parent_turn().await;
    agent.finish("Changed web.").await;
    let items = eventually(|| async { Some(p.results()).filter(|items| !items.is_empty()) }).await;
    assert_eq!((items[0].task_id, items[0].status), (task_id, DelegationStatus::Completed));
    assert_eq!(items[0].branch.as_deref(), Some(worktree.branch.as_str()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_group_shared_delegation_works_in_the_target_group_folder() {
    let Some(p) = Pair::group(&["api", "web"]).await else { return };
    let started = p.delegate(json!({"task": "Look at both repositories"})).await;
    let task_id = task_id_of(&started);
    let child = eventually(|| async { p.child_on_b(task_id) }).await;
    assert_eq!(child.cwd, p.repo_b.to_string_lossy(), "a shared child works in the target's own group folder");
    assert!(child.worktree.is_none());
    assert_eq!(child.members.iter().map(|m| (m.path.as_str(), m.included)).collect::<Vec<_>>(), [("api", true), ("web", true)]);
    p.agent("Look at both repositories").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_group_delegation_to_a_group_missing_a_member_fails_with_the_missing_repository() {
    let Some(p) = Pair::group(&["api"]).await else { return };
    let started = p.delegate(json!({"task": "Change both repositories", "workspace": "worktree"})).await;
    let task_id = task_id_of(&started);
    let row = eventually(|| async { Some(p.row(task_id)).filter(|row| row.state.is_terminal()) }).await;
    assert!(row.info.error.unwrap().contains("missing web"));
    assert_eq!(p.children_on_b(), 0);
}
