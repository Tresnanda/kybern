//! Native drivers for coding agents.
//!
//! Each provider gets its own module speaking that provider's own protocol.
//! The daemon only sees [`AgentDriver`] and [`AgentSession`]: it spawns a
//! session per thread, feeds it user messages, answers permission requests,
//! and turns [`DriverEvent`]s into persisted thread events.

pub mod binary;
pub mod claude;
mod claude_config;
pub mod codex;
pub mod cursor;
pub mod ndjson;
pub mod opencode;
pub mod pi;
pub mod registry;

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;

use async_trait::async_trait;
use kybern_protocol::*;
use serde_json::Value;
use tokio::sync::mpsc;

#[derive(Debug, thiserror::Error)]
pub enum DriverError {
    #[error("provider binary not found: {0}")]
    BinaryNotFound(String),
    #[error("provider version {found} is older than required {required}")]
    VersionTooOld { found: String, required: String },
    #[error("provider process exited: {0}")]
    ProcessExited(String),
    #[error("protocol error: {0}")]
    Protocol(String),
    #[error("unsupported: {0}")]
    Unsupported(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

pub type Result<T> = std::result::Result<T, DriverError>;

/// Read-only context used while discovering a provider's installed
/// capabilities and effective defaults.
///
/// Provider catalogs are not always machine-global. Claude Code, for example,
/// layers user, project, local, managed, and environment settings. Keeping the
/// context here lets each native driver follow its own harness semantics.
#[derive(Debug, Clone, Default)]
pub struct ProbeContext {
    pub binary: Option<PathBuf>,
    pub cwd: Option<PathBuf>,
    pub env: BTreeMap<String, String>,
}

/// Everything a driver needs to start (or resume) a provider session.
#[derive(Debug, Clone)]
pub struct SessionConfig {
    pub cwd: PathBuf,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: PermissionMode,
    /// Resume this provider session instead of starting fresh.
    pub resume_session_id: Option<String>,
    /// When resuming, fork into a new provider session (used by rewind).
    pub fork: bool,
    /// When forking, drop everything after this point in the provider conversation.
    pub rewind: Option<RewindPoint>,
    /// Absolute path to the provider binary; `None` means look up on PATH.
    pub binary: Option<PathBuf>,
    pub env: HashMap<String, String>,
}

/// Provider-side identifiers of a turn boundary, recorded when the turn completed.
#[derive(Debug, Clone, Default)]
pub struct TurnAnchors {
    /// Provider id of the turn being dropped (Codex turn id, OpenCode user message id, Claude user uuid).
    pub turn_id: Option<String>,
    /// Provider id of the last entry of the previous turn (Claude: last assistant uuid).
    pub previous_end: Option<String>,
}

/// Where to cut the conversation when forking for a rewind.
#[derive(Debug, Clone)]
pub struct RewindPoint {
    /// Anchors of the first turn to drop.
    pub drop_from: TurnAnchors,
    /// Anchors of the last turn to keep, if any.
    pub keep_through: Option<TurnAnchors>,
}

/// Provider-normalized task metadata. The daemon adds Kybern thread/turn ids
/// and durable timestamps before publishing it.
#[derive(Debug, Clone)]
pub struct DriverRuntimeTask {
    pub id: String,
    pub kind: RuntimeTaskKind,
    pub status: RuntimeTaskStatus,
    pub title: String,
    pub detail: Option<String>,
    pub provider_type: Option<String>,
    pub parent_id: Option<String>,
    pub tool_call_id: Option<String>,
    pub provider_thread_id: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub backgrounded: bool,
    pub last_tool_name: Option<String>,
    pub usage: Option<Usage>,
    pub stats: RuntimeTaskStats,
    pub capabilities: RuntimeTaskCapabilities,
}

#[derive(Debug, Clone)]
pub struct DriverRuntimeTaskUpdate {
    pub id: String,
    pub status: Option<RuntimeTaskStatus>,
    pub detail: Option<String>,
    pub backgrounded: Option<bool>,
    pub last_tool_name: Option<String>,
    pub usage: Option<Usage>,
    pub stats: Option<RuntimeTaskStats>,
    pub capabilities: Option<RuntimeTaskCapabilities>,
}

impl DriverRuntimeTaskUpdate {
    pub fn status(id: impl Into<String>, status: RuntimeTaskStatus) -> Self {
        Self {
            id: id.into(),
            status: Some(status),
            detail: None,
            backgrounded: None,
            last_tool_name: None,
            usage: None,
            stats: None,
            capabilities: None,
        }
    }
}

/// Normalized stream of what a provider is doing. Ordered per session.
#[derive(Debug, Clone)]
pub enum DriverEvent {
    /// Provider reported its session id and effective model.
    SessionBound {
        session_id: String,
        model: Option<String>,
    },
    TextDelta {
        message_id: String,
        origin: EventOrigin,
        delta: String,
    },
    ThinkingDelta {
        message_id: String,
        origin: EventOrigin,
        delta: String,
    },
    /// Full text of an assistant message once the provider finalizes it.
    MessageCompleted {
        message_id: String,
        origin: EventOrigin,
        text: String,
        thinking: Option<String>,
    },
    ToolStarted(ToolCall),
    /// Incremental output from a running tool (command stdout, patch progress).
    ToolOutputDelta {
        tool_call_id: String,
        delta: String,
    },
    ToolCompleted {
        tool_call_id: String,
        output: Value,
        is_error: bool,
    },
    RuntimeTaskStarted(DriverRuntimeTask),
    RuntimeTaskUpdated(DriverRuntimeTaskUpdate),
    RuntimeTaskCompleted(DriverRuntimeTaskUpdate),
    /// The provider is blocked waiting for `respond_permission`.
    PermissionRequest {
        request_id: String,
        tool_call_id: Option<String>,
        tool_name: String,
        input: Value,
        summary: String,
        suggestions: Vec<Value>,
    },
    /// The provider withdrew a pending permission request (tool was cancelled).
    PermissionWithdrawn {
        request_id: String,
    },
    TurnCompleted {
        stop_reason: StopReason,
        usage: Usage,
        cost_usd: Option<f64>,
        duration_ms: u64,
        anchors: TurnAnchors,
    },
    TurnFailed {
        error: String,
    },
    Notice {
        level: NoticeLevel,
        text: String,
        data: Option<Value>,
    },
    /// The provider process ended. No further events follow.
    Exited {
        code: Option<i32>,
        error: Option<String>,
    },
}

#[async_trait]
pub trait AgentSession: Send + Sync {
    /// Queue a user turn. `message_id` is kybern's id for the message; drivers that
    /// accept a client-chosen id use it so rewinds can reference the turn.
    async fn send_message(&self, message_id: &str, message: &UserMessage) -> Result<()>;
    async fn interrupt(&self) -> Result<()>;
    async fn set_permission_mode(&self, mode: PermissionMode) -> Result<()>;
    async fn set_model(&self, model: &str) -> Result<()>;
    async fn set_effort(&self, effort: &str) -> Result<()>;
    async fn respond_permission(&self, request_id: &str, decision: &ApprovalDecision) -> Result<()>;
    /// Stop one provider-owned subagent or background process without
    /// interrupting unrelated work in the parent thread.
    async fn stop_runtime_task(&self, _task: &RuntimeTask) -> Result<()> {
        Err(DriverError::Unsupported("targeted task stop".into()))
    }
    /// Detach a foreground provider task so the parent can continue.
    async fn background_runtime_task(&self, _task: &RuntimeTask) -> Result<()> {
        Err(DriverError::Unsupported("task backgrounding".into()))
    }
    /// Graceful shutdown. The event stream ends with `Exited`.
    async fn close(&self) -> Result<()>;
}

pub struct SpawnedSession {
    pub session: Box<dyn AgentSession>,
    pub events: mpsc::Receiver<DriverEvent>,
}

#[async_trait]
pub trait AgentDriver: Send + Sync {
    fn kind(&self) -> ProviderKind;
    /// Look for the binary, read its version, report capabilities.
    async fn probe(&self, binary: Option<&PathBuf>) -> ProviderStatus;
    /// Probe with the same project and environment that a new session would
    /// inherit. Drivers whose catalog is machine-global can use `probe`.
    async fn probe_with_context(&self, context: &ProbeContext) -> ProviderStatus {
        self.probe(context.binary.as_ref()).await
    }
    /// Whether `spawn` with `fork: true` can drop turns from the conversation.
    fn supports_fork(&self) -> bool {
        true
    }
    /// Run a single tool-free prompt and return the model's text. Used for thread titles.
    async fn one_shot(&self, _cwd: &std::path::Path, _prompt: &str, _binary: Option<&PathBuf>) -> Result<String> {
        Err(DriverError::Unsupported("one-shot prompts".into()))
    }
    async fn spawn(&self, config: SessionConfig) -> Result<SpawnedSession>;
}

/// One-line human summary of a tool call, for approval cards and notifications.
pub fn summarize_tool_call(name: &str, input: &Value) -> String {
    let short =
        |key: &str| input.get(key).and_then(|v| v.as_str()).map(|s| s.lines().next().unwrap_or("").chars().take(120).collect::<String>());
    match name {
        "Bash" | "bash" | "shell" | "execute" => short("command").map(|c| format!("run: {c}")).unwrap_or_else(|| name.to_string()),
        "Edit" | "Write" | "MultiEdit" | "edit" | "write" | "apply_patch" => short("file_path")
            .or_else(|| short("path"))
            .map(|p| format!("{}: {p}", name.to_lowercase()))
            .unwrap_or_else(|| name.to_string()),
        "Read" | "read" => short("file_path").or_else(|| short("path")).map(|p| format!("read: {p}")).unwrap_or_else(|| name.to_string()),
        "WebFetch" | "webfetch" => short("url").map(|u| format!("fetch: {u}")).unwrap_or_else(|| name.to_string()),
        _ => name.to_string(),
    }
}
