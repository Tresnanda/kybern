//! The login broker and pushed keys on the in-process multi-daemon harness (ADE-86 S4, design §9.3,
//! §9.4, §11.2). They skip on a computer without the `127.x.0.n` loopback aliases.
//!
//! **The fake harness.** The broker's Claude is a shell script (`fake_claude`) with a login of its own
//! in a named account's folder. `claude -p` rotates that login, as a real refresh does: the old token stops
//! being valid at once and a new one is written. The borrower's agent is a fake driver that does what the
//! real Claude driver does with a lent login: it asks the registry for the session's source, takes the
//! token from it, and rejects the turn with Claude's own words when the token is no longer the valid one.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use kybern_client::{Client, Endpoint};
use kybern_drivers::login_lend;
use kybern_drivers::{AgentDriver, AgentSession, DriverEvent, SessionConfig, SpawnedSession, TurnAnchors};
use kybern_protocol::methods::*;
use kybern_protocol::*;
use serde_json::json;

use super::harness::*;
use super::manage::rename;

/// A `claude` that signs in (`auth status`), logs out (`auth logout`) and refreshes (`-p`). The account's
/// folder is `CLAUDE_CONFIG_DIR`, and its `.email` the account's email (broker@example.com without one);
/// `FAKE_STATE` holds `valid` (the only token that works), a counter and a log of what was run.
const FAKE_CLAUDE: &str = r#"#!/bin/sh
state="$FAKE_STATE"
case "$1" in
  auth)
    if [ "$2" = "logout" ]; then
      echo "logout $(date +%s%N)" >> "$state/events"
      rm -f "$CLAUDE_CONFIG_DIR/.credentials.json"
      exit 0
    fi
    if [ -f "$CLAUDE_CONFIG_DIR/.credentials.json" ]; then
      email=$(cat "$CLAUDE_CONFIG_DIR/.email" 2>/dev/null || echo broker@example.com)
      echo "{\"loggedIn\":true,\"authMethod\":\"claude.ai\",\"email\":\"$email\",\"subscriptionType\":\"max\"}"
    else
      echo '{"loggedIn":false}'
    fi
    exit 0;;
  -p)
    n=$(cat "$state/n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$state/n"
    new="tok-$n"
    printf '%s' "$new" > "$state/valid"
    exp=$(( ($(date +%s) + 28800) * 1000 ))
    printf '{"claudeAiOauth":{"accessToken":"%s","refreshToken":"refresh-%s","expiresAt":%s,"scopes":["user:inference","user:profile"],"subscriptionType":"max"}}' "$new" "$n" "$exp" > "$CLAUDE_CONFIG_DIR/.credentials.json"
    echo "refresh $new" >> "$state/events"
    echo '{"type":"result","result":"ok"}'
    exit 0;;
esac
exit 0
"#;

const REVOKED: &str = "Failed to authenticate: OAuth token revoked. Please log in again or contact your administrator.";

fn write_fake_claude(dir: &Path) -> PathBuf {
    std::fs::create_dir_all(dir).unwrap();
    let path = dir.join("claude");
    kybern_protocol::process::write_executable(&path, FAKE_CLAUDE).unwrap();
    path
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Sign the fake account in with `token`, valid for `lifetime_ms` more.
fn write_login(account_dir: &Path, state_dir: &Path, token: &str, lifetime_ms: i64) {
    std::fs::create_dir_all(account_dir).unwrap();
    std::fs::create_dir_all(state_dir).unwrap();
    std::fs::write(state_dir.join("valid"), token).unwrap();
    std::fs::write(
        account_dir.join(".credentials.json"),
        json!({"claudeAiOauth": {"accessToken": token, "refreshToken": "refresh-0", "expiresAt": now_ms() + lifetime_ms,
            "scopes": ["user:inference", "user:profile"], "subscriptionType": "max"}})
        .to_string(),
    )
    .unwrap();
}

fn events_of(state_dir: &Path) -> Vec<String> {
    std::fs::read_to_string(state_dir.join("events")).unwrap_or_default().lines().map(str::to_string).collect()
}

// ---- the borrower's fake agent ----

/// One agent process the fake driver started.
#[derive(Clone)]
struct Spawned {
    token: String,
    resume: Option<String>,
    sent: Arc<Mutex<Vec<String>>>,
    closed: Arc<std::sync::atomic::AtomicBool>,
}

#[derive(Clone, Default)]
struct Hold(Arc<tokio::sync::Mutex<Option<Arc<tokio::sync::Notify>>>>);

struct LentDriver {
    /// Each broker's file of the one token that works; a token is valid when any of them holds it.
    valid_files: Vec<PathBuf>,
    spawned: Arc<Mutex<Vec<Spawned>>>,
    /// While set, a turn waits for this before it checks its token (a turn in flight when the broker rotates).
    hold: Hold,
}

struct LentSession {
    tx: tokio::sync::mpsc::Sender<DriverEvent>,
    token: String,
    valid_files: Vec<PathBuf>,
    sent: Arc<Mutex<Vec<String>>>,
    closed: Arc<std::sync::atomic::AtomicBool>,
    hold: Hold,
}

#[async_trait::async_trait]
impl AgentSession for LentSession {
    async fn send_message(&self, _message_id: &str, message: &UserMessage) -> kybern_drivers::Result<()> {
        let text = serde_json::to_string(message).unwrap();
        self.sent.lock().unwrap().push(text);
        let (tx, token, valid_files, hold) = (self.tx.clone(), self.token.clone(), self.valid_files.clone(), self.hold.clone());
        tokio::spawn(async move {
            let gate = hold.0.lock().await.clone();
            if let Some(gate) = gate {
                gate.notified().await;
            }
            let _ = tx.send(DriverEvent::SessionBound { session_id: "native-1".into(), model: None }).await;
            if valid_files.iter().any(|file| std::fs::read_to_string(file).unwrap_or_default() == token) {
                let _ = tx
                    .send(DriverEvent::MessageCompleted {
                        message_id: uuid::Uuid::now_v7().to_string(),
                        origin: EventOrigin::Root,
                        text: "answered".into(),
                        thinking: None,
                    })
                    .await;
                let _ = tx
                    .send(DriverEvent::TurnCompleted {
                        stop_reason: StopReason::Completed,
                        usage: Usage::default(),
                        cost_usd: Some(0.0),
                        duration_ms: 1,
                        anchors: TurnAnchors::default(),
                    })
                    .await;
            } else {
                let _ = tx.send(DriverEvent::TurnFailed { error: REVOKED.into(), problem: None }).await;
            }
        });
        Ok(())
    }
    async fn steer(&self, _id: &str, _message: &UserMessage) -> kybern_drivers::Result<()> {
        Ok(())
    }
    async fn interrupt(&self) -> kybern_drivers::Result<()> {
        Ok(())
    }
    async fn set_permission_mode(&self, _mode: PermissionMode) -> kybern_drivers::Result<()> {
        Ok(())
    }
    async fn set_model(&self, _model: &str) -> kybern_drivers::Result<()> {
        Ok(())
    }
    async fn set_effort(&self, _effort: &str) -> kybern_drivers::Result<()> {
        Ok(())
    }
    async fn respond_permission(&self, _request_id: &str, _decision: &ApprovalDecision) -> kybern_drivers::Result<()> {
        Ok(())
    }
    async fn close(&self) -> kybern_drivers::Result<()> {
        self.closed.store(true, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }
}

#[async_trait::async_trait]
impl AgentDriver for LentDriver {
    fn kind(&self) -> ProviderKind {
        ProviderKind::ClaudeCode
    }

    async fn probe(&self, _binary: Option<&PathBuf>) -> ProviderStatus {
        ProviderStatus {
            kind: ProviderKind::ClaudeCode,
            display_name: "Claude Code".into(),
            available: true,
            binary_path: None,
            version: None,
            unavailable_reason: None,
            supported_permission_modes: PermissionMode::ALL.to_vec(),
            supports_fork: false,
            supports_model_switch: false,
            supports_effort_switch: false,
            supported_efforts: vec![],
            models: vec![],
            instances: vec![],
        }
    }

    async fn spawn(&self, config: SessionConfig) -> kybern_drivers::Result<SpawnedSession> {
        // What the real driver does: resolve the handle, take the token, never put the handle in the child's env.
        let token = match login_lend::source_of(&config.env) {
            Some(source) => match source.current().await.map_err(kybern_drivers::DriverError::Protocol)? {
                BorrowedLogin::Claude { access_token, .. } => access_token,
                other => panic!("a Claude session was lent {other:?}"),
            },
            None => "not lent".into(),
        };
        let (tx, events) = tokio::sync::mpsc::channel(64);
        let spawned = Spawned {
            token: token.clone(),
            resume: config.resume_session_id.clone(),
            sent: Arc::new(Mutex::new(Vec::new())),
            closed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        };
        self.spawned.lock().unwrap().push(spawned.clone());
        let session = LentSession {
            tx,
            token,
            valid_files: self.valid_files.clone(),
            sent: spawned.sent,
            closed: spawned.closed,
            hold: self.hold.clone(),
        };
        Ok(SpawnedSession { session: Box::new(session), events })
    }
}

// ---- logs ----

#[derive(Clone, Default)]
struct Capture(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for Capture {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Everything every test in this process logs, at every level. A scoped subscriber would miss the events of
/// spawned tasks and of nodes on other threads, so the capture is process-wide and installed once.
fn captured_logs() -> &'static Capture {
    static CAPTURE: std::sync::OnceLock<Capture> = std::sync::OnceLock::new();
    CAPTURE.get_or_init(|| {
        let capture = Capture::default();
        let writer = capture.clone();
        let subscriber =
            tracing_subscriber::fmt().with_max_level(tracing::Level::TRACE).with_ansi(false).with_writer(move || writer.clone()).finish();
        let _ = tracing::subscriber::set_global_default(subscriber);
        capture
    })
}

// ---- the fixture ----

/// A node whose harnesses look at an empty home. Without this a "default" account would be this computer's
/// real CLI sign-in: it would show as lendable, and a borrow could read its login. Nothing here may.
fn isolate(node: &Node, claude_binary: &Path) {
    let home = node.root.join("home");
    std::fs::create_dir_all(home.join(".codex")).unwrap();
    let mut settings = node.state.settings.get();
    for kind in [ProviderKind::ClaudeCode, ProviderKind::Codex, ProviderKind::Omp] {
        let provider = settings.providers.entry(kind).or_default();
        provider.env.insert("HOME".into(), home.to_string_lossy().into_owned());
        provider.env.insert("USERPROFILE".into(), home.to_string_lossy().into_owned());
        if kind == ProviderKind::Codex {
            provider.env.insert("CODEX_HOME".into(), home.join(".codex").to_string_lossy().into_owned());
        }
        if kind == ProviderKind::ClaudeCode {
            provider.binary = Some(claude_binary.to_string_lossy().into_owned());
            provider.env.insert("FAKE_STATE".into(), node.root.join("fake-claude").to_string_lossy().into_owned());
        }
    }
    node.state.settings.set(settings).unwrap();
}

/// Three machines in one network: "mac" (a), "pc" (b, borrows) and "vps" (c, the broker).
struct Lending {
    cluster: Cluster,
    a: Node,
    b: Node,
    c: Node,
    /// The broker's Claude: its account folder, its fake state and the account's instance id.
    broker_dir: PathBuf,
    broker_state: PathBuf,
    broker_account: String,
    /// The borrower's local named account and its fake agent.
    local_account: String,
    spawned: Arc<Mutex<Vec<Spawned>>>,
    hold: Hold,
}

async fn lending() -> Option<Lending> {
    let cluster = Cluster::new(&[NodeSpec::owner("a"), NodeSpec::owner("b"), NodeSpec::tagged("c")])?;
    captured_logs();
    let script = write_fake_claude(&cluster.dir.path().join("bin"));
    let valid_files =
        vec![cluster.dir.path().join("vps-claude-state").join("valid"), cluster.dir.path().join("mac-claude-state").join("valid")];
    let spawned = Arc::new(Mutex::new(Vec::new()));
    let hold = Hold::default();
    let mut drivers = kybern_drivers::registry::DriverRegistry::default();
    drivers.register(Arc::new(LentDriver { valid_files, spawned: spawned.clone(), hold: hold.clone() }));
    let a = cluster.start("a", true).await;
    let b = cluster.start_with("b", true, drivers).await;
    let c = cluster.start("c", true).await;
    for node in [&a, &b, &c] {
        isolate(node, &script);
    }
    cluster.form(&a, &[&b, &c], JoinVia::Auto).await;
    // Every member runs the broker's watch, quickly, as the daemons do every half minute.
    for node in [&a, &b, &c] {
        tokio::spawn(super::broker::run_every(node.state.clone(), Duration::from_millis(200)));
    }
    for (node, name) in [(&a, "mac"), (&b, "pc"), (&c, "vps")] {
        rename(&a.state, &node.id(), name).await.unwrap();
    }
    eventually("everyone is linked", WAIT, || linked(&a, &b) && linked(&a, &c) && linked(&b, &c)).await;

    // The VPS has a signed-in Claude account of its own, with the fake binary.
    let broker_state = cluster.dir.path().join("vps-claude-state");
    std::fs::create_dir_all(&broker_state).unwrap();
    let account = crate::provider_accounts::create(
        &c.state,
        AccountsCreateParams { kind: ProviderKind::ClaudeCode, name: "Shared".into(), directory: None },
    )
    .unwrap();
    let broker_dir =
        std::path::PathBuf::from(c.state.settings.get().providers[&ProviderKind::ClaudeCode].accounts[&account.instance].directory.clone());
    let mut settings = c.state.settings.get();
    let provider = settings.providers.entry(ProviderKind::ClaudeCode).or_default();
    provider.binary = Some(script.to_string_lossy().into_owned());
    provider.env.insert("FAKE_STATE".into(), broker_state.to_string_lossy().into_owned());
    c.state.settings.set(settings).unwrap();
    write_login(&broker_dir, &broker_state, "tok-0", 8 * 3600 * 1000);

    // The register names the VPS, chosen by hand (0.27.2), and it reaches everyone.
    let op = a.membership().set("broker", json!(c.id())).unwrap();
    let chosen = a.membership().set(super::broker::CHOICE_REGISTER, json!({ "machine_id": c.id(), "via": "manual" })).unwrap();
    a.state.network.publish_ops(vec![op, chosen]);
    eventually("the broker register reaches everyone", WAIT, || {
        [&a, &b, &c].iter().all(|node| {
            let projection = node.membership().projection();
            projection.broker() == Some(c.id().as_str())
                && projection.register(super::broker::CHOICE_REGISTER).is_some_and(|choice| choice.value["machine_id"] == json!(c.id()))
        })
    })
    .await;

    // The PC has a local named account that signs in through the broker.
    let local = crate::provider_accounts::create(
        &b.state,
        AccountsCreateParams { kind: ProviderKind::ClaudeCode, name: "Via VPS".into(), directory: None },
    )
    .unwrap();
    let at_b = client(&b).await;
    at_b.call::<LoginBrokerBind>(LoginBrokerBindParams {
        provider: ProviderKind::ClaudeCode,
        instance: local.instance.clone(),
        broker_account: Some(account.instance.clone()),
    })
    .await
    .unwrap();
    Some(Lending {
        cluster,
        a,
        b,
        c,
        broker_dir,
        broker_state,
        broker_account: account.instance,
        local_account: local.instance,
        spawned,
        hold,
    })
}

async fn client(node: &Node) -> Client {
    Client::connect(&Endpoint { url: node.ws_url(), token: node.device_token(&Scope::ALL) }).await.unwrap()
}

impl Lending {
    fn broker(&self, node: &Node) -> Arc<super::broker::LoginBroker> {
        node.state.orchestrator.login_broker().cloned().unwrap()
    }

    /// The broker's own Claude refreshed: a new token, and the old one is dead.
    fn rotate_on_vps(&self, token: &str) {
        write_login(&self.broker_dir, &self.broker_state, token, 8 * 3600 * 1000);
    }

    /// A project and a thread on the PC that uses the bound account.
    async fn thread(&self) -> (ThreadId, ProjectId) {
        let folder = self.b.root.join("project");
        std::fs::create_dir_all(&folder).unwrap();
        let project = self.b.state.orchestrator.add_project(folder.to_string_lossy().into_owned(), Some("Lent".into()), None).unwrap();
        let thread = client(&self.b)
            .await
            .call::<ThreadsCreate>(ThreadsCreateParams {
                pin_account: true,
                project_id: Some(project.id),
                provider: ProviderInstance { kind: ProviderKind::ClaudeCode, instance: self.local_account.clone() },
                model: None,
                effort: None,
                permission_mode: None,
                use_worktree: Some(false),
                base_branch: None,
                title: Some("Lent login".into()),
                message: None,
                thread_id: None,
                message_id: None,
                members: None,
                base_branches: None,
            })
            .await
            .unwrap();
        (thread.id, project.id)
    }

    async fn send(&self, thread: ThreadId, text: &str) {
        self.b.state.orchestrator.send(thread, UserMessage::text(text)).await.unwrap();
    }

    fn kinds(&self, thread: ThreadId) -> Vec<&'static str> {
        self.b.state.store.events_for_thread(thread).unwrap().iter().map(|event| event.payload.kind()).collect()
    }

    fn turns(&self, thread: ThreadId, kind: &str) -> usize {
        self.kinds(thread).iter().filter(|candidate| **candidate == kind).count()
    }

    fn spawns(&self) -> Vec<Spawned> {
        self.spawned.lock().unwrap().clone()
    }
}

// ---- tests ----

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_bound_account_runs_its_session_on_the_token_the_broker_lent() {
    let Some(l) = lending().await else { return };
    let (thread, _) = l.thread().await;
    l.send(thread, "hello").await;
    eventually("the turn completes", WAIT, || l.turns(thread, "turn_completed") == 1).await;

    let spawns = l.spawns();
    assert_eq!(spawns.len(), 1);
    assert_eq!(spawns[0].token, "tok-0", "the session ran on the broker's token");
    // The broker recorded the loan, the borrower the other end of it; neither stored a token.
    let lender = l.c.state.store.loans_open(kybern_store::LoanRole::Lender).unwrap();
    let borrower = l.b.state.store.loans_open(kybern_store::LoanRole::Borrower).unwrap();
    assert_eq!((lender.len(), borrower.len()), (1, 1));
    assert_eq!(lender[0].loan_id, borrower[0].loan_id);
    assert_eq!((lender[0].peer.as_str(), borrower[0].peer.as_str()), (l.b.id().as_str(), l.c.id().as_str()));
    for node in [&l.b, &l.c] {
        for file in ["state.sqlite", "state.sqlite-wal", "settings.json"] {
            let found = std::fs::read(node.root.join(file)).unwrap_or_default();
            assert!(!String::from_utf8_lossy(&found).contains("tok-0"), "{} stored the token in {file}", node.name);
        }
    }
    // The borrower's account row reads "signs in through vps" and counts as signed in.
    let list = crate::provider_accounts::list(&l.b.state, AccountsListParams { kind: Some(ProviderKind::ClaudeCode), refresh: true })
        .await
        .unwrap();
    let account = list.accounts.iter().find(|a| a.provider.instance == l.local_account).unwrap();
    let broker = account.broker.as_ref().expect("the account says where it signs in");
    assert_eq!((broker.machine_name.as_str(), broker.state, account.status), ("vps", BrokerLoginState::Borrowing, AccountStatus::SignedIn));
    // The borrower never ran the broker's Claude: no refresh happened.
    assert!(events_of(&l.broker_state).is_empty(), "{:?}", events_of(&l.broker_state));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_rotation_is_pushed_and_the_idle_session_resumes_once_on_the_new_token() {
    let Some(l) = lending().await else { return };
    let (thread, _) = l.thread().await;
    l.send(thread, "first").await;
    eventually("first turn", WAIT, || l.turns(thread, "turn_completed") == 1).await;
    let broker = l.broker(&l.c);
    // The broker watches its credential once; nothing changed.
    broker.watch_lent(&l.c.state).await;
    assert_eq!(l.spawns().len(), 1);

    // The broker's Claude refreshes: every outstanding token is dead. The watch pushes the new one.
    l.rotate_on_vps("tok-1");
    broker.watch_lent(&l.c.state).await;
    eventually("the borrower holds the new token and ended its idle session", WAIT, || {
        l.spawns()[0].closed.load(std::sync::atomic::Ordering::SeqCst)
    })
    .await;
    let lender = l.c.state.store.loans_open(kybern_store::LoanRole::Lender).unwrap();
    assert!(lender[0].last_pushed_at.is_some() && lender[0].last_error.is_none(), "{lender:?}");

    l.send(thread, "second").await;
    eventually("second turn", WAIT, || l.turns(thread, "turn_completed") == 2).await;
    let spawns = l.spawns();
    assert_eq!(spawns.len(), 2, "exactly one resume for one rotation");
    assert_eq!((spawns[1].token.as_str(), spawns[1].resume.as_deref()), ("tok-1", Some("native-1")));
    assert_eq!(l.turns(thread, "turn_failed"), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_turn_rejected_mid_flight_borrows_again_resumes_and_sends_the_message_once_more() {
    let Some(l) = lending().await else { return };
    let (thread, _) = l.thread().await;
    // A turn is running when the broker rotates, and the push has not arrived yet.
    let gate = Arc::new(tokio::sync::Notify::new());
    *l.hold.0.lock().await = Some(gate.clone());
    l.send(thread, "long task").await;
    eventually("the session started", WAIT, || l.spawns().len() == 1 && !l.spawns()[0].sent.lock().unwrap().is_empty()).await;
    l.rotate_on_vps("tok-1");
    *l.hold.0.lock().await = None;
    gate.notify_one();

    eventually("the turn completes after one recovery", WAIT, || l.turns(thread, "turn_completed") == 1).await;
    let spawns = l.spawns();
    assert_eq!(spawns.len(), 2, "one resume");
    assert_eq!(spawns[1].token, "tok-1", "the new session borrowed again");
    assert_eq!(spawns[1].resume.as_deref(), Some("native-1"), "the new process resumed the conversation");
    assert_eq!(spawns[0].sent.lock().unwrap().len(), 1);
    assert_eq!(spawns[1].sent.lock().unwrap().len(), 1, "the failed message was sent again");
    assert_eq!(spawns[0].sent.lock().unwrap()[0], spawns[1].sent.lock().unwrap()[0], "the same message");
    assert_eq!(l.turns(thread, "turn_failed"), 0, "the user never saw the failure");
    assert_eq!(l.turns(thread, "turn_started"), 1, "one turn, not two");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_second_rejection_in_the_same_turn_is_reported_not_retried_forever() {
    let Some(l) = lending().await else { return };
    let (thread, _) = l.thread().await;
    // The valid token keeps changing under the session, so the retry is rejected too.
    let gate = Arc::new(tokio::sync::Notify::new());
    *l.hold.0.lock().await = Some(gate.clone());
    l.send(thread, "unlucky").await;
    eventually("the session started", WAIT, || l.spawns().len() == 1 && !l.spawns()[0].sent.lock().unwrap().is_empty()).await;
    l.rotate_on_vps("tok-1");
    gate.notify_one();
    eventually("the retry started", WAIT, || l.spawns().len() == 2 && !l.spawns()[1].sent.lock().unwrap().is_empty()).await;
    l.rotate_on_vps("tok-2");
    gate.notify_one();
    eventually("the second rejection is reported", WAIT, || l.turns(thread, "turn_failed") == 1).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(l.spawns().len(), 2, "no third attempt");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn borrowers_never_make_the_broker_refresh_and_a_dying_token_refreshes_once() {
    let Some(l) = lending().await else { return };
    let (thread, _) = l.thread().await;
    for i in 0..3 {
        l.send(thread, &format!("turn {i}")).await;
        eventually("turn", WAIT, || l.turns(thread, "turn_completed") == i + 1).await;
        // End the session so the next turn borrows again (renewals are not refreshes).
        let broker = l.broker(&l.b);
        broker.renew(ProviderKind::ClaudeCode, &l.local_account, &l.broker_account).await.unwrap();
    }
    assert!(events_of(&l.broker_state).is_empty(), "borrowing never ran the broker's Claude: {:?}", events_of(&l.broker_state));

    // A token that is about to die: three borrows at once cause exactly one refresh, and the rotation reaches the borrower.
    write_login(&l.broker_dir, &l.broker_state, "tok-0", 20_000);
    let broker = l.broker(&l.b);
    let renewals = (0..3).map(|_| broker.renew(ProviderKind::ClaudeCode, &l.local_account, &l.broker_account));
    for result in futures::future::join_all(renewals).await {
        result.unwrap();
    }
    let refreshes: Vec<String> = events_of(&l.broker_state).into_iter().filter(|line| line.starts_with("refresh")).collect();
    assert_eq!(refreshes.len(), 1, "{refreshes:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_broker_being_offline_falls_back_with_the_right_message_and_a_held_loan_keeps_working() {
    let Some(l) = lending().await else { return };
    let (thread, _) = l.thread().await;
    l.send(thread, "while online").await;
    eventually("first turn", WAIT, || l.turns(thread, "turn_completed") == 1).await;

    // The VPS drops off. The loan the PC holds keeps working until the token dies.
    l.c.set_network_enabled(false);
    eventually("the PC loses the VPS", WAIT, || l.b.state.network.peers.link(&l.c.id()).is_none()).await;
    l.send(thread, "still lent").await;
    eventually("a held loan keeps the session going", WAIT, || l.turns(thread, "turn_completed") == 2).await;

    // A renewal needs the broker: the account says so, in words a person acts on.
    let broker = l.broker(&l.b);
    let error = broker.renew(ProviderKind::ClaudeCode, &l.local_account, &l.broker_account).await.unwrap_err();
    assert_eq!(error, "Claude Code signs in through vps, which is offline · Sign in here instead");
    let status = client(&l.b).await.call::<LoginBrokerStatusMethod>(Empty {}).await.unwrap();
    let claude = status.providers.iter().find(|p| p.provider == ProviderKind::ClaudeCode).unwrap();
    assert_eq!(claude.state, BrokerLoginState::BrokerOffline);
    assert_eq!(claude.message.as_deref(), Some(error.as_str()));
    let list = crate::provider_accounts::list(&l.b.state, AccountsListParams { kind: Some(ProviderKind::ClaudeCode), refresh: true })
        .await
        .unwrap();
    let account = list.accounts.iter().find(|a| a.provider.instance == l.local_account).unwrap();
    assert_eq!(account.status, AccountStatus::NeedsSignIn);

    // A fresh session cannot borrow, and the turn fails with that sentence instead of a stack of errors.
    // (The lease is dropped by unbinding and binding again: a new session has nothing to run on.)
    let at_b = client(&l.b).await;
    for broker_account in [None, Some(l.broker_account.clone())] {
        at_b.call::<LoginBrokerBind>(LoginBrokerBindParams {
            provider: ProviderKind::ClaudeCode,
            instance: l.local_account.clone(),
            broker_account,
        })
        .await
        .unwrap();
    }
    l.b.state.orchestrator.login_rotated(ProviderKind::ClaudeCode, &l.local_account).await;
    l.send(thread, "after the drop").await;
    eventually("the turn fails with the fallback sentence", WAIT, || l.turns(thread, "turn_failed") == 1).await;
    let (failed, problem) =
        l.b.state
            .store
            .events_for_thread(thread)
            .unwrap()
            .into_iter()
            .find_map(|event| match event.payload {
                EventPayload::TurnFailed { error, problem } => Some((error, problem)),
                _ => None,
            })
            .unwrap();
    assert_eq!(failed, "Claude Code signs in through vps, which is offline · Sign in here instead");
    // The failed turn carries the fix: "Sign in on pc instead", for this account.
    let problem = problem.expect("the turn says what failed");
    assert_eq!((problem.kind, problem.subject.as_deref()), (ProblemKind::Offline, Some(LOGIN_BORROW_SUBJECT)));
    let action = problem.action.unwrap();
    assert_eq!((action.id.as_str(), action.label.as_str()), (SIGN_IN_HERE_ACTION, "Sign in on pc instead"));
    assert_eq!(action.params.unwrap(), json!({ "machine_id": l.b.id(), "provider": "claude-code", "instance": l.local_account }));

    // "Sign in here instead": unbinding returns the account to a local sign-in.
    let status = at_b
        .call::<LoginBrokerBind>(LoginBrokerBindParams {
            provider: ProviderKind::ClaudeCode,
            instance: l.local_account.clone(),
            broker_account: None,
        })
        .await
        .unwrap();
    let claude = status.providers.iter().find(|p| p.provider == ProviderKind::ClaudeCode).unwrap();
    assert_eq!((claude.local_account.as_deref(), claude.state), (None, BrokerLoginState::BrokerOffline));
    assert!(l.b.state.orchestrator.login_broker().unwrap().binding(ProviderKind::ClaudeCode, &l.local_account).is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn moving_the_broker_reissues_to_the_members_before_the_old_one_signs_out() {
    let Some(l) = lending().await else { return };
    let (thread, _) = l.thread().await;
    l.send(thread, "on the vps").await;
    eventually("first turn", WAIT, || l.turns(thread, "turn_completed") == 1).await;

    // The Mac has a signed-in Claude too, with its own fake state; the PC's account will borrow from it.
    let mac_state = l.cluster.dir.path().join("mac-claude-state");
    let mac_account = crate::provider_accounts::create(
        &l.a.state,
        AccountsCreateParams { kind: ProviderKind::ClaudeCode, name: "Mac".into(), directory: None },
    )
    .unwrap();
    let mac_dir =
        PathBuf::from(l.a.state.settings.get().providers[&ProviderKind::ClaudeCode].accounts[&mac_account.instance].directory.clone());
    let mut settings = l.a.state.settings.get();
    settings
        .providers
        .entry(ProviderKind::ClaudeCode)
        .or_default()
        .env
        .insert("FAKE_STATE".into(), mac_state.to_string_lossy().into_owned());
    l.a.state.settings.set(settings).unwrap();
    write_login(&mac_dir, &mac_state, "mac-0", 8 * 3600 * 1000);
    let vps_loan_before = l.b.state.store.loans_open(kybern_store::LoanRole::Borrower).unwrap();
    assert_eq!(vps_loan_before[0].peer, l.c.id());

    // The new broker has to be signed in: an empty one is refused, with what to do.
    let refused = client(&l.a)
        .await
        .call::<LoginBrokerSet>(LoginBrokerSetParams { machine_id: Some(l.b.id()), sign_out_old: true, via: None })
        .await
        .unwrap_err();
    assert!(format!("{refused:?}").contains("Sign in on pc first"), "{refused:?}");

    // Every online member re-borrows from the Mac; the VPS signs out after that.
    let result = client(&l.a)
        .await
        .call::<LoginBrokerSet>(LoginBrokerSetParams { machine_id: Some(l.a.id()), sign_out_old: true, via: None })
        .await
        .unwrap();
    assert!(result.rebound.contains(&l.b.id()), "{result:?}");
    assert_eq!(result.old_signed_out, vec![ProviderKind::ClaudeCode], "{result:?}");
    let after = l.b.state.store.loans_open(kybern_store::LoanRole::Borrower).unwrap();
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].peer, l.a.id(), "the PC now borrows from the Mac");
    assert_eq!(
        l.b.state.orchestrator.login_broker().unwrap().binding(ProviderKind::ClaudeCode, &l.local_account),
        Some(mac_account.instance.clone()),
        "the account follows to the Mac's"
    );
    // The order: the PC's new loan exists before the VPS logged out.
    let logout = events_of(&l.broker_state).into_iter().find(|line| line.starts_with("logout")).expect("the old broker signed out");
    let logout_ns: i128 = logout.split_whitespace().nth(1).unwrap().parse().unwrap();
    let reissued_ns = after[0].created_at.timestamp_nanos_opt().unwrap() as i128;
    assert!(reissued_ns < logout_ns, "the new loan ({reissued_ns}) came before the sign-out ({logout_ns})");
    assert!(l.c.state.store.loans_open(kybern_store::LoanRole::Lender).unwrap().is_empty(), "the old broker released its loans");
    assert_eq!(l.b.membership().projection().broker(), Some(l.a.id().as_str()));

    // The session that was idle on the VPS' token ended; the next message runs on the Mac's.
    l.send(thread, "on the mac").await;
    eventually("second turn", WAIT, || l.turns(thread, "turn_completed") == 2).await;
    let spawns = l.spawns();
    assert_eq!(spawns.last().unwrap().token, "mac-0");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_pushed_key_arrives_sealed_queues_for_an_offline_machine_and_is_wired_into_the_provider() {
    let Some(l) = lending().await else { return };
    const KEY: &str = "cursor-key-SENTINEL-9f3a";
    let store = crate::secret_store::store_of(&l.a.state).unwrap();
    store.put("provider.cursor.CURSOR_API_KEY", KEY, &crate::secret_store::SecretSource::Local).unwrap();
    l.c.set_network_enabled(false);
    eventually("the VPS is offline", WAIT, || l.a.state.network.peers.link(&l.c.id()).is_none()).await;

    let result = client(&l.a)
        .await
        .call::<SecretsPush>(SecretsPushParams { name: "provider.cursor.CURSOR_API_KEY".into(), machines: vec![] })
        .await
        .unwrap();
    let state_of = |name: &str| result.machines.iter().find(|m| m.name == name).unwrap().state;
    assert_eq!((state_of("pc"), state_of("vps")), (SecretsPushState::Delivered, SecretsPushState::Queued), "{result:?}");

    // What waits in the outbox is the sealed blob and nothing else.
    let queued = l.a.state.store.outbox_list(Some(&l.c.id()), Some(OutboxState::Queued)).unwrap();
    let item = queued.iter().find(|item| item.kind == OutboxKind::SecretsPut).expect("a queued push");
    let payload = item.payload.to_string();
    assert!(!payload.contains(KEY) && !payload.contains("SENTINEL"), "the outbox holds the key in the clear: {payload}");
    let put: PeerSecretsPutParams = serde_json::from_value(item.payload.clone()).unwrap();

    // The PC took it: stored with its source, and the cursor env points at the reference.
    let pc_settings = l.b.state.settings.get();
    assert_eq!(pc_settings.providers[&ProviderKind::Cursor].env["CURSOR_API_KEY"], "kybern-secret:provider.cursor.CURSOR_API_KEY");
    for node in [&l.b] {
        let db = std::fs::read(node.root.join("state.sqlite")).unwrap_or_default();
        let wal = std::fs::read(node.root.join("state.sqlite-wal")).unwrap_or_default();
        let json = std::fs::read(node.root.join("settings.json")).unwrap_or_default();
        for found in [db, wal, json] {
            assert!(!String::from_utf8_lossy(&found).contains("SENTINEL"), "{} stored the key in the clear", node.name);
        }
    }
    // A blob made for the VPS does not open on the PC.
    let pc_store = crate::secret_store::store_of(&l.b.state).unwrap();
    let stolen = pc_store.put_sealed(
        &l.b.membership().keys(),
        &crate::secret_store::SealedSecret { name: put.name.clone(), sealed: put.sealed.clone() },
        &l.a.id(),
        &l.b.id(),
    );
    assert!(stolen.is_err(), "a blob sealed to the VPS opened on the PC");

    // The VPS returns and takes the queued push.
    l.c.set_network_enabled(true);
    eventually("the VPS takes the queued key", WAIT, || {
        l.c.state.settings.get().providers.get(&ProviderKind::Cursor).is_some_and(|p| p.env.contains_key("CURSOR_API_KEY"))
    })
    .await;
    // Pushing something that is not a harness credential variable is refused by the target.
    let bad =
        l.a.state.orchestrator.remote_hub().unwrap().call(&l.b.id(), "peer.secrets.put", json!({"name": "x", "sealed": "AAAA"})).await;
    assert!(bad.is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn no_token_reaches_the_logs() {
    let Some(l) = lending().await else { return };
    let (thread, _) = l.thread().await;
    l.send(thread, "log me").await;
    eventually("turn", WAIT, || l.turns(thread, "turn_completed") == 1).await;
    l.rotate_on_vps("tok-77");
    l.broker(&l.c).watch_lent(&l.c.state).await;
    eventually("the push", WAIT, || l.spawns()[0].closed.load(std::sync::atomic::Ordering::SeqCst)).await;
    let logs = String::from_utf8_lossy(&captured_logs().0.lock().unwrap()).into_owned();
    assert!(
        logs.contains("lent a login") && logs.contains("pushed a rotated login"),
        "the capture saw nothing from the broker, so it proves nothing"
    );
    // Every test in the process writes here, so this covers all their tokens, sealed blobs and pushed keys too.
    for secret in ["tok-0", "tok-1", "tok-2", "tok-77", "mac-0", "refresh-0", "refresh-1", "SENTINEL"] {
        assert!(!logs.contains(secret), "{secret} reached the logs");
    }
    assert!(!logs.contains("claudeAiOauth"), "a credentials file reached the logs");
}

// ---- Codex and omp ----

const FAKE_OMP: &str = r#"#!/bin/sh
case "$1 $2" in
  "auth-broker serve")
    echo "$*" >> "$FAKE_STATE/omp-serve"
    exec sleep 120;;
  "auth-broker token")
    echo "omp-bearer-1"
    exit 0;;
esac
exit 0
"#;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn codex_is_lent_as_an_access_token_without_its_refresh_token() {
    use base64::Engine;
    let Some(l) = lending().await else { return };
    let jwt = |claims: serde_json::Value| {
        let part = |value: &serde_json::Value| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(value).unwrap());
        format!("{}.{}.sig", part(&json!({"alg": "none"})), part(&claims))
    };
    // The VPS' Codex, signed in under a named account with a (fake) auth.json in file mode.
    let account = crate::provider_accounts::create(
        &l.c.state,
        AccountsCreateParams { kind: ProviderKind::Codex, name: "Shared Codex".into(), directory: None },
    )
    .unwrap();
    let dir = PathBuf::from(l.c.state.settings.get().providers[&ProviderKind::Codex].accounts[&account.instance].directory.clone());
    let exp = chrono::Utc::now().timestamp() + 240 * 3600;
    std::fs::write(
        dir.join("auth.json"),
        json!({"auth_mode": "chatgpt", "tokens": {"id_token": jwt(json!({"https://api.openai.com/auth": {"chatgpt_plan_type": "pro"}})),
            "access_token": jwt(json!({"exp": exp, "marker": "cx-access-0"})), "refresh_token": "cx-refresh-SECRET", "account_id": "acct-9"}})
        .to_string(),
    )
    .unwrap();
    // The PC's Codex account signs in through it.
    let local = crate::provider_accounts::create(
        &l.b.state,
        AccountsCreateParams { kind: ProviderKind::Codex, name: "Via VPS".into(), directory: None },
    )
    .unwrap();
    client(&l.b)
        .await
        .call::<LoginBrokerBind>(LoginBrokerBindParams {
            provider: ProviderKind::Codex,
            instance: local.instance.clone(),
            broker_account: Some(account.instance.clone()),
        })
        .await
        .unwrap();
    let source = l.broker(&l.b).acquire(ProviderKind::Codex, &local.instance, &account.instance).await.unwrap();
    match source.current().await.unwrap() {
        BorrowedLogin::Codex { access_token, account_id, plan_type, id_token } => {
            assert!(access_token.split('.').count() == 3, "a JWT access token");
            assert_eq!((account_id.as_str(), plan_type.as_deref()), ("acct-9", Some("pro")));
            assert!(id_token.is_some());
        }
        other => panic!("{other:?}"),
    }
    // The host refresh is a new borrow, and the refresh token never travelled: nothing in the borrower's files has it.
    assert!(matches!(source.renew(login_lend::RenewReason::Unauthorized).await, Ok(BorrowedLogin::Codex { .. })));
    for node in [&l.b, &l.c] {
        for file in ["state.sqlite", "state.sqlite-wal", "settings.json"] {
            let found = std::fs::read(node.root.join(file)).unwrap_or_default();
            assert!(!String::from_utf8_lossy(&found).contains("cx-refresh-SECRET"), "{} holds Codex' refresh token in {file}", node.name);
        }
    }
    assert!(!String::from_utf8_lossy(&captured_logs().0.lock().unwrap()).contains("cx-refresh-SECRET"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn omp_is_pointed_at_the_brokers_own_broker_and_fallback_unsets_both_variables() {
    let Some(l) = lending().await else { return };
    let omp = l.cluster.dir.path().join("bin").join("omp");
    kybern_protocol::process::write_executable(&omp, FAKE_OMP).unwrap();
    let mut settings = l.c.state.settings.get();
    let provider = settings.providers.entry(ProviderKind::Omp).or_default();
    provider.binary = Some(omp.to_string_lossy().into_owned());
    provider.env.insert("FAKE_STATE".into(), l.broker_state.to_string_lossy().into_owned());
    l.c.state.settings.set(settings).unwrap();
    let local = crate::provider_accounts::create(
        &l.b.state,
        AccountsCreateParams { kind: ProviderKind::Omp, name: "Via VPS".into(), directory: None },
    )
    .unwrap();
    let at_b = client(&l.b).await;
    at_b.call::<LoginBrokerBind>(LoginBrokerBindParams {
        provider: ProviderKind::Omp,
        instance: local.instance.clone(),
        broker_account: Some("default".into()),
    })
    .await
    .unwrap();
    let source = l.broker(&l.b).acquire(ProviderKind::Omp, &local.instance, "default").await;
    let source = match source {
        Ok(source) => source,
        Err(text) => panic!("{text}"),
    };
    let login = source.current().await.unwrap();
    let env = login_lend::omp_env(&login).expect("omp gets its environment");
    let by_name: std::collections::HashMap<_, _> = env.into_iter().collect();
    assert_eq!(by_name["OMP_AUTH_BROKER_TOKEN"], "omp-bearer-1");
    assert!(by_name["OMP_AUTH_BROKER_URL"].starts_with("http://") && by_name["OMP_AUTH_BROKER_URL"].ends_with(":7878"), "{by_name:?}");
    let served = std::fs::read_to_string(l.broker_state.join("omp-serve")).unwrap_or_default();
    assert!(served.contains("auth-broker serve --bind="), "the VPS started omp's broker: {served}");
    // "Sign in here instead" takes the account off the broker: nothing is injected for it any more.
    at_b.call::<LoginBrokerBind>(LoginBrokerBindParams {
        provider: ProviderKind::Omp,
        instance: local.instance.clone(),
        broker_account: None,
    })
    .await
    .unwrap();
    assert!(l.broker(&l.b).binding(ProviderKind::Omp, &local.instance).is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_removed_machine_drops_its_borrowed_logins_ends_their_sessions_and_deletes_pushed_keys() {
    let Some(l) = lending().await else { return };
    let (thread, _) = l.thread().await;
    l.send(thread, "hello").await;
    eventually("the turn completes", WAIT, || l.turns(thread, "turn_completed") == 1).await;
    // A key pushed to the PC, wired into its Cursor env.
    let store = crate::secret_store::store_of(&l.a.state).unwrap();
    store.put("provider.cursor.CURSOR_API_KEY", "cursor-key-SENTINEL-77", &crate::secret_store::SecretSource::Local).unwrap();
    client(&l.a)
        .await
        .call::<SecretsPush>(SecretsPushParams { name: "provider.cursor.CURSOR_API_KEY".into(), machines: vec![l.b.id()] })
        .await
        .unwrap();
    let pc_store = crate::secret_store::store_of(&l.b.state).unwrap();
    assert!(pc_store.contains("provider.cursor.CURSOR_API_KEY").unwrap());

    // The mac removes the PC, which cooperates: it learns of its removal from the push.
    super::removal::remove(&l.a.state, &l.b.id(), false, &[]).await.unwrap();
    eventually("the PC knows it was removed", WAIT, || l.b.membership().self_removed()).await;
    eventually("the borrowed session ends", WAIT, || l.spawns()[0].closed.load(std::sync::atomic::Ordering::SeqCst)).await;
    eventually("the loan is released", WAIT, || l.b.state.store.loans_open(kybern_store::LoanRole::Borrower).unwrap().is_empty()).await;
    eventually("the pushed key is deleted", WAIT, || !pc_store.contains("provider.cursor.CURSOR_API_KEY").unwrap()).await;
    eventually("and unwired from the Cursor env", WAIT, || {
        l.b.state.settings.get().providers.get(&ProviderKind::Cursor).is_none_or(|p| !p.env.contains_key("CURSOR_API_KEY"))
    })
    .await;
    // Nothing cached is lent out again: a new session of the account is refused with a sentence.
    let refused = l.broker(&l.b).acquire(ProviderKind::ClaudeCode, &l.local_account, &l.broker_account).await.err().unwrap();
    assert!(refused.contains("not connected to your other machines"), "{refused}");
    // The mac keeps its own copy of the key.
    assert!(store.contains("provider.cursor.CURSOR_API_KEY").unwrap());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn turning_the_network_off_ends_the_sessions_on_borrowed_logins() {
    let Some(l) = lending().await else { return };
    let (thread, _) = l.thread().await;
    l.send(thread, "hello").await;
    eventually("the turn completes", WAIT, || l.turns(thread, "turn_completed") == 1).await;
    super::manage::set_enabled(&l.b.state, false).await.unwrap();
    eventually("the borrowed session ends", WAIT, || l.spawns()[0].closed.load(std::sync::atomic::Ordering::SeqCst)).await;
    eventually("the loan is released", WAIT, || l.b.state.store.loans_open(kybern_store::LoanRole::Borrower).unwrap().is_empty()).await;
    let refused = l.broker(&l.b).acquire(ProviderKind::ClaudeCode, &l.local_account, &l.broker_account).await.err().unwrap();
    assert!(refused.contains("not connected to your other machines"), "{refused}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn releasing_a_loan_ends_the_session_that_holds_it_and_the_account_reads_signed_out() {
    let Some(l) = lending().await else { return };
    let (thread, _) = l.thread().await;
    l.send(thread, "hello").await;
    eventually("the turn completes", WAIT, || l.turns(thread, "turn_completed") == 1).await;
    assert!(!l.spawns()[0].closed.load(std::sync::atomic::Ordering::SeqCst));

    client(&l.b)
        .await
        .call::<LoginBrokerBind>(LoginBrokerBindParams {
            provider: ProviderKind::ClaudeCode,
            instance: l.local_account.clone(),
            broker_account: None,
        })
        .await
        .unwrap();

    // The process that held the lent token is stopped, and the thread has no live session left.
    assert!(l.spawns()[0].closed.load(std::sync::atomic::Ordering::SeqCst), "the borrowed session was left running");
    assert!(l.b.state.orchestrator.session_activity().await.unwrap().live == 0);
    assert_eq!(l.turns(thread, "provider_session_released"), 1);
    assert!(l.b.state.store.loans_open(kybern_store::LoanRole::Borrower).unwrap().is_empty());
    let list = crate::provider_accounts::list(&l.b.state, AccountsListParams { kind: Some(ProviderKind::ClaudeCode), refresh: true })
        .await
        .unwrap();
    let account = list.accounts.iter().find(|a| a.provider.instance == l.local_account).unwrap();
    assert!(
        matches!(account.status, AccountStatus::SignedOut | AccountStatus::NeedsSignIn),
        "still reads as signed in: {:?}",
        account.status
    );
    assert!(account.broker.is_none(), "the account still points at the broker");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_thread_on_a_borrowed_account_gets_no_model_helper_and_keeps_its_plain_title() {
    let Some(l) = lending().await else { return };
    let (thread, _) = l.thread().await;
    let stored = l.b.state.store.thread_get(thread).unwrap().unwrap();
    // Neither its own harness nor another one: a borrowed login lives only in the session, and the machine's
    // own logins are not the thread's to use.
    for kind in [ProviderKind::ClaudeCode, ProviderKind::Codex] {
        assert!(l.b.state.orchestrator.one_shot_env(&stored, kind).is_none(), "{kind} would run on the machine's own login");
    }
    let title = l.b.state.orchestrator.generate_title(&stored, &UserMessage::text("name this")).await.unwrap();
    assert_eq!(title, None);
}

/// A `broker` register from before 0.27.2 (no `broker.choice` for it) on a machine that isn't known to be always on.
async fn make_legacy(l: &Lending) {
    let op = l.a.membership().set(super::broker::CHOICE_REGISTER, json!({})).unwrap();
    l.a.state.network.publish_ops(vec![op]);
    eventually("the choice is gone everywhere", WAIT, || {
        [&l.a, &l.b, &l.c].iter().all(|node| {
            node.membership().projection().register(super::broker::CHOICE_REGISTER).is_some_and(|choice| choice.value == json!({}))
        })
    })
    .await;
}

async fn new_local_account(node: &Node, name: &str) -> String {
    crate::provider_accounts::create(
        &node.state,
        AccountsCreateParams { kind: ProviderKind::ClaudeCode, name: name.into(), directory: None },
    )
    .unwrap()
    .instance
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_legacy_lender_that_isnt_always_on_takes_no_new_accounts_but_keeps_the_bound_ones() {
    let Some(l) = lending().await else { return };
    make_legacy(&l).await;
    let at_b = client(&l.b).await;

    // Status and offers both say new setups can't borrow from it, and why.
    let status = at_b.call::<LoginBrokerStatusMethod>(Empty {}).await.unwrap();
    let lender = status.lender.expect("the lender is reported");
    assert_eq!((lender.machine_id.as_str(), lender.chosen, lender.usable_for_new), (l.c.id().as_str(), None, false));
    let reason = lender.reason.expect("with a reason");
    assert!(reason.starts_with("vps shared its sign-ins before Kybern 0.27.2"), "{reason}");
    assert!(!reason.contains("broker"), "{reason}");
    let offers = at_b.call::<AccountsOffers>(Empty {}).await.unwrap();
    assert_eq!(offers.lender.map(|lender| lender.usable_for_new), Some(false));
    // Every member is a candidate; the VPS is the lender.
    let vps = status.lenders.iter().find(|candidate| candidate.machine_id == l.c.id()).expect("the VPS is listed");
    assert!(vps.is_lender && vps.online && vps.supported && vps.can_share, "{vps:?}");
    assert!(status.lenders.iter().any(|candidate| candidate.is_self && candidate.machine_id == l.b.id()));

    // A new account is refused, with the sentence and "Sign in on pc instead".
    let fresh = new_local_account(&l.b, "New").await;
    let error = l
        .broker(&l.b)
        .bind(
            &l.b.state,
            LoginBrokerBindParams {
                provider: ProviderKind::ClaudeCode,
                instance: fresh.clone(),
                broker_account: Some(l.broker_account.clone()),
            },
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, codes::FORBIDDEN);
    assert_eq!(error.message, reason);
    let problem = error.problem().expect("a problem");
    assert_eq!(problem.subject.as_deref(), Some(LOGIN_BORROW_SUBJECT));
    let action = problem.action.expect("a fix");
    assert_eq!((action.id.as_str(), action.label.as_str()), (SIGN_IN_HERE_ACTION, "Sign in on pc instead"));
    assert_eq!(action.params.unwrap()["machine_id"], json!(l.b.id()));
    assert!(l.broker(&l.b).binding(ProviderKind::ClaudeCode, &fresh).is_none(), "the refused account stays unbound");

    // The account bound before keeps borrowing.
    let (thread, _) = l.thread().await;
    l.send(thread, "still works").await;
    eventually("the bound account's turn completes", WAIT, || l.turns(thread, "turn_completed") == 1).await;

    // Picking the same machine again by hand makes it deliberate: new accounts may borrow from it now.
    let result = client(&l.a)
        .await
        .call::<LoginBrokerSet>(LoginBrokerSetParams { machine_id: Some(l.c.id()), sign_out_old: false, via: None })
        .await
        .unwrap();
    assert_eq!(result.status.lender.as_ref().map(|lender| (lender.chosen, lender.usable_for_new)), Some((Some(LenderVia::Manual), true)));
    eventually("the PC hears the choice", WAIT, || l.broker(&l.b).lender_status().is_some_and(|lender| lender.usable_for_new)).await;
    at_b.call::<LoginBrokerBind>(LoginBrokerBindParams {
        provider: ProviderKind::ClaudeCode,
        instance: fresh.clone(),
        broker_account: Some(l.broker_account.clone()),
    })
    .await
    .unwrap();
    assert_eq!(l.broker(&l.b).binding(ProviderKind::ClaudeCode, &fresh), Some(l.broker_account.clone()));
    // The always-on offer is recorded as such.
    let result = client(&l.a)
        .await
        .call::<LoginBrokerSet>(LoginBrokerSetParams { machine_id: Some(l.c.id()), sign_out_old: false, via: Some(LenderVia::AlwaysOn) })
        .await
        .unwrap();
    assert_eq!(result.status.lender.and_then(|lender| lender.chosen), Some(LenderVia::AlwaysOn));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_lender_that_refuses_says_which_machine_and_what_to_do_while_the_account_is_set_up() {
    let Some(l) = lending().await else { return };
    // The VPS turns Logins off for the PC.
    let op = l.c.membership().set(&format!("allow.{}.logins", l.c.id()), json!(false)).unwrap();
    l.c.state.network.publish_ops(vec![op]);
    eventually("the policy reaches the PC", WAIT, || l.b.membership().projection().allowed(&l.c.id()).get("logins") == Some(&false)).await;
    let fresh = new_local_account(&l.b, "Refused").await;
    let error = l
        .broker(&l.b)
        .bind(
            &l.b.state,
            LoginBrokerBindParams {
                provider: ProviderKind::ClaudeCode,
                instance: fresh.clone(),
                broker_account: Some(l.broker_account.clone()),
            },
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, codes::FORBIDDEN);
    assert_eq!(
        error.message,
        "vps doesn't let other machines use its sign-ins. Choose Share this machine’s sign-ins for vps in Settings → Accounts, or sign in on pc instead."
    );
    let problem = error.problem().unwrap();
    assert_eq!((problem.kind, problem.subject.as_deref()), (ProblemKind::Permission, Some(LOGIN_BORROW_SUBJECT)));
    assert_eq!(problem.action.unwrap().id, SIGN_IN_HERE_ACTION);
    assert!(l.broker(&l.b).binding(ProviderKind::ClaudeCode, &fresh).is_none(), "a refused bind is undone");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stopping_sharing_signs_no_machine_out_unless_asked() {
    let Some(l) = lending().await else { return };
    let (thread, _) = l.thread().await;
    l.send(thread, "hello").await;
    eventually("the turn completes", WAIT, || l.turns(thread, "turn_completed") == 1).await;
    // What a client sends for "Stop sharing": no `sign_out_old`.
    let params: LoginBrokerSetParams = serde_json::from_value(json!({ "machine_id": null })).unwrap();
    assert!(!params.sign_out_old);
    let result = client(&l.a).await.call::<LoginBrokerSet>(params).await.unwrap();
    assert!(result.old_signed_out.is_empty(), "{result:?}");
    assert!(result.status.lender.is_none());
    assert!(
        !events_of(&l.broker_state).iter().any(|line| line.starts_with("logout")),
        "the VPS was signed out: {:?}",
        events_of(&l.broker_state)
    );
    assert!(l.broker_dir.join(".credentials.json").exists(), "the VPS keeps its own sign-in");
    let choice = l.a.membership().projection().register(super::broker::CHOICE_REGISTER).map(|choice| choice.value.clone());
    assert_eq!(choice, Some(json!({})), "the choice is cleared with the lender");
}

// ---- 0.27.2: borrowing keeps working and never lands on another account ----

/// Wait for an async condition, polling (the harness' `eventually` takes a plain closure).
async fn eventually_async<F, Fut>(what: &str, mut condition: F)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    let deadline = tokio::time::Instant::now() + WAIT;
    while !condition().await {
        assert!(tokio::time::Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// A signed-in Claude account on `node` with `email`, its token `token`, and the node's fake state `state_dir`.
fn claude_account(node: &Node, name: &str, email: &str, token: &str, state_dir: &Path) -> String {
    let account = crate::provider_accounts::create(
        &node.state,
        AccountsCreateParams { kind: ProviderKind::ClaudeCode, name: name.into(), directory: None },
    )
    .unwrap();
    let dir = PathBuf::from(node.state.settings.get().providers[&ProviderKind::ClaudeCode].accounts[&account.instance].directory.clone());
    let mut settings = node.state.settings.get();
    settings
        .providers
        .entry(ProviderKind::ClaudeCode)
        .or_default()
        .env
        .insert("FAKE_STATE".into(), state_dir.to_string_lossy().into_owned());
    node.state.settings.set(settings).unwrap();
    write_login(&dir, state_dir, token, 8 * 3600 * 1000);
    std::fs::write(dir.join(".email"), email).unwrap();
    account.instance
}

fn email_of(node: &Node, kind: ProviderKind, instance: &str) -> Option<String> {
    node.state.settings.get().providers.get(&kind)?.accounts.get(instance)?.email.clone()
}

async fn send_from_client(l: &Lending, thread: ThreadId, text: &str) -> anyhow::Result<ThreadsSendResult> {
    l.b.state
        .orchestrator
        .send_client_message(ThreadsSendParams { thread_id: thread, message: UserMessage::text(text), message_id: None })
        .await
}

async fn set_logins(node: &Node, allowed: bool, seen_by: &Node) {
    let op = node.membership().set(&format!("allow.{}.logins", node.id()), json!(allowed)).unwrap();
    node.state.network.publish_ops(vec![op]);
    eventually("the policy reaches the borrower", WAIT, || {
        seen_by.membership().projection().allowed(&node.id()).get("logins") == Some(&allowed)
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_failed_borrow_is_tried_again_when_the_lender_is_back_and_before_a_send_is_refused() {
    let Some(l) = lending().await else { return };
    let (thread, _) = l.thread().await;
    l.send(thread, "first").await;
    eventually("first turn", WAIT, || l.turns(thread, "turn_completed") == 1).await;
    let broker = l.broker(&l.b);
    let state_of = || broker.account_view(ProviderKind::ClaudeCode, &l.local_account).unwrap().state;

    // The VPS sleeps, and a renewal in the meantime fails: the account reads offline.
    l.c.set_network_enabled(false);
    eventually("the PC loses the VPS", WAIT, || l.b.state.network.peers.link(&l.c.id()).is_none()).await;
    broker.renew(ProviderKind::ClaudeCode, &l.local_account, &l.broker_account).await.unwrap_err();
    assert_eq!(state_of(), BrokerLoginState::BrokerOffline);
    // It wakes up: the account reads as borrowing again, and the worker borrows again (no rotation, no push).
    l.c.set_network_enabled(true);
    eventually("the account reads as borrowing again", WAIT, || state_of() == BrokerLoginState::Borrowing).await;
    eventually("the worker borrowed again", WAIT, || broker.lease_error_for_test(ProviderKind::ClaudeCode, &l.local_account).is_none())
        .await;

    // The VPS turns Logins off: a renewal is refused, and so is a send, after asking the VPS again.
    set_logins(&l.c, false, &l.b).await;
    broker.renew(ProviderKind::ClaudeCode, &l.local_account, &l.broker_account).await.unwrap_err();
    let refused = send_from_client(&l, thread, "while refused").await.unwrap_err().to_string();
    assert!(refused.contains("doesn't let other machines use its sign-ins"), "{refused}");
    // Logins on again: the next send borrows once more instead of refusing on the old answer.
    set_logins(&l.c, true, &l.b).await;
    send_from_client(&l, thread, "allowed again").await.unwrap();
    eventually("the turn runs", WAIT, || l.turns(thread, "turn_completed") == 2).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn moving_the_lender_keeps_each_account_on_its_own_email_and_never_another_persons() {
    let Some(l) = lending().await else { return };
    let (thread, _) = l.thread().await;
    l.send(thread, "on the vps").await;
    eventually("first turn", WAIT, || l.turns(thread, "turn_completed") == 1).await;
    assert_eq!(email_of(&l.b, ProviderKind::ClaudeCode, &l.local_account).as_deref(), Some("broker@example.com"));

    // The Mac is signed in to someone else's account only, and becomes the lender.
    let mac_state = l.cluster.dir.path().join("mac-claude-state");
    let other = claude_account(&l.a, "Other", "other@example.com", "mac-other-0", &mac_state);
    client(&l.a)
        .await
        .call::<LoginBrokerSet>(LoginBrokerSetParams { machine_id: Some(l.a.id()), sign_out_old: false, via: None })
        .await
        .unwrap();
    let broker = l.broker(&l.b);
    eventually("the PC leaves the account unbound", WAIT, || broker.binding(ProviderKind::ClaudeCode, &l.local_account).is_none()).await;
    assert!(l.b.state.store.loans_open(kybern_store::LoanRole::Borrower).unwrap().is_empty(), "no loan of the other account");
    let view = broker.account_view(ProviderKind::ClaudeCode, &l.local_account).expect("the account says why");
    assert_eq!(view.state, BrokerLoginState::BrokerNotSignedIn);
    let message = view.message.unwrap();
    assert_eq!(
        message,
        "mac isn't signed in to broker@example.com, so pc can't use it through mac. Sign in to broker@example.com on mac, or sign in on pc instead."
    );
    let refused = send_from_client(&l, thread, "on whose account?").await.unwrap_err().to_string();
    assert!(refused.contains("isn't signed in to broker@example.com"), "{refused}");
    assert!(l.spawns().iter().all(|spawn| spawn.token != "mac-other-0"), "a session ran on another person's account");

    // The Mac signs in to the same account: the PC binds to that one, not the other.
    let same = claude_account(&l.a, "Same", "broker@example.com", "mac-0", &mac_state);
    eventually("the PC binds to the same account", WAIT, || {
        broker.binding(ProviderKind::ClaudeCode, &l.local_account).as_deref() == Some(&same)
    })
    .await;
    assert_ne!(same, other);
    send_from_client(&l, thread, "on the mac").await.unwrap();
    eventually("second turn", WAIT, || l.turns(thread, "turn_completed") == 2).await;
    assert_eq!(l.spawns().last().unwrap().token, "mac-0");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_lender_that_lends_another_account_under_the_same_id_is_refused() {
    let Some(l) = lending().await else { return };
    // The VPS' account is signed in to someone else now; its id is the same.
    std::fs::write(l.broker_dir.join(".email"), "other@example.com").unwrap();
    l.c.state.account_identities.invalidate(&ProviderInstance { kind: ProviderKind::ClaudeCode, instance: l.broker_account.clone() });
    let mut settings = l.c.state.settings.get();
    settings.providers.get_mut(&ProviderKind::ClaudeCode).unwrap().accounts.get_mut(&l.broker_account).unwrap().email =
        Some("other@example.com".into());
    l.c.state.settings.set(settings).unwrap();
    let error = l.broker(&l.b).renew(ProviderKind::ClaudeCode, &l.local_account, &l.broker_account).await.unwrap_err();
    assert_eq!(
        error,
        "vps now shares a different Claude Code account than broker@example.com. Sign in to broker@example.com on vps, or sign in on pc instead."
    );
    assert_eq!(email_of(&l.b, ProviderKind::ClaudeCode, &l.local_account).as_deref(), Some("broker@example.com"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_machine_that_becomes_the_lender_stops_borrowing_itself() {
    let Some(l) = lending().await else { return };
    let (thread, _) = l.thread().await;
    l.send(thread, "on the vps").await;
    eventually("first turn", WAIT, || l.turns(thread, "turn_completed") == 1).await;
    // The PC has its own login of the same account, and is chosen to share its sign-ins.
    let mine = claude_account(&l.b, "Mine", "broker@example.com", "pc-0", &l.b.root.join("fake-claude"));
    client(&l.a)
        .await
        .call::<LoginBrokerSet>(LoginBrokerSetParams { machine_id: Some(l.b.id()), sign_out_old: false, via: None })
        .await
        .unwrap();
    let broker = l.broker(&l.b);
    eventually("the PC's borrowed account stops borrowing", WAIT, || {
        broker.binding(ProviderKind::ClaudeCode, &l.local_account).is_none()
            && l.b.state.store.loans_open(kybern_store::LoanRole::Borrower).unwrap().is_empty()
    })
    .await;
    assert!(broker.account_view(ProviderKind::ClaudeCode, &l.local_account).is_none(), "the account still points at a lender");
    // The shared account maps to the PC's own login, not to the empty one.
    assert_eq!(email_of(&l.b, ProviderKind::ClaudeCode, &l.local_account), None);
    let settings = l.b.state.settings.get();
    let terminal = crate::accounts_shared::terminal_emails(Some(&l.b.state.store));
    assert_eq!(
        crate::accounts_shared::instance_for_key(&settings, &terminal, "claude-code:broker@example.com").as_deref(),
        Some(mine.as_str())
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_borrowed_account_carries_the_lenders_email_so_shared_defaults_reach_it() {
    let Some(l) = lending().await else { return };
    assert_eq!(email_of(&l.b, ProviderKind::ClaudeCode, &l.local_account).as_deref(), Some("broker@example.com"));
    let settings = l.b.state.settings.get();
    let terminal = crate::accounts_shared::terminal_emails(Some(&l.b.state.store));
    assert_eq!(
        crate::accounts_shared::key_of_instance(&settings, &terminal, ProviderKind::ClaudeCode, &l.local_account).as_deref(),
        Some("claude-code:broker@example.com"),
        "picking it as the default here names the lender's account"
    );
    // The shared default (chosen on another machine) reaches the borrowed account here.
    let mut settings = l.b.state.settings.get();
    settings.accounts_shared.defaults.insert(ProviderKind::ClaudeCode, "claude-code:broker@example.com".into());
    l.b.state.settings.set(settings).unwrap();
    assert_eq!(l.b.state.settings.get().providers[&ProviderKind::ClaudeCode].default_account.as_deref(), Some(l.local_account.as_str()));
}

/// A `codex` whose app-server renews its login on `account/read { refreshToken: true }`: it logs the request and
/// writes `$FAKE_STATE/codex-next-auth.json` over the account's `auth.json`.
const FAKE_CODEX: &str = r#"#!/bin/sh
[ "$1" = "app-server" ] || exit 0
IFS= read -r init
printf '{"id":1,"result":{}}\n'
IFS= read -r initialized
IFS= read -r request
echo "$request" >> "$FAKE_STATE/codex-requests"
case "$request" in
  *account/read*refreshToken*true*) cat "$FAKE_STATE/codex-next-auth.json" > "$CODEX_HOME/auth.json";;
esac
printf '{"id":2,"result":{"account":null}}\n'
"#;

fn codex_jwt(claims: serde_json::Value) -> String {
    use base64::Engine;
    let part = |value: &serde_json::Value| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(value).unwrap());
    format!("{}.{}.sig", part(&json!({"alg": "none"})), part(&claims))
}

fn codex_auth(marker: &str, lifetime_s: i64) -> (String, serde_json::Value) {
    let access = codex_jwt(json!({"exp": chrono::Utc::now().timestamp() + lifetime_s, "marker": marker}));
    let auth = json!({"auth_mode": "chatgpt", "tokens": {"id_token": codex_jwt(json!({"https://api.openai.com/auth": {"chatgpt_plan_type": "pro"}})),
        "access_token": access, "refresh_token": "cx-refresh-SECRET", "account_id": "acct-9"}});
    (access, auth)
}

/// A Codex account on the VPS with `auth`, its folder, and a PC account bound to it (or the bind's refusal).
async fn codex_pair(l: &Lending, auth: Option<serde_json::Value>) -> (String, PathBuf, String, Result<LoginBrokerStatus, RpcError>) {
    let account = crate::provider_accounts::create(
        &l.c.state,
        AccountsCreateParams { kind: ProviderKind::Codex, name: "Shared Codex".into(), directory: None },
    )
    .unwrap();
    let dir = PathBuf::from(l.c.state.settings.get().providers[&ProviderKind::Codex].accounts[&account.instance].directory.clone());
    let mut settings = l.c.state.settings.get();
    settings.providers.get_mut(&ProviderKind::Codex).unwrap().accounts.get_mut(&account.instance).unwrap().email =
        Some("codex@example.com".into());
    l.c.state.settings.set(settings).unwrap();
    if let Some(auth) = auth {
        std::fs::write(dir.join("auth.json"), auth.to_string()).unwrap();
    }
    let local = crate::provider_accounts::create(
        &l.b.state,
        AccountsCreateParams { kind: ProviderKind::Codex, name: "Via VPS".into(), directory: None },
    )
    .unwrap();
    let bound = l
        .broker(&l.b)
        .bind(
            &l.b.state,
            LoginBrokerBindParams {
                provider: ProviderKind::Codex,
                instance: local.instance.clone(),
                broker_account: Some(account.instance.clone()),
            },
        )
        .await;
    (account.instance, dir, local.instance, bound)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_lent_codex_login_is_renewed_by_codex_ahead_of_expiry_and_reaches_the_borrower() {
    let Some(l) = lending().await else { return };
    let codex = l.cluster.dir.path().join("bin").join("codex");
    kybern_protocol::process::write_executable(&codex, FAKE_CODEX).unwrap();
    let codex_state = l.cluster.dir.path().join("vps-codex-state");
    std::fs::create_dir_all(&codex_state).unwrap();
    let mut settings = l.c.state.settings.get();
    let provider = settings.providers.entry(ProviderKind::Codex).or_default();
    provider.binary = Some(codex.to_string_lossy().into_owned());
    provider.env.insert("FAKE_STATE".into(), codex_state.to_string_lossy().into_owned());
    l.c.state.settings.set(settings).unwrap();
    // Two hours left: well within a day, so the lender has Codex renew it while someone borrows it.
    let (_, auth) = codex_auth("cx-access-0", 2 * 3600);
    let (new, next) = codex_auth("cx-access-1", 240 * 3600);
    std::fs::write(codex_state.join("codex-next-auth.json"), next.to_string()).unwrap();
    let (account, _, local, bound) = codex_pair(&l, Some(auth)).await;
    bound.unwrap();
    assert_eq!(email_of(&l.b, ProviderKind::Codex, &local).as_deref(), Some("codex@example.com"));
    let source = l.broker(&l.b).acquire(ProviderKind::Codex, &local, &account).await.unwrap();
    let token = |login: BorrowedLogin| match login {
        BorrowedLogin::Codex { access_token, .. } => access_token,
        other => panic!("{other:?}"),
    };

    l.broker(&l.c).watch_lent(&l.c.state).await;
    eventually_async("the borrower holds the renewed token", || {
        let source = source.clone();
        let new = new.clone();
        async move { source.current().await.ok().map(token).as_deref() == Some(new.as_str()) }
    })
    .await;
    let requests = std::fs::read_to_string(codex_state.join("codex-requests")).unwrap_or_default();
    assert!(requests.contains("account/read") && requests.contains("\"refreshToken\":true"), "{requests}");
    // Renewed once: a fresh token is not renewed again.
    l.broker(&l.c).watch_lent(&l.c.state).await;
    assert_eq!(std::fs::read_to_string(codex_state.join("codex-requests")).unwrap_or_default().lines().count(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn binding_to_a_codex_login_that_cant_be_shared_is_refused_while_setting_up() {
    let Some(l) = lending().await else { return };
    // An API key, and a login kept in the system keyring (no auth.json): neither can be lent.
    for (auth, words) in [(Some(json!({"auth_mode": "apikey", "OPENAI_API_KEY": "sk-test"})), "API key"), (None, "system keyring")] {
        let (_, _, local, bound) = codex_pair(&l, auth).await;
        let error = bound.unwrap_err();
        assert!(error.message.contains(words) && error.message.contains("(vps)"), "{}", error.message);
        let problem = error.problem().expect("a problem");
        assert_eq!(problem.subject.as_deref(), Some(LOGIN_BORROW_SUBJECT));
        assert_eq!(problem.action.unwrap().id, SIGN_IN_HERE_ACTION);
        assert!(l.broker(&l.b).binding(ProviderKind::Codex, &local).is_none(), "the refused account stays unbound");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_borrowed_default_reads_its_limits_from_the_lender_with_the_lenders_time() {
    let Some(l) = lending().await else { return };
    let lent = ProviderInstance { kind: ProviderKind::ClaudeCode, instance: l.broker_account.clone() };
    l.c.state
        .orchestrator
        .usage()
        .observe_account(&lent, &[UsageLimit { name: "5-hour".into(), used_percent: 42.0, window_minutes: Some(300), resets_at: None }]);
    let at_lender = l.c.state.orchestrator.usage().cached_limits(ProviderKind::ClaudeCode, std::slice::from_ref(&l.broker_account));
    assert_eq!(at_lender[&l.broker_account][0].used_percent, 42.0);
    // The PC's default is the borrowed account.
    let mut settings = l.b.state.settings.get();
    settings.providers.get_mut(&ProviderKind::ClaudeCode).unwrap().default_account = Some(l.local_account.clone());
    l.b.state.settings.set(settings).unwrap();
    let before = chrono::Utc::now();
    let result = l.b.state.orchestrator.usage().limits(UsageLimitsParams { cached: false, refresh: true, ..Default::default() }).await;
    let global =
        result.providers.iter().find(|entry| entry.provider == ProviderKind::ClaudeCode).expect("the default's limits, from the lender");
    assert_eq!(global.limits[0].used_percent, 42.0);
    assert!(global.updated_at.is_some_and(|at| at < before), "the lender's time, not the time it was asked: {:?}", global.updated_at);
    assert_eq!(global.source, Some(LimitsSource::Session));
    // Counted once: the default is not listed again as an account entry.
    assert_eq!(result.accounts.iter().filter(|entry| entry.provider == ProviderKind::ClaudeCode).count(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_restart_renews_the_same_loan_and_a_removed_account_lets_its_loan_go() {
    let Some(l) = lending().await else { return };
    let (thread, _) = l.thread().await;
    l.send(thread, "hello").await;
    eventually("the turn completes", WAIT, || l.turns(thread, "turn_completed") == 1).await;
    let loan = l.c.state.store.loans_open(kybern_store::LoanRole::Lender).unwrap()[0].loan_id.clone();

    // A restart: the PC's leases are gone, its loans in the store are not. The next borrow renews the same loan.
    let broker = l.broker(&l.b);
    broker.forget_leases_for_test();
    broker.acquire(ProviderKind::ClaudeCode, &l.local_account, &l.broker_account).await.unwrap();
    let lent: Vec<String> =
        l.c.state.store.loans_open(kybern_store::LoanRole::Lender).unwrap().into_iter().map(|loan| loan.loan_id).collect();
    assert_eq!(lent, vec![loan.clone()], "one loan on the lender, the same one");
    let held: Vec<String> =
        l.b.state.store.loans_open(kybern_store::LoanRole::Borrower).unwrap().into_iter().map(|loan| loan.loan_id).collect();
    assert_eq!(held, vec![loan]);

    // The account is removed here: its loan goes back, and the binding with it.
    crate::provider_accounts::remove(&l.b.state, ProviderInstance { kind: ProviderKind::ClaudeCode, instance: l.local_account.clone() })
        .await
        .unwrap();
    eventually("the loan is let go on both machines", WAIT, || {
        l.b.state.store.loans_open(kybern_store::LoanRole::Borrower).unwrap().is_empty()
            && l.c.state.store.loans_open(kybern_store::LoanRole::Lender).unwrap().is_empty()
    })
    .await;
    assert!(
        l.b.state.store.meta_get(&format!("login_broker:bind:claude-code:{}", l.local_account)).unwrap().unwrap_or_default().is_empty()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_lender_refreshes_ahead_of_expiry_only_once_a_running_turn_finished() {
    let Some(l) = lending().await else { return };
    let (thread, _) = l.thread().await;
    let gate = Arc::new(tokio::sync::Notify::new());
    *l.hold.0.lock().await = Some(gate.clone());
    l.send(thread, "long task").await;
    eventually("the turn is running", WAIT, || l.spawns().len() == 1 && !l.spawns()[0].sent.lock().unwrap().is_empty()).await;

    // Four minutes left: due for a refresh, which would revoke the token the running turn uses. It waits.
    write_login(&l.broker_dir, &l.broker_state, "tok-0", 4 * 60 * 1000);
    let lender = l.broker(&l.c);
    lender.watch_lent(&l.c.state).await;
    assert!(!events_of(&l.broker_state).iter().any(|line| line.starts_with("refresh")), "{:?}", events_of(&l.broker_state));

    // The turn finishes on the token it started with: no failure, no second send.
    *l.hold.0.lock().await = None;
    gate.notify_one();
    eventually("the turn completes", WAIT, || l.turns(thread, "turn_completed") == 1).await;
    assert_eq!((l.spawns().len(), l.turns(thread, "turn_failed")), (1, 0));
    assert_eq!(l.spawns()[0].sent.lock().unwrap().len(), 1, "the message was sent once");
    // Idle now: the refresh happens, and the next turn runs on the new token.
    eventually_async("the lender refreshed", || {
        let lender = lender.clone();
        let state = l.c.state.clone();
        let dir = l.broker_state.clone();
        async move {
            lender.watch_lent(&state).await;
            events_of(&dir).iter().any(|line| line.starts_with("refresh"))
        }
    })
    .await;
    l.send(thread, "next").await;
    eventually("the next turn", WAIT, || l.turns(thread, "turn_completed") == 2).await;
    assert_eq!(l.spawns().last().unwrap().token, "tok-1");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sharing_a_machines_sign_ins_again_turns_its_logins_back_on() {
    let Some(l) = lending().await else { return };
    set_logins(&l.c, false, &l.b).await;
    eventually("the Mac has heard of it too", WAIT, || l.a.membership().projection().allowed(&l.c.id()).get("logins") == Some(&false))
        .await;
    let fresh = new_local_account(&l.b, "Refused").await;
    let bind = |instance: String| LoginBrokerBindParams {
        provider: ProviderKind::ClaudeCode,
        instance,
        broker_account: Some(l.broker_account.clone()),
    };
    let error = l.broker(&l.b).bind(&l.b.state, bind(fresh.clone())).await.unwrap_err();
    assert!(error.message.contains("Settings → Accounts") && !error.message.contains("Settings → Machines"), "{}", error.message);
    // "Share this machine's sign-ins" for the VPS, picked again on the Mac.
    client(&l.a)
        .await
        .call::<LoginBrokerSet>(LoginBrokerSetParams { machine_id: Some(l.c.id()), sign_out_old: false, via: None })
        .await
        .unwrap();
    eventually("the VPS lets its sign-ins be used again", WAIT, || {
        l.b.membership().projection().allowed(&l.c.id()).get("logins") != Some(&false)
    })
    .await;
    l.broker(&l.b).bind(&l.b.state, bind(fresh.clone())).await.unwrap();
}
