//! The login broker (ADE-86 M5 / S4, design §9.4) and pushed keys (§9.3).
//!
//! Read `kybern_protocol::login_broker` for the shape. In short:
//!
//! * **Lender** (the machine the `broker` register names): [`LoginBroker::serve_borrow`] reads the harness'
//!   own login, seals the access token to the borrower and records a loan. [`run`] watches the credential
//!   and, when Claude rotates it, pushes the new token to every borrower (a Claude refresh revokes every
//!   outstanding token at once). It refreshes a Claude login close to expiry by running Claude itself, never
//!   by redeeming a refresh token.
//! * **Borrower**: a named account bound to the broker ([`LoginBroker::bind`]) gets its session's login from
//!   a [`Lease`]. The lease hands the drivers a [`LoginSource`]; the token lives in memory and in the
//!   harness process' environment only. A rejected login is borrowed again; the orchestrator resumes the
//!   session and sends the message once more (`orchestrator/login_borrow.rs`).
//! * **Moving the broker** ([`set_broker`]): the register changes, every member re-borrows from the new
//!   broker, and only then does the old broker sign out, because a sign-out revokes every loan.
//! * **Pushed keys** ([`push_secret`]): a stored key is sealed to each member and delivered with
//!   `peer.secrets.put`, or queued sealed in the outbox for a machine that is offline.
//!
//! Nothing here logs, traces, stores or returns a token. Loans record who borrowed what, never a credential.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use chrono::{DateTime, TimeZone, Utc};
use kybern_drivers::login_lend::{self, LoginSource, RenewReason};
use kybern_protocol::methods::*;
use kybern_protocol::*;
use kybern_store::{LoanRole, LoanRow, Store};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::peers::PeerLink;
use super::{Network, TARGET};
use crate::orchestrator::remote_delegation::{CallFailure, MemberView, RemoteHub};
use crate::state::AppState;

/// How often the broker looks at its own credentials and a borrower looks at the register.
const TICK: Duration = Duration::from_secs(30);
/// A Claude login within this long of expiring is refreshed (by Claude itself) while it has borrowers, at a
/// moment no borrower has a turn running: a Claude refresh revokes the token those turns run on.
const REFRESH_AHEAD_MS: i64 = 30 * 60 * 1000;
/// Within this long of expiring the refresh no longer waits for running turns: they would fail at expiry anyway.
const REFRESH_FORCED_MS: i64 = 3 * 60 * 1000;
/// A Codex login within this long of expiring is renewed by Codex itself while it has borrowers. Codex keeps
/// the old access token valid until it expires, so this never waits for running turns.
const CODEX_REFRESH_AHEAD_MS: i64 = 24 * 3600 * 1000;
/// After a refresh ahead of expiry failed, the next one waits this long (no harness run every tick).
const REFRESH_RETRY: Duration = Duration::from_secs(10 * 60);
/// A borrow refused for any reason but an offline lender is tried again in the background this often
/// (a send tries again at once).
const RETRY_REFUSED: Duration = Duration::from_secs(5 * 60);
/// Every this many ticks a member looks whether the lender now has the account an unmatched borrower wants.
const UNMATCHED_EVERY: u64 = 10;
/// A borrow never hands out a token that is about to die: below this, Claude refreshes first.
const HARD_EXPIRY_MS: i64 = 60 * 1000;
/// How long a move waits for the online members to re-borrow from the new broker.
const REBIND_WAIT: Duration = Duration::from_secs(45);
/// How long a member gets to answer `peer.login.status`.
const STATUS_WAIT: Duration = Duration::from_secs(5);
/// The port `omp auth-broker serve` listens on, on the broker's tailnet address.
const OMP_BROKER_PORT: u16 = 7878;

const BINDING_PREFIX: &str = "login_broker:bind:";
const UNMATCHED_PREFIX: &str = "login_broker:unmatched:";

fn binding_key(kind: ProviderKind, instance: &str) -> String {
    format!("{BINDING_PREFIX}{}:{instance}", kind.as_str())
}

/// A bound account the lender moved away from, whose account the new lender doesn't have: `{machine_id, email}`.
fn unmatched_key(kind: ProviderKind, instance: &str) -> String {
    format!("{UNMATCHED_PREFIX}{}:{instance}", kind.as_str())
}

/// `(kind, instance)` of a binding or unmatched key.
fn parse_account_key<'a>(prefix: &str, key: &'a str) -> Option<(ProviderKind, &'a str)> {
    let (kind, instance) = key.strip_prefix(prefix)?.split_once(':')?;
    Some((kind.parse().ok()?, instance))
}

fn same_email(a: &str, b: &str) -> bool {
    a.trim().eq_ignore_ascii_case(b.trim())
}

/// Bound to the loan, the two machines and the harness, so a sealed credential replayed under another
/// loan, from another sender or to another machine does not open.
pub fn login_context(loan_id: &str, from: &str, to: &str, provider: ProviderKind) -> Vec<u8> {
    format!("kybern-login-v1\0{loan_id}\0{from}\0{to}\0{}", provider.as_str()).into_bytes()
}

fn seal_login(recipient_sealing_b64: &str, context: &[u8], login: &BorrowedLogin) -> anyhow::Result<String> {
    use anyhow::Context;
    let recipient: [u8; 32] = B64
        .decode(recipient_sealing_b64)
        .ok()
        .and_then(|raw| raw.try_into().ok())
        .context("the borrower's sealing key is not 32 bytes of base64")?;
    let plain = serde_json::to_vec(login)?;
    Ok(B64.encode(crate::secret_store::seal(&recipient, context, &plain)?))
}

fn open_login(keys: &super::keys::MachineKeys, context: &[u8], sealed_b64: &str) -> anyhow::Result<BorrowedLogin> {
    use anyhow::Context;
    let sealed = B64.decode(sealed_b64).context("the lent login is not base64")?;
    let plain = crate::secret_store::open(keys, context, &sealed)?;
    serde_json::from_slice(&plain).context("the lent login is unreadable")
}

fn fingerprint(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

fn login_token(login: &BorrowedLogin) -> &str {
    match login {
        BorrowedLogin::Claude { access_token, .. } | BorrowedLogin::Codex { access_token, .. } => access_token,
        BorrowedLogin::Omp { token, .. } => token,
    }
}

fn expiry_of(login: &BorrowedLogin) -> Option<DateTime<Utc>> {
    match login {
        BorrowedLogin::Claude { expires_at_ms: Some(ms), .. } => Utc.timestamp_millis_opt(*ms).single(),
        BorrowedLogin::Codex { access_token, .. } => {
            login_lend::codex_expires_at(access_token).and_then(|seconds| Utc.timestamp_opt(seconds, 0).single())
        }
        _ => None,
    }
}

/// Whether a retry of a failed borrow asks the lender again. Only a lender that was offline leaves a held, still
/// valid token in use; any refusal is asked again, so a lender that said no is never worked around.
fn renew_on_retry(state: &LeaseState) -> bool {
    !(state.login.is_some() && !expiring(state.expires_at) && matches!(state.last_error, Some(BrokerError::Offline(_))))
}

/// Whether a held login dies within the next minute: a session must not start on it.
fn expiring(expires_at: Option<DateTime<Utc>>) -> bool {
    expires_at.is_some_and(|at| at.timestamp_millis() < Utc::now().timestamp_millis() + HARD_EXPIRY_MS)
}

// ---- why a borrow did not work ----

/// The register, next to `broker`, that records the lender was chosen deliberately (0.27.2+):
/// `{ "machine_id": <the lender>, "via": "manual" | "always_on" }`. A `broker` without a matching
/// choice is a legacy lender (set before 0.27.2, or by an older daemon).
pub const CHOICE_REGISTER: &str = "broker.choice";

/// Which machine a failed borrow was asked of, and which machine asked. Named in every sentence, so a
/// person knows where to fix it ("kdi-vps doesn't let MacBook use its sign-ins …").
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Parties {
    pub lender: String,
    pub here: String,
}

/// What went wrong asking the broker. [`BrokerError::message`] is the sentence a person reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BrokerError {
    /// No `broker` register.
    NoBroker,
    /// This machine is the broker; it signs in locally.
    IsSelf,
    /// The broker's session is down.
    Offline(String),
    /// The broker has no sign-in for this harness (the text says what to do there).
    NotSignedIn(String),
    /// The broker runs a Kybern without the login broker.
    Unsupported(String),
    /// The broker refused: `allow.<broker>.logins` is off for this machine.
    Refused(Parties),
    /// This machine is paused in the network, so no member serves it.
    Paused(Parties),
    /// The machine this one takes for the broker says it no longer is (the register moved, or the two
    /// machines have not synced yet).
    NotLender(Parties),
    /// The broker does not know this machine yet (membership has not synced there).
    UnknownMachine(Parties),
    /// A legacy lender that isn't always on: a new account does not bind to it. The text is the reason.
    NotForNew(String),
    /// The lender now lends a different account than the one this account is (another person's, or another
    /// login of the same person): it is never used.
    WrongAccount { parties: Parties, email: String },
    /// The lender moved to a machine that has no sign-in for this account's email (or the email is unknown).
    Unmatched { parties: Parties, email: Option<String> },
    /// This machine is not in a network now: it was removed, or the network is turned off here.
    Left,
    Failed(String),
}

impl BrokerError {
    /// The state a client shows for this error.
    pub fn state(&self) -> BrokerLoginState {
        match self {
            BrokerError::Offline(_) => BrokerLoginState::BrokerOffline,
            BrokerError::NotSignedIn(_) | BrokerError::WrongAccount { .. } | BrokerError::Unmatched { .. } => {
                BrokerLoginState::BrokerNotSignedIn
            }
            BrokerError::Unsupported(_) => BrokerLoginState::BrokerUnsupported,
            _ => BrokerLoginState::BrokerOffline,
        }
    }

    pub fn message(&self, kind: ProviderKind) -> String {
        let harness = kind.display_name();
        match self {
            BrokerError::NoBroker => format!(
                "{harness} uses another machine's sign-in, but no machine shares its sign-ins now. Choose one with Share this machine’s sign-ins in Settings → Accounts, or sign in here."
            ),
            BrokerError::IsSelf => format!("This machine shares its own sign-ins. Sign in to {harness} here."),
            BrokerError::Offline(name) => format!("{harness} signs in through {name}, which is offline · Sign in here instead"),
            BrokerError::NotSignedIn(detail) => detail.clone(),
            BrokerError::Unsupported(name) => {
                format!("{name} needs a newer Kybern to share its {harness} sign-in. Update it from Settings → Machines.")
            }
            BrokerError::Refused(Parties { lender, here }) => format!(
                "{lender} doesn't let other machines use its sign-ins. Choose Share this machine’s sign-ins for {lender} in Settings → Accounts, or sign in on {here} instead."
            ),
            BrokerError::Paused(Parties { lender, here }) => format!(
                "{here} is paused, so {lender} won't share its sign-ins with it. Resume {here} in Settings → Machines, or sign in on {here} instead."
            ),
            BrokerError::NotLender(Parties { lender, here }) => format!(
                "{lender} no longer shares its sign-ins. Choose the machine that shares them in Settings → Accounts, or sign in on {here} instead."
            ),
            BrokerError::UnknownMachine(Parties { lender, here }) => format!(
                "{lender} doesn't know {here} yet. Wait a minute for your machines to sync and try again, or sign in on {here} instead."
            ),
            BrokerError::NotForNew(reason) => reason.clone(),
            BrokerError::WrongAccount { parties: Parties { lender, here }, email } => format!(
                "{lender} now shares a different {harness} account than {email}. Sign in to {email} on {lender}, or sign in on {here} instead."
            ),
            BrokerError::Unmatched { parties: Parties { lender, here }, email: Some(email) } => format!(
                "{lender} isn't signed in to {email}, so {here} can't use it through {lender}. Sign in to {email} on {lender}, or sign in on {here} instead."
            ),
            BrokerError::Unmatched { parties: Parties { lender, here }, email: None } => format!(
                "{lender} shares its sign-ins now, but Kybern can't tell which of its {harness} accounts this one is. Sign in on {here} instead."
            ),
            BrokerError::Left => format!(
                "This machine is not connected to your other machines, so {harness} can't use their sign-ins. Sign in here instead."
            ),
            BrokerError::Failed(reason) => reason.clone(),
        }
    }

    fn lender(&self) -> Option<&str> {
        match self {
            BrokerError::Offline(name) | BrokerError::Unsupported(name) => Some(name),
            BrokerError::Refused(parties)
            | BrokerError::Paused(parties)
            | BrokerError::NotLender(parties)
            | BrokerError::UnknownMachine(parties)
            | BrokerError::WrongAccount { parties, .. }
            | BrokerError::Unmatched { parties, .. } => Some(&parties.lender),
            _ => None,
        }
    }

    fn problem_kind(&self) -> ProblemKind {
        match self {
            BrokerError::Offline(_) | BrokerError::Left => ProblemKind::Offline,
            BrokerError::NotSignedIn(_) | BrokerError::WrongAccount { .. } | BrokerError::Unmatched { .. } => ProblemKind::SignedOut,
            BrokerError::Unsupported(_) => ProblemKind::UpdateNeeded,
            BrokerError::IsSelf => ProblemKind::InvalidInput,
            BrokerError::Failed(_) => ProblemKind::Internal,
            BrokerError::NoBroker
            | BrokerError::Refused(_)
            | BrokerError::Paused(_)
            | BrokerError::NotLender(_)
            | BrokerError::UnknownMachine(_)
            | BrokerError::NotForNew(_) => ProblemKind::Permission,
        }
    }

    /// The `login_borrow` problem: the sentence as its hint, and "Sign in on <here> instead" as its action.
    pub fn problem(&self, kind: ProviderKind, here: &Borrower) -> Problem {
        let message = self.message(kind);
        let title = match self.lender() {
            Some(lender) => format!("Couldn't use {lender}'s sign-in"),
            None => "Couldn't use the shared sign-in".to_string(),
        };
        let mut params = json!({ "machine_id": here.machine_id, "provider": kind.as_str() });
        if let Some(instance) = &here.instance {
            params["instance"] = json!(instance);
        }
        let mut problem = Problem::new(self.problem_kind(), message.clone())
            .with_subject(LOGIN_BORROW_SUBJECT)
            .with_copy(title, message)
            .with_action(ProblemAction::new(SIGN_IN_HERE_ACTION, format!("Sign in on {} instead", here.name)).with_params(params));
        if matches!(self, BrokerError::Offline(_) | BrokerError::UnknownMachine(_)) {
            problem = problem.with_secondary(ProblemAction::retry("Try again"));
        }
        problem
    }

    /// This error as an RPC error carrying [`BrokerError::problem`].
    pub fn rpc_error(&self, kind: ProviderKind, here: &Borrower) -> RpcError {
        let code = match self.problem_kind() {
            ProblemKind::Permission => codes::FORBIDDEN,
            ProblemKind::InvalidInput => codes::INVALID_PARAMS,
            ProblemKind::Internal => codes::INTERNAL_ERROR,
            _ => codes::NOT_AVAILABLE,
        };
        RpcError::new(code, self.message(kind)).with_problem(&self.problem(kind, here))
    }

    /// Whether binding an account should stop here. An offline lender is not: the account borrows once it is back.
    fn refuses_binding(&self) -> bool {
        !matches!(self, BrokerError::Offline(_))
    }
}

/// The machine a borrow is for: the one to sign in on instead.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Borrower {
    pub machine_id: String,
    pub name: String,
    /// The local account bound to the lender, when there is one.
    pub instance: Option<String>,
}

/// A borrow that did not work, as an error a session start returns: its `Display` is the sentence, and
/// `crate::problem::typed` reads its [`Problem`] so the failed turn carries the `sign_in_here` action.
#[derive(Debug, Clone)]
pub struct BorrowRefusal {
    pub message: String,
    pub problem: Box<Problem>,
}

impl std::fmt::Display for BorrowRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for BorrowRefusal {}

/// What the lender says when it won't lend, so the borrower can tell which refusal it was.
const NOT_LENDER: &str = "not_lender";
const UNKNOWN_MACHINE: &str = "unknown_machine";
/// The subject of the refusal a lender sends when `machine:logins` is off for the caller (`peers.rs`).
pub const LOGINS_OFF: &str = "logins_off";

/// The borrower's reading of a lender's refusal. A 0.27.2+ lender names it with a problem subject; an older one
/// only with its code and text.
fn refusal_of(error: &RpcError, lender: &str, parties: impl Fn() -> Parties, paused_here: bool) -> BrokerError {
    let subject = error.problem().and_then(|problem| problem.subject);
    match (error.code, subject.as_deref()) {
        (_, Some(NOT_LENDER)) => BrokerError::NotLender(parties()),
        (_, Some(UNKNOWN_MACHINE)) => BrokerError::UnknownMachine(parties()),
        (codes::METHOD_NOT_FOUND, _) => BrokerError::Unsupported(lender.to_string()),
        (codes::FORBIDDEN, _) if paused_here => BrokerError::Paused(parties()),
        // An older lender refused a machine it doesn't know with the bare peer scope.
        (codes::FORBIDDEN, _) if error.message.contains("machine:peer") => BrokerError::UnknownMachine(parties()),
        (codes::FORBIDDEN, _) => BrokerError::Refused(parties()),
        (codes::NOT_AVAILABLE, _) if error.message.contains("is not the login broker") => BrokerError::NotLender(parties()),
        (codes::NOT_AVAILABLE, _) => BrokerError::NotSignedIn(error.message.clone()),
        _ => BrokerError::Failed(error.message.clone()),
    }
}

/// Whether a new setup may bind an account to the lender, and why not. A lender chosen deliberately (0.27.2+) is
/// always usable; a legacy one only while it is always on.
pub fn usable_for_new(name: &str, chosen: Option<LenderVia>, ratio: Option<f32>, is_self: bool) -> (bool, Option<String>) {
    if is_self || chosen.is_some() || ratio.is_some_and(|ratio| ratio >= crate::accounts_offers::ALWAYS_ON_RATIO) {
        return (true, None);
    }
    let why = match ratio {
        None => "Kybern can't tell yet whether it stays on",
        Some(_) => "it isn't always on",
    };
    (
        false,
        Some(format!(
            "{name} shared its sign-ins before Kybern 0.27.2, and {why}, so new machines sign in themselves. Choose a machine that stays on to share sign-ins."
        )),
    )
}

/// How the lender was chosen, from the `broker.choice` register: only when it names the current lender.
fn chosen_in(projection: &super::ops::Projection, lender: &str) -> Option<LenderVia> {
    let value = &projection.register(CHOICE_REGISTER)?.value;
    if value.get("machine_id").and_then(Value::as_str) != Some(lender) {
        return None;
    }
    serde_json::from_value(value.get("via")?.clone()).ok()
}

// ---- borrower: leases ----

type LeaseKey = (ProviderKind, String);

#[derive(Default)]
struct LeaseState {
    /// The broker this lease borrowed from.
    broker: String,
    loan_id: Option<String>,
    login: Option<BorrowedLogin>,
    expires_at: Option<DateTime<Utc>>,
    last_error: Option<BrokerError>,
    /// When `last_error` happened, so a refusal is tried again in the background now and then.
    failed_at: Option<std::time::Instant>,
}

/// One borrowed login on this machine, shared by every session of the account.
pub struct Lease {
    kind: ProviderKind,
    /// The local named account that signs in through the broker.
    instance: String,
    /// The broker's account that is lent.
    account: String,
    state: Mutex<LeaseState>,
    /// Borrow and push do not interleave.
    gate: tokio::sync::Mutex<()>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// What a session's driver asks for its credential.
struct LeaseSource {
    broker: Arc<LoginBroker>,
    lease: Arc<Lease>,
}

#[async_trait]
impl LoginSource for LeaseSource {
    async fn current(&self) -> Result<BorrowedLogin, String> {
        // A machine that left the network keeps nothing it borrowed through it, even before the worker clears it.
        if !self.broker.in_network() {
            return Err(BrokerError::Left.message(self.lease.kind));
        }
        let (held, expired) = {
            let state = lock(&self.lease.state);
            (state.login.clone(), expiring(state.expires_at))
        };
        match held {
            // A held token that is about to die is renewed first: a session never starts on a dead one.
            Some(login) if !expired => Ok(login),
            Some(_) => self.broker.borrow(&self.lease, true).await.map_err(|error| error.message(self.lease.kind)),
            None => self.broker.borrow(&self.lease, false).await.map_err(|error| error.message(self.lease.kind)),
        }
    }

    async fn renew(&self, _reason: RenewReason) -> Result<BorrowedLogin, String> {
        self.broker.borrow(&self.lease, true).await.map_err(|error| error.message(self.lease.kind))
    }
}

// ---- the service ----

/// Everything the login broker needs on one machine. Built with the hub, installed in the orchestrator
/// (the borrower side runs inside `spawn_session`) and reached by the RPC and peer handlers through it.
pub struct LoginBroker {
    hub: Arc<dyn RemoteHub>,
    network: Arc<Network>,
    store: Store,
    /// A borrowed account carries the lender account's email in its settings, so shared defaults and project
    /// choices (`accounts_shared`, by email) reach it and a lender never lends it another account.
    settings: crate::settings::SettingsStore,
    leases: Mutex<HashMap<LeaseKey, Arc<Lease>>>,
    /// Turns that already had one automatic recovery.
    recovered: Mutex<HashSet<Uuid>>,
    /// The broker refreshes one Claude login at a time.
    refresh_gate: tokio::sync::Mutex<()>,
    /// Fingerprint of the access token last seen per lent account, to notice a rotation.
    seen: Mutex<HashMap<(ProviderKind, String), [u8; 32]>>,
    /// The `omp auth-broker serve` this machine runs, once started.
    omp: tokio::sync::Mutex<Option<tokio::process::Child>>,
    /// A refresh ahead of expiry that failed, per lent account: the next waits [`REFRESH_RETRY`].
    refresh_failed: Mutex<HashMap<(ProviderKind, String), std::time::Instant>>,
    /// Worker ticks so far, to look for unmatched accounts every [`UNMATCHED_EVERY`].
    ticks: std::sync::atomic::AtomicU64,
}

impl LoginBroker {
    pub fn new(hub: Arc<dyn RemoteHub>, network: Arc<Network>, store: Store, settings: crate::settings::SettingsStore) -> Arc<Self> {
        Arc::new(Self {
            hub,
            network,
            store,
            settings,
            leases: Mutex::new(HashMap::new()),
            recovered: Mutex::new(HashSet::new()),
            refresh_gate: tokio::sync::Mutex::new(()),
            seen: Mutex::new(HashMap::new()),
            omp: tokio::sync::Mutex::new(None),
            refresh_failed: Mutex::new(HashMap::new()),
            ticks: std::sync::atomic::AtomicU64::new(0),
        })
    }

    fn self_id(&self) -> String {
        self.hub.self_id()
    }

    /// This machine takes part in its network now: the network is on here and this machine is a current member.
    /// Borrowed logins are only used while it does.
    fn in_network(&self) -> bool {
        self.network.is_enabled() && self.network.membership().is_some_and(|membership| membership.self_is_member())
    }

    /// The machine the `broker` register names, when it is a current member.
    pub fn broker_id(&self) -> Option<String> {
        let membership = self.network.membership()?;
        let projection = membership.projection();
        let id = projection.broker()?.to_string();
        projection.is_member(&id).then_some(id)
    }

    fn member_name(&self, id: &str) -> String {
        self.hub
            .target(id)
            .map(|target| target.name)
            .or_else(|| (id == self.self_id()).then(|| self.hub.self_name()))
            .unwrap_or_else(|| "the machine that shares sign-ins".into())
    }

    // ---- bindings ----

    /// The broker account a local account signs in through, if it is bound.
    pub fn binding(&self, kind: ProviderKind, instance: &str) -> Option<String> {
        if instance == "default" || !login_lend_supports(kind) {
            return None;
        }
        self.store.meta_get(&binding_key(kind, instance)).ok().flatten().filter(|account| !account.is_empty())
    }

    fn set_binding(&self, kind: ProviderKind, instance: &str, account: Option<&str>) -> anyhow::Result<()> {
        self.store.meta_set(&binding_key(kind, instance), account.unwrap_or(""))
    }

    /// The email a local named account was last seen with: for a bound one, the lent account's.
    fn account_email(&self, kind: ProviderKind, instance: &str) -> Option<String> {
        let settings = self.settings.get();
        settings.providers.get(&kind)?.accounts.get(instance)?.email.clone().filter(|email| !email.trim().is_empty())
    }

    /// Give a bound account the lent account's email (and plan), so it is the same account as the lender's in
    /// shared defaults and project choices, and picking it as the default here names the right shared account.
    fn remember_email(&self, kind: ProviderKind, instance: &str, email: &str, plan: Option<&str>) {
        let email = email.trim().to_ascii_lowercase();
        if !crate::accounts_shared::has_identity(kind) || !email.contains('@') {
            return;
        }
        let written = self.settings.update(|current| {
            let account = current.providers.get(&kind)?.accounts.get(instance)?;
            let plan = plan.map(str::to_string).or_else(|| account.plan.clone());
            if account.email.as_deref() == Some(email.as_str()) && account.plan == plan {
                return None;
            }
            let mut next = current.clone();
            let account = next.providers.get_mut(&kind)?.accounts.get_mut(instance)?;
            account.email = Some(email.clone());
            account.plan = plan;
            Some((next, ()))
        });
        if let Err(error) = written {
            tracing::warn!(target: TARGET, %error, "could not record a borrowed account's email");
        }
    }

    /// Forget the email of an account that no longer borrows, when this machine has its own login of it: the
    /// shared account then maps to that login, not to the empty one.
    fn forget_email_if_owned(&self, kind: ProviderKind, instance: &str) {
        let Some(email) = self.account_email(kind, instance) else { return };
        let _ = self.settings.update(|current| {
            let provider = current.providers.get(&kind)?;
            let owned = provider.accounts.iter().any(|(id, account)| {
                id != instance && account.email.as_deref().is_some_and(|other| same_email(other, &email)) && self.binding(kind, id).is_none()
            }) || crate::accounts_shared::terminal_email(&self.store, kind).is_some_and(|other| same_email(&other, &email));
            if !owned {
                return None;
            }
            let mut next = current.clone();
            next.providers.get_mut(&kind)?.accounts.get_mut(instance)?.email = None;
            Some((next, ()))
        });
    }

    fn clear_email(&self, kind: ProviderKind, instance: &str) {
        let _ = self.settings.update(|current| {
            current.providers.get(&kind)?.accounts.get(instance)?.email.as_ref()?;
            let mut next = current.clone();
            next.providers.get_mut(&kind)?.accounts.get_mut(instance)?.email = None;
            Some((next, ()))
        });
    }

    /// The account a moved lender has no sign-in for, when there is one: `(lender machine id, email)`.
    fn unmatched(&self, kind: ProviderKind, instance: &str) -> Option<(String, Option<String>)> {
        let text = self.store.meta_get(&unmatched_key(kind, instance)).ok().flatten().filter(|text| !text.is_empty())?;
        let value: Value = serde_json::from_str(&text).ok()?;
        let lender = value.get("machine_id")?.as_str()?.to_string();
        Some((lender, value.get("email").and_then(Value::as_str).map(str::to_string)))
    }

    fn set_unmatched(&self, kind: ProviderKind, instance: &str, lender: Option<(&str, Option<&str>)>) {
        let value = lender.map(|(machine_id, email)| json!({ "machine_id": machine_id, "email": email }).to_string()).unwrap_or_default();
        let _ = self.store.meta_set(&unmatched_key(kind, instance), &value);
    }

    fn lease_for(&self, kind: ProviderKind, instance: &str, account: &str) -> Arc<Lease> {
        let mut leases = lock(&self.leases);
        let stale = leases.get(&(kind, instance.to_string())).is_some_and(|lease| lease.account != account);
        if stale {
            leases.remove(&(kind, instance.to_string()));
        }
        leases
            .entry((kind, instance.to_string()))
            .or_insert_with(|| {
                Arc::new(Lease {
                    kind,
                    instance: instance.to_string(),
                    account: account.to_string(),
                    state: Mutex::new(LeaseState::default()),
                    gate: tokio::sync::Mutex::new(()),
                })
            })
            .clone()
    }

    /// The login source for a session of a bound account, borrowing now when the lease is empty.
    /// The error is the sentence to show ("Claude signs in through the VPS, which is offline · …").
    pub async fn acquire(self: &Arc<Self>, kind: ProviderKind, instance: &str, account: &str) -> Result<Arc<dyn LoginSource>, String> {
        self.acquire_or_problem(kind, instance, account).await.map_err(|refusal| refusal.message)
    }

    /// [`LoginBroker::acquire`] with the refusal's `login_borrow` problem, for a session start.
    pub async fn acquire_or_problem(
        self: &Arc<Self>,
        kind: ProviderKind,
        instance: &str,
        account: &str,
    ) -> Result<Arc<dyn LoginSource>, BorrowRefusal> {
        let refusal = |error: BrokerError| BorrowRefusal {
            message: error.message(kind),
            problem: Box::new(error.problem(kind, &self.borrower(Some(instance)))),
        };
        if !self.in_network() {
            return Err(refusal(BrokerError::Left));
        }
        let lease = self.lease_for(kind, instance, account);
        let (held, expired) = {
            let state = lock(&lease.state);
            (state.login.is_some(), expiring(state.expires_at))
        };
        if !held || expired {
            self.borrow(&lease, expired).await.map_err(refusal)?;
        }
        Ok(Arc::new(LeaseSource { broker: self.clone(), lease }))
    }

    /// This machine, as the one to sign in on instead.
    fn borrower(&self, instance: Option<&str>) -> Borrower {
        Borrower { machine_id: self.self_id(), name: self.hub.self_name(), instance: instance.map(str::to_string) }
    }

    fn parties(&self, lender: &str) -> Parties {
        Parties { lender: lender.to_string(), here: self.hub.self_name() }
    }

    /// Whether this machine is paused in its network: no member serves it then.
    fn paused_here(&self) -> bool {
        self.network.membership().is_some_and(|membership| membership.projection().entry(&self.self_id()).is_some_and(|entry| entry.paused))
    }

    // ---- the lender, as setup sees it ----

    /// The current lender and whether a new setup may borrow from it (`usable_for_new`, `reason`).
    pub fn lender_status(&self) -> Option<LenderStatus> {
        let id = self.broker_id()?;
        let membership = self.network.membership()?;
        let projection = membership.projection();
        let me = self.self_id();
        let name = self.member_name(&id);
        let chosen = chosen_in(&projection, &id);
        let ratio = (id != me).then(|| super::online::ratio(&self.store, &id, &me, Utc::now())).flatten();
        let always_on = if id == me { None } else { ratio.map(|ratio| ratio >= crate::accounts_offers::ALWAYS_ON_RATIO) };
        let (usable, reason) = usable_for_new(&name, chosen, ratio, id == me);
        Some(LenderStatus { machine_id: id, name, chosen, always_on, usable_for_new: usable, reason })
    }

    /// Every member, and whether "Share this machine's sign-ins" can pick it now.
    pub fn lender_candidates(&self) -> Vec<LenderCandidate> {
        let lender = self.broker_id();
        let me = self.self_id();
        let now = Utc::now();
        let mut candidates: Vec<LenderCandidate> = self
            .hub
            .members()
            .into_iter()
            .map(|member| {
                let online = member.is_self || member.status == "online";
                let paused = member.status == "paused";
                let supported =
                    member.is_self || member.features.iter().any(|feature| feature == kybern_protocol::features::LOGIN_BROKER_V1);
                let always_on = if member.is_self {
                    None
                } else {
                    super::online::ratio(&self.store, &member.id, &me, now).map(|ratio| ratio >= crate::accounts_offers::ALWAYS_ON_RATIO)
                };
                let reason = if paused {
                    Some(format!("{} is paused. Resume it in Settings → Machines first.", member.name))
                } else if !online {
                    Some(format!("{} is offline. Bring it online first.", member.name))
                } else if !supported {
                    Some(format!("{} needs a newer Kybern to share its sign-ins. Update it from Settings → Machines.", member.name))
                } else {
                    None
                };
                LenderCandidate {
                    is_lender: lender.as_deref() == Some(member.id.as_str()),
                    machine_id: member.id,
                    name: member.name,
                    is_self: member.is_self,
                    online,
                    supported,
                    always_on,
                    can_share: reason.is_none(),
                    reason,
                }
            })
            .collect();
        candidates.sort_by(|a, b| b.is_self.cmp(&a.is_self).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
        candidates
    }

    /// Ask the broker for the lease's login (`peer.login.borrow`) and keep it in memory. A lent login of another
    /// account than this one's email is refused ([`BrokerError::WrongAccount`]).
    async fn borrow(&self, lease: &Lease, renewing: bool) -> Result<BorrowedLogin, BrokerError> {
        self.borrow_as(lease, renewing, false).await
    }

    /// [`LoginBroker::borrow`]; with `adopt` (binding the account now) the account takes the lent account's email.
    async fn borrow_as(&self, lease: &Lease, renewing: bool, adopt: bool) -> Result<BorrowedLogin, BrokerError> {
        let _gate = lease.gate.lock().await;
        // Another session may have borrowed while this one waited; a renewal still goes to the broker.
        if !renewing {
            let mut state = lock(&lease.state);
            if let Some(login) = state.login.clone().filter(|_| !expiring(state.expires_at)) {
                state.last_error = None;
                state.failed_at = None;
                return Ok(login);
            }
        }
        let result = self.borrow_from_broker(lease, adopt).await;
        let mut state = lock(&lease.state);
        match &result {
            Ok(_) => {
                state.last_error = None;
                state.failed_at = None;
            }
            Err(error) => {
                state.last_error = Some(error.clone());
                state.failed_at = Some(std::time::Instant::now());
            }
        }
        result
    }

    /// The loan this machine already holds for the lease, from the store: after a restart the lease is empty, and
    /// borrowing under the same loan renews it instead of leaving the old one open on the lender.
    fn stored_loan(&self, lease: &Lease, broker_id: &str) -> Option<String> {
        self.store
            .loans_open(LoanRole::Borrower)
            .unwrap_or_default()
            .into_iter()
            .find(|loan| {
                loan.peer == broker_id
                    && loan.provider == lease.kind
                    && loan.account == lease.account
                    && loan.local_instance.as_deref() == Some(lease.instance.as_str())
            })
            .map(|loan| loan.loan_id)
    }

    async fn borrow_from_broker(&self, lease: &Lease, adopt: bool) -> Result<BorrowedLogin, BrokerError> {
        if !self.in_network() {
            return Err(BrokerError::Left);
        }
        let me = self.self_id();
        let broker_id = self.broker_id().ok_or(BrokerError::NoBroker)?;
        if broker_id == me {
            return Err(BrokerError::IsSelf);
        }
        let name = self.member_name(&broker_id);
        let previous = {
            let state = lock(&lease.state);
            (state.broker == broker_id).then(|| state.loan_id.clone()).flatten()
        }
        .or_else(|| self.stored_loan(lease, &broker_id));
        let expected = if adopt { None } else { self.account_email(lease.kind, &lease.instance) };
        let params = PeerLoginBorrowParams { provider: lease.kind, account: lease.account.clone(), loan_id: previous };
        let value = self.hub.call(&broker_id, PeerLoginBorrow::NAME, serde_json::to_value(&params).unwrap_or_default()).await.map_err(
            |failure| match failure {
                CallFailure::Offline(_) | CallFailure::Gone(_) => BrokerError::Offline(name.clone()),
                CallFailure::Remote(error) => refusal_of(&error, &name, || self.parties(&name), self.paused_here()),
            },
        )?;
        let result: PeerLoginBorrowResult = serde_json::from_value(value).map_err(|_| {
            BrokerError::Failed(format!(
                "{name} answered with something Kybern can't read. Update Kybern on both machines, then try again."
            ))
        })?;
        // Never another account than this one: the lender's account ids differ from machine to machine and change
        // when the lender moves, the email does not. The token is not opened, and the loan goes back.
        if let (Some(want), Some(lent)) = (&expected, &result.email)
            && !same_email(want, lent)
        {
            let _ = self.hub.call(&broker_id, PeerLoginRelease::NAME, json!({ "loan_id": result.loan_id })).await;
            tracing::warn!(target: TARGET, provider = lease.kind.as_str(), "the lender lent another account than this one; not using it");
            return Err(BrokerError::WrongAccount { parties: self.parties(&name), email: want.clone() });
        }
        let membership = self.network.membership().ok_or(BrokerError::NoBroker)?;
        let login = open_login(&membership.keys(), &login_context(&result.loan_id, &broker_id, &me, lease.kind), &result.sealed)
            .map_err(|error| BrokerError::Failed(format!("The lent login could not be opened: {error:#}")))?;
        let expires_at = result.expires_at.or_else(|| expiry_of(&login));
        let generation = {
            let mut state = lock(&lease.state);
            let generation = if state.loan_id.as_deref() == Some(result.loan_id.as_str()) { 1 } else { 0 } + 1;
            state.broker = broker_id.clone();
            state.loan_id = Some(result.loan_id.clone());
            state.login = Some(login.clone());
            state.expires_at = expires_at;
            generation
        };
        let row = LoanRow {
            loan_id: result.loan_id.clone(),
            role: LoanRole::Borrower,
            peer: broker_id,
            provider: lease.kind,
            account: lease.account.clone(),
            local_instance: Some(lease.instance.clone()),
            generation,
            expires_at,
            last_pushed_at: None,
            last_error: None,
            created_at: Utc::now(),
        };
        if let Err(error) = self.store.loan_open(&row) {
            tracing::warn!(target: TARGET, %error, "could not record a borrowed login");
        }
        // Any other loan this account still holds (from before a restart, or from an earlier lender) is let go.
        for stale in self.store.loans_open(LoanRole::Borrower).unwrap_or_default().into_iter().filter(|loan| {
            loan.loan_id != result.loan_id && loan.provider == lease.kind && loan.local_instance.as_deref() == Some(lease.instance.as_str())
        }) {
            let _ = self.store.loan_release(&stale.loan_id);
            let _ = tokio::time::timeout(
                STATUS_WAIT,
                self.hub.call(&stale.peer, PeerLoginRelease::NAME, json!({ "loan_id": stale.loan_id })),
            )
            .await;
        }
        if let Some(email) = &result.email {
            self.remember_email(lease.kind, &lease.instance, email, result.plan.as_deref());
        }
        Ok(login)
    }

    /// A borrow that failed is tried again before a send is refused on it: the lender may be back, or may let this
    /// machine borrow now. Nothing happens when the last borrow worked.
    pub async fn retry_failed(&self, kind: ProviderKind, instance: &str) {
        let Some(account) = self.binding(kind, instance) else { return };
        let Some(lease) = lock(&self.leases).get(&(kind, instance.to_string())).cloned().filter(|lease| lease.account == account) else {
            return;
        };
        let (failed, renew) = {
            let state = lock(&lease.state);
            (state.last_error.is_some(), renew_on_retry(&state))
        };
        if failed {
            let _ = tokio::time::timeout(REBIND_WAIT, self.borrow(&lease, renew)).await;
        }
    }

    /// The worker's retry of failed borrows: at once when the lender that was offline is online again, and every
    /// [`RETRY_REFUSED`] for any other refusal. Both Claude and Codex recover without a push.
    async fn retry_failed_leases(&self) {
        let leases: Vec<Arc<Lease>> = lock(&self.leases).values().cloned().collect();
        let lender_online = self.broker_id().is_some_and(|id| self.hub.target(&id).is_some_and(|target| target.online));
        for lease in leases {
            let due = {
                let state = lock(&lease.state);
                match (&state.last_error, state.failed_at) {
                    (Some(BrokerError::Offline(_)), _) => lender_online,
                    (Some(BrokerError::Left | BrokerError::NoBroker | BrokerError::IsSelf), _) => false,
                    (Some(_), Some(at)) => at.elapsed() >= RETRY_REFUSED,
                    _ => false,
                }
            };
            if due && self.binding(lease.kind, &lease.instance).as_deref() == Some(lease.account.as_str()) {
                let renew = renew_on_retry(&lock(&lease.state));
                let _ = self.borrow(&lease, renew).await;
            }
        }
    }

    /// `peer.login.push` on the borrower: the broker rotated the credential of a loan this machine holds.
    /// Returns the (kind, local account) whose idle sessions should restart on the new token.
    pub fn apply_push(&self, link: &PeerLink, params: PeerLoginPushParams) -> Result<(ProviderKind, String), RpcError> {
        let loan = self
            .store
            .loan_get(&params.loan_id)
            .map_err(RpcError::internal)?
            .filter(|loan| loan.role == LoanRole::Borrower && loan.peer == link.machine_id && loan.provider == params.provider)
            .ok_or_else(|| RpcError::new(codes::NOT_FOUND, "this machine holds no such loan from that machine"))?;
        let instance = loan.local_instance.clone().unwrap_or_default();
        let me = self.self_id();
        let membership = self.network.membership().ok_or_else(|| RpcError::new(codes::NOT_AVAILABLE, "no network"))?;
        let login = open_login(&membership.keys(), &login_context(&params.loan_id, &link.machine_id, &me, params.provider), &params.sealed)
            .map_err(|error| RpcError::invalid_params(format!("{error:#}")))?;
        if login.provider() != params.provider {
            return Err(RpcError::invalid_params("the pushed login is for another harness"));
        }
        if let Some(lease) = lock(&self.leases).get(&(params.provider, instance.clone())).cloned() {
            let mut state = lock(&lease.state);
            if state.loan_id.as_deref() == Some(params.loan_id.as_str()) {
                state.expires_at = params.expires_at.or_else(|| expiry_of(&login));
                state.login = Some(login);
                state.last_error = None;
                state.failed_at = None;
            }
        }
        let _ = self.store.loan_pushed(&params.loan_id, Utc::now(), params.expires_at, None);
        Ok((params.provider, instance))
    }

    /// The borrower's view of an account that signs in through the broker.
    pub fn account_view(&self, kind: ProviderKind, instance: &str) -> Option<AccountBroker> {
        let Some(account) = self.binding(kind, instance) else { return self.unmatched_view(kind, instance) };
        let broker_id = self.broker_id();
        let (machine_id, machine_name) = match &broker_id {
            Some(id) => (id.clone(), self.member_name(id)),
            None => (String::new(), "the machine that shares sign-ins".into()),
        };
        let lease = lock(&self.leases).get(&(kind, instance.to_string())).cloned();
        let lender_online = broker_id.as_ref().is_some_and(|id| self.hub.target(id).is_some_and(|target| target.online));
        // "Offline" is only as true as the lender's presence: once it is back, the account reads as borrowing again
        // (the next session borrows, and the worker borrows at once).
        let error = lease
            .as_ref()
            .and_then(|lease| lock(&lease.state).last_error.clone())
            .filter(|error| !(matches!(error, BrokerError::Offline(_)) && lender_online));
        let held = lease.as_ref().is_some_and(|lease| lock(&lease.state).login.is_some());
        let (state, message) = match (&broker_id, error) {
            (None, _) => (BrokerLoginState::BrokerOffline, Some(BrokerError::NoBroker.message(kind))),
            (Some(id), _) if *id == self.self_id() => (BrokerLoginState::Lending, Some(BrokerError::IsSelf.message(kind))),
            (Some(_), Some(error)) => (error.state(), Some(error.message(kind))),
            (Some(id), None) if !held && self.hub.target(id).is_some_and(|target| !target.online) => {
                let error = BrokerError::Offline(machine_name.clone());
                (error.state(), Some(error.message(kind)))
            }
            (Some(_), None) => (BrokerLoginState::Borrowing, None),
        };
        Some(AccountBroker { machine_id, machine_name, broker_account: account, state, message })
    }

    /// An account whose lender moved to a machine without its sign-in: it reads as needing a sign-in, and says
    /// where to sign in.
    fn unmatched_view(&self, kind: ProviderKind, instance: &str) -> Option<AccountBroker> {
        let (lender, email) = self.unmatched(kind, instance)?;
        let name = self.member_name(&lender);
        let error = BrokerError::Unmatched { parties: self.parties(&name), email };
        Some(AccountBroker {
            machine_id: lender,
            machine_name: name,
            broker_account: String::new(),
            state: error.state(),
            message: Some(error.message(kind)),
        })
    }

    /// Borrow again now (the lent token was rejected): the broker may have rotated before its push arrived.
    pub async fn renew(&self, kind: ProviderKind, instance: &str, account: &str) -> Result<(), String> {
        let lease = self.lease_for(kind, instance, account);
        self.borrow(&lease, true).await.map(|_| ()).map_err(|error| error.message(kind))
    }

    /// A restart, as far as the borrower's memory goes: every lease is gone, the loans in the store are not.
    #[cfg(test)]
    pub fn forget_leases_for_test(&self) {
        lock(&self.leases).clear();
    }

    /// The last borrow's failure for a local account, as its sentence.
    #[cfg(test)]
    pub fn lease_error_for_test(&self, kind: ProviderKind, instance: &str) -> Option<String> {
        let lease = lock(&self.leases).get(&(kind, instance.to_string())).cloned()?;
        lock(&lease.state).last_error.as_ref().map(|error| error.message(kind))
    }

    // ---- recovery bookkeeping ----

    /// Whether this turn may still be recovered automatically; true once per turn.
    pub fn take_recovery(&self, turn_id: Uuid) -> bool {
        let mut recovered = lock(&self.recovered);
        if recovered.len() > 512 {
            recovered.clear();
        }
        recovered.insert(turn_id)
    }

    // ---- lender: what this machine can lend ----

    /// Signed-in accounts here that the broker could lend. Accounts that themselves sign in through a
    /// broker are never lent on.
    pub async fn lendable(&self, state: &AppState) -> Vec<LendableAccount> {
        let mut lendable = Vec::new();
        // Only harnesses with an account sign-in: omp, OpenCode and pi have none to lend or borrow.
        for kind in [ProviderKind::ClaudeCode, ProviderKind::Codex] {
            let Ok(list) = crate::provider_accounts::list(state, AccountsListParams { kind: Some(kind), refresh: false }).await else {
                continue;
            };
            for account in list.accounts {
                if account.status != AccountStatus::SignedIn || self.binding(kind, &account.provider.instance).is_some() {
                    continue;
                }
                lendable.push(LendableAccount {
                    provider: kind,
                    account: account.provider.instance,
                    name: account.name,
                    email: account.identity.as_ref().and_then(|identity| identity.email.clone()),
                    plan: account.identity.as_ref().and_then(|identity| identity.plan.clone()),
                });
            }
        }
        lendable
    }

    /// Only the lender serves a borrow. The refusal names it (`not_lender`) so a borrower that has not heard of a move
    /// says so instead of "not signed in". Older borrowers read the code and show the sentence.
    fn ensure_broker(&self) -> Result<(), RpcError> {
        if self.broker_id().as_deref() == Some(self.self_id().as_str()) {
            Ok(())
        } else {
            let name = self.hub.self_name();
            let message = format!(
                "{name} no longer shares its sign-ins. Choose the machine that shares them in Settings → Accounts, or sign in on this machine."
            );
            Err(RpcError::new(codes::NOT_AVAILABLE, message.clone())
                .with_problem(&Problem::new(ProblemKind::Permission, message).with_subject(NOT_LENDER)))
        }
    }

    /// Read (and when it is about to die, refresh) the login of one of this machine's accounts.
    async fn lend(&self, state: &AppState, kind: ProviderKind, account: &str) -> Result<(BorrowedLogin, Option<String>), RpcError> {
        if self.binding(kind, account).is_some() {
            return Err(RpcError::new(
                codes::NOT_AVAILABLE,
                "That account uses another machine's sign-in itself, so it can't be shared on.",
            ));
        }
        let unavailable = |text: String| RpcError::new(codes::NOT_AVAILABLE, text);
        let instance = ProviderInstance { kind, instance: account.to_string() };
        let name = self.hub.self_name();
        match kind {
            ProviderKind::ClaudeCode => {
                let context = crate::provider_accounts::context(state, &instance).map_err(|error| unavailable(error.to_string()))?;
                let not_signed_in = || unavailable(format!("Claude is not signed in on {name}. Sign in on {name} first."));
                let mut stored = login_lend::read_claude(&context).await.ok_or_else(not_signed_in)?;
                if claude_expires_within(&stored, HARD_EXPIRY_MS) {
                    let _gate = self.refresh_gate.lock().await;
                    // Another borrow may have refreshed while this one waited for the gate.
                    stored = login_lend::read_claude(&context).await.ok_or_else(not_signed_in)?;
                    if claude_expires_within(&stored, HARD_EXPIRY_MS) {
                        login_lend::refresh_claude(&context, context.binary.as_deref())
                            .await
                            .map_err(|reason| unavailable(format!("{reason} ({name})")))?;
                        stored = login_lend::read_claude(&context).await.ok_or_else(not_signed_in)?;
                    }
                }
                let login = BorrowedLogin::Claude { access_token: stored.access_token.clone(), expires_at_ms: stored.expires_at_ms };
                self.observe(state, kind, account, &login).await;
                Ok((login, stored.plan))
            }
            ProviderKind::Codex => {
                let provider = state.settings.get().providers.get(&kind).cloned().unwrap_or_default();
                let env = crate::provider_accounts::environment(&provider, kind, account).map_err(|error| unavailable(error.to_string()))?;
                let read = || login_lend::read_codex(&env).map_err(|reason| unavailable(format!("{reason} ({name})")));
                let mut stored = read()?;
                if codex_expires_within(&stored, HARD_EXPIRY_MS) {
                    // Codex renews its own login; Kybern never redeems the refresh token.
                    let _gate = self.refresh_gate.lock().await;
                    stored = read()?;
                    if codex_expires_within(&stored, HARD_EXPIRY_MS) {
                        let _ = kybern_drivers::codex::refresh_account_login(state.settings.dir(), provider.binary.clone().map(std::path::PathBuf::from).as_ref(), &env)
                            .await;
                        stored = read()?;
                    }
                }
                if codex_expires_within(&stored, HARD_EXPIRY_MS) {
                    return Err(unavailable(format!(
                        "Codex's login on {name} has expired and couldn't renew. Use Codex on {name} once, or sign in again there, then try again."
                    )));
                }
                let plan = login_lend::codex_plan_label(stored.plan_type.as_deref());
                let login = BorrowedLogin::Codex {
                    access_token: stored.access_token,
                    account_id: stored.account_id,
                    plan_type: stored.plan_type,
                    id_token: stored.id_token,
                };
                self.observe(state, kind, account, &login).await;
                Ok((login, plan))
            }
            ProviderKind::Omp => Ok((self.omp_login(state).await.map_err(unavailable)?, None)),
            other => Err(unavailable(format!("{} sign-ins are not lent. Push its key instead.", other.display_name()))),
        }
    }

    /// `peer.login.borrow` on the broker.
    pub async fn serve_borrow(
        &self,
        state: &AppState,
        requester: &str,
        params: PeerLoginBorrowParams,
    ) -> Result<PeerLoginBorrowResult, RpcError> {
        self.ensure_broker()?;
        if !broker_supports(params.provider) {
            return Err(RpcError::invalid_params(format!("{} sign-ins are not lent.", params.provider.display_name())));
        }
        let membership = self.network.membership().ok_or_else(|| RpcError::new(codes::NOT_AVAILABLE, "no network"))?;
        let projection = membership.projection();
        let sealing_key = projection
            .entry(requester)
            .filter(|entry| entry.removed.is_none())
            .map(|entry| entry.descriptor.sealing_key.clone())
            .ok_or_else(|| {
                let message = format!(
                    "{} doesn't know that machine yet. Wait a minute for your machines to sync, then try again.",
                    self.hub.self_name()
                );
                RpcError::new(codes::NOT_FOUND, message.clone())
                    .with_problem(&Problem::new(ProblemKind::Permission, message).with_subject(UNKNOWN_MACHINE))
            })?;
        let (login, plan) = self.lend(state, params.provider, &params.account).await?;
        let expires_at = expiry_of(&login);
        // A renewal keeps its loan; anything else is a new one.
        let existing = params.loan_id.as_deref().and_then(|id| self.store.loan_get(id).ok().flatten()).filter(|loan| {
            loan.role == LoanRole::Lender && loan.peer == requester && loan.provider == params.provider && loan.account == params.account
        });
        let loan_id = existing.as_ref().map(|loan| loan.loan_id.clone()).unwrap_or_else(|| Uuid::now_v7().to_string());
        let row = LoanRow {
            loan_id: loan_id.clone(),
            role: LoanRole::Lender,
            peer: requester.to_string(),
            provider: params.provider,
            account: params.account.clone(),
            local_instance: None,
            generation: existing.map_or(1, |loan| loan.generation + 1),
            expires_at,
            last_pushed_at: None,
            last_error: None,
            created_at: Utc::now(),
        };
        self.store.loan_open(&row).map_err(RpcError::internal)?;
        let sealed = seal_login(&sealing_key, &login_context(&loan_id, &self.self_id(), requester, params.provider), &login)
            .map_err(|error| RpcError::internal(format!("{error:#}")))?;
        tracing::info!(target: TARGET, machine = requester, provider = params.provider.as_str(), "lent a login");
        let email = self.lent_email(state, params.provider, &params.account).await;
        Ok(PeerLoginBorrowResult { loan_id, sealed, expires_at, email, plan })
    }

    /// The email of one of this machine's accounts, so a borrower knows which account it borrowed: the one last
    /// seen, else a probe (cached for minutes).
    async fn lent_email(&self, state: &AppState, kind: ProviderKind, account: &str) -> Option<String> {
        let known = if account == "default" {
            crate::accounts_shared::terminal_email(&state.store, kind)
        } else {
            self.account_email(kind, account)
        };
        if known.is_some() {
            return known;
        }
        let instance = ProviderInstance { kind, instance: account.to_string() };
        let (_, identity) = state.account_identities.probe(state, &instance, false).await;
        identity.and_then(|identity| identity.email).map(|email| email.trim().to_ascii_lowercase())
    }

    /// `peer.login.release`.
    pub fn serve_release(&self, requester: &str, params: PeerLoginReleaseParams) -> Result<(), RpcError> {
        if let Some(loan) = self.store.loan_get(&params.loan_id).map_err(RpcError::internal)?
            && loan.role == LoanRole::Lender
            && loan.peer == requester
        {
            self.store.loan_release(&params.loan_id).map_err(RpcError::internal)?;
        }
        Ok(())
    }

    /// `peer.login.status`.
    pub async fn serve_status(&self, state: &AppState) -> PeerLoginStatus {
        let is_broker = self.broker_id().as_deref() == Some(self.self_id().as_str());
        let borrowed_from = self
            .store
            .loans_open(LoanRole::Borrower)
            .unwrap_or_default()
            .into_iter()
            .map(|loan| loan.peer)
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        let mut busy_loans = Vec::new();
        for loan in self.store.loans_open(LoanRole::Borrower).unwrap_or_default() {
            if let Some(instance) = &loan.local_instance
                && state.orchestrator.login_sessions_busy(loan.provider, instance).await
            {
                busy_loans.push(loan.loan_id);
            }
        }
        PeerLoginStatus { broker: self.broker_id(), is_broker, lendable: self.lendable(state).await, borrowed_from, busy_loans }
    }

    /// `peer.login.usage`: the plan limits the broker already reads for the account.
    pub async fn serve_usage(&self, state: &AppState, params: PeerLoginUsageParams) -> Result<UsageLimitsResult, RpcError> {
        self.ensure_broker()?;
        let instance = ProviderInstance { kind: params.provider, instance: params.account };
        let limits = state
            .orchestrator
            .usage()
            .limits(UsageLimitsParams { cached: true, instances: vec![instance.clone()], ..Default::default() })
            .await;
        let default = crate::provider_accounts::resolve(
            &state.settings.get().providers.get(&instance.kind).cloned().unwrap_or_default(),
            None,
            None,
        );
        Ok(lent_usage(limits, &instance, &default))
    }

    // ---- lender: rotation ----

    /// Note the token a lent account has now. When it differs from the last one seen, the harness rotated
    /// it and every outstanding Claude loan is dead: push the new token to the other borrowers.
    async fn observe(&self, state: &AppState, kind: ProviderKind, account: &str, login: &BorrowedLogin) {
        let print = fingerprint(login_token(login));
        let changed = {
            let mut seen = lock(&self.seen);
            let previous = seen.insert((kind, account.to_string()), print);
            previous.is_some_and(|previous| previous != print)
        };
        // Claude revokes every outstanding token when it refreshes; Codex keeps the old one until it expires, but a
        // borrower holding the new one never needs to borrow again at expiry.
        if changed && matches!(kind, ProviderKind::ClaudeCode | ProviderKind::Codex) {
            self.push_rotation(state, kind, account, login).await;
        }
    }

    /// Send a rotated credential to every borrower of the account.
    pub async fn push_rotation(&self, state: &AppState, kind: ProviderKind, account: &str, login: &BorrowedLogin) {
        let _ = state;
        let loans: Vec<LoanRow> = self
            .store
            .loans_open(LoanRole::Lender)
            .unwrap_or_default()
            .into_iter()
            .filter(|loan| loan.provider == kind && loan.account == account)
            .collect();
        let Some(membership) = self.network.membership() else { return };
        let me = self.self_id();
        for loan in loans {
            let projection = membership.projection();
            let Some(entry) = projection.entry(&loan.peer).filter(|entry| entry.removed.is_none()) else {
                let _ = self.store.loan_release(&loan.loan_id);
                continue;
            };
            let sealed = match seal_login(&entry.descriptor.sealing_key, &login_context(&loan.loan_id, &me, &loan.peer, kind), login) {
                Ok(sealed) => sealed,
                Err(error) => {
                    let _ = self.store.loan_pushed(&loan.loan_id, Utc::now(), None, Some(&format!("{error:#}")));
                    continue;
                }
            };
            let expires_at = expiry_of(login);
            let params = PeerLoginPushParams { loan_id: loan.loan_id.clone(), provider: kind, sealed, expires_at };
            match self.hub.call(&loan.peer, PeerLoginPush::NAME, serde_json::to_value(&params).unwrap_or_default()).await {
                Ok(_) => {
                    let _ = self.store.loan_pushed(&loan.loan_id, Utc::now(), expires_at, None);
                    tracing::info!(target: TARGET, machine = %loan.peer, "pushed a rotated login");
                }
                Err(CallFailure::Remote(error)) if error.code == codes::NOT_FOUND => {
                    // The borrower forgot the loan (it restarted); it borrows again when it needs to.
                    let _ = self.store.loan_release(&loan.loan_id);
                }
                Err(failure) => {
                    let _ = self.store.loan_pushed(&loan.loan_id, Utc::now(), None, Some(&failure.to_string()));
                }
            }
        }
    }

    /// One look at the lent accounts: notice a rotation, and have the harness refresh a login that is about to
    /// expire. A Claude refresh revokes the token borrowers run on, so it waits until no borrower has a turn running
    /// (up to [`REFRESH_FORCED_MS`] before expiry). A failed refresh is not tried again for [`REFRESH_RETRY`].
    pub(crate) async fn watch_lent(&self, state: &AppState) {
        let loans = self.store.loans_open(LoanRole::Lender).unwrap_or_default();
        let mut accounts: Vec<(ProviderKind, String)> = Vec::new();
        for loan in &loans {
            if matches!(loan.provider, ProviderKind::ClaudeCode | ProviderKind::Codex) && !accounts.contains(&(loan.provider, loan.account.clone())) {
                accounts.push((loan.provider, loan.account.clone()));
            }
        }
        for (kind, account) in accounts {
            let key = (kind, account.clone());
            let backing_off = lock(&self.refresh_failed).get(&key).is_some_and(|at| at.elapsed() < REFRESH_RETRY);
            let instance = ProviderInstance { kind, instance: account.clone() };
            let login = match kind {
                ProviderKind::ClaudeCode => {
                    let Ok(context) = crate::provider_accounts::context(state, &instance) else { continue };
                    let Some(mut stored) = login_lend::read_claude(&context).await else { continue };
                    let forced = claude_expires_within(&stored, REFRESH_FORCED_MS);
                    if claude_expires_within(&stored, REFRESH_AHEAD_MS) && !backing_off {
                        let borrowers: Vec<&LoanRow> = loans.iter().filter(|loan| loan.provider == kind && loan.account == account).collect();
                        if forced || !self.borrowers_busy(&borrowers).await {
                            let _gate = self.refresh_gate.lock().await;
                            if let Some(again) = login_lend::read_claude(&context).await {
                                stored = again;
                            }
                            if claude_expires_within(&stored, REFRESH_AHEAD_MS) {
                                match login_lend::refresh_claude(&context, context.binary.as_deref()).await {
                                    Ok(()) => {
                                        lock(&self.refresh_failed).remove(&key);
                                        if let Some(again) = login_lend::read_claude(&context).await {
                                            stored = again;
                                        }
                                    }
                                    Err(reason) => {
                                        lock(&self.refresh_failed).insert(key.clone(), std::time::Instant::now());
                                        tracing::warn!(target: TARGET, reason, "could not refresh the lent Claude login");
                                    }
                                }
                            }
                        }
                    }
                    BorrowedLogin::Claude { access_token: stored.access_token, expires_at_ms: stored.expires_at_ms }
                }
                _ => {
                    let provider = state.settings.get().providers.get(&kind).cloned().unwrap_or_default();
                    let Ok(env) = crate::provider_accounts::environment(&provider, kind, &account) else { continue };
                    let Ok(mut stored) = login_lend::read_codex(&env) else { continue };
                    if codex_expires_within(&stored, CODEX_REFRESH_AHEAD_MS) && !backing_off {
                        let _gate = self.refresh_gate.lock().await;
                        // Another look may have renewed it while this one waited for the gate.
                        if let Ok(again) = login_lend::read_codex(&env) {
                            stored = again;
                        }
                        if codex_expires_within(&stored, CODEX_REFRESH_AHEAD_MS) {
                            let binary = provider.binary.clone().map(std::path::PathBuf::from);
                            match kybern_drivers::codex::refresh_account_login(state.settings.dir(), binary.as_ref(), &env).await {
                                Ok(()) => {
                                    if let Ok(again) = login_lend::read_codex(&env) {
                                        stored = again;
                                    }
                                }
                                Err(reason) => tracing::warn!(target: TARGET, reason, "could not renew the lent Codex login"),
                            }
                        }
                        if codex_expires_within(&stored, CODEX_REFRESH_AHEAD_MS) {
                            lock(&self.refresh_failed).insert(key.clone(), std::time::Instant::now());
                        } else {
                            lock(&self.refresh_failed).remove(&key);
                        }
                    }
                    BorrowedLogin::Codex {
                        access_token: stored.access_token,
                        account_id: stored.account_id,
                        plan_type: stored.plan_type,
                        id_token: stored.id_token,
                    }
                }
            };
            self.observe(state, kind, &account, &login).await;
        }
    }

    /// Whether any of these borrowers has a turn running on its loan now (`busy_loans`). A borrower that doesn't
    /// answer, or an older one that doesn't say, counts as idle: the refresh is never put off for good.
    async fn borrowers_busy(&self, loans: &[&LoanRow]) -> bool {
        let peers: HashSet<&str> = loans.iter().map(|loan| loan.peer.as_str()).collect();
        for peer in peers {
            if let Ok(Ok(value)) = tokio::time::timeout(STATUS_WAIT, self.hub.call(peer, PeerLoginStatusMethod::NAME, Value::Null)).await
                && let Ok(status) = serde_json::from_value::<PeerLoginStatus>(value)
                && loans.iter().any(|loan| loan.peer == peer && status.busy_loans.contains(&loan.loan_id))
            {
                return true;
            }
        }
        false
    }

    // ---- omp ----

    /// The URL and bearer token of the `omp auth-broker serve` this machine runs for the others.
    async fn omp_login(&self, state: &AppState) -> Result<BorrowedLogin, String> {
        let settings = state.settings.get();
        let provider = settings.providers.get(&ProviderKind::Omp).cloned().unwrap_or_default();
        let env = crate::provider_accounts::environment(&provider, ProviderKind::Omp, "default").map_err(|error| error.to_string())?;
        let binary = kybern_drivers::binary::resolve(ProviderKind::Omp, provider.binary.clone().map(std::path::PathBuf::from).as_ref())
            .map_err(|error| error.to_string())?;
        let status = self
            .network
            .tailscale
            .status()
            .await
            .map_err(|_| "Sharing omp's sign-in needs Tailscale running on the machine that shares it.".to_string())?;
        let ip = status
            .self_node
            .as_ref()
            .and_then(|node| node.ip())
            .ok_or("Sharing omp's sign-in needs a Tailscale address on the machine that shares it.")?;
        let url = format!("http://{ip}:{OMP_BROKER_PORT}");
        {
            let mut running = self.omp.lock().await;
            let alive = match running.as_mut() {
                Some(child) => child.try_wait().ok().flatten().is_none(),
                None => false,
            };
            if !alive {
                use kybern_protocol::process::NoWindow;
                let mut command = tokio::process::Command::new(&binary).no_window();
                command
                    .args(["auth-broker", "serve", &format!("--bind={ip}:{OMP_BROKER_PORT}")])
                    .envs(&env)
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .kill_on_drop(false);
                *running = Some(command.spawn().map_err(|error| format!("Could not start omp's sign-in sharing: {error}"))?);
            }
        }
        let mut command = {
            use kybern_protocol::process::NoWindow;
            tokio::process::Command::new(&binary).no_window()
        };
        command.args(["auth-broker", "token"]).envs(&env).stdin(std::process::Stdio::null());
        let output = tokio::time::timeout(Duration::from_secs(10), command.output())
            .await
            .map_err(|_| "omp did not hand over its sign-in in time. Try again.".to_string())?
            .map_err(|error| error.to_string())?;
        let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !output.status.success() || token.is_empty() {
            return Err("omp has no sign-in to share. Run `omp auth-broker login` on this machine first.".into());
        }
        Ok(BorrowedLogin::Omp { url, token })
    }

    // ---- client methods ----

    /// `login.broker.status`.
    pub async fn status(&self, state: &AppState) -> LoginBrokerStatus {
        let broker_id = self.broker_id();
        let me = self.self_id();
        let is_broker = broker_id.as_deref() == Some(me.as_str());
        let broker = broker_id.as_ref().map(|id| BrokerInfo {
            machine_id: id.clone(),
            name: Some(self.member_name(id)),
            reachable: *id == me || self.hub.target(id).is_some_and(|target| target.online),
        });
        // What the broker can lend, from the broker itself.
        let remote = match (&broker_id, is_broker) {
            (Some(id), false) => match tokio::time::timeout(STATUS_WAIT, self.hub.call(id, PeerLoginStatusMethod::NAME, Value::Null)).await
            {
                Ok(Ok(value)) => serde_json::from_value::<PeerLoginStatus>(value).ok(),
                _ => None,
            },
            _ => None,
        };
        let local_lendable = if is_broker { self.lendable(state).await } else { Vec::new() };
        let settings = state.settings.get();
        let mut providers = Vec::new();
        // Only harnesses with an account sign-in: omp, OpenCode and pi have none to lend or borrow.
        for kind in [ProviderKind::ClaudeCode, ProviderKind::Codex] {
            let bound = settings
                .providers
                .get(&kind)
                .map(|provider| {
                    provider
                        .accounts
                        .keys()
                        .filter_map(|id| self.binding(kind, id).map(|account| (id.clone(), account)))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let (local_account, broker_account) = bound.first().cloned().map(|(l, b)| (Some(l), Some(b))).unwrap_or((None, None));
            let lendable: Vec<LendableAccount> = if is_broker {
                local_lendable.iter().filter(|a| a.provider == kind).cloned().collect()
            } else {
                remote.as_ref().map(|r| r.lendable.iter().filter(|a| a.provider == kind).cloned().collect()).unwrap_or_default()
            };
            let (state_of, message) = if let Some(local) = &local_account {
                match self.account_view(kind, local) {
                    Some(view) => (view.state, view.message),
                    None => (BrokerLoginState::NotUsed, None),
                }
            } else if is_broker {
                // Lending means something is signed in here to lend.
                (if lendable.is_empty() { BrokerLoginState::NotUsed } else { BrokerLoginState::Lending }, None)
            } else if broker_id.is_none() {
                (BrokerLoginState::NotUsed, None)
            } else if remote.is_none() {
                let error = BrokerError::Offline(broker.as_ref().and_then(|b| b.name.clone()).unwrap_or_default());
                (error.state(), Some(error.message(kind)))
            } else if lendable.is_empty() {
                let name = broker.as_ref().and_then(|b| b.name.clone()).unwrap_or_default();
                (BrokerLoginState::BrokerNotSignedIn, Some(format!("{} is not signed in on {name} yet.", kind.display_name())))
            } else {
                (BrokerLoginState::NotUsed, None)
            };
            providers.push(BrokerProviderStatus {
                provider: kind,
                state: state_of,
                local_account,
                broker_account,
                lendable,
                message,
                sessions: 0,
            });
        }
        let loans = if is_broker {
            self.store
                .loans_open(LoanRole::Lender)
                .unwrap_or_default()
                .into_iter()
                .map(|loan| BrokerLoanView {
                    loan_id: loan.loan_id,
                    machine_id: loan.peer,
                    provider: loan.provider,
                    account: loan.account,
                    created_at: loan.created_at,
                    last_pushed_at: loan.last_pushed_at,
                    last_error: loan.last_error,
                })
                .collect()
        } else {
            Vec::new()
        };
        LoginBrokerStatus { broker, is_broker, providers, loans, lender: self.lender_status(), lenders: self.lender_candidates() }
    }

    /// `login.broker.bind`.
    pub async fn bind(&self, state: &AppState, params: LoginBrokerBindParams) -> Result<LoginBrokerStatus, RpcError> {
        if !broker_supports(params.provider) {
            return Err(RpcError::invalid_params(format!(
                "{} sign-ins are not lent. Push its key instead.",
                params.provider.display_name()
            )));
        }
        if params.instance == "default" {
            return Err(RpcError::invalid_params(
                "The CLI account keeps its own sign-in. Create a named account to use another machine's sign-in.",
            ));
        }
        let exists =
            state.settings.get().providers.get(&params.provider).is_some_and(|provider| provider.accounts.contains_key(&params.instance));
        if !exists {
            return Err(RpcError::not_found("account"));
        }
        let here = self.borrower(Some(&params.instance));
        let previous = self.binding(params.provider, &params.instance);
        // Choosing (or dropping) the lender's account by hand settles an account the lender had no sign-in for.
        self.set_unmatched(params.provider, &params.instance, None);
        if let Some(account) = &params.broker_account {
            let refuse = |error: BrokerError| error.rpc_error(params.provider, &here);
            let lender = self.lender_status().ok_or_else(|| refuse(BrokerError::NoBroker))?;
            if lender.machine_id == self.self_id() {
                return Err(refuse(BrokerError::IsSelf));
            }
            // Accounts already bound keep borrowing; a new one binds only to a lender someone chose, or one that is always on.
            if previous.is_none() && !lender.usable_for_new {
                return Err(refuse(BrokerError::NotForNew(lender.reason.unwrap_or_default())));
            }
            self.set_binding(params.provider, &params.instance, Some(account)).map_err(RpcError::internal)?;
            // Borrow once now, so a lender that refuses says so while the account is being set up, not at its
            // first message. An offline lender is not a refusal: the account borrows once it is back.
            let lease = self.lease_for(params.provider, &params.instance, account);
            // Binding is the choice of the lender's account, so the account takes its email.
            let lent = match self.borrow_as(&lease, false, true).await {
                Err(error) if error.refuses_binding() => {
                    let _ = self.set_binding(params.provider, &params.instance, previous.as_deref());
                    if previous.as_deref() != Some(account.as_str()) {
                        lock(&self.leases).remove(&(params.provider, params.instance.clone()));
                    }
                    return Err(refuse(error));
                }
                outcome => outcome.is_ok(),
            };
            // An offline lender, or an older one that doesn't say: the email its machine last published.
            if !lent || self.account_email(params.provider, &params.instance).is_none() {
                let published = crate::network::accounts_sync::lender_key(state, &lender.machine_id, params.provider, account)
                    .and_then(|key| crate::accounts_shared::parse_key(&key).map(|(_, email)| email.to_string()));
                match published {
                    Some(email) => self.remember_email(params.provider, &params.instance, &email, None),
                    // Another account than before, not known yet: the first borrow takes its email.
                    None if !lent && previous.as_deref() != Some(account.as_str()) => self.clear_email(params.provider, &params.instance),
                    None => {}
                }
            }
        } else {
            self.set_binding(params.provider, &params.instance, None).map_err(RpcError::internal)?;
        }
        if params.broker_account.is_none() {
            // Unbinding: let go of the loan and the cached token.
            let removed = lock(&self.leases).remove(&(params.provider, params.instance.clone()));
            if let Some(lease) = removed {
                let (loan, broker) = {
                    let mut lease_state = lock(&lease.state);
                    (lease_state.loan_id.take(), lease_state.broker.clone())
                };
                if let Some(loan_id) = loan {
                    let _ = self.store.loan_release(&loan_id);
                    let _ = self.hub.call(&broker, PeerLoginRelease::NAME, json!({ "loan_id": loan_id })).await;
                }
            }
            // A session that holds the lent token must not outlive the loan.
            state.orchestrator.end_login_sessions(params.provider, &params.instance, false).await;
        }
        state.account_identities.invalidate(&ProviderInstance { kind: params.provider, instance: params.instance });
        Ok(self.status(state).await)
    }

    /// `peer.login.release_all` on the old broker, after a move.
    pub async fn serve_release_all(&self, state: &AppState, params: PeerLoginReleaseAllParams) -> PeerLoginReleaseAllResult {
        // A machine that is still the broker keeps its loans and its sign-ins: this is only for the old broker
        // after the register moved, so no other member can sign a working broker out.
        if self.broker_id().as_deref() == Some(self.self_id().as_str()) {
            return PeerLoginReleaseAllResult::default();
        }
        let loans = self.store.loans_open(LoanRole::Lender).unwrap_or_default();
        for loan in &loans {
            let _ = self.store.loan_release(&loan.loan_id);
        }
        // The borrowers have usually let their loans go already; the history says what this machine lent.
        let lent = self.store.accounts_ever_lent().unwrap_or_default();
        let mut signed_out = Vec::new();
        if params.sign_out {
            for (kind, account) in lent {
                // The CLI account is the user's own sign-in on this machine: it stops lending, nothing more.
                if account == "default" {
                    continue;
                }
                let instance = ProviderInstance { kind, instance: account };
                if crate::provider_accounts::sign_out(state, instance.into()).await.is_ok() && !signed_out.contains(&kind) {
                    signed_out.push(kind);
                }
            }
        }
        lock(&self.seen).clear();
        PeerLoginReleaseAllResult { released: loans.len() as u32, signed_out }
    }

    // ---- this machine left the network ----

    /// This machine was removed, or its network was turned off: drop every borrowed login it holds, release the
    /// loans, and end the sessions running on them (§2.5, §9.4). The broker hears of a release only while the network
    /// is on; a removed machine's loans expire there on their own. Returns how many loans ended.
    pub async fn forget_borrowed(&self, state: &AppState) -> usize {
        let leases: Vec<Arc<Lease>> = lock(&self.leases).drain().map(|(_, lease)| lease).collect();
        let mut ended: Vec<(ProviderKind, String)> = Vec::new();
        for lease in &leases {
            *lock(&lease.state) = LeaseState::default();
            ended.push((lease.kind, lease.instance.clone()));
        }
        let loans = self.store.loans_open(LoanRole::Borrower).unwrap_or_default();
        for loan in &loans {
            let _ = self.store.loan_release(&loan.loan_id);
            if self.network.is_enabled() {
                let _ = tokio::time::timeout(
                    STATUS_WAIT,
                    self.hub.call(&loan.peer, PeerLoginRelease::NAME, json!({ "loan_id": loan.loan_id })),
                )
                .await;
            }
            if let Some(instance) = &loan.local_instance
                && !ended.contains(&(loan.provider, instance.clone()))
            {
                ended.push((loan.provider, instance.clone()));
            }
        }
        for (kind, instance) in &ended {
            // A session that holds the lent token must not outlive the loan.
            state.orchestrator.end_login_sessions(*kind, instance, false).await;
        }
        if !ended.is_empty() {
            tracing::info!(target: TARGET, loans = loans.len(), accounts = ended.len(), "this machine left its network; dropped its borrowed logins");
        }
        loans.len()
    }

    // ---- the register moved: borrow from the new broker ----

    /// Borrow again from the current broker for every loan held from another machine, and let the old
    /// one go. Called each tick, so a member that was offline during a move catches up when it returns.
    /// The account is the one with the same email on the new lender, never just any account of the harness; when
    /// it has none, the account is left unbound and says so ([`BrokerError::Unmatched`]).
    async fn rebind_borrowers(&self, state: &AppState) {
        let current = self.broker_id();
        let me = self.self_id();
        if current.as_deref() == Some(me.as_str()) {
            // This machine became the lender: it signs in itself, and a binding here would only refuse its threads.
            self.drop_own_bindings(state).await;
        }
        // What the new broker can lend, asked once per look.
        let mut lendable: Option<Vec<LendableAccount>> = None;
        for loan in self.store.loans_open(LoanRole::Borrower).unwrap_or_default() {
            if current.as_deref() == Some(loan.peer.as_str()) {
                continue;
            }
            let (Some(instance), Some(new_broker)) = (loan.local_instance.clone(), current.clone()) else {
                // No broker any more, or the lender left: nothing backs the loan, so the sessions on it end.
                let _ = self.store.loan_release(&loan.loan_id);
                if let Some(instance) = &loan.local_instance {
                    lock(&self.leases).remove(&(loan.provider, instance.clone()));
                    state.orchestrator.end_login_sessions(loan.provider, instance, false).await;
                }
                continue;
            };
            if new_broker == me {
                // Released by `drop_own_bindings`; a loan whose binding was already gone only needs releasing.
                let _ = self.store.loan_release(&loan.loan_id);
                lock(&self.leases).remove(&(loan.provider, instance.clone()));
                continue;
            }
            if lendable.is_none() {
                lendable = Some(match self.lendable_on(&new_broker).await {
                    Some(lendable) => lendable,
                    // Not reachable yet: try again next look.
                    None => continue,
                });
            }
            let offered: Vec<&LendableAccount> = lendable.iter().flatten().filter(|account| account.provider == loan.provider).collect();
            let expected = self.account_email(loan.provider, &instance).or_else(|| self.published_email(state, &loan.peer, loan.provider, &loan.account));
            let matched = expected
                .as_deref()
                .and_then(|want| offered.iter().find(|account| account.email.as_deref().is_some_and(|email| same_email(email, want))))
                .map(|account| account.account.clone());
            let Some(account) = matched else {
                self.leave_unmatched(state, &loan, &instance, &new_broker, expected.as_deref()).await;
                continue;
            };
            if expected.is_some() && self.account_email(loan.provider, &instance).is_none() {
                self.remember_email(loan.provider, &instance, expected.as_deref().unwrap_or_default(), None);
            }
            if account != loan.account {
                let _ = self.set_binding(loan.provider, &instance, Some(&account));
            }
            let lease = self.lease_for(loan.provider, &instance, &account);
            // Borrow from the new broker first; the old loan is released only once the new one works.
            if self.borrow(&lease, true).await.is_ok() {
                let _ = self.store.loan_release(&loan.loan_id);
                let _ = self.hub.call(&loan.peer, PeerLoginRelease::NAME, json!({ "loan_id": loan.loan_id })).await;
                // The old broker's token is no good once it signs out: idle sessions start over on the new one.
                state.orchestrator.end_login_sessions(loan.provider, &instance, true).await;
                tracing::info!(target: TARGET, provider = loan.provider.as_str(), "borrowed again from the new login broker");
            }
        }
        let tick = self.ticks.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if tick % UNMATCHED_EVERY == 0 {
            self.recheck_unmatched(state, lendable).await;
        }
    }

    /// What `machine` can lend now, or `None` when it doesn't answer.
    async fn lendable_on(&self, machine: &str) -> Option<Vec<LendableAccount>> {
        match tokio::time::timeout(STATUS_WAIT, self.hub.call(machine, PeerLoginStatusMethod::NAME, Value::Null)).await {
            Ok(Ok(value)) => Some(serde_json::from_value::<PeerLoginStatus>(value).map(|status| status.lendable).unwrap_or_default()),
            _ => None,
        }
    }

    /// The email `machine` published for one of its accounts (its holdings), for a lender that doesn't say.
    fn published_email(&self, state: &AppState, machine: &str, kind: ProviderKind, account: &str) -> Option<String> {
        let key = crate::network::accounts_sync::lender_key(state, machine, kind, account)?;
        crate::accounts_shared::parse_key(&key).map(|(_, email)| email.to_string())
    }

    /// The new lender has no sign-in for this account: let the old loan go, leave the account unbound, and record
    /// which lender and email it waits for. A turn running on the old token finishes; nothing new starts on it.
    async fn leave_unmatched(&self, state: &AppState, loan: &LoanRow, instance: &str, lender: &str, email: Option<&str>) {
        let _ = self.store.loan_release(&loan.loan_id);
        let _ = tokio::time::timeout(STATUS_WAIT, self.hub.call(&loan.peer, PeerLoginRelease::NAME, json!({ "loan_id": loan.loan_id }))).await;
        lock(&self.leases).remove(&(loan.provider, instance.to_string()));
        let _ = self.set_binding(loan.provider, instance, None);
        self.set_unmatched(loan.provider, instance, Some((lender, email)));
        state.orchestrator.end_login_sessions(loan.provider, instance, true).await;
        tracing::info!(target: TARGET, provider = loan.provider.as_str(), "the new lender has no sign-in for a borrowed account; left it unbound");
    }

    /// Accounts left unmatched bind again once the current lender has their email (signed in there since).
    async fn recheck_unmatched(&self, state: &AppState, known: Option<Vec<LendableAccount>>) {
        let entries: Vec<(ProviderKind, String, String, Option<String>)> = self
            .store
            .meta_list_prefix(UNMATCHED_PREFIX)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|(key, _)| {
                let (kind, instance) = parse_account_key(UNMATCHED_PREFIX, &key)?;
                let (lender, email) = self.unmatched(kind, instance)?;
                Some((kind, instance.to_string(), lender, email))
            })
            .collect();
        if entries.is_empty() {
            return;
        }
        let Some(current) = self.broker_id() else { return };
        let me = self.self_id();
        let exists = |kind: ProviderKind, instance: &str| {
            self.settings.get().providers.get(&kind).is_some_and(|provider| provider.accounts.contains_key(instance))
        };
        let mut lendable = known;
        for (kind, instance, lender, email) in entries {
            if current == me || !exists(kind, &instance) {
                self.set_unmatched(kind, &instance, None);
                continue;
            }
            if lender != current {
                self.set_unmatched(kind, &instance, Some((&current, email.as_deref())));
            }
            let Some(want) = email else { continue };
            if lendable.is_none() {
                lendable = self.lendable_on(&current).await;
            }
            let Some(account) = lendable
                .iter()
                .flatten()
                .find(|account| account.provider == kind && account.email.as_deref().is_some_and(|email| same_email(email, &want)))
                .map(|account| account.account.clone())
            else {
                continue;
            };
            let _ = self.set_binding(kind, &instance, Some(&account));
            self.set_unmatched(kind, &instance, None);
            let lease = self.lease_for(kind, &instance, &account);
            let _ = self.borrow(&lease, true).await;
            state.account_identities.invalidate(&ProviderInstance { kind, instance: instance.clone() });
            tracing::info!(target: TARGET, provider = kind.as_str(), "the lender has the account now; borrowing it again");
        }
    }

    /// This machine is the lender: every account here that borrowed stops, its loans go back, and the account loses
    /// the lent email when this machine has its own login of it (so the shared account maps to that one).
    async fn drop_own_bindings(&self, state: &AppState) {
        for (key, account) in self.store.meta_list_prefix(BINDING_PREFIX).unwrap_or_default() {
            if account.is_empty() {
                continue;
            }
            let Some((kind, instance)) = parse_account_key(BINDING_PREFIX, &key) else { continue };
            let instance = instance.to_string();
            let _ = self.set_binding(kind, &instance, None);
            lock(&self.leases).remove(&(kind, instance.clone()));
            for loan in self.store.loans_open(LoanRole::Borrower).unwrap_or_default() {
                if loan.provider == kind && loan.local_instance.as_deref() == Some(instance.as_str()) {
                    let _ = self.store.loan_release(&loan.loan_id);
                    let _ =
                        tokio::time::timeout(STATUS_WAIT, self.hub.call(&loan.peer, PeerLoginRelease::NAME, json!({ "loan_id": loan.loan_id })))
                            .await;
                }
            }
            self.forget_email_if_owned(kind, &instance);
            state.orchestrator.end_login_sessions(kind, &instance, true).await;
            state.account_identities.invalidate(&ProviderInstance { kind, instance });
            tracing::info!(target: TARGET, provider = kind.as_str(), "this machine shares its sign-ins now; an account here stopped borrowing");
        }
    }

    /// Loans and bindings of accounts removed here are let go (the lender stops pushing to them), and a lender lets
    /// go of loans of its own accounts that were removed. Leases live in memory; the loans in the store are the
    /// record, so this also tidies what a restart left behind.
    async fn prune_removed(&self, state: &AppState) {
        let settings = self.settings.get();
        let exists = |kind: ProviderKind, instance: &str| {
            instance == "default" || settings.providers.get(&kind).is_some_and(|provider| provider.accounts.contains_key(instance))
        };
        for loan in self.store.loans_open(LoanRole::Borrower).unwrap_or_default() {
            let Some(instance) = loan.local_instance.clone() else { continue };
            if exists(loan.provider, &instance) {
                continue;
            }
            let _ = self.store.loan_release(&loan.loan_id);
            let _ = tokio::time::timeout(STATUS_WAIT, self.hub.call(&loan.peer, PeerLoginRelease::NAME, json!({ "loan_id": loan.loan_id }))).await;
            lock(&self.leases).remove(&(loan.provider, instance.clone()));
            state.orchestrator.end_login_sessions(loan.provider, &instance, false).await;
        }
        for prefix in [BINDING_PREFIX, UNMATCHED_PREFIX] {
            for (key, value) in self.store.meta_list_prefix(prefix).unwrap_or_default() {
                if !value.is_empty()
                    && let Some((kind, instance)) = parse_account_key(prefix, &key)
                    && !exists(kind, instance)
                {
                    let _ = self.store.meta_set(&key, "");
                    lock(&self.leases).remove(&(kind, instance.to_string()));
                }
            }
        }
        for loan in self.store.loans_open(LoanRole::Lender).unwrap_or_default() {
            if !exists(loan.provider, &loan.account) {
                let _ = self.store.loan_release(&loan.loan_id);
            }
        }
    }

    /// Choosing this machine to share its sign-ins (`broker.choice`) after its Logins policy was turned off turns it
    /// on again: the later, deliberate choice wins. No screen offers the policy itself any more.
    fn allow_logins_after_choice(&self) {
        let Some(membership) = self.network.membership() else { return };
        let me = self.self_id();
        let key = format!("allow.{me}.logins");
        let stale = {
            let projection = membership.projection();
            let Some(choice) = projection.register(CHOICE_REGISTER) else { return };
            choice.value.get("machine_id").and_then(Value::as_str) == Some(me.as_str())
                && projection.register(&key).is_some_and(|policy| policy.value == json!(false) && policy.lamport < choice.lamport)
        };
        if !stale {
            return;
        }
        match membership.set(&key, json!(true)) {
            Ok(op) => {
                self.network.publish_ops(vec![op]);
                self.network.wake();
                tracing::info!(target: TARGET, "this machine was chosen to share its sign-ins; turned Logins on again");
            }
            Err(error) => tracing::warn!(target: TARGET, %error, "could not turn Logins on after sharing was chosen"),
        }
    }
}

/// The part of the lender's limits that leaves it for `instance`: that account's entry only, labelled with it. The
/// global entry is the lender's default account, so it goes only when that is the lent account.
fn lent_usage(limits: UsageLimitsResult, instance: &ProviderInstance, lender_default: &str) -> UsageLimitsResult {
    let mut accounts: Vec<ProviderLimits> = limits
        .accounts
        .into_iter()
        .filter(|entry| entry.provider == instance.kind && entry.instance.as_deref() == Some(instance.instance.as_str()))
        .collect();
    if accounts.is_empty()
        && lender_default == instance.instance
        && let Some(mut global) = limits.providers.into_iter().find(|entry| entry.provider == instance.kind)
    {
        global.instance = Some(instance.instance.clone());
        accounts.push(global);
    }
    let refreshing = limits.refreshing.into_iter().filter(|kind| *kind == instance.kind).collect();
    UsageLimitsResult { providers: Vec::new(), refreshing, accounts }
}

/// The lent account's entry in a lender's answer, and nothing else: never another account's limits.
fn lent_entry(result: UsageLimitsResult, kind: ProviderKind, account: &str) -> Option<ProviderLimits> {
    result.accounts.into_iter().find(|entry| entry.provider == kind && entry.instance.as_deref() == Some(account))
}

fn login_lend_supports(kind: ProviderKind) -> bool {
    broker_supports(kind)
}

fn claude_expires_within(stored: &login_lend::ClaudeStored, window_ms: i64) -> bool {
    stored.expires_at_ms.is_some_and(|expires| expires < Utc::now().timestamp_millis() + window_ms)
}

fn codex_expires_within(stored: &login_lend::CodexStored, window_ms: i64) -> bool {
    stored.expires_at.is_some_and(|expires| expires * 1000 < Utc::now().timestamp_millis() + window_ms)
}

// ---- the worker ----

/// The broker's watch (rotation, refresh ahead of expiry) and every member's catch-up after a move.
pub async fn run(state: AppState) {
    run_every(state, TICK).await
}

/// [`run`] with its own tick (the tests look every few hundred milliseconds).
pub async fn run_every(state: AppState, tick: Duration) {
    let Some(broker) = state.orchestrator.login_broker().cloned() else { return };
    let shutdown = state.shutdown.clone();
    let mut changes = state.network.subscribe_changes();
    loop {
        tokio::select! {
            _ = shutdown.cancelled() => return,
            _ = tokio::time::sleep(tick) => {}
            // A removal or the network turned off is acted on at once.
            _ = changes.recv() => {}
        }
        let Some(membership) = state.network.membership() else { continue };
        if membership.self_removed() {
            broker.forget_borrowed(&state).await;
            forget_pushed_secrets(&state);
            continue;
        }
        if !state.network.is_enabled() {
            broker.forget_borrowed(&state).await;
            continue;
        }
        broker.prune_removed(&state).await;
        if broker.broker_id().as_deref() == Some(broker.self_id().as_str()) {
            broker.allow_logins_after_choice();
            broker.watch_lent(&state).await;
        }
        broker.rebind_borrowers(&state).await;
        broker.retry_failed_leases().await;
    }
}

/// A removed machine deletes every key other members pushed to it, and the references to them in its provider
/// environments (§2.5). Nothing to do when there are none.
fn forget_pushed_secrets(state: &AppState) {
    let store = match crate::secret_store::store_of(state) {
        Ok(store) => store,
        Err(error) => {
            tracing::warn!(target: TARGET, %error, "could not open the secret store to delete pushed keys");
            return;
        }
    };
    let mut settings = state.settings.get();
    match store.forget_pushed(&mut settings) {
        Ok((0, _)) => {}
        Ok((deleted, unwired)) => {
            if unwired > 0
                && let Err(error) = state.settings.set(settings)
            {
                tracing::warn!(target: TARGET, %error, "could not remove the references to pushed keys from settings");
            }
            tracing::info!(target: TARGET, deleted, "this machine was removed; deleted the keys other machines pushed to it");
        }
        Err(error) => tracing::warn!(target: TARGET, %error, "could not delete the keys other machines pushed"),
    }
}

// ---- moving the broker ----

/// `login.broker.set`: the new broker signs in first (the client runs that), then the register switches,
/// the online members borrow from the new broker, and only then does the old broker sign out.
pub async fn set_broker(state: &AppState, params: LoginBrokerSetParams) -> Result<LoginBrokerSetResult, RpcError> {
    let broker = state
        .orchestrator
        .login_broker()
        .cloned()
        .ok_or_else(|| RpcError::new(codes::NOT_AVAILABLE, "The machine network is unavailable on this machine."))?;
    let network = &state.network;
    let membership =
        network.membership().ok_or_else(|| RpcError::new(codes::NOT_AVAILABLE, "The machine network is unavailable on this machine."))?;
    let me = broker.self_id();
    let old = broker.broker_id();
    let via = params.via.unwrap_or(LenderVia::Manual);
    // The choice is recorded next to the register: a lender picked here (0.27.2+) is deliberate, so new setups
    // borrow from it; a `broker` without it is a legacy lender (see `usable_for_new`).
    let choice = |machine_id: &Option<MachineId>| match machine_id {
        Some(id) => json!({ "machine_id": id, "via": via }),
        None => json!({}),
    };
    if old == params.machine_id {
        // Picking the current lender again by hand makes a legacy one deliberate.
        // A fresh choice every time, also when it is recorded already: the lender turns Logins on again when it was
        // turned off before this choice (`allow_logins_after_choice`).
        if old.is_some() {
            let op = membership.set(CHOICE_REGISTER, choice(&old)).map_err(|error| RpcError::new(codes::CONFLICT, error.to_string()))?;
            network.publish_ops(vec![op]);
            network.wake();
        }
        return Ok(LoginBrokerSetResult { status: broker.status(state).await, ..Default::default() });
    }
    // The new broker must be able to lend something, or every member would lose its sign-in.
    if let Some(target) = &params.machine_id {
        if !membership.projection().is_member(target) {
            return Err(RpcError::not_found("machine"));
        }
        let name = broker.member_name(target);
        let lendable = if *target == me {
            broker.lendable(state).await
        } else {
            let offline = || {
                let message = format!("{name} did not answer. Bring it online, then share its sign-ins.");
                RpcError::new(codes::NOT_AVAILABLE, message.clone())
                    .with_problem(&Problem::new(ProblemKind::Offline, message).with_subject(name.clone()))
            };
            let value = tokio::time::timeout(STATUS_WAIT, broker.hub.call(target, PeerLoginStatusMethod::NAME, Value::Null))
                .await
                .map_err(|_| offline())?
                .map_err(|failure| match failure {
                    CallFailure::Remote(error) if error.code == codes::METHOD_NOT_FOUND => {
                        let message = format!("{name} needs a newer Kybern to share its sign-ins. Update it from Settings → Machines.");
                        RpcError::new(codes::NOT_AVAILABLE, message.clone()).with_problem(&Problem::new(ProblemKind::UpdateNeeded, message))
                    }
                    CallFailure::Offline(_) | CallFailure::Gone(_) => offline(),
                    other => RpcError::new(codes::NOT_AVAILABLE, other.to_string()),
                })?;
            serde_json::from_value::<PeerLoginStatus>(value).map(|status| status.lendable).unwrap_or_default()
        };
        if lendable.is_empty() {
            return Err(RpcError::new(
                codes::NOT_AVAILABLE,
                format!("{name} is not signed in to anything it could share. Sign in on {name} first, then share its sign-ins."),
            ));
        }
    }
    let op = membership
        .set("broker", params.machine_id.clone().map_or(Value::String(String::new()), Value::String))
        .map_err(|error| RpcError::new(codes::CONFLICT, error.to_string()))?;
    let chosen =
        membership.set(CHOICE_REGISTER, choice(&params.machine_id)).map_err(|error| RpcError::new(codes::CONFLICT, error.to_string()))?;
    network.publish_ops(vec![op, chosen]);
    network.wake();

    let mut result = LoginBrokerSetResult::default();
    let members: Vec<String> = broker.hub.members().into_iter().filter(|member| !member.is_self).map(|member| member.id).collect();
    // This machine re-borrows at once; the others do the same within a tick of hearing the register.
    broker.rebind_borrowers(state).await;
    let deadline = tokio::time::Instant::now() + REBIND_WAIT;
    let mut pending: Vec<String> = Vec::new();
    for id in &members {
        match broker.hub.target(id) {
            Some(target) if target.online && !target.paused => pending.push(id.clone()),
            _ => result.offline.push(id.clone()),
        }
    }
    while !pending.is_empty() && tokio::time::Instant::now() < deadline {
        let mut still = Vec::new();
        for id in pending {
            let rebound = match tokio::time::timeout(STATUS_WAIT, broker.hub.call(&id, PeerLoginStatusMethod::NAME, Value::Null)).await {
                Ok(Ok(value)) => serde_json::from_value::<PeerLoginStatus>(value)
                    .map(|status| status.broker == params.machine_id && old.as_ref().is_none_or(|old| !status.borrowed_from.contains(old)))
                    .unwrap_or(false),
                // A member that does not know the broker (an older Kybern) has nothing to move.
                Ok(Err(CallFailure::Remote(error))) if error.code == codes::METHOD_NOT_FOUND => true,
                _ => false,
            };
            if rebound {
                result.rebound.push(id);
            } else {
                still.push(id);
            }
        }
        pending = still;
        if !pending.is_empty() {
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }
    result.offline.extend(pending);

    if let Some(old) = old.filter(|old| params.sign_out_old && Some(old.as_str()) != params.machine_id.as_deref()) {
        // The old broker signs out only after the others re-borrowed, and only once it has heard of the move itself.
        let heard = old == me || result.rebound.contains(&old);
        if !heard {
            result.note = Some("The old machine kept its sign-ins: it was offline, or had not heard of the change yet.".into());
        } else if result.rebound.is_empty() && members.iter().any(|id| *id != old) && !result.offline.is_empty() {
            result.note = Some("The old machine kept its sign-ins because no machine had borrowed from the new one yet.".into());
        } else if old == me {
            let released = broker.serve_release_all(state, PeerLoginReleaseAllParams { sign_out: true }).await;
            result.old_signed_out = released.signed_out;
        } else {
            match broker.hub.call(&old, PeerLoginReleaseAll::NAME, json!({ "sign_out": true })).await {
                Ok(value) => {
                    result.old_signed_out =
                        serde_json::from_value::<PeerLoginReleaseAllResult>(value).map(|released| released.signed_out).unwrap_or_default();
                }
                Err(failure) => result.note = Some(format!("The old machine was not asked to sign out: {failure}")),
            }
        }
    }
    result.status = broker.status(state).await;
    Ok(result)
}

// ---- pushed keys ----

/// The environment variable a pushed provider key belongs to: `provider.<kind>.<ENV>` where `ENV` is one
/// of the harness' credential variables. Nothing else is accepted, so a push cannot set `LD_PRELOAD`.
pub fn pushed_env_target(name: &str) -> Option<(ProviderKind, String)> {
    let rest = name.strip_prefix("provider.")?;
    ProviderKind::ALL.into_iter().find_map(|kind| {
        let env = rest.strip_prefix(kind.as_str())?.strip_prefix('.')?;
        crate::provider_accounts::credential_keys(kind).contains(&env).then(|| (kind, env.to_string()))
    })
}

/// `peer.secrets.put` on the target: store the sealed value and wire its reference into the harness' env.
pub fn serve_secrets_put(state: &AppState, from: &str, params: PeerSecretsPutParams) -> Result<(), RpcError> {
    let membership = state.network.membership().ok_or_else(|| RpcError::new(codes::NOT_AVAILABLE, "no network"))?;
    let store = crate::secret_store::store_of(state)
        .map_err(|error| RpcError::new(codes::NOT_AVAILABLE, format!("This machine's secret store is not available: {error:#}")))?;
    let this = membership.machine_id();
    let sealed = crate::secret_store::SealedSecret { name: params.name.clone(), sealed: params.sealed };
    store.put_sealed(&membership.keys(), &sealed, from, &this).map_err(|error| RpcError::invalid_params(format!("{error:#}")))?;
    if let Some((kind, env)) = pushed_env_target(&params.name) {
        let mut settings = state.settings.get();
        settings.providers.entry(kind).or_default().env.insert(env, crate::secret_store::reference(&params.name));
        state.settings.set(settings).map_err(RpcError::internal)?;
    }
    tracing::info!(target: TARGET, machine = from, "stored a pushed key");
    Ok(())
}

/// `secrets.push`: seal the stored value to each member and deliver it, or queue the sealed blob.
pub async fn push_secret(state: &AppState, params: SecretsPushParams) -> Result<SecretsPushResult, RpcError> {
    let hub = state
        .orchestrator
        .remote_hub()
        .cloned()
        .ok_or_else(|| RpcError::new(codes::NOT_AVAILABLE, "The machine network is unavailable on this machine."))?;
    let membership = state
        .network
        .membership()
        .ok_or_else(|| RpcError::new(codes::NOT_AVAILABLE, "The machine network is unavailable on this machine."))?;
    let store = crate::secret_store::store_of(state)
        .map_err(|error| RpcError::new(codes::NOT_AVAILABLE, format!("This machine's secret store is not available: {error:#}")))?;
    if !store.contains(&params.name).map_err(RpcError::internal)? {
        return Err(RpcError::not_found("secret"));
    }
    let me = membership.machine_id();
    let projection = membership.projection();
    let members: Vec<MemberView> = hub.members().into_iter().filter(|member| !member.is_self).collect();
    let chosen: Vec<MemberView> = if params.machines.is_empty() {
        members
    } else {
        let mut chosen = Vec::new();
        for query in &params.machines {
            let target = hub.resolve(query).map_err(|reason| RpcError::new(codes::NOT_FOUND, reason))?;
            if let Some(member) = members.iter().find(|member| member.id == target.id)
                && !chosen.iter().any(|known: &MemberView| known.id == member.id)
            {
                chosen.push(member.clone());
            }
        }
        chosen
    };
    let mut result = SecretsPushResult::default();
    for member in chosen {
        let row =
            |state, detail: Option<String>| SecretsPushMachine { machine_id: member.id.clone(), name: member.name.clone(), state, detail };
        if !member.features.is_empty() && !member.features.iter().any(|feature| feature == features::SECRETS_STORE_V1) {
            result
                .machines
                .push(row(SecretsPushState::Refused, Some(format!("{} needs a newer Kybern to take pushed keys.", member.name))));
            continue;
        }
        let Some(entry) = projection.entry(&member.id).filter(|entry| entry.removed.is_none()) else { continue };
        let sealed = store
            .seal_for_machine(&params.name, &entry.descriptor.sealing_key, &me, &member.id)
            .map_err(|error| RpcError::internal(format!("{error:#}")))?;
        let put = PeerSecretsPutParams { name: sealed.name, sealed: sealed.sealed };
        let payload = serde_json::to_value(&put).map_err(RpcError::internal)?;
        match hub.call(&member.id, PeerSecretsPut::NAME, payload.clone()).await {
            Ok(_) => result.machines.push(row(SecretsPushState::Delivered, None)),
            Err(CallFailure::Remote(error)) if error.code != codes::INTERNAL_ERROR && error.code != codes::THREAD_BUSY => {
                result.machines.push(row(SecretsPushState::Refused, Some(error.message)));
            }
            Err(_) => {
                // Offline (or briefly busy): the sealed blob waits in the outbox. The value is not in it in the clear.
                crate::network::outbox::enqueue(
                    state,
                    OutboxEnqueueParams {
                        target: member.id.clone(),
                        operation: OutboxOp { kind: OutboxKind::SecretsPut, payload, operation_id: None },
                    },
                )?;
                result.machines.push(row(SecretsPushState::Queued, None));
            }
        }
    }
    Ok(result)
}

/// The outbox worker's delivery of a queued `secrets_put`.
pub async fn deliver_secrets_put(state: &AppState, item: &OutboxItem) -> crate::orchestrator::remote_delegation::Delivery {
    use crate::orchestrator::remote_delegation::Delivery;
    let Some(hub) = state.orchestrator.remote_hub().cloned() else {
        return Delivery::Failed("This daemon cannot reach other machines.".into());
    };
    if serde_json::from_value::<PeerSecretsPutParams>(item.payload.clone()).is_err() {
        return Delivery::Failed("The queued key is unreadable.".into());
    }
    match hub.call(&item.target, PeerSecretsPut::NAME, item.payload.clone()).await {
        Ok(value) => Delivery::Delivered(value),
        Err(CallFailure::Offline(reason)) => Delivery::Retry(reason),
        Err(CallFailure::Gone(reason)) => Delivery::Failed(reason),
        Err(CallFailure::Remote(error)) => match error.code {
            codes::METHOD_NOT_FOUND => {
                Delivery::Retry("That machine needs a newer Kybern to take pushed keys. Update it from Settings → Machines.".into())
            }
            codes::INTERNAL_ERROR | codes::THREAD_BUSY | codes::NOT_AVAILABLE => Delivery::Retry(error.message),
            _ => Delivery::Failed(error.message),
        },
    }
}

// ---- rings for a bound account ----

#[async_trait]
impl crate::usage::BoundUsage for LoginBroker {
    /// A bound account has no login of its own to read: the broker reads the plan limits and this asks for them.
    async fn read(
        &self,
        kind: ProviderKind,
        instance: &str,
    ) -> Option<Result<ProviderLimits, kybern_drivers::claude::UsageUnread>> {
        let account = self.binding(kind, instance)?;
        let unread = |detail: String| kybern_drivers::claude::UsageUnread { reason: LimitsStale::Unavailable, retry_at: None, detail };
        let Some(broker_id) = self.broker_id().filter(|id| *id != self.self_id()) else {
            return Some(Err(unread("no machine shares its sign-ins".into())));
        };
        let params = serde_json::to_value(PeerLoginUsageParams { provider: kind, account: account.clone() }).unwrap_or_default();
        let value = match self.hub.call(&broker_id, PeerLoginUsage::NAME, params).await {
            Ok(value) => value,
            Err(failure) => return Some(Err(unread(failure.to_string()))),
        };
        let Ok(result) = serde_json::from_value::<UsageLimitsResult>(value) else { return Some(Err(unread("unreadable answer".into()))) };
        Some(match lent_entry(result, kind, &account) {
            Some(entry) if !entry.limits.is_empty() => Ok(entry),
            _ => Err(unread("the machine that shares this sign-in has no limits for this account yet".into())),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contexts_bind_loan_machines_and_harness() {
        let a = login_context("loan", "broker", "me", ProviderKind::ClaudeCode);
        assert_ne!(a, login_context("loan2", "broker", "me", ProviderKind::ClaudeCode));
        assert_ne!(a, login_context("loan", "other", "me", ProviderKind::ClaudeCode));
        assert_ne!(a, login_context("loan", "broker", "you", ProviderKind::ClaudeCode));
        assert_ne!(a, login_context("loan", "broker", "me", ProviderKind::Codex));
    }

    #[test]
    fn broker_errors_read_as_sentences_a_person_acts_on() {
        let offline = BrokerError::Offline("VPS".into());
        assert_eq!(offline.message(ProviderKind::ClaudeCode), "Claude Code signs in through VPS, which is offline · Sign in here instead");
        assert_eq!(offline.state(), BrokerLoginState::BrokerOffline);
        assert!(BrokerError::NoBroker.message(ProviderKind::Codex).contains("Choose a machine to share them"));
        assert!(BrokerError::Unsupported("VPS".into()).message(ProviderKind::Codex).contains("Update it"));
        assert_eq!(
            BrokerError::NotSignedIn("Claude is not signed in on VPS. Sign in on VPS first.".into()).state(),
            BrokerLoginState::BrokerNotSignedIn
        );
    }

    #[test]
    fn a_legacy_lender_is_usable_for_new_setups_only_while_it_is_always_on() {
        // Chosen by hand or through the always-on offer: always usable, whatever its week looked like.
        assert_eq!(usable_for_new("MacBook", Some(LenderVia::Manual), Some(0.2), false), (true, None));
        assert_eq!(usable_for_new("MacBook", Some(LenderVia::AlwaysOn), None, false), (true, None));
        // Legacy and always on: still usable.
        assert_eq!(usable_for_new("vps", None, Some(0.95), false), (true, None));
        // Legacy, a laptop that sleeps, or not seen long enough: not for new setups, and the reason says so.
        let (usable, reason) = usable_for_new("MacBook", None, Some(0.4), false);
        assert!(!usable);
        let reason = reason.unwrap();
        assert!(reason.starts_with("MacBook shared its sign-ins before Kybern 0.27.2, and it isn't always on"), "{reason}");
        assert!(!reason.contains("broker") && reason.len() < 240, "{reason}");
        let (usable, reason) = usable_for_new("MacBook", None, None, false);
        assert!(!usable && reason.unwrap().contains("can't tell yet whether it stays on"));
        // This machine lending to itself is never refused here.
        assert_eq!(usable_for_new("pc", None, None, true), (true, None));
    }

    #[test]
    fn a_lenders_refusal_reads_as_which_refusal_it_was() {
        let parties = || Parties { lender: "kdi-vps".into(), here: "MacBook".into() };
        let with = |code, message: &str, subject: Option<&str>| {
            let error = RpcError::new(code, message);
            match subject {
                Some(subject) => error.with_problem(&Problem::new(ProblemKind::Permission, message).with_subject(subject)),
                None => error,
            }
        };
        assert_eq!(
            refusal_of(&with(codes::FORBIDDEN, "missing scope: machine:logins", None), "kdi-vps", parties, false),
            BrokerError::Refused(parties())
        );
        assert_eq!(refusal_of(&with(codes::FORBIDDEN, "x", Some(LOGINS_OFF)), "kdi-vps", parties, false), BrokerError::Refused(parties()));
        assert_eq!(
            refusal_of(&with(codes::FORBIDDEN, "missing scope: machine:logins", None), "kdi-vps", parties, true),
            BrokerError::Paused(parties())
        );
        // Older lenders: a machine they don't know, and "not the broker".
        assert_eq!(
            refusal_of(&with(codes::FORBIDDEN, "missing scope: machine:peer", None), "kdi-vps", parties, false),
            BrokerError::UnknownMachine(parties())
        );
        assert_eq!(
            refusal_of(&with(codes::NOT_AVAILABLE, "This machine is not the login broker.", None), "kdi-vps", parties, false),
            BrokerError::NotLender(parties())
        );
        // Newer lenders name it.
        assert_eq!(
            refusal_of(&with(codes::NOT_AVAILABLE, "kdi-vps no longer …", Some(NOT_LENDER)), "kdi-vps", parties, false),
            BrokerError::NotLender(parties())
        );
        assert_eq!(
            refusal_of(&with(codes::NOT_FOUND, "…", Some(UNKNOWN_MACHINE)), "kdi-vps", parties, false),
            BrokerError::UnknownMachine(parties())
        );
        assert_eq!(
            refusal_of(&with(codes::METHOD_NOT_FOUND, "method not found: peer.login.borrow", None), "kdi-vps", parties, false),
            BrokerError::Unsupported("kdi-vps".into())
        );
        assert_eq!(
            refusal_of(
                &with(codes::NOT_AVAILABLE, "Claude is not signed in on kdi-vps. Sign in on kdi-vps first.", None),
                "kdi-vps",
                parties,
                false
            ),
            BrokerError::NotSignedIn("Claude is not signed in on kdi-vps. Sign in on kdi-vps first.".into())
        );
    }

    #[test]
    fn a_failed_borrow_names_both_machines_and_offers_signing_in_here() {
        let here = Borrower { machine_id: "m-mac".into(), name: "MacBook".into(), instance: Some("a1".into()) };
        let refused = BrokerError::Refused(Parties { lender: "kdi-vps".into(), here: "MacBook".into() });
        assert_eq!(
            refused.message(ProviderKind::ClaudeCode),
            "kdi-vps doesn't let other machines use its sign-ins. Choose Share this machine’s sign-ins for kdi-vps in Settings → Accounts, or sign in on MacBook instead."
        );
        let error = refused.rpc_error(ProviderKind::ClaudeCode, &here);
        assert_eq!(error.code, codes::FORBIDDEN);
        let problem = error.problem().unwrap();
        assert_eq!((problem.kind, problem.subject.as_deref()), (ProblemKind::Permission, Some(LOGIN_BORROW_SUBJECT)));
        assert_eq!(problem.title.as_deref(), Some("Couldn't use kdi-vps's sign-in"));
        assert_eq!(problem.hint.as_deref(), Some(error.message.as_str()));
        let action = problem.action.unwrap();
        assert_eq!((action.id.as_str(), action.label.as_str()), (SIGN_IN_HERE_ACTION, "Sign in on MacBook instead"));
        assert_eq!(action.params.unwrap(), json!({ "machine_id": "m-mac", "provider": "claude-code", "instance": "a1" }));
        // Offline is retried; it doesn't undo a bind.
        let offline = BrokerError::Offline("kdi-vps".into());
        assert_eq!(offline.problem(ProviderKind::Codex, &here).secondary.map(|action| action.id), Some("retry".into()));
        assert!(!offline.refuses_binding() && refused.refuses_binding());
        // No sentence on this path says "broker".
        let parties = Parties { lender: "kdi-vps".into(), here: "MacBook".into() };
        for error in [
            BrokerError::NoBroker,
            BrokerError::IsSelf,
            BrokerError::Offline("kdi-vps".into()),
            BrokerError::Unsupported("kdi-vps".into()),
            BrokerError::Refused(parties.clone()),
            BrokerError::Paused(parties.clone()),
            BrokerError::NotLender(parties.clone()),
            BrokerError::UnknownMachine(parties.clone()),
            BrokerError::WrongAccount { parties: parties.clone(), email: "me@example.com".into() },
            BrokerError::Unmatched { parties: parties.clone(), email: Some("me@example.com".into()) },
            BrokerError::Unmatched { parties, email: None },
            BrokerError::Left,
        ] {
            let message = error.message(ProviderKind::ClaudeCode);
            assert!(!message.to_lowercase().contains("broker"), "{message}");
            // Settings → Machines has no sign-in sharing controls: sharing is chosen on the Accounts page.
            assert!(!message.contains("Settings → Machines"), "{message}");
        }
        for error in [BrokerError::NoBroker, refused.clone(), BrokerError::NotLender(Parties { lender: "kdi-vps".into(), here: "MacBook".into() })] {
            assert!(error.message(ProviderKind::ClaudeCode).contains("Settings → Accounts"), "{:?}", error);
        }
        assert!(BrokerError::NoBroker.message(ProviderKind::ClaudeCode).contains("Share this machine’s sign-ins"));
    }

    #[test]
    fn only_the_lent_accounts_limits_leave_the_lender_and_never_another_accounts() {
        let entry = |instance: Option<&str>, used: f64| ProviderLimits {
            provider: ProviderKind::ClaudeCode,
            limits: vec![UsageLimit { name: "5-hour".into(), used_percent: used, window_minutes: Some(300), resets_at: None }],
            updated_at: None,
            source: None,
            plan: None,
            stale: None,
            retry_at: None,
            instance: instance.map(str::to_string),
        };
        let all = || UsageLimitsResult {
            providers: vec![entry(None, 90.0)],
            refreshing: vec![],
            accounts: vec![entry(Some("other"), 50.0), entry(Some("lent"), 10.0)],
        };
        let instance = |id: &str| ProviderInstance { kind: ProviderKind::ClaudeCode, instance: id.into() };
        let out = lent_usage(all(), &instance("lent"), "default");
        assert!(out.providers.is_empty());
        let shown: Vec<(Option<String>, f64)> = out.accounts.iter().map(|e| (e.instance.clone(), e.limits[0].used_percent)).collect();
        assert_eq!(shown, vec![(Some("lent".into()), 10.0)]);
        // The global entry is the lender's default account: it leaves only when that is the lent one.
        let no_accounts = || UsageLimitsResult { accounts: vec![], ..all() };
        assert!(lent_usage(no_accounts(), &instance("default"), "other").accounts.is_empty());
        assert_eq!(lent_usage(no_accounts(), &instance("default"), "default").accounts[0].instance.as_deref(), Some("default"));
        // The borrower takes the lent account's own entry, or nothing.
        assert!(lent_entry(no_accounts(), ProviderKind::ClaudeCode, "lent").is_none());
        assert!(lent_entry(all(), ProviderKind::Codex, "lent").is_none());
        assert_eq!(lent_entry(all(), ProviderKind::ClaudeCode, "lent").unwrap().limits[0].used_percent, 10.0);
    }

    #[test]
    fn a_retry_asks_the_lender_again_unless_it_was_only_offline() {
        let held = |error: BrokerError, expires_in_ms: i64| LeaseState {
            login: Some(BorrowedLogin::Claude { access_token: "t".into(), expires_at_ms: None }),
            expires_at: Utc.timestamp_millis_opt(Utc::now().timestamp_millis() + expires_in_ms).single(),
            last_error: Some(error),
            ..Default::default()
        };
        assert!(!renew_on_retry(&held(BrokerError::Offline("vps".into()), 3_600_000)), "a valid held token keeps working");
        assert!(renew_on_retry(&held(BrokerError::Offline("vps".into()), 10_000)), "a dying one is renewed");
        let parties = Parties { lender: "vps".into(), here: "pc".into() };
        assert!(renew_on_retry(&held(BrokerError::Refused(parties), 3_600_000)), "a refusal is asked again");
        assert!(renew_on_retry(&LeaseState::default()));
    }

    #[test]
    fn the_choice_counts_only_for_the_lender_it_names() {
        let mut projection = super::super::ops::Projection::default();
        let register = |value: Value| super::super::ops::Register { value, lamport: 1, signer: "m1".into(), op_id: "op".into() };
        assert_eq!(chosen_in(&projection, "vps"), None);
        projection.registers.insert(CHOICE_REGISTER.into(), register(json!({ "machine_id": "vps", "via": "always_on" })));
        assert_eq!(chosen_in(&projection, "vps"), Some(LenderVia::AlwaysOn));
        assert_eq!(chosen_in(&projection, "mac"), None, "a choice of another machine is not this lender's");
        projection.registers.insert(CHOICE_REGISTER.into(), register(json!({})));
        assert_eq!(chosen_in(&projection, "vps"), None);
    }

    #[test]
    fn only_a_harness_credential_variable_can_be_wired_by_a_push() {
        assert_eq!(pushed_env_target("provider.cursor.CURSOR_API_KEY"), Some((ProviderKind::Cursor, "CURSOR_API_KEY".into())));
        assert_eq!(pushed_env_target("provider.opencode.OPENAI_API_KEY"), Some((ProviderKind::Opencode, "OPENAI_API_KEY".into())));
        assert_eq!(pushed_env_target("provider.pi.LD_PRELOAD"), None);
        assert_eq!(pushed_env_target("provider.cursor.OPENAI_API_KEY"), None);
        assert_eq!(pushed_env_target("notes.token"), None);
    }

    #[test]
    fn a_rotation_is_a_changed_fingerprint_and_a_first_sight_is_not() {
        assert_ne!(fingerprint("old"), fingerprint("new"));
        assert_eq!(fingerprint("same"), fingerprint("same"));
    }
}
