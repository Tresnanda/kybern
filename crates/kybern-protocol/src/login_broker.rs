//! The login broker and pushed keys (ADE-86 M5 / S4, design §9.3 and §9.4).
//!
//! **One sign-in, every machine.** The machine named by the `broker` register holds the real
//! accounts and is the only one that refreshes them. Another member that starts a session for a
//! broker-backed account **borrows** the login (`peer.login.borrow`): the broker seals the credential
//! to the borrower's sealing key and records a *loan*. The credential never reaches disk on the
//! borrower: Claude gets `CLAUDE_CODE_OAUTH_TOKEN`, Codex gets app-server external auth, omp gets the
//! URL and bearer token of `omp auth-broker serve`.
//!
//! What the login spike found decides the shape (`docs/research/login-broker-spike-2026-10-28.md`):
//!
//! * **Claude**: every refresh on the broker revokes every outstanding loan at once. The broker watches
//!   its own credential and, on each rotation, pushes the new token to every borrower
//!   (`peer.login.push`). A session that already failed re-borrows, resumes and re-sends.
//! * **Codex**: access tokens are 10-day JWTs that survive a broker refresh. A borrower answers the
//!   app-server's `account/chatgptAuthTokens/refresh` request by borrowing again.
//! * **omp**: it ships the broker. Kybern only moves its URL and token.
//!
//! Tokens are never stored by the store, logged, traced or returned to a client; only sealed blobs
//! cross the network and only the loan's bookkeeping is persisted.

use chrono::{DateTime, Utc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{MachineId, ProviderKind};

// ---- what is lent ----

/// A credential another machine lent. This is the plaintext inside the sealed box of
/// `peer.login.borrow` and `peer.login.push`; it has no `Debug` that prints the secret.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BorrowedLogin {
    /// A Claude Code OAuth access token (the refresh token never leaves the broker).
    Claude {
        access_token: String,
        /// Milliseconds since the epoch, as Claude Code stores it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expires_at_ms: Option<i64>,
    },
    /// A ChatGPT login for Codex's app-server external auth.
    Codex {
        access_token: String,
        /// The ChatGPT workspace/account id the token belongs to.
        account_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        plan_type: Option<String>,
        /// The id token, for file mode only (`refresh_token: ""`).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id_token: Option<String>,
    },
    /// The broker `omp auth-broker serve` runs on the Kybern broker.
    Omp { url: String, token: String },
}

impl std::fmt::Debug for BorrowedLogin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let kind = match self {
            BorrowedLogin::Claude { .. } => "claude",
            BorrowedLogin::Codex { .. } => "codex",
            BorrowedLogin::Omp { .. } => "omp",
        };
        write!(f, "BorrowedLogin::{kind}(..)")
    }
}

impl BorrowedLogin {
    pub fn provider(&self) -> ProviderKind {
        match self {
            BorrowedLogin::Claude { .. } => ProviderKind::ClaudeCode,
            BorrowedLogin::Codex { .. } => ProviderKind::Codex,
            BorrowedLogin::Omp { .. } => ProviderKind::Omp,
        }
    }
}

/// Which harnesses the broker can lend a login for.
pub fn broker_supports(kind: ProviderKind) -> bool {
    matches!(kind, ProviderKind::ClaudeCode | ProviderKind::Codex | ProviderKind::Omp)
}

// ---- peer methods ----

/// `peer.login.borrow`: a member asks the broker for the login of one of its accounts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PeerLoginBorrowParams {
    pub provider: ProviderKind,
    /// The broker's account instance (`default` or a named account's id).
    #[serde(default = "default_account")]
    pub account: String,
    /// The loan this renews, when the borrower holds one already.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loan_id: Option<String>,
}

pub fn default_account() -> String {
    "default".into()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PeerLoginBorrowResult {
    pub loan_id: String,
    /// Standard base64 of the sealed [`BorrowedLogin`] JSON.
    pub sealed: String,
    /// When the lent access token expires, when the harness says.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
}

/// `peer.login.push`: the broker's credential rotated; the new one for an open loan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PeerLoginPushParams {
    pub loan_id: String,
    pub provider: ProviderKind,
    pub sealed: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<DateTime<Utc>>,
}

/// `peer.login.release`: the borrower no longer needs the loan (its last session ended).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PeerLoginReleaseParams {
    pub loan_id: String,
}

/// One account a machine can lend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct LendableAccount {
    pub provider: ProviderKind,
    pub account: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
}

/// `peer.login.status`: what a member can lend, and whom it believes the broker is. The reply to a
/// member that is not the broker lists nothing.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PeerLoginStatus {
    /// This machine's `broker` register.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub broker: Option<MachineId>,
    /// This machine is the broker.
    #[serde(default)]
    pub is_broker: bool,
    #[serde(default)]
    pub lendable: Vec<LendableAccount>,
    /// Loans this machine holds as a borrower, so a move can tell when every member re-borrowed.
    #[serde(default)]
    pub borrowed_from: Vec<MachineId>,
}

/// `peer.login.release_all`: the broker was moved; drop every loan and optionally sign out.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PeerLoginReleaseAllParams {
    /// Run each lent harness's own sign-out. Only after every borrower re-borrowed elsewhere.
    #[serde(default)]
    pub sign_out: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PeerLoginReleaseAllResult {
    pub released: u32,
    pub signed_out: Vec<ProviderKind>,
}

/// `peer.login.usage`: plan limits the broker read for one of its accounts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PeerLoginUsageParams {
    pub provider: ProviderKind,
    #[serde(default = "default_account")]
    pub account: String,
}

// ---- pushed keys ----

/// `peer.secrets.put`: a key another member pushed, sealed to this machine's sealing key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PeerSecretsPutParams {
    pub name: String,
    /// Standard base64 of the sealed value (see `secret_store::SealedSecret`).
    pub sealed: String,
}

/// `secrets.push`: "Use on all machines" for a stored key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SecretsPushParams {
    /// The secret's name in the store (`provider.cursor.CURSOR_API_KEY`).
    pub name: String,
    /// Members to push to. Empty or absent means every other member.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub machines: Vec<MachineId>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SecretsPushState {
    /// The machine stored it.
    Delivered,
    /// The machine is offline; the sealed value waits in the outbox.
    Queued,
    /// The machine refused or does not support pushed keys.
    Refused,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SecretsPushMachine {
    pub machine_id: MachineId,
    pub name: String,
    pub state: SecretsPushState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SecretsPushResult {
    pub machines: Vec<SecretsPushMachine>,
}

// ---- client methods ----

/// Where one harness' sign-in comes from on this machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum BrokerLoginState {
    /// This machine is the broker and the account is signed in here.
    Lending,
    /// A local account here signs in through the broker and the broker answers.
    Borrowing,
    /// "Signs in through VPS, which is offline · Sign in here instead".
    BrokerOffline,
    /// The broker is reachable but has no sign-in for the harness yet.
    BrokerNotSignedIn,
    /// The broker does not understand borrowing (an older Kybern).
    BrokerUnsupported,
    /// No account here is bound to the broker.
    NotUsed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct BrokerProviderStatus {
    pub provider: ProviderKind,
    pub state: BrokerLoginState,
    /// The local account that signs in through the broker, when there is one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_account: Option<String>,
    /// The broker's account that is lent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub broker_account: Option<String>,
    /// Accounts the broker can lend for this harness.
    #[serde(default)]
    pub lendable: Vec<LendableAccount>,
    /// The sentence a client shows ("Claude signs in through the VPS, which is offline · …").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// Sessions on this machine using the loan.
    #[serde(default)]
    pub sessions: u32,
}

/// One loan the broker holds, for Settings → Machines.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct BrokerLoanView {
    pub loan_id: String,
    pub machine_id: MachineId,
    pub provider: ProviderKind,
    pub account: String,
    pub created_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_pushed_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct LoginBrokerStatus {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub broker: Option<crate::BrokerInfo>,
    /// This machine is the broker.
    #[serde(default)]
    pub is_broker: bool,
    pub providers: Vec<BrokerProviderStatus>,
    /// Loans this machine lent (empty unless it is the broker).
    #[serde(default)]
    pub loans: Vec<BrokerLoanView>,
}

/// `login.broker.bind`: make a local account sign in through the broker (or stop).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct LoginBrokerBindParams {
    pub provider: ProviderKind,
    /// A named account on this machine. The CLI account cannot be bound.
    pub instance: String,
    /// The broker's account to lend; `None` unbinds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub broker_account: Option<String>,
}

/// `login.broker.set`: move the broker (or clear it).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct LoginBrokerSetParams {
    /// The new broker, or `None` for no broker.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine_id: Option<MachineId>,
    /// After the members re-borrowed from the new broker, ask the old one to sign out. Default true.
    #[serde(default = "yes")]
    pub sign_out_old: bool,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct LoginBrokerSetResult {
    pub status: LoginBrokerStatus,
    /// Members that re-borrowed from the new broker before the old one signed out.
    #[serde(default)]
    pub rebound: Vec<MachineId>,
    /// Members that were offline. They borrow from the new broker when they return.
    #[serde(default)]
    pub offline: Vec<MachineId>,
    /// The old broker signed out of these harnesses.
    #[serde(default)]
    pub old_signed_out: Vec<ProviderKind>,
    /// Why the old broker was not signed out, when it was not.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// What an account row says when the account signs in through the broker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct AccountBroker {
    pub machine_id: MachineId,
    /// "VPS": the name clients put in "Signs in through VPS".
    pub machine_name: String,
    /// The broker's account that is lent.
    pub broker_account: String,
    pub state: BrokerLoginState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}
