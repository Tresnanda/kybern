//! Continue on another machine (ADE-86 M3 / F2, design §7.2).
//!
//! A move is a fork that ends the source: the work (a hand-off note, the branch and a snapshot of the
//! uncommitted changes) and the visible transcript go to the target, and the source thread becomes
//! read-only with a link to the continuation. The whole move is one outbox item (`OutboxKind::Move`),
//! so an offline target receives it when it returns, and a running thread moves when its turn ends.
//!
//! The source (A) takes a **lease** on the thread (`Thread.moved`, state `departing`): sends are
//! refused until the target (B) confirms or the move is aborted. `peer.move.prepare` reserves a slot
//! on B, `peer.move.commit` creates the thread there from the carried history, `peer.move.get` tells a
//! recovering A what happened to a commit it never heard back about, and `peer.move.abort` releases
//! B's slot. B deduplicates every call by `operation_id`. The branch travels with `peer.git.bundle`
//! and `peer.git.import`, as in a fork.

use chrono::{DateTime, Utc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{MachineId, Origin, OutboxItem, PermissionMode, ProviderKind, RepoIdentity, ThreadId};

pub use crate::outbox::NEEDS_BUNDLE as MOVE_NEEDS_BUNDLE;

/// The most history one move carries (JSON bytes). The newest items are kept.
pub const MAX_HISTORY_BYTES: usize = 2 * 1024 * 1024;

/// How long the source holds its lease, and the target its copy of it, without a renewal.
pub const MOVE_LEASE_SECONDS: i64 = 10 * 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum HistoryRole {
    User,
    Assistant,
    /// A tool call, as a one-line summary without its output.
    Tool,
    /// A notice the thread showed (compaction, a fork or move link).
    Notice,
}

/// One entry of the conversation a moved thread brings along.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct HistoryItem {
    pub role: HistoryRole,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<DateTime<Utc>>,
    /// The tool's name, for `tool` items.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
}

/// `threads.move_to_machine`: queue a move of `thread_id` to `machine`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ThreadsMoveToMachineParams {
    pub thread_id: ThreadId,
    /// The target machine's name or id.
    pub machine: String,
    /// Picks one of the target's projects when more than one has this repository: an id, a name or a path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    /// The hand-off note the user edited. Omit to send the note `threads.fork_note` shows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handoff_note: Option<String>,
    /// Title of the continuing thread; defaults to the source's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// The harness for the continuing thread; defaults to the source's when the target has it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<ProviderKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    /// The new thread's permission mode, which also caps it. Defaults to the source thread's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<PermissionMode>,
    /// Reuse the same key to make a repeated request return the first move.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<Uuid>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ThreadsMoveToMachineResult {
    pub operation_id: Uuid,
    /// The queued outbox item; its `result` holds the continuing thread once the move is done. Retry
    /// and Keep here are `outbox.retry` and `outbox.cancel` on it.
    pub item: OutboxItem,
    pub target_name: String,
    /// The note that will be sent.
    pub handoff_note: String,
}

/// `threads.move_abandon`: give up a move whose outcome is unknown, or one still waiting.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ThreadsMoveAbandonParams {
    pub thread_id: ThreadId,
    /// Give up even when the target cannot be asked. If it had already created the thread, there are then two.
    #[serde(default)]
    pub force: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MoveAbandonOutcome {
    /// The thread is yours again.
    Released,
    /// The target had already created the thread, so the move is done: the source is read-only with the link.
    Completed,
    /// There was no move to abandon.
    Nothing,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ThreadsMoveAbandonResult {
    pub outcome: MoveAbandonOutcome,
}

/// `peer.move.prepare`: A asks B to reserve a slot for the move. B checks the repository, the harness
/// and the disk. It asks for the branch first (`"needs": "bundle"`) when it lacks the commit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PeerMovePrepareParams {
    /// A's operation id. B namespaces it by the origin, so a repeat finds the first slot.
    pub operation_id: Uuid,
    /// `kind: move`, the source thread and the permission cap. B replaces the machine with the session's.
    pub origin: Origin,
    pub source_title: String,
    pub repo: RepoIdentity,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    /// The branch on A that holds the snapshot; B uses the same name for its worktree.
    pub branch: String,
    pub commit: String,
    pub provider: ProviderKind,
    /// The user named the harness, so B must not swap it for another.
    #[serde(default)]
    pub provider_chosen: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    pub permission_mode: PermissionMode,
    /// How many bytes of history `peer.move.commit` will carry, so B can refuse before the work is sent.
    #[serde(default)]
    pub history_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PeerMovePrepareResult {
    /// When B drops the slot unless A commits or renews by calling `prepare` again.
    pub lease_until: DateTime<Utc>,
    pub project_name: String,
    pub provider: ProviderKind,
}

/// `peer.move.commit`: A asks B to create the thread from the carried history.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PeerMoveCommitParams {
    pub operation_id: Uuid,
    /// The hand-off note, which becomes the first message together with the link back.
    pub handoff_note: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub from_thread: ThreadId,
    pub from_title: String,
    pub items: Vec<HistoryItem>,
    /// Items dropped from the front to fit [`MAX_HISTORY_BYTES`].
    #[serde(default)]
    pub omitted: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PeerMoveCommitResult {
    pub thread_id: ThreadId,
    pub machine_id: MachineId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_name: Option<String>,
    pub branch: String,
    pub provider: ProviderKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PeerMoveRefParams {
    pub operation_id: Uuid,
    /// The source thread, which with the operation id names the move on B.
    pub from_thread: ThreadId,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PeerMoveState {
    /// B never heard of the move, or dropped it.
    Unknown,
    Prepared,
    Committed,
    Aborted,
}

/// `peer.move.get` and `peer.move.abort`: where the move stands on B.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PeerMoveStatus {
    pub state: PeerMoveState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine_id: Option<MachineId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<ProviderKind>,
}
