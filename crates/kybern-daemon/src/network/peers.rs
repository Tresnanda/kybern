//! The peer manager (design §3.1 to §3.3): discovery ticks, the dial rule, heartbeat and backoff,
//! and the one JSON-RPC link per pair of members.
//!
//! * **Discovery.** Every tick (60 s while a client shows Machines, else 5 min, and once on start
//!   and after any session drops) the worker reads `tailscale status`, probes online peers that are
//!   not members for the well-known endpoint and records the answers as the *found* list.
//! * **Dial rule.** For every pair the member with the smaller machine id dials; the other waits.
//!   A dial verifies the target's well-known proof against the key in the membership set, opens a
//!   session ([`super::session`]) and connects a WebSocket with the grant.
//! * **One link per pair, used both ways.** [`PeerLink`] sends and answers requests on one
//!   socket. The listening side wraps its connection's outbox; the dialing side owns the socket.
//! * **Heartbeat and backoff.** A WebSocket ping every 30 s; a link silent for three missed pings
//!   is dead. Reconnects back off 2, 4, 8 … 300 s and start over when the tailnet's status changes.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use futures::{SinkExt, StreamExt};
use kybern_protocol::methods::*;
use kybern_protocol::*;
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::http::header::AUTHORIZATION;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::relay::LinkRelays;
use super::session::{self, Target};
use super::tailscale::{TsNode, TsStatus, Whois};
use super::well_known::{self, WellKnown};
use super::{ApplyOutcome, MembershipError, Network, TARGET};
use crate::state::AppState;

const SESSION_TARGET: &str = "kybern::network::session";
const DISCOVERY_TARGET: &str = "kybern::network::discovery";
/// The ports a peer's network listener may hold (§3.1): the default and the next six.
pub const PORT_RANGE: std::ops::RangeInclusive<u16> = DEFAULT_PORT..=DEFAULT_PORT + 6;
const MAX_CONCURRENT_PROBES: usize = 8;
const MAX_INBOUND_REQUESTS: usize = 16;

// ---- the link ----

/// Where a link's frames go: the listener's connection outbox, or the dialer's socket writer.
#[async_trait]
pub trait FrameSink: Send + Sync {
    /// Queue one JSON frame; `false` once the socket is gone.
    async fn send(&self, frame: Value) -> bool;
}

struct ChannelSink(mpsc::Sender<String>);

#[async_trait]
impl FrameSink for ChannelSink {
    async fn send(&self, frame: Value) -> bool {
        match serde_json::to_string(&frame) {
            Ok(text) => self.0.send(text).await.is_ok(),
            Err(_) => false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    /// This machine opened the session.
    Dialed,
    /// The other machine opened it to this one.
    Accepted,
}

/// One session with one member, requests and notifications flowing both ways.
pub struct PeerLink {
    pub machine_id: String,
    pub direction: Direction,
    /// The grant that authenticated an accepted link.
    pub grant_id: Option<Uuid>,
    /// What the session allows: the scopes the target granted us (dialed) or we granted (accepted).
    pub scopes: Vec<Scope>,
    pub opened_at: Instant,
    sink: Arc<dyn FrameSink>,
    pending: Mutex<HashMap<i64, oneshot::Sender<RpcResponse>>>,
    next_id: AtomicI64,
    closed: CancellationToken,
    last_frame: Mutex<Instant>,
    inbound: Arc<tokio::sync::Semaphore>,
    pub relays: LinkRelays,
}

impl PeerLink {
    pub fn new(
        machine_id: String,
        direction: Direction,
        grant_id: Option<Uuid>,
        scopes: Vec<Scope>,
        sink: Arc<dyn FrameSink>,
    ) -> Arc<Self> {
        Arc::new(Self {
            machine_id,
            direction,
            grant_id,
            scopes,
            opened_at: Instant::now(),
            sink,
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicI64::new(1),
            closed: CancellationToken::new(),
            last_frame: Mutex::new(Instant::now()),
            inbound: Arc::new(tokio::sync::Semaphore::new(MAX_INBOUND_REQUESTS)),
            relays: LinkRelays::new(direction),
        })
    }

    fn pending(&self) -> MutexGuard<'_, HashMap<i64, oneshot::Sender<RpcResponse>>> {
        self.pending.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Send a request and wait for its answer.
    pub async fn call_raw(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending().insert(id, tx);
        let request = RpcRequest::new(RpcId::Number(id), method, params);
        if !self.sink.send(serde_json::to_value(&request).unwrap_or(Value::Null)).await {
            self.pending().remove(&id);
            return Err(RpcError::internal("the session is closed"));
        }
        let answer = tokio::select! {
            answer = rx => answer.map_err(|_| RpcError::internal("the session closed before it answered"))?,
            _ = self.closed.cancelled() => { self.pending().remove(&id); return Err(RpcError::internal("the session is closed")); }
            _ = tokio::time::sleep(Duration::from_secs(60)) => { self.pending().remove(&id); return Err(RpcError::internal("the machine did not answer in time")); }
        };
        match (answer.result, answer.error) {
            (_, Some(error)) => Err(error),
            (Some(result), None) => Ok(result),
            (None, None) => Ok(Value::Null),
        }
    }

    pub async fn call<M: Method>(&self, params: M::Params) -> Result<M::Result, RpcError> {
        let value = self.call_raw(M::NAME, serde_json::to_value(params).map_err(RpcError::internal)?).await?;
        serde_json::from_value(value).map_err(RpcError::internal)
    }

    /// Send a notification (no answer expected). `false` when the session is gone.
    pub async fn notify(&self, method: &str, params: Value) -> bool {
        let note = RpcNotification::new(method, params);
        self.sink.send(serde_json::to_value(&note).unwrap_or(Value::Null)).await
    }

    async fn respond(&self, response: RpcResponse) {
        let _ = self.sink.send(serde_json::to_value(&response).unwrap_or(Value::Null)).await;
    }

    /// Hand an answer to the request waiting for it.
    pub fn deliver(&self, response: RpcResponse) {
        if let RpcId::Number(id) = response.id
            && let Some(tx) = self.pending().remove(&id)
        {
            let _ = tx.send(response);
        }
    }

    /// Any frame, pong included, proves the other side is alive.
    pub fn touch(&self) {
        *self.last_frame.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Instant::now();
    }

    pub fn idle_for(&self) -> Duration {
        self.last_frame.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).elapsed()
    }

    pub fn close(&self) {
        self.closed.cancel();
        self.relays.close_all();
    }

    pub fn is_closed(&self) -> bool {
        self.closed.is_cancelled()
    }

    /// Resolves when the link is closed.
    pub async fn closed(&self) {
        self.closed.cancelled().await;
    }

    pub fn token(&self) -> CancellationToken {
        self.closed.clone()
    }
}

// ---- the table ----

/// What the peer manager knows about one member.
#[derive(Debug, Clone, Default)]
pub struct PeerStatus {
    pub online: bool,
    pub direction: Option<Direction>,
    pub scopes: Vec<Scope>,
    pub since: Option<Instant>,
    pub last_seen: Option<DateTime<Utc>>,
    pub presence: Option<PeerPresence>,
    pub last_error: Option<String>,
    /// Consecutive failed attempts; the next wait is `backoff_min * 2^failures`, capped.
    pub failures: u32,
}

/// A machine that answered the well-known endpoint and is not a member.
#[derive(Debug, Clone)]
pub struct FoundEntry {
    pub node: TsNode,
    pub whois: Option<Whois>,
    pub descriptor: WellKnown,
    pub port: u16,
    pub probed_at: Instant,
}

#[derive(Default)]
struct PeersInner {
    links: HashMap<String, Arc<PeerLink>>,
    status: HashMap<String, PeerStatus>,
    next_attempt: HashMap<String, Instant>,
    found: HashMap<String, FoundEntry>,
    /// Nodes probed recently, answered or not.
    probed: HashMap<String, Instant>,
    /// The tailnet's online set when the worker last looked.
    signature: String,
}

#[derive(Default)]
pub struct Peers {
    inner: Mutex<PeersInner>,
}

impl Peers {
    fn lock(&self) -> MutexGuard<'_, PeersInner> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The open link to a member.
    pub fn link(&self, machine_id: &str) -> Option<Arc<PeerLink>> {
        self.lock().links.get(machine_id).filter(|link| !link.is_closed()).cloned()
    }

    pub fn links(&self) -> Vec<Arc<PeerLink>> {
        self.lock().links.values().filter(|link| !link.is_closed()).cloned().collect()
    }

    pub fn status(&self, machine_id: &str) -> PeerStatus {
        let inner = self.lock();
        let mut status = inner.status.get(machine_id).cloned().unwrap_or_default();
        let link = inner.links.get(machine_id).filter(|link| !link.is_closed());
        status.online = link.is_some();
        status.direction = link.map(|link| link.direction);
        status.scopes = link.map(|link| link.scopes.clone()).unwrap_or_default();
        status.since = link.map(|link| link.opened_at);
        status
    }

    /// Machines found on the tailnet that are not members, newest answers only.
    pub fn found(&self) -> Vec<FoundEntry> {
        self.lock().found.values().cloned().collect()
    }

    /// Register a link. A second link to the same member replaces the first, which is closed.
    pub fn register(&self, link: Arc<PeerLink>) {
        let old = {
            let mut inner = self.lock();
            let status = inner.status.entry(link.machine_id.clone()).or_default();
            status.last_seen = Some(Utc::now());
            status.last_error = None;
            inner.links.insert(link.machine_id.clone(), link)
        };
        if let Some(old) = old {
            old.close();
        }
    }

    /// Forget a link that ended. Only the link itself is removed; a newer one stays.
    pub fn unregister(&self, link: &Arc<PeerLink>, error: Option<String>) {
        let mut inner = self.lock();
        if inner.links.get(&link.machine_id).is_some_and(|current| Arc::ptr_eq(current, link)) {
            inner.links.remove(&link.machine_id);
            let lived = link.opened_at.elapsed();
            let status = inner.status.entry(link.machine_id.clone()).or_default();
            status.last_seen = Some(Utc::now());
            status.presence = None;
            if error.is_some() {
                status.last_error = error;
            }
            // A link that survived a couple of heartbeats was a good one: backoff starts over.
            if lived > Duration::from_secs(10) {
                status.failures = 0;
            }
        }
    }

    pub fn set_presence(&self, machine_id: &str, presence: PeerPresence) {
        let mut inner = self.lock();
        let status = inner.status.entry(machine_id.to_string()).or_default();
        status.presence = Some(presence);
        status.last_seen = Some(Utc::now());
    }

    /// Close the link to a member, if any (removal, a tampered operation, the network turned off).
    pub fn close(&self, machine_id: &str) {
        let link = self.lock().links.remove(machine_id);
        if let Some(link) = link {
            link.close();
        }
    }

    pub fn close_all(&self) {
        let links: Vec<_> = self.lock().links.drain().map(|(_, link)| link).collect();
        for link in links {
            link.close();
        }
    }

    /// Push operations to every connected member except `except`, in the background (§2.3).
    pub fn gossip(&self, ops: Vec<OpEnvelope>, except: Option<&str>) {
        if ops.is_empty() {
            return;
        }
        for link in self.links() {
            if Some(link.machine_id.as_str()) == except {
                continue;
            }
            let ops = ops.clone();
            tokio::spawn(async move {
                if let Err(error) = link.call::<PeerOpsPush>(PeerOpsPushParams { ops }).await {
                    tracing::debug!(target: SESSION_TARGET, machine = %link.machine_id, %error.message, "could not push operations");
                }
            });
        }
    }

    fn fail(&self, machine_id: &str, timing: &super::Timing, error: String) {
        let mut inner = self.lock();
        let status = inner.status.entry(machine_id.to_string()).or_default();
        status.failures = status.failures.saturating_add(1);
        status.last_error = Some(error);
        let wait = backoff(timing, status.failures);
        inner.next_attempt.insert(machine_id.to_string(), Instant::now() + wait);
    }

    fn due(&self, machine_id: &str) -> bool {
        self.lock().next_attempt.get(machine_id).is_none_or(|at| Instant::now() >= *at)
    }

    /// When the soonest scheduled attempt is due.
    fn soonest_retry(&self) -> Option<Duration> {
        let now = Instant::now();
        self.lock().next_attempt.values().filter(|at| **at > now).map(|at| *at - now).min()
    }

    fn reset_backoff(&self) {
        let mut inner = self.lock();
        inner.next_attempt.clear();
        for status in inner.status.values_mut() {
            status.failures = 0;
        }
    }
}

/// `backoff_min * 2^(failures - 1)`, capped: 2, 4, 8 … 300 s with the defaults.
pub fn backoff(timing: &super::Timing, failures: u32) -> Duration {
    let exponent = failures.saturating_sub(1).min(16);
    timing.backoff_min.saturating_mul(1u32 << exponent).min(timing.backoff_max)
}

// ---- operations arriving from a peer ----

impl Network {
    /// Take operations a peer sent, close its session if they were forged, drop removed machines,
    /// and re-gossip what was new (§2.3, §2.5).
    pub fn apply_remote(&self, from: Option<&str>, ops: Vec<OpEnvelope>) -> Result<ApplyOutcome, MembershipError> {
        let membership = self.membership().ok_or(MembershipError::NoNetwork)?;
        let outcome = membership.apply_ops(ops)?;
        self.after_apply(from, &outcome);
        Ok(outcome)
    }

    /// The consequences of an applied batch. N4 calls it for operations it applied itself, with
    /// `from: None`.
    pub fn after_apply(&self, from: Option<&str>, outcome: &ApplyOutcome) {
        if outcome.tampered() {
            tracing::warn!(target: TARGET, peer = ?from, "a peer sent a membership operation that does not verify; closing its session");
            if let Some(from) = from {
                self.peers.close(from);
            }
        }
        for machine in &outcome.removed {
            self.drop_machine(machine);
        }
        if outcome.self_removed {
            tracing::warn!(target: TARGET, "this machine was removed from its network");
            self.peers.close_all();
        }
        if outcome.changed() {
            self.peers.gossip(outcome.accepted.clone(), from);
            self.notify_changed();
            self.wake();
        }
    }

    /// Close every session with a machine and revoke every grant it holds (§2.5).
    pub fn drop_machine(&self, machine_id: &str) {
        self.peers.close(machine_id);
        let revoked = self.grants.revoke_machine(machine_id);
        if !revoked.is_empty() {
            tracing::info!(target: SESSION_TARGET, machine = machine_id, grants = revoked.len(), "revoked the grants of a removed machine");
        }
    }

    /// The presence this machine pushes (§4.1): version and features now; harnesses, load and
    /// battery come with the packages that own them.
    pub fn presence(&self) -> PeerPresence {
        PeerPresence {
            version: env!("CARGO_PKG_VERSION").to_string(),
            network_protocol: NETWORK_PROTOCOL,
            features: self.features(),
            harnesses: Vec::new(),
            load: None,
            battery: None,
            at: Utc::now(),
        }
    }
}

// ---- requests arriving on a link ----

fn parse<T: serde::de::DeserializeOwned>(params: Value) -> Result<T, RpcError> {
    serde_json::from_value(if params.is_null() { serde_json::json!({}) } else { params }).map_err(RpcError::invalid_params)
}

fn ok<T: serde::Serialize>(value: T) -> Result<Value, RpcError> {
    serde_json::to_value(value).map_err(RpcError::internal)
}

/// Answer one `peer.*` request. The caller has already checked the method's scope.
pub async fn dispatch(state: &AppState, link: &Arc<PeerLink>, method: &str, params: Value) -> Result<Value, RpcError> {
    let network = &state.network;
    match method {
        PeerOpsSync::NAME => {
            let theirs: PeerOpsSyncParams = parse(params)?;
            let membership = network.membership().ok_or_else(|| RpcError::new(codes::NOT_AVAILABLE, "no network"))?;
            ok(membership.sync_respond(&theirs))
        }
        PeerOpsPush::NAME => {
            let push: PeerOpsPushParams = parse(params)?;
            let outcome = network
                .apply_remote(Some(&link.machine_id), push.ops)
                .map_err(|error| RpcError::new(codes::CONFLICT, error.to_string()))?;
            ok(PeerOpsPushResult { accepted: outcome.accepted.len() as u32, rejected: outcome.rejected.len() as u32 })
        }
        PeerPresenceMethod::NAME => {
            let presence: PeerPresence = parse(params)?;
            network.peers.set_presence(&link.machine_id, presence);
            network.notify_changed();
            ok(Empty {})
        }
        PeerRelayOpen::NAME => super::relay::handle_open(state, link, parse(params)?).await,
        PeerRelayData::NAME => super::relay::handle_data(link, parse(params)?).await,
        PeerRelayClose::NAME => super::relay::handle_close(link, parse(params)?),
        // The device-token mint and revoke fan-out are N4's.
        PeerClientTokenMint::NAME | PeerDeviceRevoke::NAME => {
            Err(RpcError::new(codes::NOT_AVAILABLE, format!("{method} is not available yet in this build.")))
        }
        _ => Err(RpcError::method_not_found(method)),
    }
}

/// What a peer may use right now: for a dialed link, this machine's policy for it; for an accepted
/// one, the grant's scopes narrowed by the same policy, so a register turned off after the grant
/// was issued takes effect at once. A removed or paused member keeps `machine:peer` only if paused.
pub fn effective_scopes(network: &Network, link: &PeerLink) -> Vec<Scope> {
    let policy = network.policy_scopes(&link.machine_id);
    match link.direction {
        Direction::Dialed => policy,
        Direction::Accepted => link.scopes.iter().copied().filter(|scope| policy.contains(scope)).collect(),
    }
}

/// Handle one text frame from a peer: an answer to our request, a request, or a notification.
pub async fn inbound(state: &AppState, link: &Arc<PeerLink>, text: &str) {
    link.touch();
    let Ok(value) = serde_json::from_str::<Value>(text) else { return };
    if value.get("method").is_none() {
        if let Ok(response) = serde_json::from_value::<RpcResponse>(value) {
            link.deliver(response);
        }
        return;
    }
    let id = value.get("id").and_then(|id| serde_json::from_value::<RpcId>(id.clone()).ok());
    let method = value["method"].as_str().unwrap_or_default().to_string();
    let params = value.get("params").cloned().unwrap_or(Value::Null);
    // Relay data is hot and ordered: it is handled inline. Other requests run on their own task,
    // bounded per link.
    let ordered = method == PeerRelayData::NAME || method == PeerRelayClose::NAME;
    let state = state.clone();
    let link = link.clone();
    let busy_link = link.clone();
    let busy_id = id.clone();
    let inbound = link.inbound.clone();
    let work = async move {
        let result = match scope_for(&method) {
            Some(Some(scope)) if method.starts_with("peer.") => {
                if effective_scopes(&state.network, &link).contains(&scope) {
                    dispatch(&state, &link, &method, params).await
                } else {
                    Err(RpcError::forbidden(scope.as_str()))
                }
            }
            _ => Err(RpcError::method_not_found(&method)),
        };
        if let Some(id) = id {
            link.respond(match result {
                Ok(value) => RpcResponse::ok(id, value),
                Err(error) => RpcResponse::err(id, error),
            })
            .await;
        }
    };
    if ordered {
        work.await;
    } else if let Ok(permit) = inbound.try_acquire_owned() {
        tokio::spawn(async move {
            let _permit = permit;
            work.await;
        });
    } else if let Some(id) = busy_id {
        busy_link.respond(RpcResponse::err(id, RpcError::internal("too many concurrent requests on this session"))).await;
    }
}

/// After a link opens: compare membership and exchange what each side lacks, then say who we are.
async fn after_open(state: &AppState, link: &Arc<PeerLink>, dialer: bool) {
    let network = &state.network;
    let Some(membership) = network.membership() else { return };
    if dialer {
        match link.call::<PeerOpsSync>(membership.sync_request()).await {
            Ok(theirs) => {
                if !theirs.ops.is_empty()
                    && let Err(error) = network.apply_remote(Some(&link.machine_id), theirs.ops)
                {
                    tracing::warn!(target: SESSION_TARGET, machine = %link.machine_id, %error, "could not apply the peer's operations");
                }
                let lacking = membership.ops_since(&theirs.ids);
                if !lacking.is_empty() {
                    let _ = link.call::<PeerOpsPush>(PeerOpsPushParams { ops: lacking }).await;
                }
            }
            Err(error) => tracing::warn!(target: SESSION_TARGET, machine = %link.machine_id, %error.message, "operation sync failed"),
        }
    }
    let _ = link.notify(PeerPresenceMethod::NAME, serde_json::to_value(network.presence()).unwrap_or(Value::Null)).await;
}

/// A session the other machine opened to us: register it and send our side of the opening.
/// Called by the WebSocket layer once the grant has authenticated the upgrade.
pub fn accept(state: &AppState, link: Arc<PeerLink>) {
    state.network.peers.register(link.clone());
    state.network.notify_changed();
    tracing::info!(target: SESSION_TARGET, machine = %link.machine_id, "accepted a session");
    let state = state.clone();
    tokio::spawn(async move { after_open(&state, &link, false).await });
}

/// An accepted link ended.
pub fn accepted_ended(state: &AppState, link: &Arc<PeerLink>) {
    link.close();
    state.network.peers.unregister(link, None);
    state.network.notify_changed();
    // A session that dropped is looked at once (§3.1).
    state.network.wake();
}

// ---- dialing ----

fn candidate_ports(descriptor_port: Option<u16>) -> Vec<u16> {
    match descriptor_port {
        Some(port) => vec![port],
        None => PORT_RANGE.collect(),
    }
}

async fn tcp_connect(network: &Network, addr: SocketAddr) -> std::io::Result<tokio::net::TcpStream> {
    let socket = if addr.is_ipv4() { tokio::net::TcpSocket::new_v4()? } else { tokio::net::TcpSocket::new_v6()? };
    if let Some(source) = network.tailscale.dial_source()
        && source.is_ipv4() == addr.is_ipv4()
    {
        socket.bind(SocketAddr::new(source, 0))?;
    }
    tokio::time::timeout(Duration::from_secs(10), socket.connect(addr)).await.map_err(|_| std::io::ErrorKind::TimedOut)?
}

/// Open the WebSocket of an established session.
async fn connect_socket(
    network: &Network,
    target: &Target,
    token: &str,
) -> Result<tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>, String> {
    let ip = network.tailscale.dial_target(target.ts_ip);
    let addr = SocketAddr::new(ip, target.port);
    let stream = tcp_connect(network, addr).await.map_err(|error| format!("could not connect the session socket: {error}"))?;
    let mut request = target.ws_url(network).into_client_request().map_err(|error| error.to_string())?;
    let header = HeaderValue::from_str(&format!("Bearer {token}")).map_err(|error| error.to_string())?;
    request.headers_mut().insert(AUTHORIZATION, header);
    let (socket, _) =
        tokio_tungstenite::client_async(request, stream).await.map_err(|error| format!("the session socket was refused: {error}"))?;
    Ok(socket)
}

/// Dial a member: verify it, open a session, connect and run the link until it ends. Returns when
/// the link is registered (the run continues on its own tasks) or the attempt failed.
async fn dial(state: &AppState, member: &str, node: &TsNode) -> Result<(), String> {
    let network = &state.network;
    let membership = network.membership().ok_or("the network is unavailable")?;
    let projection = membership.projection();
    let entry = projection.entry(member).filter(|entry| entry.removed.is_none()).ok_or("not a member")?;
    let ip = node.ip().ok_or("the node has no tailnet address")?;
    let wanted: Vec<Scope> = Scope::MACHINE_DEFAULT.to_vec();
    let mut last = String::from("no listener answered");
    for port in candidate_ports(entry.descriptor.port) {
        let target = Target { machine_id: member.to_string(), signing_key: entry.descriptor.signing_key.clone(), ts_ip: ip, port };
        match session::open(network, membership, &target, &wanted, None).await {
            Ok(established) => {
                let socket = connect_socket(network, &target, &established.token).await?;
                run_dialed(state.clone(), target, established, socket);
                return Ok(());
            }
            // Nothing listens on this port: try the next one the peer may have taken (§3.1).
            Err(session::SessionError::Identity(well_known::ProbeError::Unreachable(reason))) => last = reason,
            Err(error) => return Err(error.to_string()),
        }
    }
    Err(last)
}

/// Ping every `ping_every`; a link that has heard nothing for `dead_after` (three missed pings) is
/// closed, which the reader turns into an offline peer and a reconnect with backoff.
pub(super) fn spawn_heartbeat(link: Arc<PeerLink>, timing: super::Timing, ping: mpsc::Sender<()>) {
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = link.closed() => break,
                _ = tokio::time::sleep(timing.ping_every) => {}
            }
            if link.idle_for() > timing.dead_after {
                tracing::warn!(target: SESSION_TARGET, machine = %link.machine_id, "the peer missed its heartbeats; closing the session");
                link.close();
                break;
            }
            let _ = ping.try_send(());
        }
    });
}

fn run_dialed(
    state: AppState,
    target: Target,
    established: session::Established,
    socket: tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
) {
    let (mut sink, mut stream) = socket.split();
    let (out_tx, mut out_rx) = mpsc::channel::<String>(256);
    let link = PeerLink::new(
        target.machine_id.clone(),
        Direction::Dialed,
        None,
        established.scopes.clone(),
        Arc::new(ChannelSink(out_tx.clone())),
    );
    let timing = state.network.timing.clone();
    let (ping_tx, mut ping_rx) = mpsc::channel::<()>(1);

    // Writer: text frames and pings.
    let writer_link = link.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = writer_link.closed() => break,
                text = out_rx.recv() => match text {
                    Some(text) => if sink.send(Message::Text(text.into())).await.is_err() { break },
                    None => break,
                },
                ping = ping_rx.recv() => match ping {
                    Some(()) => if sink.send(Message::Ping(Vec::new().into())).await.is_err() { break },
                    None => break,
                },
            }
        }
        let _ = sink.close().await;
        writer_link.close();
    });

    // Heartbeat: a ping every interval; three missed ones and the link is dead.
    spawn_heartbeat(link.clone(), timing.clone(), ping_tx);

    // Renewal: a new signed request names the grant, so the socket keeps its authority (§3.3).
    let renew_state = state.clone();
    let renew_link = link.clone();
    let renew_target = target.clone();
    let grant_id = established.grant_id.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = renew_link.closed() => break,
                _ = tokio::time::sleep(renew_state.network.timing.renew_after) => {}
            }
            let Some(membership) = renew_state.network.membership() else { break };
            let wanted = Scope::MACHINE_DEFAULT.to_vec();
            if let Err(error) = session::open(&renew_state.network, membership, &renew_target, &wanted, Some(&grant_id)).await {
                tracing::warn!(target: SESSION_TARGET, machine = %renew_link.machine_id, %error, "could not renew the session; reconnecting");
                renew_link.close();
                break;
            }
        }
    });

    // Reader: answers, requests and pongs. When it ends the link is over.
    let reader_state = state.clone();
    let reader_link = link.clone();
    tokio::spawn(async move {
        let mut error = None;
        loop {
            tokio::select! {
                _ = reader_link.closed() => break,
                frame = stream.next() => match frame {
                    Some(Ok(Message::Text(text))) => inbound(&reader_state, &reader_link, text.as_str()).await,
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => reader_link.touch(),
                    Some(Err(failure)) => { error = Some(failure.to_string()); break }
                }
            }
        }
        reader_link.close();
        reader_state.network.peers.unregister(&reader_link, error);
        reader_state.network.notify_changed();
        // A session that dropped is looked at once.
        reader_state.network.wake();
    });

    state.network.peers.register(link.clone());
    state.network.notify_changed();
    tracing::info!(target: SESSION_TARGET, machine = %link.machine_id, "opened a session");
    tokio::spawn(async move { after_open(&state, &link, true).await });
}

// ---- the worker ----

/// A fingerprint of who is online, to notice that the tailnet changed.
fn signature(status: &TsStatus) -> String {
    let mut online: Vec<&str> = status.peers.iter().filter(|peer| peer.online).map(|peer| peer.node_id.as_str()).collect();
    online.sort_unstable();
    format!("{}|{}", status.running, online.join(","))
}

/// The background worker: runs a pass, then waits for the next tick, a retry that is due, or a
/// wake-up. It ends with the daemon.
pub async fn run(state: AppState) {
    let network = state.network.clone();
    loop {
        let retry = pass(&state).await;
        let tick = if network.is_watching() { network.timing.tick_watching } else { network.timing.tick_idle };
        let wait = retry.map_or(tick, |retry| retry.min(tick)).max(Duration::from_millis(20));
        tokio::select! {
            _ = state.shutdown.cancelled() => break,
            _ = tokio::time::sleep(wait) => {}
            _ = network.woken() => {}
        }
    }
    state.network.peers.close_all();
}

/// One pass of the worker. Returns when the next scheduled retry is due.
pub async fn pass(state: &AppState) -> Option<Duration> {
    let network = &state.network;
    let enabled = state.settings.get().network.enabled;
    network.set_enabled(enabled);
    crate::exposure::apply_network(state, enabled).await;
    let membership = network.membership()?;
    if !enabled {
        network.peers.close_all();
        return None;
    }
    let status = match network.tailscale.status().await {
        Ok(status) if status.running => status,
        _ => return None,
    };
    let sig = signature(&status);
    let changed = {
        let mut inner = network.peers.lock();
        std::mem::replace(&mut inner.signature, sig.clone()) != sig
    };
    if changed {
        // A tailnet change is the moment an unreachable peer may have become reachable.
        network.peers.reset_backoff();
        network.notify_changed();
    }

    let me = membership.machine_id();
    if membership.self_is_member() {
        let projection = membership.projection();
        let mut dials = Vec::new();
        for (id, entry) in projection.members() {
            // The member with the smaller id dials (§3.3); a paused member gets no session.
            if *id == me || entry.paused || me.as_str() > id.as_str() || network.peers.link(id).is_some() || !network.peers.due(id) {
                continue;
            }
            let node = entry.descriptor.ts_node_id.as_deref().and_then(|node_id| status.peer(node_id));
            match node {
                Some(node) if node.online && node.ip().is_some() => dials.push((id.clone(), node.clone())),
                _ => network.peers.fail_quiet(id, "not online on the tailnet"),
            }
        }
        let results = futures::stream::iter(dials)
            .map(|(id, node)| async move {
                let result = dial(state, &id, &node).await;
                (id, result)
            })
            .buffer_unordered(MAX_CONCURRENT_PROBES)
            .collect::<Vec<_>>()
            .await;
        for (id, result) in results {
            if let Err(error) = result {
                tracing::debug!(target: SESSION_TARGET, machine = %id, %error, "could not open a session");
                network.peers.fail(&id, &network.timing, error);
            }
        }
    }

    discover(state, &status).await;
    network.peers.soonest_retry()
}

impl Peers {
    /// Note why a member cannot be dialed without counting it as a failed attempt: the status
    /// change that brings it back resets the schedule anyway.
    fn fail_quiet(&self, machine_id: &str, reason: &str) {
        let mut inner = self.lock();
        inner.status.entry(machine_id.to_string()).or_default().last_error = Some(reason.to_string());
    }
}

/// Probe online peers that are not members for the well-known endpoint (§3.1).
async fn discover(state: &AppState, status: &TsStatus) {
    let network = &state.network;
    let Some(membership) = network.membership() else { return };
    let projection = membership.projection();
    let ttl = network.timing.found_ttl;
    let candidates: Vec<TsNode> = {
        let mut inner = network.peers.lock();
        // Members and tombstoned nodes are never "found"; nodes that left the tailnet are dropped.
        let known: Vec<String> = projection.members().filter_map(|(_, entry)| entry.descriptor.ts_node_id.clone()).collect();
        inner.found.retain(|node_id, _| !known.contains(node_id) && status.peer(node_id).is_some_and(|peer| peer.online));
        inner.probed.retain(|_, at| at.elapsed() < ttl);
        status
            .peers
            .iter()
            .filter(|peer| peer.online && peer.ip().is_some() && !peer.node_id.is_empty())
            .filter(|peer| !known.contains(&peer.node_id) && !projection.is_node_tombstoned(&peer.node_id))
            .filter(|peer| !inner.probed.contains_key(&peer.node_id))
            .cloned()
            .collect()
    };
    if candidates.is_empty() {
        return;
    }
    {
        let mut inner = network.peers.lock();
        for peer in &candidates {
            inner.probed.insert(peer.node_id.clone(), Instant::now());
        }
    }
    let found = futures::stream::iter(candidates)
        .map(|node| async move { probe_node(state, node).await })
        .buffer_unordered(MAX_CONCURRENT_PROBES)
        .collect::<Vec<_>>()
        .await;
    let mut changed = false;
    {
        let mut inner = network.peers.lock();
        for entry in found.into_iter().flatten() {
            tracing::debug!(target: DISCOVERY_TARGET, machine = %entry.descriptor.machine_id, node = %entry.node.node_id, "found a machine on the tailnet");
            changed |= inner.found.insert(entry.node.node_id.clone(), entry).is_none();
        }
    }
    if changed {
        network.notify_changed();
    }
}

async fn probe_node(state: &AppState, node: TsNode) -> Option<FoundEntry> {
    let network = &state.network;
    let ip = node.ip()?;
    let dial_ip = network.tailscale.dial_target(ip);
    let timeout = if dial_ip.is_loopback() { Duration::from_secs(3) } else { Duration::from_secs(10) };
    for port in PORT_RANGE {
        match well_known::probe(&network.http, &well_known::base_url(dial_ip, port), None, timeout, network.timing.clock_window).await {
            Ok(descriptor) => {
                let whois = network.tailscale.whois(ip).await.ok();
                return Some(FoundEntry { node, whois, descriptor, port, probed_at: Instant::now() });
            }
            // Nothing there, or not Kybern: stop at the first answer, try the next port otherwise.
            Err(_) => continue,
        }
    }
    None
}

/// The address a probe or session actually uses for a tailnet peer, for the doctor and the tests.
pub fn dial_address(network: &Network, ts_ip: IpAddr, port: u16) -> SocketAddr {
    SocketAddr::new(network.tailscale.dial_target(ts_ip), port)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::network::Timing;

    #[test]
    fn backoff_doubles_from_two_seconds_to_five_minutes() {
        let timing = Timing::default();
        let waits: Vec<u64> = (1..=10).map(|failures| backoff(&timing, failures).as_secs()).collect();
        assert_eq!(waits, [2, 4, 8, 16, 32, 64, 128, 256, 300, 300]);
        assert_eq!(backoff(&timing, 0).as_secs(), 2);
        assert_eq!(backoff(&timing, u32::MAX).as_secs(), 300);
    }

    #[test]
    fn a_peers_ports_are_the_descriptors_or_the_default_range() {
        assert_eq!(candidate_ports(Some(4180)), vec![4180]);
        assert_eq!(candidate_ports(None), vec![4173, 4174, 4175, 4176, 4177, 4178, 4179]);
    }
}
