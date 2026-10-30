//! `GET /.well-known/kybern/machine?nonce=<b64url>` (design §3.2): the unauthenticated identity
//! endpoint, and the check every caller runs on it before it sends a credential to an address.
//!
//! The answer carries only public data: the machine's id, name, version, features and public keys,
//! and a signature over the caller's nonce. The signed message is
//! `"kybern-wk-v1\0" ‖ nonce ‖ machine_id ‖ at ‖ host` as UTF-8 with no separators, where `nonce`
//! is the string the caller sent and `host` the `Host` header it sent. The client in
//! `packages/kybern-client/src/machineRoutes.ts` builds the same message, so the two must change
//! together.

use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, SocketAddr};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::extract::{Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use base64::Engine;
use base64::engine::general_purpose::{STANDARD as B64, URL_SAFE_NO_PAD as B64URL};
use chrono::{DateTime, SecondsFormat, Utc};
use kybern_protocol::{NETWORK_PROTOCOL, WELL_KNOWN_PROOF_DOMAIN};
use rand::RngExt;
use serde::{Deserialize, Serialize};

use super::keys::{self, MachineKeys};
use crate::state::AppState;
use crate::ws::Peer;

pub const PATH: &str = "/.well-known/kybern/machine";

/// Requests per minute per source address (§3.2).
const RATE_LIMIT: usize = 30;
const MAX_TRACKED_SOURCES: usize = 4096;

/// What the endpoint answers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WellKnown {
    pub machine_id: String,
    pub name: String,
    pub os: String,
    pub arch: String,
    pub version: String,
    pub network_protocol: u32,
    #[serde(default)]
    pub features: Vec<String>,
    /// Ed25519 public key, standard base64.
    pub signing_key: String,
    /// X25519 public key, standard base64.
    pub sealing_key: String,
    #[serde(default)]
    pub network_id: Option<String>,
    #[serde(default)]
    pub ts_name: Option<String>,
    /// The port the Tailscale listener holds, when it is not the default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    /// The daemon's clock, RFC 3339.
    pub at: String,
    /// Ed25519 signature, standard base64.
    pub proof: String,
}

/// The bytes the daemon signs.
pub fn proof_message(nonce: &str, machine_id: &str, at: &str, host: &str) -> Vec<u8> {
    let mut message = Vec::with_capacity(WELL_KNOWN_PROOF_DOMAIN.len() + nonce.len() + machine_id.len() + at.len() + host.len());
    for part in [WELL_KNOWN_PROOF_DOMAIN, nonce, machine_id, at, host] {
        message.extend_from_slice(part.as_bytes());
    }
    message
}

/// A fresh 32-byte nonce, base64url without padding.
pub fn new_nonce() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill(&mut bytes);
    B64URL.encode(bytes)
}

/// Whether `nonce` is shaped like one a client sends: base64url, 16 to 64 characters.
fn nonce_is_valid(nonce: &str) -> bool {
    (16..=64).contains(&nonce.len()) && nonce.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

pub fn now_rfc3339() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

/// Per-source request counts over the last minute.
#[derive(Default)]
pub struct RateLimiter {
    sources: Mutex<HashMap<IpAddr, VecDeque<Instant>>>,
}

impl RateLimiter {
    /// Count a request from `ip`; `false` once it has made [`RATE_LIMIT`] in the last minute. The
    /// local machine is not limited: relayed requests reach a daemon from its own loopback address.
    pub fn allow(&self, ip: IpAddr) -> bool {
        if ip == IpAddr::from([127, 0, 0, 1]) || ip == IpAddr::from(std::net::Ipv6Addr::LOCALHOST) {
            return true;
        }
        let mut sources = self.sources.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let now = Instant::now();
        if sources.len() >= MAX_TRACKED_SOURCES {
            sources.retain(|_, hits| hits.back().is_some_and(|at| now.duration_since(*at) < Duration::from_secs(60)));
        }
        let hits = sources.entry(ip).or_default();
        while hits.front().is_some_and(|at| now.duration_since(*at) >= Duration::from_secs(60)) {
            hits.pop_front();
        }
        if hits.len() >= RATE_LIMIT {
            return false;
        }
        hits.push_back(now);
        true
    }
}

/// Build and sign the answer for a nonce and a `Host`.
pub async fn answer(state: &AppState, keys: &MachineKeys, machine_id: &str, nonce: &str, host: &str) -> WellKnown {
    let network = &state.network;
    let ts = network.self_ts().await;
    let at = now_rfc3339();
    let proof = B64.encode(keys.sign(&proof_message(nonce, machine_id, &at, host)));
    WellKnown {
        machine_id: machine_id.to_string(),
        name: crate::rpc::hostname(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        network_protocol: NETWORK_PROTOCOL,
        features: network.features(),
        signing_key: keys.signing_public_b64(),
        sealing_key: keys.sealing_public_b64(),
        network_id: network.membership().and_then(|membership| membership.network_id()),
        ts_name: ts.name,
        port: network.listening_port().filter(|port| *port != kybern_protocol::DEFAULT_PORT),
        at,
        proof,
    }
}

/// The route handler. It is served on every listener, so a client can verify a route it reached
/// over loopback, the tailnet or a relay.
pub async fn serve(
    State(state): State<AppState>,
    Peer(peer): Peer,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let Some(membership) = state.network.membership() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "the machine network is unavailable on this machine").into_response();
    };
    if let Some(peer) = peer
        && !state.network.limiter.allow(peer.ip())
    {
        return (StatusCode::TOO_MANY_REQUESTS, "too many identity checks; wait a minute").into_response();
    }
    let Some(nonce) = query.get("nonce").filter(|nonce| nonce_is_valid(nonce)) else {
        return (StatusCode::BAD_REQUEST, "pass nonce=<32 bytes, base64url>").into_response();
    };
    let Some(host) = headers.get(header::HOST).and_then(|host| host.to_str().ok()) else {
        return (StatusCode::BAD_REQUEST, "a Host header is required").into_response();
    };
    // Someone asking who we are may be a machine that has just started: look at the tailnet again soon.
    if state.network.is_enabled()
        && let Some(peer) = peer
        && let Ok(whois) = state.network.tailscale.whois(peer.ip()).await
    {
        // A node of the tailnet asked: only that node is looked at again. A local caller is no news.
        state.network.nudge_discovery(Some(&whois.node_id));
    }
    let keys = membership.keys();
    let body = answer(&state, &keys, &membership.machine_id(), nonce, host).await;
    let mut response = axum::Json(body).into_response();
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// Why an identity check failed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ProbeError {
    #[error("{0}")]
    Unreachable(String),
    #[error("the address answered as a different machine")]
    WrongMachine,
    #[error("the address could not prove its identity")]
    BadProof,
    #[error("the address answered with a clock that is too far from ours")]
    Stale,
    #[error("the address did not answer like a Kybern machine")]
    Malformed,
}

/// The machine a check expects: its id and the signing key from the membership set.
#[derive(Debug, Clone, Copy)]
pub struct Expected<'a> {
    pub machine_id: &'a str,
    pub signing_key: &'a str,
}

/// The authority (`host:port`) of a base URL: the `host` the proof covers.
pub fn authority(base: &str) -> &str {
    let rest = base.split_once("://").map_or(base, |(_, rest)| rest);
    rest.split(['/', '?', '#']).next().unwrap_or(rest)
}

/// Check an answer: the signature over our nonce and host verifies against the key it names, `at`
/// is within `window`, and, when `expected` is given, the machine id and key are the expected ones.
/// With no expectation the answer proves only that whoever answered holds the key it reports.
pub fn verify(answer: &WellKnown, nonce: &str, host: &str, expected: Option<Expected<'_>>, window: Duration) -> Result<(), ProbeError> {
    if let Some(expected) = expected
        && (answer.machine_id != expected.machine_id || answer.signing_key != expected.signing_key)
    {
        return Err(ProbeError::WrongMachine);
    }
    let signature = B64.decode(&answer.proof).map_err(|_| ProbeError::BadProof)?;
    keys::verify_signature(&answer.signing_key, &proof_message(nonce, &answer.machine_id, &answer.at, host), &signature)
        .map_err(|_| ProbeError::BadProof)?;
    let at = DateTime::parse_from_rfc3339(&answer.at).map_err(|_| ProbeError::Malformed)?;
    let skew = (Utc::now() - at.with_timezone(&Utc)).abs();
    if skew > chrono::Duration::from_std(window).unwrap_or(chrono::Duration::seconds(60)) {
        return Err(ProbeError::Stale);
    }
    Ok(())
}

/// `GET <base>/.well-known/kybern/machine?nonce=…` and check the answer (§3.2). `base` is
/// `http://<ip>:<port>`; no credential is sent.
pub async fn probe(
    http: &reqwest::Client,
    base: &str,
    expected: Option<Expected<'_>>,
    timeout: Duration,
    window: Duration,
) -> Result<WellKnown, ProbeError> {
    let nonce = new_nonce();
    let url = format!("{}{PATH}?nonce={nonce}", base.trim_end_matches('/'));
    let response = http.get(&url).timeout(timeout).send().await.map_err(|error| ProbeError::Unreachable(describe(&error)))?;
    if !response.status().is_success() {
        return Err(ProbeError::Unreachable(format!("answered {}", response.status())));
    }
    let answer: WellKnown = response.json().await.map_err(|_| ProbeError::Malformed)?;
    verify(&answer, &nonce, authority(base), expected, window)?;
    tracing::trace!(target: "kybern::network::discovery", machine = %answer.machine_id, "identity proof verified");
    Ok(answer)
}

fn describe(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "timed out".into()
    } else if error.is_connect() {
        "could not connect".into()
    } else {
        "the request failed".to_string()
    }
}

/// The address a probe or a dial uses for a peer, with a loopback address in brackets when needed.
pub fn base_url(ip: IpAddr, port: u16) -> String {
    format!("http://{}", SocketAddr::new(ip, port))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signed(keys: &MachineKeys, machine_id: &str, nonce: &str, host: &str, at: &str) -> WellKnown {
        WellKnown {
            machine_id: machine_id.into(),
            name: "m".into(),
            os: "linux".into(),
            arch: "x86_64".into(),
            version: "0".into(),
            network_protocol: 1,
            features: vec![],
            signing_key: keys.signing_public_b64(),
            sealing_key: keys.sealing_public_b64(),
            network_id: None,
            ts_name: None,
            port: None,
            at: at.into(),
            proof: B64.encode(keys.sign(&proof_message(nonce, machine_id, at, host))),
        }
    }

    #[test]
    fn the_proof_message_is_the_documented_concatenation() {
        assert_eq!(proof_message("n", "m", "t", "h:1"), b"kybern-wk-v1\0nmth:1");
    }

    #[test]
    fn a_proof_verifies_only_for_its_nonce_host_machine_and_key() {
        let keys = MachineKeys::generate();
        let other = MachineKeys::generate();
        let window = Duration::from_secs(60);
        let answer = signed(&keys, "mid", "nonce-nonce-nonce-1", "10.0.0.1:4173", &now_rfc3339());
        let expected = Expected { machine_id: "mid", signing_key: &keys.signing_public_b64() };
        verify(&answer, "nonce-nonce-nonce-1", "10.0.0.1:4173", Some(expected), window).unwrap();
        verify(&answer, "nonce-nonce-nonce-1", "10.0.0.1:4173", None, window).unwrap();
        // A replayed answer for another nonce or another address fails.
        assert_eq!(verify(&answer, "nonce-nonce-nonce-2", "10.0.0.1:4173", None, window), Err(ProbeError::BadProof));
        assert_eq!(verify(&answer, "nonce-nonce-nonce-1", "10.0.0.2:4173", None, window), Err(ProbeError::BadProof));
        // An impostor with its own key is refused against the expected key, before any proof.
        let impostor = signed(&other, "mid", "nonce-nonce-nonce-1", "10.0.0.1:4173", &now_rfc3339());
        assert_eq!(verify(&impostor, "nonce-nonce-nonce-1", "10.0.0.1:4173", Some(expected), window), Err(ProbeError::WrongMachine));
        // Another machine id behind the same key is refused too.
        let renamed = WellKnown { machine_id: "other".into(), ..answer.clone() };
        assert_eq!(verify(&renamed, "nonce-nonce-nonce-1", "10.0.0.1:4173", Some(expected), window), Err(ProbeError::WrongMachine));
        // A tampered field breaks the signature.
        let tampered = WellKnown { at: "2020-01-01T00:00:00Z".into(), ..answer };
        assert_eq!(verify(&tampered, "nonce-nonce-nonce-1", "10.0.0.1:4173", None, window), Err(ProbeError::BadProof));
    }

    #[test]
    fn a_stale_clock_is_not_an_identity_failure() {
        let keys = MachineKeys::generate();
        let old = (Utc::now() - chrono::Duration::seconds(300)).to_rfc3339_opts(SecondsFormat::Secs, true);
        let answer = signed(&keys, "mid", "nonce-nonce-nonce-1", "h:1", &old);
        assert_eq!(verify(&answer, "nonce-nonce-nonce-1", "h:1", None, Duration::from_secs(60)), Err(ProbeError::Stale));
    }

    #[test]
    fn nonces_and_authorities_are_parsed_strictly() {
        assert!(nonce_is_valid(&new_nonce()));
        assert!(!nonce_is_valid("short"));
        assert!(!nonce_is_valid(&"a".repeat(65)));
        assert!(!nonce_is_valid("has spaces in it, yes!!"));
        assert_eq!(authority("http://100.64.0.1:4173"), "100.64.0.1:4173");
        assert_eq!(authority("http://[::1]:4173/relay/x"), "[::1]:4173");
        assert_eq!(base_url("127.0.0.2".parse().unwrap(), 4173), "http://127.0.0.2:4173");
        assert_eq!(base_url("::1".parse().unwrap(), 4173), "http://[::1]:4173");
    }

    #[test]
    fn the_rate_limiter_allows_thirty_a_minute_per_source_and_never_limits_loopback() {
        let limiter = RateLimiter::default();
        let a: IpAddr = "100.64.0.2".parse().unwrap();
        let b: IpAddr = "100.64.0.3".parse().unwrap();
        for _ in 0..RATE_LIMIT {
            assert!(limiter.allow(a));
        }
        assert!(!limiter.allow(a));
        assert!(limiter.allow(b));
        for _ in 0..(RATE_LIMIT * 3) {
            assert!(limiter.allow("127.0.0.1".parse().unwrap()));
        }
    }
}
