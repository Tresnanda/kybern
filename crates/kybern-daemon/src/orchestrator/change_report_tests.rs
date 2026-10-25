// Change report and lead-copy cap tests. Included into `orchestrator::tests` so
// they can use its fixture, the repositories of the `kybern_git` tests and the
// scripted driver of the delegation tests.

fn commit_all(repo: &std::path::Path, message: &str) {
    git_in(repo, &["add", "-A"]);
    git_in(repo, &["commit", "-q", "-m", message]);
}

fn write_files(repo: &std::path::Path, names: impl IntoIterator<Item = String>) {
    for name in names {
        std::fs::write(repo.join(&name), format!("{name}\n")).unwrap();
    }
}

/// Wait for the turn the fixture started on its own to finish starting: its
/// own change report must not interleave with the test's.
async fn startup_done(fixture: &Fixture, thread: &Thread) {
    eventually(|| async { fixture.store.meta_get(&format!("handoff:{}", thread.id)).unwrap().map(|_| ()) }).await;
}

/// The first look at a repository records its heads and says nothing.
async fn first_look(t: &LeadRepo) {
    startup_done(&t.fixture, &t.thread).await;
    assert!(t.fixture.orchestrator.lead_change_report(&t.thread).await.unwrap().is_none(), "the first look only records");
}

async fn report(t: &LeadRepo) -> Option<String> {
    t.fixture.orchestrator.lead_change_report(&t.thread).await.unwrap().map(|report| report.text)
}

#[tokio::test]
async fn a_deletion_a_rename_and_counts_are_reported_once_and_only_after_they_were_seen() {
    let t = LeadRepo::new().await;
    std::fs::write(t.repo.join("gone.txt"), "g\n").unwrap();
    std::fs::write(t.repo.join("old.txt"), "a body long enough for rename detection\nsecond line\nthird line\n").unwrap();
    std::fs::write(t.repo.join("keep.txt"), "k\n").unwrap();
    commit_all(&t.repo, "Base");
    first_look(&t).await;
    assert!(report(&t).await.is_none(), "nothing changed");

    std::fs::remove_file(t.repo.join("gone.txt")).unwrap();
    commit_all(&t.repo, "Remove gone");
    git_in(&t.repo, &["mv", "old.txt", "new.txt"]);
    git_in(&t.repo, &["commit", "-q", "-m", "Rename old"]);
    std::fs::write(t.repo.join("keep.txt"), "k\nmore\n").unwrap();
    std::fs::write(t.repo.join("added.txt"), "a\n").unwrap();
    commit_all(&t.repo, "Edit and add");

    let first = t.fixture.orchestrator.lead_change_report(&t.thread).await.unwrap().expect("code changed");
    let text = first.text.clone();
    assert!(text.starts_with("Code changed since your last turn:\n- fixture · main: 3 commits ("), "{text}");
    assert!(text.contains("Remove gone (Lead Test): deleted `gone.txt`"), "{text}");
    assert!(text.contains("Rename old (Lead Test): renamed `old.txt` → `new.txt`"), "{text}");
    assert!(text.contains("Edit and add (Lead Test): modified 1 file; added 1 file"), "{text}");
    assert!(!text.contains("uncommitted"), "{text}");

    // Until the message that carried it was accepted, the heads are not marked seen.
    assert_eq!(report(&t).await.as_deref(), Some(text.as_str()));
    t.fixture.orchestrator.lead_change_seen(&t.thread, first).await;
    assert!(report(&t).await.is_none(), "reported once");

    // Later changes are reported from where the lead left off.
    std::fs::write(t.repo.join("keep.txt"), "again\n").unwrap();
    commit_all(&t.repo, "Touch keep");
    let later = report(&t).await.unwrap();
    assert!(later.contains("main: 1 commit (") && later.contains("Touch keep") && !later.contains("Remove gone"), "{later}");
}

#[tokio::test]
async fn at_most_twenty_commits_and_fifteen_removed_paths_are_listed_and_the_rest_counted() {
    let t = LeadRepo::new().await;
    write_files(&t.repo, (0..20).map(|i| format!("doomed{i:02}.txt")));
    commit_all(&t.repo, "Base");
    first_look(&t).await;

    for i in 0..20 {
        std::fs::remove_file(t.repo.join(format!("doomed{i:02}.txt"))).unwrap();
    }
    commit_all(&t.repo, "Delete twenty");
    for i in 0..24 {
        std::fs::write(t.repo.join(format!("c{i}.txt")), "c\n").unwrap();
        commit_all(&t.repo, &format!("Commit {i}"));
    }
    let text = report(&t).await.unwrap();
    assert!(text.contains("main: 25 commits ("), "{text}");
    assert_eq!(text.lines().filter(|line| line.starts_with("  - ") && line.contains("(Lead Test)")).count(), 20, "{text}");
    assert!(text.contains("  - +5 more (kybern_git log for the rest)"), "{text}");
    // The deleting commit is the oldest, so it falls outside the 20 listed.
    assert!(!text.contains("doomed00"), "{text}");

    // With few commits the deletion list is capped on its own.
    let t = LeadRepo::new().await;
    write_files(&t.repo, (0..20).map(|i| format!("doomed{i:02}.txt")));
    commit_all(&t.repo, "Base");
    first_look(&t).await;
    for i in 0..20 {
        std::fs::remove_file(t.repo.join(format!("doomed{i:02}.txt"))).unwrap();
    }
    commit_all(&t.repo, "Delete twenty");
    let text = report(&t).await.unwrap();
    assert_eq!(text.matches("`doomed").count(), 15, "{text}");
    assert!(text.contains("+5 more deleted or renamed"), "{text}");
}

#[tokio::test]
async fn a_rewritten_branch_is_reported_as_rewritten_with_its_last_commits() {
    let t = LeadRepo::new().await;
    std::fs::write(t.repo.join("b.txt"), "b\n").unwrap();
    commit_all(&t.repo, "Second");
    first_look(&t).await;

    git_in(&t.repo, &["reset", "-q", "--hard", "HEAD~1"]);
    std::fs::write(t.repo.join("b.txt"), "different\n").unwrap();
    commit_all(&t.repo, "Second, rewritten");
    let text = report(&t).await.unwrap();
    assert!(text.contains("fixture · main: history rewritten (was "), "{text}");
    assert!(text.contains("last 2 commits:") && text.contains("Second, rewritten") && text.contains(" init "), "{text}");
}

#[tokio::test]
async fn uncommitted_files_are_listed_up_to_ten_and_reported_again_only_when_they_change() {
    let t = LeadRepo::new().await;
    first_look(&t).await;
    assert!(report(&t).await.is_none());

    write_files(&t.repo, (0..12).map(|i| format!("wip{i:02}.txt")));
    let text = report(&t).await.unwrap();
    assert!(text.contains("- fixture · uncommitted in the main checkout: 12 files (`wip00.txt`"), "{text}");
    assert_eq!(text.matches("`wip").count(), 10, "{text}");
    assert!(text.contains(", +2)"), "{text}");

    // The same dirty tree is not repeated every turn.
    let report_now = t.fixture.orchestrator.lead_change_report(&t.thread).await.unwrap().unwrap();
    t.fixture.orchestrator.lead_change_seen(&t.thread, report_now).await;
    assert!(report(&t).await.is_none());
    std::fs::write(t.repo.join("wip12.txt"), "x\n").unwrap();
    assert!(report(&t).await.unwrap().contains("13 files"));
}

#[tokio::test]
async fn a_branch_a_child_worked_on_is_tracked_for_fourteen_days() {
    let t = LeadRepo::new().await;
    startup_done(&t.fixture, &t.thread).await;
    let child = t.worktree_child("b.txt", "one\n");
    let branch = child.delegation.as_ref().and_then(|d| d.branch.clone()).unwrap();
    first_look(&t).await;
    assert!(t.fixture.orchestrator.lead_git_heads(&t.thread).await["."].contains_key(&branch));

    let worktree = std::path::Path::new(&child.cwd);
    std::fs::write(worktree.join("c.txt"), "two\n").unwrap();
    commit_all(worktree, "Child follow-up");
    let text = report(&t).await.unwrap();
    assert!(text.contains(&format!("- fixture · {branch}: 1 commit (")) && text.contains("Child follow-up"), "{text}");
    assert!(!text.contains("fixture · main"), "the default branch did not move: {text}");

    // Children older than fourteen days are no longer followed.
    let mut stale = t.fixture.store.thread_get(child.id).unwrap().unwrap();
    let info = stale.delegation.as_mut().unwrap();
    info.started_at = chrono::Utc::now() - chrono::Duration::days(20);
    info.completed_at = Some(chrono::Utc::now() - chrono::Duration::days(15));
    t.fixture.store.thread_upsert(&stale).unwrap();
    assert!(!t.fixture.orchestrator.lead_git_heads(&t.thread).await["."].contains_key(&branch));
}

#[tokio::test]
async fn a_group_project_reports_each_repository_by_name() {
    let g = GroupLead::new().await;
    let thread = g.lead.thread.clone();
    startup_done(&g.lead.fixture, &thread).await;
    let o = &g.lead.fixture.orchestrator;
    // The fixture's own startup recorded the plain repository this thread began in.
    g.lead.fixture.store.meta_set(&format!("lead_seen:{}:.", thread.id), "").unwrap();
    assert!(o.lead_change_report(&thread).await.unwrap().is_none(), "the first look only records");

    std::fs::write(g.group.join("api/b.rs"), "b\n").unwrap();
    commit_all(&g.group.join("api"), "Add b to api");
    std::fs::remove_file(g.group.join("web/w.ts")).unwrap();
    commit_all(&g.group.join("web"), "Drop w");
    let text = o.lead_change_report(&thread).await.unwrap().expect("two repositories changed").text;
    assert!(text.contains("- api · main: 1 commit (") && text.contains("Add b to api (Lead Test): added 1 file"), "{text}");
    assert!(text.contains("- web · main: 1 commit (") && text.contains("Drop w (Lead Test): deleted `w.ts`"), "{text}");
    // The group folder is a repository too, but its nested members are not its own changes.
    assert!(!text.contains("acme"), "{text}");
}

#[tokio::test]
async fn git_delta_since_diffs_against_given_heads_without_the_header() {
    let t = LeadRepo::new().await;
    startup_done(&t.fixture, &t.thread).await;
    let o = &t.fixture.orchestrator;
    let heads = o.lead_git_heads(&t.thread).await;
    assert!(o.git_delta_since(&t.thread, &heads).await.is_none(), "nothing since the heads");
    std::fs::write(t.repo.join("n.txt"), "n\n").unwrap();
    commit_all(&t.repo, "New file");
    let delta = o.git_delta_since(&t.thread, &heads).await.unwrap();
    assert!(delta.starts_with("- fixture · main: 1 commit (") && delta.contains("New file"), "{delta}");
    assert!(!delta.contains("Code changed since your last turn"), "{delta}");
    // Without a baseline there is nothing to compare with.
    assert!(o.git_delta_since(&t.thread, &super::change_report::SeenHeads::new()).await.is_none());
}

/// A scripted driver whose sessions refuse their next message while `fail` is set.
struct FlakyDriver {
    inner: ScriptedDriver,
    fail: Arc<AtomicBool>,
}

struct FlakySession {
    inner: Box<dyn AgentSession>,
    fail: Arc<AtomicBool>,
}

#[async_trait::async_trait]
impl kybern_drivers::AgentDriver for FlakyDriver {
    fn kind(&self) -> ProviderKind {
        self.inner.kind()
    }

    async fn probe(&self, binary: Option<&PathBuf>) -> ProviderStatus {
        self.inner.probe(binary).await
    }

    async fn spawn(&self, config: kybern_drivers::SessionConfig) -> kybern_drivers::Result<kybern_drivers::SpawnedSession> {
        let spawned = self.inner.spawn(config).await?;
        Ok(kybern_drivers::SpawnedSession {
            session: Box::new(FlakySession { inner: spawned.session, fail: self.fail.clone() }),
            events: spawned.events,
        })
    }
}

#[async_trait::async_trait]
impl AgentSession for FlakySession {
    async fn send_message(&self, message_id: &str, message: &UserMessage) -> kybern_drivers::Result<()> {
        if self.fail.load(Ordering::SeqCst) {
            return Err(kybern_drivers::DriverError::Protocol("refused".into()));
        }
        self.inner.send_message(message_id, message).await
    }

    async fn steer(&self, message_id: &str, message: &UserMessage) -> kybern_drivers::Result<()> {
        self.inner.steer(message_id, message).await
    }

    async fn interrupt(&self) -> kybern_drivers::Result<()> {
        self.inner.interrupt().await
    }

    async fn set_permission_mode(&self, mode: PermissionMode) -> kybern_drivers::Result<()> {
        self.inner.set_permission_mode(mode).await
    }

    async fn set_model(&self, model: &str) -> kybern_drivers::Result<()> {
        self.inner.set_model(model).await
    }

    async fn set_effort(&self, effort: &str) -> kybern_drivers::Result<()> {
        self.inner.set_effort(effort).await
    }

    async fn respond_permission(&self, request_id: &str, decision: &ApprovalDecision) -> kybern_drivers::Result<()> {
        self.inner.respond_permission(request_id, decision).await
    }

    async fn close(&self) -> kybern_drivers::Result<()> {
        self.inner.close().await
    }
}

/// A Coordinator on a scripted driver, working in a real repository on `main`.
async fn scripted_lead(fail: Arc<AtomicBool>) -> (Fixture, Thread, Arc<std::sync::Mutex<Vec<ScriptedChild>>>, std::path::PathBuf) {
    let spawned = Arc::new(std::sync::Mutex::new(Vec::new()));
    let mut drivers = DriverRegistry::default();
    drivers.register(Arc::new(FlakyDriver { inner: ScriptedDriver { kind: ProviderKind::ClaudeCode, spawned: spawned.clone() }, fail }));
    let fixture = Fixture::with_drivers(drivers);
    let repo = fixture.root.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git_in(&repo, &["init", "-q"]);
    git_in(&repo, &["symbolic-ref", "HEAD", "refs/heads/main"]);
    git_in(&repo, &["config", "user.name", "Lead Test"]);
    git_in(&repo, &["config", "user.email", "lead@example.com"]);
    std::fs::write(repo.join("gone.txt"), "g\n").unwrap();
    commit_all(&repo, "init");
    let mut project = fixture.store.project_get(fixture.project.id).unwrap().unwrap();
    project.path = repo.to_string_lossy().into_owned();
    fixture.store.project_update(&project).unwrap();
    // A brief keeps the Coordinator from starting its setup interview.
    user_note(&fixture, "Project brief", "Be careful.", Some(ProjectNoteRole::Brief));
    let lead = fixture.orchestrator.coordinator_open(open_params(&project, ProviderKind::ClaudeCode, None)).await.unwrap().thread;
    (fixture, lead, spawned, repo)
}

async fn settle(fixture: &Fixture, lead: &Thread, status: ThreadStatus) {
    eventually(|| async { (fixture.store.thread_get(lead.id).unwrap().unwrap().status == status).then_some(()) }).await;
}

#[tokio::test]
async fn the_change_report_leads_the_providers_copy_once_and_never_reaches_the_transcript() {
    let (fixture, lead, spawned, repo) = scripted_lead(Arc::new(AtomicBool::new(false))).await;
    fixture.orchestrator.send(lead.id, UserMessage::text("first request")).await.unwrap();
    let agent = eventually(|| async { spawned.lock().unwrap().first().cloned() }).await;
    eventually(|| async { (!agent.messages.lock().await.is_empty()).then_some(()) }).await;
    assert!(!agent.transcript().await.contains("Code changed"), "the first look says nothing");
    agent.finish("done").await;
    settle(&fixture, &lead, ThreadStatus::Idle).await;

    std::fs::remove_file(repo.join("gone.txt")).unwrap();
    commit_all(&repo, "Remove gone");
    fixture.orchestrator.send(lead.id, UserMessage::text("second request")).await.unwrap();
    eventually(|| async { (agent.messages.lock().await.len() == 2).then_some(()) }).await;
    let second = agent.messages.lock().await[1].clone();
    let ContentPart::Text { text } = &second.parts[0] else { panic!("the report leads the message: {second:?}") };
    assert!(text.starts_with("Code changed since your last turn:\n- fixture · main: 1 commit ("), "{text}");
    assert!(text.contains("Remove gone (Lead Test): deleted `gone.txt`"), "{text}");
    assert!(matches!(second.parts.last(), Some(ContentPart::Text { text }) if text == "second request"));
    let stored = serde_json::to_string(&fixture.store.events_for_thread(lead.id).unwrap()).unwrap();
    assert!(stored.contains("second request") && !stored.contains("Code changed"), "the report is not part of the user's message");

    agent.finish("done").await;
    settle(&fixture, &lead, ThreadStatus::Idle).await;
    fixture.orchestrator.send(lead.id, UserMessage::text("third request")).await.unwrap();
    eventually(|| async { (agent.messages.lock().await.len() == 3).then_some(()) }).await;
    assert_eq!(agent.messages.lock().await[2].parts.len(), 1, "a report is sent once");
}

#[tokio::test]
async fn a_report_whose_message_was_refused_is_sent_again_with_the_next_one() {
    let fail = Arc::new(AtomicBool::new(false));
    let (fixture, lead, spawned, repo) = scripted_lead(fail.clone()).await;
    fixture.orchestrator.send(lead.id, UserMessage::text("first request")).await.unwrap();
    let agent = eventually(|| async { spawned.lock().unwrap().first().cloned() }).await;
    eventually(|| async { (!agent.messages.lock().await.is_empty()).then_some(()) }).await;
    agent.finish("done").await;
    settle(&fixture, &lead, ThreadStatus::Idle).await;

    std::fs::remove_file(repo.join("gone.txt")).unwrap();
    commit_all(&repo, "Remove gone");
    fail.store(true, Ordering::SeqCst);
    let _ = fixture.orchestrator.send(lead.id, UserMessage::text("refused request")).await;
    settle(&fixture, &lead, ThreadStatus::Failed).await;
    assert_eq!(agent.messages.lock().await.len(), 1, "the refused message never arrived");

    fail.store(false, Ordering::SeqCst);
    fixture.orchestrator.send(lead.id, UserMessage::text("retried request")).await.unwrap();
    eventually(|| async { (agent.messages.lock().await.len() == 2).then_some(()) }).await;
    let retried = agent.messages.lock().await[1].clone();
    assert!(matches!(&retried.parts[0], ContentPart::Text { text } if text.contains("deleted `gone.txt`")), "{retried:?}");
}

fn long_result(marker: &str) -> String {
    let mut text = String::new();
    while text.len() < 4000 {
        text.push_str("The importer now streams rows instead of buffering them. ");
    }
    text.push_str(marker);
    text
}

fn result_item(thread_id: ThreadId, result: &str) -> AgentResultItem {
    AgentResultItem {
        task_id: Uuid::now_v7(),
        thread_id,
        title: "Fix the importer".into(),
        provider: ProviderKind::ClaudeCode,
        model: None,
        role: DelegationRole::default(),
        status: DelegationStatus::Completed,
        result: Some(result.into()),
        error: None,
        workspace: DelegationWorkspace::Worktree,
        branch: Some("kybern/child".into()),
        head_commit: Some("abc1234def".into()),
        base_commit: Some("0000000aaa".into()),
        diffstat: Some(DiffStat { files: 3, additions: 40, deletions: 5 }),
        files_touched: Vec::new(),
        conflicts: Vec::new(),
    }
}

#[tokio::test]
async fn a_leads_copy_of_child_results_and_messages_is_capped_but_the_transcript_and_other_threads_keep_the_full_text() {
    let (fixture, lead, spawned, _repo) = scripted_lead(Arc::new(AtomicBool::new(false))).await;
    let child_id = Uuid::now_v7();
    let marker = "END-OF-THE-FULL-RESULT";
    let message = UserMessage {
        parts: vec![
            ContentPart::AgentResults { items: vec![result_item(child_id, &long_result(marker))] },
            ContentPart::ThreadMessage {
                message_id: Uuid::now_v7(),
                from_thread_id: Some(child_id),
                from_title: "Child".into(),
                purpose: ThreadMessagePurpose::Message,
                reply_to: None,
                body: long_result("END-OF-THE-FULL-MESSAGE"),
            },
        ],
    };

    fixture.orchestrator.send(lead.id, message.clone()).await.unwrap();
    let agent = eventually(|| async { spawned.lock().unwrap().first().cloned() }).await;
    eventually(|| async { (!agent.messages.lock().await.is_empty()).then_some(()) }).await;
    let sent = agent.messages.lock().await[0].clone();
    let texts: Vec<&str> = sent.parts.iter().filter_map(|part| if let ContentPart::Text { text } = part { Some(text.as_str()) } else { None }).collect();
    assert_eq!(texts.len(), 2, "both parts reach the lead as capped text: {sent:?}");
    let (results, thread_message) = (texts[0], texts[1]);
    assert!(results.contains("Fix the importer") && results.contains("completed"), "{results}");
    assert!(results.contains("branch kybern/child at abc1234def") && results.contains("3 files +40 −5"), "{results}");
    assert!(results.contains(&format!("Full result: kybern_thread_read {child_id}")), "{results}");
    assert!(results.len() < 2400 && !results.contains(marker), "{} bytes", results.len());
    assert!(results.contains("streams rows instead of buffering them."), "cut on a sentence boundary: {results}");
    assert!(thread_message.contains(&format!("kybern_thread_read {child_id}")) && !thread_message.contains("END-OF-THE-FULL-MESSAGE"));
    assert!(thread_message.len() < 2000, "{} bytes", thread_message.len());

    // The saved conversation (and so every client) still has the whole text.
    let stored = serde_json::to_string(&fixture.store.events_for_thread(lead.id).unwrap()).unwrap();
    assert!(stored.contains(marker) && stored.contains("END-OF-THE-FULL-MESSAGE"), "stored messages are unchanged");

    // A thread that is not a Coordinator receives the batch as before.
    let plain = fixture.thread(ThreadStatus::Idle);
    fixture.orchestrator.send(plain.id, message).await.unwrap();
    let other = eventually(|| async { spawned.lock().unwrap().get(1).cloned() }).await;
    eventually(|| async { (!other.messages.lock().await.is_empty()).then_some(()) }).await;
    let received = other.messages.lock().await[0].clone();
    assert!(matches!(&received.parts[0], ContentPart::AgentResults { .. }), "{received:?}");
    assert!(other.transcript().await.contains(marker));
}
