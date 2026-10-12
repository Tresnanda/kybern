// `kybern_git` tests. Included into `orchestrator::tests` so they can use its
// fixture and live-session helpers, and the approval helpers of the secret tests.

fn git_in(dir: &std::path::Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {}: {}", args.join(" "), String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// A fake `gh` that logs its arguments. `signed_in` decides `gh auth status`.
/// Pull request 7 is open with one passed and one running check; branch `feat`
/// has a pull request only after `gh pr create` ran.
fn fake_gh(dir: &std::path::Path, signed_in: bool) -> (std::path::PathBuf, std::path::PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(dir).unwrap();
    let (log, created, script) = (dir.join("gh.log"), dir.join("gh-created"), dir.join("gh"));
    let auth = if signed_in { "exit 0" } else { "echo 'not logged in' >&2; exit 1" };
    std::fs::write(
        &script,
        format!(
            r#"#!/bin/sh
echo "$@" >> "{log}"
case "$1" in
  --version) echo "gh version 2.0.0" ;;
  auth) {auth} ;;
  repo) echo main ;;
  pr)
    case "$2" in
      view)
        if [ "$3" = "7" ]; then
          echo '{{"number":7,"title":"Fix the importer","url":"https://github.com/o/r/pull/7","state":"OPEN","mergeable":"MERGEABLE","isDraft":false,"statusCheckRollup":[{{"__typename":"CheckRun","status":"COMPLETED","conclusion":"SUCCESS"}},{{"__typename":"CheckRun","status":"IN_PROGRESS"}}]}}'
        elif [ "$3" = "8" ]; then
          echo '{{"number":8,"title":"Conflicted","url":"https://github.com/o/r/pull/8","state":"OPEN","mergeable":"CONFLICTING","isDraft":false,"statusCheckRollup":[]}}'
        elif [ -f "{created}" ]; then
          echo '{{"number":12,"title":"Add b","url":"https://github.com/o/r/pull/12","state":"OPEN","headRefName":"feat","baseRefName":"main","isDraft":false,"author":{{"login":"me"}},"updatedAt":"2026-01-01T00:00:00Z"}}'
        else
          echo "no pull requests found" >&2; exit 1
        fi ;;
      create) touch "{created}"; echo "https://github.com/o/r/pull/12" ;;
      merge) echo merged ;;
    esac ;;
esac
"#,
            log = log.display(),
            created = created.display(),
            auth = auth,
        ),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    (script, log)
}

/// A Coordinator thread with a live session, working in a real repository on `main`.
struct LeadRepo {
    fixture: Fixture,
    thread: Thread,
    live: Arc<LiveSession>,
    repo: std::path::PathBuf,
}

impl LeadRepo {
    async fn new() -> Self {
        Self::build(true).await
    }

    async fn build(with_identity: bool) -> Self {
        let fixture = Fixture::new();
        let repo = fixture.root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git_in(&repo, &["init", "-q"]);
        git_in(&repo, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        git_in(&repo, &["config", "user.name", "Lead Test"]);
        git_in(&repo, &["config", "user.email", "lead@example.com"]);
        std::fs::write(repo.join("a.txt"), "one\n").unwrap();
        git_in(&repo, &["add", "."]);
        git_in(&repo, &["commit", "-q", "-m", "init"]);
        if !with_identity {
            git_in(&repo, &["config", "--unset", "user.name"]);
            git_in(&repo, &["config", "--unset", "user.email"]);
        }
        // Do not depend on the machine's own git configuration.
        let home = fixture.root.join("home");
        std::fs::create_dir_all(&home).unwrap();
        fixture.orchestrator.lead_git_config().set_git_env(vec![
            ("HOME".into(), home.to_string_lossy().into_owned()),
            ("GIT_CONFIG_GLOBAL".into(), "/dev/null".into()),
            ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
        ]);
        let mut thread = fixture.thread(ThreadStatus::Idle);
        thread.coordinator_project_id = Some(fixture.project.id);
        thread.cwd = repo.to_string_lossy().into_owned();
        fixture.store.thread_upsert(&thread).unwrap();
        let (live, _) = fixture.active_app_tool_session(&thread).await;
        Self { fixture, thread, live, repo }
    }

    async fn call(&self, args: serde_json::Value) -> anyhow::Result<serde_json::Value> {
        tokio::time::timeout(
            Duration::from_secs(20),
            self.fixture.tool(&self.thread, &self.live, &Uuid::now_v7().to_string(), "kybern_git", args),
        )
        .await
        .expect("the call must not wait for a card here")
    }

    async fn ok(&self, args: serde_json::Value) -> serde_json::Value {
        self.call(args).await.unwrap()
    }

    async fn error(&self, args: serde_json::Value) -> String {
        self.call(args).await.unwrap_err().to_string()
    }

    /// Run a call that raises a card, answer the card, and return it with the result.
    async fn with_card(&self, args: serde_json::Value, answer: ApprovalDecision) -> (ApprovalRequest, anyhow::Result<serde_json::Value>) {
        let (orchestrator, thread_id, session) = (self.fixture.orchestrator.clone(), self.thread.id, self.live.session_instance_id);
        let call = tokio::spawn(async move {
            orchestrator.execute_native_app_tool_call(thread_id, session, &Uuid::now_v7().to_string(), "kybern_git", args).await
        });
        let card = tokio::time::timeout(Duration::from_secs(20), secret_card(&self.live)).await.expect("a card is raised");
        let (request, resolved) = self.fixture.store.approval_get(card).unwrap().unwrap();
        assert!(!resolved);
        self.fixture.orchestrator.respond_approval(card, answer).await.unwrap();
        (request, tokio::time::timeout(Duration::from_secs(30), call).await.expect("the call ends").unwrap())
    }

    fn cards(&self) -> usize {
        self.fixture.store.approvals_pending(Some(self.thread.id)).unwrap().len()
    }

    fn set_push_without_asking(&self, on: bool) {
        let mut settings = self.fixture.orchestrator.inner.settings.get();
        settings.orchestration.lead_push_without_asking = on;
        self.fixture.orchestrator.inner.settings.set(settings).unwrap();
    }

    /// A bare remote named `origin`.
    fn add_remote(&self) -> std::path::PathBuf {
        let remote = self.fixture.root.join("remote.git");
        std::fs::create_dir_all(&remote).unwrap();
        git_in(&remote, &["init", "-q", "--bare"]);
        git_in(&self.repo, &["remote", "add", "origin", &remote.to_string_lossy()]);
        git_in(&self.repo, &["push", "-q", "-u", "origin", "main"]);
        remote
    }

    /// A delegated child of this Coordinator.
    fn child(&self, workspace: DelegationWorkspace, status: DelegationStatus, branch: Option<String>, cwd: &std::path::Path) -> Thread {
        let mut child = self.fixture.thread(ThreadStatus::Idle);
        child.parent_thread_id = Some(self.thread.id);
        child.title = "Add b".into();
        child.cwd = cwd.to_string_lossy().into_owned();
        child.delegation = Some(DelegationInfo {
            task_id: Uuid::now_v7(),
            operation_id: Uuid::now_v7(),
            parent_thread_id: self.thread.id,
            depth: 1,
            role: DelegationRole::default(),
            workspace,
            owns: Vec::new(),
            status,
            result: None,
            error: None,
            files_touched: Vec::new(),
            conflicts: Vec::new(),
            base_commit: None,
            branch,
            head_commit: None,
            diffstat: None,
            worktree_state: (workspace == DelegationWorkspace::Worktree).then_some(WorktreeState::Active),
            started_at: chrono::Utc::now(),
            completed_at: None,
            parent_notified: true,
        });
        self.fixture.store.thread_upsert(&child).unwrap();
        child
    }

    /// A finished worktree agent that committed `file` on its own branch.
    fn worktree_child(&self, file: &str, content: &str) -> Thread {
        let id = Uuid::now_v7();
        let branch = format!("kybern/{id}");
        let worktree = self.fixture.root.join(format!("wt-{id}"));
        git_in(&self.repo, &["worktree", "add", "-q", "-b", &branch, &worktree.to_string_lossy(), "HEAD"]);
        std::fs::write(worktree.join(file), content).unwrap();
        git_in(&worktree, &["add", "."]);
        git_in(&worktree, &["commit", "-q", "-m", "child work"]);
        self.child(DelegationWorkspace::Worktree, DelegationStatus::Completed, Some(branch), &worktree)
    }
}

#[tokio::test]
async fn only_the_coordinator_sees_and_may_call_the_git_tool() {
    // An ordinary thread is refused, whatever the arguments.
    let fixture = Fixture::new();
    std::fs::create_dir_all(&fixture.root).unwrap();
    let (thread, live) = fixture.tool_thread(PermissionMode::FullAccess).await;
    let error = fixture.tool(&thread, &live, "g1", "kybern_git", json!({"op": "status"})).await.unwrap_err().to_string();
    assert!(error.contains("only available to a project Coordinator"), "{error}");

    // Only the Coordinator's session is offered the tool and may call it.
    let (fixture, bridges) = lead_capture_fixture();
    let lead = fixture.orchestrator.coordinator_open(open_params(&fixture.project, ProviderKind::ClaudeCode, None)).await.unwrap().thread;
    let ordinary = fixture.thread(ThreadStatus::Idle);
    let lead_bridge = spawn_bridge(&fixture, &bridges, &lead).await;
    assert!(lead_bridge.tools().any(|tool| tool.name == "kybern_git"), "the Coordinator is offered kybern_git");
    assert!(lead_bridge.restrictions.allowed_tools.iter().any(|name| name == "kybern_git"));
    let ordinary_bridge = spawn_bridge(&fixture, &bridges, &ordinary).await;
    assert!(!ordinary_bridge.tools().any(|tool| tool.name == "kybern_git"), "other threads never see it");
    assert!(!crate::app_tools::native_tool_definitions().iter().any(|tool| tool.name == "kybern_git"));
}

#[tokio::test]
async fn read_ops_describe_the_checkout() {
    let t = LeadRepo::new().await;
    let status = t.ok(json!({"op": "status"})).await;
    assert_eq!(
        (status["branch"].clone(), status["clean"].clone(), status["on_default_branch"].clone(), status["upstream"].clone()),
        (json!("main"), json!(true), json!(true), json!(null))
    );
    std::fs::write(t.repo.join("a.txt"), "one\ntwo\n").unwrap();
    std::fs::write(t.repo.join("new.txt"), "n\n").unwrap();
    let status = t.ok(json!({"op": "status"})).await;
    assert_eq!(status["clean"], json!(false));
    assert!(status["changes"].as_array().unwrap().contains(&json!({"code": "??", "path": "new.txt"})));

    let diff = t.ok(json!({"op": "diff"})).await;
    assert_eq!(diff["scope"], json!("uncommitted"));
    assert_eq!(diff["files"], json!([{"path": "a.txt", "additions": 1, "deletions": 0, "binary": false}]));
    assert_eq!(diff["untracked"], json!(["new.txt"]));
    assert!(diff["patch"].as_str().unwrap().contains("+two"));
    let staged = t.ok(json!({"op": "diff", "staged": true})).await;
    assert_eq!((staged["scope"].clone(), staged["files"].clone()), (json!("staged"), json!([])));

    let log = t.ok(json!({"op": "log", "limit": 5})).await;
    assert_eq!(log["commits"][0]["subject"], json!("init"));
    assert_eq!(log["commits"][0]["author"], json!("Lead Test"));
    let branches = t.ok(json!({"op": "branches"})).await;
    assert_eq!(branches["current"], json!("main"));
    assert_eq!(branches["branches"][0]["name"], json!("main"));
    assert_eq!(branches["branches"][0]["is_current"], json!(true));

    assert!(t.error(json!({"op": "tag", "name": "v1"})).await.contains("not offered"));
    assert!(t.error(json!({"op": "status", "bogus": 1})).await.contains("unknown field"));
}

#[tokio::test]
async fn branching_and_committing_follow_the_guards() {
    let t = LeadRepo::new().await;
    std::fs::write(t.repo.join("b.txt"), "b\n").unwrap();

    // The default branch is never committed to.
    let error = t.error(json!({"op": "commit", "message": "Add b"})).await;
    assert!(error.contains("Create a branch first with op create_branch."), "{error}");

    // A bad name or an existing branch is refused; a good one is created and checked out.
    assert!(t.error(json!({"op": "create_branch", "name": "a b"})).await.contains("valid branch name"));
    assert!(t.error(json!({"op": "create_branch", "name": "main"})).await.contains("already exists"));
    assert!(t.error(json!({"op": "create_branch", "name": "feat", "from": "nope"})).await.contains("not a branch or commit"));
    let created = t.ok(json!({"op": "create_branch", "name": "feat"})).await;
    assert_eq!((created["status"].clone(), created["from"].clone()), (json!("created"), json!("main")));
    assert_eq!(git_in(&t.repo, &["branch", "--show-current"]), "feat");

    // A commit with paths takes only those; the author is the repo's own identity.
    std::fs::write(t.repo.join("c.txt"), "c\n").unwrap();
    let committed = t.ok(json!({"op": "commit", "message": "Add b\n\nbody", "paths": ["b.txt"]})).await;
    assert_eq!((committed["status"].clone(), committed["subject"].clone()), (json!("committed"), json!("Add b")));
    assert_eq!(git_in(&t.repo, &["log", "-1", "--format=%an <%ae>"]), "Lead Test <lead@example.com>");
    assert_eq!(git_in(&t.repo, &["show", "--name-only", "--format=", "HEAD"]), "b.txt");
    assert_eq!(git_in(&t.repo, &["status", "--porcelain"]), "?? c.txt");
    // Without paths, everything goes; nothing left is refused.
    t.ok(json!({"op": "commit", "message": "Add c"})).await;
    assert!(t.error(json!({"op": "commit", "message": "again"})).await.contains("Nothing to commit"));
    assert!(t.error(json!({"op": "commit", "message": "x", "paths": ["../escape"]})).await.contains("relative"));

    // Switching needs a clean tree and an existing branch.
    std::fs::write(t.repo.join("a.txt"), "dirty\n").unwrap();
    let dirty = t.error(json!({"op": "switch", "branch": "main"})).await;
    assert!(dirty.contains("1 uncommitted changes") && dirty.contains("op commit"), "{dirty}");
    git_in(&t.repo, &["checkout", "--", "a.txt"]);
    assert!(t.error(json!({"op": "switch", "branch": "ghost"})).await.contains("no local branch named ghost"));
    assert_eq!(t.ok(json!({"op": "switch", "branch": "main"})).await["status"], json!("switched"));
    assert_eq!(t.ok(json!({"op": "switch", "branch": "main"})).await["status"], json!("already_on_branch"));
    assert_eq!(git_in(&t.repo, &["branch", "--show-current"]), "main");
}

#[tokio::test]
async fn branch_changes_wait_for_agents_working_in_the_checkout() {
    let t = LeadRepo::new().await;
    let shared = t.child(DelegationWorkspace::Shared, DelegationStatus::Running, None, &t.repo);
    for args in [json!({"op": "create_branch", "name": "feat"}), json!({"op": "switch", "branch": "main"})] {
        let error = t.error(args).await;
        assert_eq!(error, "Wait for 1 agent working in this checkout to finish, or let them finish in their own worktrees.");
    }
    assert_eq!(git_in(&t.repo, &["branch", "--show-current"]), "main");
    // A second one, a grandchild included, is counted too.
    let second = t.child(DelegationWorkspace::Shared, DelegationStatus::Running, None, &t.repo);
    let mut nested = t.fixture.thread(ThreadStatus::Idle);
    nested.parent_thread_id = Some(second.id);
    nested.delegation = Some(DelegationInfo {
        parent_thread_id: second.id,
        task_id: Uuid::now_v7(),
        operation_id: Uuid::now_v7(),
        ..second.delegation.clone().unwrap()
    });
    t.fixture.store.thread_upsert(&nested).unwrap();
    assert!(t.error(json!({"op": "create_branch", "name": "feat"})).await.starts_with("Wait for 3 agents working"));

    // Finished shared agents and running worktree agents do not block.
    for thread in [&shared, &second, &nested] {
        let mut done = t.fixture.store.thread_get(thread.id).unwrap().unwrap();
        done.delegation.as_mut().unwrap().status = DelegationStatus::Completed;
        t.fixture.store.thread_upsert(&done).unwrap();
    }
    t.child(DelegationWorkspace::Worktree, DelegationStatus::Running, Some("kybern/x".into()), &t.repo);
    assert_eq!(t.ok(json!({"op": "create_branch", "name": "feat"})).await["status"], json!("created"));
}

#[tokio::test]
async fn commits_need_a_configured_identity() {
    let t = LeadRepo::build(false).await;
    t.ok(json!({"op": "create_branch", "name": "feat"})).await;
    std::fs::write(t.repo.join("b.txt"), "b\n").unwrap();
    let error = t.error(json!({"op": "commit", "message": "Add b"})).await;
    assert!(error.contains("git config user.name") && error.contains("git config user.email"), "{error}");
    assert_eq!(git_in(&t.repo, &["status", "--porcelain"]), "?? b.txt", "nothing was staged or committed");
}

#[tokio::test]
async fn merge_child_merges_the_agents_branch_with_a_merge_commit() {
    let t = LeadRepo::new().await;
    let child = t.worktree_child("b.txt", "from the child\n");
    let args = json!({"op": "merge_child", "thread_id": child.id});

    // Not on the default branch, and not with a dirty tree.
    assert!(t.error(args.clone()).await.contains("Create a branch first"));
    t.ok(json!({"op": "create_branch", "name": "feat"})).await;
    std::fs::write(t.repo.join("dirty.txt"), "x\n").unwrap();
    assert!(t.error(args.clone()).await.contains("uncommitted changes"));
    std::fs::remove_file(t.repo.join("dirty.txt")).unwrap();

    let merged = t.ok(args.clone()).await;
    assert_eq!((merged["status"].clone(), merged["into"].clone()), (json!("merged"), json!("feat")));
    assert_eq!(std::fs::read_to_string(t.repo.join("b.txt")).unwrap(), "from the child\n");
    assert_eq!(git_in(&t.repo, &["rev-list", "--parents", "-n", "1", "HEAD"]).split_whitespace().count(), 3, "a merge commit");
    let branch = child.delegation.as_ref().unwrap().branch.clone().unwrap();
    assert_eq!(git_in(&t.repo, &["log", "-1", "--format=%s"]), format!("Merge {branch}: Add b"));
    assert_eq!(t.ok(args).await["status"], json!("already_merged"));
}

#[tokio::test]
async fn merge_child_aborts_on_conflict_and_reports_the_files() {
    let t = LeadRepo::new().await;
    let child = t.worktree_child("a.txt", "child edit\n");
    t.ok(json!({"op": "create_branch", "name": "feat"})).await;
    std::fs::write(t.repo.join("a.txt"), "lead edit\n").unwrap();
    t.ok(json!({"op": "commit", "message": "Lead edit"})).await;
    let before = git_in(&t.repo, &["rev-parse", "HEAD"]);

    let result = t.ok(json!({"op": "merge_child", "thread_id": child.id})).await;
    assert_eq!(result["status"], json!("conflict"));
    assert_eq!(result["conflicts"], json!(["a.txt"]));
    assert_eq!(git_in(&t.repo, &["rev-parse", "HEAD"]), before);
    assert_eq!(git_in(&t.repo, &["status", "--porcelain"]), "", "the merge was aborted");
    assert!(!t.repo.join(".git/MERGE_HEAD").exists());
    assert_eq!(std::fs::read_to_string(t.repo.join("a.txt")).unwrap(), "lead edit\n");
}

#[tokio::test]
async fn merge_child_refuses_what_is_not_a_finished_worktree_agent() {
    let t = LeadRepo::new().await;
    t.ok(json!({"op": "create_branch", "name": "feat"})).await;
    let call = |id: Uuid| json!({"op": "merge_child", "thread_id": id});
    assert!(t.error(call(Uuid::now_v7())).await.contains("no thread with that id"));
    assert!(t.error(call(t.fixture.thread(ThreadStatus::Idle).id)).await.contains("not an agent you delegated to"));
    let shared = t.child(DelegationWorkspace::Shared, DelegationStatus::Completed, None, &t.repo);
    assert!(t.error(call(shared.id)).await.contains("already here"));
    let running = t.child(DelegationWorkspace::Worktree, DelegationStatus::Running, Some("kybern/x".into()), &t.repo);
    assert!(t.error(call(running.id)).await.contains("still running"));
    let no_branch = t.child(DelegationWorkspace::Worktree, DelegationStatus::Completed, None, &t.repo);
    assert!(t.error(call(no_branch.id)).await.contains("no recorded branch"));
    let gone = t.child(DelegationWorkspace::Worktree, DelegationStatus::Completed, Some("kybern/gone".into()), &t.repo);
    assert!(t.error(call(gone.id)).await.contains("no longer exists"));
    // A child of another thread is not this Coordinator's to merge.
    let mut other = t.child(DelegationWorkspace::Worktree, DelegationStatus::Completed, Some("kybern/x".into()), &t.repo);
    other.parent_thread_id = Some(Uuid::now_v7());
    other.delegation.as_mut().unwrap().parent_thread_id = other.parent_thread_id.unwrap();
    t.fixture.store.thread_upsert(&other).unwrap();
    assert!(t.error(call(other.id)).await.contains("not an agent you delegated to"));
}

#[tokio::test]
async fn push_asks_first_and_never_pushes_a_declined_card() {
    let t = LeadRepo::new().await;
    assert!(t.error(json!({"op": "push"})).await.contains("no remote"), "no remote yet");
    let remote = t.add_remote();
    t.ok(json!({"op": "create_branch", "name": "feat"})).await;
    std::fs::write(t.repo.join("b.txt"), "b\n").unwrap();
    t.ok(json!({"op": "commit", "message": "Add b"})).await;
    let tip = git_in(&t.repo, &["rev-parse", "HEAD"]);

    // Declined: nothing is pushed.
    let (card, result) = t.with_card(json!({"op": "push"}), ApprovalDecision::Deny { reason: None }).await;
    assert_eq!(card.tool_name, "kybern_git");
    assert!(!card.is_user_input());
    assert_eq!(card.input, json!({"op": "push", "remote": "origin", "branch": "feat", "ahead": 1}));
    assert_eq!(result.unwrap()["status"], json!("declined"));
    assert!(git_in(&remote, &["branch", "--list", "feat"]).is_empty());

    // Allowed: pushed with the upstream set.
    let (_, result) = t.with_card(json!({"op": "push"}), ApprovalDecision::AllowOnce).await;
    let result = result.unwrap();
    assert_eq!((result["status"].clone(), result["upstream"].clone()), (json!("pushed"), json!("origin/feat")));
    assert_eq!(git_in(&remote, &["rev-parse", "feat"]), tip);
    // Nothing left to send needs no card.
    assert_eq!(t.ok(json!({"op": "push"})).await["status"], json!("up_to_date"));
    assert_eq!(t.cards(), 0);
}

#[tokio::test]
async fn push_skips_the_card_when_the_user_allowed_it() {
    let t = LeadRepo::new().await;
    let remote = t.add_remote();
    t.ok(json!({"op": "create_branch", "name": "feat"})).await;
    std::fs::write(t.repo.join("b.txt"), "b\n").unwrap();
    t.ok(json!({"op": "commit", "message": "Add b"})).await;
    t.set_push_without_asking(true);
    let result = t.ok(json!({"op": "push"})).await;
    assert_eq!(result["status"], json!("pushed"));
    assert_eq!(git_in(&remote, &["rev-parse", "feat"]), git_in(&t.repo, &["rev-parse", "HEAD"]));
    assert!(t.live.daemon_approvals.lock().await.is_empty(), "no card was raised");
}

#[tokio::test]
async fn open_pr_asks_pushes_and_opens_through_gh() {
    let t = LeadRepo::new().await;
    let remote = t.add_remote();
    let (gh, log) = fake_gh(&t.fixture.root.join("bin"), true);
    t.fixture.orchestrator.lead_git_config().set_gh(gh.to_string_lossy());
    assert!(t.error(json!({"op": "open_pr", "title": "T", "body": "B"})).await.contains("Create a branch first"));
    t.ok(json!({"op": "create_branch", "name": "feat"})).await;
    std::fs::write(t.repo.join("b.txt"), "b\n").unwrap();
    t.ok(json!({"op": "commit", "message": "Add b"})).await;

    let args = json!({"op": "open_pr", "title": "Add b", "body": "Adds b.\n\nTested."});
    let (card, result) = t.with_card(args.clone(), ApprovalDecision::Deny { reason: Some("not yet".into()) }).await;
    assert_eq!(
        card.input,
        json!({"op": "open_pr", "remote": "origin", "branch": "feat", "ahead": 1, "title": "Add b", "body": "Adds b.\n\nTested.", "base": "main"})
    );
    assert_eq!(result.unwrap()["status"], json!("declined"));
    assert!(!std::fs::read_to_string(&log).unwrap().contains("pr create"));
    assert!(git_in(&remote, &["branch", "--list", "feat"]).is_empty(), "declining pushes nothing");

    let (_, result) = t.with_card(args.clone(), ApprovalDecision::AllowOnce).await;
    let result = result.unwrap();
    assert_eq!(
        (result["status"].clone(), result["number"].clone(), result["url"].clone(), result["base"].clone()),
        (json!("opened"), json!(12), json!("https://github.com/o/r/pull/12"), json!("main"))
    );
    assert!(!git_in(&remote, &["branch", "--list", "feat"]).is_empty(), "the branch was pushed first");
    let log = std::fs::read_to_string(&log).unwrap();
    assert!(log.contains("pr create --title Add b --body Adds b."), "{log}");
    assert!(log.contains("--base main --head feat"), "{log}");
    // A second call finds the open pull request.
    assert!(t.error(args).await.contains("already open for feat"));
}

#[tokio::test]
async fn open_pr_skips_the_card_when_allowed_and_explains_a_missing_or_signed_out_gh() {
    let t = LeadRepo::new().await;
    t.add_remote();
    t.ok(json!({"op": "create_branch", "name": "feat"})).await;
    std::fs::write(t.repo.join("b.txt"), "b\n").unwrap();
    t.ok(json!({"op": "commit", "message": "Add b"})).await;
    let args = json!({"op": "open_pr", "title": "Add b", "body": "B"});

    // No gh, or not signed in: an actionable error, before any card.
    t.fixture.orchestrator.lead_git_config().set_gh(t.fixture.root.join("no-such-gh").to_string_lossy());
    assert!(t.error(args.clone()).await.contains("not installed"));
    let (signed_out, _) = fake_gh(&t.fixture.root.join("signed-out"), false);
    t.fixture.orchestrator.lead_git_config().set_gh(signed_out.to_string_lossy());
    assert!(t.error(args.clone()).await.contains("gh auth login"));
    assert_eq!(t.cards(), 0);

    let (gh, log) = fake_gh(&t.fixture.root.join("bin"), true);
    t.fixture.orchestrator.lead_git_config().set_gh(gh.to_string_lossy());
    t.set_push_without_asking(true);
    assert_eq!(t.ok(args).await["status"], json!("opened"));
    assert!(t.live.daemon_approvals.lock().await.is_empty(), "no card was raised");
    assert!(std::fs::read_to_string(log).unwrap().contains("pr create"));
}

#[tokio::test]
async fn merge_pr_always_asks_even_when_pushing_is_allowed() {
    let t = LeadRepo::new().await;
    let (gh, log) = fake_gh(&t.fixture.root.join("bin"), true);
    t.fixture.orchestrator.lead_git_config().set_gh(gh.to_string_lossy());
    t.set_push_without_asking(true);
    let args = json!({"op": "merge_pr", "number": 7, "method": "squash"});

    let (card, result) = t.with_card(args.clone(), ApprovalDecision::Deny { reason: None }).await;
    assert_eq!(
        card.input,
        json!({
            "op": "merge_pr", "number": 7, "title": "Fix the importer", "method": "squash",
            "checks": {"total": 2, "passed": 1, "failed": 0, "pending": 1, "skipped": 0}
        })
    );
    assert_eq!(result.unwrap()["status"], json!("declined"));
    assert!(!std::fs::read_to_string(&log).unwrap().contains("pr merge"), "a declined card merges nothing");

    let (_, result) = t.with_card(json!({"op": "merge_pr", "number": 7, "method": "merge"}), ApprovalDecision::AllowOnce).await;
    let result = result.unwrap();
    assert_eq!((result["status"].clone(), result["method"].clone()), (json!("merged"), json!("merge")));
    let log = std::fs::read_to_string(&log).unwrap();
    assert!(log.contains("pr merge 7 --merge"), "{log}");
    assert!(!log.contains("--delete-branch"));

    // Problems are reported before a card is raised.
    assert!(t.error(json!({"op": "merge_pr", "number": 8, "method": "squash"})).await.contains("merge conflicts"));
    assert!(t.error(json!({"op": "merge_pr", "number": 99, "method": "squash"})).await.contains("Could not read pull request #99"));
    assert_eq!(t.cards(), 0);
}

#[tokio::test]
async fn a_card_the_turn_outlives_is_cancelled_and_nothing_is_pushed() {
    let t = LeadRepo::new().await;
    let remote = t.add_remote();
    t.ok(json!({"op": "create_branch", "name": "feat"})).await;
    std::fs::write(t.repo.join("b.txt"), "b\n").unwrap();
    t.ok(json!({"op": "commit", "message": "Add b"})).await;
    let (orchestrator, thread_id, session) = (t.fixture.orchestrator.clone(), t.thread.id, t.live.session_instance_id);
    let call = tokio::spawn(async move {
        orchestrator.execute_native_app_tool_call(thread_id, session, "turn-end", "kybern_git", json!({"op": "push"})).await
    });
    let card = tokio::time::timeout(Duration::from_secs(20), secret_card(&t.live)).await.unwrap();
    let turn_id = t.live.turn.lock().await.as_ref().unwrap().id;
    t.fixture.orchestrator.resolve_finished_requests(t.thread.id, turn_id, &t.live).await.unwrap();
    let result = call.await.unwrap().unwrap();
    assert_eq!(result["status"], json!("cancelled"));
    assert!(git_in(&remote, &["branch", "--list", "feat"]).is_empty());
    assert!(t.fixture.store.approval_get(card).unwrap().unwrap().1, "the card was resolved");
}
