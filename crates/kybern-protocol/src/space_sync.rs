//! Signed Spaces replica, separate from membership operations.
use crate::{MachineId, OpEnvelope, ProjectId, ProjectKind, RepoIdentity, SpaceId};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// A project reference carries repository identity so placements also work without a local checkout.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SpaceProject {
    pub machine_id: MachineId,
    pub project_id: ProjectId,
    /// Local folder identities this machine replaced when leaving and rejoining.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub previous_machine_ids: Vec<MachineId>,
    #[serde(default)]
    pub kind: ProjectKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<RepoIdentity>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub repos: Vec<RepoIdentity>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SpacesPlaceParams {
    pub project: SpaceProject,
    pub space_id: SpaceId,
}
/// The exact body is signed with the Spaces domain, never the membership domain.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SpaceField {
    pub network_id: String,
    pub lamport: u64,
    pub entity: String,
    pub field: String,
    pub value: serde_json::Value,
    pub at: chrono::DateTime<chrono::Utc>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct PeerSpacesSyncParams {
    pub digest: String,
    #[serde(default)]
    pub ids: Vec<String>,
    #[serde(default)]
    pub fields: Vec<OpEnvelope>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PeerSpacesSyncResult {
    pub digest: String,
    pub ids: Vec<String>,
    pub fields: Vec<OpEnvelope>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PeerSpaceLogoParams {
    pub hash: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PeerSpaceLogoResult {
    pub data: String,
}

/// A resolved logical placement. Clocks also let clients resolve a newly learned repository identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SpacePlacement {
    pub project: SpaceProject,
    pub space_id: SpaceId,
    pub lamport: u64,
    pub signer: String,
    pub op_id: String,
}
