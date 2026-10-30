//! The multi-daemon harness (design §11.3), in process.
//!
//! A [`Cluster`] plays a tailnet. Each [`Node`] is a real daemon state with its own data directory,
//! store and keys, served on its own `127.<block>.0.<n>` address, with a [`Fake`] Tailscale that
//! reads one fixture per node. Every node runs the production code paths: the network listener is
//! opened by [`crate::exposure::apply_network`] on the node's fake Tailscale address at the network
//! port, discovery and sessions run in [`peers::run`], and peers dial each other with the real
//! handshake over real sockets. Only `tailscale` itself is fake.
//!
//! It lives inside the crate, like `remote_tests.rs`, because the daemon library exposes only
//! `run()`; process-level tests that start the real `kybernd` with `KYBERN_TAILSCALE_FAKE` are in
//! `crates/kybern/tests/network.rs`.
//!
//! Each cluster gets its own `127.<block>.0.0/24` so tests running in parallel never share an
//! address. macOS only has `127.0.0.1` configured, so [`Cluster::new`] returns `None` there unless
//! the aliases exist (`sudo ifconfig lo0 alias 127.1.0.2`), and the test is skipped.

use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use axum::Router;
use axum::routing::get;
use kybern_drivers::registry::DriverRegistry;
use kybern_protocol::{JoinVia, Scope};
use tokio::task::JoinHandle;
use uuid::Uuid;

use super::peers;
use super::tailscale::{Fake, FakeFixture, FakeNode};
use super::testutil::TempDir;
use super::{Membership, Timing};
use crate::state::AppState;

static NEXT_BLOCK: AtomicU32 = AtomicU32::new(1);

pub const OWNER: &str = "owner@example.com";
pub const TAILNET: &str = "fake.ts.net";

/// What a node is on the tailnet, as `tailscale whois` reports it.
#[derive(Debug, Clone)]
pub struct NodeSpec {
    pub name: String,
    pub login: String,
    pub user_id: i64,
    pub tags: Vec<String>,
    pub shared_in: bool,
}

impl NodeSpec {
    /// A node of the owner (the same user).
    pub fn owner(name: &str) -> Self {
        Self { name: name.into(), login: OWNER.into(), user_id: 1, tags: vec![], shared_in: false }
    }

    /// A tagged server node (a VPS with `tag:server`).
    pub fn tagged(name: &str) -> Self {
        Self { tags: vec!["tag:server".into()], ..Self::owner(name) }
    }

    /// A node shared in from another tailnet.
    pub fn shared_in(name: &str) -> Self {
        Self { login: "friend@example.com".into(), user_id: 9, shared_in: true, ..Self::owner(name) }
    }

    /// A node of another user on the same tailnet.
    pub fn other_user(name: &str) -> Self {
        Self { login: "other@example.com".into(), user_id: 2, ..Self::owner(name) }
    }
}

/// Whether this machine has more than one loopback address to play a tailnet with.
fn loopback_aliases_available() -> bool {
    std::net::TcpListener::bind(("127.1.0.2", 0)).is_ok()
}

pub struct Cluster {
    pub dir: TempDir,
    block: u32,
    fixture: FakeFixture,
    /// Whether daemons join same-user machines on their own. Off unless a test asks, so a test that
    /// forms its network with [`Cluster::form`] is not raced by discovery.
    auto_join: bool,
    /// The intervals every daemon runs on: [`Timing::fast`] unless a test slows part of it down.
    timing: Timing,
    /// `(viewer, node)` pairs: the viewer's Tailscale lists the node offline while the node itself runs.
    seen_offline: Vec<(String, String)>,
}

impl Cluster {
    /// A tailnet of `specs`, the first one being the first node. `None` when the machine has no
    /// loopback aliases to play it with.
    pub fn new(specs: &[NodeSpec]) -> Option<Self> {
        if !loopback_aliases_available() {
            eprintln!("skipped: this machine has no 127.x.0.n loopback aliases (macOS: sudo ifconfig lo0 alias 127.1.0.2)");
            return None;
        }
        let block = NEXT_BLOCK.fetch_add(1, Ordering::SeqCst);
        let nodes = specs
            .iter()
            .enumerate()
            .map(|(index, spec)| FakeNode {
                name: spec.name.clone(),
                node_id: format!("n{}", spec.name),
                ip: format!("100.64.{block}.{}", index + 1).parse().unwrap(),
                listen: format!("127.{block}.0.{}", index + 2).parse().unwrap(),
                login: spec.login.clone(),
                user_id: spec.user_id,
                tags: spec.tags.clone(),
                shared_in: spec.shared_in,
                online: true,
            })
            .collect();
        let cluster = Self {
            dir: TempDir::new("cluster"),
            block,
            fixture: FakeFixture { self_name: String::new(), tailnet: TAILNET.into(), nodes },
            auto_join: false,
            timing: Timing::fast(),
            seen_offline: Vec::new(),
        };
        cluster.save();
        Some(cluster)
    }

    /// Let the daemons join each other on discovery (N4's joining flows).
    pub fn auto_join(mut self, on: bool) -> Self {
        self.auto_join = on;
        self
    }

    /// Change the intervals the daemons run on, for a scenario that must not be rescued by a short tick or backoff.
    pub fn timing(mut self, change: impl FnOnce(&mut Timing)) -> Self {
        change(&mut self.timing);
        self
    }

    fn fixture_path(&self, name: &str) -> PathBuf {
        self.dir.path().join(format!("tailscale-{name}.json"))
    }

    /// Write one fixture per node: the same tailnet, a different `self`.
    pub fn save(&self) {
        for node in &self.fixture.nodes {
            let mut fixture = FakeFixture { self_name: node.name.clone(), ..self.fixture.clone() };
            for (_, hidden) in self.seen_offline.iter().filter(|(viewer, _)| *viewer == node.name) {
                fixture.nodes.iter_mut().find(|other| other.name == *hidden).unwrap().online = false;
            }
            fixture.save(&self.fixture_path(&node.name)).unwrap();
        }
    }

    pub fn fake(&self, name: &str) -> &FakeNode {
        self.fixture.nodes.iter().find(|node| node.name == name).unwrap_or_else(|| panic!("no node {name}"))
    }

    pub fn listen_ip(&self, name: &str) -> IpAddr {
        self.fake(name).listen
    }

    /// Take a node off the tailnet (or bring it back) without touching its daemon.
    pub fn set_online(&mut self, name: &str, online: bool) {
        self.fixture.nodes.iter_mut().find(|node| node.name == name).unwrap().online = online;
        self.save();
    }

    /// `viewer`'s Tailscale lists `name` as offline (it lost its coordination server) although its daemon
    /// is up and reachable. Only `viewer`'s status changes.
    pub fn list_offline_for(&mut self, viewer: &str, name: &str, offline: bool) {
        self.seen_offline.retain(|(v, n)| !(v == viewer && n == name));
        if offline {
            self.seen_offline.push((viewer.into(), name.into()));
        }
        self.save();
    }

    /// Put `name` on the same computer as `with`: it listens on the same address, as a second
    /// daemon on one host would. Call before starting either.
    pub fn share_host(&mut self, name: &str, with: &str) {
        let listen = self.fake(with).listen;
        self.fixture.nodes.iter_mut().find(|node| node.name == name).unwrap().listen = listen;
        self.save();
    }

    /// Start `name`'s daemon: its own data directory, an in-process server on a loopback primary
    /// address, and (with `worker`) the peer manager that opens the network listener and dials.
    pub async fn start(&self, name: &str, worker: bool) -> Node {
        self.start_with(name, worker, DriverRegistry::default()).await
    }

    /// [`Cluster::start`] with the harness drivers the node's agents run on.
    pub async fn start_with(&self, name: &str, worker: bool, drivers: DriverRegistry) -> Node {
        self.start_configured(name, worker, drivers, None, self.auto_join).await
    }

    /// A node with a chosen machine id and its own say over joining on discovery, for a scenario that
    /// depends on which of two machines has the smaller id.
    pub async fn start_as(&self, name: &str, machine_id: &str, auto_join: bool) -> Node {
        self.start_configured(name, true, DriverRegistry::default(), Some(machine_id), auto_join).await
    }

    /// A node whose tailnet is unreachable: its Tailscale fixture does not exist, so it sees no peers
    /// and opens no tailnet listener, as a machine off the tailnet does.
    pub async fn start_off_tailnet(&self, name: &str) -> Node {
        let root = self.dir.path().join(format!("data-{name}"));
        std::fs::create_dir_all(&root).unwrap();
        let paths = crate::config::Paths::resolve(Some(root.clone())).unwrap();
        let tailscale = Arc::new(Fake::new(self.dir.path().join(format!("no-tailscale-{name}.json"))));
        self.serve(name, true, &paths, root, tailscale, DriverRegistry::default(), false).await
    }

    async fn start_configured(&self, name: &str, worker: bool, drivers: DriverRegistry, machine_id: Option<&str>, auto_join: bool) -> Node {
        let root = self.dir.path().join(format!("data-{name}"));
        std::fs::create_dir_all(&root).unwrap();
        let paths = crate::config::Paths::resolve(Some(root.clone())).unwrap();
        if let Some(machine_id) = machine_id {
            let store = kybern_store::Store::open(&paths.db).unwrap();
            store.meta_set("environment_id", machine_id).unwrap();
        }
        let tailscale = Arc::new(Fake::new(self.fixture_path(name)));
        self.serve(name, worker, &paths, root, tailscale, drivers, auto_join).await
    }

    #[allow(clippy::too_many_arguments)]
    async fn serve(
        &self,
        name: &str,
        worker: bool,
        paths: &crate::config::Paths,
        root: PathBuf,
        tailscale: Arc<Fake>,
        drivers: DriverRegistry,
        auto_join: bool,
    ) -> Node {
        let state = AppState::initialize_with_drivers(paths, tailscale, Timing { auto_join, ..self.timing.clone() }, drivers).unwrap();
        // The network is off until a user turns it on; every harness node has.
        let mut settings = state.settings.get();
        settings.network.enabled = true;
        state.settings.set(settings).unwrap();
        state.network.set_enabled(true);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let primary = listener.local_addr().unwrap();
        *state.listen_addr.write().unwrap() = Some(primary);
        state.port.store(primary.port(), Ordering::Relaxed);
        let app = Router::new()
            .merge(crate::http::routes())
            .merge(super::routes())
            .route("/ws", get(crate::ws::upgrade))
            .layer(axum::extract::DefaultBodyLimit::max(64 * 1024 * 1024))
            .with_state(state.clone());
        state.exposure.attach(app.clone()).await;
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).await;
        });
        let outbox = worker.then(|| {
            state.orchestrator.remote_start();
            tokio::spawn(super::outbox::run(state.clone()))
        });
        let worker = worker.then(|| tokio::spawn(peers::run(state.clone())));
        Node { name: name.to_string(), state, primary, listen_ip: self.listen_ip(name), root, server, worker, outbox }
    }

    /// Found the network on `founder` and add `others` to it, the way N4's flows will: each is added
    /// by a signed operation and handed the whole set. Every node is woken.
    pub async fn form(&self, founder: &Node, others: &[&Node], via: JoinVia) {
        let info = founder.state.network.self_info().await;
        if !founder.membership().has_network() {
            founder.membership().genesis(OWNER, TAILNET, &info).unwrap();
        }
        for other in others {
            self.enroll(founder, other, via).await;
        }
        founder.state.network.wake();
    }

    /// Add `other` to the network `by` belongs to, and give it the set.
    pub async fn enroll(&self, by: &Node, other: &Node, via: JoinVia) {
        if by.membership().is_member(&other.id()) {
            return;
        }
        let info = other.state.network.self_info().await;
        let descriptor = other.membership().self_descriptor(&info);
        let op = by.membership().add(descriptor, via).unwrap();
        other.membership().join(by.membership().all_ops()).unwrap();
        // The members that are already linked to `by` hear of it, as they do from a real join.
        by.state.network.publish_ops(vec![op]);
        other.state.network.wake();
    }
}

pub struct Node {
    pub name: String,
    pub state: AppState,
    /// The loopback address the primary listener holds.
    pub primary: SocketAddr,
    /// The fake tailnet address' loopback twin, where the network listener binds.
    pub listen_ip: IpAddr,
    pub root: PathBuf,
    server: JoinHandle<()>,
    worker: Option<JoinHandle<()>>,
    outbox: Option<JoinHandle<()>>,
}

impl Node {
    pub fn id(&self) -> String {
        self.state.network.machine_id().unwrap()
    }

    pub fn membership(&self) -> &Arc<Membership> {
        self.state.network.membership().unwrap()
    }

    /// `http://127.x.0.n:<network port>`: where peers reach this node.
    pub fn network_base(&self, port: u16) -> String {
        super::well_known::base_url(self.listen_ip, port)
    }

    /// `ws://` URL of the primary listener, where this node's own clients connect.
    pub fn ws_url(&self) -> String {
        format!("ws://{}/ws", self.primary)
    }

    pub fn http_url(&self) -> String {
        format!("http://{}", self.primary)
    }

    /// A device token for a client of this node.
    pub fn device_token(&self, scopes: &[Scope]) -> String {
        let token = crate::auth::generate();
        self.state.store.token_insert(Uuid::now_v7(), &crate::auth::hash(&token), "harness device", scopes).unwrap();
        token
    }

    /// Run the peer manager again now, and wait for it to finish its pass.
    pub async fn pass(&self) {
        peers::pass(&self.state).await;
    }

    pub fn set_network_enabled(&self, enabled: bool) {
        let mut settings = self.state.settings.get();
        settings.network.enabled = enabled;
        self.state.settings.set(settings).unwrap();
        self.state.network.wake();
    }

    /// Stop the daemon the way a crash does: its sockets close and nothing answers.
    pub fn stop(&mut self) {
        // The network off first: aborting the serve task does not end connections it already
        // accepted, so a stopped node could still take a new session and look online again.
        self.state.network.set_enabled(false);
        self.state.shutdown.cancel();
        self.state.network.peers.close_all();
        self.server.abort();
        if let Some(worker) = self.worker.take() {
            worker.abort();
        }
        if let Some(outbox) = self.outbox.take() {
            outbox.abort();
        }
    }
}

impl Drop for Node {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Wait until `condition` holds, polling every 25 ms; panics with `what` after `timeout`.
pub async fn eventually(what: &str, timeout: Duration, mut condition: impl FnMut() -> bool) {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if condition() {
            return;
        }
        if tokio::time::Instant::now() >= deadline {
            panic!("timed out waiting for: {what}");
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

pub const WAIT: Duration = Duration::from_secs(20);

/// Both nodes hold an open link to each other.
pub fn linked(a: &Node, b: &Node) -> bool {
    a.state.network.peers.link(&b.id()).is_some() && b.state.network.peers.link(&a.id()).is_some()
}
