//! Machine utilities (ADE-86 M4, design §8): sending files and folders to another machine, and
//! forwarding a port of another machine to this one.
//!
//! **Files.** A client calls `files.send` on its own daemon. The daemon queues a `files_push` outbox
//! item, which streams the file to the target with `peer.files.begin`, `peer.files.chunk` (4 MiB, with
//! the offset) and `peer.files.finish`. The target stages the bytes under its data directory and moves
//! them into place once every SHA-256 matches, so a disconnect resumes by offset and a half-written file
//! never lands in a project. `machine:files` gates all four.
//!
//! **Ports.** `ports.forward` binds a loopback port on this machine; each connection to it opens a
//! `peer.ports.open` stream to the target, which connects to its own loopback port. The stream carries
//! `peer.ports.data` and `peer.ports.close` frames with the relay's credit window. `machine:ports` gates
//! `peer.ports.open`; the data and close frames only work on a stream an authorized open created.

use chrono::{DateTime, Utc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{MachineId, OutboxItem, ProjectId};

/// The largest send: one file, or all the files of a folder together (§8.1).
pub const MAX_PUSH_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// The size of one `peer.files.chunk`.
pub const PUSH_CHUNK_BYTES: usize = 4 * 1024 * 1024;
/// The most files one folder send may hold.
pub const MAX_PUSH_FILES: usize = 20_000;
/// The most forwards one daemon holds (§8.3).
pub const MAX_PORT_FORWARDS: usize = 16;
/// A forward with no connection for this long closes (§8.3).
pub const PORT_FORWARD_IDLE_SECS: u64 = 30 * 60;

/// Notification: a send's bytes moved. Params: [`FilesProgress`].
pub const FILES_PROGRESS_NOTIFICATION: &str = "files.progress";
/// Notification on the receiving machine: files arrived. Params: [`FilesReceived`].
pub const FILES_RECEIVED_NOTIFICATION: &str = "files.received";
/// Notification: the list of port forwards changed. Params: [`PortsListResult`].
pub const PORTS_CHANGED_NOTIFICATION: &str = "ports.changed";

// ---- files ----

/// Where the files land on the target.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PushDest {
    /// `~/Downloads/Kybern/<from machine>/`, the default.
    Downloads,
    /// A project of the target, named by id, name or path, with an optional folder inside it.
    Project {
        project: String,
        /// Relative to the project's root, `/`-separated, without `..`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        subdir: Option<String>,
    },
}

/// One file of a send.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PushEntry {
    /// Relative to the send's root, `/`-separated.
    pub path: String,
    pub size: u64,
    /// Lowercase hex SHA-256 of the whole file.
    pub sha256: String,
}

/// `files.send`: queue a file or folder of a project of this machine for another machine.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct FilesSendParams {
    pub project_id: ProjectId,
    /// The file or folder, relative to the project root.
    pub path: String,
    /// The target machine, by id or name.
    pub machine: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dest: Option<PushDest>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct FilesSendResult {
    /// The outbox item that carries the send; it follows the usual states.
    pub item: OutboxItem,
    pub files: u32,
    pub bytes: u64,
    /// Entries left out of a folder: symlinks, `.git`, credential folders and env files.
    pub skipped: u32,
}

/// What the outbox keeps of a send (its payload).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct FilesPushPayload {
    /// The absolute, canonical path of the file or folder on the sending machine.
    pub source: String,
    pub name: String,
    pub is_folder: bool,
    pub dest: PushDest,
}

/// `peer.files.begin`: announce a send, or pick one up again after a disconnect.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PeerFilesBeginParams {
    /// The outbox item's operation id: a repeat finds the bytes already staged.
    pub transfer_id: Uuid,
    /// The file or folder name that lands in the destination.
    pub name: String,
    pub is_folder: bool,
    pub dest: PushDest,
    pub entries: Vec<PushEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PeerFilesBeginResult {
    /// For each entry, the bytes the target already holds; send from there.
    pub offsets: Vec<u64>,
    /// The send was finished before: nothing is left to do.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub complete: bool,
    /// Where a finished send landed, when `complete`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dest_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PeerFilesChunkParams {
    pub transfer_id: Uuid,
    /// The index into the announced entries.
    pub index: u32,
    /// Where this chunk starts in the file; it must be the target's current offset.
    pub offset: u64,
    /// Standard base64 of at most [`PUSH_CHUNK_BYTES`] bytes.
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PeerFilesChunkResult {
    /// The target's offset in that file now.
    pub offset: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PeerFilesTransferParams {
    pub transfer_id: Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PeerFilesFinishResult {
    /// The file or folder on the target.
    pub dest_path: String,
    pub files: u32,
    pub bytes: u64,
}

/// Pushed to the sender's clients while a send runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct FilesProgress {
    pub item_id: Uuid,
    pub sent: u64,
    pub total: u64,
}

/// Pushed to the receiver's clients when a send landed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct FilesReceived {
    pub transfer_id: Uuid,
    pub from_machine: MachineId,
    pub from_name: String,
    pub name: String,
    pub files: u32,
    pub bytes: u64,
    /// Where it is on this machine.
    pub dest_path: String,
    pub at: DateTime<Utc>,
}

// ---- ports ----

/// `ports.forward`: bind a loopback port here that reaches a loopback port of another machine.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PortsForwardParams {
    /// The target machine, by id or name.
    pub machine: String,
    pub remote_port: u16,
    /// A port to bind here; any free port when left out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_port: Option<u16>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PortForward {
    pub id: Uuid,
    pub machine_id: MachineId,
    pub machine_name: String,
    pub remote_port: u16,
    pub local_port: u16,
    /// Connections open right now.
    pub connections: u32,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PortsListResult {
    pub forwards: Vec<PortForward>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PortsStopParams {
    pub id: Uuid,
}

/// `peer.ports.open`: the target connects a stream to a loopback port of its own.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PeerPortsOpenParams {
    pub stream_id: u64,
    pub port: u16,
}

// ---- clipboard (M4 / U2, design §8.2) ----

/// The longest text one clipboard send or paste carries.
pub const MAX_CLIPBOARD_BYTES: usize = 1024 * 1024;
/// How long a machine with no desktop session keeps a sent text in its Kybern clipboard buffer.
pub const CLIPBOARD_BUFFER_MINUTES: i64 = 10;

/// Where a clipboard text lives on a machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ClipboardStore {
    /// The operating system's clipboard.
    System,
    /// Kybern's own buffer, for a machine with no desktop session (a server) or when the system clipboard cannot be reached.
    Buffer,
}

/// `clipboard.set`: put a text on the clipboard of this machine, or of another machine of the network.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ClipboardSetParams {
    /// The target machine, by id or name; this machine when left out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine: Option<String>,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ClipboardSetResult {
    pub stored: ClipboardStore,
    pub bytes: u64,
}

/// `clipboard.get`: read the clipboard of this machine, or of another machine of the network.
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct ClipboardGetParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ClipboardGetResult {
    pub text: String,
    pub source: ClipboardStore,
}

/// `peer.clipboard.set`: the text a member sends on behalf of its client.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PeerClipboardSetParams {
    pub text: String,
}

/// `peer.clipboard.auto`: a change of the universal clipboard, sealed to the receiver's sealing key.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PeerClipboardAutoParams {
    /// Standard base64 of the sealed text.
    pub sealed: String,
}

/// `clipboard.status`: what this machine's clipboard can do, and how many changes the universal clipboard skipped.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ClipboardStatus {
    /// Where an explicit send lands on this machine.
    pub backend: ClipboardStore,
    /// "Share clipboard automatically" is on for this machine.
    pub auto: bool,
    /// Changes the universal clipboard did not share because they looked secret; counts only, never content.
    pub skipped: u64,
}
