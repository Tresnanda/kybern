//! Fork to a machine (ADE-86 M3 / F1, design §7.1).
//!
//! A fork gives another machine a copy of a thread's work: a hand-off note, the fork branch and a
//! snapshot of the uncommitted changes. Both threads stay live. The whole fork is one outbox item
//! (`OutboxKind::Fork`), so an offline machine receives it when it returns. `threads.fork_note` shows
//! the note to edit, `threads.fork_to_machine` queues the fork, and `peer.fork` is what the source
//! machine says to the target once it is online. The branch itself travels with `peer.git.bundle` and
//! `peer.git.import`.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{MachineId, Origin, OutboxItem, PermissionMode, ProviderKind, RepoIdentity, ThreadId};

/// The error `data` of a `peer.fork` that needs the fork branch first (`"needs": "bundle"`); the same
/// word `peer.delegate` uses.
pub use crate::outbox::NEEDS_BUNDLE as FORK_NEEDS_BUNDLE;

/// `threads.fork_note`: the hand-off note Kybern would send for this thread, so a client can show it in
/// a sheet and let the user edit it before forking.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ThreadsForkNoteParams {
    pub thread_id: ThreadId,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ThreadsForkNoteResult {
    pub note: String,
}

/// `threads.fork_to_machine`: queue a fork of `thread_id` for `machine`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ThreadsForkToMachineParams {
    pub thread_id: ThreadId,
    /// The target machine's name or id.
    pub machine: String,
    /// Picks one of the target's projects when more than one has this repository: an id, a name or a path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    /// Also push the fork branch to `origin`. Off by default: the repository may be public.
    #[serde(default)]
    pub push_origin: bool,
    /// The hand-off note the user edited. Omit to send the note `threads.fork_note` shows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handoff_note: Option<String>,
    /// Title of the new thread; defaults to the source's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// The harness for the new thread; defaults to the source's when the target has it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<ProviderKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    /// The new thread's permission mode, which also caps it. Defaults to the source thread's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<PermissionMode>,
    /// Reuse the same key to make a repeated request return the first fork.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<Uuid>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ThreadsForkToMachineResult {
    pub operation_id: Uuid,
    /// The queued outbox item; its `result` holds the new thread once it is delivered.
    pub item: OutboxItem,
    pub target_name: String,
    /// The fork branch in the source checkout (`kybern/fork-<short id>`).
    pub branch: String,
    /// The commit the branch points to: the snapshot of the work.
    pub commit: String,
    /// The note that was sent.
    pub handoff_note: String,
}

/// `peer.fork`: A asks B to open the forked thread. The branch was imported with `peer.git.import`
/// first when B asked for it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PeerForkParams {
    /// A's operation id. B namespaces it by the origin, so a repeat finds the first thread.
    pub operation_id: Uuid,
    /// `kind: fork`, the source thread and the permission cap. B replaces the machine with the session's.
    pub origin: Origin,
    /// The source thread's title, for the new thread's first message and default title.
    pub source_title: String,
    /// The hand-off note, which becomes the new thread's first message together with the link back.
    pub handoff_note: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// The repository, to find the matching checkout on B.
    pub repo: RepoIdentity,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    /// The fork branch's name on A; B uses the same name for its worktree.
    pub branch: String,
    /// The commit the branch points to.
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
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PeerForkResult {
    pub thread_id: ThreadId,
    pub machine_id: MachineId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_name: Option<String>,
    /// The branch the new thread's worktree is on.
    pub branch: String,
    /// The harness the thread runs, which differs from the request only when B lacked the default.
    pub provider: ProviderKind,
}

/// The link from the new thread back to its source: `kybern://thread/<machine>/<thread>`.
pub fn thread_link(machine_id: &str, thread_id: ThreadId) -> String {
    format!("kybern://thread/{machine_id}/{thread_id}")
}
