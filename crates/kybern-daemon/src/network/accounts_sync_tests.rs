//! Accounts across machines on the in-process multi-daemon harness: two machines that each had their own
//! accounts end up with one shared set, a rename on one reaches the other, and each machine's holdings
//! reach the other's offers. They skip on a computer without the `127.x.0.n` loopback aliases.

use kybern_protocol::methods::{AccountOfferKind, AccountStatus, AccountSummary};
use kybern_protocol::*;

use super::harness::*;

fn add_account(node: &Node, id: &str, name: &str, email: &str, default: bool) {
    let mut settings = node.state.settings.get();
    let claude = settings.providers.entry(ProviderKind::ClaudeCode).or_default();
    claude.accounts.insert(
        id.into(),
        ProviderAccount {
            name: name.into(),
            directory: node.state.settings.dir().join("accounts").join(id).to_string_lossy().into_owned(),
            color: Some("blue".into()),
            email: Some(email.into()),
            plan: None,
        },
    );
    if default {
        claude.default_account = Some(id.into());
    }
    node.state.settings.set(settings).unwrap();
}

fn summary(id: &str, email: &str) -> AccountSummary {
    AccountSummary {
        provider: ProviderInstance { kind: ProviderKind::ClaudeCode, instance: id.into() },
        name: id.into(),
        color: None,
        identity: None,
        status: AccountStatus::SignedIn,
        is_default: false,
        projects: vec![],
        directory: None,
        managed: true,
        can_sign_out: true,
        broker: None,
        key: Some(crate::accounts_shared::key(ProviderKind::ClaudeCode, email)),
        terminal: false,
    }
}

async fn sync_both(a: &Node, b: &Node) {
    let link = a.state.network.peers.link(&b.id()).expect("a link to b");
    super::accounts_sync::sync(&a.state, &link).await;
    let link = b.state.network.peers.link(&a.id()).expect("a link to a");
    super::accounts_sync::sync(&b.state, &link).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_machines_end_with_one_set_of_accounts_and_edits_travel() {
    let Some(cluster) = Cluster::new(&[NodeSpec::owner("a"), NodeSpec::owner("b")]) else { return };
    let a = cluster.start("a", true).await;
    let b = cluster.start("b", true).await;
    cluster.form(&a, &[&b], JoinVia::Auto).await;
    eventually("linked", WAIT, || linked(&a, &b)).await;

    // Each machine had its own accounts. The same email is one account; each chose its own default.
    add_account(&a, "w1", "Work", "work@example.com", true);
    add_account(&b, "x9", "Job", "Work@Example.com", false);
    add_account(&b, "p1", "Personal", "me@home.org", true);
    sync_both(&a, &b).await;
    eventually("one shared set", WAIT, || a.state.settings.get().accounts_shared == b.state.settings.get().accounts_shared).await;
    let shared = a.state.settings.get().accounts_shared;
    assert_eq!(shared.profiles.len(), 2);
    let default = shared.defaults[&ProviderKind::ClaudeCode].clone();
    // Each machine runs its own login for the shared default.
    let expect = |node: &Node, work: &str, personal: Option<&str>| {
        let provider = node.state.settings.get().providers[&ProviderKind::ClaudeCode].clone();
        let local = crate::provider_accounts::resolve(&provider, None, None);
        if default == "claude-code:work@example.com" {
            assert_eq!(local, work);
        } else if let Some(personal) = personal {
            assert_eq!(local, personal);
        }
    };
    expect(&a, "w1", None);
    expect(&b, "x9", Some("p1"));
    // The same account has the same name on both machines.
    let name_a = a.state.settings.get().providers[&ProviderKind::ClaudeCode].accounts["w1"].name.clone();
    let name_b = b.state.settings.get().providers[&ProviderKind::ClaudeCode].accounts["x9"].name.clone();
    assert_eq!(name_a, name_b);

    // A rename on one machine reaches the other, and so does a dismissal.
    let mut settings = b.state.settings.get();
    settings.providers.get_mut(&ProviderKind::ClaudeCode).unwrap().accounts.get_mut("x9").unwrap().name = "Office".into();
    settings
        .accounts_shared
        .offers
        .insert("new_machine:x".into(), OfferDismissal { state: OfferDismissalState::Never, fingerprint: "f".into() });
    b.state.settings.set(settings).unwrap();
    sync_both(&a, &b).await;
    eventually("the rename arrives", WAIT, || a.state.settings.get().providers[&ProviderKind::ClaudeCode].accounts["w1"].name == "Office")
        .await;
    assert!(a.state.settings.get().accounts_shared.offers.contains_key("new_machine:x"));

    // The default chosen on a reaches b, mapped to b's own login, even when a pass that read a's settings
    // just before the choice ends after it.
    let mut settings = a.state.settings.get();
    settings.accounts_shared.defaults.insert(ProviderKind::ClaudeCode, "claude-code:work@example.com".into());
    super::accounts_sync::observe_now(&a.state).unwrap();
    a.state.settings.set(settings).unwrap();
    super::accounts_sync::merge_now(&a.state, &[]).unwrap();
    assert_eq!(a.state.settings.get().accounts_shared.defaults[&ProviderKind::ClaudeCode], "claude-code:work@example.com");
    sync_both(&a, &b).await;
    eventually("b follows the default", WAIT, || {
        b.state.settings.get().providers[&ProviderKind::ClaudeCode].default_account.as_deref() == Some("x9")
    })
    .await;

    // What b holds reaches a, so a's offers know that b lacks nothing a has and a lacks b's Personal account.
    super::accounts_sync::publish_holdings(&b.state, &[summary("x9", "work@example.com"), summary("p1", "me@home.org")]);
    super::accounts_sync::publish_holdings(&a.state, &[summary("w1", "work@example.com")]);
    sync_both(&a, &b).await;
    eventually("b's holdings reach a", WAIT, || {
        super::accounts_sync::all_holdings(&a.state).get(&b.id()).is_some_and(|h| h.accounts.len() == 2)
    })
    .await;
    let offers = crate::accounts_offers::offers(&a.state).offers;
    let new =
        offers.iter().find(|offer| offer.kind == AccountOfferKind::NewMachine && offer.machine_id == a.id()).expect("a lacks Personal");
    assert_eq!(new.keys, vec!["claude-code:me@home.org"]);
    assert_eq!(new.machines, vec![b.id()]);
    assert!(!offers.iter().any(|offer| offer.kind == AccountOfferKind::NewMachine && offer.machine_id == b.id()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_machine_cannot_sign_another_machines_holdings() {
    let Some(cluster) = Cluster::new(&[NodeSpec::owner("a"), NodeSpec::owner("b")]) else { return };
    let a = cluster.start("a", true).await;
    let b = cluster.start("b", true).await;
    cluster.form(&a, &[&b], JoinVia::Auto).await;
    eventually("linked", WAIT, || linked(&a, &b)).await;
    // a seals a register claiming to be b's holdings and sends it.
    let forged = super::spaces::seal(
        a.membership(),
        99,
        format!("holdings:{}", b.id()),
        "account",
        serde_json::json!({"accounts": [{"kind": "claude-code", "instance": "evil", "status": "signed_in"}]}),
    )
    .unwrap();
    let params = PeerSpacesSyncParams { digest: String::new(), ids: vec![], fields: vec![forged] };
    super::accounts_sync::serve(&b.state, params).await.unwrap();
    let registers = b.state.store.meta_get("network.accounts.v1").unwrap().unwrap_or_default();
    assert!(!registers.contains("evil"), "a forged holdings register is dropped");
}
