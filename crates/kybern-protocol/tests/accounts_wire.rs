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

use chrono::{DateTime, TimeZone, Utc};
use kybern_protocol::methods::*;
use kybern_protocol::*;
use serde::Serialize;
use serde_json::{Value, json};

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/kybern-client/tests/fixtures/accounts-wire")
}

fn at(hour: u32) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 11, 27, hour, 0, 0).unwrap()
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

const WORK: &str = "claude-code:work@example.com";
const HOME: &str = "claude-code:me@home.org";

fn offers() -> AccountsOffersResult {
    let offer = |id: &str, kind, machine: &str| AccountOffer {
        id: id.into(),
        kind,
        fingerprint: format!("fp-{id}"),
        machine_id: machine.into(),
        machine_name: machine.into(),
        provider: None,
        keys: vec![],
        machines: vec![],
        clash: None,
        dismissed: None,
    };
    AccountsOffersResult {
        offers: vec![
            AccountOffer {
                keys: vec![WORK.into()],
                machines: vec!["m-mac".into(), "m-pc".into()],
                ..offer("always_on:m-vps", AccountOfferKind::AlwaysOn, "m-vps")
            },
            AccountOffer {
                keys: vec![WORK.into(), HOME.into()],
                machines: vec!["m-mac".into()],
                ..offer("new_machine:m-pc", AccountOfferKind::NewMachine, "m-pc")
            },
            // No accounts and no machines: what 0.27.0 left out of the JSON.
            AccountOffer {
                provider: Some(ProviderKind::ClaudeCode),
                ..offer("terminal_login:m-pc:claude-code", AccountOfferKind::TerminalLogin, "m-pc")
            },
            AccountOffer {
                provider: Some(ProviderKind::ClaudeCode),
                clash: Some(AccountClash { kind: ProviderKind::ClaudeCode, machine_id: "m-pc".into(), was: HOME.into(), now: WORK.into() }),
                dismissed: Some(OfferDismissalState::Later),
                ..offer("clash:claude-code:m-pc", AccountOfferKind::MigrationClash, "m-pc")
            },
        ],
    }
}

fn summary(instance: &str, status: AccountStatus) -> AccountSummary {
    AccountSummary {
        provider: ProviderInstance { kind: ProviderKind::ClaudeCode, instance: instance.into() },
        name: instance.into(),
        color: None,
        identity: None,
        status,
        is_default: false,
        projects: vec![],
        directory: None,
        managed: false,
        can_sign_out: false,
        broker: None,
        key: None,
        terminal: false,
    }
}

fn identity(email: &str, plan: &str) -> Option<AccountIdentity> {
    Some(AccountIdentity { email: Some(email.into()), plan: Some(plan.into()), organization: None })
}

/// One machine's `providers.accounts.list`: every kind of row the desktop draws.
fn accounts() -> AccountsListResult {
    AccountsListResult {
        accounts: vec![
            // The terminal login whose email came from `~/.claude.json` (a Keychain login, #107).
            AccountSummary {
                name: "CLI account".into(),
                identity: Some(AccountIdentity {
                    email: Some("work@example.com".into()),
                    plan: Some("Max".into()),
                    organization: Some("Work Inc".into()),
                }),
                is_default: true,
                can_sign_out: true,
                key: Some(WORK.into()),
                terminal: true,
                ..summary("default", AccountStatus::SignedIn)
            },
            // A named account with its own folder.
            AccountSummary {
                name: "Personal".into(),
                color: Some("teal".into()),
                identity: identity("me@home.org", "Pro"),
                projects: vec!["/home/me/code/site".into()],
                directory: Some("/home/me/.kybern/accounts/claude-code/p1".into()),
                managed: true,
                can_sign_out: true,
                key: Some(HOME.into()),
                ..summary("p1", AccountStatus::SignedIn)
            },
            // Borrowed from the VPS, which answers.
            AccountSummary {
                name: "Via VPS".into(),
                identity: identity("shared@example.com", "Max"),
                directory: Some("/home/me/.kybern/accounts/claude-code/b1".into()),
                managed: true,
                broker: Some(AccountBroker {
                    machine_id: "m-vps".into(),
                    machine_name: "VPS".into(),
                    broker_account: "s1".into(),
                    state: BrokerLoginState::Borrowing,
                    message: None,
                }),
                key: Some("claude-code:shared@example.com".into()),
                ..summary("b1", AccountStatus::SignedIn)
            },
            // Borrowed from a lender that does not answer.
            AccountSummary {
                name: "Via PC".into(),
                directory: Some("/home/me/.kybern/accounts/claude-code/b2".into()),
                managed: true,
                broker: Some(AccountBroker {
                    machine_id: "m-pc".into(),
                    machine_name: "PC".into(),
                    broker_account: "x".into(),
                    state: BrokerLoginState::BrokerOffline,
                    message: Some("Signs in through PC, which is offline · Sign in here instead".into()),
                }),
                ..summary("b2", AccountStatus::Unknown)
            },
            // A named account that was signed out: it still names the account it was.
            AccountSummary {
                name: "Old".into(),
                identity: identity("old@example.com", "Pro"),
                directory: Some("/home/me/.kybern/accounts/claude-code/o1".into()),
                managed: true,
                key: Some("claude-code:old@example.com".into()),
                ..summary("o1", AccountStatus::SignedOut)
            },
            // Another harness' terminal login, signed out with no account to name.
            AccountSummary {
                provider: ProviderInstance { kind: ProviderKind::Codex, instance: "default".into() },
                name: "CLI account".into(),
                terminal: true,
                ..summary("default", AccountStatus::SignedOut)
            },
            // An Antigravity named account next to the computer's own login.
            AccountSummary {
                provider: ProviderInstance { kind: ProviderKind::Antigravity, instance: "g1".into() },
                name: "Second".into(),
                identity: identity("second@example.com", "Pro"),
                directory: Some("/home/me/.kybern/accounts/antigravity/g1".into()),
                managed: true,
                can_sign_out: true,
                key: Some("antigravity:second@example.com".into()),
                ..summary("g1", AccountStatus::SignedIn)
            },
            AccountSummary {
                provider: ProviderInstance { kind: ProviderKind::Antigravity, instance: "default".into() },
                name: "CLI account".into(),
                terminal: true,
                ..summary("default", AccountStatus::Unknown)
            },
        ],
    }
}

fn targets() -> Vec<ThreadTargetState> {
    let target = |instance: &str| SessionTarget {
        provider: ProviderInstance { kind: ProviderKind::ClaudeCode, instance: instance.into() },
        model: Some("opus".into()),
        effort: None,
    };
    let state = |instance: &str| ThreadTargetState {
        target: target(instance),
        native_session_id: None,
        account_override: false,
        effective_permission_mode: PermissionMode::Supervised,
        pending_permission_mode: None,
        quota_limited: false,
        account_unavailable: false,
        suggested_account: None,
        waiting_until: None,
        waiting_account: None,
    };
    vec![
        ThreadTargetState { native_session_id: Some("native-1".into()), ..state("default") },
        ThreadTargetState { account_override: true, account_unavailable: true, suggested_account: Some("p1".into()), ..state("b2") },
        ThreadTargetState {
            quota_limited: true,
            suggested_account: Some("p1".into()),
            waiting_until: Some(at(15)),
            waiting_account: Some(ProviderInstance { kind: ProviderKind::ClaudeCode, instance: "default".into() }),
            pending_permission_mode: Some(PermissionMode::AcceptEdits),
            ..state("default")
        },
    ]
}

fn events() -> Vec<ThreadEvent> {
    let thread: ThreadId = serde_json::from_value(json!("019c0000-0000-7000-8000-000000000001")).unwrap();
    let instance = |id: &str| ProviderInstance { kind: ProviderKind::ClaudeCode, instance: id.into() };
    let event = |seq: u64, payload| ThreadEvent {
        seq: serde_json::from_value(json!(seq)).unwrap(),
        thread_id: thread.clone(),
        turn_id: None,
        at: at(14),
        payload,
    };
    vec![
        event(
            1,
            EventPayload::AccountSwitched {
                from: instance("default"),
                to: instance("p1"),
                reason: AccountSwitchReason::Limit,
                text: "Switched to Personal".into(),
            },
        ),
        event(
            2,
            EventPayload::AccountSwitched {
                from: instance("b2"),
                to: instance("default"),
                reason: AccountSwitchReason::Unavailable,
                text: "Switched to CLI account".into(),
            },
        ),
        event(3, EventPayload::AccountWait { until: at(15), account: Some(instance("default")), text: "Waiting until 15:00".into() }),
        event(4, EventPayload::AccountWaitEnded { account: Some(instance("default")), cancelled: false, text: "Continued at 15:00".into() }),
        event(5, EventPayload::AccountWait { until: at(16), account: None, text: String::new() }),
        event(6, EventPayload::AccountWaitEnded { account: None, cancelled: true, text: String::new() }),
    ]
}

fn broker() -> Vec<LoginBrokerStatus> {
    let lendable = LendableAccount {
        provider: ProviderKind::ClaudeCode,
        account: "s1".into(),
        name: "Shared".into(),
        email: Some("shared@example.com".into()),
        plan: Some("Max".into()),
    };
    vec![
        // No broker at all.
        LoginBrokerStatus::default(),
        // A member that borrows Claude and has nothing for Codex.
        LoginBrokerStatus {
            broker: Some(BrokerInfo { machine_id: "m-vps".into(), name: Some("VPS".into()), reachable: true }),
            is_broker: false,
            providers: vec![
                BrokerProviderStatus {
                    provider: ProviderKind::ClaudeCode,
                    state: BrokerLoginState::Borrowing,
                    local_account: Some("b1".into()),
                    broker_account: Some("s1".into()),
                    lendable: vec![lendable.clone()],
                    message: None,
                    sessions: 2,
                },
                BrokerProviderStatus {
                    provider: ProviderKind::Codex,
                    state: BrokerLoginState::BrokerNotSignedIn,
                    local_account: None,
                    broker_account: None,
                    lendable: vec![],
                    message: Some("Codex isn't signed in on VPS yet".into()),
                    sessions: 0,
                },
            ],
            loans: vec![],
        },
        // A lender that is offline.
        LoginBrokerStatus {
            broker: Some(BrokerInfo { machine_id: "m-pc".into(), name: None, reachable: false }),
            is_broker: false,
            providers: vec![BrokerProviderStatus {
                provider: ProviderKind::ClaudeCode,
                state: BrokerLoginState::BrokerOffline,
                local_account: Some("b2".into()),
                broker_account: Some("x".into()),
                lendable: vec![],
                message: None,
                sessions: 0,
            }],
            loans: vec![],
        },
        // The broker itself, with a loan.
        LoginBrokerStatus {
            broker: Some(BrokerInfo { machine_id: "m-vps".into(), name: Some("VPS".into()), reachable: true }),
            is_broker: true,
            providers: vec![BrokerProviderStatus {
                provider: ProviderKind::ClaudeCode,
                state: BrokerLoginState::Lending,
                local_account: None,
                broker_account: Some("s1".into()),
                lendable: vec![lendable],
                message: None,
                sessions: 0,
            }],
            loans: vec![BrokerLoanView {
                loan_id: "loan-1".into(),
                machine_id: "m-mac".into(),
                provider: ProviderKind::ClaudeCode,
                account: "s1".into(),
                created_at: at(9),
                last_pushed_at: Some(at(10)),
                last_error: None,
            }],
        },
    ]
}

fn logins() -> Vec<AccountLogin> {
    let login = |id: &str, mode, phase| AccountLogin {
        id: id.into(),
        kind: ProviderKind::ClaudeCode,
        instance: None,
        mode,
        phase,
        url: None,
        user_code: None,
        terminal: None,
        identity: None,
        suggested_name: None,
        suggested_color: None,
        duplicate_of: None,
        previous_email: None,
        error: None,
        expires_at: at(18),
        handoff: None,
    };
    vec![
        // A browser sign-in on another machine waiting for its loopback redirect: the handoff.
        AccountLogin {
            url: Some("https://claude.com/cai/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A54321%2Fcallback&state=abc".into()),
            handoff: Some(LoginHandoff { port: 54321, path: "/callback".into() }),
            ..login("l-handoff", AccountLoginMode::Browser, AccountLoginPhase::Waiting)
        },
        AccountLogin {
            identity: identity("me@home.org", "Pro"),
            suggested_name: Some("Home".into()),
            suggested_color: Some("blue".into()),
            ..login("l-done", AccountLoginMode::Paste, AccountLoginPhase::SignedIn)
        },
        AccountLogin {
            kind: ProviderKind::Antigravity,
            instance: Some("default".into()),
            error: Some("Antigravity stopped before signing in. Try again, or show the terminal.".into()),
            ..login("l-failed", AccountLoginMode::Terminal, AccountLoginPhase::Failed)
        },
        AccountLogin {
            identity: identity("work@example.com", "Max"),
            duplicate_of: Some("default".into()),
            ..login("l-duplicate", AccountLoginMode::Browser, AccountLoginPhase::SignedIn)
        },
    ]
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
