//! One pairing, every machine (design §3.4): a client that paired with member A asks A for a
//! device token for machine B. A asks B over their session (`peer.client_token.mint`); B mints the
//! token and returns it **sealed to A's key**, so a relay in between cannot read it; A opens it and
//! hands it to the client over the client's authenticated socket.
//!
//! Revoking a device on any member fans out as `peer.device.revoke` and revokes that device's
//! tokens on every member.

use std::net::IpAddr;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use kybern_protocol::methods::{PeerClientTokenMint, PeerDeviceRevoke};
use kybern_protocol::{
    NetworkClientGrantParams, NetworkClientGrantResult, PeerClientTokenMintParams, PeerClientTokenMintResult, PeerDeviceRevokeParams,
    Route, RouteKind, RpcError, Scope, codes,
};
use uuid::Uuid;

use super::peers::PeerLink;
use super::{Network, TARGET};
use crate::auth::Principal;
use crate::state::AppState;

const MAX_DEVICE_ID: usize = 80;
const MAX_LABEL: usize = 200;

fn valid_device_id(device_id: &str) -> bool {
    !device_id.is_empty()
        && device_id.len() <= MAX_DEVICE_ID
        && device_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"-_.:".contains(&byte))
}

/// The sealed-box context: the token is for one client device, minted by one machine for one other.
fn context(from: &str, to: &str, device_id: &str) -> Vec<u8> {
    format!("kybern-client-token-v1\0{from}\0{to}\0{device_id}").into_bytes()
}

/// A label without a "(via …)" suffix, so a token minted through two hops is still named once.
fn base_label(label: &str) -> &str {
    let mut label = label.trim();
    while let Some(at) = label.rfind(" (via ") {
        if !label.ends_with(')') {
            break;
        }
        label = label[..at].trim_end();
    }
    if label.is_empty() { "paired device" } else { label }
}

fn clip(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// Make a device token on this machine for a client. Any older token this machine issued to the
/// same device for the same requester goes, so a client that asks again holds one.
fn mint_local(state: &AppState, device_id: &str, label: &str, via: Option<&str>) -> Result<(String, Vec<Scope>), RpcError> {
    let store = &state.store;
    let internal = |error: anyhow::Error| RpcError::internal(format!("{error:#}"));
    if let Some(via) = via {
        for id in store.tokens_revoke_device_via(device_id, via).map_err(internal)? {
            let _ = state.revoked_tokens.send(id);
        }
    }
    let token = crate::auth::generate();
    let id = Uuid::now_v7();
    let scopes = crate::access::paired_scopes();
    store.token_insert(id, &crate::auth::hash(&token), &clip(label, MAX_LABEL), &scopes).map_err(internal)?;
    store.token_set_device(id, device_id, via).map_err(internal)?;
    Ok((token, scopes))
}

/// `network.client_grant`: a device token for `machine_id`, for the client `principal`.
pub async fn grant(
    state: &AppState,
    principal: &Principal,
    params: NetworkClientGrantParams,
) -> Result<NetworkClientGrantResult, RpcError> {
    let network = &state.network;
    let membership =
        network.membership().ok_or_else(|| RpcError::new(codes::NOT_AVAILABLE, "The machine network is unavailable on this machine."))?;
    if !valid_device_id(&params.device_id) {
        return Err(RpcError::invalid_params("device_id is 1 to 80 letters, digits or - _ . :"));
    }
    let projection = membership.projection();
    let me = membership.machine_id();
    let Some(entry) = projection.entry(&params.machine_id).filter(|entry| entry.removed.is_none()) else {
        return Err(RpcError::not_found("machine"));
    };
    // The device that is asking is now a known device on this machine too, so revoking it here
    // reaches the tokens minted elsewhere for it.
    if state.store.token_device(principal.token_id).map_err(RpcError::internal)?.is_none() {
        let _ = state.store.token_set_device(principal.token_id, &params.device_id, None);
    }
    let my_name = projection.entry(&me).map(|entry| entry.descriptor.name.clone()).unwrap_or_else(|| "this machine".into());
    let label = format!("{} (via {})", base_label(&principal.label), my_name);
    let token = if params.machine_id == me {
        mint_local(state, &params.device_id, &label, None)?.0
    } else {
        if entry.paused {
            return Err(RpcError::new(codes::NOT_AVAILABLE, format!("{} is paused. Resume it to connect.", entry.descriptor.name)));
        }
        let link = network.peers.link(&params.machine_id).ok_or_else(|| {
            RpcError::new(
                codes::NOT_AVAILABLE,
                format!("{} is not connected to this machine right now. Try again when it is online.", entry.descriptor.name),
            )
        })?;
        let minted = link
            .call::<PeerClientTokenMint>(PeerClientTokenMintParams { device_id: params.device_id.clone(), label: clip(&label, MAX_LABEL) })
            .await?;
        let sealed = B64.decode(&minted.sealed_token).map_err(|_| RpcError::internal("the machine returned a token that is not sealed"))?;
        let plain = crate::secret_store::open(&membership.keys(), &context(&params.machine_id, &me, &params.device_id), &sealed).map_err(
            |error| RpcError::internal(format!("could not open the token {} sealed for this machine: {error:#}", entry.descriptor.name)),
        )?;
        String::from_utf8(plain).map_err(|_| RpcError::internal("the sealed token is not text"))?
    };
    tracing::info!(target: TARGET, machine = %params.machine_id, "issued a client token for another machine");
    Ok(NetworkClientGrantResult {
        token,
        scopes: crate::access::paired_scopes(),
        routes: routes(state, &params.machine_id).await,
        signing_key: Some(entry.descriptor.signing_key.clone()),
    })
}

/// `peer.client_token.mint`: member A asks this machine for a token for one of A's clients; the
/// answer is sealed to A's sealing key, which the membership set holds.
pub fn mint_for_peer(state: &AppState, link: &PeerLink, params: PeerClientTokenMintParams) -> Result<PeerClientTokenMintResult, RpcError> {
    let network = &state.network;
    let membership = network.membership().ok_or_else(|| RpcError::new(codes::NOT_AVAILABLE, "no network"))?;
    if !valid_device_id(&params.device_id) {
        return Err(RpcError::invalid_params("device_id is 1 to 80 letters, digits or - _ . :"));
    }
    let projection = membership.projection();
    let requester =
        projection.entry(&link.machine_id).filter(|entry| entry.removed.is_none()).ok_or_else(|| RpcError::forbidden("machine:peer"))?;
    let sealing_key: [u8; 32] = B64
        .decode(&requester.descriptor.sealing_key)
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(|| RpcError::internal("the requesting machine's sealing key is not valid"))?;
    let me = membership.machine_id();
    let (token, scopes) = mint_local(state, &params.device_id, &params.label, Some(&link.machine_id))?;
    let sealed = crate::secret_store::seal(&sealing_key, &context(&me, &link.machine_id, &params.device_id), token.as_bytes())
        .map_err(|error| RpcError::internal(format!("{error:#}")))?;
    tracing::info!(target: TARGET, machine = %link.machine_id, "minted a client token for another machine");
    Ok(PeerClientTokenMintResult { sealed_token: B64.encode(sealed), scopes })
}

/// Revoke every token of a device on this machine and close its sockets. Returns how many.
pub fn revoke_device_local(state: &AppState, device_id: &str) -> usize {
    match state.store.tokens_revoke_device(device_id) {
        Ok(ids) => {
            for id in &ids {
                let _ = state.revoked_tokens.send(*id);
                state.previews.revoke_principal(*id);
            }
            ids.len()
        }
        Err(error) => {
            tracing::warn!(target: TARGET, %error, "could not revoke a device's tokens");
            0
        }
    }
}

/// Revoke a device here and on every connected member (`peer.device.revoke`). A member that is
/// offline learns nothing from this; its tokens for the device die when the device's other tokens
/// are used to reach it, or when it is removed.
pub async fn revoke_device_everywhere(state: &AppState, device_id: &str) {
    revoke_device_local(state, device_id);
    for link in state.network.peers.links() {
        let device_id = device_id.to_string();
        tokio::spawn(async move {
            if let Err(error) = link.call::<PeerDeviceRevoke>(PeerDeviceRevokeParams { device_id }).await {
                tracing::debug!(target: TARGET, machine = %link.machine_id, %error.message, "could not fan out a device revocation");
            }
        });
    }
}

/// The ways to reach `machine_id` from a client of this machine (§3.4): a direct tailnet address,
/// and a relay through this machine when it holds a session to it.
pub async fn routes(state: &AppState, machine_id: &str) -> Vec<Route> {
    let network = &state.network;
    let Some(membership) = network.membership() else { return Vec::new() };
    let me = membership.machine_id();
    let projection = membership.projection();
    let Some(entry) = projection.entry(machine_id).filter(|entry| entry.removed.is_none()) else { return Vec::new() };
    let mut routes = Vec::new();
    if machine_id == me {
        for endpoint in crate::access::endpoints(state).await {
            routes.push(Route { kind: kind_of(&endpoint), url: endpoint.trim_end_matches('/').to_string(), via: None });
        }
        return routes;
    }
    let port = entry.descriptor.port.unwrap_or(kybern_protocol::DEFAULT_PORT);
    if let Some(ip) = tailnet_ip_of(network, entry.descriptor.ts_node_id.as_deref()).await {
        routes.push(Route { kind: RouteKind::DirectTailnet, url: super::well_known::base_url(ip, port), via: None });
    }
    if network.peers.link(machine_id).is_some()
        && let Some(own) = crate::access::endpoints(state).await.into_iter().next()
    {
        routes.push(Route { kind: RouteKind::Relay, url: format!("{}/relay/{machine_id}", own.trim_end_matches('/')), via: Some(me) });
    }
    routes
}

async fn tailnet_ip_of(network: &Network, node_id: Option<&str>) -> Option<IpAddr> {
    let status = network.tailscale.status().await.ok()?;
    status.peer(node_id?)?.ip()
}

fn kind_of(endpoint: &str) -> RouteKind {
    let host = endpoint.split("://").nth(1).unwrap_or(endpoint).split(['/', ':']).next().unwrap_or_default();
    match host.parse::<IpAddr>() {
        Ok(ip) if super::tailscale::plain_http_allowed(ip, false) => RouteKind::DirectTailnet,
        _ if host.ends_with(".ts.net") => RouteKind::DirectTailnet,
        _ => RouteKind::DirectAdvertised,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_ids_are_short_and_plain() {
        assert!(valid_device_id("3f6c1a2e-0b1d-4a52-9d0c-aaaaaaaaaaaa"));
        assert!(valid_device_id("phone:abc_1.2"));
        assert!(!valid_device_id(""));
        assert!(!valid_device_id("has space"));
        assert!(!valid_device_id(&"x".repeat(MAX_DEVICE_ID + 1)));
    }

    #[test]
    fn a_label_keeps_one_via_suffix() {
        assert_eq!(base_label("Phone (via Mac)"), "Phone");
        assert_eq!(base_label("Phone (via Mac) (via PC)"), "Phone");
        assert_eq!(base_label("Phone"), "Phone");
        assert_eq!(base_label("  "), "paired device");
        assert_eq!(base_label("Notes (draft)"), "Notes (draft)");
    }

    #[test]
    fn endpoints_are_classified_by_their_host() {
        assert_eq!(kind_of("http://100.64.0.2:4173"), RouteKind::DirectTailnet);
        assert_eq!(kind_of("https://mac.tail1234.ts.net"), RouteKind::DirectTailnet);
        assert_eq!(kind_of("https://box.example.com"), RouteKind::DirectAdvertised);
        assert_eq!(kind_of("http://192.168.1.4:4173"), RouteKind::DirectAdvertised);
    }
}
