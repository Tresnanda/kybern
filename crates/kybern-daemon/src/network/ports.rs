//! Port forwarding between machines (ADE-86 M4 / U3, design §8.3).
//!
//! `ports.forward` binds `127.0.0.1:<local>` here, preferring the remote port then the next free port.
//! New peers authorize once with `peer.ports.prepare`; each connection carries raw bytes on its own
//! Tailscale TCP socket. Older or indirect peers retain the existing `peer.ports.open` relay streams.
//! Both paths require `machine:ports`, connect only to the target's loopback, and preserve half-close.
//!
//! * The target refuses the ports of its own kybernd (its listeners and the default port): a forward is
//!   never a way to reach another machine's daemon without a token.
//! * A forward with no connection for [`super::Timing::ports_idle`] (30 min) closes, and a daemon holds
//!   at most 16.
//! * A preview of a dev server on another machine (`kybern_preview_open { machine }`) starts a forward
//!   and shows `http://localhost:<local>`: the page, its assets and its hot-reload WebSocket are plain
//!   TCP to the browser, so nothing in the page changes.

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use kybern_protocol::methods::*;
use kybern_protocol::*;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::Network;
use super::peers::PeerLink;
use super::relay::{Chunk, Slot, Stream, StreamKind, frame_cost};
use crate::state::AppState;

pub mod direct;

const TARGET: &str = "kybern::network::ports";
const OPEN_TIMEOUT: Duration = Duration::from_secs(15);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
/// A TCP read is cut into frames of this size.
const READ_CHUNK: usize = 16 * 1024;

#[cfg(test)]
#[path = "../previews/network_tests.rs"]
mod preview_rpc_tests;

// ---- this machine: the forwards ----

struct Forward {
    id: Uuid,
    machine_id: String,
    machine_name: String,
    remote_port: u16,
    local_port: u16,
    created_at: chrono::DateTime<chrono::Utc>,
    connections: AtomicU32,
    cancel: CancellationToken,
    direct: Option<(SocketAddr, PeerPortsDirect)>,
    prepared: bool,
}

impl Forward {
    fn view(&self) -> PortForward {
        PortForward {
            id: self.id,
            machine_id: self.machine_id.clone(),
            machine_name: self.machine_name.clone(),
            remote_port: self.remote_port,
            local_port: self.local_port,
            connections: self.connections.load(Ordering::Relaxed),
            created_at: self.created_at,
        }
    }
}

/// The forwards this daemon holds.
#[derive(Default)]
pub struct Forwards {
    list: std::sync::Mutex<Vec<Arc<Forward>>>,
    pub direct: direct::Listeners,
}

impl Forwards {
    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<Arc<Forward>>> {
        self.list.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn views(&self) -> Vec<PortForward> {
        self.lock().iter().map(|forward| forward.view()).collect()
    }

    fn remove(&self, id: Uuid) -> Option<Arc<Forward>> {
        let mut list = self.lock();
        let at = list.iter().position(|forward| forward.id == id)?;
        Some(list.remove(at))
    }

    /// Close every forward (the daemon is shutting down, or the network was turned off).
    pub fn close_all(&self) {
        self.direct.close_all();
        for forward in self.lock().drain(..) {
            forward.cancel.cancel();
        }
    }

    /// Close the forwards that lead to a machine (it was removed).
    pub fn close_machine(&self, machine_id: &str) {
        self.lock().retain(|forward| {
            let keep = forward.machine_id != machine_id;
            if !keep {
                forward.cancel.cancel();
            }
            keep
        });
    }
}

fn announce(network: &Network) {
    let result = PortsListResult { forwards: network.ports.views() };
    network.notify_utility(PORTS_CHANGED_NOTIFICATION, serde_json::to_value(result).unwrap_or(Value::Null));
}

/// `ports.list`.
pub fn list(state: &AppState) -> PortsListResult {
    PortsListResult { forwards: state.network.ports.views() }
}

/// `ports.stop`.
pub fn stop(state: &AppState, id: Uuid) -> Result<PortsListResult, RpcError> {
    let forward = state.network.ports.remove(id).ok_or_else(|| RpcError::not_found("port forward"))?;
    forward.cancel.cancel();
    announce(&state.network);
    Ok(list(state))
}

/// `ports.forward`: bind a loopback port here that leads to a loopback port of `machine`. A second call
/// for the same machine and port returns the forward that exists.
pub async fn forward(state: &AppState, params: PortsForwardParams) -> Result<PortForward, RpcError> {
    let hub = state.orchestrator.remote_hub().ok_or_else(|| RpcError::new(codes::NOT_AVAILABLE, "the machine network is not available"))?;
    let target = hub.resolve(&params.machine).map_err(|message| RpcError::new(codes::NOT_FOUND, message))?;
    forward_to(&state.network, &state.shutdown, &target.id, &target.name, params.remote_port, params.local_port).await
}

/// [`forward`] for a machine already resolved; the agent's preview tool comes through here too.
pub async fn forward_to(
    network: &Arc<Network>,
    shutdown: &CancellationToken,
    machine_id: &str,
    machine_name: &str,
    remote_port: u16,
    local_port: Option<u16>,
) -> Result<PortForward, RpcError> {
    if remote_port == 0 {
        return Err(RpcError::invalid_params("Name a port between 1 and 65535."));
    }
    if let Some(existing) = network.ports.lock().iter().find(|forward| {
        forward.machine_id == machine_id && forward.remote_port == remote_port && local_port.is_none_or(|port| port == forward.local_port)
    }) {
        return Ok(existing.view());
    }
    if network.ports.lock().len() >= MAX_PORT_FORWARDS {
        return Err(RpcError::new(codes::CONFLICT, format!("{MAX_PORT_FORWARDS} ports are forwarded already. Stop one first.")));
    }
    let link = network
        .peers
        .link(machine_id)
        .ok_or_else(|| RpcError::new(codes::NOT_AVAILABLE, format!("{machine_name} is offline, so its ports cannot be forwarded.")))?;
    let id = Uuid::now_v7();
    let capable = network.peers.status(machine_id).presence.is_none_or(|p| p.features.iter().any(|f| f == features::PORTS_DIRECT_V1));
    let (prepared, direct) = if capable {
        match link.call::<PeerPortsPrepare>(PeerPortsPrepareParams { forward_id: id, port: remote_port }).await {
            Ok(result) => {
                let endpoint = match result.direct {
                    Some(endpoint) => direct::destination(network, machine_id, endpoint.port).await.map(|addr| (addr, endpoint)),
                    None => None,
                };
                if endpoint.is_none() {
                    let _ = link.notify(PeerPortsRelease::NAME, json!({"forward_id": id})).await;
                }
                (true, endpoint)
            }
            Err(error) if error.code == codes::METHOD_NOT_FOUND => (false, None),
            Err(error) => return Err(error),
        }
    } else {
        (false, None)
    };
    let listener = match bind_local(remote_port, local_port).await {
        Ok(listener) => listener,
        Err(error) => {
            if prepared {
                let _ = link.notify(PeerPortsRelease::NAME, json!({"forward_id": id})).await;
            }
            return Err(error);
        }
    };
    let bound = listener.local_addr().map_err(RpcError::internal)?.port();
    let forward = Arc::new(Forward {
        id,
        machine_id: machine_id.to_string(),
        machine_name: machine_name.to_string(),
        remote_port,
        local_port: bound,
        created_at: chrono::Utc::now(),
        direct,
        prepared,
        connections: AtomicU32::new(0),
        cancel: CancellationToken::new(),
    });
    let added = {
        let mut list = network.ports.lock();
        if list.len() >= MAX_PORT_FORWARDS {
            false
        } else {
            list.push(forward.clone());
            true
        }
    };
    if !added {
        if prepared {
            let _ = link.notify(PeerPortsRelease::NAME, json!({"forward_id": id})).await;
        }
        return Err(RpcError::new(codes::CONFLICT, format!("{MAX_PORT_FORWARDS} ports are forwarded already. Stop one first.")));
    }
    tokio::spawn(accept_loop(network.clone(), shutdown.clone(), forward.clone(), listener));
    announce(network);
    tracing::info!(target: TARGET, machine = machine_id, remote_port, local_port = bound, transport = if forward.direct.is_some() { "tcp" } else { "websocket" }, "forwarding a port");
    Ok(forward.view())
}

/// Start at the remote port, then try each higher port. An explicitly chosen port is exact.
async fn bind_local(remote: u16, local: Option<u16>) -> Result<TcpListener, RpcError> {
    bind_first_free(remote, local, |port| TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port)))).await
}

/// The port choice of `bind_local`, with the bind passed in so it can be tested without real ports:
/// the asked-for local port or nothing, else the remote port number or the first free one above it.
async fn bind_first_free<T, F, Fut>(remote: u16, local: Option<u16>, mut bind: F) -> Result<T, RpcError>
where
    F: FnMut(u16) -> Fut,
    Fut: std::future::Future<Output = std::io::Result<T>>,
{
    let start = local.unwrap_or(remote);
    let end = if local.is_some() { start } else { u16::MAX };
    for port in start..=end {
        match bind(port).await {
            Ok(listener) => return Ok(listener),
            Err(error) if local.is_none() && error.kind() == std::io::ErrorKind::AddrInUse => continue,
            Err(error) => return Err(RpcError::new(codes::CONFLICT, format!("Could not use that local port: {error}"))),
        }
    }
    Err(RpcError::new(codes::CONFLICT, "No local port is free. Stop a forward and try again."))
}

/// What a preview target names on another machine: the port of its dev server, and the path to open.
pub fn parse_server_target(target: &str) -> Result<(u16, String), String> {
    let trimmed = target.trim();
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else if trimmed.chars().all(|c| c.is_ascii_digit()) && !trimmed.is_empty() {
        format!("http://localhost:{trimmed}")
    } else {
        format!("http://{trimmed}")
    };
    let url = reqwest::Url::parse(&with_scheme).map_err(|_| {
        "Give the dev server's address on that machine, such as http://localhost:5173. Files on another machine are not previewed here: send them with kybern files send first.".to_string()
    })?;
    let host = url.host_str().unwrap_or_default();
    if !matches!(url.scheme(), "http" | "https") || !(host == "localhost" || host == "127.0.0.1" || host == "[::1]" || host == "::1") {
        return Err("Only a dev server on that machine's own localhost can be previewed through it, such as http://localhost:5173.".into());
    }
    let port = url.port_or_known_default().ok_or_else(|| "Add the port of the dev server, such as http://localhost:5173.".to_string())?;
    let mut path = url.path().to_string();
    if let Some(query) = url.query() {
        path.push('?');
        path.push_str(query);
    }
    if let Some(fragment) = url.fragment() {
        path.push('#');
        path.push_str(fragment);
    }
    Ok((port, path))
}

async fn accept_loop(network: Arc<Network>, shutdown: CancellationToken, forward: Arc<Forward>, listener: TcpListener) {
    let idle_limit = network.timing.ports_idle;
    let mut idle_since = Instant::now();
    let tick = (idle_limit / 4).clamp(Duration::from_millis(50), Duration::from_secs(30));
    loop {
        tokio::select! {
            _ = forward.cancel.cancelled() => break,
            _ = shutdown.cancelled() => break,
            accepted = listener.accept() => {
                let Ok((socket, _)) = accepted else { continue };
                idle_since = Instant::now();
                let network = network.clone();
                let forward = forward.clone();
                tokio::spawn(async move { connection(network, forward, socket).await });
            }
            _ = tokio::time::sleep(tick) => {
                if forward.connections.load(Ordering::Relaxed) > 0 {
                    idle_since = Instant::now();
                } else if idle_since.elapsed() >= idle_limit {
                    tracing::info!(target: TARGET, machine = %forward.machine_id, port = forward.remote_port, "closing an idle port forward");
                    break;
                }
            }
        }
    }
    forward.cancel.cancel();
    if forward.prepared
        && let Some(link) = network.peers.link(&forward.machine_id)
    {
        let _ = link.notify(PeerPortsRelease::NAME, json!({"forward_id": forward.id})).await;
    }
    network.ports.remove(forward.id);
    announce(&network);
}

struct Counted(Arc<Forward>);

impl Counted {
    fn new(forward: &Arc<Forward>) -> Self {
        forward.connections.fetch_add(1, Ordering::Relaxed);
        Self(forward.clone())
    }
}

impl Drop for Counted {
    fn drop(&mut self) {
        self.0.connections.fetch_sub(1, Ordering::Relaxed);
    }
}

async fn connection(network: Arc<Network>, forward: Arc<Forward>, mut socket: TcpStream) {
    let _count = Counted::new(&forward);
    let Some(link) = network.peers.link(&forward.machine_id) else { return };
    if let Some((address, endpoint)) = &forward.direct {
        let Some(_slot) = network.relays.acquire(&format!("ports:{}", link.machine_id)) else {
            return;
        };
        let remote = tokio::select! {
            _ = forward.cancel.cancelled() => return,
            remote = direct::connect(&network, *address, endpoint) => remote,
        };
        if let Some(mut remote) = remote {
            let _ = socket.set_nodelay(true);
            tokio::select! {
                _ = forward.cancel.cancelled() => {},
                _ = link.closed() => {},
                _ = tokio::io::copy_bidirectional(&mut socket, &mut remote) => {},
            }
            return;
        }
    }
    let (stream, incoming, slot) = match open_stream(&link, &network, forward.remote_port).await {
        Ok(opened) => opened,
        Err(error) => {
            tracing::debug!(target: TARGET, machine = %forward.machine_id, error = %error.message, "could not open a forwarded connection");
            return;
        }
    };
    pump(link, stream, incoming, socket, slot, forward.cancel.clone()).await;
}

/// Open a stream to a port of the machine on the other end of `link`.
async fn open_stream(link: &Arc<PeerLink>, network: &Network, port: u16) -> Result<(Arc<Stream>, mpsc::Receiver<Chunk>, Slot), RpcError> {
    let slot = network
        .relays
        .acquire(&format!("ports:{}", link.machine_id))
        .ok_or_else(|| RpcError::new(codes::CONFLICT, "too many forwarded connections"))?;
    let (stream, incoming) = link.relays.create(None, StreamKind::Ports, None).ok_or_else(|| RpcError::internal("stream id clash"))?;
    let open = PeerPortsOpenParams { stream_id: stream.id, port };
    match tokio::time::timeout(OPEN_TIMEOUT, link.call::<PeerPortsOpen>(open)).await {
        Ok(Ok(_)) => Ok((stream, incoming, slot)),
        Ok(Err(error)) => {
            link.relays.remove(stream.id);
            Err(error)
        }
        Err(_) => {
            link.relays.remove(stream.id);
            Err(RpcError::internal("the machine did not open the connection in time"))
        }
    }
}

// ---- the target: peer.ports.open ----

/// The ports of this machine's own daemon, which a forward may never reach.
pub fn own_ports(state: &AppState) -> Vec<u16> {
    let mut ports = vec![DEFAULT_PORT, state.port.load(Ordering::Relaxed)];
    if let Some(addr) = *state.listen_addr.read().unwrap_or_else(|poisoned| poisoned.into_inner()) {
        ports.push(addr.port());
    }
    if let Some(port) = state.network.listening_port() {
        ports.push(port);
    }
    ports.push(state.settings.get().network.port);
    ports.retain(|port| *port != 0);
    ports.sort_unstable();
    ports.dedup();
    ports
}

/// `peer.ports.open`: connect a stream to a loopback port of this machine.
pub async fn handle_open(state: &AppState, link: &Arc<PeerLink>, params: PeerPortsOpenParams) -> Result<Value, RpcError> {
    validate_port(state, params.port)?;
    let slot = state
        .network
        .relays
        .acquire(&format!("inbound:{}", link.machine_id))
        .ok_or_else(|| RpcError::new(codes::CONFLICT, "too many forwarded connections on this machine"))?;
    let socket = connect_loopback(params.port).await?;
    let (stream, incoming) = link
        .relays
        .create(Some(params.stream_id), StreamKind::Ports, Some(Scope::MachinePorts))
        .ok_or_else(|| RpcError::invalid_params("that stream id is in use"))?;
    let link = link.clone();
    tokio::spawn(async move {
        let cancel = CancellationToken::new();
        pump(link, stream, incoming, socket, slot, cancel).await;
    });
    Ok(json!({}))
}

fn validate_port(state: &AppState, port: u16) -> Result<(), RpcError> {
    if port == 0 {
        return Err(RpcError::invalid_params("port must be 1-65535"));
    }
    if own_ports(state).contains(&port) {
        return Err(RpcError::new(codes::FORBIDDEN, format!("Port {port} belongs to Kybern itself and is not forwarded.")));
    }
    Ok(())
}

/// `127.0.0.1`, else `::1`: a dev server may listen on either.
async fn connect_loopback(port: u16) -> Result<TcpStream, RpcError> {
    let attempt = |addr: SocketAddr| async move { tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(addr)).await };
    if let Ok(Ok(socket)) = attempt(SocketAddr::from((Ipv4Addr::LOCALHOST, port))).await {
        return Ok(socket);
    }
    if let Ok(Ok(socket)) = attempt(SocketAddr::from((std::net::Ipv6Addr::LOCALHOST, port))).await {
        return Ok(socket);
    }
    Err(RpcError::new(codes::NOT_FOUND, format!("Nothing is listening on port {port} of that machine.")))
}

// ---- the stream ----

async fn send_data(link: &PeerLink, stream: &Stream, bytes: &[u8], text: bool) -> bool {
    if !stream.credit.take(frame_cost(bytes.len()), &stream.cancel).await {
        return false;
    }
    stream.touch();
    let params = PeerRelayDataParams { stream_id: stream.id, data: B64.encode(bytes), credit: None, text };
    link.notify(PeerPortsData::NAME, serde_json::to_value(params).unwrap_or(Value::Null)).await
}

async fn grant(link: &PeerLink, stream: &Stream, bytes: usize) {
    if bytes == 0 {
        return;
    }
    let bytes = frame_cost(bytes);
    let params =
        PeerRelayDataParams { stream_id: stream.id, data: String::new(), credit: Some(bytes.min(u32::MAX as usize) as u32), text: false };
    let _ = link.notify(PeerPortsData::NAME, serde_json::to_value(params).unwrap_or(Value::Null)).await;
}

async fn send_close(link: &PeerLink, stream_id: u64) {
    let params = PeerRelayCloseParams { stream_id, reason: None };
    let _ = link.notify(PeerPortsClose::NAME, serde_json::to_value(params).unwrap_or(Value::Null)).await;
}

/// Carry bytes between a TCP socket and a stream until either side ends. Reading and writing run apart, so a
/// transfer in one direction never waits on credit the other direction has to grant. An empty text frame
/// means "this side will send no more" (a half-close); the stream ends when both sides have.
async fn pump(
    link: Arc<PeerLink>,
    stream: Arc<Stream>,
    mut incoming: mpsc::Receiver<Chunk>,
    socket: TcpStream,
    slot: Slot,
    stop: CancellationToken,
) {
    let (mut reader, mut writer) = socket.into_split();
    let done = CancellationToken::new();
    let read_task = {
        let (link, stream, done, stop) = (link.clone(), stream.clone(), done.clone(), stop.clone());
        tokio::spawn(async move {
            let mut buffer = vec![0u8; READ_CHUNK];
            let finished_cleanly = loop {
                let read = tokio::select! {
                    read = reader.read(&mut buffer) => read,
                    _ = stream.cancel.cancelled() => break false,
                    _ = link.closed() => break false,
                    _ = stop.cancelled() => break false,
                    _ = done.cancelled() => break false,
                };
                match read {
                    Ok(0) => break true,
                    Ok(read) => {
                        if !send_data(&link, &stream, &buffer[..read], false).await {
                            break false;
                        }
                    }
                    Err(_) => break false,
                }
            };
            if finished_cleanly {
                // Tell the other side no more is coming; it may still answer.
                let _ = send_data(&link, &stream, &[], true).await;
            }
            finished_cleanly
        })
    };
    let mut remote_open = true;
    while remote_open {
        // Bytes already received are written before an end or a cancel is honoured.
        let chunk = tokio::select! {
            biased;
            chunk = incoming.recv() => chunk,
            _ = stream.cancel.cancelled() => None,
            _ = link.closed() => None,
            _ = stop.cancelled() => None,
            _ = done.cancelled() => None,
        };
        match chunk {
            Some(Chunk::Binary(bytes)) | Some(Chunk::Text(bytes)) if !bytes.is_empty() => {
                let size = bytes.len();
                if writer.write_all(&bytes).await.is_err() {
                    break;
                }
                grant(&link, &stream, size).await;
            }
            // Half-close from the other side: end our writing, keep reading until it ends.
            Some(Chunk::Text(_)) | Some(Chunk::Binary(_)) => {
                let _ = writer.shutdown().await;
                remote_open = false;
            }
            Some(Chunk::End) | None => break,
        }
    }
    if remote_open {
        // The stream ended abruptly: stop the reader too.
        done.cancel();
    }
    let reader_clean = read_task.await.unwrap_or(false);
    if remote_open || !reader_clean {
        let _ = writer.shutdown().await;
    }
    // The reader may still be waiting for the local side after a remote half-close; wait for it to finish
    // or for the stream to be cancelled, then close.
    send_close(&link, stream.id).await;
    link.relays.remove(stream.id);
    drop(slot);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn local_port_selection_preserves_free_ports_and_skips_occupied_ports() {
        // The choice itself, against a fixed set of taken ports: other tests binding ephemeral
        // ports cannot take a "free" one in between, as they could with real sockets.
        let taken = [5173u16, 5174, 5176, u16::MAX];
        let bind = |port: u16| {
            let tried = port;
            async move { if taken.contains(&tried) { Err(std::io::Error::from(std::io::ErrorKind::AddrInUse)) } else { Ok(tried) } }
        };
        assert_eq!(bind_first_free(3000, None, bind).await.unwrap(), 3000, "a free remote port number is kept locally");
        assert_eq!(bind_first_free(5173, None, bind).await.unwrap(), 5175, "an occupied one moves to the next free port");
        assert_eq!(bind_first_free(5176, None, bind).await.unwrap(), 5177);
        assert_eq!(bind_first_free(5173, Some(4000), bind).await.unwrap(), 4000, "an asked-for local port is used as is");
        assert_eq!(bind_first_free(5173, Some(5174), bind).await.unwrap_err().code, codes::CONFLICT, "and never replaced");
        assert_eq!(bind_first_free(u16::MAX, None, bind).await.unwrap_err().code, codes::CONFLICT);
        // Any error other than "in use" is reported, not skipped.
        let denied = |_port: u16| async { Err::<u16, _>(std::io::Error::from(std::io::ErrorKind::PermissionDenied)) };
        assert_eq!(bind_first_free(3000, None, denied).await.unwrap_err().code, codes::CONFLICT);

        // And with real sockets, on a port this test holds: an asked-for port is refused, and an
        // automatic choice moves above it.
        let reserved = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = reserved.local_addr().unwrap().port();
        assert!(bind_local(port, Some(port)).await.is_err());
        if port < u16::MAX {
            assert!(bind_local(port, None).await.unwrap().local_addr().unwrap().port() > port);
        }
    }

    #[test]
    fn a_preview_target_on_another_machine_is_a_localhost_dev_server() {
        assert_eq!(parse_server_target("http://localhost:5173").unwrap(), (5173, "/".to_string()));
        assert_eq!(parse_server_target("localhost:3000/app?x=1").unwrap(), (3000, "/app?x=1".to_string()));
        assert_eq!(parse_server_target("5173").unwrap(), (5173, "/".to_string()));
        assert_eq!(parse_server_target("http://127.0.0.1:8080/a#top").unwrap(), (8080, "/a#top".to_string()));
        for bad in ["https://example.com", "mockups/index.html", "javascript:alert(1)", "http://192.168.1.4:3000", ""] {
            assert!(parse_server_target(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_port_forward_view_reports_its_connections() {
        let forward = Forward {
            id: Uuid::now_v7(),
            machine_id: "m".into(),
            machine_name: "satyamas".into(),
            remote_port: 5173,
            local_port: 40000,
            created_at: chrono::Utc::now(),
            direct: None,
            prepared: false,
            connections: AtomicU32::new(0),
            cancel: CancellationToken::new(),
        };
        let forward = Arc::new(forward);
        let guard = Counted::new(&forward);
        assert_eq!(forward.view().connections, 1);
        drop(guard);
        assert_eq!(forward.view().connections, 0);
    }
}
