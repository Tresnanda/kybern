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
/// A Claude login within this long of expiring is refreshed (by Claude itself) while it has borrowers.
const REFRESH_AHEAD_MS: i64 = 5 * 60 * 1000;
/// A borrow never hands out a token that is about to die: below this, Claude refreshes first.
const HARD_EXPIRY_MS: i64 = 60 * 1000;
/// How long a move waits for the online members to re-borrow from the new broker.
const REBIND_WAIT: Duration = Duration::from_secs(45);
/// How long a member gets to answer `peer.login.status`.
const STATUS_WAIT: Duration = Duration::from_secs(5);
/// The port `omp auth-broker serve` listens on, on the broker's tailnet address.
const OMP_BROKER_PORT: u16 = 7878;

fn binding_key(kind: ProviderKind, instance: &str) -> String {
    format!("login_broker:bind:{}:{instance}", kind.as_str())
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
        _ => None,
    }
}

// ---- why a borrow did not work ----

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
    /// The broker refused (`machine:logins` is off for this machine).
    Refused(String),
    /// This machine is not in a network now: it was removed, or the network is turned off here.
    Left,
    Failed(String),
}

impl BrokerError {
    /// The state a client shows for this error.
    pub fn state(&self) -> BrokerLoginState {
        match self {
            BrokerError::Offline(_) => BrokerLoginState::BrokerOffline,
            BrokerError::NotSignedIn(_) => BrokerLoginState::BrokerNotSignedIn,
            BrokerError::Unsupported(_) => BrokerLoginState::BrokerUnsupported,
            _ => BrokerLoginState::BrokerOffline,
        }
    }

    pub fn message(&self, kind: ProviderKind) -> String {
        let harness = kind.display_name();
        match self {
            BrokerError::NoBroker => format!(
                "{harness} signs in through a login broker, but no machine is set as one. Choose one in Settings → Machines, or sign in here."
            ),
            BrokerError::IsSelf => format!("This machine is the login broker. Sign in to {harness} here."),
            BrokerError::Offline(name) => format!("{harness} signs in through {name}, which is offline · Sign in here instead"),
            BrokerError::NotSignedIn(detail) => detail.clone(),
            BrokerError::Unsupported(name) => {
                format!("{name} needs a newer Kybern to share its {harness} sign-in. Update it from Settings → Machines.")
            }
            BrokerError::Refused(name) => format!(
                "{name} does not let this machine borrow its logins. Turn Logins on for this machine in Settings → Machines on {name}."
            ),
            BrokerError::Left => format!(
                "This machine is not connected to your other machines, so {harness} cannot sign in through the login broker. Sign in here instead."
            ),
            BrokerError::Failed(reason) => reason.clone(),
        }
    }
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
        if let Some(login) = lock(&self.lease.state).login.clone() {
            return Ok(login);
        }
        self.broker.borrow(&self.lease, false).await.map_err(|error| error.message(self.lease.kind))
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
    leases: Mutex<HashMap<LeaseKey, Arc<Lease>>>,
    /// Turns that already had one automatic recovery.
    recovered: Mutex<HashSet<Uuid>>,
    /// The broker refreshes one Claude login at a time.
    refresh_gate: tokio::sync::Mutex<()>,
    /// Fingerprint of the access token last seen per lent account, to notice a rotation.
    seen: Mutex<HashMap<(ProviderKind, String), [u8; 32]>>,
    /// The `omp auth-broker serve` this machine runs, once started.
    omp: tokio::sync::Mutex<Option<tokio::process::Child>>,
}

impl LoginBroker {
    pub fn new(hub: Arc<dyn RemoteHub>, network: Arc<Network>, store: Store) -> Arc<Self> {
        Arc::new(Self {
            hub,
            network,
            store,
            leases: Mutex::new(HashMap::new()),
            recovered: Mutex::new(HashSet::new()),
            refresh_gate: tokio::sync::Mutex::new(()),
            seen: Mutex::new(HashMap::new()),
            omp: tokio::sync::Mutex::new(None),
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
            .unwrap_or_else(|| "the login broker".into())
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
        if !self.in_network() {
            return Err(BrokerError::Left.message(kind));
        }
        let lease = self.lease_for(kind, instance, account);
        let held = lock(&lease.state).login.is_some();
        if !held {
            self.borrow(&lease, false).await.map_err(|error| error.message(kind))?;
        }
        Ok(Arc::new(LeaseSource { broker: self.clone(), lease }))
    }

    /// Ask the broker for the lease's login (`peer.login.borrow`) and keep it in memory.
    async fn borrow(&self, lease: &Lease, renewing: bool) -> Result<BorrowedLogin, BrokerError> {
        let _gate = lease.gate.lock().await;
        // Another session may have borrowed while this one waited; a renewal still goes to the broker.
        if !renewing && let Some(login) = lock(&lease.state).login.clone() {
            return Ok(login);
        }
        let result = self.borrow_from_broker(lease).await;
        match &result {
            Ok(_) => lock(&lease.state).last_error = None,
            Err(error) => lock(&lease.state).last_error = Some(error.clone()),
        }
        result
    }

    async fn borrow_from_broker(&self, lease: &Lease) -> Result<BorrowedLogin, BrokerError> {
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
        };
        let params = PeerLoginBorrowParams { provider: lease.kind, account: lease.account.clone(), loan_id: previous };
        let value = self.hub.call(&broker_id, PeerLoginBorrow::NAME, serde_json::to_value(&params).unwrap_or_default()).await.map_err(
            |failure| match failure {
                CallFailure::Offline(_) | CallFailure::Gone(_) => BrokerError::Offline(name.clone()),
                CallFailure::Remote(error) => match error.code {
                    codes::METHOD_NOT_FOUND => BrokerError::Unsupported(name.clone()),
                    codes::FORBIDDEN => BrokerError::Refused(name.clone()),
                    codes::NOT_AVAILABLE => BrokerError::NotSignedIn(error.message),
                    _ => BrokerError::Failed(error.message),
                },
            },
        )?;
        let result: PeerLoginBorrowResult = serde_json::from_value(value)
            .map_err(|_| BrokerError::Failed("The login broker answered with something unreadable.".into()))?;
        let membership = self.network.membership().ok_or(BrokerError::NoBroker)?;
        let login = open_login(&membership.keys(), &login_context(&result.loan_id, &broker_id, &me, lease.kind), &result.sealed)
            .map_err(|error| BrokerError::Failed(format!("The lent login could not be opened: {error:#}")))?;
        let generation = {
            let mut state = lock(&lease.state);
            let generation = if state.loan_id.as_deref() == Some(result.loan_id.as_str()) { 1 } else { 0 } + 1;
            state.broker = broker_id.clone();
            state.loan_id = Some(result.loan_id.clone());
            state.login = Some(login.clone());
            state.expires_at = result.expires_at;
            generation
        };
        let row = LoanRow {
            loan_id: result.loan_id,
            role: LoanRole::Borrower,
            peer: broker_id,
            provider: lease.kind,
            account: lease.account.clone(),
            local_instance: Some(lease.instance.clone()),
            generation,
            expires_at: result.expires_at,
            last_pushed_at: None,
            last_error: None,
            created_at: Utc::now(),
        };
        if let Err(error) = self.store.loan_open(&row) {
            tracing::warn!(target: TARGET, %error, "could not record a borrowed login");
        }
        Ok(login)
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
                state.login = Some(login);
                state.expires_at = params.expires_at;
                state.last_error = None;
            }
        }
        let _ = self.store.loan_pushed(&params.loan_id, Utc::now(), params.expires_at, None);
        Ok((params.provider, instance))
    }

    /// The borrower's view of an account that signs in through the broker.
    pub fn account_view(&self, kind: ProviderKind, instance: &str) -> Option<AccountBroker> {
        let account = self.binding(kind, instance)?;
        let broker_id = self.broker_id();
        let (machine_id, machine_name) = match &broker_id {
            Some(id) => (id.clone(), self.member_name(id)),
            None => (String::new(), "the login broker".into()),
        };
        let lease = lock(&self.leases).get(&(kind, instance.to_string())).cloned();
        let error = lease.as_ref().and_then(|lease| lock(&lease.state).last_error.clone());
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

    /// Borrow again now (the lent token was rejected): the broker may have rotated before its push arrived.
    pub async fn renew(&self, kind: ProviderKind, instance: &str, account: &str) -> Result<(), String> {
        let lease = self.lease_for(kind, instance, account);
        self.borrow(&lease, true).await.map(|_| ()).map_err(|error| error.message(kind))
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

    fn ensure_broker(&self) -> Result<(), RpcError> {
        if self.broker_id().as_deref() == Some(self.self_id().as_str()) {
            Ok(())
        } else {
            Err(RpcError::new(codes::NOT_AVAILABLE, "This machine is not the login broker."))
        }
    }

    /// Read (and when it is about to die, refresh) the login of one of this machine's accounts.
    async fn lend(&self, state: &AppState, kind: ProviderKind, account: &str) -> Result<(BorrowedLogin, Option<String>), RpcError> {
        if self.binding(kind, account).is_some() {
            return Err(RpcError::new(codes::NOT_AVAILABLE, "That account signs in through a broker itself and cannot be lent on."));
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
                let env = crate::provider_accounts::environment(
                    &state.settings.get().providers.get(&kind).cloned().unwrap_or_default(),
                    kind,
                    account,
                )
                .map_err(|error| unavailable(error.to_string()))?;
                let stored = login_lend::read_codex(&env).map_err(|reason| unavailable(format!("{reason} ({name})")))?;
                if stored.expires_at.is_some_and(|exp| exp * 1000 < Utc::now().timestamp_millis() + HARD_EXPIRY_MS) {
                    return Err(unavailable(format!(
                        "Codex's login on {name} has expired. Use Codex on {name} once so it renews, then try again."
                    )));
                }
                let plan = login_lend::codex_plan_label(stored.plan_type.as_deref());
                Ok((
                    BorrowedLogin::Codex {
                        access_token: stored.access_token,
                        account_id: stored.account_id,
                        plan_type: stored.plan_type,
                        id_token: stored.id_token,
                    },
                    plan,
                ))
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
            .ok_or_else(|| RpcError::forbidden("machine:peer"))?;
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
        Ok(PeerLoginBorrowResult { loan_id, sealed, expires_at, email: None, plan })
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
        PeerLoginStatus { broker: self.broker_id(), is_broker, lendable: self.lendable(state).await, borrowed_from }
    }

    /// `peer.login.usage`: the plan limits the broker already reads for the account.
    pub async fn serve_usage(&self, state: &AppState, params: PeerLoginUsageParams) -> Result<UsageLimitsResult, RpcError> {
        self.ensure_broker()?;
        let instance = ProviderInstance { kind: params.provider, instance: params.account };
        let mut limits = state
            .orchestrator
            .usage()
            .limits(UsageLimitsParams { cached: true, instances: vec![instance.clone()], ..Default::default() })
            .await;
        // Only the lent account's windows leave this machine.
        limits.accounts.retain(|entry| entry.provider == instance.kind && entry.instance.as_deref() == Some(instance.instance.as_str()));
        if instance.instance == "default" {
            limits.providers.retain(|entry| entry.provider == instance.kind);
        } else {
            limits.providers.clear();
        }
        Ok(limits)
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
        if changed && kind == ProviderKind::ClaudeCode {
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

    /// One look at the lent Claude accounts: notice a rotation, and refresh a login that is about to expire.
    pub(crate) async fn watch_lent(&self, state: &AppState) {
        let mut accounts: Vec<(ProviderKind, String)> = Vec::new();
        for loan in self.store.loans_open(LoanRole::Lender).unwrap_or_default() {
            if loan.provider == ProviderKind::ClaudeCode && !accounts.contains(&(loan.provider, loan.account.clone())) {
                accounts.push((loan.provider, loan.account.clone()));
            }
        }
        for (kind, account) in accounts {
            let instance = ProviderInstance { kind, instance: account.clone() };
            let Ok(context) = crate::provider_accounts::context(state, &instance) else { continue };
            let Some(mut stored) = login_lend::read_claude(&context).await else { continue };
            if claude_expires_within(&stored, REFRESH_AHEAD_MS) {
                let _gate = self.refresh_gate.lock().await;
                if let Some(again) = login_lend::read_claude(&context).await {
                    stored = again;
                }
                if claude_expires_within(&stored, REFRESH_AHEAD_MS) {
                    match login_lend::refresh_claude(&context, context.binary.as_deref()).await {
                        Ok(()) => {
                            if let Some(again) = login_lend::read_claude(&context).await {
                                stored = again;
                            }
                        }
                        Err(reason) => tracing::warn!(target: TARGET, reason, "could not refresh the lent Claude login"),
                    }
                }
            }
            let login = BorrowedLogin::Claude { access_token: stored.access_token, expires_at_ms: stored.expires_at_ms };
            self.observe(state, kind, &account, &login).await;
        }
    }

    // ---- omp ----

    /// The URL and bearer token of the `omp auth-broker serve` this machine runs for the others.
    async fn omp_login(&self, state: &AppState) -> Result<BorrowedLogin, String> {
        let settings = state.settings.get();
        let provider = settings.providers.get(&ProviderKind::Omp).cloned().unwrap_or_default();
        let env = crate::provider_accounts::environment(&provider, ProviderKind::Omp, "default").map_err(|error| error.to_string())?;
        let binary = kybern_drivers::binary::resolve(ProviderKind::Omp, provider.binary.clone().map(std::path::PathBuf::from).as_ref())
            .map_err(|error| error.to_string())?;
        let status =
            self.network.tailscale.status().await.map_err(|_| "omp's broker needs Tailscale running on this machine.".to_string())?;
        let ip = status.self_node.as_ref().and_then(|node| node.ip()).ok_or("omp's broker needs a Tailscale address on this machine.")?;
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
                *running = Some(command.spawn().map_err(|error| format!("Could not start omp's login broker: {error}"))?);
            }
        }
        let mut command = {
            use kybern_protocol::process::NoWindow;
            tokio::process::Command::new(&binary).no_window()
        };
        command.args(["auth-broker", "token"]).envs(&env).stdin(std::process::Stdio::null());
        let output = tokio::time::timeout(Duration::from_secs(10), command.output())
            .await
            .map_err(|_| "omp did not print its broker token in time.".to_string())?
            .map_err(|error| error.to_string())?;
        let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !output.status.success() || token.is_empty() {
            return Err("omp's login broker has no token. Run `omp auth-broker login` on this machine first.".into());
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
        LoginBrokerStatus { broker, is_broker, providers, loans }
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
                "The CLI account keeps its own sign-in. Create a named account to sign in through the broker.",
            ));
        }
        let exists =
            state.settings.get().providers.get(&params.provider).is_some_and(|provider| provider.accounts.contains_key(&params.instance));
        if !exists {
            return Err(RpcError::not_found("account"));
        }
        if params.broker_account.is_some() && self.broker_id().is_none() {
            return Err(RpcError::new(codes::NOT_AVAILABLE, BrokerError::NoBroker.message(params.provider)));
        }
        self.set_binding(params.provider, &params.instance, params.broker_account.as_deref()).map_err(RpcError::internal)?;
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
                if crate::provider_accounts::sign_out(state, instance).await.is_ok() && !signed_out.contains(&kind) {
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
    async fn rebind_borrowers(&self, state: &AppState) {
        let current = self.broker_id();
        let me = self.self_id();
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
                // This machine became the broker: it signs in locally; the old loan only needs releasing.
                let _ = self.store.loan_release(&loan.loan_id);
                lock(&self.leases).remove(&(loan.provider, instance.clone()));
                state.orchestrator.end_login_sessions(loan.provider, &instance, false).await;
                continue;
            }
            if lendable.is_none() {
                lendable = Some(
                    match tokio::time::timeout(STATUS_WAIT, self.hub.call(&new_broker, PeerLoginStatusMethod::NAME, Value::Null)).await {
                        Ok(Ok(value)) => serde_json::from_value::<PeerLoginStatus>(value).map(|status| status.lendable).unwrap_or_default(),
                        // Not reachable yet: try again next look.
                        _ => continue,
                    },
                );
            }
            // The account ids differ per machine: keep the same one if the new broker has it, else its first of this harness.
            let offered: Vec<&LendableAccount> = lendable.iter().flatten().filter(|account| account.provider == loan.provider).collect();
            let account = offered
                .iter()
                .find(|account| account.account == loan.account)
                .or_else(|| offered.first())
                .map(|account| account.account.clone());
            let Some(account) = account else { continue };
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
    }
}

fn login_lend_supports(kind: ProviderKind) -> bool {
    broker_supports(kind)
}

fn claude_expires_within(stored: &login_lend::ClaudeStored, window_ms: i64) -> bool {
    stored.expires_at_ms.is_some_and(|expires| expires < Utc::now().timestamp_millis() + window_ms)
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
        if broker.broker_id().as_deref() == Some(broker.self_id().as_str()) {
            broker.watch_lent(&state).await;
        }
        broker.rebind_borrowers(&state).await;
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
    if old == params.machine_id {
        return Ok(LoginBrokerSetResult { status: broker.status(state).await, ..Default::default() });
    }
    // The new broker must be able to lend something, or every member would lose its sign-in.
    if let Some(target) = &params.machine_id {
        if !membership.projection().is_member(target) {
            return Err(RpcError::not_found("machine"));
        }
        let lendable = if *target == me {
            broker.lendable(state).await
        } else {
            let value = tokio::time::timeout(STATUS_WAIT, broker.hub.call(target, PeerLoginStatusMethod::NAME, Value::Null))
                .await
                .map_err(|_| {
                    RpcError::new(codes::NOT_AVAILABLE, "That machine did not answer. Bring it online, then move the login broker.")
                })?
                .map_err(|failure| match failure {
                    CallFailure::Remote(error) if error.code == codes::METHOD_NOT_FOUND => RpcError::new(
                        codes::NOT_AVAILABLE,
                        "That machine needs a newer Kybern to be the login broker. Update it from Settings → Machines.",
                    ),
                    other => RpcError::new(codes::NOT_AVAILABLE, other.to_string()),
                })?;
            serde_json::from_value::<PeerLoginStatus>(value).map(|status| status.lendable).unwrap_or_default()
        };
        if lendable.is_empty() {
            let name = broker.member_name(target);
            return Err(RpcError::new(
                codes::NOT_AVAILABLE,
                format!("{name} is not signed in to anything it could lend. Sign in on {name} first, then move the login broker."),
            ));
        }
    }
    let op = membership
        .set("broker", params.machine_id.clone().map_or(Value::String(String::new()), Value::String))
        .map_err(|error| RpcError::new(codes::CONFLICT, error.to_string()))?;
    network.publish_ops(vec![op]);
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
            result.note = Some("The old broker kept its sign-in: it was offline, or had not heard of the move yet.".into());
        } else if result.rebound.is_empty() && members.iter().any(|id| *id != old) && !result.offline.is_empty() {
            result.note = Some("The old broker kept its sign-in because no member had borrowed from the new one yet.".into());
        } else if old == me {
            let released = broker.serve_release_all(state, PeerLoginReleaseAllParams { sign_out: true }).await;
            result.old_signed_out = released.signed_out;
        } else {
            match broker.hub.call(&old, PeerLoginReleaseAll::NAME, json!({ "sign_out": true })).await {
                Ok(value) => {
                    result.old_signed_out =
                        serde_json::from_value::<PeerLoginReleaseAllResult>(value).map(|released| released.signed_out).unwrap_or_default();
                }
                Err(failure) => result.note = Some(format!("The old broker was not asked to sign out: {failure}")),
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
    ) -> Option<Result<(Vec<UsageLimit>, Option<String>), kybern_drivers::claude::UsageUnread>> {
        let account = self.binding(kind, instance)?;
        let unread = |detail: String| kybern_drivers::claude::UsageUnread { reason: LimitsStale::Unavailable, retry_at: None, detail };
        let Some(broker_id) = self.broker_id().filter(|id| *id != self.self_id()) else {
            return Some(Err(unread("no login broker".into())));
        };
        let params = serde_json::to_value(PeerLoginUsageParams { provider: kind, account: account.clone() }).unwrap_or_default();
        let value = match self.hub.call(&broker_id, PeerLoginUsage::NAME, params).await {
            Ok(value) => value,
            Err(failure) => return Some(Err(unread(failure.to_string()))),
        };
        let Ok(result) = serde_json::from_value::<UsageLimitsResult>(value) else { return Some(Err(unread("unreadable answer".into()))) };
        let entry = result
            .accounts
            .into_iter()
            .find(|entry| entry.instance.as_deref() == Some(account.as_str()))
            .or_else(|| result.providers.into_iter().next());
        Some(match entry {
            Some(entry) if !entry.limits.is_empty() => Ok((entry.limits, entry.plan)),
            _ => Err(unread("the login broker has no limits for this account yet".into())),
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
        assert!(BrokerError::NoBroker.message(ProviderKind::Codex).contains("Settings → Machines"));
        assert!(BrokerError::Unsupported("VPS".into()).message(ProviderKind::Codex).contains("Update it"));
        assert_eq!(
            BrokerError::NotSignedIn("Claude is not signed in on VPS. Sign in on VPS first.".into()).state(),
            BrokerLoginState::BrokerNotSignedIn
        );
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
