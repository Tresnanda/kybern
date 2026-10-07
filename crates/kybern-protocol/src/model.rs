//! Domain model shared by daemon and clients.

use chrono::{DateTime, Utc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::event::NoticeLevel;

pub type ProjectId = Uuid;
/// Daemon-owned neutral workspace used by chats that are not attached to a
/// user project. Clients present these threads as project-free.
pub const FREE_CHAT_PROJECT_ID: ProjectId = Uuid::from_u128(1);

pub fn is_free_chat_project(id: ProjectId) -> bool {
    id == FREE_CHAT_PROJECT_ID
}
pub type ThreadId = Uuid;
pub type TurnId = Uuid;
pub type MessageId = Uuid;
pub type ApprovalId = Uuid;
pub type SubscriptionId = Uuid;
pub type AssetId = Uuid;
pub type TerminalId = Uuid;

/// Monotonic per-daemon event sequence number. Clients resume from the last one they saw.
pub type EventSeq = i64;

/// Coding agent backends the daemon can drive. Each has its own native driver.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderKind {
    ClaudeCode,
    Codex,
    Opencode,
    Pi,
    Omp,
    Cursor,
}

impl ProviderKind {
    pub const ALL: [ProviderKind; 6] =
        [ProviderKind::ClaudeCode, ProviderKind::Codex, ProviderKind::Opencode, ProviderKind::Pi, ProviderKind::Omp, ProviderKind::Cursor];

    pub fn as_str(self) -> &'static str {
        match self {
            ProviderKind::ClaudeCode => "claude-code",
            ProviderKind::Codex => "codex",
            ProviderKind::Opencode => "opencode",
            ProviderKind::Pi => "pi",
            ProviderKind::Omp => "omp",
            ProviderKind::Cursor => "cursor",
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            ProviderKind::ClaudeCode => "Claude Code",
            ProviderKind::Codex => "Codex",
            ProviderKind::Opencode => "OpenCode",
            ProviderKind::Pi => "pi",
            ProviderKind::Omp => "Oh My Pi",
            ProviderKind::Cursor => "Cursor",
        }
    }

    /// Executable name looked up on PATH when no override is configured.
    pub fn default_binary(self) -> &'static str {
        match self {
            ProviderKind::ClaudeCode => "claude",
            ProviderKind::Codex => "codex",
            ProviderKind::Opencode => "opencode",
            ProviderKind::Pi => "pi",
            ProviderKind::Omp => "omp",
            ProviderKind::Cursor => "agent",
        }
    }
}

impl std::fmt::Display for ProviderKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for ProviderKind {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        ProviderKind::ALL.into_iter().find(|p| p.as_str() == s).ok_or_else(|| format!("unknown provider: {s}"))
    }
}

/// A configured account/instance of a provider. `default` is created implicitly.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
pub struct ProviderInstance {
    pub kind: ProviderKind,
    pub instance: String,
}

impl ProviderInstance {
    pub fn default_for(kind: ProviderKind) -> Self {
        Self { kind, instance: "default".into() }
    }
}

/// A named, native-isolated account. Secrets remain in the harness directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ProviderAccount {
    pub name: String,
    pub directory: String,
}

/// The target of the next message, separate from the admitted live session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SessionTarget {
    pub provider: ProviderInstance,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
}

/// Availability of a provider binary on the daemon host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ProviderModel {
    /// Model selector accepted by the provider (for example `gpt-5.6-sol` or `openai/gpt-5.6-sol`).
    pub id: String,
    pub display_name: String,
    /// Concrete model id the selector currently resolves to, when `id` is an
    /// alias (Claude's `opus` → `claude-opus-5-5`). Sessions report the concrete
    /// id, so clients match a thread's model against either field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_id: Option<String>,
    /// The harness's own one-line description (Claude Code: `Opus 5.5 · Best
    /// for everyday, complex tasks`), shown under the name in pickers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Upstream model provider. Harnesses that aggregate providers use this to build a paged picker.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// Effort values accepted for this model, in the provider's preferred order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub efforts: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_effort: Option<String>,
    #[serde(default)]
    pub is_default: bool,
}

/// A command advertised by a live harness's native protocol.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ProviderCommand {
    pub name: String,
    pub description: String,
}

/// Availability and selectable capabilities of a provider binary on the daemon host.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ProviderStatus {
    pub kind: ProviderKind,
    pub display_name: String,
    pub available: bool,
    /// Resolved executable path when found.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binary_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Human-readable reason when unavailable (not found, too old, ...).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
    /// Which permission modes this provider can honor.
    pub supported_permission_modes: Vec<PermissionMode>,
    /// Whether the provider can fork its conversation, enabling conversation rewind.
    pub supports_fork: bool,
    pub supports_model_switch: bool,
    /// Whether effort can be changed after a provider session has started.
    #[serde(default)]
    pub supports_effort_switch: bool,
    /// Fallback effort choices when the catalog does not vary by model.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub supported_efforts: Vec<String>,
    /// Models reported by the installed harness. Empty means the harness has no catalog API.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub models: Vec<ProviderModel>,
    pub instances: Vec<String>,
}

/// The four permission modes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionMode {
    /// Every tool call that mutates or executes asks for approval.
    Supervised,
    /// File edits proceed; shell and network still ask.
    AcceptEdits,
    /// The provider decides with its own safety heuristics; asks only when unsure.
    Auto,
    /// Nothing asks. Sandboxing is the provider's problem.
    FullAccess,
}

impl PermissionMode {
    pub const ALL: [PermissionMode; 4] =
        [PermissionMode::Supervised, PermissionMode::AcceptEdits, PermissionMode::Auto, PermissionMode::FullAccess];
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Project {
    pub id: ProjectId,
    pub name: String,
    /// Absolute path on the daemon host.
    pub path: String,
    pub is_git: bool,
    /// Per-project override for "new threads use a worktree". Global default is off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktrees_default: Option<bool>,
    /// Prefix for this project's task keys, such as `ADE`. Assigned from the
    /// project name when it is added; editable through `projects.update`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_prefix: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ThreadStatus {
    Idle,
    Running,
    AwaitingApproval,
    Failed,
    Archived,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Thread {
    pub id: ThreadId,
    pub project_id: ProjectId,
    pub title: String,
    pub provider: ProviderInstance,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    pub permission_mode: PermissionMode,
    pub status: ThreadStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<WorktreeInfo>,
    /// Working directory the agent runs in: the worktree path or the project path.
    pub cwd: String,
    /// The provider's own session id once bound, used for resume and fork.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_session_id: Option<String>,
    pub pinned: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// Sequence of the last event on this thread. Clients use it to detect gaps.
    pub last_seq: EventSeq,
    /// Immutable parent for a Kybern-managed helper thread.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_thread_id: Option<ThreadId>,
    /// Set when this thread is the persistent coordinator for a project.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coordinator_project_id: Option<ProjectId>,
    /// Active collaboration membership, denormalized for efficient navigation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collaboration_group_id: Option<crate::GroupId>,
    /// Set when this thread mirrors one provider-native subagent. Such a thread
    /// is read-only: it records what the subagent said and did, and its
    /// `parent_thread_id` is the thread (or subagent thread) that launched it.
    /// Clients that do not know about subagent threads must hide them from
    /// thread lists.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent: Option<SubagentInfo>,
    /// Set when this thread is a child another thread delegated work to with
    /// `kybern_agent_delegate`. Unlike `subagent` it is a normal, writable
    /// thread; `parent_thread_id` is the delegating thread. Clients that do
    /// not know about delegation hide such threads from thread lists the same
    /// way they hide subagents.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delegation: Option<DelegationInfo>,
}

/// What the delegating agent asked this child to be.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DelegationRole {
    Implementation,
    Research,
    Review,
    Design,
    Test,
    #[default]
    General,
}

impl DelegationRole {
    pub fn as_str(self) -> &'static str {
        match self {
            DelegationRole::Implementation => "implementation",
            DelegationRole::Research => "research",
            DelegationRole::Review => "review",
            DelegationRole::Design => "design",
            DelegationRole::Test => "test",
            DelegationRole::General => "general",
        }
    }
}

impl std::fmt::Display for DelegationRole {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Where a delegated child works.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DelegationWorkspace {
    /// The parent's checkout and branch.
    #[default]
    Shared,
    /// Its own git worktree on `kybern/<child-id>`, seeded from the parent's
    /// current uncommitted state.
    Worktree,
}

impl DelegationWorkspace {
    pub fn as_str(self) -> &'static str {
        match self {
            DelegationWorkspace::Shared => "shared",
            DelegationWorkspace::Worktree => "worktree",
        }
    }
}

impl std::fmt::Display for DelegationWorkspace {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DelegationStatus {
    Running,
    Completed,
    Failed,
    Cancelled,
    /// Cut off by a daemon restart.
    Interrupted,
}

impl DelegationStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            DelegationStatus::Running => "running",
            DelegationStatus::Completed => "completed",
            DelegationStatus::Failed => "failed",
            DelegationStatus::Cancelled => "cancelled",
            DelegationStatus::Interrupted => "interrupted",
        }
    }
}

impl std::fmt::Display for DelegationStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// State of a delegated child's own worktree (`DelegationWorkspace::Worktree`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WorktreeState {
    Active,
    /// Left on disk because it was dirty or its branch is unmerged.
    Kept,
    Removed,
}

/// Files and lines changed between two commits.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct DiffStat {
    pub files: u32,
    pub additions: u32,
    pub deletions: u32,
}

/// A shared-checkout edit that landed on a path a sibling delegation owns.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct DelegationConflict {
    /// Repo-relative path that was edited.
    pub path: String,
    /// The sibling thread whose `owns` globs cover `path`.
    pub owner_thread_id: ThreadId,
    pub at: DateTime<Utc>,
}

/// Delegation metadata carried by a child [`Thread`] created with
/// `kybern_agent_delegate`. Refreshed through `thread_updated`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DelegationInfo {
    /// Stable id agents use to refer to this delegation.
    pub task_id: Uuid,
    /// Idempotency key of the delegate call.
    pub operation_id: Uuid,
    /// Duplicate of `Thread::parent_thread_id` for convenience.
    pub parent_thread_id: ThreadId,
    /// 1 for a direct child of a top-level thread.
    pub depth: u8,
    #[serde(default)]
    pub role: DelegationRole,
    #[serde(default)]
    pub workspace: DelegationWorkspace,
    /// Globs relative to the checkout root this child owns (shared only).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub owns: Vec<String>,
    pub status: DelegationStatus,
    /// The child's final assistant text of the completing turn (at most
    /// 16 KiB, truncated with a marker).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Repo-relative paths the child edited, deduplicated, at most 200.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files_touched: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub conflicts: Vec<DelegationConflict>,
    /// Worktree: the snapshot commit the worktree was seeded from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_commit: Option<String>,
    /// Worktree: `kybern/<child-id>`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// Worktree: HEAD when the child completed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head_commit: Option<String>,
    /// Worktree: `base_commit..head_commit`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diffstat: Option<DiffStat>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_state: Option<WorktreeState>,
    pub started_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<DateTime<Utc>>,
    /// Whether the delegating parent has been handed this outcome (delivered,
    /// steered or queued). Cleared when the delegation reaches a terminal state
    /// and set once its `AgentResultItem` is out, so a restart can re-send an
    /// outcome that was still waiting in the debounce window. Rows written
    /// before this field existed read as `true`: nothing is re-sent.
    #[serde(default = "default_true")]
    pub parent_notified: bool,
}

/// Why a message exists. `Task` is a delegation brief; `Warning` comes from
/// Kybern itself (for example a file ownership clash).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ThreadMessagePurpose {
    Task,
    Message,
    Question,
    Reply,
    Warning,
}

impl ThreadMessagePurpose {
    pub fn as_str(self) -> &'static str {
        match self {
            ThreadMessagePurpose::Task => "task",
            ThreadMessagePurpose::Message => "message",
            ThreadMessagePurpose::Question => "question",
            ThreadMessagePurpose::Reply => "reply",
            ThreadMessagePurpose::Warning => "warning",
        }
    }
}

impl std::fmt::Display for ThreadMessagePurpose {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// How the sender asked for a thread message to be delivered.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ThreadMessageDelivery {
    #[default]
    Queue,
    /// Into the recipient's running turn when its harness can steer; falls
    /// back to `Queue` otherwise.
    Steer,
}

impl ThreadMessageDelivery {
    pub fn as_str(self) -> &'static str {
        match self {
            ThreadMessageDelivery::Queue => "queue",
            ThreadMessageDelivery::Steer => "steer",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ThreadMessageState {
    /// Blocked by the permission rule; waiting for the user to deliver or dismiss it.
    Held,
    Queued,
    Steered,
    /// The recipient's turn that consumed it has started.
    Delivered,
    /// A question that received its reply.
    Answered,
    Dismissed,
    Failed,
}

impl ThreadMessageState {
    pub fn as_str(self) -> &'static str {
        match self {
            ThreadMessageState::Held => "held",
            ThreadMessageState::Queued => "queued",
            ThreadMessageState::Steered => "steered",
            ThreadMessageState::Delivered => "delivered",
            ThreadMessageState::Answered => "answered",
            ThreadMessageState::Dismissed => "dismissed",
            ThreadMessageState::Failed => "failed",
        }
    }
}

/// A message one thread sent another through `kybern_thread_send` (or Kybern
/// sent on its own behalf). The row id is also the queued or steered message id.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ThreadMessageRecord {
    pub id: MessageId,
    /// Idempotency key of the send.
    pub operation_id: Uuid,
    /// `None` when Kybern itself sent it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_thread_id: Option<ThreadId>,
    pub to_thread_id: ThreadId,
    pub purpose: ThreadMessagePurpose,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<MessageId>,
    pub body: String,
    /// Requested delivery.
    pub delivery: ThreadMessageDelivery,
    pub state: ThreadMessageState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub held_reason: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// How a held message left the held state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum HeldResolution {
    Delivered,
    Dismissed,
}

/// One delegated agent's outcome inside an [`ContentPart::AgentResults`] batch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct AgentResultItem {
    pub task_id: Uuid,
    pub thread_id: ThreadId,
    pub title: String,
    pub provider: ProviderKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default)]
    pub role: DelegationRole,
    pub status: DelegationStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default)]
    pub workspace: DelegationWorkspace,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head_commit: Option<String>,
    /// Worktree: the commit the worktree was seeded from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_commit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diffstat: Option<DiffStat>,
    /// At most 50.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files_touched: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub conflicts: Vec<DelegationConflict>,
}

/// Provider-native subagent metadata carried by a read-only child [`Thread`].
///
/// The title, model and effort live on the thread itself. This struct holds
/// the rest of what a subagent page needs and is refreshed (through
/// `thread_updated`) whenever the parent's runtime task for it changes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SubagentInfo {
    /// Provider-stable id of the runtime task in the parent thread. Together
    /// with the root thread it identifies this child thread.
    pub task_id: String,
    /// The thread that owns the provider session. For a subagent launched by
    /// another subagent this is the root, not `Thread::parent_thread_id`.
    /// `tasks.stop` and `tasks.background` accept the child thread id and
    /// resolve the session through it.
    pub root_thread_id: ThreadId,
    /// Turn of the root thread that launched the subagent.
    pub parent_turn_id: TurnId,
    /// Tool call in the parent that launched it, when the provider has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_thread_id: Option<String>,
    /// Provider agent type or role (`Explore`, `worker`, `task:general`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<String>,
    pub status: RuntimeTaskStatus,
    #[serde(default)]
    pub backgrounded: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_tool_name: Option<String>,
    /// Latest progress or final result summary from the provider, as reported
    /// (see `progress` and `result` for the normalized one-line forms).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// One live line while the subagent works: the provider's latest activity
    /// text, else the last tool it used (`Using Read`). Cleared once it settles.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<String>,
    /// First line of the subagent's final answer once it settled (its last
    /// message, else the provider's result summary, else the failure message).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
    #[serde(default)]
    pub stats: RuntimeTaskStats,
    /// Whether `tasks.stop` / `tasks.background` currently work for it.
    #[serde(default)]
    pub capabilities: RuntimeTaskCapabilities,
    /// False when the harness only reports lifecycle (Pi/OMP and providers
    /// without native subagent forwarding): the transcript holds just the
    /// prompt and the outcome.
    #[serde(default)]
    pub transcript: bool,
    pub started_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<DateTime<Utc>>,
}

/// One piece of a user message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentPart {
    Text {
        text: String,
    },
    /// Inline image. `data` is base64 of the raw bytes.
    Image {
        media_type: String,
        data: String,
    },
    /// Uploaded attachment served by the daemon's HTTP asset route.
    Attachment {
        asset_id: AssetId,
        name: String,
        media_type: String,
        size: u64,
    },
    /// `@path` mention resolved relative to the thread cwd.
    FileMention {
        path: String,
    },
    /// Inert reference to an existing Kybern thread. Selecting or rendering it
    /// never reads, wakes, or sends to the referenced thread.
    ThreadReference {
        thread_id: ThreadId,
        title: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project_id: Option<ProjectId>,
    },
    /// A user-selected agent skill. Drivers translate this into the provider's
    /// native invocation syntax instead of treating a lookalike `$NAME` as a
    /// skill accidentally.
    Skill {
        name: String,
        /// Canonical `SKILL.md` path returned by the provider catalog. Codex
        /// requires it for its structured `skill` turn input; other drivers
        /// may use only the name.
        path: String,
    },
    /// A provider plugin or app the user pulled in with `@name`, such as
    /// Codex's Computer Use. `path` is the provider's own id for it
    /// (`plugin://name@marketplace` or `app://connector-id`); drivers without
    /// a structured form send the mention as text.
    Mention {
        name: String,
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        display_name: Option<String>,
    },
    /// A message from another thread (or from Kybern itself when
    /// `from_thread_id` is `None`). Providers receive it as flattened text; see
    /// [`thread_message_text`].
    ThreadMessage {
        /// The `thread_messages` row id; also the queued or steered message id.
        message_id: MessageId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from_thread_id: Option<ThreadId>,
        from_title: String,
        purpose: ThreadMessagePurpose,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reply_to: Option<MessageId>,
        body: String,
    },
    /// A batch of delegated-agent outcomes delivered to the delegating thread.
    /// Providers receive it as flattened text; see [`agent_results_text`].
    AgentResults {
        items: Vec<AgentResultItem>,
    },
}

impl ContentPart {
    /// Provider-facing text of a [`ContentPart::ThreadMessage`] or
    /// [`ContentPart::AgentResults`]; `None` for every other part. Drivers
    /// flatten these parts through this one helper so every harness sees the
    /// same wording.
    pub fn orchestration_text(&self) -> Option<String> {
        match self {
            ContentPart::ThreadMessage { message_id, from_thread_id, from_title, purpose, reply_to, body } => {
                Some(thread_message_text(*message_id, *from_thread_id, from_title, *purpose, *reply_to, body))
            }
            ContentPart::AgentResults { items } => Some(agent_results_text(items)),
            _ => None,
        }
    }
}

pub fn thread_reference_text(thread_id: ThreadId, title: &str) -> String {
    format!("@thread[{thread_id}] {title} (you can read it with kybern_thread_read and message it with kybern_thread_send)")
}

/// Provider-facing text for a [`ContentPart::ThreadMessage`]. Every driver
/// flattens the part through this so agents see one format.
pub fn thread_message_text(
    message_id: MessageId,
    from_thread_id: Option<ThreadId>,
    from_title: &str,
    purpose: ThreadMessagePurpose,
    reply_to: Option<MessageId>,
    body: &str,
) -> String {
    let mut out = match from_thread_id {
        Some(from) => format!("Message from thread \"{from_title}\" ({from}) · {purpose} · id {message_id}"),
        None => format!("Message from Kybern · {purpose} · id {message_id}"),
    };
    if let Some(reply_to) = reply_to {
        out.push_str(&format!(" · reply to {reply_to}"));
    }
    out.push_str(":\n");
    out.push_str(body);
    let guidance = match purpose {
        ThreadMessagePurpose::Question => match from_thread_id {
            Some(from) => format!(
                "Reply with kybern_thread_send to {from} with purpose \"reply\" and reply_to \"{message_id}\". If you do not, your final message this turn is sent back as the reply."
            ),
            None => String::new(),
        },
        ThreadMessagePurpose::Message | ThreadMessagePurpose::Reply | ThreadMessagePurpose::Warning => {
            "No acknowledgement needed.".to_string()
        }
        ThreadMessagePurpose::Task => String::new(),
    };
    if !guidance.is_empty() {
        out.push_str("\n\n");
        out.push_str(&guidance);
    }
    out
}

/// Provider-facing text for a [`ContentPart::AgentResults`] batch.
pub fn agent_results_text(items: &[AgentResultItem]) -> String {
    let mut out = format!("Results from {} delegated agent(s):", items.len());
    for item in items {
        let model = item.model.as_deref().unwrap_or("default");
        out.push_str(&format!(
            "\n\n- {} ({}/{}, {}) — {} · task {} · thread {}",
            item.title, item.provider, model, item.role, item.status, item.task_id, item.thread_id
        ));
        match item.workspace {
            DelegationWorkspace::Shared => {
                if item.files_touched.is_empty() {
                    out.push_str("\n  workspace: shared checkout, no files touched");
                } else {
                    out.push_str(&format!("\n  files touched: {}", item.files_touched.join(", ")));
                }
            }
            DelegationWorkspace::Worktree => {
                let branch = item.branch.as_deref().unwrap_or("(unknown branch)");
                let commit = item.head_commit.as_deref().unwrap_or("(no commit)");
                out.push_str(&format!("\n  branch {branch} at {commit}"));
                if let Some(base) = item.base_commit.as_deref() {
                    out.push_str(&format!(", based on {base}"));
                }
                if let Some(stat) = item.diffstat {
                    out.push_str(&format!(", {} files +{} −{}", stat.files, stat.additions, stat.deletions));
                }
                match (item.base_commit.as_deref(), item.head_commit.as_deref()) {
                    (Some(base), Some(head)) => out.push_str(&format!(
                        ". If your checkout is clean, merge the branch with git. Otherwise apply only this agent's changes with `git diff {base}..{head} | git apply --3way`; do not merge the branch, because its first commit is a snapshot of your uncommitted changes."
                    )),
                    _ => out.push_str(". Merge it with git."),
                }
            }
        }
        for conflict in &item.conflicts {
            out.push_str(&format!("\n  conflict: edited {} owned by thread {}", conflict.path, conflict.owner_thread_id));
        }
        if item.status != DelegationStatus::Completed
            && let Some(error) = &item.error
        {
            out.push_str("\n  Error: ");
            out.push_str(error);
        }
        match (&item.result, &item.error) {
            (Some(result), _) if !result.trim().is_empty() => {
                out.push_str("\n  Result:\n");
                out.push_str(result);
            }
            (_, Some(error)) if item.status == DelegationStatus::Completed => {
                out.push_str("\n  Error: ");
                out.push_str(error);
            }
            _ => {}
        }
    }
    out.push_str("\n\nIntegrate these results. For another round, delegate again with a full brief.");
    out
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct UserMessage {
    pub parts: Vec<ContentPart>,
}

impl UserMessage {
    pub fn text(text: impl Into<String>) -> Self {
        Self { parts: vec![ContentPart::Text { text: text.into() }] }
    }

    /// Plain-text rendering used for titles and provider prompts.
    pub fn plain_text(&self) -> String {
        let mut out = String::new();
        for p in &self.parts {
            match p {
                ContentPart::Text { text } => out.push_str(text),
                ContentPart::FileMention { path } => {
                    out.push('@');
                    out.push_str(path);
                }
                ContentPart::ThreadReference { thread_id, title, .. } => {
                    out.push_str(&thread_reference_text(*thread_id, title));
                }
                ContentPart::Skill { name, .. } => {
                    out.push('$');
                    out.push_str(name);
                }
                ContentPart::Mention { name, display_name, .. } => {
                    out.push('@');
                    out.push_str(display_name.as_deref().unwrap_or(name));
                }
                ContentPart::ThreadMessage { message_id, from_thread_id, from_title, purpose, reply_to, body } => {
                    out.push_str(&thread_message_text(*message_id, *from_thread_id, from_title, *purpose, *reply_to, body));
                }
                ContentPart::AgentResults { items } => out.push_str(&agent_results_text(items)),
                ContentPart::Image { .. } => out.push_str("[image]"),
                ContentPart::Attachment { name, .. } => {
                    out.push('[');
                    out.push_str(name);
                    out.push(']');
                }
            }
        }
        out
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SkillScope {
    Project,
    Repo,
    User,
    System,
    Admin,
    App,
    /// A provider plugin or connector mentioned with `@name` rather than
    /// invoked as a `$skill`.
    Plugin,
    Other,
}

/// One skill the selected provider can invoke in a project.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SkillInfo {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub path: String,
    pub scope: SkillScope,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_read_tokens: u64,
    #[serde(default)]
    pub cache_write_tokens: u64,
}

impl Usage {
    pub fn add(&mut self, other: &Usage) {
        self.input_tokens += other.input_tokens;
        self.output_tokens += other.output_tokens;
        self.cache_read_tokens += other.cache_read_tokens;
        self.cache_write_tokens += other.cache_write_tokens;
    }
}

/// A durable unit of work started by the provider while handling a thread.
///
/// Providers expose different names for these (subagent, task, background
/// command, monitor). Kybern preserves the provider type while normalizing the
/// lifecycle so every client can render the same activity surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeTaskKind {
    Agent,
    Process,
    Monitor,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeTaskStatus {
    Pending,
    Running,
    Waiting,
    Stopping,
    Completed,
    Failed,
    Stopped,
    Interrupted,
}

impl RuntimeTaskStatus {
    pub fn is_active(self) -> bool {
        matches!(self, Self::Pending | Self::Running | Self::Waiting | Self::Stopping)
    }
}

/// Ownership of provider output after it has been normalized by a driver.
/// Root output is eligible for the parent transcript; agent-owned output is
/// retained as activity metadata and must never be promoted to the root answer.
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EventOrigin {
    #[default]
    Root,
    Agent {
        task_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_thread_id: Option<String>,
    },
}

impl EventOrigin {
    pub fn is_root(&self) -> bool {
        matches!(self, Self::Root)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct RuntimeTaskCapabilities {
    /// The provider exposes a targeted stop operation for this task.
    #[serde(default)]
    pub stop: bool,
    /// The provider can detach this foreground task without interrupting it.
    #[serde(default)]
    pub background: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RuntimeTaskStats {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_uses: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu_percent: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rss_kb: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RuntimeTask {
    /// Provider-stable task, child-thread, tool-call, or process id.
    pub id: String,
    pub thread_id: ThreadId,
    /// Kybern turn that launched this task. Background work can outlive it.
    pub origin_turn_id: TurnId,
    /// Event sequence that first anchored this task in the transcript. Older
    /// stored payloads use zero and are repaired by the event projector.
    #[serde(default)]
    pub started_seq: EventSeq,
    /// Sequence of the latest accepted task snapshot. Progress updates change
    /// this value without changing `started_seq` or the row's visual position.
    #[serde(default)]
    pub updated_seq: EventSeq,
    pub kind: RuntimeTaskKind,
    pub status: RuntimeTaskStatus,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default)]
    pub backgrounded: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
    #[serde(default)]
    pub stats: RuntimeTaskStats,
    #[serde(default)]
    pub capabilities: RuntimeTaskCapabilities,
    pub started_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ThreadActivityState {
    Working,
    Monitoring,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ThreadActivitySummary {
    pub thread_id: ThreadId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<ThreadActivityState>,
    pub active_agents: u32,
    pub active_processes: u32,
    pub active_monitors: u32,
}

/// A pending or resolved request for the user to approve a tool call.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ApprovalRequest {
    pub id: ApprovalId,
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
    /// Provider's tool-call id, when the provider exposes one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    pub tool_name: String,
    /// Provider-native input, rendered by the client (command, file path, diff, ...).
    pub input: Value,
    /// Human-readable one-line summary, e.g. `bash: git status`.
    pub summary: String,
    /// Provider-suggested "always allow" rules the client may offer.
    #[serde(default)]
    pub suggestions: Vec<Value>,
    pub created_at: DateTime<Utc>,
}

impl ApprovalRequest {
    pub fn is_user_input(&self) -> bool {
        matches!(
            self.tool_name.as_str(),
            "AskUserQuestion"
                | "request_user_input"
                | "opencode_question"
                | "mcp_elicitation"
                | "ui_select"
                | "ui_confirm"
                | "ui_input"
                | "ui_editor"
        )
    }

    pub fn validate_decision(&self, decision: &ApprovalDecision) -> Result<(), String> {
        let ApprovalDecision::Submit { response } = decision else {
            return if self.is_user_input() && !matches!(decision, ApprovalDecision::Deny { .. }) {
                Err("This request needs an answer. Submit a response or decline.".into())
            } else {
                Ok(())
            };
        };
        let invalid = || "The response does not match this request. Check the answers and try again.".to_string();
        match self.tool_name.as_str() {
            "AskUserQuestion" | "request_user_input" | "opencode_question" => {
                let questions = self.input.get("questions").and_then(Value::as_array).ok_or_else(invalid)?;
                for (index, question) in questions.iter().enumerate() {
                    let answer = if self.tool_name == "AskUserQuestion" {
                        response.get("answers").and_then(|a| a.get(question.get("question").and_then(Value::as_str).unwrap_or("")))
                    } else if self.tool_name == "request_user_input" {
                        response
                            .get("answers")
                            .and_then(|a| a.get(question.get("id").and_then(Value::as_str).unwrap_or("")))
                            .and_then(|a| a.get("answers"))
                    } else {
                        response.get("answers").and_then(|a| a.get(index))
                    };
                    let valid = if self.tool_name == "AskUserQuestion" {
                        answer.and_then(Value::as_str).is_some_and(|s| !s.trim().is_empty())
                    } else {
                        answer
                            .and_then(Value::as_array)
                            .is_some_and(|a| !a.is_empty() && a.iter().all(|v| v.as_str().is_some_and(|s| !s.trim().is_empty())))
                    };
                    if !valid {
                        return Err(invalid());
                    }
                }
            }
            "ui_confirm" => {
                if !response.get("confirmed").is_some_and(Value::is_boolean) {
                    return Err(invalid());
                }
            }
            "ui_input" | "ui_editor" => {
                if !response.get("value").is_some_and(Value::is_string) {
                    return Err(invalid());
                }
            }
            "ui_select" => {
                if !response
                    .get("value")
                    .is_some_and(|value| self.input.get("options").and_then(Value::as_array).is_some_and(|options| options.contains(value)))
                {
                    return Err(invalid());
                }
            }
            "mcp_elicitation" => {
                if response.get("action").and_then(Value::as_str) != Some("accept") {
                    return Err(invalid());
                }
                if self.input.get("mode").and_then(Value::as_str) != Some("url") {
                    let content = response.get("content").filter(|v| v.is_object()).ok_or_else(invalid)?;
                    let schema = self.input.get("requestedSchema").or_else(|| self.input.get("requested_schema")).ok_or_else(invalid)?;
                    validate_form_value(schema, content)?;
                }
            }
            // Kybern's computer-use consent: `{"scope":"always"}` remembers the app.
            "kybern_computer_use" => {
                if response.get("scope").and_then(Value::as_str) != Some("always") {
                    return Err(invalid());
                }
            }
            _ => return Err("This request needs a permission decision.".into()),
        }
        Ok(())
    }
}

// Elicitation schemas are provider-owned. Validate the structural constraints at
// the daemon boundary as well as the form, so CLI and concurrent clients agree.
fn validate_form_value(schema: &Value, value: &Value) -> Result<(), String> {
    let invalid = || "Check the form values and required fields before submitting.".to_string();
    let valid_type = match schema.get("type").and_then(Value::as_str) {
        Some("object") => value.is_object(),
        Some("array") => value.is_array(),
        Some("string") => value.is_string(),
        Some("boolean") => value.is_boolean(),
        Some("number") => value.is_number(),
        Some("integer") => value.as_i64().is_some() || value.as_u64().is_some(),
        _ => true,
    };
    if !valid_type {
        return Err(invalid());
    }
    if let Some(options) = schema.get("enum").and_then(Value::as_array)
        && !options.contains(value)
    {
        return Err(invalid());
    }
    if let Some(options) = schema.get("oneOf").and_then(Value::as_array)
        && !options.iter().any(|option| option.get("const") == Some(value))
    {
        return Err(invalid());
    }
    if let Some(properties) = schema.get("properties").and_then(Value::as_object) {
        for key in schema.get("required").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
            if value.get(key).is_none() {
                return Err(format!("Provide a value for {key}."));
            }
        }
        for (key, child) in properties {
            if let Some(field) = value.get(key) {
                validate_form_value(child, field)?;
            }
        }
    }
    if let Some(values) = value.as_array() {
        if schema.get("minItems").and_then(Value::as_u64).is_some_and(|n| values.len() < n as usize)
            || schema.get("maxItems").and_then(Value::as_u64).is_some_and(|n| values.len() > n as usize)
        {
            return Err(invalid());
        }
        if let Some(items) = schema.get("items") {
            for item in values {
                validate_form_value(items, item)?;
            }
        }
    }
    if let Some(number) = value.as_f64()
        && (schema.get("minimum").and_then(Value::as_f64).is_some_and(|n| number < n)
            || schema.get("maximum").and_then(Value::as_f64).is_some_and(|n| number > n))
    {
        return Err(invalid());
    }
    if let Some(text) = value.as_str()
        && (schema.get("minLength").and_then(Value::as_u64).is_some_and(|n| text.chars().count() < n as usize)
            || schema.get("maxLength").and_then(Value::as_u64).is_some_and(|n| text.chars().count() > n as usize))
    {
        return Err(invalid());
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "decision", rename_all = "snake_case")]
pub enum ApprovalDecision {
    /// Answer a structured question or form using the provider-native payload.
    Submit {
        response: Value,
    },
    AllowOnce,
    /// Allow and, where the provider supports it, remember for the session.
    AllowAlways,
    Deny {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
}

/// A tool invocation as shown in the transcript.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub input: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    Completed,
    Interrupted,
    MaxTurns,
    Error,
}

/// A durable, sandboxed HTML reply. Source bytes are stored separately from events.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct HtmlVisual {
    pub id: uuid::Uuid,
    pub title: String,
    /// Agent-requested height cap in CSS pixels.
    pub height: u32,
}

/// Rendered transcript entries, projected from events by the daemon.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "role", rename_all = "snake_case")]
pub enum TranscriptEntry {
    Visual {
        turn_id: TurnId,
        seq: EventSeq,
        at: DateTime<Utc>,
        visual: HtmlVisual,
    },
    Image {
        id: String,
        turn_id: TurnId,
        seq: EventSeq,
        at: DateTime<Utc>,
        origin: EventOrigin,
        source: String,
    },
    User {
        id: MessageId,
        turn_id: TurnId,
        #[serde(default)]
        seq: EventSeq,
        message: UserMessage,
        at: DateTime<Utc>,
    },
    Assistant {
        id: MessageId,
        turn_id: TurnId,
        #[serde(default)]
        seq: EventSeq,
        #[serde(default)]
        origin: EventOrigin,
        /// Segment index within one `message_id`. A provider can keep a single
        /// message id across a tool call (Claude streams preamble → tool →
        /// answer under one id); the projection splits the text at each
        /// row-making event so post-tool prose is its own entry, ordered after
        /// the tool. `0` is the first/only segment. `(id, segment)` is the
        /// stable identity a client keys on.
        #[serde(default)]
        segment: u32,
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        thinking: Option<String>,
        /// The provider closed this segment's reasoning before the message
        /// completed. Only meaningful while `complete` is false.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        thinking_complete: bool,
        at: DateTime<Utc>,
        complete: bool,
    },
    ToolCall {
        turn_id: TurnId,
        #[serde(default)]
        seq: EventSeq,
        #[serde(default)]
        origin: EventOrigin,
        call: ToolCall,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output: Option<Value>,
        /// Settled result exists in the event log but was not inlined here.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        output_omitted: bool,
        /// Settled output-delta stream exists in the event log but was not
        /// inlined here. Fetch it through `threads.tool_output`.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        stream_omitted: bool,
        is_error: bool,
        complete: bool,
        at: DateTime<Utc>,
    },
    Approval {
        turn_id: TurnId,
        #[serde(default)]
        seq: EventSeq,
        approval: ApprovalRequest,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        decision: Option<ApprovalDecision>,
    },
    TurnSummary {
        turn_id: TurnId,
        #[serde(default)]
        seq: EventSeq,
        stop_reason: StopReason,
        usage: Usage,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cost_usd: Option<f64>,
        duration_ms: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        terminal_message_id: Option<MessageId>,
        at: DateTime<Utc>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    /// Stable launch row for a provider-owned task. Later snapshots update the
    /// task in place; `seq` remains the first event that made it visible.
    RuntimeTask {
        turn_id: TurnId,
        #[serde(default)]
        seq: EventSeq,
        task: RuntimeTask,
        at: DateTime<Utc>,
    },
    Notice {
        turn_id: TurnId,
        #[serde(default)]
        seq: EventSeq,
        level: NoticeLevel,
        text: String,
        at: DateTime<Utc>,
    },
    Reverted {
        turn_id: TurnId,
        #[serde(default)]
        seq: EventSeq,
        commit: String,
        at: DateTime<Utc>,
    },
}

/// Per-provider configuration in settings.json.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ProviderSettings {
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub accounts: std::collections::BTreeMap<String, ProviderAccount>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_account: Option<String>,
    /// Account overrides keyed by the registered project path.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub project_accounts: std::collections::BTreeMap<String, String>,
    /// Absolute path to the executable; omit to look it up on PATH.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binary: Option<String>,
    /// Default model for new threads.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Extra environment variables for the provider process.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub env: std::collections::BTreeMap<String, String>,
    /// OMP profiles keyed by the registered project's absolute path. Worktrees
    /// inherit their project's profile; an empty value selects OMP's default.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub project_profiles: std::collections::BTreeMap<String, String>,
}

/// User settings persisted at `<data_dir>/settings.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct Settings {
    pub default_provider: ProviderKind,
    pub default_permission_mode: PermissionMode,
    /// Global default for new threads; projects can override.
    pub worktrees_default: bool,
    /// Remove clean, merged, inactive managed worktrees when their thread is archived.
    pub automatic_worktree_cleanup: bool,
    /// Generate thread titles with a model after the first turn.
    pub generate_titles: bool,
    /// Provider used for titles; falls back to the thread's own provider.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title_provider: Option<ProviderKind>,
    pub providers: std::collections::BTreeMap<ProviderKind, ProviderSettings>,
    /// Show OS notifications when a turn ends or needs approval.
    pub notifications: bool,
    /// Check installed harnesses daily and update them when idle. Opt-in per environment.
    pub auto_update_harnesses: bool,
    /// Check the release feed daily and replace this daemon when idle. Opt-in
    /// per environment; ignored for a daemon the desktop app manages.
    pub auto_update_daemon: bool,
    /// How the daemon trims CPU and memory while nothing needs it.
    pub background: BackgroundSettings,
    /// Which networks other devices can reach this daemon on.
    pub access: AccessSettings,
    /// Desktop control through CuaDriver for non-Codex harnesses.
    pub computer_use: ComputerUseSettings,
    /// Limits on agents delegating work to other agents.
    pub orchestration: OrchestrationSettings,
    /// Give new agent sessions a short guide to Kybern: images, notes and
    /// tasks, other threads, helpers. Applies to sessions started after the change.
    pub tell_agents_about_kybern: bool,
}

/// Limits for `kybern_agent_delegate`. Read each time an agent delegates.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct OrchestrationSettings {
    /// Most delegated children one thread may have running at once (1..=16).
    pub max_active_children: u32,
    /// Deepest chain of delegation: 1 means only top-level threads delegate (1..=4).
    pub max_depth: u32,
}

impl Default for OrchestrationSettings {
    fn default() -> Self {
        Self { max_active_children: 4, max_depth: 2 }
    }
}

/// Agents drive apps on this Mac through a separately installed CuaDriver.
/// Codex keeps OpenAI's own computer-use plugin.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct ComputerUseSettings {
    /// Offer the computer tools to new agent sessions.
    pub enabled: bool,
    /// Whether an agent may ask to use the real cursor and focus.
    pub foreground: ComputerForeground,
    /// Draw CuaDriver's agent cursor where agents act. Off by default: the
    /// cursor overlay in CuaDriver 0.28 can hold over a gigabyte of
    /// screen-sized frames.
    pub show_cursor: bool,
    /// Apps (display names) agents may control in the background without
    /// asking. Filled by "Always allow" on the approval card.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub always_allowed_apps: Vec<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ComputerForeground {
    /// Background by default; foreground after the user approves it per app.
    #[default]
    Ask,
    /// Background only.
    Never,
}

/// Extra listeners the daemon opens besides its loopback port. Persisted so
/// a restart keeps the daemon reachable for paired phones.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct AccessSettings {
    /// Also listen on this machine's Tailscale address, so devices on the
    /// same tailnet can pair and connect directly.
    pub tailscale: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            default_provider: ProviderKind::ClaudeCode,
            default_permission_mode: PermissionMode::Supervised,
            worktrees_default: false,
            automatic_worktree_cleanup: false,
            generate_titles: true,
            title_provider: None,
            providers: Default::default(),
            notifications: true,
            auto_update_harnesses: false,
            auto_update_daemon: false,
            background: BackgroundSettings::default(),
            access: AccessSettings::default(),
            computer_use: ComputerUseSettings::default(),
            orchestration: OrchestrationSettings::default(),
            tell_agents_about_kybern: true,
        }
    }
}

/// Limits on what the daemon keeps alive after work finishes. Agent processes
/// are resumed from the provider's own session on the next message, so
/// releasing one loses no conversation. Every value is in minutes; `0` turns
/// that limit off.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct BackgroundSettings {
    /// Minutes an idle thread keeps its agent process before the daemon
    /// releases it. Threads that are running, awaiting approval, or have
    /// background work are never released.
    pub session_idle_minutes: u32,
    /// Most idle agent processes kept warm at once. The least recently used
    /// are released first, even before their idle time is up.
    pub max_idle_sessions: u32,
    /// Minutes a shell with no attached client and no foreground job stays
    /// open before the daemon closes it.
    pub terminal_idle_minutes: u32,
    /// Minutes with no clients, agents, terminals, or queued work before the
    /// daemon exits. Only for daemons the desktop app starts on demand: the
    /// CLI and remote clients do not restart a daemon that has exited.
    pub daemon_idle_exit_minutes: u32,
    /// While the host runs on battery, release idle agent processes after
    /// `BATTERY_SESSION_IDLE` instead of `session_idle_minutes` and hold
    /// automatic harness updates until power returns.
    pub save_power_on_battery: bool,
}

impl Default for BackgroundSettings {
    fn default() -> Self {
        Self {
            session_idle_minutes: 10,
            max_idle_sessions: 4,
            terminal_idle_minutes: 60,
            daemon_idle_exit_minutes: 0,
            save_power_on_battery: false,
        }
    }
}

impl BackgroundSettings {
    fn minutes(value: u32) -> Option<std::time::Duration> {
        (value > 0).then(|| std::time::Duration::from_secs(u64::from(value) * 60))
    }
    /// `None` keeps idle agent processes indefinitely.
    pub fn session_idle(&self) -> Option<std::time::Duration> {
        Self::minutes(self.session_idle_minutes)
    }
    /// `None` keeps every idle agent process.
    pub fn idle_session_cap(&self) -> Option<usize> {
        (self.max_idle_sessions > 0).then_some(self.max_idle_sessions as usize)
    }
    /// `None` keeps detached shells open until they exit or are closed.
    pub fn terminal_idle(&self) -> Option<std::time::Duration> {
        Self::minutes(self.terminal_idle_minutes)
    }
    /// `None` keeps the daemon running until it is stopped.
    pub fn daemon_idle_exit(&self) -> Option<std::time::Duration> {
        Self::minutes(self.daemon_idle_exit_minutes)
    }
    /// Grace an idle agent process gets on battery before it is released:
    /// long enough to answer a follow-up without a resume, short enough to
    /// matter for the battery.
    pub const BATTERY_SESSION_IDLE: std::time::Duration = std::time::Duration::from_secs(60);
}

/// Why the daemon closed an agent process. The thread's conversation is kept
/// by the provider and resumes with the next message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SessionReleaseReason {
    /// The user released a parked process to reconnect on the next message.
    Manual,
    /// The thread was idle for longer than `background.session_idle_minutes`.
    Idle,
    /// More idle processes were alive than `background.max_idle_sessions`.
    Capacity,
    /// The harness was closed so it could be updated.
    Update,
    /// The host is on battery and `background.save_power_on_battery` is on.
    Power,
}

impl SessionReleaseReason {
    /// Transcript copy for the releases that can surprise. Idle and update
    /// releases are the expected end of a quiet thread and get no row.
    /// Mirrored in `apps/desktop/src/state/transcript.ts` for live events.
    pub fn notice_text(self) -> Option<&'static str> {
        match self {
            Self::Manual => Some("Agent released. Your next message resumes the saved conversation."),
            Self::Capacity => Some("Agent process closed to stay under the warm limit. Your next message resumes it."),
            Self::Power => Some("Agent process closed to save battery. Your next message resumes it."),
            Self::Idle | Self::Update => None,
        }
    }
}

/// Git snapshots bracketing one turn. `after` is absent while the turn runs.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Checkpoint {
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
    /// Commit hash of the working tree before the turn started.
    pub before: String,
    /// Commit hash after the turn ended.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<String>,
    /// Provider-side id of this turn, for conversation rewind.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_turn_id: Option<String>,
    /// Provider-side id of the last entry of this turn, for conversation rewind.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_turn_end: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    TypeChanged,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct FileChange {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub status: FileStatus,
    pub additions: u32,
    pub deletions: u32,
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Diff {
    pub from: String,
    pub to: String,
    pub files: Vec<FileChange>,
    /// Unified diff text (`git diff --no-color`), empty when nothing changed.
    pub patch: String,
    /// True when an oversized patch was cut to the daemon's transport limit.
    #[serde(default)]
    pub patch_truncated: bool,
}

/// Last daemon-owned harness update attempt. Persisted across client reconnects.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct HarnessUpdate {
    pub kind: ProviderKind,
    pub status: HarnessUpdateStatus,
    pub message: String,
    pub version: Option<String>,
    pub checked_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum HarnessUpdateStatus {
    NotChecked,
    Waiting,
    Updating,
    Updated,
    Current,
    Unsupported,
    Failed,
}

/// The daemon's own update state. The daemon replaces its binary from the
/// GitHub release feed and restarts under its service manager; persisted so
/// clients see the same record after a reconnect or the restart itself.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DaemonUpdate {
    pub status: DaemonUpdateStatus,
    pub message: String,
    /// Version of the running daemon.
    pub current_version: String,
    /// Newest published version, once a check has succeeded.
    pub latest_version: Option<String>,
    pub checked_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DaemonUpdateStatus {
    NotChecked,
    Checking,
    Current,
    Available,
    Waiting,
    Updating,
    Restarting,
    Unsupported,
    Failed,
}

/// Authoritative context occupancy, distinct from cumulative billable tokens.
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct ProviderUsage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<ContextUsage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limits: Option<Vec<UsageLimit>>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ContextUsage {
    pub used_tokens: u64,
    pub window_tokens: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct UsageLimit {
    pub name: String,
    pub used_percent: f64,
    pub window_minutes: Option<u64>,
    pub resets_at: Option<i64>,
}

/// A provider question that does not pause the running turn.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct AsyncQuestion {
    pub title: String,
    #[serde(default, deserialize_with = "deserialize_null_options")]
    pub options: Vec<String>,
}

fn deserialize_null_options<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Vec<String>, D::Error> {
    Ok(Option::<Vec<String>>::deserialize(deserializer)?.unwrap_or_default())
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct AsyncQuestionRequest {
    pub id: String,
    pub questions: Vec<AsyncQuestion>,
}

#[cfg(test)]
mod orchestration_tests {
    use super::*;

    fn id(n: u128) -> Uuid {
        Uuid::from_u128(n)
    }

    #[test]
    fn thread_reference_text_tells_the_agent_how_to_read_and_message_the_thread() {
        let text = thread_reference_text(id(1), "Fix login");
        assert_eq!(
            text,
            format!("@thread[{}] Fix login (you can read it with kybern_thread_read and message it with kybern_thread_send)", id(1))
        );
    }

    #[test]
    fn question_message_asks_for_a_reply_and_names_the_fallback() {
        let text = thread_message_text(id(9), Some(id(2)), "Parent", ThreadMessagePurpose::Question, None, "What is the port?");
        assert_eq!(
            text,
            format!(
                "Message from thread \"Parent\" ({}) · question · id {}:\nWhat is the port?\n\nReply with kybern_thread_send to {} with purpose \"reply\" and reply_to \"{}\". If you do not, your final message this turn is sent back as the reply.",
                id(2),
                id(9),
                id(2),
                id(9)
            )
        );
    }

    #[test]
    fn reply_task_and_kybern_warning_use_the_contract_wording() {
        let reply = thread_message_text(id(9), Some(id(2)), "Child", ThreadMessagePurpose::Reply, Some(id(7)), "8080");
        assert!(reply.starts_with(&format!(
            "Message from thread \"Child\" ({}) · reply · id {} · reply to {}:\n8080",
            id(2),
            id(9),
            id(7)
        )));
        assert!(reply.ends_with("\n\nNo acknowledgement needed."));

        let task = thread_message_text(id(9), Some(id(2)), "Parent", ThreadMessagePurpose::Task, None, "Do the thing");
        assert!(task.ends_with(":\nDo the thing"), "a task carries its own brief and no guidance: {task}");

        let warning = thread_message_text(id(9), None, "Kybern", ThreadMessagePurpose::Warning, None, "stop");
        assert_eq!(warning, format!("Message from Kybern · warning · id {}:\nstop\n\nNo acknowledgement needed.", id(9)));
    }

    fn item(workspace: DelegationWorkspace) -> AgentResultItem {
        AgentResultItem {
            task_id: id(3),
            thread_id: id(4),
            title: "Port the parser".into(),
            provider: ProviderKind::Codex,
            model: Some("gpt-5".into()),
            role: DelegationRole::Implementation,
            status: DelegationStatus::Completed,
            result: Some("Done. Tests pass.".into()),
            error: None,
            workspace,
            branch: Some("kybern/abc".into()),
            head_commit: Some("1234567".into()),
            base_commit: Some("abcdef0".into()),
            diffstat: Some(DiffStat { files: 2, additions: 10, deletions: 4 }),
            files_touched: vec!["a.rs".into(), "b.rs".into()],
            conflicts: Vec::new(),
        }
    }

    #[test]
    fn agent_results_list_each_agent_with_its_workspace_and_result() {
        let mut failed = item(DelegationWorkspace::Shared);
        failed.status = DelegationStatus::Failed;
        failed.result = None;
        failed.error = Some("boom".into());
        failed.files_touched.clear();
        failed.conflicts =
            vec![DelegationConflict { path: "src/x.rs".into(), owner_thread_id: id(5), at: chrono::DateTime::<Utc>::default() }];
        let text = agent_results_text(&[item(DelegationWorkspace::Worktree), item(DelegationWorkspace::Shared), failed]);
        assert!(text.starts_with("Results from 3 delegated agent(s):"));
        assert!(text.contains(&format!("- Port the parser (codex/gpt-5, implementation) — completed · task {} · thread {}", id(3), id(4))));
        assert!(
            text.contains(
                "branch kybern/abc at 1234567, based on abcdef0, 2 files +10 −4. If your checkout is clean, merge the branch with git."
            ),
            "{text}"
        );
        assert!(text.contains("`git diff abcdef0..1234567 | git apply --3way`"), "{text}");
        let mut bare = item(DelegationWorkspace::Worktree);
        bare.base_commit = None;
        assert!(agent_results_text(&[bare]).contains("branch kybern/abc at 1234567, 2 files +10 −4. Merge it with git."));
        assert!(text.contains("files touched: a.rs, b.rs"));
        assert!(text.contains("Result:\nDone. Tests pass."));
        assert!(text.contains(&format!("conflict: edited src/x.rs owned by thread {}", id(5))));
        assert!(text.contains("Error: boom"));
        assert!(text.ends_with("Integrate these results. For another round, delegate again with a full brief."));
    }

    #[test]
    fn interrupted_agents_show_their_error_next_to_the_partial_result() {
        let mut interrupted = item(DelegationWorkspace::Shared);
        interrupted.status = DelegationStatus::Interrupted;
        interrupted.result = Some("Waiting for sleep".into());
        interrupted.error = Some("interrupted by a Kybern restart".into());
        let text = agent_results_text(&[interrupted]);
        assert!(text.contains("Error: interrupted by a Kybern restart"), "{text}");
        assert!(text.contains("Result:\nWaiting for sleep"), "{text}");
    }

    #[test]
    fn orchestration_text_is_only_for_the_new_parts() {
        assert!(ContentPart::Text { text: "x".into() }.orchestration_text().is_none());
        assert!(ContentPart::AgentResults { items: Vec::new() }.orchestration_text().unwrap().starts_with("Results from 0"));
    }

    #[test]
    fn new_parts_roundtrip_and_plain_text_flattens_them() {
        let message = UserMessage {
            parts: vec![
                ContentPart::ThreadMessage {
                    message_id: id(1),
                    from_thread_id: Some(id(2)),
                    from_title: "Parent".into(),
                    purpose: ThreadMessagePurpose::Task,
                    reply_to: None,
                    body: "brief".into(),
                },
                ContentPart::AgentResults { items: vec![item(DelegationWorkspace::Shared)] },
            ],
        };
        let wire = serde_json::to_value(&message).unwrap();
        assert_eq!(wire["parts"][0]["type"], "thread_message");
        assert_eq!(wire["parts"][1]["type"], "agent_results");
        assert!(wire["parts"][0].get("reply_to").is_none());
        let restored: UserMessage = serde_json::from_value(wire).unwrap();
        assert_eq!(restored, message);
        let text = restored.plain_text();
        assert!(text.contains("brief") && text.contains("Results from 1 delegated agent(s):"));
    }

    #[test]
    fn thread_omits_delegation_when_absent_and_old_payloads_still_parse() {
        let now = Utc::now();
        let mut thread = serde_json::json!({
            "id": id(1), "project_id": id(2), "title": "t",
            "provider": { "kind": "codex", "instance": "default" },
            "permission_mode": "supervised", "status": "idle", "cwd": "/",
            "pinned": false, "created_at": now, "updated_at": now, "last_seq": 0
        });
        let parsed: Thread = serde_json::from_value(thread.clone()).unwrap();
        assert!(parsed.delegation.is_none());
        assert!(serde_json::to_value(&parsed).unwrap().get("delegation").is_none());
        thread["delegation"] = serde_json::json!({
            "task_id": id(3), "operation_id": id(4), "parent_thread_id": id(5), "depth": 1,
            "role": "research", "workspace": "worktree", "status": "interrupted", "started_at": now
        });
        let parsed: Thread = serde_json::from_value(thread).unwrap();
        let delegation = parsed.delegation.unwrap();
        assert_eq!(delegation.status, DelegationStatus::Interrupted);
        assert_eq!(delegation.workspace, DelegationWorkspace::Worktree);
        assert!(delegation.owns.is_empty() && delegation.files_touched.is_empty());
    }

    #[test]
    fn orchestration_settings_default_and_partial_parse() {
        assert_eq!(Settings::default().orchestration, OrchestrationSettings { max_active_children: 4, max_depth: 2 });
        let settings: Settings = serde_json::from_value(serde_json::json!({ "orchestration": { "max_depth": 3 } })).unwrap();
        assert_eq!(settings.orchestration, OrchestrationSettings { max_active_children: 4, max_depth: 3 });
        let legacy: Settings = serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(legacy.orchestration, OrchestrationSettings::default());
    }
}

/// Delivery through one native child's next tool callback. Pending is not delivered.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SubagentMessageStatus {
    Pending,
    Delivered,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SubagentMessage {
    pub id: MessageId,
    pub thread_id: ThreadId,
    pub root_thread_id: ThreadId,
    pub task_id: String,
    /// Daemon-local admitted process. Never reuse this input in a replacement session.
    pub native_task_id: String,
    pub session_instance_id: uuid::Uuid,
    pub turn_id: TurnId,
    pub message: UserMessage,
    pub status: SubagentMessageStatus,
    pub error: Option<String>,
    pub parent_message_id: Option<MessageId>,
    pub parent_queued: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}
