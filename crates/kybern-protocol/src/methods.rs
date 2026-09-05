//! Every RPC method: its name, required scope, params and result types.
//!
//! Adding a method means adding a struct pair here and an entry in `METHODS`.

use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::auth::Scope;
use crate::event::ThreadEvent;
use crate::model::*;

/// Static description of a method, used for auth checks and docs.
pub trait Method {
    const NAME: &'static str;
    const SCOPE: Option<Scope>;
    type Params: Serialize + DeserializeOwned + JsonSchema;
    type Result: Serialize + DeserializeOwned + JsonSchema;
}

macro_rules! method {
    ($ty:ident, $name:literal, $scope:expr, $params:ty, $result:ty) => {
        pub struct $ty;
        impl Method for $ty {
            const NAME: &'static str = $name;
            const SCOPE: Option<Scope> = $scope;
            type Params = $params;
            type Result = $result;
        }
    };
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct Empty {}

// ---- daemon ----

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DaemonInfo {
    pub version: String,
    pub protocol_version: u32,
    /// Stable id of this daemon install, generated on first start.
    pub environment_id: String,
    pub hostname: String,
    pub os: String,
    pub arch: String,
    pub data_dir: String,
    pub scopes: Vec<Scope>,
    pub started_at: chrono::DateTime<chrono::Utc>,
}
method!(DaemonInfoMethod, "daemon.info", None, Empty, DaemonInfo);
method!(DaemonShutdown, "daemon.shutdown", Some(Scope::AccessWrite), Empty, Empty);

/// What the daemon is holding open right now. Lets clients and the CLI verify
/// that finished work does not linger.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DaemonActivity {
    /// Connected WebSocket clients.
    pub connections: u32,
    /// Threads with an agent process alive.
    pub live_sessions: u32,
    /// Live sessions with no turn, approval, or background work in progress.
    pub idle_sessions: u32,
    /// Threads running a turn or waiting for an approval.
    pub running_threads: u32,
    /// Shells and agent CLIs with a live pseudo-terminal.
    pub terminals: u32,
    /// Follow-ups waiting for their thread to become idle.
    pub queued_messages: u32,
    /// When the daemon last became fully idle, if it is idle now.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idle_since: Option<chrono::DateTime<chrono::Utc>>,
    /// When the daemon will exit if it stays idle, per `background.daemon_idle_exit_minutes`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idle_exit_at: Option<chrono::DateTime<chrono::Utc>>,
    /// Whether the host is running on battery. Absent when the daemon cannot tell.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_battery: Option<bool>,
}
method!(DaemonActivityMethod, "daemon.activity", Some(Scope::OrchestrationRead), Empty, DaemonActivity);

// ---- providers ----

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct ProvidersListParams {
    /// Resolve project-scoped harness settings for this project.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<ProjectId>,
    /// Bypass the daemon's short-lived provider catalog cache.
    #[serde(default)]
    pub force_refresh: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ProvidersListResult {
    pub providers: Vec<ProviderStatus>,
}
method!(ProvidersList, "providers.list", Some(Scope::OrchestrationRead), ProvidersListParams, ProvidersListResult);

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct HarnessUpdatesResult {
    pub updates: Vec<HarnessUpdate>,
}
method!(HarnessUpdatesList, "harness_updates.list", Some(Scope::OrchestrationRead), Empty, HarnessUpdatesResult);

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct HarnessUpdateParams {
    pub kind: ProviderKind,
}
method!(HarnessUpdatesRun, "harness_updates.run", Some(Scope::OrchestrationOperate), HarnessUpdateParams, HarnessUpdate);

// ---- projects ----

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ProjectsListResult {
    pub projects: Vec<Project>,
}
method!(ProjectsList, "projects.list", Some(Scope::OrchestrationRead), Empty, ProjectsListResult);

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct ProjectsBrowseParams {
    /// Absolute directory on the daemon host. Omit to start in its home directory.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ProjectDirectory {
    pub name: String,
    pub path: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ProjectsBrowseResult {
    pub path: String,
    pub parent: Option<String>,
    pub directories: Vec<ProjectDirectory>,
    pub has_more: bool,
}
method!(ProjectsBrowse, "projects.browse", Some(Scope::OrchestrationRead), ProjectsBrowseParams, ProjectsBrowseResult);

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ProjectsAddParams {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}
method!(ProjectsAdd, "projects.add", Some(Scope::OrchestrationOperate), ProjectsAddParams, Project);

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ProjectsUpdateParams {
    pub project_id: ProjectId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// `Some(None)` clears the override. Encoded as `null` on the wire.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktrees_default: Option<Option<bool>>,
}
method!(ProjectsUpdate, "projects.update", Some(Scope::OrchestrationOperate), ProjectsUpdateParams, Project);

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ProjectsRemoveParams {
    pub project_id: ProjectId,
}
method!(ProjectsRemove, "projects.remove", Some(Scope::OrchestrationOperate), ProjectsRemoveParams, Empty);

// ---- threads ----

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct ThreadsListParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<ProjectId>,
    #[serde(default)]
    pub include_archived: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ThreadsListResult {
    pub threads: Vec<Thread>,
    /// Compact activity summaries for sidebar rendering.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub activity: Vec<ThreadActivitySummary>,
}
method!(ThreadsList, "threads.list", Some(Scope::OrchestrationRead), ThreadsListParams, ThreadsListResult);

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ThreadsCreateParams {
    pub project_id: ProjectId,
    pub provider: ProviderInstance,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<PermissionMode>,
    /// Create a git worktree for this thread. Defaults to the project override, then global off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub use_worktree: Option<bool>,
    /// Branch to start from. A worktree forks its branch from it; a local thread
    /// switches the project checkout to it first.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Optionally send a first message in the same call.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<UserMessage>,
}
method!(ThreadsCreate, "threads.create", Some(Scope::OrchestrationOperate), ThreadsCreateParams, Thread);

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ThreadsGetParams {
    pub thread_id: ThreadId,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ThreadsGetResult {
    pub thread: Thread,
    pub transcript: Vec<TranscriptEntry>,
    pub pending_approvals: Vec<ApprovalRequest>,
    /// Durable latest-state task projection for this thread.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub runtime_tasks: Vec<RuntimeTask>,
}
method!(ThreadsGet, "threads.get", Some(Scope::OrchestrationRead), ThreadsGetParams, ThreadsGetResult);

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ThreadsUpdateParams {
    pub thread_id: ThreadId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<PermissionMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
}
method!(ThreadsUpdate, "threads.update", Some(Scope::OrchestrationOperate), ThreadsUpdateParams, Thread);

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ThreadsArchiveParams {
    pub thread_id: ThreadId,
}
method!(ThreadsArchive, "threads.archive", Some(Scope::OrchestrationOperate), ThreadsArchiveParams, Empty);

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ThreadsSendParams {
    pub thread_id: ThreadId,
    pub message: UserMessage,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ThreadsSendResult {
    pub turn_id: TurnId,
    pub message_id: MessageId,
}
method!(ThreadsSend, "threads.send", Some(Scope::OrchestrationOperate), ThreadsSendParams, ThreadsSendResult);

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ThreadsInterruptParams {
    pub thread_id: ThreadId,
}
method!(ThreadsInterrupt, "threads.interrupt", Some(Scope::OrchestrationOperate), ThreadsInterruptParams, Empty);

// ---- daemon-owned follow-ups ----

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct QueuedMessage {
    pub id: MessageId,
    pub thread_id: ThreadId,
    pub message: UserMessage,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct QueueListParams {
    pub thread_id: Option<ThreadId>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct QueueListResult {
    pub messages: Vec<QueuedMessage>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct QueueRemoveParams {
    pub thread_id: ThreadId,
    pub id: MessageId,
}
method!(QueueAdd, "queue.add", Some(Scope::OrchestrationOperate), QueuedMessage, Empty);
method!(QueueList, "queue.list", Some(Scope::OrchestrationRead), QueueListParams, QueueListResult);
method!(QueueRemove, "queue.remove", Some(Scope::OrchestrationOperate), QueueRemoveParams, Empty);

// ---- provider-owned runtime tasks ----

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TasksListParams {
    pub thread_id: ThreadId,
    /// Include terminal tasks in addition to active work.
    #[serde(default)]
    pub include_completed: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TasksListResult {
    pub tasks: Vec<RuntimeTask>,
}
method!(TasksList, "tasks.list", Some(Scope::OrchestrationRead), TasksListParams, TasksListResult);

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TaskControlParams {
    pub thread_id: ThreadId,
    pub task_id: String,
}
method!(TaskStop, "tasks.stop", Some(Scope::OrchestrationOperate), TaskControlParams, RuntimeTask);
method!(TaskBackground, "tasks.background", Some(Scope::OrchestrationOperate), TaskControlParams, RuntimeTask);

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ThreadsRegenerateTitleParams {
    pub thread_id: ThreadId,
}
method!(ThreadsRegenerateTitle, "threads.regenerateTitle", Some(Scope::OrchestrationOperate), ThreadsRegenerateTitleParams, Thread);

// ---- checkpoints ----

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ThreadsCheckpointsParams {
    pub thread_id: ThreadId,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ThreadsCheckpointsResult {
    pub checkpoints: Vec<Checkpoint>,
}
method!(ThreadsCheckpoints, "threads.checkpoints", Some(Scope::OrchestrationRead), ThreadsCheckpointsParams, ThreadsCheckpointsResult);

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ThreadsDiffParams {
    pub thread_id: ThreadId,
    /// Diff of one turn (its before → after, or before → now while running).
    /// Omit for the whole thread: first checkpoint → current working tree.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<TurnId>,
    /// Include unified patch text. Defaults to true for older clients.
    #[serde(default = "default_true")]
    pub include_patch: bool,
    /// Limit the diff to one repository-relative path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}
method!(ThreadsDiff, "threads.diff", Some(Scope::OrchestrationRead), ThreadsDiffParams, Diff);

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ThreadsRevertParams {
    pub thread_id: ThreadId,
    /// Restore the working tree to the state before this turn.
    pub turn_id: TurnId,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ThreadsRevertResult {
    pub commit: String,
    /// Whether the provider conversation was also rewound. False when the driver cannot fork yet.
    pub conversation_rewound: bool,
}
method!(ThreadsRevert, "threads.revert", Some(Scope::OrchestrationOperate), ThreadsRevertParams, ThreadsRevertResult);

// ---- terminals ----

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TerminalInfo {
    pub id: TerminalId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub title: String,
    pub alive: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TerminalsCreateParams {
    /// A client-generated identity makes reconnecting creation idempotent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_id: Option<TerminalId>,
    /// Run in this thread's working directory (worktree or project).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    /// Explicit working directory; overrides the thread's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
    /// Program to run. Defaults to the user's shell.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<Vec<String>>,
}
fn default_cols() -> u16 {
    120
}
fn default_rows() -> u16 {
    32
}
method!(TerminalsCreate, "terminals.create", Some(Scope::TerminalOperate), TerminalsCreateParams, TerminalInfo);

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct TerminalsListParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TerminalsListResult {
    pub terminals: Vec<TerminalInfo>,
}
method!(TerminalsList, "terminals.list", Some(Scope::TerminalOperate), TerminalsListParams, TerminalsListResult);

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TerminalsInputParams {
    pub terminal_id: TerminalId,
    /// Raw bytes, base64.
    pub data: String,
}
method!(TerminalsInput, "terminals.input", Some(Scope::TerminalOperate), TerminalsInputParams, Empty);

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TerminalsResizeParams {
    pub terminal_id: TerminalId,
    pub cols: u16,
    pub rows: u16,
}
method!(TerminalsResize, "terminals.resize", Some(Scope::TerminalOperate), TerminalsResizeParams, Empty);

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TerminalsCloseParams {
    pub terminal_id: TerminalId,
}
method!(TerminalsClose, "terminals.close", Some(Scope::TerminalOperate), TerminalsCloseParams, Empty);

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TerminalsSubscribeParams {
    pub terminal_id: TerminalId,
    /// Send the retained scrollback (up to the daemon's cap) before live output.
    #[serde(default = "default_true")]
    pub replay: bool,
}
fn default_true() -> bool {
    true
}
method!(TerminalsSubscribe, "terminals.subscribe", Some(Scope::TerminalOperate), TerminalsSubscribeParams, Empty);
method!(TerminalsUnsubscribe, "terminals.unsubscribe", Some(Scope::TerminalOperate), TerminalsCloseParams, Empty);

/// Params of the `terminal.output` notification.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TerminalOutputNotification {
    pub terminal_id: TerminalId,
    /// Raw bytes, base64.
    pub data: String,
}
/// Params of the `terminal.exited` notification.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TerminalExitedNotification {
    pub terminal_id: TerminalId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
}
pub const TERMINAL_OUTPUT_NOTIFICATION: &str = "terminal.output";
pub const TERMINAL_EXITED_NOTIFICATION: &str = "terminal.exited";

// ---- settings ----

method!(SettingsGet, "settings.get", Some(Scope::OrchestrationRead), Empty, Settings);
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SettingsUpdateParams {
    pub settings: Settings,
}
method!(SettingsUpdate, "settings.update", Some(Scope::OrchestrationOperate), SettingsUpdateParams, Settings);

// ---- usage ----

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum UsageGroup {
    #[default]
    Provider,
    Model,
    Day,
    Thread,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct UsageSummaryParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since: Option<chrono::DateTime<chrono::Utc>>,
    #[serde(default)]
    pub group_by: UsageGroup,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct UsageRow {
    pub key: String,
    pub turns: u64,
    pub usage: Usage,
    pub cost_usd: f64,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct UsageSummaryResult {
    pub rows: Vec<UsageRow>,
    pub total: UsageRow,
}
method!(UsageSummary, "usage.summary", Some(Scope::OrchestrationRead), UsageSummaryParams, UsageSummaryResult);

// ---- access (pairing and tokens) ----

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct PairingCreateParams {
    /// Label for the token that pairing will mint, e.g. "iPhone".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PairingCreateResult {
    /// Six-digit code the other device enters.
    pub code: String,
    pub expires_at: chrono::DateTime<chrono::Utc>,
    /// Endpoints the daemon is reachable at (loopback first, then LAN addresses).
    pub endpoints: Vec<String>,
}
method!(PairingCreate, "access.pairing.create", Some(Scope::AccessWrite), PairingCreateParams, PairingCreateResult);

/// Which networks the daemon listens on besides loopback.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Exposure {
    /// This machine's Tailscale IPv4 address when Tailscale is running and
    /// the daemon could bind it; `None` when Tailscale is absent or userspace.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tailscale_ip: Option<String>,
    /// Whether the daemon currently listens on the Tailscale address.
    pub tailscale: bool,
    /// Every address the daemon listens on, loopback included.
    pub listeners: Vec<String>,
}
method!(ExposureGet, "access.exposure.get", Some(Scope::AccessRead), Empty, Exposure);

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct ExposureSetParams {
    /// Listen on the Tailscale address as well. Persisted in settings.
    pub tailscale: bool,
}
method!(ExposureSet, "access.exposure.set", Some(Scope::AccessWrite), ExposureSetParams, Exposure);

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TokenInfo {
    pub id: uuid::Uuid,
    pub label: String,
    pub scopes: Vec<Scope>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<chrono::DateTime<chrono::Utc>>,
    pub revoked: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TokensListResult {
    pub tokens: Vec<TokenInfo>,
}
method!(TokensList, "access.tokens.list", Some(Scope::AccessRead), Empty, TokensListResult);
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TokensRevokeParams {
    pub token_id: uuid::Uuid,
}
method!(TokensRevoke, "access.tokens.revoke", Some(Scope::AccessWrite), TokensRevokeParams, Empty);

/// Body of `POST /pair` (unauthenticated) and its response.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PairRequest {
    pub code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PairResponse {
    pub token: String,
    pub scopes: Vec<Scope>,
    pub environment_id: String,
}

// ---- assets ----

/// Response of `POST /assets` (multipart or raw body with `X-Kybern-Filename`).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct AssetInfo {
    pub id: AssetId,
    pub name: String,
    pub media_type: String,
    pub size: u64,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

// ---- git and GitHub ----

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GitStatusParams {
    pub thread_id: ThreadId,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GitStatus {
    pub is_git: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    pub dirty_files: u32,
    pub ahead: u32,
    pub behind: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_url: Option<String>,
    /// Open pull request for this branch, if `gh` knows one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pull_request: Option<PullRequest>,
}
method!(GitStatusMethod, "git.status", Some(Scope::OrchestrationRead), GitStatusParams, GitStatus);

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GitBranchesParams {
    pub project_id: ProjectId,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct BranchInfo {
    pub name: String,
    pub is_current: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    /// Committer time of the tip commit, unix seconds.
    pub committed_at: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GitBranchesResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current: Option<String>,
    /// Local branches, most recently committed first. Empty when the project is not a repository.
    pub branches: Vec<BranchInfo>,
}
method!(GitBranches, "git.branches", Some(Scope::OrchestrationRead), GitBranchesParams, GitBranchesResult);

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GitCommitParams {
    pub thread_id: ThreadId,
    /// Omit to generate a message from the diff.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GitCommitResult {
    pub commit: String,
    pub message: String,
}
method!(GitCommit, "git.commit", Some(Scope::OrchestrationOperate), GitCommitParams, GitCommitResult);

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub state: String,
    pub head: String,
    pub base: String,
    pub is_draft: bool,
    pub author: String,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PrCreateParams {
    pub thread_id: ThreadId,
    /// Omit either to generate from the thread's diff.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    #[serde(default)]
    pub draft: bool,
    /// Commit uncommitted changes first (message generated when needed).
    #[serde(default = "default_true_pr")]
    pub commit_first: bool,
}
fn default_true_pr() -> bool {
    true
}
method!(PrCreate, "github.pr.create", Some(Scope::OrchestrationOperate), PrCreateParams, PullRequest);

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PrListParams {
    pub project_id: ProjectId,
    #[serde(default = "default_pr_state")]
    pub state: String,
    #[serde(default = "default_pr_limit")]
    pub limit: u32,
}
fn default_pr_state() -> String {
    "open".into()
}
fn default_pr_limit() -> u32 {
    30
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PrListResult {
    pub pull_requests: Vec<PullRequest>,
}
method!(PrList, "github.pr.list", Some(Scope::OrchestrationRead), PrListParams, PrListResult);

// ---- files ----

/// Find files in a project by fuzzy path match, for @mentions in the composer.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct FilesSearchParams {
    pub project_id: ProjectId,
    /// Case-insensitive; every character must appear in order in the path.
    #[serde(default)]
    pub query: String,
    #[serde(default = "default_files_limit")]
    pub limit: u32,
}
fn default_files_limit() -> u32 {
    30
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct FilesSearchResult {
    /// Paths relative to the project root, best match first.
    pub files: Vec<String>,
    /// Total files considered, so clients can say "of N".
    pub total: u32,
}
method!(FilesSearch, "files.search", Some(Scope::OrchestrationRead), FilesSearchParams, FilesSearchResult);

/// One entry of a directory listing, for the file explorer.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct FileEntry {
    pub name: String,
    /// Path relative to the project root.
    pub path: String,
    pub kind: FileEntryKind,
    /// Bytes, for files.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum FileEntryKind {
    File,
    Directory,
}

/// List one directory of a project (directories first, then files, sorted by name).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct FilesListParams {
    pub project_id: ProjectId,
    /// Directory relative to the project root; empty for the root.
    #[serde(default)]
    pub path: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct FilesListResult {
    pub entries: Vec<FileEntry>,
}
method!(FilesList, "files.list", Some(Scope::OrchestrationRead), FilesListParams, FilesListResult);

/// Read a text file of a project, capped at `max_bytes`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct FilesReadParams {
    pub project_id: ProjectId,
    /// File relative to the project root.
    pub path: String,
    #[serde(default = "default_files_read_max")]
    pub max_bytes: u64,
}
fn default_files_read_max() -> u64 {
    512 * 1024
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct FilesReadResult {
    /// UTF-8 content (lossy), empty for binary files.
    pub content: String,
    /// True when the file was cut at `max_bytes`.
    pub truncated: bool,
    /// True when the file does not look like text.
    pub binary: bool,
    /// Full size on disk in bytes.
    pub size: u64,
}
method!(FilesRead, "files.read", Some(Scope::OrchestrationRead), FilesReadParams, FilesReadResult);

// ---- skills ----

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SkillsListParams {
    pub project_id: ProjectId,
    pub provider: ProviderKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SkillsListResult {
    pub skills: Vec<SkillInfo>,
}
method!(SkillsList, "skills.list", Some(Scope::OrchestrationRead), SkillsListParams, SkillsListResult);

// ---- approvals ----

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ApprovalsRespondParams {
    pub approval_id: ApprovalId,
    #[serde(flatten)]
    pub decision: ApprovalDecision,
}
method!(ApprovalsRespond, "approvals.respond", Some(Scope::OrchestrationOperate), ApprovalsRespondParams, Empty);

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct ApprovalsListParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ApprovalsListResult {
    pub approvals: Vec<ApprovalRequest>,
}
method!(ApprovalsList, "approvals.list", Some(Scope::OrchestrationRead), ApprovalsListParams, ApprovalsListResult);

// ---- events ----

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct EventsSubscribeParams {
    /// Restrict to one thread. Omit to receive every thread's events.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    /// Replay persisted events with `seq > after_seq` before going live. Omit for live only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_seq: Option<EventSeq>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct EventsSubscribeResult {
    pub subscription_id: SubscriptionId,
    /// Latest persisted seq at subscribe time. Replay covers up to and including this.
    pub head_seq: EventSeq,
}
method!(EventsSubscribe, "events.subscribe", Some(Scope::OrchestrationRead), EventsSubscribeParams, EventsSubscribeResult);

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct EventsUnsubscribeParams {
    pub subscription_id: SubscriptionId,
}
method!(EventsUnsubscribe, "events.unsubscribe", Some(Scope::OrchestrationRead), EventsUnsubscribeParams, Empty);

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct EventsRangeParams {
    pub thread_id: ThreadId,
    #[serde(default)]
    pub after_seq: EventSeq,
    #[serde(default = "default_limit")]
    pub limit: u32,
}
fn default_limit() -> u32 {
    500
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct EventsRangeResult {
    pub events: Vec<ThreadEvent>,
    pub has_more: bool,
}
method!(EventsRange, "events.range", Some(Scope::OrchestrationRead), EventsRangeParams, EventsRangeResult);

/// Registry used by the daemon's auth check and the schema dump.
pub struct MethodInfo {
    pub name: &'static str,
    pub scope: Option<Scope>,
}

macro_rules! registry {
    ($($ty:ty),* $(,)?) => {
        pub const METHODS: &[MethodInfo] = &[
            $(MethodInfo { name: <$ty as Method>::NAME, scope: <$ty as Method>::SCOPE }),*
        ];
    };
}

registry!(
    DaemonInfoMethod,
    DaemonShutdown,
    DaemonActivityMethod,
    ProvidersList,
    HarnessUpdatesList,
    HarnessUpdatesRun,
    ProjectsList,
    ProjectsBrowse,
    ProjectsAdd,
    ProjectsUpdate,
    ProjectsRemove,
    ThreadsList,
    ThreadsCreate,
    ThreadsGet,
    ThreadsUpdate,
    ThreadsArchive,
    ThreadsSend,
    QueueAdd,
    QueueList,
    QueueRemove,
    ThreadsInterrupt,
    TasksList,
    TaskStop,
    TaskBackground,
    ThreadsRegenerateTitle,
    ThreadsCheckpoints,
    ThreadsDiff,
    ThreadsRevert,
    TerminalsCreate,
    TerminalsList,
    TerminalsInput,
    TerminalsResize,
    TerminalsClose,
    TerminalsSubscribe,
    TerminalsUnsubscribe,
    SettingsGet,
    SettingsUpdate,
    UsageSummary,
    PairingCreate,
    ExposureGet,
    ExposureSet,
    TokensList,
    TokensRevoke,
    GitStatusMethod,
    GitBranches,
    GitCommit,
    PrCreate,
    PrList,
    FilesSearch,
    FilesList,
    FilesRead,
    SkillsList,
    ApprovalsRespond,
    ApprovalsList,
    EventsSubscribe,
    EventsUnsubscribe,
    EventsRange,
);

pub fn scope_for(method: &str) -> Option<Option<Scope>> {
    METHODS.iter().find(|m| m.name == method).map(|m| m.scope)
}
