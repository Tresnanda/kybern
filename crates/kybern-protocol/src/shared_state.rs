//! Shared state across the machine network (ADE-86 M5: design §9.1 and §9.2).
//!
//! **Settings fan-out (S1).** Every `Settings` field is either shared across machines or belongs to one
//! machine (the table lives in the daemon's `settings_share.rs`). A shared field is changed on every
//! member by one explicit user action: a field-level [`SettingsPatch`] carrying a [`SettingsStamp`]. A
//! target applies a field only when the stamp is newer than the field's last stamp there, so a patch that
//! sat in the outbox while the user changed the field locally never wins. Daemons never sync settings on
//! their own; clients read [`SettingsNetworkView`] to show "Mixed".
//!
//! **Federated notes and tasks (S2).** `notes.list`, `notes.search` and `tasks.items.list` take
//! `machine: "all"` (or one machine) and merge what the online members hold. Each machine stays the only
//! writer of its own notes and tasks. [`Federation`] says which ids came from which machine and which
//! machines were left out.

use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::MachineId;
use crate::methods::{NotesListResult, NotesSearchResult, TaskItemsListResult};

// ---- settings fan-out ----

/// When and where a settings change was made. Ordered by `(at, lamport, machine_id)`: a later wall clock
/// wins, the counter breaks ties on one machine, and the machine id makes the order total.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema)]
pub struct SettingsStamp {
    pub at: DateTime<Utc>,
    pub lamport: u64,
    pub machine_id: MachineId,
}

/// A field-level change to the shared settings. `fields` maps a field path (`default_provider`,
/// `orchestration`, `providers.codex.model`, …) to its new value; `null` clears an optional field.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SettingsPatch {
    pub stamp: SettingsStamp,
    pub fields: BTreeMap<String, Value>,
}

/// What a target did with each field of a [`SettingsPatch`] (`peer.settings.patch`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PeerSettingsPatchResult {
    /// Paths the patch changed here.
    #[serde(default)]
    pub applied: Vec<String>,
    /// Paths where this machine already holds a newer change, left alone.
    #[serde(default)]
    pub stale: Vec<String>,
    /// Paths that already had the patch's value (or the patch itself).
    #[serde(default)]
    pub unchanged: Vec<String>,
    /// Paths this machine would not take (not shared, or an invalid value), with the reason.
    #[serde(default)]
    pub refused: BTreeMap<String, String>,
}

/// The shared settings of one machine (`peer.settings.get`). Per-machine fields never leave it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PeerSettingsGetResult {
    pub values: BTreeMap<String, Value>,
    /// The stamp of the last change of each field, where there is one.
    #[serde(default)]
    pub stamps: BTreeMap<String, SettingsStamp>,
}

/// Where a machine stands in a [`SettingsNetworkView`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SettingsMachineState {
    /// Its values are in the view.
    Reported,
    /// Offline or paused: no values, changes queue for it.
    Offline,
    /// It runs a Kybern without settings fan-out.
    Unsupported,
    /// It did not answer in time or refused.
    Unreachable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SettingsMachineView {
    pub id: MachineId,
    pub name: String,
    pub is_self: bool,
    pub state: SettingsMachineState,
}

/// One machine's value of a shared field. `value` is absent when the machine did not report.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SettingsFieldValue {
    pub machine_id: MachineId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SettingsFieldView {
    pub path: String,
    /// One entry per machine in [`SettingsNetworkView::machines`], in the same order.
    pub values: Vec<SettingsFieldValue>,
    /// The machines that reported do not all hold the same value: clients show **Mixed**.
    pub mixed: bool,
    /// Machines with a queued change for this field, waiting to be delivered.
    #[serde(default)]
    pub pending: Vec<MachineId>,
}

/// `settings.network_view`: every shared field on every reachable machine.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SettingsNetworkView {
    /// This machine first, then the others by name.
    pub machines: Vec<SettingsMachineView>,
    pub fields: Vec<SettingsFieldView>,
}

/// `settings.share`: set shared fields here and on the other machines.
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct SettingsShareParams {
    /// Field path to its new value (`null` clears an optional field). Only shared fields.
    pub fields: BTreeMap<String, Value>,
    /// Machines to send it to (id or name); all other members when absent. This machine always takes it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machines: Option<Vec<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SettingsShareState {
    /// In the outbox; delivered when the machine is reachable (at once when it is online).
    Queued,
    /// The machine runs a Kybern without settings fan-out; nothing was queued.
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SettingsShareTarget {
    pub machine_id: MachineId,
    pub name: String,
    pub state: SettingsShareState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outbox_id: Option<Uuid>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SettingsShareResult {
    pub stamp: SettingsStamp,
    /// What changing the fields did on this machine.
    pub here: PeerSettingsPatchResult,
    pub machines: Vec<SettingsShareTarget>,
}

// ---- federated notes and tasks ----

/// The `machine` argument that reads every online machine.
pub const MACHINE_ALL: &str = "all";

/// `notes.list` with an optional machine (`"all"`, a name or an id). Without one it is this machine only.
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct NotesListParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine: Option<String>,
}

/// `tasks.items.list` with an optional machine.
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct TaskItemsListParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine: Option<String>,
}

/// The ids one machine contributed to a merged result, in the order it returned them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct FederationSection {
    pub machine_id: MachineId,
    pub machine_name: String,
    pub is_self: bool,
    pub ids: Vec<Uuid>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SkipReason {
    Offline,
    Paused,
    /// A Kybern without federated reads.
    Unsupported,
    /// The machine does not let this one use its tools (`machine:tools` is off for it).
    Refused,
    /// No answer within the 5 s budget.
    TimedOut,
    /// The machine answered with an error.
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct FederationSkipped {
    pub machine_id: MachineId,
    pub machine_name: String,
    pub reason: SkipReason,
}

/// How a merged result was put together. Absent on an ordinary, single-machine result.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Federation {
    /// This machine first, then the others by name.
    pub sections: Vec<FederationSection>,
    pub skipped: Vec<FederationSkipped>,
    /// "satyamas offline; its notes are not included", ready to show under the list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub footer: Option<String>,
}

/// `peer.federated.read`: a read another member makes of this machine's notes or tasks. Read-only, so
/// the target needs only `machine:tools` for it.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "read", rename_all = "snake_case")]
pub enum PeerFederatedReadParams {
    NotesList,
    NotesSearch {
        query: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        limit: Option<u32>,
    },
    TaskItemsList,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct PeerFederatedReadResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes_list: Option<NotesListResult>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes_search: Option<NotesSearchResult>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_items: Option<TaskItemsListResult>,
}
