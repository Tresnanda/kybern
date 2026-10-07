use kybern_git::Repo;
// Included into the parent fixture module: no real user worktrees or daemons.
async fn ordinary_worktree_fixture() -> (Fixture, Thread) {
    let mut fixture = Fixture::new();
    init_project_repo(&fixture.root);
    fixture.project.is_git = true;
    fixture.store.project_update(&fixture.project).unwrap();
    let mut thread = fixture.thread(ThreadStatus::Idle);
    let wt = fixture.orchestrator.create_worktree(&fixture.project, thread.id, None).await.unwrap();
    thread.cwd = wt.path.clone();
    thread.worktree = Some(wt);
    fixture.store.thread_upsert(&thread).unwrap();
    (fixture, thread)
}

#[tokio::test]
async fn ordinary_cleanup_requires_confirmation_and_restores_dirty_source_on_its_branch() {
    let (fixture, thread) = ordinary_worktree_fixture().await;
    let path = PathBuf::from(&thread.cwd);
    std::fs::write(path.join("tracked.txt"), "source to recover\n").unwrap();
    std::fs::write(path.join("deliverable.txt"), "untracked deliverable\n").unwrap();
    let params = methods::WorktreeRemoveParams { thread_id: thread.id, force: false, delete_branch: false };
    assert!(fixture.orchestrator.worktree_remove(params.clone()).await.is_err());
    assert!(path.exists());
    let removed = fixture.orchestrator.worktree_remove(methods::WorktreeRemoveParams { force: true, ..params }).await.unwrap();
    assert!(!removed.exists);
    assert!(!path.exists());
    let retained = fixture.store.thread_get(thread.id).unwrap().unwrap();
    assert_eq!(retained.cwd, thread.cwd);
    assert_eq!(retained.worktree.as_ref().unwrap().branch, thread.worktree.as_ref().unwrap().branch);
    assert!(Repo::new(&fixture.project.path).rev_parse(&retained.worktree.as_ref().unwrap().branch).await.is_ok());
    fixture.orchestrator.restore_worktree_if_cleaned(&retained).await.unwrap();
    assert_eq!(std::fs::read_to_string(path.join("tracked.txt")).unwrap(), "source to recover\n");
    assert_eq!(std::fs::read_to_string(path.join("deliverable.txt")).unwrap(), "untracked deliverable\n");
    assert_eq!(Repo::new(&path).current_branch().await, Some(retained.worktree.unwrap().branch));
    assert!(fixture.store.events_for_thread(thread.id).unwrap().iter().any(|e| matches!(e.payload, EventPayload::WorktreeRestored { .. })));
}

#[tokio::test]
async fn ordinary_cleanup_keeps_unmerged_branch_and_only_deletes_merged_branch() {
    let (fixture, thread) = ordinary_worktree_fixture().await;
    let path = PathBuf::from(&thread.cwd);
    std::fs::write(path.join("tracked.txt"), "committed work\n").unwrap();
    run_git(&path, &["add", "."]);
    run_git(&path, &["commit", "-qm", "unmerged work"]);
    let inspected = fixture.orchestrator.worktree_inspect(thread.id).await.unwrap();
    assert!(inspected.clean);
    assert!(!inspected.merged);
    let params = methods::WorktreeRemoveParams { thread_id: thread.id, force: true, delete_branch: true };
    assert!(fixture.orchestrator.worktree_remove(params.clone()).await.is_err());
    assert!(path.exists());
    fixture.orchestrator.worktree_remove(methods::WorktreeRemoveParams { delete_branch: false, ..params }).await.unwrap();
    fixture.orchestrator.restore_worktree_if_cleaned(&thread).await.unwrap();
    assert_eq!(std::fs::read_to_string(path.join("tracked.txt")).unwrap(), "committed work\n");
    run_git(&fixture.root, &["merge", "--ff-only", &thread.worktree.as_ref().unwrap().branch]);
    fixture
        .orchestrator
        .worktree_remove(methods::WorktreeRemoveParams { thread_id: thread.id, force: false, delete_branch: true })
        .await
        .unwrap();
    assert!(Repo::new(&fixture.root).rev_parse(&thread.worktree.as_ref().unwrap().branch).await.is_err());
    fixture.orchestrator.restore_worktree_if_cleaned(&thread).await.unwrap();
    assert_eq!(std::fs::read_to_string(path.join("tracked.txt")).unwrap(), "committed work\n");
}

#[tokio::test]
async fn ordinary_cleanup_protects_shared_owners_running_turns_and_ignored_files_even_with_force() {
    let (fixture, mut thread) = ordinary_worktree_fixture().await;
    let params = methods::WorktreeRemoveParams { thread_id: thread.id, force: true, delete_branch: false };
    thread.status = ThreadStatus::Running;
    fixture.store.thread_upsert(&thread).unwrap();
    assert!(fixture.orchestrator.worktree_remove(params.clone()).await.is_err());
    thread.status = ThreadStatus::Idle;
    fixture.store.thread_upsert(&thread).unwrap();
    let mut owner = fixture.thread(ThreadStatus::Archived);
    owner.cwd = thread.cwd.clone();
    fixture.store.thread_upsert(&owner).unwrap();
    assert!(fixture.orchestrator.worktree_remove(params.clone()).await.is_err());
    owner.cwd = fixture.project.path.clone();
    fixture.store.thread_upsert(&owner).unwrap();
    let path = PathBuf::from(&thread.cwd);
    std::fs::write(path.join(".gitignore"), "important-ignored.txt\n").unwrap();
    std::fs::write(path.join("important-ignored.txt"), "must not disappear").unwrap();
    let inspected = fixture.orchestrator.worktree_inspect(thread.id).await.unwrap();
    assert_eq!(inspected.ignored_files, 1);
    assert!(fixture.orchestrator.worktree_remove(params).await.is_err());
    assert_eq!(std::fs::read_to_string(path.join("important-ignored.txt")).unwrap(), "must not disappear");
}

#[tokio::test]
async fn ordinary_cleanup_automatic_is_opt_in_and_missing_external_folders_do_not_switch_to_main() {
    let (fixture, mut thread) = ordinary_worktree_fixture().await;
    thread.status = ThreadStatus::Archived;
    fixture.store.thread_upsert(&thread).unwrap();
    fixture.orchestrator.cleanup_eligible_worktrees().await;
    assert!(PathBuf::from(&thread.cwd).exists(), "automatic removal defaults off");
    let mut settings = fixture.orchestrator.inner.settings.get();
    settings.automatic_worktree_cleanup = true;
    fixture.orchestrator.inner.settings.set(settings).unwrap();
    fixture.orchestrator.cleanup_eligible_worktrees().await;
    assert!(!PathBuf::from(&thread.cwd).exists());
    fixture.orchestrator.restore_worktree_if_cleaned(&thread).await.unwrap();
    let mut external = fixture.thread(ThreadStatus::Idle);
    external.cwd = fixture.root.join("missing-external-tree").to_string_lossy().into_owned();
    external.worktree = Some(WorktreeInfo { path: external.cwd.clone(), branch: "external".into() });
    assert!(fixture.orchestrator.restore_worktree_if_cleaned(&external).await.is_err());
    assert!(!PathBuf::from(external.cwd).exists());
}

#[tokio::test]
async fn ordinary_cleanup_protects_live_terminals_and_os_processes() {
    let (mut fixture, thread) = ordinary_worktree_fixture().await;
    let terminals = crate::terminal::TerminalManager::default();
    let terminal = terminals
        .create(None, Some(thread.id), thread.cwd.clone(), 80, 24, Some(vec!["sh".into(), "-c".into(), "sleep 30".into()]))
        .unwrap();
    Arc::get_mut(&mut fixture.orchestrator.inner).unwrap().app_tools =
        crate::app_tools::AppTools::new(fixture.store.clone(), terminals.clone());
    let orchestrator = &fixture.orchestrator;
    let inspected = orchestrator.worktree_inspect(thread.id).await.unwrap();
    assert!(!inspected.eligible);
    assert!(inspected.blockers.iter().any(|b| b.contains("terminals")));
    assert!(
        orchestrator
            .worktree_remove(methods::WorktreeRemoveParams { thread_id: thread.id, force: true, delete_branch: false })
            .await
            .is_err()
    );
    terminals.close(terminal.info().id).unwrap();
    let mut process = tokio::process::Command::new("sleep").arg("30").current_dir(&thread.cwd).kill_on_drop(true).spawn().unwrap();
    let inspected = fixture.orchestrator.worktree_inspect(thread.id).await.unwrap();
    assert!(inspected.blockers.iter().any(|b| b.contains("process is using")));
    process.kill().await.unwrap();
    process.wait().await.unwrap();
}

#[test]
fn checkout_transition_is_bounded_provider_only_context_and_retries_until_delivery() {
    let fixture = Fixture::new();
    let thread = fixture.thread(ThreadStatus::Idle);
    fixture
        .orchestrator
        .emit(
            thread.id,
            None,
            EventPayload::ProviderNotice {
                level: NoticeLevel::Info,
                text: "Changed checkout".into(),
                data: Some(serde_json::json!({"workspace_transition":{"number":7,"branch":"review-branch","head":"review-head"}})),
            },
        )
        .unwrap();
    let human = UserMessage::text("Continue repairing");
    let (provider, sequence) = fixture.orchestrator.workspace_transition_message(&thread, &human).unwrap();
    assert!(sequence.is_some());
    assert_eq!(human.parts.len(), 1, "the retained human message is untouched");
    assert!(serde_json::to_string(&provider).unwrap().contains("review-branch"));
    let (_, retry) = fixture.orchestrator.workspace_transition_message(&thread, &human).unwrap();
    assert_eq!(retry, sequence, "a failure before delivery does not consume context");
    fixture.orchestrator.workspace_transition_delivered(thread.id, sequence.unwrap()).unwrap();
    let (next, cleared) = fixture.orchestrator.workspace_transition_message(&thread, &human).unwrap();
    assert_eq!(next, human);
    assert!(cleared.is_none());
}

#[tokio::test]
async fn cleanup_closes_an_idle_agent_before_rechecking_external_process_ownership() {
    let (fixture, thread) = ordinary_worktree_fixture().await;
    let (_, closes) = fixture.park(&thread, Instant::now()).await;
    let mut external = tokio::process::Command::new("sleep").arg("30").current_dir(&thread.cwd).kill_on_drop(true).spawn().unwrap();
    // Inspection permits the explicit close/recheck operation, without stopping
    // a process from a read-only request or assuming the external cwd is safe.
    assert!(fixture.orchestrator.worktree_inspect(thread.id).await.unwrap().eligible);
    assert_eq!(closes.load(Ordering::Relaxed), 0);
    assert!(
        fixture
            .orchestrator
            .worktree_remove(methods::WorktreeRemoveParams { thread_id: thread.id, force: false, delete_branch: false })
            .await
            .is_err()
    );
    assert_eq!(closes.load(Ordering::Relaxed), 1);
    assert!(PathBuf::from(&thread.cwd).exists());
    assert!(fixture.orchestrator.worktree_inspect(thread.id).await.unwrap().blockers.iter().any(|b| b.contains("process is using")));
    external.kill().await.unwrap();
    external.wait().await.unwrap();
    fixture
        .orchestrator
        .worktree_remove(methods::WorktreeRemoveParams { thread_id: thread.id, force: false, delete_branch: false })
        .await
        .unwrap();
    assert!(!PathBuf::from(&thread.cwd).exists());
}

fn repair_checkout_params(thread: &Thread, number: u64, head: &str) -> methods::PrActionParams {
    serde_json::from_value(serde_json::json!({
        "project_id":thread.project_id,"thread_id":thread.id,"number":number,
        "action":"checkout","head_sha":head,"for_repair":true,
    }))
    .unwrap()
}

fn record_pr_receipt(fixture: &Fixture, thread: &Thread, number: u64, head: &str, verified: bool) {
    fixture
        .orchestrator
        .emit(
            thread.id,
            None,
            EventPayload::ProviderNotice {
                level: NoticeLevel::Info,
                text: "PR checkout receipt".into(),
                data: Some(serde_json::json!({"workspace_transition":{
                    "number":number,"branch":thread.worktree.as_ref().unwrap().branch,"head":head,"verified":verified,
                }})),
            },
        )
        .unwrap();
}

#[tokio::test]
async fn repair_preparation_keeps_proven_local_commits_staged_dirty_and_ignored_source() {
    let (fixture, thread) = ordinary_worktree_fixture().await;
    let path = PathBuf::from(&thread.cwd);
    let repo = Repo::new(&path);
    let original = repo.rev_parse("HEAD").await.unwrap();
    record_pr_receipt(&fixture, &thread, 7, &original, true);
    std::fs::write(path.join("tracked.txt"), "local committed repair\n").unwrap();
    run_git(&path, &["add", "."]);
    run_git(&path, &["commit", "-qm", "local repair"]);
    let local_head = repo.rev_parse("HEAD").await.unwrap();
    std::fs::write(path.join("tracked.txt"), "staged repair\n").unwrap();
    run_git(&path, &["add", "tracked.txt"]);
    std::fs::write(path.join("tracked.txt"), "unfinished repair\n").unwrap();
    std::fs::write(path.join("deliverable.txt"), "untracked source\n").unwrap();
    std::fs::write(path.join(".gitignore"), "build-output\n").unwrap();
    std::fs::write(path.join("build-output"), "retained build output\n").unwrap();
    let before = crate::github::run(&path, "git", &["status", "--porcelain=v1"]).await.unwrap();
    let staged = crate::github::run(&path, "git", &["show", ":tracked.txt"]).await.unwrap();
    let (_, closes) = fixture.park(&thread, Instant::now()).await;
    let params = repair_checkout_params(&thread, 7, &original);
    fixture.orchestrator.pr_checkout_at_head(&params, &original, thread.clone()).await.unwrap();
    assert_eq!(repo.rev_parse("HEAD").await.unwrap(), local_head);
    assert_eq!(crate::github::run(&path, "git", &["status", "--porcelain=v1"]).await.unwrap(), before);
    assert_eq!(crate::github::run(&path, "git", &["show", ":tracked.txt"]).await.unwrap(), staged);
    assert_eq!(std::fs::read_to_string(path.join("tracked.txt")).unwrap(), "unfinished repair\n");
    assert_eq!(std::fs::read_to_string(path.join("build-output")).unwrap(), "retained build output\n");
    assert_eq!(closes.load(Ordering::Relaxed), 0, "verified reuse keeps the native session");
}

#[tokio::test]
async fn same_branch_name_does_not_prove_a_different_pr_or_head_owns_dirty_repair_source() {
    let (fixture, thread) = ordinary_worktree_fixture().await;
    let path = PathBuf::from(&thread.cwd);
    let head = Repo::new(&path).rev_parse("HEAD").await.unwrap();
    record_pr_receipt(&fixture, &thread, 7, &head, true);
    std::fs::write(path.join("tracked.txt"), "must remain on this PR\n").unwrap();
    for params in [repair_checkout_params(&thread, 8, &head), repair_checkout_params(&thread, 7, "different-head")] {
        assert!(!fixture.orchestrator.pr_repair_receipt_matches(&thread, &params).await.unwrap());
        assert!(fixture.orchestrator.pr_checkout_at_head(&params, &params.head_sha, thread.clone()).await.is_err());
        assert_eq!(Repo::new(&path).rev_parse("HEAD").await.unwrap(), head);
        assert_eq!(std::fs::read_to_string(path.join("tracked.txt")).unwrap(), "must remain on this PR\n");
    }
}

#[tokio::test]
async fn changed_remote_head_rejects_preparation_before_git_or_native_mutations() {
    let (fixture, thread) = ordinary_worktree_fixture().await;
    let path = PathBuf::from(&thread.cwd);
    let head = Repo::new(&path).rev_parse("HEAD").await.unwrap();
    let (_, closes) = fixture.park(&thread, Instant::now()).await;
    let params = repair_checkout_params(&thread, 7, &head);
    let before = fixture.store.events_for_thread(thread.id).unwrap().len();
    assert!(fixture.orchestrator.pr_checkout_at_head(&params, "new-remote-head", thread.clone()).await.is_err());
    assert_eq!(Repo::new(&path).rev_parse("HEAD").await.unwrap(), head);
    assert_eq!(fixture.store.events_for_thread(thread.id).unwrap().len(), before);
    assert_eq!(closes.load(Ordering::Relaxed), 0);
}

#[tokio::test]
async fn newest_failed_checkout_receipt_prevents_reuse_and_running_foreground_blocks_known_repair() {
    let (fixture, mut thread) = ordinary_worktree_fixture().await;
    let head = Repo::new(&thread.cwd).rev_parse("HEAD").await.unwrap();
    let params = repair_checkout_params(&thread, 7, &head);
    record_pr_receipt(&fixture, &thread, 7, &head, true);
    assert!(fixture.orchestrator.pr_repair_receipt_matches(&thread, &params).await.unwrap());
    record_pr_receipt(&fixture, &thread, 7, &head, false);
    assert!(!fixture.orchestrator.pr_repair_receipt_matches(&thread, &params).await.unwrap());
    record_pr_receipt(&fixture, &thread, 7, &head, true);
    thread.status = ThreadStatus::Running;
    fixture.store.thread_upsert(&thread).unwrap();
    assert!(fixture.orchestrator.pr_checkout_at_head(&params, &head, thread.clone()).await.is_err());
    assert_eq!(Repo::new(&thread.cwd).rev_parse("HEAD").await.unwrap(), head);
}

#[tokio::test]
async fn partial_checkout_receipt_saves_actual_branch_and_head_but_cannot_authorize_repair() {
    let (fixture, mut thread) = ordinary_worktree_fixture().await;
    let path = PathBuf::from(&thread.cwd);
    let expected = Repo::new(&path).rev_parse("HEAD").await.unwrap();
    let params = repair_checkout_params(&thread, 7, &expected);
    record_pr_receipt(&fixture, &thread, 7, &expected, true);
    run_git(&path, &["checkout", "-qb", "partially-changed-checkout"]);
    std::fs::write(path.join("tracked.txt"), "changed during checkout\n").unwrap();
    run_git(&path, &["add", "."]);
    run_git(&path, &["commit", "-qm", "unexpected fetched head"]);
    let actual = Repo::new(&path).rev_parse("HEAD").await.unwrap();
    fixture.orchestrator.record_pr_checkout_state(&mut thread, &params, Some("partially-changed-checkout"), &actual, false).unwrap();
    let saved = fixture.store.thread_get(thread.id).unwrap().unwrap();
    assert_eq!(saved.worktree.as_ref().unwrap().branch, "partially-changed-checkout");
    let events = fixture.store.events_for_thread(thread.id).unwrap();
    let marker = events
        .iter()
        .rev()
        .find_map(|event| match &event.payload {
            EventPayload::ProviderNotice { data: Some(data), .. } => data.get("workspace_transition"),
            _ => None,
        })
        .unwrap();
    assert_eq!(marker["head"].as_str(), Some(actual.as_str()));
    assert_eq!(marker["verified"].as_bool(), Some(false));
    assert!(!fixture.orchestrator.pr_repair_receipt_matches(&saved, &params).await.unwrap());
    let (context, _) = fixture.orchestrator.workspace_transition_message(&saved, &UserMessage::text("Inspect the checkout")).unwrap();
    assert!(serde_json::to_string(&context).unwrap().contains("PR identity was not verified"));
}
