// Group-project git fan-out tests. Included into `orchestrator::tests` so they
// can use its fixture.

fn group_git(dir: &std::path::Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {}: {}", args.join(" "), String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn group_member_repo(dir: &std::path::Path, file: &str) {
    std::fs::create_dir_all(dir).unwrap();
    group_git(dir, &["init", "-q"]);
    group_git(dir, &["symbolic-ref", "HEAD", "refs/heads/main"]);
    group_git(dir, &["config", "user.name", "Group Test"]);
    group_git(dir, &["config", "user.email", "group@example.com"]);
    std::fs::write(dir.join(file), "one\n").unwrap();
    group_git(dir, &["add", "."]);
    group_git(dir, &["commit", "-q", "-m", "init"]);
}

/// A group project "acme" of three repositories (api, web, infra), optionally
/// with the group folder itself a repository and a member.
struct Group {
    fixture: Fixture,
    project: Project,
    folder: std::path::PathBuf,
}

impl Group {
    fn new(folder_is_member: bool) -> Self {
        let fixture = Fixture::new();
        let folder = fixture.root.join("acme");
        std::fs::create_dir_all(&folder).unwrap();
        if folder_is_member {
            // The folder's repository ignores nothing: its nested members must
            // stay out of it through exclusions alone.
            group_member_repo(&folder, "README.md");
        }
        for (member, file) in [("api", "lib.rs"), ("web", "app.ts"), ("infra", "main.tf")] {
            group_member_repo(&folder.join(member), file);
        }
        std::fs::write(folder.join("AGENTS.md"), "# acme\n").unwrap();
        std::fs::write(folder.join("CLAUDE.md"), "@AGENTS.md\n").unwrap();
        std::fs::create_dir_all(folder.join(".claude")).unwrap();
        std::fs::write(folder.join(".claude/settings.local.json"), "{}").unwrap();
        std::fs::write(folder.join("Makefile"), "all:\n").unwrap();
        let mut paths = vec!["api", "infra", "web"];
        if folder_is_member {
            paths.insert(0, ".");
        }
        let now = chrono::Utc::now();
        let project = Project {
            repo: None,
            repos: Vec::new(),
            id: Uuid::now_v7(),
            name: "acme".into(),
            path: folder.to_string_lossy().into_owned(),
            is_git: folder_is_member,
            worktrees_default: None,
            task_prefix: None,
            brief_in_all_threads: false,
            coordinator: None,
            space_id: None,
            created_at: now,
            updated_at: now,
            kind: ProjectKind::Group,
            members: paths
                .iter()
                .map(|path| ProjectMember { path: (*path).into(), name: String::new(), status: MemberStatus::Ok })
                .collect(),
            worktree_copy: vec!["Makefile".into(), "gone.txt".into(), "api".into()],
            instructions_offer_dismissed: false,
        };
        fixture.store.project_insert(&project).unwrap();
        let project = fixture.store.project_get(project.id).unwrap().unwrap();
        Self { fixture, project, folder }
    }

    fn params(&self, worktree: bool, members: Option<&[&str]>) -> methods::ThreadsCreateParams {
        methods::ThreadsCreateParams {
            pin_account: false,
            project_id: Some(self.project.id),
            provider: ProviderInstance::default_for(ProviderKind::Codex),
            model: None,
            effort: None,
            permission_mode: None,
            use_worktree: Some(worktree),
            base_branch: None,
            title: Some("Group".into()),
            message: None,
            thread_id: None,
            message_id: None,
            members: members.map(|m| m.iter().map(|p| p.to_string()).collect()),
            base_branches: None,
        }
    }

    async fn create(&self, worktree: bool, members: Option<&[&str]>) -> Thread {
        self.fixture.orchestrator.create_thread(self.params(worktree, members)).await.unwrap()
    }

    /// Run a turn's checkpoints around `edit`.
    async fn turn(&self, thread: &Thread, edit: impl FnOnce()) -> TurnId {
        let turn = Uuid::now_v7();
        self.fixture.orchestrator.checkpoint(thread, turn, "before").await;
        edit();
        self.fixture.orchestrator.checkpoint(thread, turn, "after").await;
        turn
    }
}

#[tokio::test]
async fn group_worktree_thread_gets_a_container_with_one_worktree_per_included_member() {
    let group = Group::new(false);
    let mut progress = group.fixture.orchestrator.subscribe_workspace_progress();
    let thread = group.create(true, Some(&["api", "web"])).await;
    let container = std::path::PathBuf::from(&thread.cwd);
    let branch = format!("kybern/{}", thread.id);
    assert_eq!(thread.worktree.as_ref().map(|w| (w.path.as_str(), w.branch.as_str())), Some((thread.cwd.as_str(), branch.as_str())));
    assert!(group.fixture.orchestrator.is_managed_worktree(&container, &thread.id.to_string()));
    for member in ["api", "web"] {
        assert_eq!(group_git(&container.join(member), &["branch", "--show-current"]), branch);
    }
    assert!(!container.join("infra").exists(), "a deselected member gets no worktree");
    assert_eq!(std::fs::read_to_string(container.join("AGENTS.md")).unwrap(), "# acme\n");
    assert!(container.join("CLAUDE.md").exists() && container.join(".claude/settings.local.json").exists());
    assert!(container.join("Makefile").exists(), "worktree_copy entries are copied");
    assert!(!container.join("gone.txt").exists());

    let members: Vec<_> = thread.members.iter().map(|m| (m.path.as_str(), m.included, m.worktree.is_some())).collect();
    assert_eq!(members, [("api", true, true), ("infra", false, false), ("web", true, true)]);
    let infra = &thread.members[1];
    assert_eq!(std::path::PathBuf::from(&infra.source_path), group.folder.join("infra"));
    assert_eq!(thread.members[0].base_branch.as_deref(), Some("main"));
    assert_eq!(group.fixture.store.thread_get(thread.id).unwrap().unwrap().members, thread.members, "the snapshot is stored");

    let mut seen = Vec::new();
    while let Ok(p) = progress.try_recv() {
        seen.push((p.done, p.total, p.current));
    }
    assert_eq!(seen, [(0, 2, Some("api".into())), (1, 2, Some("web".into())), (2, 2, None)]);
    let _ = std::fs::remove_dir_all(&group.fixture.root);
}

#[tokio::test]
async fn a_failed_member_worktree_removes_everything_the_create_made() {
    let group = Group::new(false);
    let id = Uuid::now_v7();
    let branch = format!("kybern/{id}");
    // web already has the branch, so its `worktree add -b` fails after api's succeeded.
    group_git(&group.folder.join("web"), &["branch", &branch]);
    let mut params = group.params(true, None);
    params.thread_id = Some(id);
    let error = group.fixture.orchestrator.create_thread(params).await.unwrap_err().to_string();
    assert!(error.starts_with("Couldn't create a worktree for web:"), "{error}");
    let container = group.fixture.orchestrator.worktree_dir(&group.project, &id.to_string());
    assert!(!container.exists(), "the container is removed");
    let api = group.folder.join("api");
    assert!(group_git(&api, &["branch", "--list", &branch]).is_empty(), "api's new branch is deleted");
    assert_eq!(group_git(&api, &["worktree", "list", "--porcelain"]).matches("worktree ").count(), 1);
    assert!(group.fixture.store.thread_get(id).unwrap().is_none());
    let _ = std::fs::remove_dir_all(&group.fixture.root);
}

#[tokio::test]
async fn group_checkpoints_diff_by_member_and_rewind_every_member() {
    let group = Group::new(false);
    let thread = group.create(true, None).await;
    let cwd = std::path::PathBuf::from(&thread.cwd);
    let turn = group
        .turn(&thread, || {
            std::fs::write(cwd.join("api/lib.rs"), "two\n").unwrap();
            std::fs::write(cwd.join("web/new.ts"), "new\n").unwrap();
        })
        .await;
    let checkpoint = group.fixture.store.checkpoint_get(turn).unwrap().unwrap();
    assert_eq!(checkpoint.repos.iter().map(|r| r.repo.as_str()).collect::<Vec<_>>(), ["api", "infra", "web"]);
    assert!(checkpoint.repos.iter().all(|r| r.after.is_some()) && !checkpoint.incomplete);
    assert_eq!(checkpoint.before, checkpoint.repos[0].before, "the top-level commits are the primary's");
    assert_eq!(checkpoint.after, checkpoint.repos[0].after);
    let pinned = group_git(&cwd.join("web"), &["rev-parse", &format!("refs/kybern/{}/{turn}/before", thread.id)]);
    assert_eq!(pinned, checkpoint.repos[2].before, "each member pins its own snapshot");

    let diff = group.fixture.orchestrator.diff(thread.id, Some(turn), true, None).await.unwrap();
    let files: Vec<_> = diff.files.iter().map(|f| (f.repo.as_deref().unwrap(), f.path.as_str())).collect();
    assert_eq!(files, [("api", "api/lib.rs"), ("web", "web/new.ts")]);
    let rows: Vec<_> = diff.repos.iter().map(|r| (r.repo.as_str(), r.files)).collect();
    assert_eq!(rows, [("api", 1), ("infra", 0), ("web", 1)]);
    assert!(diff.patch.contains("diff --git a/api/lib.rs b/api/lib.rs") && diff.patch.contains("b/web/new.ts"));
    let only = group.fixture.orchestrator.diff(thread.id, Some(turn), false, Some("web/new.ts")).await.unwrap();
    assert_eq!(only.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["web/new.ts"]);
    let whole = group.fixture.orchestrator.diff(thread.id, None, false, None).await.unwrap();
    assert_eq!(whole.files.len(), 2);

    group.fixture.orchestrator.revert(thread.id, turn).await.unwrap();
    assert_eq!(std::fs::read_to_string(cwd.join("api/lib.rs")).unwrap(), "one\n");
    assert!(!cwd.join("web/new.ts").exists());
    let events = group.fixture.store.events_for_thread(thread.id).unwrap();
    assert!(events.iter().any(|e| matches!(&e.payload, EventPayload::WorkspaceReverted { commit, .. } if *commit == checkpoint.before)));
    let _ = std::fs::remove_dir_all(&group.fixture.root);
}

#[tokio::test]
async fn a_member_that_fails_to_rewind_puts_the_others_back() {
    let group = Group::new(false);
    let thread = group.create(true, None).await;
    let cwd = std::path::PathBuf::from(&thread.cwd);
    let turn = group
        .turn(&thread, || {
            std::fs::write(cwd.join("api/lib.rs"), "two\n").unwrap();
            std::fs::write(cwd.join("web/app.ts"), "two\n").unwrap();
        })
        .await;
    // A stale index lock makes web's restore fail after api's has run; snapshots use their own index.
    let index = group_git(&cwd.join("web"), &["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    let lock = format!("{index}.lock");
    std::fs::write(&lock, "").unwrap();
    let error = group.fixture.orchestrator.revert(thread.id, turn).await.unwrap_err().to_string();
    assert!(error.starts_with("Rewind stopped:") && error.contains("in web. api and infra were put back as they were."), "{error}");
    assert_eq!(std::fs::read_to_string(cwd.join("api/lib.rs")).unwrap(), "two\n", "api is back to its state before the rewind");
    assert_eq!(std::fs::read_to_string(cwd.join("web/app.ts")).unwrap(), "two\n");
    let events = group.fixture.store.events_for_thread(thread.id).unwrap();
    assert!(!events.iter().any(|e| matches!(e.payload, EventPayload::WorkspaceReverted { .. })));
    std::fs::remove_file(&lock).unwrap();
    group.fixture.orchestrator.revert(thread.id, turn).await.unwrap();
    assert_eq!(std::fs::read_to_string(cwd.join("web/app.ts")).unwrap(), "one\n");
    let _ = std::fs::remove_dir_all(&group.fixture.root);
}

#[tokio::test]
async fn a_member_missing_from_a_checkpoint_blocks_rewinding_to_it() {
    let group = Group::new(false);
    let thread = group.create(true, None).await;
    let cwd = std::path::PathBuf::from(&thread.cwd);
    let web = cwd.join("web");
    let parked = cwd.join("web-parked");
    std::fs::rename(&web, &parked).unwrap();
    let turn = group.turn(&thread, || std::fs::write(cwd.join("api/lib.rs"), "two\n").unwrap()).await;
    std::fs::rename(&parked, &web).unwrap();
    let checkpoint = group.fixture.store.checkpoint_get(turn).unwrap().unwrap();
    assert!(checkpoint.incomplete);
    let error = group.fixture.orchestrator.revert(thread.id, turn).await.unwrap_err().to_string();
    assert_eq!(
        error,
        "Kybern couldn't snapshot web before this turn, so it can't rewind it. Rewind an earlier turn, or restore web with Git."
    );
    assert_eq!(std::fs::read_to_string(cwd.join("api/lib.rs")).unwrap(), "two\n", "nothing was rewound");
    let _ = std::fs::remove_dir_all(&group.fixture.root);
}

#[tokio::test]
async fn the_group_folder_repository_never_touches_its_nested_members() {
    let group = Group::new(true);
    let thread = group.create(false, None).await;
    assert_eq!(std::path::PathBuf::from(&thread.cwd), group.folder);
    assert_eq!(thread.members.iter().map(|m| m.path.as_str()).collect::<Vec<_>>(), [".", "api", "infra", "web"]);
    let folder = group.folder.clone();
    let turn = group
        .turn(&thread, || {
            std::fs::write(folder.join("README.md"), "two\n").unwrap();
            std::fs::write(folder.join("api/lib.rs"), "two\n").unwrap();
        })
        .await;
    let diff = group.fixture.orchestrator.diff(thread.id, Some(turn), true, None).await.unwrap();
    let files: Vec<_> = diff.files.iter().map(|f| (f.repo.as_deref().unwrap(), f.path.as_str())).collect();
    assert_eq!(files, [(".", "README.md"), ("api", "api/lib.rs")]);
    assert!(!diff.patch.contains("Subproject"), "{}", diff.patch);
    group.fixture.orchestrator.revert(thread.id, turn).await.unwrap();
    assert_eq!(std::fs::read_to_string(folder.join("README.md")).unwrap(), "one\n");
    assert_eq!(std::fs::read_to_string(folder.join("api/lib.rs")).unwrap(), "one\n");
    for member in ["api", "web", "infra"] {
        assert!(folder.join(member).join(".git").exists(), "{member} survives the folder's restore");
    }
    let _ = std::fs::remove_dir_all(&group.fixture.root);
}

#[tokio::test]
async fn a_worktree_container_of_a_folder_member_holds_the_other_members_inside_it() {
    let group = Group::new(true);
    let thread = group.create(true, Some(&[".", "web"])).await;
    let container = std::path::PathBuf::from(&thread.cwd);
    let branch = format!("kybern/{}", thread.id);
    assert_eq!(group_git(&container, &["branch", "--show-current"]), branch);
    assert_eq!(group_git(&container.join("web"), &["branch", "--show-current"]), branch);
    assert!(container.join("README.md").exists());
    assert!(container.join("Makefile").exists(), "untracked worktree_copy entries are copied in");
    let turn = group.turn(&thread, || std::fs::write(container.join("web/app.ts"), "two\n").unwrap()).await;
    let diff = group.fixture.orchestrator.diff(thread.id, Some(turn), false, None).await.unwrap();
    assert_eq!(diff.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["web/app.ts"]);
    let _ = std::fs::remove_dir_all(&group.fixture.root);
}

#[tokio::test]
async fn deselected_members_that_change_during_a_turn_are_reported() {
    let group = Group::new(false);
    let thread = group.create(true, Some(&["api"])).await;
    let outside = group.folder.join("web/app.ts");
    group.turn(&thread, || std::fs::write(&outside, "edited outside\n").unwrap()).await;
    let changes: Vec<_> = group
        .fixture
        .store
        .events_for_thread(thread.id)
        .unwrap()
        .into_iter()
        .filter_map(|e| match e.payload {
            EventPayload::OutsideRepoChanged { repos } => Some(repos),
            _ => None,
        })
        .collect();
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].iter().map(|c| (c.repo.as_str(), c.dirty_files, c.head_moved)).collect::<Vec<_>>(), [("web", 1, false)]);
    // An unchanged turn says nothing.
    group.turn(&thread, || ()).await;
    let count = group
        .fixture
        .store
        .events_for_thread(thread.id)
        .unwrap()
        .iter()
        .filter(|e| matches!(e.payload, EventPayload::OutsideRepoChanged { .. }))
        .count();
    assert_eq!(count, 1);
    let _ = std::fs::remove_dir_all(&group.fixture.root);
}

#[tokio::test]
async fn local_branch_switches_are_all_or_nothing() {
    let group = Group::new(false);
    let api = group.folder.join("api");
    group_git(&api, &["branch", "feature"]);
    let mut params = group.params(false, None);
    params.base_branches = Some([("api".to_string(), "feature".to_string()), ("web".to_string(), "feature".to_string())].into());
    let error = group.fixture.orchestrator.create_thread(params.clone()).await.unwrap_err().to_string();
    assert!(error.starts_with("Kybern couldn't switch web to feature"), "{error}");
    assert_eq!(group_git(&api, &["branch", "--show-current"]), "main", "api is switched back");

    group_git(&group.folder.join("web"), &["branch", "feature"]);
    let thread = group.fixture.orchestrator.create_thread(params).await.unwrap();
    assert_eq!(group_git(&api, &["branch", "--show-current"]), "feature");
    let bases: Vec<_> = thread.members.iter().map(|m| m.base_branch.as_deref()).collect();
    assert_eq!(bases, [Some("feature"), Some("main"), Some("feature")]);
    let _ = std::fs::remove_dir_all(&group.fixture.root);
}

#[tokio::test]
async fn group_worktree_cleanup_saves_each_member_and_restores_the_container() {
    let group = Group::new(false);
    let thread = group.create(true, Some(&["api", "web"])).await;
    let container = std::path::PathBuf::from(&thread.cwd);
    let state = group.fixture.orchestrator.worktree_inspect(thread.id).await.unwrap();
    assert!(state.clean && state.merged && state.eligible, "{:?}", state.blockers);

    std::fs::write(container.join("notes.md"), "mine\n").unwrap();
    let state = group.fixture.orchestrator.worktree_inspect(thread.id).await.unwrap();
    assert!(!state.eligible);
    assert!(state.blockers.iter().any(|b| b.starts_with("Move or delete notes.md from this chat’s folder first")), "{:?}", state.blockers);
    std::fs::remove_file(container.join("notes.md")).unwrap();

    // An edited copy is not Kybern's copy any more; an unchanged one is.
    std::fs::write(container.join("Makefile"), "all: edited\n").unwrap();
    let state = group.fixture.orchestrator.worktree_inspect(thread.id).await.unwrap();
    assert!(state.blockers.iter().any(|b| b.starts_with("Move or delete Makefile from")), "{:?}", state.blockers);
    std::fs::write(container.join("Makefile"), "all:\n").unwrap();
    let state = group.fixture.orchestrator.worktree_inspect(thread.id).await.unwrap();
    assert!(state.eligible, "{:?}", state.blockers);

    std::fs::write(container.join("web/app.ts"), "edited\n").unwrap();
    let state = group.fixture.orchestrator.worktree_inspect(thread.id).await.unwrap();
    assert!(!state.clean && state.blockers.is_empty(), "{:?}", state.blockers);
    let removed = group
        .fixture
        .orchestrator
        .worktree_remove(methods::WorktreeRemoveParams { thread_id: thread.id, force: true, delete_branch: false })
        .await
        .unwrap();
    assert!(!removed.exists);
    assert!(!container.exists(), "the container and its copies are gone");
    let web = group.folder.join("web");
    let saved = group_git(&web, &["rev-parse", &format!("refs/kybern/worktree-recovery/{}/source", thread.id)]);
    assert_eq!(group_git(&web, &["show", &format!("{saved}:app.ts")]), "edited");
    let stored = group.fixture.store.thread_get(thread.id).unwrap().unwrap();
    assert!(stored.members.iter().filter(|m| m.included).all(|m| m.worktree_state == Some(WorktreeState::Removed)));

    group.fixture.orchestrator.restore_worktree_if_cleaned(&stored).await.unwrap();
    assert_eq!(std::fs::read_to_string(container.join("web/app.ts")).unwrap(), "edited\n");
    assert_eq!(group_git(&container.join("api"), &["branch", "--show-current"]), format!("kybern/{}", thread.id));
    assert!(container.join("AGENTS.md").exists() && container.join("Makefile").exists());
    let events = group.fixture.store.events_for_thread(thread.id).unwrap();
    assert!(events.iter().any(|e| matches!(e.payload, EventPayload::WorktreeRestored { .. })));
    let _ = std::fs::remove_dir_all(&group.fixture.root);
}
