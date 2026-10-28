//! Forwarded agent tools (ADE-86 M2 / R2, design §6.3).
//!
//! An agent on machine A names another machine in the `machine` argument of a Kybern tool. A's daemon
//! sends one `peer.tool.call` to that machine (B); B runs the tool as the *inbound thread* it keeps for
//! that one origin thread, under the narrower of the caller's permission mode and what B's own
//! policy allows, and answers with the tool's result. Tool calls never queue: an offline target is an
//! error the agent sees at once.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{Origin, RepoIdentity, ThreadId};

/// The longest a forwarded call may take, so a lost answer is noticed (one `call_raw` wait is 60 s).
pub const TOOL_CALL_MAX_MS: u64 = 55_000;

/// The title an inbound thread shows when the origin did not send one.
pub const INBOUND_TITLE_FALLBACK: &str = "Agent on another machine";

/// `peer.tool.call`: run one Kybern agent tool for an agent on another machine.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PeerToolCallParams {
    /// The tool's name, such as `kybern_read_file`.
    pub tool: String,
    /// The tool's arguments, without `machine` and `project`.
    #[serde(default)]
    pub args: Value,
    /// Where the call comes from. B takes the machine from the session and overwrites what the caller
    /// wrote for it; the thread, the permission mode and the hops are the caller's claim, and the hop
    /// limit is checked against the session's machine.
    pub origin: Origin,
    /// The calling thread's title, for the inbound thread and its approval cards.
    #[serde(default)]
    pub thread_title: String,
    /// The repository the calling thread works in, so a project-bound tool (files, terminals, diffs)
    /// finds this machine's checkout of it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<RepoIdentity>,
    /// One of this machine's projects by name, id or path, when the repository has several checkouts
    /// or the tool is not about the calling thread's repository.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    /// How long the caller waits, at most [`TOOL_CALL_MAX_MS`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PeerToolCallResult {
    /// What the tool returned, as it would have returned it on B.
    pub result: Value,
    /// The inbound thread that recorded the call.
    pub inbound_thread_id: ThreadId,
}

/// `peer.thread.archive_inbound`: the origin thread was archived, so archive its inbound thread.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PeerThreadArchiveInboundParams {
    /// The archived thread on the sender.
    pub thread_id: ThreadId,
}
