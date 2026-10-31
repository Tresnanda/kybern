//! Separate TCP sockets for port bytes. Authorization stays on the authenticated peer session.
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use kybern_protocol::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpSocket, TcpStream};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::super::{
    Network,
    peers::{self, PeerLink},
    tailscale,
};
use crate::state::AppState;

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(3);

struct Serving {
    id: Uuid,
    link: Arc<PeerLink>,
    cancel: CancellationToken,
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
    let serving = Arc::new(Serving { id: request.forward_id, link: link.clone(), cancel: CancellationToken::new() });
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
                    let Some(slot) = state.network.relays.acquire(&format!("inbound:{}", serving.link.machine_id)) else { continue; };
                    idle_since = Instant::now();
                    let (state, serving, node, token_hash, active) = (state.clone(), serving.clone(), node.clone(), token_hash.clone(), active.clone());
                    tokio::spawn(async move {
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
    Ok(PeerPortsPrepareResult { direct: Some(PeerPortsDirect { port, token }) })
}

async fn transfer(state: &AppState, serving: &Serving, mut socket: TcpStream, source: IpAddr, node: &str, token_hash: &str, port: u16) {
    let link = &serving.link;
    let handshake = async {
        let mut token = [0u8; 64];
        socket.read_exact(&mut token).await.ok()?;
        let token = std::str::from_utf8(&token).ok()?;
        if crate::auth::hash(token) != token_hash {
            return None;
        }
        let who = state.network.tailscale.whois(source).await.ok()?;
        if who.node_id != node || !authorized(&state.network, link) || super::own_ports(state).contains(&port) {
            return None;
        }
        let upstream = super::connect_loopback(port).await.ok()?;
        Some(upstream)
    };
    let ended = async {
        tokio::select! {
            _ = serving.cancel.cancelled() => {},
            _ = link.closed() => {},
        }
    };
    tokio::pin!(ended);
    let upstream = tokio::select! {
        _ = &mut ended => return,
        upstream = tokio::time::timeout(HANDSHAKE_TIMEOUT, handshake) => upstream,
    };
    let Ok(Some(mut upstream)) = upstream else {
        return;
    };
    let _ = socket.set_nodelay(true);
    let _ = upstream.set_nodelay(true);
    if socket.write_all(&[1]).await.is_err() {
        return;
    }
    tokio::select! {
        _ = tokio::io::copy_bidirectional(&mut socket, &mut upstream) => {},
        // A reset, not an end: a plain FIN reads as a half-close, and the client would keep its side open.
        _ = &mut ended => { let _ = socket.set_zero_linger(); },
    }
}

pub async fn connect(network: &Network, address: SocketAddr, endpoint: &PeerPortsDirect) -> Option<TcpStream> {
    let connect = async {
        let socket = if address.is_ipv4() { TcpSocket::new_v4() } else { TcpSocket::new_v6() }.ok()?;
        if let Some(source) = network.tailscale.dial_source() {
            socket.bind(SocketAddr::new(source, 0)).ok()?;
        }
        let mut socket = socket.connect(address).await.ok()?;
        socket.set_nodelay(true).ok()?;
        if endpoint.token.len() != 64 {
            return None;
        }
        socket.write_all(endpoint.token.as_bytes()).await.ok()?;
        if socket.read_u8().await.ok()? != 1 {
            return None;
        }
        Some(socket)
    };
    tokio::time::timeout(HANDSHAKE_TIMEOUT, connect).await.ok().flatten()
}
