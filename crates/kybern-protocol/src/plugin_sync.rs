//! Explicit user-level plugin declarations, never caches or credentials. `machine:files` gates peer calls,
//! like skills; plugins.sync.v1 additionally gates installer support. Confirmation binds a fingerprint.
use crate::{MachineId, ProviderKind, SkillsMachineState};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PluginKind {
    Plugin,
    Marketplace,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PluginContents {
    pub hooks: u32,
    pub mcp_servers: u32,
    pub commands: u32,
    pub agents: u32,
    pub skills: u32,
    pub extensions: u32,
    pub npm_packages: Vec<String>,
    /// Static declarations cannot describe all the code a package can execute.
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct MachinePlugin {
    /// Stable within a harness; marketplace rows use `marketplace:NAME`.
    pub id: String,
    pub provider: ProviderKind,
    pub kind: PluginKind,
    pub name: String,
    pub marketplace: Option<String>,
    /// Public installer input only. Never a local path or a URL containing credentials.
    pub source: Option<String>,
    pub version: Option<String>,
    /// Unknown for caches whose harness has no authoritative local state.
    pub enabled: Option<bool>,
    /// pi resource filters only, never arbitrary plugin options or credentials.
    #[serde(default)]
    pub resources: BTreeMap<String, Vec<String>>,
    pub contents: PluginContents,
    pub problem: Option<String>,
    /// SHA-256 of the complete declaration the user reviewed.
    pub fingerprint: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct PluginInventory {
    #[serde(default)]
    pub jobs: Vec<PluginCopyJob>,
    pub plugins: Vec<MachinePlugin>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PluginsMachineView {
    pub id: MachineId,
    pub name: String,
    pub is_self: bool,
    pub state: SkillsMachineState,
    pub inventory: Option<PluginInventory>,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct PluginsNetworkView {
    pub machines: Vec<PluginsMachineView>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PluginCopyTarget {
    pub machine: MachineId,
    /// Only this reviewed target declaration may be replaced. A concurrent edit fails closed.
    pub replaces: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PluginsCopyParams {
    pub provider: ProviderKind,
    pub id: String,
    pub from: Option<MachineId>,
    pub to: Vec<PluginCopyTarget>,
    /// Required; clients send the fingerprint only after showing contents and confirming installation.
    pub confirmed: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PluginInstallRequest {
    pub operation_id: Uuid,
    pub plugin: MachinePlugin,
    pub replaces: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PluginInstallState {
    Installed,
    AlreadyThere,
    Configured,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PluginInstallResult {
    pub state: PluginInstallState,
    pub message: String,
    pub actual: Option<MachinePlugin>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PluginCopyOutcome {
    pub machine: MachineId,
    pub name: String,
    pub outbox_id: Option<Uuid>,
    pub result: Option<PluginInstallResult>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PluginsCopyResult {
    pub targets: Vec<PluginCopyOutcome>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PluginCopyJob {
    pub id: Uuid,
    pub provider: ProviderKind,
    pub plugin_id: String,
    pub target: MachineId,
    pub state: crate::OutboxState,
    pub result: Option<PluginInstallResult>,
    pub error: Option<String>,
}
