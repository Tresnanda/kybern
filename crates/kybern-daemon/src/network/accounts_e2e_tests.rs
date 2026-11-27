//! Accounts across machines end to end: the paths a person takes from the desktop, over real daemons, real sockets,
//! the real RPC dispatch and scope checks, with fake harness CLIs. Each test names the failure a user hit.
//!
//! * A desktop signs accounts in on another machine with the device grant it gets there (`accounts:write`), and that
//!   grant still cannot pair, expose or stop the machine.
//! * An authorize-only handoff: a sign-in on one machine finishes through the browser of another.
//! * Antigravity accounts never touch the computer's own `agy` login (the "keyring").
//! * A Claude terminal login read from the Keychain, or due for a refresh, still has its email and key.
//! * Shared account settings converge while several machines edit them at once.
//! * Lender status for new setups and following updates, written against the behaviour other lanes are adding.
//!
//! The fake Claude is a small Python program, since a browser sign-in has to listen on a loopback port; the tests
//! that need it skip without `python3`. Cluster tests skip on a computer without the `127.x.0.n` loopback aliases.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use kybern_client::{Client, Endpoint};
use kybern_protocol::methods::*;
use kybern_protocol::*;
use serde_json::{Value, json};

use super::harness::*;
use super::testutil::TempDir;
use crate::state::AppState;

// ---- fake harnesses ----

/// `claude auth login|status|logout`. The account folder is `CLAUDE_CONFIG_DIR`, or `~/.claude` for the terminal
/// login. `.signed-in` holds the email `auth status` reports; `-` is a login that reports none (a Keychain login).
/// A pasted code is read in Kybern's hidden terminal; a browser sign-in listens on `[::1]:<port>` (the harness's own
/// loopback) and finishes when the browser's redirect with the page's `state` arrives, as `claude auth login` does.
const FAKE_CLAUDE: &str = r#"#!/usr/bin/env python3
import json, os, socket, subprocess, sys
args = sys.argv[1:]
root = os.environ["FAKE_ROOT"]
cfg = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.environ.get("HOME", ""), ".claude")
signed = os.path.join(cfg, ".signed-in")
def email():
    with open(os.path.join(root, "next-email")) as f:
        return f.read().strip()
def sign_in():
    with open(signed, "w") as f:
        f.write(email())
if args[:2] == ["auth", "status"]:
    if os.path.exists(signed):
        with open(signed) as f:
            who = f.read().strip()
        out = {"loggedIn": True, "authMethod": "claude.ai", "subscriptionType": "max"}
        if who != "-":
            out["email"] = who
        print(json.dumps(out))
        sys.exit(0)
    print('{"loggedIn":false}')
    sys.exit(1)
if args[:2] == ["auth", "logout"]:
    if os.path.exists(signed):
        os.remove(signed)
    sys.exit(0)
if args[:2] == ["auth", "login"]:
    os.makedirs(cfg, exist_ok=True)
    if sys.stdin.isatty():
        print("Opening browser to sign in...")
        print("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=S", flush=True)
        sys.stdout.write("Paste code here if prompted > ")
        sys.stdout.flush()
        code = sys.stdin.readline().strip()
        if code == "good":
            sign_in()
            sys.exit(0)
        print("bad code")
        sys.exit(1)
    server = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
    server.bind(("::1", 0))
    server.listen(8)
    port = server.getsockname()[1]
    state = "S%d" % port
    url = "https://claude.com/cai/oauth/authorize?redirect_uri=http%%3A%%2F%%2Flocalhost%%3A%d%%2Fcallback&state=%s" % (port, state)
    subprocess.run([os.environ.get("BROWSER", "open"), url])
    while True:
        conn, _ = server.accept()
        line = conn.recv(65536).decode(errors="replace").split("\r\n", 1)[0]
        with open(os.path.join(cfg, "callbacks"), "a") as f:
            f.write(line + "\n")
        if line.startswith("GET /callback?") and ("state=" + state) in line and "code=" in line:
            conn.sendall(b"HTTP/1.1 302 Found\r\nLocation: https://claude.com/oauth/success\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            conn.close()
            sign_in()
            sys.exit(0)
        conn.sendall(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        conn.close()
sys.exit(2)
"#;

/// `agy`, the way the macOS one stores its login: in the shared keyring (`@KEYRING@`, a file outside every account
/// folder) unless it is told to keep a file (`AGY_ACP_FORCE_FILE_STORAGE=1` with an `SSH_CONNECTION`), when the login
/// goes into the profile `--gemini-dir` names. Bare `agy` is the computer's own sign-in: always the keyring.
const FAKE_AGY: &str = r#"#!/bin/sh
keyring='@KEYRING@'
email=$(cat '@ROOT@/next-email' 2>/dev/null)
case "$1" in
acp)
  [ "$2" = "--gemini-dir" ] && [ "$4" = "--login" ] || exit 3
  echo "Open this link in a browser to log in with Google:"
  echo "  https://accounts.google.com/o/oauth2/auth?redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&state=S"
  read code
  code=$(printf '%s' "$code" | tr -d '\r')
  [ "$code" = "good" ] || { echo "login cancelled"; exit 1; }
  if [ -n "$SSH_CONNECTION" ] && [ "$AGY_ACP_FORCE_FILE_STORAGE" = "1" ]; then
    mkdir -p "$3/antigravity-cli"
    printf '{"token":{"access_token":"t","expiry":"2099-01-01T00:00:00Z"},"auth_method":"oauth-personal","id_token_email":"%s"}' "$email" > "$3/antigravity-cli/antigravity-oauth-token"
  else
    printf '%s' "$email" > "$keyring"
  fi
  echo "Logged in as $email."
  exit 0 ;;
models)
  [ -f "$HOME/.gemini/antigravity-cli/antigravity-oauth-token" ] || { echo "Error: Please sign in to view available models."; exit 1; }
  echo "Fetching available models..."
  printf 'gemini-x\tGemini X\n'
  exit 0 ;;
"")
  echo "Sign in with Google to continue."
  read code
  printf '%s' "$email" > "$keyring"
  exit 0 ;;
esac
exit 2
"#;

/// A harness that is not installed here.
const ABSENT: &str = "#!/bin/sh\nexit 1\n";

const ORIGINAL_LOGIN: &str = "original@example.com";

struct Fakes {
    dir: TempDir,
}

impl Fakes {
    fn new(label: &str) -> Self {
        let fakes = Self { dir: TempDir::new(label) };
        std::fs::create_dir_all(fakes.home()).unwrap();
        std::fs::create_dir_all(fakes.bin()).unwrap();
        kybern_protocol::process::write_executable(&fakes.bin().join("absent"), ABSENT).unwrap();
        kybern_protocol::process::write_executable(&fakes.bin().join("claude"), FAKE_CLAUDE).unwrap();
        let agy = FAKE_AGY.replace("@KEYRING@", &fakes.keyring_path().to_string_lossy()).replace("@ROOT@", &fakes.root().to_string_lossy());
        kybern_protocol::process::write_executable(&fakes.bin().join("agy"), agy).unwrap();
        std::fs::write(fakes.keyring_path(), ORIGINAL_LOGIN).unwrap();
        fakes
    }

    fn root(&self) -> &Path {
        self.dir.path()
    }

    fn bin(&self) -> PathBuf {
        self.root().join("bin")
    }

    /// The `HOME` every harness on this machine sees.
    fn home(&self) -> PathBuf {
        self.root().join("home")
    }

    fn keyring_path(&self) -> PathBuf {
        self.root().join("keyring")
    }

    fn keyring(&self) -> String {
        std::fs::read_to_string(self.keyring_path()).unwrap()
    }

    /// The account the next sign-in signs in as.
    fn next_email(&self, email: &str) {
        std::fs::write(self.root().join("next-email"), email).unwrap();
    }

    /// Point every harness of `state` at the fakes: Claude and `agy` here, nothing else installed, one `HOME`.
    fn install(&self, state: &AppState) {
        let mut settings = state.settings.get();
        for kind in ProviderKind::ALL {
            let provider = settings.providers.entry(kind).or_default();
            let name = match kind {
                ProviderKind::ClaudeCode => "claude",
                ProviderKind::Antigravity => "agy",
                _ => "absent",
            };
            provider.binary = Some(self.bin().join(name).to_string_lossy().into_owned());
            provider.env.insert("HOME".into(), self.home().to_string_lossy().into_owned());
            provider.env.insert("FAKE_ROOT".into(), self.root().to_string_lossy().into_owned());
        }
        // `agy mcp` belongs to the person's own profile; these tests leave it alone.
        settings.antigravity.kybern_tools = false;
        state.settings.set(settings).unwrap();
    }
}

fn python3() -> bool {
    let found = std::process::Command::new("python3").args(["-c", "pass"]).status().is_ok_and(|status| status.success());
    if !found {
        eprintln!("skipped: no python3 for the fake Claude");
    }
    found
}

fn ipv6_loopback() -> bool {
    let found = std::net::TcpListener::bind(("::1", 0)).is_ok();
    if !found {
        eprintln!("skipped: no [::1] for the fake Claude's redirect listener");
    }
    found
}

/// A daemon on its own, for the tests that need no other machine.
fn single(label: &str) -> (TempDir, AppState, Fakes) {
    let dir = TempDir::new(label);
    let paths = crate::config::Paths::resolve(Some(dir.path().join("data"))).unwrap();
    let state = AppState::initialize(&paths).unwrap();
    let fakes = Fakes::new(&format!("{label}-fakes"));
    fakes.install(&state);
    (dir, state, fakes)
}

// ---- the desktop ----

/// The desktop on its own computer: the bootstrap token, every client scope.
async fn desktop(node: &Node) -> Client {
    Client::connect(&Endpoint { url: node.ws_url(), token: node.device_token(&Scope::ALL) }).await.unwrap()
}

/// What the desktop does to reach another machine: ask its own daemon for a device grant there, then connect with it.
async fn reach(desktop: &Client, machine: &Node, device_id: &str) -> (NetworkClientGrantResult, Client) {
    let grant = desktop
        .call::<NetworkClientGrant>(NetworkClientGrantParams { machine_id: machine.id(), device_id: device_id.into() })
        .await
        .expect("a grant for the other machine");
    let client = Client::connect(&Endpoint { url: machine.ws_url(), token: grant.token.clone() }).await.unwrap();
    (grant, client)
}

/// The scopes `machine` gave the token, by name (so this file also compiles where a scope is missing).
fn scopes_on(machine: &Node, token: &str) -> Vec<String> {
    let record = machine.state.store.token_lookup(&crate::auth::hash(token)).unwrap().expect("the token is known there");
    record.scopes.iter().map(|scope| scope.to_string()).collect()
}

fn refused(result: &anyhow::Result<Value>) -> bool {
    matches!(result, Err(error) if error.to_string().contains("missing scope"))
}

async fn both_heard(a: &Node, b: &Node) {
    eventually("both machines heard each other's presence", WAIT, || {
        linked(a, b) && a.state.network.peers.status(&b.id()).presence.is_some() && b.state.network.peers.status(&a.id()).presence.is_some()
    })
    .await;
}

async fn login_reaches(client: &Client, id: &str, phase: AccountLoginPhase) -> AccountLogin {
    let deadline = tokio::time::Instant::now() + WAIT;
    loop {
        let login = client.call::<AccountsLoginGet>(AccountLoginIdParams { id: id.into() }).await.unwrap();
        if login.phase == phase {
            return login;
        }
        assert!(tokio::time::Instant::now() < deadline, "the sign-in never reached {phase:?}: {:?} {:?}", login.phase, login.error);
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

async fn state_login_reaches(state: &AppState, id: &str, phase: AccountLoginPhase) -> AccountLogin {
    let deadline = tokio::time::Instant::now() + WAIT;
    loop {
        let login = state.account_logins.get(id).unwrap();
        if login.phase == phase {
            return login;
        }
        assert!(tokio::time::Instant::now() < deadline, "the sign-in never reached {phase:?}: {:?} {:?}", login.phase, login.error);
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

fn start(kind: ProviderKind, mode: AccountLoginMode) -> AccountLoginStartParams {
    AccountLoginStartParams { kind, instance: None, mode, directory: None, upstream: None, named: false }
}

fn claude_accounts(state: &AppState) -> std::collections::BTreeMap<String, ProviderAccount> {
    state.settings.get().providers.get(&ProviderKind::ClaudeCode).map(|provider| provider.accounts.clone()).unwrap_or_default()
}

// ---- 2. a desktop signs accounts in on another machine ----

/// "This computer refused access": every sign-in call the desktop makes on another machine, with the device grant it
/// got there, over the real socket and scope check. The grant still cannot pair, expose or stop that machine.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_desktop_signs_accounts_in_on_another_machine_with_its_device_grant() {
    let Some(cluster) = Cluster::new(&[NodeSpec::owner("a"), NodeSpec::owner("b")]) else { return };
    if !python3() {
        return;
    }
    let a = cluster.start("a", true).await;
    let b = cluster.start("b", true).await;
    cluster.form(&a, &[&b], JoinVia::Auto).await;
    both_heard(&a, &b).await;
    let fakes = Fakes::new("grant-b");
    fakes.install(&b.state);

    let desktop = desktop(&a).await;
    let (grant, at_b) = reach(&desktop, &b, "desktop-1").await;
    assert!(scopes_on(&b, &grant.token).iter().any(|scope| scope == "accounts:write"), "{:?}", scopes_on(&b, &grant.token));

    let list = at_b.call::<AccountsList>(AccountsListParams { kind: Some(ProviderKind::ClaudeCode), refresh: true }).await.unwrap();
    assert!(list.accounts.iter().any(|account| account.terminal), "b's terminal login is listed");

    // A new account with a pasted code.
    fakes.next_email("paste@example.com");
    let login = at_b
        .call::<AccountsLoginStart>(start(ProviderKind::ClaudeCode, AccountLoginMode::Paste))
        .await
        .expect("the desktop may start a sign-in on b");
    assert!(login.url.as_deref().is_some_and(|url| url.contains("platform.claude.com")), "{login:?}");
    at_b.call::<AccountsLoginInput>(AccountLoginInputParams { id: login.id.clone(), code: "good".into() }).await.unwrap();
    let done = login_reaches(&at_b, &login.id, AccountLoginPhase::SignedIn).await;
    assert_eq!(done.identity.and_then(|identity| identity.email).as_deref(), Some("paste@example.com"));
    let instance = at_b
        .call::<AccountsLoginFinish>(AccountLoginFinishParams {
            id: login.id.clone(),
            name: "Pasted".into(),
            color: None,
            make_default: false,
        })
        .await
        .unwrap();
    assert_eq!(claude_accounts(&b.state)[&instance.instance].email.as_deref(), Some("paste@example.com"));

    // Signed out, then removed, from the desktop.
    let out = at_b
        .call::<AccountsSignOut>(AccountsSignOutParams {
            kind: ProviderKind::ClaudeCode,
            instance: instance.instance.clone(),
            confirm_terminal: false,
        })
        .await
        .unwrap();
    assert_eq!(out.status, AccountStatus::SignedOut);
    at_b.call::<AccountsRemove>(instance.clone()).await.unwrap();
    assert!(!claude_accounts(&b.state).contains_key(&instance.instance));

    // Binding to a lender: b has none, and says so, but does not refuse the desktop.
    let bind = at_b.call_raw(LoginBrokerBind::NAME, json!({"provider": "claude-code", "instance": "nope", "broker_account": "x"})).await;
    assert!(!refused(&bind), "{bind:?}");

    // A browser sign-in on b caught by the desktop's own computer, and cancelled.
    if ipv6_loopback() {
        let browser = at_b.call::<AccountsLoginStart>(start(ProviderKind::ClaudeCode, AccountLoginMode::Browser)).await.unwrap();
        assert!(browser.handoff.is_some(), "{browser:?}");
        let caught = desktop
            .call::<AccountsLoginHandoff>(AccountLoginHandoffParams { machine_id: b.id(), login_id: browser.id.clone() })
            .await
            .expect("this computer catches b's redirect");
        assert_eq!(Some(caught.url), browser.url);
        let canceled = at_b.call::<AccountsLoginCancel>(AccountLoginIdParams { id: browser.id.clone() }).await.unwrap();
        assert_eq!(canceled.phase, AccountLoginPhase::Canceled);
    }

    // What a device grant never does.
    for (method, params) in [
        (PairingCreate::NAME, json!({})),
        (ExposureSet::NAME, json!({"tailscale": true})),
        (TokensRevoke::NAME, json!({"token_id": uuid::Uuid::now_v7()})),
        ("daemon.shutdown", json!({})),
    ] {
        let answer = at_b.call_raw(method, params).await;
        assert!(refused(&answer), "{method}: {answer:?}");
    }
    assert!(!b.state.shutdown.is_cancelled());
}

/// A machine from before `accounts:write` could not read a scope list naming it: the token minted for it leaves the
/// scope out.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_grant_minted_for_an_older_machine_leaves_accounts_write_out() {
    let Some(cluster) = Cluster::new(&[NodeSpec::owner("a"), NodeSpec::owner("b")]) else { return };
    let a = cluster.start("a", true).await;
    let b = cluster.start("b", true).await;
    cluster.form(&a, &[&b], JoinVia::Auto).await;
    both_heard(&a, &b).await;
    let desktop = desktop(&a).await;
    let (grant, at_b) = reach(&desktop, &b, "desktop-1").await;
    assert!(scopes_on(&b, &grant.token).iter().any(|scope| scope == "accounts:write"), "a current machine gets it");
    assert!(at_b.call::<DaemonInfoMethod>(Empty {}).await.is_ok());
    // b last heard a say it runs a version without the feature, and a asks b to mint for its desktop. A live link
    // sends its real presence again on its own, so b mints right after hearing the old one.
    let link = b.state.network.peers.link(&a.id()).expect("b's link to a");
    let mut old = a.state.network.presence();
    old.version = "0.27.1".into();
    old.features.retain(|feature| feature != "accounts.write.v1");
    b.state.network.peers.set_presence(&a.id(), old);
    let minted = super::client_grant::mint_for_peer(
        &b.state,
        &link,
        PeerClientTokenMintParams { device_id: "desktop-old".into(), label: "Desktop".into(), lineage: vec![] },
    )
    .unwrap();
    let scopes: Vec<String> = minted.scopes.iter().map(|scope| scope.to_string()).collect();
    assert!(!scopes.iter().any(|scope| scope == "accounts:write"), "{scopes:?}");
    assert!(scopes.iter().any(|scope| scope == "orchestration:operate"), "{scopes:?}");
}

// ---- 3. authorize-only handoff ----

/// Claude on b listens for its redirect on b's loopback; this computer catches the browser's redirect on the same
/// port, hands path and query to b, and b's Claude finishes signing in.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_authorize_only_handoff_signs_the_other_machine_in_through_this_browser() {
    let Some(cluster) = Cluster::new(&[NodeSpec::owner("a"), NodeSpec::owner("b")]) else { return };
    if !python3() || !ipv6_loopback() {
        return;
    }
    let a = cluster.start("a", true).await;
    let b = cluster.start("b", true).await;
    cluster.form(&a, &[&b], JoinVia::Auto).await;
    both_heard(&a, &b).await;
    let fakes = Fakes::new("handoff-b");
    fakes.install(&b.state);
    fakes.next_email("handoff@example.com");

    let desktop = desktop(&a).await;
    let (_, at_b) = reach(&desktop, &b, "desktop-1").await;
    let login = at_b.call::<AccountsLoginStart>(start(ProviderKind::ClaudeCode, AccountLoginMode::Browser)).await.unwrap();
    let handoff = login.handoff.clone().expect("b's Claude waits for a loopback redirect");
    assert_eq!(handoff.path, "/callback");
    let caught =
        desktop.call::<AccountsLoginHandoff>(AccountLoginHandoffParams { machine_id: b.id(), login_id: login.id.clone() }).await.unwrap();
    let page = reqwest::Url::parse(&caught.url).unwrap();
    let state = page.query_pairs().find(|(key, _)| key == "state").map(|(_, value)| value.into_owned()).unwrap();

    // The browser on this computer comes back to the loopback port.
    let browser = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).no_proxy().build().unwrap();
    let base = format!("http://127.0.0.1:{}", handoff.port);
    let stray = browser.get(format!("{base}/callback?code=c&state=another")).send().await.unwrap();
    assert_eq!(stray.status(), 400, "another sign-in's redirect is not forwarded");
    let back = browser.get(format!("{base}/callback?code=the-code&state={state}")).send().await.unwrap();
    assert_eq!(back.status(), 302);
    assert_eq!(back.headers()["location"], "https://claude.com/oauth/success");

    let done = login_reaches(&at_b, &login.id, AccountLoginPhase::SignedIn).await;
    assert_eq!(done.identity.and_then(|identity| identity.email).as_deref(), Some("handoff@example.com"));
    let callbacks = std::fs::read_to_string(
        PathBuf::from(&b.state.settings.dir()).join("accounts").join("claude-code").join(&login.id).join("callbacks"),
    )
    .unwrap();
    assert!(
        callbacks.contains(&format!("GET /callback?code=the-code&state={state} ")),
        "b's Claude got the browser's redirect: {callbacks}"
    );
    let instance = at_b
        .call::<AccountsLoginFinish>(AccountLoginFinishParams {
            id: login.id.clone(),
            name: "Handed".into(),
            color: None,
            make_default: false,
        })
        .await
        .unwrap();
    assert_eq!(claude_accounts(&b.state)[&instance.instance].email.as_deref(), Some("handoff@example.com"));
}

/// The port is taken on this computer: the handoff says so, and the desktop falls back to a code.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_handoff_on_a_busy_port_is_not_available_so_the_desktop_uses_a_code() {
    let Some(cluster) = Cluster::new(&[NodeSpec::owner("a"), NodeSpec::owner("b")]) else { return };
    if !python3() || !ipv6_loopback() {
        return;
    }
    let a = cluster.start("a", true).await;
    let b = cluster.start("b", true).await;
    cluster.form(&a, &[&b], JoinVia::Auto).await;
    both_heard(&a, &b).await;
    let fakes = Fakes::new("busy-b");
    fakes.install(&b.state);

    let desktop = desktop(&a).await;
    let (_, at_b) = reach(&desktop, &b, "desktop-1").await;
    let login = at_b.call::<AccountsLoginStart>(start(ProviderKind::ClaudeCode, AccountLoginMode::Browser)).await.unwrap();
    let port = login.handoff.clone().unwrap().port;
    // Another program on this computer holds the port.
    let _taken = std::net::TcpListener::bind(("127.0.0.1", port)).unwrap();
    let error = desktop
        .call::<AccountsLoginHandoff>(AccountLoginHandoffParams { machine_id: b.id(), login_id: login.id.clone() })
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains(&format!("(code {})", codes::NOT_AVAILABLE)), "{error}");
    assert!(error.contains("Use a code instead"), "{error}");
    at_b.call::<AccountsLoginCancel>(AccountLoginIdParams { id: login.id }).await.unwrap();
    // The fallback, a pasted code, still works on b.
    fakes.next_email("code@example.com");
    let paste = at_b.call::<AccountsLoginStart>(start(ProviderKind::ClaudeCode, AccountLoginMode::Paste)).await.unwrap();
    at_b.call::<AccountsLoginInput>(AccountLoginInputParams { id: paste.id.clone(), code: "good".into() }).await.unwrap();
    login_reaches(&at_b, &paste.id, AccountLoginPhase::SignedIn).await;
}

// ---- 4. Antigravity accounts never touch the computer's own login ----

/// 0.27.1 took a Terminal sign-in without `named` for the computer's own login; agy then saved the new Google account
/// over the person's own. A new sign-in is always a new account; only `default` is the computer's login.
#[tokio::test(flavor = "multi_thread")]
async fn a_new_antigravity_sign_in_is_a_new_account_and_only_default_is_the_computers_login() {
    let (_dir, state, fakes) = single("agy-unnamed");
    let state = &state;
    for mode in [AccountLoginMode::Terminal, AccountLoginMode::Paste] {
        let login = state.account_logins.start(state, start(ProviderKind::Antigravity, mode)).await.unwrap();
        assert_eq!(login.instance, None, "{mode:?}: a new account, never the computer's login");
        let folder = state.settings.dir().join("accounts").join("antigravity").join(&login.id);
        assert!(folder.is_dir(), "{mode:?}: its own folder");
        state.account_logins.cancel(state, &login.id).await.unwrap();
    }
    let mut own = start(ProviderKind::Antigravity, AccountLoginMode::Terminal);
    own.instance = Some("default".into());
    let machine = state.account_logins.start(state, own).await.unwrap();
    assert_eq!(machine.instance.as_deref(), Some("default"));
    state.account_logins.cancel(state, &machine.id).await.unwrap();
    assert_eq!(fakes.keyring(), ORIGINAL_LOGIN, "nothing signed the computer's login in again");
}

/// Two named accounts, one with a pasted code and one typed in a terminal: each login lands in its own profile, and the
/// computer's own login is still the one it was.
#[tokio::test(flavor = "multi_thread")]
async fn named_antigravity_accounts_keep_their_logins_in_their_profiles_and_leave_the_computers_alone() {
    let (_dir, state, fakes) = single("agy-named");
    let state = &state;

    fakes.next_email("first@example.com");
    let mut paste = start(ProviderKind::Antigravity, AccountLoginMode::Paste);
    paste.named = true;
    let login = state.account_logins.start(state, paste).await.unwrap();
    assert!(login.url.as_deref().is_some_and(|url| url.contains("antigravity.google")), "{login:?}");
    state.account_logins.input(&login.id, "good".into()).await.unwrap();
    let done = state_login_reaches(state, &login.id, AccountLoginPhase::SignedIn).await;
    assert_eq!(done.identity.and_then(|identity| identity.email).as_deref(), Some("first@example.com"));
    let first = state
        .account_logins
        .finish(state, AccountLoginFinishParams { id: login.id.clone(), name: "First".into(), color: None, make_default: false })
        .await
        .unwrap();
    assert_eq!(fakes.keyring(), ORIGINAL_LOGIN);

    fakes.next_email("second@example.com");
    let mut typed = start(ProviderKind::Antigravity, AccountLoginMode::Terminal);
    typed.named = true;
    let login = state.account_logins.start(state, typed).await.unwrap();
    let terminal = login.terminal.clone().expect("a terminal to type in");
    state.terminals.get(terminal.id).expect("the terminal runs").write(b"good\r").unwrap();
    let done = state_login_reaches(state, &login.id, AccountLoginPhase::SignedIn).await;
    assert_eq!(done.identity.and_then(|identity| identity.email).as_deref(), Some("second@example.com"));
    let second = state
        .account_logins
        .finish(state, AccountLoginFinishParams { id: login.id.clone(), name: "Second".into(), color: None, make_default: false })
        .await
        .unwrap();

    let provider = state.settings.get().providers[&ProviderKind::Antigravity].clone();
    for (instance, email) in [(&first.instance, "first@example.com"), (&second.instance, "second@example.com")] {
        let folder = PathBuf::from(&provider.accounts[instance].directory);
        let token = std::fs::read_to_string(folder.join(".gemini/antigravity-cli/antigravity-oauth-token")).unwrap();
        assert!(token.contains(email), "{instance}'s login is a file in its own profile");
    }
    assert_eq!(fakes.keyring(), ORIGINAL_LOGIN, "the computer's own login is still the original");
    assert!(
        !fakes.home().join(".gemini/antigravity-cli/antigravity-oauth-token").exists(),
        "no login was written to the computer's profile"
    );
}

// ---- 5. the Claude terminal login's identity ----

fn claude_json(home: &Path, email: &str) {
    std::fs::write(home.join(".claude.json"), json!({"oauthAccount": {"emailAddress": email, "organizationName": "Me Inc"}}).to_string())
        .unwrap();
}

/// A terminal login whose `auth status` names no account (read from the Keychain).
fn keychain_login(home: &Path) {
    std::fs::create_dir_all(home.join(".claude")).unwrap();
    std::fs::write(home.join(".claude/.signed-in"), "-").unwrap();
}

/// A terminal login due for a refresh, which Kybern reads without running Claude Code.
fn login_due_for_refresh(home: &Path) {
    std::fs::create_dir_all(home.join(".claude")).unwrap();
    let expired = chrono::Utc::now().timestamp_millis() - 60_000;
    let login = json!({"claudeAiOauth": {"accessToken": "a", "refreshToken": "r", "expiresAt": expired, "subscriptionType": "max",
        "scopes": ["user:inference", "user:profile"]}});
    std::fs::write(home.join(".claude/.credentials.json"), login.to_string()).unwrap();
}

async fn terminal_claude(state: &AppState) -> AccountSummary {
    let list =
        crate::provider_accounts::list(state, AccountsListParams { kind: Some(ProviderKind::ClaudeCode), refresh: true }).await.unwrap();
    list.accounts.into_iter().find(|account| account.terminal).expect("the terminal login is listed")
}

/// "email unavailable" on macOS: the email comes from Claude Code's own `.claude.json`, so the terminal login has a key.
#[tokio::test(flavor = "multi_thread")]
async fn a_claude_terminal_login_without_an_email_takes_it_and_its_key_from_claude_json() {
    if !python3() {
        return;
    }
    for (label, login) in [("keychain", keychain_login as fn(&Path)), ("refresh", login_due_for_refresh)] {
        let (_dir, state, fakes) = single(&format!("claude-{label}"));
        login(&fakes.home());
        claude_json(&fakes.home(), "Me@Example.com");
        let terminal = terminal_claude(&state).await;
        let identity = terminal.identity.clone().unwrap_or_default();
        assert_eq!(identity.email.as_deref(), Some("Me@Example.com"), "{label}: {terminal:?}");
        assert_eq!(terminal.key.as_deref(), Some("claude-code:me@example.com"), "{label}: {terminal:?}");
    }
}

async fn sync_both(a: &Node, b: &Node) {
    let link = a.state.network.peers.link(&b.id()).expect("a link to b");
    super::accounts_sync::sync(&a.state, &link).await;
    let link = b.state.network.peers.link(&a.id()).expect("a link to a");
    super::accounts_sync::sync(&b.state, &link).await;
}

/// The Mac's terminal login (email from `.claude.json`) and the same account added on the PC are one account: neither
/// machine is offered to set it up.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_terminal_login_and_the_same_account_elsewhere_make_no_setup_offer() {
    let Some(cluster) = Cluster::new(&[NodeSpec::owner("a"), NodeSpec::owner("b")]) else { return };
    if !python3() {
        return;
    }
    let a = cluster.start("a", true).await;
    let b = cluster.start("b", true).await;
    cluster.form(&a, &[&b], JoinVia::Auto).await;
    both_heard(&a, &b).await;
    let mac = Fakes::new("terminal-a");
    mac.install(&a.state);
    keychain_login(&mac.home());
    claude_json(&mac.home(), "me@example.com");
    let pc = Fakes::new("named-b");
    pc.install(&b.state);
    let folder = pc.root().join("work");
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join(".signed-in"), "me@example.com").unwrap();
    let mut settings = b.state.settings.get();
    settings.providers.get_mut(&ProviderKind::ClaudeCode).unwrap().accounts.insert(
        "w1".into(),
        ProviderAccount { name: "Work".into(), directory: folder.to_string_lossy().into_owned(), ..Default::default() },
    );
    b.state.settings.set(settings).unwrap();

    // What each machine lists is what the others learn it holds.
    for node in [&a, &b] {
        crate::provider_accounts::list(&node.state, AccountsListParams { kind: None, refresh: true }).await.unwrap();
    }
    let key = "claude-code:me@example.com";
    let holds = |observer: &Node, machine: &Node| {
        super::accounts_sync::all_holdings(&observer.state)
            .get(&machine.id())
            .is_some_and(|held| held.accounts.iter().any(|account| account.key.as_deref() == Some(key)))
    };
    let deadline = tokio::time::Instant::now() + WAIT;
    while !(holds(&a, &b) && holds(&b, &a) && holds(&a, &a) && holds(&b, &b)) {
        assert!(tokio::time::Instant::now() < deadline, "each machine learns the other holds {key}");
        sync_both(&a, &b).await;
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    for node in [&a, &b] {
        let offers = crate::accounts_offers::offers(&node.state).offers;
        assert!(
            !offers.iter().any(|offer| offer.kind == AccountOfferKind::NewMachine && offer.keys.iter().any(|k| k == key)),
            "{}: {offers:?}",
            node.name
        );
    }
}

// ---- 6. shared account settings converge under concurrent edits ----

const STEPS: usize = 12;

fn key_of(index: usize) -> String {
    format!("claude-code:k{index}@example.com")
}

fn add_accounts(node: &Node, index: usize, count: usize) {
    let mut settings = node.state.settings.get();
    let claude = settings.providers.entry(ProviderKind::ClaudeCode).or_default();
    for key in 0..count {
        let id = format!("n{index}k{key}");
        claude.accounts.insert(
            id.clone(),
            ProviderAccount {
                name: format!("K{key}"),
                directory: node.state.settings.dir().join("accounts").join(&id).to_string_lossy().into_owned(),
                color: Some("blue".into()),
                email: Some(format!("k{key}@example.com")),
                plan: None,
            },
        );
    }
    node.state.settings.set(settings).unwrap();
}

/// What every machine must end with: each machine's last rename and "Only when I choose" of the account it edited,
/// every dismissal any of them made, and the first machine's last default.
fn expected_after_edits(count: usize) -> impl Fn(&AccountsShared) -> bool {
    move |shared| {
        let last = STEPS - 1;
        (0..count).all(|index| {
            shared
                .profiles
                .get(&key_of(index))
                .is_some_and(|profile| profile.name == format!("m{index}-{last}") && profile.manual_only == (last % 2 == 1))
                && (0..STEPS).all(|step| shared.offers.contains_key(&format!("new_machine:m{index}-{step}")))
        }) && shared.defaults.get(&ProviderKind::ClaudeCode) == Some(&key_of(last % count))
    }
}

/// One machine's run of edits, each a settings write (the way any route writes), with the network's passes running.
async fn edit(state: AppState, index: usize, count: usize) {
    for step in 0..STEPS {
        state
            .settings
            .update(|settings| {
                let mut next = settings.clone();
                let shared = &mut next.accounts_shared;
                let profile = shared.profiles.entry(key_of(index)).or_default();
                profile.name = format!("m{index}-{step}");
                profile.manual_only = step % 2 == 1;
                shared.offers.insert(
                    format!("new_machine:m{index}-{step}"),
                    OfferDismissal { state: OfferDismissalState::Later, fingerprint: format!("f{step}") },
                );
                if index == 0 {
                    shared.defaults.insert(ProviderKind::ClaudeCode, key_of(step % count));
                }
                Some((next, ()))
            })
            .unwrap();
        state.network.wake();
        tokio::task::yield_now().await;
    }
}

async fn converge_under_concurrent_edits(names: &[&str]) {
    let specs: Vec<NodeSpec> = names.iter().map(|name| NodeSpec::owner(name)).collect();
    let Some(cluster) = Cluster::new(&specs) else { return };
    let mut nodes = Vec::new();
    for name in names {
        nodes.push(cluster.start(name, true).await);
    }
    let others: Vec<&Node> = nodes[1..].iter().collect();
    cluster.form(&nodes[0], &others, JoinVia::Auto).await;
    for (index, first) in nodes.iter().enumerate() {
        for second in &nodes[index + 1..] {
            both_heard(first, second).await;
        }
    }
    let count = nodes.len();
    for (index, node) in nodes.iter().enumerate() {
        add_accounts(node, index, count);
    }
    let same = |nodes: &[Node]| {
        nodes.windows(2).all(|pair| pair[0].state.settings.get().accounts_shared == pair[1].state.settings.get().accounts_shared)
    };
    // Every machine has made its first sealing (its import) and heard every other's: an edit made before that is part
    // of the machine's import, at clock zero, and may lose to another machine's import by design.
    eventually("every machine imported its accounts and heard the others", WAIT, || {
        same(&nodes)
            && nodes[0].state.settings.get().accounts_shared.profiles.len() == count
            && nodes.iter().all(|node| {
                let heard = super::accounts_sync::all_holdings(&node.state);
                nodes.iter().all(|other| heard.contains_key(&other.id()))
            })
    })
    .await;

    // Every machine edits at once, while extra passes run between every pair on top of the background workers.
    let stop = Arc::new(AtomicBool::new(false));
    let mut syncing = Vec::new();
    for node in &nodes {
        for other in &nodes {
            if node.name == other.name {
                continue;
            }
            let (state, link, stop) = (node.state.clone(), node.state.network.peers.link(&other.id()).unwrap(), stop.clone());
            syncing.push(tokio::spawn(async move {
                while !stop.load(Ordering::SeqCst) {
                    super::accounts_sync::sync(&state, &link).await;
                    tokio::task::yield_now().await;
                }
            }));
        }
    }
    let edits: Vec<_> = nodes.iter().enumerate().map(|(index, node)| tokio::spawn(edit(node.state.clone(), index, count))).collect();
    for edit in edits {
        edit.await.unwrap();
    }
    stop.store(true, Ordering::SeqCst);
    for task in syncing {
        task.await.unwrap();
    }

    let expected = expected_after_edits(count);
    let deadline = tokio::time::Instant::now() + WAIT;
    while !(same(&nodes) && expected(&nodes[0].state.settings.get().accounts_shared)) {
        if tokio::time::Instant::now() >= deadline {
            let held: Vec<String> = nodes
                .iter()
                .map(|node| {
                    let shared = node.state.settings.get().accounts_shared;
                    let names: Vec<String> = (0..count)
                        .map(|index| shared.profiles.get(&key_of(index)).map_or("-".into(), |p| format!("{}/{}", p.name, p.manual_only)))
                        .collect();
                    let missing: Vec<String> = (0..count)
                        .flat_map(|index| (0..STEPS).map(move |step| format!("new_machine:m{index}-{step}")))
                        .filter(|id| !shared.offers.contains_key(id))
                        .collect();
                    format!(
                        "{}: profiles {names:?} default {:?} missing dismissals {missing:?}",
                        node.name,
                        shared.defaults.get(&ProviderKind::ClaudeCode)
                    )
                })
                .collect();
            panic!("the machines did not converge on every last edit (same: {}):\n{}", same(&nodes), held.join("\n"));
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    // The local default follows the shared one on every machine.
    for (index, node) in nodes.iter().enumerate() {
        let local = node.state.settings.get().providers[&ProviderKind::ClaudeCode].default_account.clone();
        assert_eq!(local, Some(format!("n{index}k{}", (STEPS - 1) % count)), "{}", node.name);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_machines_converge_while_both_edit_shared_accounts() {
    converge_under_concurrent_edits(&["a", "b"]).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn three_machines_converge_while_all_edit_shared_accounts() {
    converge_under_concurrent_edits(&["a", "b", "c"]).await;
}

/// The desktop writes the whole settings document it read (`settings.get`, then `settings.update`). Another machine's
/// rename that arrived in between must survive that write.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_desktop_write_from_an_older_read_keeps_another_machines_edit() {
    let Some(cluster) = Cluster::new(&[NodeSpec::owner("a"), NodeSpec::owner("b")]) else { return };
    let a = cluster.start("a", true).await;
    let b = cluster.start("b", true).await;
    cluster.form(&a, &[&b], JoinVia::Auto).await;
    both_heard(&a, &b).await;
    add_accounts(&a, 0, 1);
    add_accounts(&b, 1, 1);
    sync_both(&a, &b).await;
    sync_both(&a, &b).await;
    eventually("one shared set", WAIT, || a.state.settings.get().accounts_shared == b.state.settings.get().accounts_shared).await;

    let desktop = desktop(&a).await;
    let read = desktop.call::<SettingsGet>(Empty {}).await.unwrap();
    // b renames the account; a takes it in.
    b.state
        .settings
        .update(|settings| {
            let mut next = settings.clone();
            next.accounts_shared.profiles.get_mut(&key_of(0)).unwrap().name = "Renamed on b".into();
            Some((next, ()))
        })
        .unwrap();
    sync_both(&a, &b).await;
    assert_eq!(a.state.settings.get().accounts_shared.profiles[&key_of(0)].name, "Renamed on b");
    // The desktop on a dismisses an offer, writing the document it read before the rename arrived.
    let mut stale = read.clone();
    stale
        .accounts_shared
        .offers
        .insert("new_machine:desktop".into(), OfferDismissal { state: OfferDismissalState::Never, fingerprint: "f".into() });
    // As the desktop and the phone send it: the document they edited, with the one it was made from.
    desktop.call_raw(SettingsUpdate::NAME, json!({"settings": stale, "base": read})).await.unwrap();
    sync_both(&a, &b).await;
    sync_both(&a, &b).await;
    for node in [&a, &b] {
        let shared = node.state.settings.get().accounts_shared;
        assert!(shared.offers.contains_key("new_machine:desktop"), "{}: the dismissal arrived", node.name);
        assert_eq!(shared.profiles[&key_of(0)].name, "Renamed on b", "{}: b's rename was undone", node.name);
    }
}

// ---- 7. a lender for new setups (the lender lane's contract) ----

/// A week of history in `observer`'s record of who was online (`online.rs`): `observer` itself every slot, `machine`
/// in the share of slots each `byte` of the bitmap marks (`ff` every slot, `01` one in eight). The workers keep marking
/// the current slot, so the write is repeated until `online::ratio` reads it back.
async fn week_of(observer: &Node, machine: &Node, byte: &str, ratio: impl Fn(f32) -> bool) {
    let deadline = tokio::time::Instant::now() + WAIT;
    loop {
        let now = chrono::Utc::now().timestamp().div_euclid(15 * 60);
        let track = |byte: &str| json!({"last": now, "since": now - super::online::SLOTS + 1, "bits": byte.repeat(84)});
        let mut tracks: serde_json::Map<String, Value> = observer
            .state
            .store
            .meta_get("network.online.v1")
            .unwrap()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        tracks.insert(observer.id(), track("ff"));
        tracks.insert(machine.id(), track(byte));
        observer.state.store.meta_set("network.online.v1", &Value::Object(tracks).to_string()).unwrap();
        if super::online::ratio(&observer.state.store, &machine.id(), &observer.id(), chrono::Utc::now()).is_some_and(&ratio) {
            return;
        }
        assert!(tokio::time::Instant::now() < deadline, "the online history never read back");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs the lender lane (0b325d869 + its daemon side): passes on origin/fix/claude-terminal-email at 207b5db9f"]
async fn a_legacy_lender_that_is_not_always_on_is_not_used_for_new_setups() {
    let Some(cluster) = Cluster::new(&[NodeSpec::owner("a"), NodeSpec::owner("b"), NodeSpec::owner("c")]) else { return };
    let a = cluster.start("a", true).await;
    let b = cluster.start("b", true).await;
    let c = cluster.start("c", true).await;
    // No harness here reads the computer's real logins.
    let fakes: Vec<Fakes> = [&a, &b, &c].iter().map(|node| Fakes::new(&format!("lender-{}", node.name))).collect();
    for (node, fake) in [&a, &b, &c].iter().zip(&fakes) {
        fake.install(&node.state);
    }
    cluster.form(&a, &[&b, &c], JoinVia::Auto).await;
    both_heard(&b, &c).await;
    // The lender chosen before 0.27.2 is c, a laptop that is online an eighth of the time.
    let op = a.membership().set("broker", json!(c.id())).unwrap();
    a.state.network.publish_ops(vec![op]);
    eventually("the lender register reaches b", WAIT, || b.membership().projection().broker() == Some(c.id().as_str())).await;
    week_of(&b, &c, "01", |ratio| ratio < 0.2).await;
    let status = desktop(&b).await.call_raw(LoginBrokerStatusMethod::NAME, json!({})).await.unwrap();
    assert_eq!(status["lender"]["machine_id"], json!(c.id()), "{status}");
    assert_eq!(status["lender"]["usable_for_new"], json!(false), "{status}");
    assert!(status["lender"]["reason"].as_str().is_some_and(|reason| !reason.is_empty()), "{status}");
    // Online all week, the same lender is used for new setups.
    week_of(&b, &c, "ff", |ratio| ratio > 0.99).await;
    let status = desktop(&b).await.call_raw(LoginBrokerStatusMethod::NAME, json!({})).await.unwrap();
    assert_eq!(status["lender"]["usable_for_new"], json!(true), "{status}");
    assert!(status["lender"].get("reason").is_none_or(Value::is_null), "{status}");
}

// ---- 8. one-click update keeps machines in step (the update lane's contract) ----

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs the update lane (b02f1f83b): passes on origin/fix/claude-terminal-email at 207b5db9f"]
async fn a_following_machine_updates_despite_a_stuck_queue_and_auto_update_off() {
    let Some(cluster) = Cluster::new(&[NodeSpec::owner("a"), NodeSpec::owner("b")]) else { return };
    let a = cluster.start("a", true).await;
    let b = cluster.start("b", true).await;
    let fakes = Fakes::new("follow-b");
    fakes.install(&b.state);
    cluster.form(&a, &[&b], JoinVia::Auto).await;
    both_heard(&a, &b).await;
    // b does not update itself, and a message queued on a thread that then moved to another machine can never be sent.
    let mut settings = b.state.settings.get();
    settings.auto_update_daemon = false;
    b.state.settings.set(settings).unwrap();
    b.state.daemon_updates.allow_development.store(true, Ordering::SeqCst);
    let folder = b.root.join("project");
    std::fs::create_dir_all(&folder).unwrap();
    let project = b.state.orchestrator.add_project(folder.to_string_lossy().into_owned(), Some("Moved".into()), None).unwrap();
    let thread = desktop(&b)
        .await
        .call::<ThreadsCreate>(ThreadsCreateParams {
            pin_account: false,
            project_id: Some(project.id),
            provider: ProviderInstance::default_for(ProviderKind::ClaudeCode),
            model: None,
            effort: None,
            permission_mode: None,
            use_worktree: Some(false),
            base_branch: None,
            title: Some("Moved".into()),
            message: None,
            thread_id: None,
            message_id: None,
            members: None,
            base_branches: None,
        })
        .await
        .unwrap();
    let message = QueuedMessage { id: uuid::Uuid::now_v7(), thread_id: thread.id, message: UserMessage::text("hello") };
    b.state.orchestrator.emit(thread.id, None, EventPayload::MessageQueued { message }).unwrap();
    let moved: MoveInfo =
        serde_json::from_value(json!({"state": "departed", "peer": a.id(), "operation_id": uuid::Uuid::now_v7()})).unwrap();
    b.state.store.thread_set_moved(thread.id, Some(&moved)).unwrap();
    assert_eq!(b.state.store.queue_list(None).unwrap().len(), 1);
    // "Keep all machines on the same version", and a runs a newer one.
    let op = a.membership().set("follow_updates", json!(true)).unwrap();
    a.state.network.publish_ops(vec![op]);
    eventually("b follows updates", WAIT, || b.membership().projection().follow_updates()).await;
    let mut newer = a.state.network.presence();
    newer.version = "99.0.0".into();
    b.state.network.peers.set_presence(&a.id(), newer);
    assert_eq!(super::updates::follow_tick(&b.state).await.as_deref(), Some("99.0.0"));
}
