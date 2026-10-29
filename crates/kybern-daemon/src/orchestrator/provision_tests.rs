// Adding a project to another machine (provisioning). Included into `orchestrator::tests` beside the remote
// delegation scenarios, whose helpers (`two_checkouts`, `git_project`, `scripted_drivers`) it shares. The machines
// are real daemon states on the in-process harness; they skip without the `127.x.0.n` loopback aliases.
//
// The source in the core scenarios is machine "b" and the target "c", with "a" only in the network: nothing
// here assumes the machine a client runs on is the one with the project.

/// Three machines; `b` has a checkout of a repository with an env file, `c` has another project in `c-home`.
struct ProvisionNet {
    cluster: Cluster,
    a: Node,
    b: Node,
    c: Node,
    project_b: Project,
    repo_b: PathBuf,
    origin: PathBuf,
}

impl ProvisionNet {
    async fn new() -> Option<Self> {
        let cluster = Cluster::new(&[NodeSpec::owner("a"), NodeSpec::owner("b"), NodeSpec::owner("c")])?;
        let drivers = || scripted_drivers(&Arc::new(std::sync::Mutex::new(Vec::new())));
        let root = cluster.dir.path().to_path_buf();
        let (repo_b, _unused) = two_checkouts(&root);
        let origin = root.join("origin.git");
        // A git-ignored env file at the root and one in a subfolder; a template that is not copied.
        std::fs::write(repo_b.join(".gitignore"), ".env*\n!.env.example\nnode_modules/\n").unwrap();
        run_git(&repo_b, &["add", ".gitignore"]);
        run_git(&repo_b, &["commit", "-q", "-m", "ignore env"]);
        run_git(&repo_b, &["push", "-q", "origin", "main"]);
        std::fs::write(repo_b.join(".env"), "API_KEY=zq-secret-root\n").unwrap();
        std::fs::create_dir_all(repo_b.join("apps/web")).unwrap();
        std::fs::write(repo_b.join("apps/web/.env.local"), "WEB_KEY=zq-secret-web\n").unwrap();
        std::fs::write(repo_b.join(".env.example"), "API_KEY=\n").unwrap();
        run_git(&repo_b, &["add", ".env.example"]);
        run_git(&repo_b, &["commit", "-q", "-m", "example env"]);
        run_git(&repo_b, &["push", "-q", "origin", "main"]);

        let a = cluster.start_with("a", true, drivers()).await;
        let b = cluster.start_with("b", true, drivers()).await;
        let c = cluster.start_with("c", true, drivers()).await;
        cluster.form(&a, &[&b, &c], JoinVia::Auto).await;
        let project_b = git_project("kybern", &repo_b);
        b.state.store.project_insert(&project_b).unwrap();
        // c's other project decides where c proposes to put new ones.
        let other = root.join("c-home").join("other");
        std::fs::create_dir_all(&other).unwrap();
        c.state.store.project_insert(&git_project("other", &other)).unwrap();
        wait_until("b and c linked", WAIT, || crate::network::harness::linked(&b, &c)).await;
        Some(Self { cluster, a, b, c, project_b, repo_b, origin })
    }

    fn root(&self) -> PathBuf {
        self.cluster.dir.path().to_path_buf()
    }

    /// `projects.provision` on b for c.
    async fn provision(&self, path: Option<PathBuf>, env_files: Option<Vec<&str>>, operation_id: Option<Uuid>) -> ProvisionStatus {
        let params = ProjectsProvisionParams {
            project_id: self.project_b.id,
            machine: self.c.id(),
            choice: ProvisionChoice {
                path: path.map(|path| path.to_string_lossy().into_owned()),
                env_files: env_files.map(|files| files.into_iter().map(str::to_string).collect()),
            },
            operation_id,
        };
        crate::network::provision::start(&self.b.state, params).await.unwrap()
    }

    /// The provisioning's outbox item on b once it settled.
    async fn settled(&self, operation_id: Uuid) -> OutboxItem {
        let store = self.b.state.store.clone();
        wait_until("the provisioning settled", WAIT * 4, || {
            store.outbox_get_by_operation(operation_id).unwrap().is_some_and(|item| item.state.is_settled())
        })
        .await;
        store.outbox_get_by_operation(operation_id).unwrap().unwrap()
    }

    fn c_project_at(&self, path: &std::path::Path) -> Option<Project> {
        let wanted = std::fs::canonicalize(path).ok()?;
        self.c.state.store.projects_list().unwrap().into_iter().find(|project| std::path::Path::new(&project.path) == wanted)
    }
}

fn git_out(dir: &std::path::Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git").arg("-C").arg(dir).args(args).env("GIT_CONFIG_GLOBAL", "/dev/null").output().unwrap();
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_project_is_cloned_from_its_remote_on_another_machine_with_its_env_files() {
    let Some(net) = ProvisionNet::new().await else { return };
    // The plan, as a client on any machine asks b for it.
    let plan = net.b.state.orchestrator.provision_plan(net.project_b.id, &net.c.id(), None).await.unwrap();
    assert!(plan.blocked.is_none() && plan.existing.is_empty(), "{plan:?}");
    assert_eq!(plan.source.id, net.b.id(), "the source is the machine asked, not the first one");
    let suggested = PathBuf::from(plan.suggested_path.clone().unwrap());
    assert_eq!(suggested, std::fs::canonicalize(net.root().join("c-home")).unwrap().join("kybern"), "next to c's other projects");
    assert_eq!(plan.path_check.as_ref().unwrap().state, PathState::Free);
    let env: Vec<&str> = plan.env_files.iter().map(|file| file.path.as_str()).collect();
    assert_eq!(env, vec![".env", "apps/web/.env.local"], "ignored env files only, no template");
    assert!(plan.env_files.iter().all(|file| file.selected));

    let status = net.provision(None, None, None).await;
    assert_eq!(status.phase, ProvisionPhase::Queued);
    let item = net.settled(status.operation_id).await;
    assert_eq!(item.state, OutboxState::Delivered, "{:?}", item.last_error);
    assert!(!item.payload.to_string().contains("zq-secret"), "the outbox never holds env contents");
    let result: ProvisionResult = serde_json::from_value(item.result.clone().unwrap()).unwrap();
    assert!(result.cloned_from_remote);
    assert_eq!(result.env_written, vec![".env".to_string(), "apps/web/.env.local".to_string()]);

    // c has the checkout on the same branch and commit, registered as a project, with the env files.
    let project = net.c_project_at(&suggested).expect("registered on c");
    assert_eq!(project.id, result.project.id);
    assert_eq!(git_out(&suggested, &["rev-parse", "HEAD"]), git_out(&net.repo_b, &["rev-parse", "HEAD"]));
    assert_eq!(git_out(&suggested, &["symbolic-ref", "--short", "HEAD"]), "main");
    assert_eq!(std::fs::read_to_string(suggested.join(".env")).unwrap(), "API_KEY=zq-secret-root\n");
    assert_eq!(std::fs::read_to_string(suggested.join("apps/web/.env.local")).unwrap(), "WEB_KEY=zq-secret-web\n");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(suggested.join(".env")).unwrap().permissions().mode() & 0o777, 0o600);
    }
    // Asking again now finds it there.
    let again = net.b.state.orchestrator.provision_plan(net.project_b.id, &net.c.id(), None).await.unwrap();
    assert_eq!(again.existing.len(), 1);
    let status = crate::network::provision::status(&net.b.state, item.operation_id).unwrap();
    assert_eq!(status.phase, ProvisionPhase::Done);
    let _ = &net.a;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_repository_the_target_cannot_clone_travels_as_a_bundle_with_its_unpushed_commits() {
    let Some(net) = ProvisionNet::new().await else { return };
    // The remote is one c cannot reach, and b has a commit nobody else has.
    run_git(&net.repo_b, &["remote", "set-url", "origin", "/nonexistent/kybern-origin.git"]);
    std::fs::write(net.repo_b.join("local.txt"), "only on b\n").unwrap();
    run_git(&net.repo_b, &["add", "local.txt"]);
    run_git(&net.repo_b, &["commit", "-q", "-m", "local work"]);
    let dest = net.root().join("c-home").join("bundled");

    let status = net.provision(Some(dest.clone()), Some(vec![]), None).await;
    let item = net.settled(status.operation_id).await;
    assert_eq!(item.state, OutboxState::Delivered, "{:?}", item.last_error);
    let result: ProvisionResult = serde_json::from_value(item.result.unwrap()).unwrap();
    assert!(!result.cloned_from_remote);
    assert!(result.env_written.is_empty(), "no env files were chosen");
    assert!(!dest.join(".env").exists());
    assert_eq!(git_out(&dest, &["rev-parse", "HEAD"]), git_out(&net.repo_b, &["rev-parse", "HEAD"]));
    assert_eq!(std::fs::read_to_string(dest.join("local.txt")).unwrap(), "only on b\n");
    assert_eq!(git_out(&dest, &["symbolic-ref", "--short", "HEAD"]), "main");
    assert_eq!(git_out(&dest, &["config", "remote.origin.url"]), "/nonexistent/kybern-origin.git", "origin names the source's remote");
    assert!(net.c_project_at(&dest).is_some());
    assert!(std::fs::read_dir(net.c.state.paths.root.join("transfers")).map_or(true, |mut dir| dir.next().is_none()), "no staged bundle left");
    let _ = &net.origin;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_folder_with_other_files_is_refused_and_the_same_repository_is_only_registered() {
    let Some(net) = ProvisionNet::new().await else { return };
    let busy = net.root().join("c-home").join("busy");
    std::fs::create_dir_all(&busy).unwrap();
    std::fs::write(busy.join("notes.txt"), "mine\n").unwrap();
    let plan = net.b.state.orchestrator.provision_plan(net.project_b.id, &net.c.id(), Some(busy.to_string_lossy().into())).await.unwrap();
    assert_eq!(plan.path_check.unwrap().state, PathState::NotEmpty);
    let status = net.provision(Some(busy.clone()), None, None).await;
    let item = net.settled(status.operation_id).await;
    assert_eq!(item.state, OutboxState::Failed);
    assert!(item.last_error.as_deref().unwrap_or("").contains("other files"), "{:?}", item.last_error);
    assert_eq!(std::fs::read_dir(&busy).unwrap().count(), 1, "nothing was written there");

    // A checkout of the same repository is used as it is: its own branch and changes stay.
    let mine = net.root().join("c-home").join("mine");
    run_git(&net.root(), &["clone", "-q", net.origin.to_str().unwrap(), mine.to_str().unwrap()]);
    run_git(&mine, &["checkout", "-q", "-b", "my-branch"]);
    std::fs::write(mine.join("wip.txt"), "uncommitted\n").unwrap();
    let plan = net.b.state.orchestrator.provision_plan(net.project_b.id, &net.c.id(), Some(mine.to_string_lossy().into())).await.unwrap();
    assert_eq!(plan.path_check.unwrap().state, PathState::SameRepo);
    let status = net.provision(Some(mine.clone()), None, None).await;
    let item = net.settled(status.operation_id).await;
    assert_eq!(item.state, OutboxState::Delivered, "{:?}", item.last_error);
    assert_eq!(git_out(&mine, &["symbolic-ref", "--short", "HEAD"]), "my-branch");
    assert!(mine.join("wip.txt").exists());
    assert!(net.c_project_at(&mine).is_some());

    // Forbidden places never get that far.
    let home = net.b.state.orchestrator.provision_plan(net.project_b.id, &net.c.id(), Some("~".into())).await.unwrap();
    assert_eq!(home.path_check.unwrap().state, PathState::Forbidden);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn provisioning_is_idempotent_by_operation_and_waits_for_an_offline_machine() {
    let Some(net) = ProvisionNet::new().await else { return };
    net.c.set_network_enabled(false);
    wait_until("b loses c", WAIT, || net.b.state.network.peers.link(&net.c.id()).is_none()).await;
    let plan = net.b.state.orchestrator.provision_plan(net.project_b.id, &net.c.id(), None).await.unwrap();
    assert!(!plan.target.online);
    assert_eq!(plan.path_check.unwrap().state, PathState::Unknown);

    let operation = Uuid::now_v7();
    let first = net.provision(None, None, Some(operation)).await;
    let second = net.provision(None, None, Some(operation)).await;
    assert_eq!(first.item_id, second.item_id, "a repeat is the first operation");
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(net.b.state.store.outbox_get_by_operation(operation).unwrap().unwrap().state, OutboxState::Queued, "it waits");

    net.c.set_network_enabled(true);
    wait_until("b and c linked again", WAIT, || crate::network::harness::linked(&net.b, &net.c)).await;
    net.b.state.orchestrator.remote_hub().unwrap().kick();
    let item = net.settled(operation).await;
    assert_eq!(item.state, OutboxState::Delivered, "{:?}", item.last_error);
    let result: ProvisionResult = serde_json::from_value(item.result.unwrap()).unwrap();

    // The target's steps can be repeated: a resent prepare continues, a resent finish returns the same project.
    let dest = PathBuf::from(&result.project.path);
    let again = net
        .c
        .state
        .orchestrator
        .serve_provision_prepare(PeerProvisionPrepareParams {
            operation_id: operation,
            path: result.project.path.clone(),
            rel: ".".into(),
            repo: crate::network::git_transfer::identity_of(&net.repo_b).await,
            remote_url: Some(net.origin.to_string_lossy().into()),
            branch: Some("main".into()),
            commit: git_out(&net.repo_b, &["rev-parse", "HEAD"]),
        })
        .await
        .unwrap();
    assert_eq!(again.state, PrepareState::Ready);
    let finish = PeerProvisionFinishParams {
        operation_id: operation,
        path: result.project.path.clone(),
        name: "kybern".into(),
        kind: ProjectKind::Single,
        members: Vec::new(),
        env_files: Vec::new(),
        cloned_from_remote: true,
    };
    let repeat = net.c.state.orchestrator.serve_provision_finish(&finish, vec![(".env".into(), b"OTHER=1\n".to_vec())]).await.unwrap();
    assert_eq!(repeat.project.id, result.project.id);
    assert_eq!(repeat.env_kept, vec![".env".to_string()], "an env file that is there is never overwritten");
    assert_eq!(std::fs::read_to_string(dest.join(".env")).unwrap(), "API_KEY=zq-secret-root\n");
    let refused = net.c.state.orchestrator.serve_provision_finish(&finish, vec![("src/main.rs".into(), b"x".to_vec())]).await;
    assert!(refused.is_err(), "only env files are written");
}

/// Machine a's parent agent (in `mode`) and machine b, which has no checkout of a's repository.
async fn agent_pair(mode: PermissionMode) -> Option<(Cluster, Node, Node, Fixture, Thread, Arc<LiveSession>, Arc<std::sync::Mutex<Vec<ScriptedChild>>>)> {
    let cluster = Cluster::new(&[NodeSpec::owner("a"), NodeSpec::owner("b")])?;
    let spawned = Arc::new(std::sync::Mutex::new(Vec::new()));
    let (repo_a, _) = two_checkouts(cluster.dir.path());
    let a = cluster.start_with("a", true, scripted_drivers(&Arc::new(std::sync::Mutex::new(Vec::new())))).await;
    let b = cluster.start_with("b", true, scripted_drivers(&spawned)).await;
    cluster.form(&a, &[&b], JoinVia::Auto).await;
    let project_a = git_project("kybern", &repo_a);
    a.state.store.project_insert(&project_a).unwrap();
    let other = cluster.dir.path().join("b-home").join("other");
    std::fs::create_dir_all(&other).unwrap();
    b.state.store.project_insert(&git_project("other", &other)).unwrap();
    wait_until("a and b linked", WAIT, || crate::network::harness::linked(&a, &b)).await;
    let fixture = Fixture {
        root: std::env::temp_dir().join(format!("kybern-provision-fixture-{}", Uuid::now_v7())),
        store: a.state.store.clone(),
        orchestrator: a.state.orchestrator.clone(),
        project: project_a,
    };
    let mut parent = fixture.thread(ThreadStatus::Idle);
    parent.permission_mode = mode;
    fixture.store.thread_upsert(&parent).unwrap();
    let (live, _, _) = fixture.park_recording(&parent, Instant::now()).await;
    fixture.orchestrator.send(parent.id, UserMessage::text("coordinate the work")).await.unwrap();
    live.turn_ready.notified().await;
    Some((cluster, a, b, fixture, parent, live, spawned))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn delegating_to_a_machine_without_the_repository_asks_and_then_runs_there() {
    let Some((cluster, a, b, fixture, parent, live, spawned)) = agent_pair(PermissionMode::Auto).await else { return };
    let (orchestrator, thread_id, session) = (fixture.orchestrator.clone(), parent.id, live.session_instance_id);
    let target = b.id();
    let call = tokio::spawn(async move {
        orchestrator
            .execute_native_app_tool_call(thread_id, session, "d1", "kybern_agent_delegate", json!({"task": "Run the provisioned test", "machine": target}))
            .await
    });
    let card = secret_card(&live).await;
    wait_until("the card is stored", WAIT, || fixture.store.approval_get(card).ok().flatten().is_some()).await;
    let (request, _) = fixture.store.approval_get(card).unwrap().unwrap();
    assert_eq!(request.tool_name, PROJECT_PROVISION_TOOL);
    let input: ProvisionCardInput = serde_json::from_value(request.input.clone()).unwrap();
    assert_eq!(input.then, "delegate");
    assert_eq!(input.plan.target.id, b.id());
    let dest = cluster.dir.path().join("b-home").join("chosen");
    // An env file the card did not offer is refused.
    let bad = json!({"path": dest.to_string_lossy(), "env_files": ["src/main.rs"]});
    assert!(fixture.orchestrator.respond_approval(card, ApprovalDecision::Submit { response: bad }).await.is_err());
    let answer = json!({"path": dest.to_string_lossy(), "env_files": []});
    fixture.orchestrator.respond_approval(card, ApprovalDecision::Submit { response: answer }).await.unwrap();
    let started = call.await.unwrap().unwrap();
    assert_eq!(started["provision"]["approved_by"], "user", "{started}");

    // The project lands on b, then the delegation that waited for it starts there.
    wait_until("the child started on b", WAIT * 4, || !spawned.lock().unwrap().is_empty()).await;
    let child = b.state.store.threads_list(None, true).unwrap().into_iter().find(|thread| thread.delegation.is_some()).unwrap();
    let project = b.state.store.project_get(child.project_id).unwrap().unwrap();
    assert_eq!(std::path::Path::new(&project.path), std::fs::canonicalize(&dest).unwrap());
    let _ = (&a, &parent);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn full_access_adds_the_project_with_the_proposed_folder_without_a_card() {
    let Some((cluster, _a, b, fixture, parent, live, spawned)) = agent_pair(PermissionMode::FullAccess).await else { return };
    let started = fixture
        .tool(&parent, &live, "d1", "kybern_agent_delegate", json!({"task": "Full access task", "machine": b.id()}))
        .await
        .unwrap();
    assert_eq!(started["provision"]["approved_by"], "full_access", "{started}");
    let proposed = std::fs::canonicalize(cluster.dir.path().join("b-home")).unwrap().join("kybern");
    assert_eq!(started["provision"]["path"], json!(proposed.to_string_lossy()));
    wait_until("the child started on b", WAIT * 4, || !spawned.lock().unwrap().is_empty()).await;
    assert!(proposed.join(".git").exists());
    assert!(live.daemon_approvals.lock().await.is_empty(), "no card in Full access");

}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_add_project_tool_takes_its_machine_argument_through_the_real_dispatch() {
    let Some((cluster, _a, b, fixture, parent, live, _spawned)) = agent_pair(PermissionMode::FullAccess).await else { return };
    // `machine` names the target to provision: the call must reach the tool, not be refused as "cannot run on another machine".
    let queued = fixture.tool(&parent, &live, "p1", "kybern_project_add_to_machine", json!({"machine": b.id(), "reason": "Needed for tests"})).await.unwrap();
    assert_eq!(queued["status"], "queued", "{queued}");
    assert_eq!(queued["approved_by"], "full_access", "{queued}");
    let proposed = std::fs::canonicalize(cluster.dir.path().join("b-home")).unwrap().join("kybern");
    wait_until("the project landed on b", WAIT * 4, || proposed.join(".git").exists()).await;
    assert!(live.daemon_approvals.lock().await.is_empty(), "no card in Full access");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn declining_the_card_fails_the_delegation_and_queues_nothing() {
    let Some((_cluster, a2, b2, fixture2, parent2, live2, _)) = agent_pair(PermissionMode::Supervised).await else { return };
    let (orchestrator, thread_id, session, target) = (fixture2.orchestrator.clone(), parent2.id, live2.session_instance_id, b2.id());
    let call = tokio::spawn(async move {
        orchestrator.execute_native_app_tool_call(thread_id, session, "d2", "kybern_agent_delegate", json!({"task": "Nope", "machine": target})).await
    });
    let card = secret_card(&live2).await;
    // The card is in the session before it is stored: answer once the store has it.
    wait_until("the card is stored", WAIT, || fixture2.store.approval_get(card).ok().flatten().is_some()).await;
    fixture2.orchestrator.respond_approval(card, ApprovalDecision::Deny { reason: None }).await.unwrap();
    let error = call.await.unwrap().unwrap_err().to_string();
    assert!(error.contains("chose not to add"), "{error}");
    assert!(a2.state.store.outbox_list(None, None).unwrap().is_empty(), "nothing was queued");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_delegation_that_reaches_a_machine_without_the_repository_waits_for_its_provisioning() {
    let Some((_cluster, a, b, fixture, parent, live, spawned)) = agent_pair(PermissionMode::Auto).await else { return };
    // The provisioning is queued but b is told about the delegation first: it answers "no checkout" and the
    // delegation waits instead of failing.
    b.set_network_enabled(false);
    wait_until("a loses b", WAIT, || a.state.network.peers.link(&b.id()).is_none()).await;
    let target = a.state.orchestrator.remote_hub().unwrap().resolve(&b.id()).unwrap();
    let project = a.state.store.project_get(parent.project_id).unwrap().unwrap();
    a.state.orchestrator.provision_enqueue(&project, &target, ProvisionChoice::default(), Uuid::now_v7(), None).await.unwrap();
    let started =
        fixture.tool(&parent, &live, "d1", "kybern_agent_delegate", json!({"task": "Waits for the project", "machine": b.id()})).await.unwrap();
    assert!(started.get("provision").is_none(), "an offline machine is not asked about");
    b.set_network_enabled(true);
    wait_until("the child started on b", WAIT * 4, || !spawned.lock().unwrap().is_empty()).await;
    assert!(a.state.store.outbox_list(None, None).unwrap().iter().all(|item| item.state == OutboxState::Delivered));
}
