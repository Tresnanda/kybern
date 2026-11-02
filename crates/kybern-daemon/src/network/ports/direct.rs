//! Separate TCP sockets for port bytes. Authorization stays on the authenticated peer session.
//!
//! A forward's caller dials the target's per-forward listener on its Tailscale address and sends the 64-byte token; the
//! target checks it and who the connection comes from (`tailscale whois`), then answers one byte.
//!
//! * Version 1 (`ports.direct.v1`): the target connects to the dev server before it answers, and the socket carries raw
//!   bytes from then on. Each browser connection costs those two round trips.
//! * Version 2 (`ports.direct.v2`, asked for in `peer.ports.prepare`): the target answers as soon as the caller is
//!   authorized, and the socket then waits for a mode byte. The caller keeps a few such sockets ready ([`WarmPool`]), so a
//!   browser connection costs no round trip before its first bytes. Mode `R` connects the dev server and carries raw
//!   bytes; mode `H` carries one HTTP/2 connection whose requests the target sends over pooled HTTP/1.1 connections to the
//!   dev server (the Fast mode of a preview, [`super::fast`]).
use std::collections::{HashMap, VecDeque};
use std::convert::Infallible;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use http_body_util::{BodyExt, Empty, combinators::BoxBody};
use hyper::body::{Bytes, Incoming};
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::{TokioExecutor, TokioIo, TokioTimer};
use kybern_protocol::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpSocket, TcpStream};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::super::{
    Network,
    peers::{self, PeerLink},
    tailscale,
};
use crate::state::AppState;

const TARGET: &str = "kybern::network::ports";
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(3);
/// How long a source address stays verified for one forward once `whois` named the member's node. Tailscale addresses
/// belong to a node for its lifetime; the per-forward token is checked on every connection regardless.
const VERIFIED_FOR: Duration = Duration::from_secs(10 * 60);
/// An authorized version 2 socket waits this long for its mode byte.
const WARM_WAIT: Duration = Duration::from_secs(60);
/// The caller discards a ready socket older than this, well before the target gives up on it.
const WARM_KEEP: Duration = Duration::from_secs(45);
/// Ready sockets a forward keeps: what a browser opens at once for one origin, less the one it reuses.
const WARM_SOCKETS: usize = 4;
/// A forward keeps sockets ready for this long after its last connection.
const WARM_WHILE_ACTIVE: Duration = Duration::from_secs(10 * 60);
/// How long a connection waits for a place under the stream limits before it is refused.
pub(super) const QUEUE_WAIT: Duration = Duration::from_secs(10);

pub const MODE_RAW: u8 = b'R';
pub const MODE_HTTP2: u8 = b'H';
const ACK: u8 = 1;

struct Serving {
    id: Uuid,
    link: Arc<PeerLink>,
    cancel: CancellationToken,
    version: u8,
    /// Source addresses `whois` already named as the member's node, and when.
    verified: Mutex<HashMap<IpAddr, Instant>>,
}

#[derive(Default)]
pub struct Listeners(Mutex<Vec<Arc<Serving>>>);

impl Listeners {
    pub fn close_all(&self) {
        for serving in self.0.lock().unwrap_or_else(|p| p.into_inner()).drain(..) {
            serving.cancel.cancel();
        }
    }

    pub fn release(&self, machine: &str, id: Uuid) {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).retain(|s| {
            let keep = s.link.machine_id != machine || s.id != id;
            if !keep {
                s.cancel.cancel();
            }
            keep
        });
    }

    pub fn close_unpermitted(&self, network: &Network) {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).retain(|s| {
            let keep = authorized(network, &s.link);
            if !keep {
                s.cancel.cancel();
            }
            keep
        });
    }
}

fn authorized(network: &Network, link: &PeerLink) -> bool {
    network.is_enabled()
        && !link.is_closed()
        && link.grant_id.is_none_or(|id| network.grants.is_active(id))
        && peers::effective_scopes(network, link).contains(&Scope::MachinePorts)
}

/// A destination is always obtained from the peer's recorded Tailscale node, never an RPC URL.
pub async fn destination(network: &Network, machine: &str, port: u16) -> Option<SocketAddr> {
    let node = network.membership()?.projection().entry(machine)?.descriptor.ts_node_id.clone()?;
    let status = network.tailscale.status().await.ok()?;
    let peer = status.peer(&node)?;
    if !status.running || !peer.online || network.tailscale.listen_ip().await.is_none() {
        return None;
    }
    let ip = peer.ip()?;
    if !tailscale::plain_http_allowed(ip, network.tailscale.is_fake()) {
        return None;
    }
    Some(SocketAddr::new(network.tailscale.dial_target(ip), port))
}

pub async fn prepare(state: &AppState, link: &Arc<PeerLink>, request: PeerPortsPrepareParams) -> Result<PeerPortsPrepareResult, RpcError> {
    super::validate_port(state, request.port)?;
    let network = &state.network;
    if !authorized(network, link) {
        return Err(RpcError::new(codes::FORBIDDEN, "This machine no longer permits port forwarding."));
    }
    let node = network.membership().and_then(|m| m.projection().entry(&link.machine_id).and_then(|e| e.descriptor.ts_node_id.clone()));
    let Some(node) = node else {
        return Ok(PeerPortsPrepareResult { direct: None });
    };
    let Some(ip) = network.tailscale.listen_ip().await.filter(|ip| tailscale::plain_http_allowed(*ip, network.tailscale.is_fake())) else {
        return Ok(PeerPortsPrepareResult { direct: None });
    };
    let listener = match TcpListener::bind(SocketAddr::new(ip, 0)).await {
        Ok(listener) => listener,
        Err(_) => return Ok(PeerPortsPrepareResult { direct: None }),
    };
    let port = listener.local_addr().map_err(RpcError::internal)?.port();
    let token = crate::auth::hash(&crate::auth::generate());
    let token_hash = crate::auth::hash(&token);
    let version = if request.direct_version.unwrap_or(1) >= 2 { 2 } else { 1 };
    let serving = Arc::new(Serving {
        id: request.forward_id,
        link: link.clone(),
        cancel: CancellationToken::new(),
        version,
        verified: Mutex::default(),
    });
    {
        let mut held = network.ports.direct.0.lock().unwrap_or_else(|p| p.into_inner());
        held.retain(|s| !s.cancel.is_cancelled() && !s.link.is_closed());
        if held.len() >= MAX_PORT_FORWARDS * 16 || held.iter().filter(|s| s.link.machine_id == link.machine_id).count() >= MAX_PORT_FORWARDS
        {
            return Err(RpcError::new(codes::CONFLICT, "Too many direct port forwards. Stop one first."));
        }
        if held.iter().any(|s| s.link.machine_id == link.machine_id && s.id == request.forward_id) {
            return Err(RpcError::new(codes::CONFLICT, "That forward is already open."));
        }
        held.push(serving.clone());
    }
    let state = state.clone();
    tokio::spawn(async move {
        let mut idle_since = Instant::now();
        let active = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let idle_limit = state.network.timing.ports_idle;
        let tick = (idle_limit / 4).clamp(Duration::from_millis(50), Duration::from_secs(30));
        loop {
            tokio::select! {
                _ = serving.cancel.cancelled() => break,
                _ = serving.link.closed() => break,
                _ = state.shutdown.cancelled() => break,
                _ = tokio::time::sleep(tick) => {
                    if !authorized(&state.network, &serving.link) { break; }
                    if active.load(std::sync::atomic::Ordering::Relaxed) > 0 { idle_since = Instant::now(); }
                    else if idle_since.elapsed() >= idle_limit { break; }
                }
                accepted = listener.accept() => {
                    let Ok((socket, source)) = accepted else { continue; };
                    let _ = socket.set_nodelay(true);
                    idle_since = Instant::now();
                    let (state, serving, node, token_hash, active) = (state.clone(), serving.clone(), node.clone(), token_hash.clone(), active.clone());
                    tokio::spawn(async move {
                        // Over the limit, a connection waits for a place instead of being dropped.
                        let key = format!("inbound:{}", serving.link.machine_id);
                        let Some(slot) = state.network.relays.acquire_wait(&key, crate::network::relay::MAX_STREAMS_PER_CLIENT, QUEUE_WAIT, &serving.cancel).await else {
                            tracing::debug!(target: TARGET, machine = %serving.link.machine_id, "refused a direct connection: no place under the stream limit");
                            return;
                        };
                        let _slot = slot;
                        active.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        transfer(&state, &serving, socket, source.ip(), &node, &token_hash, request.port).await;
                        active.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
                    });
                }
            }
        }
        serving.cancel.cancel();
        state.network.ports.direct.0.lock().unwrap_or_else(|p| p.into_inner()).retain(|held| !Arc::ptr_eq(held, &serving));
    });
    Ok(PeerPortsPrepareResult { direct: Some(PeerPortsDirect { port, token, version: (version == 2).then_some(2) }) })
}

/// The connection comes from the member's node: an address `whois` named recently for this forward, or `whois` now.
async fn verify_source(state: &AppState, serving: &Serving, source: IpAddr, node: &str) -> bool {
    if serving.verified.lock().unwrap_or_else(|p| p.into_inner()).get(&source).is_some_and(|at| at.elapsed() < VERIFIED_FOR) {
        return true;
    }
    let Ok(who) = state.network.tailscale.whois(source).await else { return false };
    if who.node_id != node {
        return false;
    }
    serving.verified.lock().unwrap_or_else(|p| p.into_inner()).insert(source, Instant::now());
    true
}

async fn transfer(state: &AppState, serving: &Serving, mut socket: TcpStream, source: IpAddr, node: &str, token_hash: &str, port: u16) {
    let link = &serving.link;
    let ended = async {
        tokio::select! {
            _ = serving.cancel.cancelled() => {},
            _ = link.closed() => {},
        }
    };
    tokio::pin!(ended);
    let authorize = async {
        let mut token = [0u8; 64];
        socket.read_exact(&mut token).await.ok()?;
        let token = std::str::from_utf8(&token).ok()?;
        if crate::auth::hash(token) != token_hash {
            return None;
        }
        if !verify_source(state, serving, source, node).await
            || !authorized(&state.network, link)
            || super::own_ports(state).contains(&port)
        {
            return None;
        }
        Some(())
    };
    let authorized_now = tokio::select! {
        _ = &mut ended => return,
        result = tokio::time::timeout(HANDSHAKE_TIMEOUT, authorize) => matches!(result, Ok(Some(()))),
    };
    if !authorized_now {
        return;
    }
    let mode = if serving.version >= 2 {
        if socket.write_all(&[ACK]).await.is_err() {
            return;
        }
        // A ready socket: it waits for the caller to use it.
        let mut mode = [0u8; 1];
        let read = tokio::select! {
            _ = &mut ended => return,
            read = tokio::time::timeout(WARM_WAIT, socket.read_exact(&mut mode)) => read,
        };
        match read {
            Ok(Ok(_)) => mode[0],
            _ => return,
        }
    } else {
        MODE_RAW
    };
    match mode {
        MODE_RAW => {
            let upstream = tokio::select! {
                _ = &mut ended => return,
                upstream = super::connect_loopback(port) => upstream,
            };
            let Ok(mut upstream) = upstream else { return };
            let _ = upstream.set_nodelay(true);
            if serving.version < 2 && socket.write_all(&[ACK]).await.is_err() {
                return;
            }
            tokio::select! {
                _ = tokio::io::copy_bidirectional(&mut socket, &mut upstream) => {},
                // A reset, not an end: a plain FIN reads as a half-close, and the client would keep its side open.
                _ = &mut ended => { let _ = socket.set_zero_linger(); },
            }
        }
        MODE_HTTP2 => {
            tokio::select! {
                _ = serve_http2(socket, port) => {},
                _ = &mut ended => {},
            }
        }
        _ => {}
    }
}

// ---- mode H: one HTTP/2 connection, pooled HTTP/1.1 to the dev server ----

pub(super) type ProxyBody = BoxBody<Bytes, hyper::Error>;

pub(super) fn empty_body() -> ProxyBody {
    Empty::<Bytes>::new().map_err(|never| match never {}).boxed()
}

pub(super) fn status_response(status: StatusCode) -> Response<ProxyBody> {
    let mut response = Response::new(empty_body());
    *response.status_mut() = status;
    response
}

/// Headers that belong to one hop (RFC 9110 §7.6.1), and those HTTP/2 forbids.
pub(super) fn strip_hop_headers(headers: &mut hyper::HeaderMap) {
    let named: Vec<String> = headers
        .get_all(hyper::header::CONNECTION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(|token| token.trim().to_ascii_lowercase())
        .filter(|token| !token.is_empty())
        .collect();
    for name in named {
        headers.remove(name.as_str());
    }
    for name in ["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer", "proxy-authorization"] {
        headers.remove(name);
    }
}

/// The address the dev server answers on: `127.0.0.1`, else `::1` (a dev server may listen on either).
async fn loopback_address(port: u16) -> Option<SocketAddr> {
    let socket = super::connect_loopback(port).await.ok()?;
    socket.peer_addr().ok()
}

async fn serve_http2(socket: TcpStream, port: u16) {
    let Some(upstream) = loopback_address(port).await else {
        tracing::debug!(target: TARGET, port, "nothing listens on the forwarded port; the HTTP/2 connection ends");
        return;
    };
    let mut connector = hyper_util::client::legacy::connect::HttpConnector::new();
    connector.set_nodelay(true);
    connector.set_connect_timeout(Some(Duration::from_secs(3)));
    let client: hyper_util::client::legacy::Client<_, Incoming> = hyper_util::client::legacy::Client::builder(TokioExecutor::new())
        .pool_timer(TokioTimer::new())
        .pool_idle_timeout(Duration::from_secs(60))
        .pool_max_idle_per_host(64)
        .build(connector);
    let service = hyper::service::service_fn(move |request: Request<Incoming>| {
        let client = client.clone();
        async move { Ok::<_, Infallible>(to_dev_server(&client, upstream, request).await) }
    });
    let mut builder = hyper::server::conn::http2::Builder::new(TokioExecutor::new());
    builder
        .timer(TokioTimer::new())
        .adaptive_window(true)
        .max_concurrent_streams(1024)
        .max_frame_size(64 * 1024)
        .max_send_buf_size(1024 * 1024)
        .keep_alive_interval(Some(Duration::from_secs(20)))
        .keep_alive_timeout(Duration::from_secs(20));
    if let Err(error) = builder.serve_connection(TokioIo::new(socket), service).await {
        tracing::debug!(target: TARGET, %error, "the HTTP/2 connection of a forward ended");
    }
}

/// One request of the HTTP/2 connection, sent to the dev server over HTTP/1.1. `Host` is the address the browser used
/// (`localhost:<port>`), so host checks such as Vite's `allowedHosts` see what they would see locally.
async fn to_dev_server(
    client: &hyper_util::client::legacy::Client<hyper_util::client::legacy::connect::HttpConnector, Incoming>,
    upstream: SocketAddr,
    request: Request<Incoming>,
) -> Response<ProxyBody> {
    let (mut parts, body) = request.into_parts();
    let authority = parts.uri.authority().map(|authority| authority.to_string());
    let path = parts.uri.path_and_query().map(|pq| pq.as_str().to_string()).unwrap_or_else(|| "/".into());
    let Ok(uri) = format!("http://{upstream}{path}").parse::<hyper::Uri>() else {
        return status_response(StatusCode::BAD_REQUEST);
    };
    strip_hop_headers(&mut parts.headers);
    if !parts.headers.contains_key(hyper::header::HOST)
        && let Some(host) = authority.as_deref().and_then(|host| hyper::header::HeaderValue::from_str(host).ok())
    {
        parts.headers.insert(hyper::header::HOST, host);
    }
    if !parts.headers.contains_key("x-forwarded-proto") {
        parts.headers.insert("x-forwarded-proto", hyper::header::HeaderValue::from_static("https"));
    }
    parts.uri = uri;
    parts.version = hyper::Version::HTTP_11;
    match client.request(Request::from_parts(parts, body)).await {
        Ok(response) => {
            let (mut parts, body) = response.into_parts();
            strip_hop_headers(&mut parts.headers);
            parts.version = hyper::Version::HTTP_2;
            Response::from_parts(parts, body.boxed())
        }
        Err(error) => {
            tracing::debug!(target: TARGET, %error, "the dev server did not answer a forwarded request");
            status_response(StatusCode::BAD_GATEWAY)
        }
    }
}

// ---- the caller ----

/// Dial a forward's listener and authorize: for version 2 the socket is then ready and waits for a mode.
async fn dial(network: &Network, address: SocketAddr, endpoint: &PeerPortsDirect) -> Option<(TcpStream, Duration)> {
    let connect = async {
        let socket = if address.is_ipv4() { TcpSocket::new_v4() } else { TcpSocket::new_v6() }.ok()?;
        if let Some(source) = network.tailscale.dial_source() {
            socket.bind(SocketAddr::new(source, 0)).ok()?;
        }
        let started = Instant::now();
        let mut socket = socket.connect(address).await.ok()?;
        let round_trip = started.elapsed();
        socket.set_nodelay(true).ok()?;
        if endpoint.token.len() != 64 {
            return None;
        }
        socket.write_all(endpoint.token.as_bytes()).await.ok()?;
        if endpoint.version.unwrap_or(1) >= 2 && socket.read_u8().await.ok()? != ACK {
            return None;
        }
        Some((socket, round_trip))
    };
    tokio::time::timeout(HANDSHAKE_TIMEOUT, connect).await.ok().flatten()
}

/// A socket that carries raw bytes to the forwarded port.
pub async fn connect(network: &Network, address: SocketAddr, endpoint: &PeerPortsDirect) -> Option<TcpStream> {
    let (mut socket, _) = dial(network, address, endpoint).await?;
    if endpoint.version.unwrap_or(1) >= 2 {
        socket.write_all(&[MODE_RAW]).await.ok()?;
    } else if tokio::time::timeout(HANDSHAKE_TIMEOUT, socket.read_u8()).await.ok()?.ok()? != ACK {
        return None;
    }
    Some(socket)
}

/// The direct route of one forward, with the sockets it keeps ready (version 2).
pub struct Route {
    pub address: SocketAddr,
    pub endpoint: PeerPortsDirect,
    warm: Mutex<VecDeque<(Instant, TcpStream)>>,
    wanted: Notify,
    last_used: Mutex<Instant>,
}

impl Route {
    pub fn new(address: SocketAddr, endpoint: PeerPortsDirect) -> Self {
        Self { address, endpoint, warm: Mutex::default(), wanted: Notify::new(), last_used: Mutex::new(Instant::now()) }
    }

    pub fn ready_sockets(&self) -> bool {
        self.endpoint.version.unwrap_or(1) >= 2
    }

    /// A ready socket that is still open, if one is kept.
    fn take_ready(&self) -> Option<TcpStream> {
        let mut warm = self.warm.lock().unwrap_or_else(|p| p.into_inner());
        while let Some((at, socket)) = warm.pop_front() {
            if at.elapsed() >= WARM_KEEP {
                continue;
            }
            // A ready socket has nothing to read; a closed one reads an end.
            let mut probe = [0u8; 1];
            match socket.try_read(&mut probe) {
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => return Some(socket),
                _ => continue,
            }
        }
        None
    }

    /// A socket for `mode`: a ready one when kept, else a new one. The pool refills behind it.
    pub async fn open(&self, network: &Network, mode: u8) -> Option<TcpStream> {
        *self.last_used.lock().unwrap_or_else(|p| p.into_inner()) = Instant::now();
        if !self.ready_sockets() {
            return if mode == MODE_RAW { connect(network, self.address, &self.endpoint).await } else { None };
        }
        let socket = match self.take_ready() {
            Some(socket) => Some(socket),
            None => dial(network, self.address, &self.endpoint).await.map(|(socket, _)| socket),
        };
        self.wanted.notify_one();
        let mut socket = socket?;
        socket.write_all(&[mode]).await.ok()?;
        Some(socket)
    }

    /// Dial one ready socket now and keep it; its connect time is the route's round trip.
    pub async fn warm_one(&self, network: &Network) -> Option<Duration> {
        if !self.ready_sockets() {
            return None;
        }
        let (socket, round_trip) = dial(network, self.address, &self.endpoint).await?;
        self.warm.lock().unwrap_or_else(|p| p.into_inner()).push_back((Instant::now(), socket));
        Some(round_trip)
    }

    /// Keep [`WARM_SOCKETS`] ready while the forward is in use, replacing those that grow old, until `cancel`.
    pub async fn keep_warm(self: Arc<Self>, network: Arc<Network>, cancel: CancellationToken) {
        if !self.ready_sockets() {
            return;
        }
        loop {
            let (count, oldest) = {
                let mut warm = self.warm.lock().unwrap_or_else(|p| p.into_inner());
                warm.retain(|(at, _)| at.elapsed() < WARM_KEEP);
                (warm.len(), warm.front().map(|(at, _)| *at))
            };
            let active = self.last_used.lock().unwrap_or_else(|p| p.into_inner()).elapsed() < WARM_WHILE_ACTIVE;
            if active && count < WARM_SOCKETS {
                if self.warm_one(&network).await.is_none() {
                    // The target is not answering; try again a little later rather than spin.
                    tokio::select! {
                        _ = cancel.cancelled() => break,
                        _ = tokio::time::sleep(Duration::from_secs(2)) => {}
                    }
                }
                continue;
            }
            if !active {
                self.warm.lock().unwrap_or_else(|p| p.into_inner()).clear();
            }
            let wait = oldest.map(|at| WARM_KEEP.saturating_sub(at.elapsed())).unwrap_or(WARM_KEEP).max(Duration::from_millis(200));
            tokio::select! {
                _ = cancel.cancelled() => break,
                _ = self.wanted.notified() => {}
                _ = tokio::time::sleep(wait) => {}
            }
        }
        self.warm.lock().unwrap_or_else(|p| p.into_inner()).clear();
    }
}
