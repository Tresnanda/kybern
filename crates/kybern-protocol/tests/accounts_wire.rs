//! The account answers on the wire, as golden JSON the desktop's tests read back.
//!
//! 0.27.0 crashed rendering an offer whose `keys` and `machines` the daemon left out when they were empty: the Rust
//! types and the TypeScript that reads them disagreed, and no test fed one into the other. These fixtures are the
//! real serialization of every account shape a client receives (offers of every kind; terminal, named, borrowed and
//! signed-out accounts; a thread's target state; the account events; the login broker's status; a sign-in with a
//! handoff). `packages/kybern-client/tests/accounts-wire.test.mjs` and `apps/gpuix/src/accounts/e2e.test.ts` load the
//! same files and run them through the clients' code.
//!
//! A change to these types changes the JSON and fails here. Regenerate deliberately, then run the client tests:
//! `KYBERN_UPDATE_FIXTURES=1 cargo test -p kybern-protocol --test accounts_wire`.

use std::path::PathBuf;

use kybern_protocol::ThreadEvent;
use kybern_protocol::login_broker::LoginBrokerStatus;
use kybern_protocol::methods::*;
use serde::Serialize;
use serde_json::{Value, json};

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/kybern-client/tests/fixtures/accounts-wire")
}

/// Compare `value` with the fixture `name`, or write it when regenerating.
fn golden(name: &str, value: &impl Serialize) -> Option<String> {
    let path = dir().join(format!("{name}.json"));
    let made = serde_json::to_value(value).unwrap();
    if std::env::var_os("KYBERN_UPDATE_FIXTURES").is_some() {
        std::fs::create_dir_all(dir()).unwrap();
        std::fs::write(&path, format!("{}\n", serde_json::to_string_pretty(&made).unwrap())).unwrap();
        return None;
    }
    let saved: Value = match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap(),
        Err(_) => return Some(format!("{name}: no fixture at {}", path.display())),
    };
    (saved != made).then(|| {
        format!("{name}: the wire shape changed.\n saved: {saved}\n now:   {made}\nRegenerate deliberately with KYBERN_UPDATE_FIXTURES=1.")
    })
}

// The values are written as JSON a daemon could send and read through the real types, so a field another version adds
// takes its default here instead of breaking this file; what is compared is what the Rust serializer writes back.
fn real<T: serde::de::DeserializeOwned>(value: Value) -> T {
    serde_json::from_value(value).unwrap()
}

const AT: &str = "2026-11-27T14:00:00Z";

fn offers() -> AccountsOffersResult {
    let work = "claude-code:work@example.com";
    let home = "claude-code:me@home.org";
    let offer = |id: &str, kind: &str, machine: &str, more: Value| {
        let mut offer = json!({"id": id, "kind": kind, "fingerprint": format!("fp-{id}"), "machine_id": machine, "machine_name": machine});
        offer.as_object_mut().unwrap().extend(more.as_object().unwrap().clone());
        offer
    };
    real(json!({"offers": [
        offer("always_on:m-vps", "always_on", "m-vps", json!({"keys": [work], "machines": ["m-mac", "m-pc"]})),
        offer("new_machine:m-pc", "new_machine", "m-pc", json!({"keys": [work, home], "machines": ["m-mac"]})),
        // No accounts and no machines: what 0.27.0 left out of the JSON.
        offer("terminal_login:m-pc:claude-code", "terminal_login", "m-pc", json!({"provider": "claude-code"})),
        offer("clash:claude-code:m-pc", "migration_clash", "m-pc", json!({
            "provider": "claude-code",
            "clash": {"kind": "claude-code", "machine_id": "m-pc", "was": home, "now": work},
            "dismissed": "later",
        })),
    ]}))
}

fn row(kind: &str, instance: &str, status: &str, more: Value) -> Value {
    let mut row = json!({"provider": {"kind": kind, "instance": instance}, "name": instance, "status": status, "is_default": false});
    row.as_object_mut().unwrap().extend(more.as_object().unwrap().clone());
    row
}

/// One machine's `providers.accounts.list`: every kind of row the desktop draws.
fn accounts() -> AccountsListResult {
    let identity = |email: &str, plan: &str| json!({"email": email, "plan": plan});
    real(json!({"accounts": [
        // The terminal login whose email came from `~/.claude.json` (a Keychain login, #107).
        row("claude-code", "default", "signed_in", json!({
            "name": "CLI account", "identity": {"email": "work@example.com", "plan": "Max", "organization": "Work Inc"},
            "is_default": true, "can_sign_out": true, "key": "claude-code:work@example.com", "terminal": true,
        })),
        // A named account with its own folder.
        row("claude-code", "p1", "signed_in", json!({
            "name": "Personal", "color": "teal", "identity": identity("me@home.org", "Pro"), "projects": ["/home/me/code/site"],
            "directory": "/home/me/.kybern/accounts/claude-code/p1", "managed": true, "can_sign_out": true, "key": "claude-code:me@home.org",
        })),
        // Borrowed from the VPS, which answers.
        row("claude-code", "b1", "signed_in", json!({
            "name": "Via VPS", "identity": identity("shared@example.com", "Max"), "directory": "/home/me/.kybern/accounts/claude-code/b1",
            "managed": true, "key": "claude-code:shared@example.com",
            "broker": {"machine_id": "m-vps", "machine_name": "VPS", "broker_account": "s1", "state": "borrowing"},
        })),
        // Borrowed from a lender that does not answer.
        row("claude-code", "b2", "unknown", json!({
            "name": "Via PC", "directory": "/home/me/.kybern/accounts/claude-code/b2", "managed": true,
            "broker": {"machine_id": "m-pc", "machine_name": "PC", "broker_account": "x", "state": "broker_offline",
                "message": "Signs in through PC, which is offline · Sign in here instead"},
        })),
        // A named account that was signed out: it still names the account it was.
        row("claude-code", "o1", "signed_out", json!({
            "name": "Old", "identity": identity("old@example.com", "Pro"), "directory": "/home/me/.kybern/accounts/claude-code/o1",
            "managed": true, "key": "claude-code:old@example.com",
        })),
        // Another harness' terminal login, signed out with no account to name.
        row("codex", "default", "signed_out", json!({"name": "CLI account", "terminal": true})),
        // An Antigravity named account next to the computer's own login.
        row("antigravity", "g1", "signed_in", json!({
            "name": "Second", "identity": identity("second@example.com", "Pro"), "directory": "/home/me/.kybern/accounts/antigravity/g1",
            "managed": true, "can_sign_out": true, "key": "antigravity:second@example.com",
        })),
        row("antigravity", "default", "unknown", json!({"name": "CLI account", "terminal": true})),
    ]}))
}

fn targets() -> Vec<ThreadTargetState> {
    let state = |instance: &str, more: Value| {
        let mut state = json!({
            "target": {"provider": {"kind": "claude-code", "instance": instance}, "model": "opus"},
            "account_override": false, "effective_permission_mode": "supervised",
        });
        state.as_object_mut().unwrap().extend(more.as_object().unwrap().clone());
        state
    };
    real(json!([
        state("default", json!({"native_session_id": "native-1"})),
        state("b2", json!({"account_override": true, "account_unavailable": true, "suggested_account": "p1"})),
        state(
            "default",
            json!({
                "quota_limited": true, "suggested_account": "p1", "waiting_until": "2026-11-27T15:00:00Z",
                "waiting_account": {"kind": "claude-code", "instance": "default"}, "pending_permission_mode": "accept-edits",
            })
        ),
    ]))
}

fn events() -> Vec<ThreadEvent> {
    let instance = |id: &str| json!({"kind": "claude-code", "instance": id});
    let event = |seq: u64, payload: Value| {
        let mut event = json!({"seq": seq, "thread_id": "019c0000-0000-7000-8000-000000000001", "at": AT});
        event.as_object_mut().unwrap().extend(payload.as_object().unwrap().clone());
        event
    };
    real(json!([
        event(
            1,
            json!({"kind": "account_switched", "from": instance("default"), "to": instance("p1"), "reason": "limit", "text": "Switched to Personal"})
        ),
        event(
            2,
            json!({"kind": "account_switched", "from": instance("b2"), "to": instance("default"), "reason": "unavailable", "text": "Switched to CLI account"})
        ),
        event(
            3,
            json!({"kind": "account_wait", "until": "2026-11-27T15:00:00Z", "account": instance("default"), "text": "Waiting until 15:00"})
        ),
        event(4, json!({"kind": "account_wait_ended", "account": instance("default"), "cancelled": false, "text": "Continued at 15:00"})),
        event(5, json!({"kind": "account_wait", "until": "2026-11-27T16:00:00Z"})),
        event(6, json!({"kind": "account_wait_ended", "cancelled": true})),
    ]))
}

fn broker() -> Vec<LoginBrokerStatus> {
    let lendable = json!({"provider": "claude-code", "account": "s1", "name": "Shared", "email": "shared@example.com", "plan": "Max"});
    let vps = json!({"machine_id": "m-vps", "name": "VPS", "reachable": true});
    real(json!([
        // No broker at all.
        {"providers": []},
        // A member that borrows Claude and has nothing for Codex.
        {"broker": vps, "providers": [
            {"provider": "claude-code", "state": "borrowing", "local_account": "b1", "broker_account": "s1", "lendable": [lendable], "sessions": 2},
            {"provider": "codex", "state": "broker_not_signed_in", "message": "Codex isn't signed in on VPS yet"},
        ]},
        // A lender that is offline.
        {"broker": {"machine_id": "m-pc", "reachable": false}, "providers": [
            {"provider": "claude-code", "state": "broker_offline", "local_account": "b2", "broker_account": "x"},
        ]},
        // The broker itself, with a loan.
        {"broker": vps, "is_broker": true, "providers": [
            {"provider": "claude-code", "state": "lending", "broker_account": "s1", "lendable": [lendable]},
        ], "loans": [{"loan_id": "loan-1", "machine_id": "m-mac", "provider": "claude-code", "account": "s1",
            "created_at": "2026-11-27T09:00:00Z", "last_pushed_at": "2026-11-27T10:00:00Z"}]},
    ]))
}

fn logins() -> Vec<AccountLogin> {
    let login = |id: &str, mode: &str, phase: &str, more: Value| {
        let mut login = json!({"id": id, "kind": "claude-code", "mode": mode, "phase": phase, "expires_at": "2026-11-27T18:00:00Z"});
        login.as_object_mut().unwrap().extend(more.as_object().unwrap().clone());
        login
    };
    real(json!([
        // A browser sign-in on another machine waiting for its loopback redirect: the handoff.
        login(
            "l-handoff",
            "browser",
            "waiting",
            json!({
                "url": "https://claude.com/cai/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A54321%2Fcallback&state=abc",
                "handoff": {"port": 54321, "path": "/callback"},
            })
        ),
        login(
            "l-done",
            "paste",
            "signed_in",
            json!({"identity": {"email": "me@home.org", "plan": "Pro"}, "suggested_name": "Home", "suggested_color": "blue"})
        ),
        login(
            "l-failed",
            "terminal",
            "failed",
            json!({
                "kind": "antigravity", "instance": "default", "error": "Antigravity stopped before signing in. Try again, or show the terminal.",
            })
        ),
        login(
            "l-duplicate",
            "browser",
            "signed_in",
            json!({"identity": {"email": "work@example.com", "plan": "Max"}, "duplicate_of": "default"})
        ),
    ]))
}

#[test]
fn account_answers_keep_the_wire_shape_the_clients_read() {
    let problems: Vec<String> = [
        golden("offers", &offers()),
        golden("accounts-list", &accounts()),
        golden("thread-target", &targets()),
        golden("account-events", &events()),
        golden("login-broker-status", &broker()),
        golden("account-logins", &logins()),
    ]
    .into_iter()
    .flatten()
    .collect();
    assert!(problems.is_empty(), "{}", problems.join("\n\n"));
}

/// The bug 0.27.0 shipped, said directly: an offer without accounts still carries both lists.
#[test]
fn an_offer_without_accounts_still_sends_keys_and_machines() {
    let terminal = &serde_json::to_value(offers()).unwrap()["offers"][2];
    assert_eq!(terminal["kind"], "terminal_login");
    assert_eq!(terminal["keys"], json!([]), "{terminal}");
    assert_eq!(terminal["machines"], json!([]), "{terminal}");
}
