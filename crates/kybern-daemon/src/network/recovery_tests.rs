//! A network that heals on its own, found by the real multi-machine test (ADE-86): a capability turned
//! back on reaches a live session, a restarted peer is dialed again at once instead of after the wait its
//! failed attempts earned, and a new machine of the same user is found within seconds. Every scenario runs
//! real daemons over real sockets on the fake tailnet of the multi-daemon harness.

use std::time::Duration;

use kybern_client::{Client, Endpoint};
use kybern_protocol::methods::*;
use kybern_protocol::*;

use super::harness::*;
use super::peers::{self, Direction};

const SOON: Duration = Duration::from_secs(8);

async fn admin(node: &Node) -> Client {
    Client::connect(&Endpoint { url: node.ws_url(), token: node.device_token(&crate::access::paired_scopes()) }).await.unwrap()
}

fn converged(nodes: &[&Node], expected: usize) -> bool {
    let digest = nodes[0].membership().digest();
    nodes.iter().all(|node| {
        node.membership().projection().members().count() == expected
            && node.membership().digest() == digest
            && node.membership().has_network()
    })
}

/// Whether `node` lets `other` use `scope` on the session `other` opened to it, right now.
fn usable(node: &Node, other: &Node, scope: Scope) -> bool {
    node.state
        .network
        .peers
        .link(&other.id())
        .is_some_and(|link| link.direction == Direction::Accepted && peers::effective_scopes(&node.state.network, &link).contains(&scope))
}

async fn allow_files(node: &Node, allowed: bool) {
    admin(node)
        .await
        .call::<NetworkAllowSet>(NetworkAllowSetParams { machine_id: node.id(), capability: "files".into(), allowed })
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn turning_a_capability_back_on_reaches_a_live_session_within_seconds() {
    let Some(cluster) = Cluster::new(&[NodeSpec::owner("a"), NodeSpec::owner("b")]) else { return };
    // `a` has the smaller id, so it dials `b`: the session `b` accepts carries the grant `b` issued.
    let a = cluster.start_as("a", "00000000-0000-7000-8000-000000000001", false).await;
    let b = cluster.start_as("b", "ffffffff-ffff-7fff-8fff-ffffffffffff", false).await;
    cluster.form(&a, &[&b], JoinVia::Auto).await;
    eventually("linked", WAIT, || linked(&a, &b)).await;
    assert!(usable(&b, &a, Scope::MachineFiles));

    // Off: it takes effect at once. The session in place still lists the capability in its grant.
    allow_files(&b, false).await;
    assert!(!usable(&b, &a, Scope::MachineFiles));
    eventually("a hears of it", WAIT, || a.membership().projection().allowed(&b.id()).get("files") == Some(&false)).await;
    // A new session is granted under the narrower policy (as one opened after the change would be).
    b.state.network.drop_session(&a.id());
    eventually("a new session without files", WAIT, || {
        b.state
            .network
            .peers
            .link(&a.id())
            .is_some_and(|link| link.direction == Direction::Accepted && !link.scopes.contains(&Scope::MachineFiles))
    })
    .await;

    // Back on: before the fix this waited for the grant to be replaced, up to its whole life.
    allow_files(&b, true).await;
    eventually("files usable again", SOON, || usable(&b, &a, Scope::MachineFiles)).await;
    // `b` registers the session on the upgrade, `a` once it reads the answer: a moment apart.
    eventually("the sessions are back", WAIT, || linked(&a, &b)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_restarted_peer_is_dialed_again_at_once_not_after_its_backoff() {
    // A failed attempt would earn half a minute of waiting; the test gives the restart a few seconds.
    let Some(cluster) = Cluster::new(&[NodeSpec::owner("a"), NodeSpec::owner("b")]).map(|cluster| {
        cluster.timing(|timing| {
            timing.backoff_min = Duration::from_secs(30);
            timing.backoff_max = Duration::from_secs(30);
        })
    }) else {
        return;
    };
    let (a_id, b_id) = ("00000000-0000-7000-8000-000000000001", "ffffffff-ffff-7fff-8fff-ffffffffffff");
    // `a` dials `b` (the smaller id dials), so `b` can only wait to be dialed after it restarts.
    let a = cluster.start_as("a", a_id, false).await;
    let mut b = cluster.start_as("b", b_id, false).await;
    cluster.form(&a, &[&b], JoinVia::Auto).await;
    eventually("linked", WAIT, || linked(&a, &b)).await;

    b.stop();
    b.state.exposure.clear_network().await;
    eventually("a loses b", WAIT, || a.state.network.peers.link(b_id).is_none()).await;
    eventually("a's attempts fail and it waits", WAIT, || a.state.network.peers.status(b_id).failures >= 1).await;
    drop(b);
    tokio::time::sleep(Duration::from_millis(200)).await;

    let b = cluster.start_as("b", b_id, false).await;
    eventually("a and the restarted b are linked", SOON, || linked(&a, &b)).await;
    assert_eq!(a.state.network.peers.status(b_id).failures, 0, "the wait it had earned is over");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_new_machine_of_the_same_user_joins_within_seconds_of_starting() {
    // Discovery ticks once a minute here: only the new machine's nudge can make it quick.
    let Some(cluster) = Cluster::new(&[NodeSpec::owner("a"), NodeSpec::owner("b"), NodeSpec::owner("c")]).map(|cluster| {
        cluster.auto_join(true).timing(|timing| {
            timing.tick_idle = Duration::from_secs(60);
            timing.tick_watching = Duration::from_secs(60);
            timing.found_ttl = Duration::from_secs(600);
        })
    }) else {
        return;
    };
    let a = cluster.start("a", true).await;
    let b = cluster.start("b", true).await;
    eventually("a and b join", SOON, || converged(&[&a, &b], 2)).await;
    let c = cluster.start("c", true).await;
    eventually("c joins", SOON, || converged(&[&a, &b, &c], 3)).await;
}
