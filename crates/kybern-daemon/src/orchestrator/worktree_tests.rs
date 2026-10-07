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
    fixture.orchestrator.worktree_remove(methods::WorktreeRemoveParams { thread_id: thread.id, force: false, delete_branch: true }).await.unwrap();
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
    let terminal = terminals.create(None, Some(thread.id), thread.cwd.clone(), 80, 24, Some(vec!["sh".into(), "-c".into(), "sleep 30".into()])).unwrap();
    Arc::get_mut(&mut fixture.orchestrator.inner).unwrap().app_tools = crate::app_tools::AppTools::new(fixture.store.clone(), terminals.clone());
    let orchestrator = &fixture.orchestrator;
    let inspected = orchestrator.worktree_inspect(thread.id).await.unwrap();
    assert!(!inspected.eligible);
    assert!(inspected.blockers.iter().any(|b| b.contains("terminals")));
    assert!(orchestrator.worktree_remove(methods::WorktreeRemoveParams { thread_id: thread.id, force: true, delete_branch: false }).await.is_err());
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
    fixture.orchestrator.emit(thread.id, None, EventPayload::ProviderNotice {
        level: NoticeLevel::Info, text: "Changed checkout".into(),
        data: Some(serde_json::json!({"workspace_transition":{"number":7,"branch":"review-branch","head":"review-head"}})),
    }).unwrap();
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
