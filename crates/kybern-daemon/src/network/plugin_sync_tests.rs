//! In-process machines with isolated plugin homes; OpenCode's native config mechanism needs no process.
use super::harness::*;
use super::testutil::TempDir;
use kybern_client::{Client, Endpoint};
use kybern_protocol::methods::*;
use kybern_protocol::*;
use serde_json::json;
use std::path::Path;
fn seed(home: &Path, version: &str) {
    let path = home.join(".config/opencode/opencode.json");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, json!({"plugin":[format!("review@{version}")]}).to_string()).unwrap();
}
async fn client(n: &Node) -> Client {
    Client::connect(&Endpoint { url: n.ws_url(), token: n.device_token(&Scope::ALL) }).await.unwrap()
}
async fn sent(n: &Node, id: uuid::Uuid) -> OutboxItem {
    eventually("plugin install settles", WAIT, || n.state.store.outbox_get(id).unwrap().unwrap().state.is_settled()).await;
    n.state.store.outbox_get(id).unwrap().unwrap()
}
fn request(p: &MachinePlugin, from: Option<String>, to: String) -> PluginsCopyParams {
    PluginsCopyParams {
        provider: p.provider,
        id: p.id.clone(),
        from,
        to: vec![PluginCopyTarget { machine: to, replaces: None }],
        confirmed: p.fingerprint.clone(),
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn plugin_list_a_to_b_then_remote_b_to_c_and_offline_frozen_copy() {
    let Some(cluster) = Cluster::new(&[NodeSpec::owner("a"), NodeSpec::owner("b"), NodeSpec::owner("c")]) else {
        return;
    };
    let a = cluster.start("a", true).await;
    let b = cluster.start("b", true).await;
    let c = cluster.start("c", true).await;
    cluster.form(&a, &[&b, &c], JoinVia::Auto).await;
    eventually("links", WAIT, || linked(&a, &b) && linked(&b, &c) && linked(&a, &c)).await;
    let homes = TempDir::new("plugin-cluster-homes");
    for n in [&a, &b, &c] {
        let home = homes.path().join(n.id());
        std::fs::create_dir_all(&home).unwrap();
        n.state.skill_homes.set(Default::default(), home);
    }
    seed(&homes.path().join(a.id()), "1.0.0");
    let ac = client(&a).await;
    assert!(a.state.network.features().iter().any(|f| f == features::PLUGINS_SYNC_V1));
    let p = crate::plugins::inventory(&a.state).await.unwrap().plugins[0].clone();
    let result = ac.call::<PluginsCopy>(request(&p, None, b.id())).await.unwrap();
    assert!(result.targets[0].error.is_none(), "{:?}", result.targets[0]);
    let item = sent(&a, result.targets[0].outbox_id.unwrap()).await;
    assert_eq!(item.state, OutboxState::Delivered, "{:?}", item.last_error);
    let r: PluginInstallResult = serde_json::from_value(item.result.unwrap()).unwrap();
    assert_eq!(r.state, PluginInstallState::Configured, "{}", r.message);
    let view = ac.call::<PluginsNetworkViewMethod>(Empty {}).await.unwrap();
    assert_eq!(view.machines.iter().filter(|m| m.inventory.as_ref().is_some_and(|i| !i.plugins.is_empty())).count(), 2);
    c.set_network_enabled(false);
    eventually("c offline", WAIT, || b.state.network.peers.link(&c.id()).is_none()).await;
    let result = ac.call::<PluginsCopy>(request(&p, Some(b.id()), c.id())).await.unwrap();
    let id = result.targets[0].outbox_id.unwrap();
    assert_eq!(b.state.store.outbox_get(id).unwrap().unwrap().state, OutboxState::Queued);
    // Queue uses the approved declaration, not whatever replaces it on the source later.
    seed(&homes.path().join(b.id()), "2.0.0");
    c.set_network_enabled(true);
    eventually("c back", WAIT, || linked(&b, &c)).await;
    let item = sent(&b, id).await;
    assert_eq!(item.state, OutboxState::Delivered, "{:?}", item.last_error);
    let got = crate::plugins::inventory(&c.state).await.unwrap();
    assert_eq!(got.plugins[0].version.as_deref(), Some("1.0.0"));
    // Stale source review refuses before queueing anything.
    assert!(ac.call::<PluginsCopy>(request(&p, Some(b.id()), c.id())).await.is_err());
    // Files capability controls listing, forwarding and installation.
    c.membership().set(&format!("allow.{}.files", c.id()), json!(false)).unwrap();
    let err = a.state.network.peers.link(&c.id()).unwrap().call::<PeerPluginsInventory>(Empty {}).await.unwrap_err();
    assert_eq!(err.code, codes::FORBIDDEN);
    let result = ac.call::<PluginsCopy>(request(&p, None, c.id())).await.unwrap();
    assert_eq!(sent(&a, result.targets[0].outbox_id.unwrap()).await.state, OutboxState::Failed);
}
