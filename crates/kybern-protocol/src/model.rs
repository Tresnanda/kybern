//! Domain model shared by daemon and clients.

use chrono::{DateTime, Utc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

pub type ProjectId = Uuid;
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

/// Availability of a provider binary on the daemon host.
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
    pub instances: Vec<String>,
}

/// The four permission modes, mirroring T3 Code.
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "decision", rename_all = "snake_case")]
pub enum ApprovalDecision {
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

/// Rendered transcript entries, projected from events by the daemon.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "role", rename_all = "snake_case")]
pub enum TranscriptEntry {
    User {
        id: MessageId,
        turn_id: TurnId,
        message: UserMessage,
        at: DateTime<Utc>,
    },
    Assistant {
        id: MessageId,
        turn_id: TurnId,
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        thinking: Option<String>,
        at: DateTime<Utc>,
        complete: bool,
    },
    ToolCall {
        turn_id: TurnId,
        call: ToolCall,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output: Option<Value>,
        is_error: bool,
        complete: bool,
        at: DateTime<Utc>,
    },
    Approval {
        turn_id: TurnId,
        approval: ApprovalRequest,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        decision: Option<ApprovalDecision>,
    },
    TurnSummary {
        turn_id: TurnId,
        stop_reason: StopReason,
        usage: Usage,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cost_usd: Option<f64>,
        duration_ms: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
}

/// Per-provider configuration in settings.json.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ProviderSettings {
    /// Absolute path to the executable; omit to look it up on PATH.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binary: Option<String>,
    /// Default model for new threads.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Extra environment variables for the provider process.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub env: std::collections::BTreeMap<String, String>,
}

/// User settings persisted at `<data_dir>/settings.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct Settings {
    pub default_provider: ProviderKind,
    pub default_permission_mode: PermissionMode,
    /// Global default for new threads; projects can override.
    pub worktrees_default: bool,
    /// Generate thread titles with a model after the first turn.
    pub generate_titles: bool,
    /// Provider used for titles; falls back to the thread's own provider.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title_provider: Option<ProviderKind>,
    pub providers: std::collections::BTreeMap<ProviderKind, ProviderSettings>,
    /// Show OS notifications when a turn ends or needs approval.
    pub notifications: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            default_provider: ProviderKind::ClaudeCode,
            default_permission_mode: PermissionMode::Supervised,
            worktrees_default: false,
            generate_titles: true,
            title_provider: None,
            providers: Default::default(),
            notifications: true,
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
}
