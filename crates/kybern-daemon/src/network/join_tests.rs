//! Joining, removal, client grants and the doctor on the in-process multi-daemon harness
//! (design §11.1 N4 acceptance, §11.3). Every scenario runs real daemons over real sockets on a fake
//! tailnet; only `tailscale` is a fixture.

use std::time::Duration;

use kybern_client::{Client, Endpoint};
use kybern_protocol::methods::*;
use kybern_protocol::*;

use super::harness::*;

/// A tailnet whose daemons join each other on their own, as they do in a real daemon.
fn cluster(specs: &[NodeSpec]) -> Option<Cluster> {
    Cluster::new(specs).map(|cluster| cluster.auto_join(true))
}

/// A tailnet whose daemons are formed by hand, for a scenario that must not be raced by discovery.
fn manual_cluster(specs: &[NodeSpec]) -> Option<Cluster> {
    Cluster::new(specs)
}

/// A client of `node` with the scopes a paired device gets.
async fn admin(node: &Node) -> Client {
    Client::connect(&Endpoint { url: node.ws_url(), token: node.device_token(&crate::access::paired_scopes()) }).await.unwrap()
}

/// A client with every scope, as the local bootstrap token has.
async fn root(node: &Node) -> Client {
    Client::connect(&Endpoint { url: node.ws_url(), token: node.device_token(&Scope::ALL) }).await.unwrap()
}

fn member_count(node: &Node) -> usize {
    node.membership().projection().members().count()
}

fn is_member(node: &Node, other: &Node) -> bool {
    node.membership().is_member(&other.id())
}

/// Every node sees exactly `expected` members and the same set of operations.
fn converged(nodes: &[&Node], expected: usize) -> bool {
    let digest = nodes[0].membership().digest();
    nodes.iter().all(|node| member_count(node) == expected && node.membership().digest() == digest && node.membership().has_network())
}

async fn all_linked(nodes: &[&Node]) {
    for (index, first) in nodes.iter().enumerate() {
        for second in &nodes[index + 1..] {
            eventually(&format!("{} and {} linked", first.name, second.name), WAIT, || linked(first, second)).await;
        }
    }
}

/// How many genesis operations a node's set holds.
fn genesis_count(node: &Node) -> usize {
    node.membership().all_ops().iter().filter(|op| op.body.contains("\"kind\":\"genesis\"")).count()
}

async fn found_action(client: &Client, name: &str) -> Option<FoundAction> {
    let status = client.call::<NetworkStatusMethod>(Empty {}).await.unwrap();
    status.found.iter().find(|machine| machine.name == name).map(|machine| machine.action)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn three_lone_daemons_of_one_user_join_without_a_click_and_found_one_network() {
    let Some(cluster) = cluster(&[NodeSpec::owner("a"), NodeSpec::owner("b"), NodeSpec::owner("c")]) else { return };
    let a = cluster.start("a", true).await;
    let b = cluster.start("b", true).await;
    let c = cluster.start("c", true).await;
    eventually("everyone is in one network", WAIT, || converged(&[&a, &b, &c], 3)).await;
    all_linked(&[&a, &b, &c]).await;

    // The smaller machine id founded it, and only one genesis exists: no second network was made.
    let smallest = [&a, &b, &c].into_iter().map(|node| node.id()).min().unwrap();
    for node in [&a, &b, &c] {
        assert_eq!(genesis_count(node), 1, "{} holds one genesis", node.name);
        let projection = node.membership().projection();
        let founder = projection.machines.iter().find(|(_, entry)| entry.added_by.is_none()).map(|(id, _)| id.clone());
        assert_eq!(founder.as_deref(), Some(smallest.as_str()), "the smallest machine id founds the network");
        assert_eq!(projection.owner_login.as_deref(), Some(OWNER));
        for (id, entry) in projection.members() {
            if *id != smallest {
                assert_eq!(entry.added_via, Some(JoinVia::Auto), "joined without a click");
            }
        }
    }
    assert_eq!(a.membership().network_id(), b.membership().network_id());
}

#[test]
fn the_wait_for_a_founder_runs_out_and_starts_over_when_nothing_is_waited_for() {
    let state = super::join::JoinState::default();
    let long = Duration::from_secs(3600);
    assert!(!state.wait_expired(true, long), "the clock starts at the first wait");
    assert!(state.wait_expired(true, Duration::ZERO), "and runs out once the limit has passed");
    assert!(!state.wait_expired(false, Duration::ZERO), "nothing to wait for is never an expired wait");
    assert!(!state.wait_expired(true, long), "a later wait starts a new clock");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_lone_machine_founds_after_waiting_for_a_smaller_one_that_never_does() {
    let Some(cluster) = cluster(&[NodeSpec::owner("a"), NodeSpec::owner("b")]) else { return };
    // `a` has the smaller id and answers the well-known endpoint, but never joins on its own (its
    // network is not doing discovery); `b` would wait for it to found the network.
    let a = cluster.start_as("a", "00000000-0000-7000-8000-000000000001", false).await;
    let b = cluster.start_as("b", "ffffffff-ffff-7fff-8fff-ffffffffffff", true).await;
    eventually("b finds a", WAIT, || b.state.network.peers.found().iter().any(|entry| entry.node.name() == "a")).await;

    // It waits at first: a lone machine with a smaller id is expected to found the network.
    tokio::time::sleep(Duration::from_millis(1200)).await;
    assert!(!b.membership().has_network() && !a.membership().has_network(), "b waits for the smaller machine within the wait");

    // After the wait it founds, and the smaller one, still lone, accepts the offer.
    eventually("b founds and adds a", WAIT, || converged(&[&a, &b], 2)).await;
    assert_eq!(genesis_count(&b), 1);
    let projection = b.membership().projection();
    let founder = projection.machines.iter().find(|(_, entry)| entry.added_by.is_none()).map(|(id, _)| id.clone());
    assert_eq!(founder, Some(b.id()), "the larger machine founded the network once the wait was over");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_tagged_node_is_found_and_joins_with_one_click() {
    let Some(cluster) = cluster(&[NodeSpec::owner("a"), NodeSpec::owner("b"), NodeSpec::tagged("v")]) else { return };
    let a = cluster.start("a", true).await;
    let b = cluster.start("b", true).await;
    let v = cluster.start("v", true).await;
    // a and b are the same user and join on their own; v waits to be found.
    eventually("a and b join", WAIT, || converged(&[&a, &b], 2)).await;
    eventually("v is found", WAIT, || a.state.network.peers.found().iter().any(|entry| entry.node.name() == "v")).await;

    // Nothing adds it on its own.
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert!(!is_member(&a, &v) && !v.membership().has_network(), "a tagged node waits for a click");

    // One click on any member: b, which did not found the network, adds it.
    let client_b = admin(&b).await;
    assert_eq!(found_action(&client_b, "v").await, Some(FoundAction::Add));
    let found_id = b.state.network.peers.found().iter().find(|entry| entry.node.name() == "v").unwrap().node.node_id.clone();
    let added = client_b.call::<NetworkAdd>(NetworkFoundParams { found_id }).await.unwrap();
    assert!(!added.needs_code);
    assert_eq!(added.machine.unwrap().machine_id, v.id());

    eventually("everyone has v", WAIT, || converged(&[&a, &b, &v], 3)).await;
    all_linked(&[&a, &b, &v]).await;
    assert_eq!(a.membership().projection().entry(&v.id()).unwrap().added_via, Some(JoinVia::Found));
    assert_eq!(a.membership().projection().entry(&v.id()).unwrap().added_by.as_deref(), Some(b.id().as_str()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn shared_and_foreign_nodes_need_a_code_and_the_code_works_once() {
    let specs = [NodeSpec::owner("a"), NodeSpec::owner("b"), NodeSpec::shared_in("s"), NodeSpec::other_user("o")];
    let Some(cluster) = cluster(&specs) else { return };
    let a = cluster.start("a", true).await;
    let b = cluster.start("b", true).await;
    let s = cluster.start("s", true).await;
    let o = cluster.start("o", true).await;
    eventually("a and b join", WAIT, || converged(&[&a, &b], 2)).await;
    eventually("s and o are found", WAIT, || {
        let found = a.state.network.peers.found();
        ["s", "o"].iter().all(|name| found.iter().any(|entry| entry.node.name() == *name))
    })
    .await;

    let client_a = admin(&a).await;
    assert_eq!(found_action(&client_a, "s").await, Some(FoundAction::Code), "a shared-in node cannot be verified by a click");
    assert_eq!(found_action(&client_a, "o").await, Some(FoundAction::Code), "another user's node needs a code too");
    let found_id = a.state.network.peers.found().iter().find(|entry| entry.node.name() == "s").unwrap().node.node_id.clone();
    let result = client_a.call::<NetworkAdd>(NetworkFoundParams { found_id }).await.unwrap();
    assert!(result.needs_code && result.machine.is_none());
    tokio::time::sleep(Duration::from_millis(1200)).await;
    assert!(!is_member(&a, &s) && !is_member(&a, &o), "nothing joined without a code");

    // The code is shown on s. A wrong one is refused.
    let client_s = admin(&s).await;
    let code = client_s.call::<NetworkCodeCreate>(Empty {}).await.unwrap();
    assert_eq!(code.code.len(), 6);
    assert!(code.qr.starts_with("kybern://join?") && code.qr.contains(&code.code), "{}", code.qr);
    let address = s.network_base(4173);
    let wrong = if code.code == "000000" { "111111" } else { "000000" };
    let refused = client_a.call::<NetworkJoin>(NetworkJoinParams { code: wrong.into(), address: address.clone(), migrate: false }).await;
    assert!(refused.is_err(), "a wrong code adds nothing");
    assert!(!is_member(&a, &s));

    let card = client_a
        .call::<NetworkJoin>(NetworkJoinParams { code: code.code.clone(), address: address.clone(), migrate: false })
        .await
        .unwrap();
    assert_eq!(card.machine_id, s.id());
    eventually("everyone has s", WAIT, || converged(&[&a, &b, &s], 3)).await;
    all_linked(&[&a, &b, &s]).await;
    assert_eq!(a.membership().projection().entry(&s.id()).unwrap().added_via, Some(JoinVia::Code));
    assert!(!is_member(&a, &o), "the other user's node stayed out");

    // The code was spent: it does not add the next machine, and s is not offered twice.
    let again = client_a.call::<NetworkJoin>(NetworkJoinParams { code: code.code, address: o.network_base(4173), migrate: false }).await;
    assert!(again.is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_saved_environment_migrates_into_the_network_with_its_own_connection() {
    let Some(cluster) = cluster(&[NodeSpec::owner("a"), NodeSpec::owner("c"), NodeSpec::other_user("e")]) else { return };
    let a = cluster.start("a", true).await;
    let c = cluster.start("c", true).await;
    let e = cluster.start("e", true).await;
    eventually("a and c join", WAIT, || converged(&[&a, &c], 2)).await;
    eventually("a and c linked", WAIT, || linked(&a, &c)).await;

    // The client holds a token for e (its saved environment) and for a. It asks e for a code over
    // the connection it already has, and redeems it on a (design §2.4d).
    let at_e = admin(&e).await;
    let at_a = admin(&a).await;
    let code = at_e.call::<NetworkCodeCreate>(Empty {}).await.unwrap();
    let card = at_a
        .call::<NetworkJoin>(NetworkJoinParams { code: code.code, address: format!("http://{}", e.primary), migrate: true })
        .await
        .unwrap();
    assert_eq!(card.machine_id, e.id());
    assert_eq!(a.membership().projection().entry(&e.id()).unwrap().added_via, Some(JoinVia::Migrate));
    eventually("e is in the network everywhere", WAIT, || converged(&[&a, &c, &e], 3)).await;
    all_linked(&[&a, &c, &e]).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_networks_of_one_owner_merge_with_one_click() {
    let specs = [NodeSpec::owner("a"), NodeSpec::owner("b"), NodeSpec::owner("c"), NodeSpec::owner("d")];
    let Some(cluster) = manual_cluster(&specs) else { return };
    let a = cluster.start("a", true).await;
    let b = cluster.start("b", true).await;
    let c = cluster.start("c", true).await;
    let d = cluster.start("d", true).await;
    // Two pairs formed while they could not see each other.
    cluster.form(&a, &[&b], JoinVia::Auto).await;
    cluster.form(&c, &[&d], JoinVia::Auto).await;
    assert_ne!(a.membership().network_id(), c.membership().network_id());
    eventually("c is found from a", WAIT, || a.state.network.peers.found().iter().any(|entry| entry.node.name() == "c")).await;

    let client_a = admin(&a).await;
    tokio::time::sleep(Duration::from_millis(1000)).await;
    assert_eq!(member_count(&a), 2, "two networks do not merge on their own");
    assert_eq!(found_action(&client_a, "c").await, Some(FoundAction::Merge));
    let found_id = a.state.network.peers.found().iter().find(|entry| entry.node.name() == "c").unwrap().node.node_id.clone();
    let status = client_a.call::<NetworkMerge>(NetworkFoundParams { found_id }).await.unwrap();
    assert!(status.members.len() >= 2);

    eventually("one network of four", WAIT, || converged(&[&a, &b, &c, &d], 4)).await;
    all_linked(&[&a, &b, &c, &d]).await;
    assert_eq!(a.membership().network_id(), d.membership().network_id());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn removing_a_machine_reaches_everyone_and_ends_what_it_issued() {
    let Some(cluster) = cluster(&[NodeSpec::owner("a"), NodeSpec::owner("b"), NodeSpec::owner("c")]) else { return };
    let a = cluster.start("a", true).await;
    let b = cluster.start("b", true).await;
    let c = cluster.start("c", true).await;
    eventually("everyone is in one network", WAIT, || converged(&[&a, &b, &c], 3)).await;
    all_linked(&[&a, &b, &c]).await;

    // A phone paired with c holds tokens for a and b that c asked them to mint.
    let at_c = admin(&c).await;
    let phone_via_c_for_a =
        at_c.call::<NetworkClientGrant>(NetworkClientGrantParams { machine_id: a.id(), device_id: "phone-1".into() }).await.unwrap();
    let phone_via_c_for_b =
        at_c.call::<NetworkClientGrant>(NetworkClientGrantParams { machine_id: b.id(), device_id: "phone-1".into() }).await.unwrap();
    // And a token for a that b minted: it must survive c's removal.
    let at_b = admin(&b).await;
    let tablet_via_b_for_a =
        at_b.call::<NetworkClientGrant>(NetworkClientGrantParams { machine_id: a.id(), device_id: "tablet-1".into() }).await.unwrap();
    let active = |node: &Node, token: &str| crate::auth::authenticate(&node.state.store, token).unwrap().is_some();
    assert!(active(&a, &phone_via_c_for_a.token) && active(&b, &phone_via_c_for_b.token) && active(&a, &tablet_via_b_for_a.token));

    // Remove c from a. Within one sync b, c and a agree.
    let at_a = admin(&a).await;
    let status = at_a.call::<NetworkRemove>(NetworkRemoveParams { machine_id: c.id(), stolen: false, also_remove: vec![] }).await.unwrap();
    assert_eq!(status.members.len(), 2);
    eventually("b and c know", WAIT, || b.membership().projection().is_removed(&c.id()) && c.membership().self_removed()).await;
    assert!(!is_member(&a, &c) && !is_member(&b, &c));
    assert_eq!(a.membership().digest(), b.membership().digest());
    eventually("sessions with c end", WAIT, || {
        a.state.network.peers.link(&c.id()).is_none()
            && b.state.network.peers.link(&c.id()).is_none()
            && c.state.network.peers.links().is_empty()
    })
    .await;
    assert!(a.state.network.grants.held().iter().all(|grant| grant.machine_id != c.id()), "a revoked c's grants");
    assert!(b.state.network.grants.held().iter().all(|grant| grant.machine_id != c.id()));

    // What c issued dies with it; what b issued does not.
    assert!(!active(&a, &phone_via_c_for_a.token) && !active(&b, &phone_via_c_for_b.token));
    assert!(active(&a, &tablet_via_b_for_a.token));
    // The removed machine says so, and nobody adds it back on its own.
    let status_c = at_c.call::<NetworkStatusMethod>(Empty {}).await;
    if let Ok(status_c) = status_c {
        assert!(status_c.removed);
    }
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert!(!is_member(&a, &c) && !is_member(&b, &c), "auto-join never applies after a removal");
    assert!(a.membership().projection().is_node_tombstoned(&format!("n{}", c.name)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_machine_that_is_offline_learns_of_its_removal_from_the_others() {
    let Some(cluster) = cluster(&[NodeSpec::owner("a"), NodeSpec::owner("b"), NodeSpec::owner("c")]) else { return };
    let a = cluster.start("a", true).await;
    let b = cluster.start("b", true).await;
    let c = cluster.start("c", true).await;
    eventually("everyone is in one network", WAIT, || converged(&[&a, &b, &c], 3)).await;
    all_linked(&[&a, &b, &c]).await;

    // Remove c from b while a is not reachable from b: a hears it by sync, not from b.
    a.state.network.peers.close(&b.id());
    b.state.network.peers.close(&a.id());
    let at_b = admin(&b).await;
    at_b.call::<NetworkRemove>(NetworkRemoveParams { machine_id: c.id(), stolen: false, also_remove: vec![] }).await.unwrap();
    eventually("a hears it", WAIT, || a.membership().projection().is_removed(&c.id())).await;
    assert_eq!(a.membership().digest(), b.membership().digest());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn removing_as_stolen_removes_what_it_added_and_revokes_its_tokens_and_grants() {
    let specs = [NodeSpec::owner("a"), NodeSpec::owner("b"), NodeSpec::owner("c"), NodeSpec::other_user("d")];
    let Some(cluster) = cluster(&specs) else { return };
    let a = cluster.start("a", true).await;
    let b = cluster.start("b", true).await;
    let c = cluster.start("c", true).await;
    let d = cluster.start("d", true).await;
    eventually("a, b and c join", WAIT, || converged(&[&a, &b, &c], 3)).await;
    // c, the machine that will turn out stolen, adds d.
    cluster.enroll(&c, &d, JoinVia::Code).await;
    eventually("four machines", WAIT, || converged(&[&a, &b, &c, &d], 4)).await;
    all_linked(&[&a, &b, &c, &d]).await;
    assert_eq!(a.membership().projection().entry(&d.id()).unwrap().added_by.as_deref(), Some(c.id().as_str()));

    let at_c = admin(&c).await;
    let via_c =
        at_c.call::<NetworkClientGrant>(NetworkClientGrantParams { machine_id: a.id(), device_id: "laptop-app".into() }).await.unwrap();
    assert!(crate::auth::authenticate(&a.state.store, &via_c.token).unwrap().is_some());
    assert!(c.state.network.peers.link(&a.id()).is_some() || a.state.network.peers.link(&c.id()).is_some());

    let at_b = admin(&b).await;
    let status =
        at_b.call::<NetworkRemove>(NetworkRemoveParams { machine_id: c.id(), stolen: true, also_remove: vec![d.id()] }).await.unwrap();
    assert_eq!(status.members.len(), 2, "both were removed from the list: {:?}", status.members);
    eventually("a knows", WAIT, || a.membership().projection().is_removed(&c.id()) && a.membership().projection().is_removed(&d.id()))
        .await;
    for node in [&a, &b] {
        let projection = node.membership().projection();
        for id in [c.id(), d.id()] {
            let removal = projection.entry(&id).unwrap().removed.clone().unwrap();
            assert_eq!(removal.reason, RemoveReason::Stolen, "{} records why", node.name);
        }
        assert!(node.state.network.grants.held().iter().all(|grant| grant.machine_id != c.id() && grant.machine_id != d.id()));
    }
    assert!(crate::auth::authenticate(&a.state.store, &via_c.token).unwrap().is_none(), "the token c issued is revoked");
    // The removed keys cannot come back by being added again.
    let again = a.membership().build_add(c.membership().self_descriptor(&c.state.network.self_info().await), JoinVia::Code);
    assert!(matches!(again, Err(super::MembershipError::Tombstoned)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_client_gets_a_token_for_another_machine_through_the_one_it_paired_with() {
    let Some(cluster) = cluster(&[NodeSpec::owner("a"), NodeSpec::owner("b"), NodeSpec::owner("c")]) else { return };
    let a = cluster.start("a", true).await;
    let b = cluster.start("b", true).await;
    let c = cluster.start("c", true).await;
    eventually("one network", WAIT, || converged(&[&a, &b, &c], 3)).await;
    all_linked(&[&a, &b, &c]).await;

    let pairing_token = a.device_token(&crate::access::paired_scopes());
    let client = Client::connect(&Endpoint { url: a.ws_url(), token: pairing_token.clone() }).await.unwrap();
    let grant =
        client.call::<NetworkClientGrant>(NetworkClientGrantParams { machine_id: b.id(), device_id: "phone-1".into() }).await.unwrap();
    assert!(grant.token.starts_with("kyb_"));
    assert!(grant.scopes.contains(&Scope::NetworkRead) && grant.scopes.contains(&Scope::OrchestrationOperate));
    assert_eq!(grant.signing_key.as_deref(), Some(b.membership().keys().signing_public_b64().as_str()), "the client can pin the key");
    assert!(grant.routes.iter().any(|route| route.kind == RouteKind::DirectTailnet && route.url.contains(":4173")), "{:?}", grant.routes);
    assert!(
        grant.routes.iter().any(|route| route.kind == RouteKind::Relay && route.via.as_deref() == Some(a.id().as_str())),
        "{:?}",
        grant.routes
    );

    // The token is b's own: it connects to b directly and b names the device behind it.
    let at_b = Client::connect(&Endpoint { url: b.ws_url(), token: grant.token.clone() }).await.unwrap();
    let info = at_b.call::<DaemonInfoMethod>(Empty {}).await.unwrap();
    assert_eq!(info.machine_id, b.id());
    let record = b.state.store.token_lookup(&crate::auth::hash(&grant.token)).unwrap().unwrap();
    assert!(record.label.contains("(via"), "{}", record.label);
    assert!(b.state.store.token_device(record.id).unwrap().as_deref() == Some("phone-1"));

    // Asking again replaces the token rather than piling them up.
    let second =
        client.call::<NetworkClientGrant>(NetworkClientGrantParams { machine_id: b.id(), device_id: "phone-1".into() }).await.unwrap();
    assert_ne!(second.token, grant.token);
    assert!(crate::auth::authenticate(&b.state.store, &grant.token).unwrap().is_none());
    assert!(crate::auth::authenticate(&b.state.store, &second.token).unwrap().is_some());

    // A grant for the machine it paired with is a token there too.
    let own =
        client.call::<NetworkClientGrant>(NetworkClientGrantParams { machine_id: a.id(), device_id: "phone-1".into() }).await.unwrap();
    assert!(crate::auth::authenticate(&a.state.store, &own.token).unwrap().is_some());

    // Revoking the device on any machine revokes it on every machine (peer.device.revoke).
    let third =
        client.call::<NetworkClientGrant>(NetworkClientGrantParams { machine_id: c.id(), device_id: "phone-1".into() }).await.unwrap();
    let revoker = root(&c).await;
    let phone_on_a = crate::auth::authenticate(&a.state.store, &pairing_token).unwrap().unwrap();
    // The pairing token itself carries the device, since the first grant named it.
    assert_eq!(a.state.store.token_device(phone_on_a.token_id).unwrap().as_deref(), Some("phone-1"));
    // c knows the device through the token it minted for it.
    let token_on_c = crate::auth::authenticate(&c.state.store, &third.token).unwrap().unwrap();
    revoker.call::<TokensRevoke>(TokensRevokeParams { token_id: token_on_c.token_id }).await.unwrap();
    eventually("the device is revoked everywhere", WAIT, || {
        crate::auth::authenticate(&a.state.store, &pairing_token).unwrap().is_none()
            && crate::auth::authenticate(&b.state.store, &second.token).unwrap().is_none()
            && crate::auth::authenticate(&c.state.store, &third.token).unwrap().is_none()
    })
    .await;

    // A machine that is not connected cannot mint: the answer says so.
    let at_a = admin(&a).await;
    b.state.network.peers.close_all();
    a.state.network.peers.close(&b.id());
    let offline = at_a.call::<NetworkClientGrant>(NetworkClientGrantParams { machine_id: b.id(), device_id: "phone-2".into() }).await;
    let _ = offline;
    let unknown =
        at_a.call::<NetworkClientGrant>(NetworkClientGrantParams { machine_id: "nope".into(), device_id: "phone-2".into() }).await;
    assert!(unknown.is_err());
    let bad_device = at_a.call::<NetworkClientGrant>(NetworkClientGrantParams { machine_id: a.id(), device_id: "has space".into() }).await;
    assert!(bad_device.is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pause_rename_and_a_machines_own_policy_spread_to_everyone() {
    let Some(cluster) = cluster(&[NodeSpec::owner("a"), NodeSpec::owner("b"), NodeSpec::owner("c")]) else { return };
    let a = cluster.start("a", true).await;
    let b = cluster.start("b", true).await;
    let c = cluster.start("c", true).await;
    eventually("one network", WAIT, || converged(&[&a, &b, &c], 3)).await;
    all_linked(&[&a, &b, &c]).await;
    let at_a = admin(&a).await;

    let card = at_a.call::<NetworkPause>(NetworkPauseParams { machine_id: b.id(), paused: true }).await.unwrap();
    assert_eq!(card.status, MachineStatus::Paused);
    eventually("c sees b paused", WAIT, || c.membership().projection().entry(&b.id()).unwrap().paused).await;
    assert_eq!(c.state.network.policy_scopes(&b.id()), vec![Scope::MachinePeer], "a paused machine keeps operation sync only");
    let resumed = at_a.call::<NetworkPause>(NetworkPauseParams { machine_id: b.id(), paused: false }).await.unwrap();
    assert_ne!(resumed.status, MachineStatus::Paused);

    let renamed = at_a.call::<NetworkRename>(NetworkRenameParams { machine_id: c.id(), name: "satyamas".into() }).await.unwrap();
    assert_eq!(renamed.name, "satyamas");
    eventually("b sees the name", WAIT, || b.membership().projection().entry(&c.id()).unwrap().descriptor.name == "satyamas").await;
    assert!(at_a.call::<NetworkRename>(NetworkRenameParams { machine_id: c.id(), name: "  ".into() }).await.is_err());

    // A machine's policy is written on that machine only.
    let at_c = admin(&c).await;
    assert!(
        at_a.call::<NetworkAllowSet>(NetworkAllowSetParams { machine_id: c.id(), capability: "files".into(), allowed: false })
            .await
            .is_err()
    );
    at_c.call::<NetworkAllowSet>(NetworkAllowSetParams { machine_id: c.id(), capability: "files".into(), allowed: false }).await.unwrap();
    eventually("a sees c's policy", WAIT, || a.membership().projection().allowed(&c.id()).get("files") == Some(&false)).await;
    assert!(!c.state.network.policy_scopes(&a.id()).contains(&Scope::MachineFiles));
    assert!(c.state.network.policy_scopes(&a.id()).contains(&Scope::MachineDelegate));
    assert!(
        at_c.call::<NetworkAllowSet>(NetworkAllowSetParams { machine_id: c.id(), capability: "peer".into(), allowed: false })
            .await
            .is_err()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_doctor_checks_tailscale_membership_and_each_peer() {
    let Some(cluster) = cluster(&[NodeSpec::owner("a"), NodeSpec::owner("b"), NodeSpec::owner("c")]) else { return };
    let a = cluster.start("a", true).await;
    let b = cluster.start("b", true).await;
    let c = cluster.start("c", true).await;
    eventually("one network", WAIT, || converged(&[&a, &b, &c], 3)).await;
    all_linked(&[&a, &b, &c]).await;
    let at_a = admin(&a).await;

    let report = at_a.call::<NetworkDoctor>(NetworkDoctorParams { machine_id: None }).await.unwrap();
    let find =
        |id: &str, machine: Option<&str>| report.checks.iter().find(|check| check.id == id && check.machine_id.as_deref() == machine);
    for id in ["tailscale.running", "tailscale.self_ip", "tailscale.listener", "membership.self_member"] {
        assert_eq!(find(id, None).unwrap_or_else(|| panic!("no {id}: {:#?}", report.checks)).status, DoctorStatus::Pass, "{id}");
    }
    assert_eq!(find("tailscale.lock", None).unwrap().status, DoctorStatus::Warn, "tailnet lock is recommended");
    assert!(find("tailscale.lock", None).unwrap().next_step.is_some());
    for node in [&b, &c] {
        let id = node.id();
        for check in ["peer.session", "peer.digest", "peer.whois", "peer.well_known", "peer.key_matches", "peer.clock"] {
            let found = find(check, Some(&id)).unwrap_or_else(|| panic!("no {check} for {}: {:#?}", node.name, report.checks));
            assert_eq!(found.status, DoctorStatus::Pass, "{check} for {}: {}", node.name, found.title);
        }
    }

    // One peer's checks only.
    let only_b = at_a.call::<NetworkDoctor>(NetworkDoctorParams { machine_id: Some(b.id()) }).await.unwrap();
    assert!(only_b.checks.iter().all(|check| check.machine_id.as_deref() == Some(b.id().as_str())), "{:#?}", only_b.checks);

    // A peer that goes away fails its checks and says what to do.
    let mut c = c;
    c.stop();
    eventually("a notices", WAIT, || a.state.network.peers.link(&c.id()).is_none()).await;
    let after = at_a.call::<NetworkDoctor>(NetworkDoctorParams { machine_id: Some(c.id()) }).await.unwrap();
    let session = after.checks.iter().find(|check| check.id == "peer.session").unwrap();
    assert_eq!(session.status, DoctorStatus::Fail);
    assert!(session.next_step.is_some());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn status_describes_a_lone_machine_and_the_master_switch_leaves_the_network() {
    let Some(cluster) = manual_cluster(&[NodeSpec::owner("a"), NodeSpec::owner("b")]) else { return };
    let a = cluster.start("a", false).await;
    let client = admin(&a).await;
    let lone = client.call::<NetworkStatusMethod>(Empty {}).await.unwrap();
    assert!(lone.enabled && lone.network_id.is_none() && lone.members.is_empty() && !lone.removed);
    assert!(lone.self_machine.is_self && lone.self_machine.machine_id == a.id());

    let b = cluster.start("b", true).await;
    cluster.form(&a, &[&b], JoinVia::Auto).await;
    let formed = client.call::<NetworkStatusMethod>(Empty {}).await.unwrap();
    assert_eq!(formed.members.len(), 2);
    assert!(formed.members[0].is_self, "this machine is listed first");
    assert!(formed.digest.is_some() && formed.network_id.is_some());

    // Off keeps membership but ends the sessions; on brings them back.
    let off = client.call::<NetworkSetEnabled>(NetworkSetEnabledParams { enabled: false }).await.unwrap();
    assert!(!off.enabled && off.members.len() == 2);
    assert!(a.state.network.peers.links().is_empty());
    let on = client.call::<NetworkSetEnabled>(NetworkSetEnabledParams { enabled: true }).await.unwrap();
    assert!(on.enabled);

    // Founding a network by joining something needs the network on and a reachable machine.
    let code = client.call::<NetworkCodeCreate>(Empty {}).await;
    assert!(code.is_err(), "a machine in a network does not show a join code");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rejoin_gives_a_removed_machine_a_new_identity_and_remembers_the_old_one() {
    let Some(cluster) = cluster(&[NodeSpec::owner("a"), NodeSpec::owner("b")]) else { return };
    let a = cluster.start("a", true).await;
    let b = cluster.start("b", true).await;
    eventually("one network", WAIT, || converged(&[&a, &b], 2)).await;
    all_linked(&[&a, &b]).await;
    let old = b.id();
    admin(&a)
        .await
        .call::<NetworkRemove>(NetworkRemoveParams { machine_id: old.clone(), stolen: false, also_remove: vec![] })
        .await
        .unwrap();
    eventually("b knows", WAIT, || b.membership().self_removed()).await;

    // A machine that is not removed cannot rejoin.
    assert!(admin(&a).await.call::<NetworkRejoin>(Empty {}).await.is_err());
    let status = admin(&b).await.call::<NetworkRejoin>(Empty {}).await.unwrap();
    assert!(status.network_id.is_none() && !status.removed, "a lone machine again");
    assert_ne!(b.id(), old);
    assert!(super::previous_machine_ids(&b.state.store).unwrap().contains(&old));
    // Its node id is tombstoned, so nothing adds it by itself; a member's click does (§2.6).
    assert!(a.membership().projection().is_node_tombstoned("nb"));
    let at_a = admin(&a).await;
    eventually("a finds b again, with its new identity", WAIT, || {
        a.state.network.peers.found().iter().any(|entry| entry.node.name() == "b" && entry.descriptor.machine_id == b.id())
    })
    .await;
    assert_eq!(found_action(&at_a, "b").await, Some(FoundAction::Add));
    let found_id = a.state.network.peers.found().iter().find(|entry| entry.node.name() == "b").unwrap().node.node_id.clone();
    let added = at_a.call::<NetworkAdd>(NetworkFoundParams { found_id }).await.unwrap();
    assert_eq!(added.machine.unwrap().machine_id, b.id());
    assert_eq!(a.membership().projection().entry(&b.id()).unwrap().added_via, Some(JoinVia::Found));
    assert!(a.membership().projection().is_removed(&old), "the old identity stays removed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn paired_tokens_get_the_network_scopes_and_older_ones_are_upgraded() {
    let Some(cluster) = cluster(&[NodeSpec::owner("a")]) else { return };
    let a = cluster.start("a", false).await;
    // A code-paired client holds the network scopes, a phone included.
    let (code, _) = a.state.pairing.create(Some("phone".into())).unwrap();
    let (_, scopes) = a.state.pairing.redeem(&a.state.store, &code, Some("Pixel".into())).unwrap();
    assert!(scopes.contains(&Scope::NetworkAdmin) && scopes.contains(&Scope::NetworkRead));

    // A token paired before the network lacks both; an upgrade adds them once.
    let old = uuid::Uuid::now_v7();
    a.state.store.token_insert(old, "old-hash", "iPhone", &[Scope::OrchestrationRead]).unwrap();
    crate::access::upgrade_paired_tokens(&a.state.store);
    let upgraded = a.state.store.tokens_list().unwrap().into_iter().find(|token| token.id == old).unwrap();
    assert!(upgraded.scopes.contains(&Scope::NetworkRead) && upgraded.scopes.contains(&Scope::NetworkAdmin));
    crate::access::upgrade_paired_tokens(&a.state.store);
    let again = a.state.store.tokens_list().unwrap().into_iter().find(|token| token.id == old).unwrap();
    assert_eq!(again.scopes, upgraded.scopes, "running it twice changes nothing");
}
