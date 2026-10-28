//! Joining a network (design §2.4): the offer a member sends, the checks the machine being added
//! runs before it accepts, the discovery pass that joins same-user machines on its own, the
//! one-click Add for tagged nodes, the six-digit code for everything else, the merge of two
//! networks of one owner, and the saved-environment migration.
//!
//! ```text
//! A (member)                                    P (the machine being added)
//! GET  P/.well-known/kybern/machine?nonce  →    id, keys, network_id   (P must be in no network)
//! POST P/network/offer {add op, full set}  →    whois(source) says A is the owner (auto, found)
//!                                               or the code is the one P shows (code, migrate)
//!                                               P keeps the set: it is now a member
//!                                          ←    P's signature over nonce ‖ P ‖ add id
//! A keeps the add and gossips it.
//! ```
//!
//! Every way in ends with an `add` operation signed by a member. The target checks the member the
//! way the design says; the member only trusts the answer because P signs it with the key P proved
//! in the well-known check.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use kybern_protocol::{FoundAction, FoundMachine, JoinVia, MachineCard, MachineDescriptor, OpEnvelope, OpKind};
use serde::{Deserialize, Serialize};

use super::membership::MembershipError;
use super::ops::{self, OpSet, Projection};
use super::peers::{FoundEntry, backoff};
use super::tailscale::{TsNode, TsStatus, Whois};
use super::well_known::{self, Expected, ProbeError, WellKnown};
use super::{Network, TARGET, keys};
use crate::state::AppState;
use crate::ws::Peer;

const DISCOVERY_TARGET: &str = "kybern::network::discovery";
pub const OFFER_PATH: &str = "/network/offer";
pub const MERGE_PATH: &str = "/network/merge";
const OFFER_RESPONSE_DOMAIN: &str = "kybern-offer-resp-v1\0";
const MERGE_RESPONSE_DOMAIN: &str = "kybern-merge-resp-v1\0";
/// An offer carries the whole set, which is tens of operations; this bounds what a target reads.
const MAX_OFFER_OPS: usize = 4096;

// ---- wire types ----

/// What a member sends a machine it wants to add.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Offer {
    /// A fresh nonce; the target signs it back.
    pub nonce: String,
    /// The machine being added.
    pub to: String,
    pub via: JoinVia,
    /// Every operation the member holds, the `add` for the target included.
    pub ops: Vec<OpEnvelope>,
    /// The id of the `add` in `ops`.
    pub add: String,
    /// The six-digit code the target showed, for `code` and `migrate`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OfferAnswer {
    pub machine_id: String,
    pub nonce: String,
    pub add: String,
    /// `ed25519(target, "kybern-offer-resp-v1\0" ‖ nonce ‖ machine ‖ add id)`, standard base64.
    pub sig: String,
}

fn offer_response_message(nonce: &str, machine_id: &str, add: &str) -> Vec<u8> {
    format!("{OFFER_RESPONSE_DOMAIN}{}", [nonce, machine_id, add].join("\0")).into_bytes()
}

/// What a member sends a machine in another network of the same owner.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MergeOffer {
    pub nonce: String,
    pub to: String,
    /// The sender's network genesis, which the target's merge names.
    pub genesis: OpEnvelope,
    /// Everything the sender holds, so the target has the sender's members at once.
    pub ops: Vec<OpEnvelope>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MergeAnswer {
    pub machine_id: String,
    pub nonce: String,
    /// The target's network genesis, which the sender's merge names.
    pub genesis: OpEnvelope,
    pub ops: Vec<OpEnvelope>,
    pub sig: String,
}

fn merge_response_message(nonce: &str, machine_id: &str, genesis: &str) -> Vec<u8> {
    format!("{MERGE_RESPONSE_DOMAIN}{}", [nonce, machine_id, genesis].join("\0")).into_bytes()
}

// ---- errors ----

#[derive(Debug, thiserror::Error)]
pub enum JoinError {
    #[error("{0}")]
    Unavailable(String),
    #[error("that machine is already in a network")]
    TargetInNetwork,
    #[error("{0}")]
    Refused(String),
    #[error("{0}")]
    Identity(#[from] ProbeError),
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    NotFound(String),
    #[error(transparent)]
    Membership(#[from] MembershipError),
    #[error("{0}")]
    Transport(String),
}

impl JoinError {
    /// The error a client of the daemon sees.
    pub fn into_rpc(self) -> kybern_protocol::RpcError {
        use kybern_protocol::{RpcError, codes};
        match self {
            Self::Unavailable(message) => RpcError::new(codes::NOT_AVAILABLE, message),
            Self::NotFound(message) => RpcError::new(codes::NOT_FOUND, message),
            Self::Invalid(message) => RpcError::new(codes::INVALID_PARAMS, message),
            Self::TargetInNetwork => {
                RpcError::new(codes::CONFLICT, "That machine is already in a network. Remove it there first, or merge the two networks.")
            }
            Self::Refused(message) => RpcError::new(codes::FORBIDDEN, message),
            Self::Identity(error) => RpcError::new(codes::FORBIDDEN, format!("{error}. Nothing was sent to that address.")),
            Self::Membership(error) => RpcError::new(codes::CONFLICT, error.to_string()),
            Self::Transport(message) => RpcError::new(codes::NOT_AVAILABLE, message),
        }
    }
}

// ---- state ----

/// Retry bookkeeping for the discovery pass, so a refused offer is not repeated every tick.
#[derive(Default)]
pub struct JoinState {
    attempts: Mutex<HashMap<String, (Instant, u32)>>,
}

impl JoinState {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, (Instant, u32)>> {
        self.attempts.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn due(&self, node_id: &str) -> bool {
        self.lock().get(node_id).is_none_or(|(next, _)| Instant::now() >= *next)
    }

    fn failed(&self, node_id: &str, timing: &super::Timing) {
        let mut attempts = self.lock();
        let entry = attempts.entry(node_id.to_string()).or_insert((Instant::now(), 0));
        entry.1 = entry.1.saturating_add(1);
        entry.0 = Instant::now() + backoff(timing, entry.1 + 2).max(timing.found_ttl);
    }

    fn forget(&self, node_id: &str) {
        self.lock().remove(node_id);
    }
}

// ---- this machine as the tailnet sees it ----

struct Me {
    status: TsStatus,
    login: Option<String>,
    tagged: bool,
    shared_in: bool,
}

impl Me {
    async fn read(network: &Network) -> Option<Me> {
        let status = network.tailscale.status().await.ok().filter(|status| status.running)?;
        let node = status.self_node.clone()?;
        let login = status.login_of(node.user_id).map(str::to_string);
        Some(Me { login, tagged: node.tagged(), shared_in: node.shared_in, status })
    }

    /// An untagged node of a human user: the only kind that can vouch for a join.
    fn can_vouch(&self) -> bool {
        !self.tagged && !self.shared_in && self.login.is_some()
    }
}

// ---- classification ----

/// What can be done with a machine found on the tailnet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Plan {
    /// Same Tailscale user on both sides: joins without a click.
    Auto,
    /// One click on a member the target can verify (a tagged node of a one-user tailnet).
    Click,
    /// The user enters the code shown on the target.
    Code,
    /// The target is in another network of the same owner.
    Merge,
    /// Not offered at all: a member already, or another owner's network.
    Hidden,
}

/// Decide what to do with `entry`, from this machine's view of the tailnet. `projection` is this
/// machine's membership; a lone machine passes an empty one.
fn classify(me: &Me, projection: &Projection, entry: &FoundEntry) -> Plan {
    // A removed machine, or one using a removed key, is not offered for adding (§2.3).
    if projection.is_removed(&entry.descriptor.machine_id) || projection.is_key_tombstoned(&entry.descriptor.signing_key) {
        return Plan::Hidden;
    }
    let theirs = entry.descriptor.network_id.as_deref();
    if theirs.is_some() {
        let ours = projection.network_id.as_deref();
        if theirs == ours || ours.is_none() {
            return Plan::Hidden;
        }
        let owner = projection.owner_login.as_deref().unwrap_or_default();
        let same_owner = entry.whois.as_ref().is_some_and(|whois| whois.is_owner(owner));
        return if same_owner && me.can_vouch() { Plan::Merge } else { Plan::Hidden };
    }
    let Some(whois) = entry.whois.as_ref() else { return Plan::Code };
    let Some(my_login) = me.login.as_deref().filter(|_| me.can_vouch()) else { return Plan::Code };
    // The owner of the network (this machine's own login when it has none yet) must be the user
    // both nodes belong to; otherwise the target cannot verify the offer.
    let owner = projection.owner_login.as_deref().unwrap_or(my_login);
    if owner.eq_ignore_ascii_case(my_login) && whois.is_owner(my_login) {
        return Plan::Auto;
    }
    if whois.tagged() && !whois.shared_in && !entry.node.shared_in && me.status.human_users() == 1 {
        return Plan::Click;
    }
    Plan::Code
}

/// The Found list `network.status` shows (§4.1).
pub async fn found_list(state: &AppState) -> Vec<FoundMachine> {
    let network = &state.network;
    let Some(membership) = network.membership() else { return Vec::new() };
    if !network.is_enabled() {
        return Vec::new();
    }
    let Some(me) = Me::read(network).await else { return Vec::new() };
    let projection = membership.projection();
    let mut list = Vec::new();
    for entry in network.peers.found() {
        let action = match classify(&me, &projection, &entry) {
            Plan::Auto | Plan::Click => FoundAction::Add,
            Plan::Code => FoundAction::Code,
            Plan::Merge => FoundAction::Merge,
            Plan::Hidden => continue,
        };
        list.push(FoundMachine {
            found_id: entry.node.node_id.clone(),
            name: entry.node.name(),
            machine_id: Some(entry.descriptor.machine_id.clone()),
            os: Some(entry.descriptor.os.clone()),
            ts_name: entry.descriptor.ts_name.clone(),
            version: Some(entry.descriptor.version.clone()),
            action,
            other_network_id: entry.descriptor.network_id.clone().filter(|_| action == FoundAction::Merge),
        });
    }
    list.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.found_id.cmp(&b.found_id)));
    list
}

// ---- founding ----

/// Found a network on this machine if it has none: the Tailscale identity of this node becomes the
/// owner (§2.2). A machine without Tailscale gets an owner nobody else can match, so only codes
/// can add to it.
pub async fn ensure_network(state: &AppState) -> Result<(), JoinError> {
    let network = &state.network;
    let membership = network.membership().ok_or_else(|| JoinError::Unavailable(unavailable_reason(network)))?;
    if !network.is_enabled() {
        return Err(JoinError::Unavailable("Connect to your other machines is turned off on this machine.".into()));
    }
    if membership.has_network() {
        return if membership.self_is_member() { Ok(()) } else { Err(MembershipError::NotMember.into()) };
    }
    let ts = network.self_ts().await;
    let login = ts.login.clone().filter(|login| !login.trim().is_empty()).unwrap_or_else(|| format!("machine:{}", membership.machine_id()));
    let info = network.self_info().await;
    match membership.genesis(&login, ts.tailnet.as_deref().unwrap_or_default(), &info) {
        Ok(_) => {
            tracing::info!(target: TARGET, "founded a network");
            network.notify_changed();
            network.wake();
            Ok(())
        }
        // Another path founded it first.
        Err(MembershipError::AlreadyInNetwork) => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn unavailable_reason(network: &Network) -> String {
    match &network.unavailable {
        Some(reason) => format!("The machine network is unavailable on this machine: {reason}"),
        None => "The machine network is unavailable on this machine.".into(),
    }
}

// ---- the offer: the member's side ----

/// A machine a member is about to add.
#[derive(Debug, Clone)]
pub struct Candidate {
    /// Where its network listener (or primary listener) answers: `http://host:port`.
    pub base: String,
    pub descriptor: MachineDescriptor,
}

/// Build a candidate from a well-known answer and what the tailnet says about the node.
fn candidate(base: &str, answer: &WellKnown, node: Option<&TsNode>) -> Candidate {
    Candidate {
        base: base.to_string(),
        descriptor: MachineDescriptor {
            machine_id: answer.machine_id.clone(),
            name: node.map(|node| node.name()).filter(|name| !name.is_empty()).unwrap_or_else(|| answer.name.clone()),
            os: answer.os.clone(),
            signing_key: answer.signing_key.clone(),
            sealing_key: answer.sealing_key.clone(),
            ts_node_id: node.map(|node| node.node_id.clone()).filter(|id| !id.is_empty()),
            ts_name: node.map(|node| node.dns_name.clone()).filter(|name| !name.is_empty()).or_else(|| answer.ts_name.clone()),
            port: answer.port,
        },
    }
}

/// Send the offer and, once the target has signed its answer, keep the `add` and spread it.
async fn send_offer(state: &AppState, target: &Candidate, via: JoinVia, code: Option<String>) -> Result<MachineCard, JoinError> {
    let network = &state.network;
    let membership = network.membership().ok_or_else(|| JoinError::Unavailable(unavailable_reason(network)))?;
    let add = membership.build_add(target.descriptor.clone(), via)?;
    let mut ops_list = membership.all_ops();
    ops_list.push(add.clone());
    let offer =
        Offer { nonce: well_known::new_nonce(), to: target.descriptor.machine_id.clone(), via, ops: ops_list, add: add.id.clone(), code };
    let response = network
        .http
        .post(format!("{}{OFFER_PATH}", target.base.trim_end_matches('/')))
        .timeout(Duration::from_secs(20))
        .json(&offer)
        .send()
        .await
        .map_err(|error| JoinError::Transport(format!("Could not reach that machine: {}", error.without_url())))?;
    let status = response.status();
    if !status.is_success() {
        let message = response.text().await.unwrap_or_default();
        let message: String = message.chars().take(300).collect();
        return Err(match status {
            StatusCode::CONFLICT => JoinError::TargetInNetwork,
            StatusCode::TOO_MANY_REQUESTS => JoinError::Refused("Too many attempts on that machine. Wait a minute and try again.".into()),
            StatusCode::UNAUTHORIZED if offer.code.is_some() => {
                JoinError::Refused("That code is wrong or has expired. Ask that machine for a new one.".into())
            }
            _ => JoinError::Refused(if message.is_empty() { format!("That machine refused to join ({status}).") } else { message }),
        });
    }
    let answer: OfferAnswer =
        response.json().await.map_err(|_| JoinError::Transport("That machine answered with something unreadable.".into()))?;
    let signature = B64.decode(&answer.sig).map_err(|_| JoinError::Refused("The join answer is not signed.".into()))?;
    let signed = keys::verify_signature(
        &target.descriptor.signing_key,
        &offer_response_message(&offer.nonce, &target.descriptor.machine_id, &add.id),
        &signature,
    );
    if signed.is_err() || answer.nonce != offer.nonce || answer.add != add.id || answer.machine_id != target.descriptor.machine_id {
        return Err(JoinError::Refused("The join answer did not come from the machine that was asked.".into()));
    }
    let outcome = network.apply_remote(None, vec![add])?;
    let _ = outcome;
    tracing::info!(target: TARGET, machine = %target.descriptor.machine_id, ?via, "added a machine to the network");
    network.wake();
    Ok(super::status::card(state, &target.descriptor.machine_id).await.unwrap_or_else(|| fallback_card(target)))
}

fn fallback_card(target: &Candidate) -> MachineCard {
    MachineCard {
        machine_id: target.descriptor.machine_id.clone(),
        name: target.descriptor.name.clone(),
        os: target.descriptor.os.clone(),
        arch: None,
        ts_name: target.descriptor.ts_name.clone(),
        signing_key: Some(target.descriptor.signing_key.clone()),
        status: kybern_protocol::MachineStatus::Offline,
        is_self: false,
        version: None,
        network_protocol: 0,
        features: Vec::new(),
        last_seen_at: None,
        relay_via: None,
        harnesses: Vec::new(),
        allow: Default::default(),
        added_by: None,
        added_via: Some(JoinVia::Code),
        added_at: None,
    }
}

// ---- the offer: the target's side ----

fn refuse(status: StatusCode, message: impl Into<String>) -> Response {
    (status, message.into()).into_response()
}

/// `POST /network/offer`.
pub async fn serve_offer(State(state): State<AppState>, Peer(peer): Peer, Json(offer): Json<Offer>) -> Response {
    match accept(&state, peer.map(|peer| peer.ip()), offer).await {
        Ok(answer) => Json(answer).into_response(),
        Err((status, reason)) => {
            tracing::warn!(target: TARGET, %reason, "refused an offer to join a network");
            refuse(status, reason)
        }
    }
}

type Refusal = (StatusCode, String);

fn forbidden(reason: impl Into<String>) -> Refusal {
    (StatusCode::FORBIDDEN, reason.into())
}

/// The target checks the offer; on success it keeps the set and signs.
async fn accept(state: &AppState, source: Option<IpAddr>, offer: Offer) -> Result<OfferAnswer, Refusal> {
    let network = &state.network;
    let Some(membership) = network.membership() else {
        return Err((StatusCode::SERVICE_UNAVAILABLE, "the machine network is unavailable on this machine".into()));
    };
    if !network.is_enabled() {
        return Err((StatusCode::NOT_FOUND, "the machine network is turned off on this machine".into()));
    }
    let me = membership.machine_id();
    if offer.to != me {
        return Err((StatusCode::BAD_REQUEST, "this offer is for another machine".into()));
    }
    if offer.ops.len() > MAX_OFFER_OPS || offer.ops.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "the offer carries no usable operations".into()));
    }
    if membership.has_network() {
        return Err((StatusCode::CONFLICT, "this machine is already in a network".into()));
    }

    // What the offered set says: who adds this machine, and which network and owner it is.
    let (adder, descriptor, projection) = inspect(&offer)?;
    if descriptor.machine_id != me || descriptor.signing_key != membership.keys().signing_public_b64() {
        return Err((StatusCode::BAD_REQUEST, "the offered operation does not describe this machine".into()));
    }

    match offer.via {
        JoinVia::Code | JoinVia::Migrate => {
            let code = offer.code.as_deref().ok_or_else(|| (StatusCode::UNAUTHORIZED, "a code is required".to_string()))?;
            state.pairing.redeem_machine_code(code).map_err(|error| {
                if error.is::<crate::access::PairingRateLimited>() {
                    (StatusCode::TOO_MANY_REQUESTS, error.to_string())
                } else {
                    (StatusCode::UNAUTHORIZED, "that code is wrong or has expired".into())
                }
            })?;
        }
        JoinVia::Auto | JoinVia::Found => verify_clicker(network, source, &offer, &adder, &descriptor, &projection).await?,
    }

    match membership.join(offer.ops.clone()) {
        Ok(_) => {}
        Err(MembershipError::AlreadyInNetwork) => return Err((StatusCode::CONFLICT, "this machine is already in a network".into())),
        Err(error) => return Err((StatusCode::BAD_REQUEST, error.to_string())),
    }
    tracing::info!(target: TARGET, adder = %adder, via = ?offer.via, "joined a network");
    network.notify_changed();
    network.wake();
    let signature = membership.keys().sign(&offer_response_message(&offer.nonce, &me, &offer.add));
    Ok(OfferAnswer { machine_id: me, nonce: offer.nonce, add: offer.add, sig: B64.encode(signature) })
}

/// Parse the offered set the way a joining machine would adopt it and read off the add for this
/// machine: its signer, its descriptor, and the projection (owner login, tailnet, members).
fn inspect(offer: &Offer) -> Result<(String, MachineDescriptor, Projection), Refusal> {
    let bad = |reason: &str| (StatusCode::BAD_REQUEST, reason.to_string());
    let mut parsed = Vec::with_capacity(offer.ops.len());
    for envelope in &offer.ops {
        parsed.push(ops::parse(envelope).map_err(|error| bad(&error.to_string()))?);
    }
    let add = parsed.iter().find(|op| op.id() == offer.add).ok_or_else(|| bad("the offer does not hold the operation it names"))?;
    let OpKind::Add { machine, via } = &add.op else { return Err(bad("the named operation is not an add")) };
    if *via != offer.via {
        return Err(bad("the add was written for another way of joining"));
    }
    let adder = add.signer().to_string();
    let descriptor = machine.clone();
    let mut set = OpSet::default();
    set.apply(parsed, true);
    let projection = set.project();
    if !projection.is_member(&adder) {
        return Err(bad("the machine that offers is not a member of its own network"));
    }
    Ok((adder, descriptor, projection))
}

/// The tailnet half of an auto or found join: who is calling, and whether this machine can verify
/// them (§2.4a, §2.4b).
async fn verify_clicker(
    network: &Network,
    source: Option<IpAddr>,
    offer: &Offer,
    adder: &str,
    descriptor: &MachineDescriptor,
    projection: &Projection,
) -> Result<(), Refusal> {
    let source = source.ok_or_else(|| forbidden("the source address is unknown"))?;
    let Some(me) = Me::read(network).await else {
        return Err(forbidden("Tailscale is not running on this machine, so it cannot verify who is adding it"));
    };
    let whois: Whois =
        network.tailscale.whois(source).await.map_err(|error| forbidden(format!("the source is not on the tailnet: {error}")))?;
    let adder_node = projection.entry(adder).and_then(|entry| entry.descriptor.ts_node_id.clone());
    if adder_node.as_deref() != Some(whois.node_id.as_str()) {
        return Err(forbidden("the source address is not the tailnet node of the machine that offers"));
    }
    let owner = projection.owner_login.as_deref().unwrap_or_default();
    if !whois.is_owner(owner) {
        return Err(forbidden("the machine that offers is not an untagged node of the network's owner"));
    }
    if let (Some(mine), Some(theirs)) = (me.status.self_node.as_ref().map(|node| node.node_id.as_str()), descriptor.ts_node_id.as_deref())
        && !mine.is_empty()
        && mine != theirs
    {
        return Err((StatusCode::BAD_REQUEST, "the offered operation names another tailnet node".into()));
    }
    // The owner on the other side must be this node's owner too (auto), or this node must be a
    // tagged node of the same one-user tailnet (found).
    let own_owner = me.login.as_deref().is_some_and(|login| !me.tagged && !me.shared_in && login.eq_ignore_ascii_case(owner));
    let tagged_ok = me.tagged
        && !me.shared_in
        && me.status.tailnet.as_deref().is_some_and(|tailnet| Some(tailnet) == projection.tailnet.as_deref())
        && me.status.human_users() == 1;
    match offer.via {
        JoinVia::Auto if own_owner => Ok(()),
        JoinVia::Found if own_owner || tagged_ok => Ok(()),
        JoinVia::Auto => Err(forbidden("this machine does not belong to the network's owner")),
        _ => Err(forbidden("this machine cannot verify who is adding it; enter the code shown here instead")),
    }
}

// ---- discovery: auto-join ----

/// After a discovery pass: offer to every found machine that can be added without a click. A lone
/// machine founds the network only when it meets a same-user machine with a larger machine id, so
/// two lone machines never both found one (§2.4).
pub async fn auto_join(state: &AppState, status: &TsStatus) {
    let network = &state.network;
    let Some(membership) = network.membership() else { return };
    if !network.timing.auto_join || !network.is_enabled() || membership.key_mismatch() || membership.self_removed() {
        return;
    }
    let Some(self_node) = status.self_node.as_ref() else { return };
    let me = Me {
        status: status.clone(),
        login: status.login_of(self_node.user_id).map(str::to_string),
        tagged: self_node.tagged(),
        shared_in: self_node.shared_in,
    };
    if !me.can_vouch() {
        return;
    }
    let lone = !membership.has_network();
    let my_id = membership.machine_id();
    let projection = membership.projection();
    let found = network.peers.found();
    if lone {
        // A lone machine founds the network only when no one else will: a network of this owner
        // on the tailnet adds it from there, and a lone machine with a smaller id founds before it.
        // That keeps three lone machines from founding two networks (§2.4).
        let owner = me.login.clone().unwrap_or_default();
        let waits_for_another = found.iter().any(|entry| {
            entry.whois.as_ref().is_some_and(|whois| whois.is_owner(&owner))
                && (entry.descriptor.network_id.is_some() || entry.descriptor.machine_id.as_str() < my_id.as_str())
        });
        if waits_for_another {
            return;
        }
    }
    for entry in found {
        let node_id = entry.node.node_id.clone();
        // A removed node never rejoins on its own (§2.6).
        if projection.is_node_tombstoned(&node_id) || !network.join.due(&node_id) {
            continue;
        }
        if classify(&me, &projection, &entry) != Plan::Auto {
            continue;
        }
        let result = async {
            ensure_network(state).await?;
            let target = candidate(
                &well_known::base_url(
                    network.tailscale.dial_target(entry.node.ip().ok_or_else(|| JoinError::Invalid("no address".into()))?),
                    entry.port,
                ),
                &entry.descriptor,
                Some(&entry.node),
            );
            verify_target(network, &target, &entry.descriptor).await?;
            send_offer(state, &target, JoinVia::Auto, None).await
        }
        .await;
        match result {
            Ok(card) => {
                network.join.forget(&node_id);
                tracing::info!(target: DISCOVERY_TARGET, machine = %card.machine_id, "joined a machine of the same Tailscale user");
            }
            Err(JoinError::TargetInNetwork) => {
                // It joined another network meanwhile; the next probe tells what to do.
                network.join.failed(&node_id, &network.timing);
            }
            Err(error) => {
                tracing::debug!(target: DISCOVERY_TARGET, node = %node_id, %error, "could not join a machine automatically");
                network.join.failed(&node_id, &network.timing);
                // What answered earlier no longer does (it moved or restarted): look again next pass.
                if matches!(error, JoinError::Identity(ProbeError::Unreachable(_))) {
                    network.peers.replace_found(&node_id, None);
                }
            }
        }
    }
}

/// What a found machine answers right now. The list is up to ten minutes old, and a machine can
/// have moved to another port or rejoined with a new identity since (§2.6), so a click or an offer
/// asks again first. A machine that no longer answers is dropped from the list.
async fn refresh(state: &AppState, entry: FoundEntry) -> Option<FoundEntry> {
    let node_id = entry.node.node_id.clone();
    let fresh = super::peers::probe_node(state, entry.node.clone()).await;
    state.network.peers.replace_found(&node_id, fresh.clone());
    if fresh.is_none() {
        state.network.notify_changed();
    }
    fresh
}

/// The identity check before an offer: the target answers a fresh nonce with the key it showed
/// when it was found (§3.2). Nothing is sent to an address that cannot prove it.
async fn verify_target(network: &Network, target: &Candidate, seen: &WellKnown) -> Result<WellKnown, JoinError> {
    let timeout = if target.base.contains("127.") { Duration::from_secs(3) } else { Duration::from_secs(10) };
    let answer = well_known::probe(
        &network.http,
        &target.base,
        Some(Expected { machine_id: &seen.machine_id, signing_key: &seen.signing_key }),
        timeout,
        network.timing.clock_window,
    )
    .await?;
    if answer.network_id.is_some() {
        return Err(JoinError::TargetInNetwork);
    }
    Ok(answer)
}

// ---- Add (one click) ----

/// `network.add`: join a machine found on the tailnet. `needs_code` when the target cannot verify
/// the click (§2.4b).
pub async fn add_found(state: &AppState, found_id: &str) -> Result<kybern_protocol::NetworkAddResult, JoinError> {
    let network = &state.network;
    let membership = network.membership().ok_or_else(|| JoinError::Unavailable(unavailable_reason(network)))?;
    let entry = network
        .peers
        .found()
        .into_iter()
        .find(|entry| entry.node.node_id == found_id)
        .ok_or_else(|| JoinError::NotFound("that machine is no longer on your tailnet".into()))?;
    let entry = refresh(state, entry)
        .await
        .ok_or_else(|| JoinError::NotFound("that machine no longer answers; check that Kybern is running on it".into()))?;
    let me = Me::read(network).await.ok_or_else(|| JoinError::Unavailable("Tailscale is not running on this machine.".into()))?;
    let projection = membership.projection();
    let plan = classify(&me, &projection, &entry);
    let via = match plan {
        Plan::Auto if projection.is_node_tombstoned(found_id) => JoinVia::Found,
        Plan::Auto => JoinVia::Auto,
        Plan::Click => JoinVia::Found,
        Plan::Code => return Ok(kybern_protocol::NetworkAddResult { machine: None, needs_code: true }),
        Plan::Merge => return Err(JoinError::Invalid("That machine is in another of your networks. Merge them instead.".into())),
        Plan::Hidden => return Err(JoinError::NotFound("that machine cannot be added from here".into())),
    };
    ensure_network(state).await?;
    let ip = entry.node.ip().ok_or_else(|| JoinError::Invalid("that machine has no tailnet address".into()))?;
    let target = candidate(&well_known::base_url(network.tailscale.dial_target(ip), entry.port), &entry.descriptor, Some(&entry.node));
    verify_target(network, &target, &entry.descriptor).await?;
    match send_offer(state, &target, via, None).await {
        Ok(card) => Ok(kybern_protocol::NetworkAddResult { machine: Some(card), needs_code: false }),
        // The target could not verify the click after all: the code flow is the way in.
        Err(JoinError::Refused(reason)) => {
            tracing::info!(target: TARGET, %reason, "a codeless add was refused; asking for the code");
            Ok(kybern_protocol::NetworkAddResult { machine: None, needs_code: true })
        }
        Err(error) => Err(error),
    }
}

// ---- code join and migration ----

/// Whether `address` may carry a join code and a membership set in plain HTTP: loopback, private
/// networks and the tailnet (§3.3). Anything else must be `https`.
pub fn address_allowed(url: &reqwest::Url, fake: bool) -> bool {
    if url.scheme() == "https" {
        return true;
    }
    if url.scheme() != "http" {
        return false;
    }
    let Some(host) = url.host_str() else { return false };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => {
            let o = ip.octets();
            (ip.is_loopback() && (fake || o[0] == 127)) || ip.is_private() || ip.is_link_local() || (o[0] == 100 && (o[1] & 0xc0) == 0x40)
        }
        Ok(IpAddr::V6(ip)) => {
            let s = ip.segments();
            ip.is_loopback() || (s[0] & 0xfe00) == 0xfc00 || (s[0] & 0xffc0) == 0xfe80
        }
        Err(_) => {
            let name = host.to_ascii_lowercase();
            name == "localhost" || name.ends_with(".local") || name.ends_with(".ts.net") || name.ends_with(".localhost")
        }
    }
}

fn base_of(address: &str, fake: bool) -> Result<String, JoinError> {
    let text = address.trim();
    if text.is_empty() {
        return Err(JoinError::Invalid("Enter the address shown on the machine you are adding.".into()));
    }
    let with_scheme = if text.contains("://") { text.to_string() } else { format!("http://{text}") };
    let mut url = reqwest::Url::parse(&with_scheme).map_err(|_| JoinError::Invalid("That address is not valid.".into()))?;
    if url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
        return Err(JoinError::Invalid("Use an address without credentials.".into()));
    }
    // A `ws://` address is the same listener.
    match url.scheme() {
        "ws" => {
            let _ = url.set_scheme("http");
        }
        "wss" => {
            let _ = url.set_scheme("https");
        }
        _ => {}
    }
    if url.port().is_none() && url.scheme() == "http" {
        let _ = url.set_port(Some(kybern_protocol::DEFAULT_PORT));
    }
    if !address_allowed(&url, fake) {
        return Err(JoinError::Invalid(
            "That address is outside your private networks. Use an https address, or its Tailscale address.".into(),
        ));
    }
    Ok(url.origin().ascii_serialization())
}

/// `network.join`: add the machine that shows `code` at `address` (§2.4c, §2.4d).
pub async fn join_by_code(state: &AppState, code: &str, address: &str, migrate: bool) -> Result<MachineCard, JoinError> {
    let network = &state.network;
    if network.membership().is_none() {
        return Err(JoinError::Unavailable(unavailable_reason(network)));
    }
    let code = code.trim();
    if code.len() != 6 || !code.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(JoinError::Invalid("The code is six digits.".into()));
    }
    let base = base_of(address, network.tailscale.is_fake())?;
    // Before the code or the set leaves this machine, the address must prove it is a Kybern machine
    // with a key; the code then decides whether it is the one to add.
    let timeout = if base.contains("127.") || base.contains("localhost") { Duration::from_secs(3) } else { Duration::from_secs(10) };
    let answer = well_known::probe(&network.http, &base, None, timeout, network.timing.clock_window).await?;
    if answer.network_id.is_some() {
        return Err(JoinError::TargetInNetwork);
    }
    if answer.machine_id == network.machine_id().unwrap_or_default() {
        return Err(JoinError::Invalid("That is this machine.".into()));
    }
    let node = match network.tailscale.status().await {
        Ok(status) if status.running => {
            answer.ts_name.as_deref().and_then(|name| status.peers.iter().find(|peer| peer.dns_name == name)).cloned()
        }
        _ => None,
    };
    ensure_network(state).await?;
    let target = candidate(&base, &answer, node.as_ref());
    send_offer(state, &target, if migrate { JoinVia::Migrate } else { JoinVia::Code }, Some(code.to_string())).await
}

/// `network.code.create`: the code this machine shows so a member can add it.
pub async fn create_code(state: &AppState) -> Result<kybern_protocol::NetworkCodeCreateResult, JoinError> {
    let network = &state.network;
    let membership = network.membership().ok_or_else(|| JoinError::Unavailable(unavailable_reason(network)))?;
    if !network.is_enabled() {
        return Err(JoinError::Unavailable("Connect to your other machines is turned off on this machine.".into()));
    }
    if membership.has_network() {
        return Err(JoinError::Invalid("This machine is already in a network. Remove it there to add it to another.".into()));
    }
    let (code, expires_at) = state.pairing.create_machine_code().map_err(|error| JoinError::Refused(error.to_string()))?;
    let mut endpoints = crate::access::endpoints(state).await;
    // The network listener, when it is up, is the address a tailnet member reaches this machine on.
    if let (Some(port), Some(ip)) = (network.listening_port(), network.tailscale.listen_ip().await) {
        let own = format!("http://{}", std::net::SocketAddr::new(ip, port));
        if !endpoints.contains(&own) {
            endpoints.insert(0, own);
        }
    }
    let url = endpoints.first().cloned().unwrap_or_default();
    let mut link = reqwest::Url::parse("kybern://join").expect("a constant link");
    link.query_pairs_mut().append_pair("url", &url).append_pair("code", &code).append_pair("machine", &membership.machine_id());
    Ok(kybern_protocol::NetworkCodeCreateResult { code, expires_at, endpoints, qr: link.to_string() })
}

// ---- merging two networks of one owner ----

/// `network.merge`: join this machine's network with the one a found machine is in (§2.4a).
pub async fn merge(state: &AppState, found_id: &str) -> Result<(), JoinError> {
    let network = &state.network;
    let membership = network.membership().ok_or_else(|| JoinError::Unavailable(unavailable_reason(network)))?;
    let entry = network
        .peers
        .found()
        .into_iter()
        .find(|entry| entry.node.node_id == found_id)
        .ok_or_else(|| JoinError::NotFound("that machine is no longer on your tailnet".into()))?;
    let entry = refresh(state, entry)
        .await
        .ok_or_else(|| JoinError::NotFound("that machine no longer answers; check that Kybern is running on it".into()))?;
    let me = Me::read(network).await.ok_or_else(|| JoinError::Unavailable("Tailscale is not running on this machine.".into()))?;
    if classify(&me, &membership.projection(), &entry) != Plan::Merge {
        return Err(JoinError::Invalid("That machine is not in another of your networks.".into()));
    }
    let genesis = membership.genesis_envelope().ok_or(MembershipError::NoNetwork)?;
    let ip = entry.node.ip().ok_or_else(|| JoinError::Invalid("that machine has no tailnet address".into()))?;
    let base = well_known::base_url(network.tailscale.dial_target(ip), entry.port);
    let seen = &entry.descriptor;
    let proof = well_known::probe(
        &network.http,
        &base,
        Some(Expected { machine_id: &seen.machine_id, signing_key: &seen.signing_key }),
        Duration::from_secs(10),
        network.timing.clock_window,
    )
    .await?;
    if proof.network_id.is_none() {
        return Err(JoinError::Invalid("That machine left its network; it can be added directly.".into()));
    }
    let offer = MergeOffer { nonce: well_known::new_nonce(), to: seen.machine_id.clone(), genesis, ops: membership.all_ops() };
    let response = network
        .http
        .post(format!("{base}{MERGE_PATH}"))
        .timeout(Duration::from_secs(20))
        .json(&offer)
        .send()
        .await
        .map_err(|error| JoinError::Transport(format!("Could not reach that machine: {}", error.without_url())))?;
    if !response.status().is_success() {
        let message = response.text().await.unwrap_or_default();
        return Err(JoinError::Refused(message.chars().take(300).collect()));
    }
    let answer: MergeAnswer =
        response.json().await.map_err(|_| JoinError::Transport("That machine answered with something unreadable.".into()))?;
    let signature = B64.decode(&answer.sig).map_err(|_| JoinError::Refused("The merge answer is not signed.".into()))?;
    let signed =
        keys::verify_signature(&seen.signing_key, &merge_response_message(&offer.nonce, &seen.machine_id, &answer.genesis.id), &signature);
    if signed.is_err() || answer.nonce != offer.nonce || answer.machine_id != seen.machine_id {
        return Err(JoinError::Refused("The merge answer did not come from the machine that was asked.".into()));
    }
    // Our side of the merge names their genesis; their members' operations then belong to a
    // network this set holds.
    let merge_op = match membership.merge(answer.genesis.clone()) {
        Ok(op) => Some(op),
        Err(MembershipError::Invalid(_)) => None,
        Err(error) => return Err(error.into()),
    };
    if let Some(op) = merge_op {
        network.publish_ops(vec![op]);
    }
    network.apply_remote(None, answer.ops)?;
    network.wake();
    tracing::info!(target: TARGET, machine = %seen.machine_id, "merged two networks");
    Ok(())
}

/// `POST /network/merge`: the other network's member asks this machine to merge.
pub async fn serve_merge(State(state): State<AppState>, Peer(peer): Peer, Json(offer): Json<MergeOffer>) -> Response {
    match accept_merge(&state, peer.map(|peer| peer.ip()), offer).await {
        Ok(answer) => Json(answer).into_response(),
        Err((status, reason)) => {
            tracing::warn!(target: TARGET, %reason, "refused to merge networks");
            refuse(status, reason)
        }
    }
}

async fn accept_merge(state: &AppState, source: Option<IpAddr>, offer: MergeOffer) -> Result<MergeAnswer, Refusal> {
    let network = &state.network;
    let Some(membership) = network.membership() else {
        return Err((StatusCode::SERVICE_UNAVAILABLE, "the machine network is unavailable on this machine".into()));
    };
    if !network.is_enabled() {
        return Err((StatusCode::NOT_FOUND, "the machine network is turned off on this machine".into()));
    }
    let me = membership.machine_id();
    if offer.to != me {
        return Err((StatusCode::BAD_REQUEST, "this offer is for another machine".into()));
    }
    if offer.ops.len() > MAX_OFFER_OPS {
        return Err((StatusCode::BAD_REQUEST, "the offer carries too many operations".into()));
    }
    if !membership.self_is_member() {
        return Err((StatusCode::CONFLICT, "this machine is not a member of a network".into()));
    }
    let projection = membership.projection();
    let owner = projection.owner_login.clone().unwrap_or_default();
    let source = source.ok_or_else(|| forbidden("the source address is unknown"))?;
    let whois = network.tailscale.whois(source).await.map_err(|error| forbidden(format!("the source is not on the tailnet: {error}")))?;
    if !whois.is_owner(&owner) {
        return Err(forbidden("the machine that offers is not an untagged node of this network's owner"));
    }
    let own = Me::read(network).await.ok_or_else(|| forbidden("Tailscale is not running on this machine"))?;
    if !own.can_vouch() && own.tagged && own.status.human_users() != 1 {
        return Err(forbidden("this machine cannot verify who is merging"));
    }
    // The signer of the offered genesis' network must belong to the node that is calling.
    let theirs = ops::parse(&offer.genesis).map_err(|error| (StatusCode::BAD_REQUEST, error.to_string()))?;
    if !matches!(theirs.op, OpKind::Genesis { .. }) {
        return Err((StatusCode::BAD_REQUEST, "a merge carries the other network's genesis".into()));
    }
    let own_genesis = membership.genesis_envelope().ok_or((StatusCode::CONFLICT, "this machine has no network".to_string()))?;
    let merge_op = match membership.merge(offer.genesis.clone()) {
        Ok(op) => Some(op),
        Err(MembershipError::Invalid(_)) => None,
        Err(error) => return Err((StatusCode::BAD_REQUEST, error.to_string())),
    };
    if let Some(op) = merge_op {
        network.publish_ops(vec![op]);
    }
    let _ = network.apply_remote(None, offer.ops);
    network.wake();
    let signature = membership.keys().sign(&merge_response_message(&offer.nonce, &me, &own_genesis.id));
    Ok(MergeAnswer { machine_id: me, nonce: offer.nonce, genesis: own_genesis, ops: membership.all_ops(), sig: B64.encode(signature) })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(text: &str) -> reqwest::Url {
        reqwest::Url::parse(text).unwrap()
    }

    #[test]
    fn plain_http_addresses_are_limited_to_private_networks() {
        assert!(address_allowed(&url("https://example.com"), false));
        assert!(address_allowed(&url("http://100.101.102.103:4173"), false));
        assert!(address_allowed(&url("http://192.168.1.20:4173"), false));
        assert!(address_allowed(&url("http://10.0.0.5:4173"), false));
        assert!(address_allowed(&url("http://localhost:4173"), false));
        assert!(address_allowed(&url("http://satyamas.tail1234.ts.net:4173"), false));
        assert!(address_allowed(&url("http://[fd7a:115c:a1e0::1]:4173"), false));
        assert!(!address_allowed(&url("http://203.0.113.7:4173"), false));
        assert!(!address_allowed(&url("http://example.com:4173"), false));
        assert!(!address_allowed(&url("ftp://192.168.1.20"), false));
    }

    #[test]
    fn an_address_is_normalized_to_its_origin_and_the_default_port() {
        assert_eq!(base_of("100.64.0.9", false).unwrap(), "http://100.64.0.9:4173");
        assert_eq!(base_of("ws://100.64.0.9:4180/ws", false).unwrap(), "http://100.64.0.9:4180");
        assert_eq!(base_of("https://box.example.com", false).unwrap(), "https://box.example.com");
        assert!(base_of("", false).is_err());
        assert!(base_of("http://user:pw@100.64.0.9", false).is_err());
        assert!(base_of("http://8.8.8.8:4173", false).is_err());
    }
}
