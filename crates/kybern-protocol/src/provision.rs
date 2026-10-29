//! Add a project to another machine (ADE-86 provisioning).
//!
//! Any member can be the source (a machine that has the project) and any other the target. A client
//! calls `projects.provision_plan` and `projects.provision` on the **source**'s connection; the source
//! daemon does the work and talks to the target with `peer.provision.*`, so repository data and env files
//! go machine to machine and never through the client. The target owns its paths: it proposes the
//! folder (`peer.provision.probe`), checks it, clones from the remote with its own git credentials or
//! takes a bundle from the source, writes the env files and registers the project.
//!
//! The work is one outbox item (`OutboxKind::Provision`, payload [`ProvisionRequest`]), so an offline
//! target gets it when it returns. Its progress is pushed as `projects.provision.changed`.

use chrono::{DateTime, Utc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{MachineId, Project, ProjectId, ProjectKind, RepoIdentity};

/// Notification: a provisioning operation changed. Params: [`ProvisionStatus`].
pub const PROVISION_CHANGED_NOTIFICATION: &str = "projects.provision.changed";

/// The largest bundle a provisioning sends: the whole history of a repository the target cannot clone.
pub const MAX_PROVISION_BUNDLE_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// The error `data.needs` of a `peer.delegate`, `peer.fork` or `peer.move.prepare` whose target has no
/// checkout of the repository: the work can go once the project is added there.
pub const NEEDS_PROJECT: &str = "project";

/// `tool_name` of the daemon-raised card "os-kdi doesn't have kybern yet": an agent delegated, forked or
/// asked (`kybern_project_add_to_machine`) to work on a machine without the repository.
///
/// `input` is a [`ProvisionCardInput`]. The answer is `ApprovalDecision::Submit { response:
/// {"path": "<folder on the target>", "env_files": ["<path>", ...]} }` or `Deny`.
pub const PROJECT_PROVISION_TOOL: &str = "kybern_project_provision";

/// A machine as the plan shows it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ProvisionMachine {
    pub id: MachineId,
    pub name: String,
    /// `macos`, `windows` or `linux`; empty when not known yet.
    #[serde(default)]
    pub os: String,
    pub online: bool,
}

/// One repository the provisioning sets up: the project itself, or one member of a group.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ProvisionRepo {
    /// Where it goes inside the destination: `.` for the project folder itself.
    pub path: String,
    /// `host/owner/repo` of its `origin`, when it has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote: Option<String>,
    /// The branch the source has checked out (`None` when detached).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
}

/// A project of the target that already is this repository.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ProvisionExisting {
    pub project_id: ProjectId,
    pub name: String,
    pub path: String,
}

/// What a destination folder on the target holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PathState {
    /// Missing or empty: it will be created and filled.
    Free,
    /// Already a checkout of the same repository: it is registered as it is.
    SameRepo,
    /// Holds other files: refused.
    NotEmpty,
    /// Not a place Kybern writes a project to (a root, the home folder, a system folder, not absolute).
    Forbidden,
    /// The target is offline; it checks the folder when the work arrives.
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PathCheck {
    pub state: PathState,
    /// The folder as the target spells it (`~` expanded).
    pub path: String,
    /// A sentence for the sheet: "Empty folder · will be created".
    pub message: String,
}

/// A git-ignored env or secret file of the source project. Only its name and size ever travel to a client.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct EnvFileCandidate {
    /// Relative to the project folder, `/`-separated.
    pub path: String,
    pub size: u64,
    /// Ticked by default.
    pub selected: bool,
}

/// `projects.provision_plan` (on the source): what adding `project_id` to `machine` would do.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ProjectsProvisionPlanParams {
    pub project_id: ProjectId,
    /// The target machine's name or id.
    pub machine: String,
    /// A folder on the target to check instead of the proposed one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ProvisionPlan {
    pub project_id: ProjectId,
    pub project_name: String,
    #[serde(default)]
    pub kind: ProjectKind,
    pub source: ProvisionMachine,
    pub target: ProvisionMachine,
    pub repos: Vec<ProvisionRepo>,
    /// The target's projects that already are this repository; non-empty means it is there already.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub existing: Vec<ProvisionExisting>,
    /// The folder the target proposes (`~/projects/kybern`, `D:\code\kybern`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggested_path: Option<String>,
    /// The target's home folder, when it answered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_home: Option<String>,
    /// The check of `path` (the asked one, else the suggested one).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path_check: Option<PathCheck>,
    pub env_files: Vec<EnvFileCandidate>,
    /// Why it cannot be done at all, in a sentence that says what to do.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked: Option<String>,
}

/// The user's choices: where on the target, and which env files.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
pub struct ProvisionChoice {
    /// A folder on the target; `~` is the target's home. Omit for the proposed one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Env files to copy, relative to the project folder. `None` copies every detected one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env_files: Option<Vec<String>>,
}

/// `projects.provision` (on the source): queue adding `project_id` to `machine`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ProjectsProvisionParams {
    pub project_id: ProjectId,
    pub machine: String,
    #[serde(flatten)]
    pub choice: ProvisionChoice,
    /// Reuse the same key to make a repeated request return the first operation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<Uuid>,
}

/// `projects.provision.status`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ProjectsProvisionStatusParams {
    pub operation_id: Uuid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProvisionPhase {
    /// Waiting in the outbox (the target is offline, or another provisioning for it runs).
    Queued,
    /// The target checks the folder and clones from the remote.
    Cloning,
    /// The source streams the repository to the target.
    Sending,
    Importing,
    CopyingEnv,
    Done,
    Failed,
    Cancelled,
}

/// The live state of one provisioning, on the source.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ProvisionStatus {
    pub operation_id: Uuid,
    /// The outbox item that carries it.
    pub item_id: Uuid,
    /// The source's project.
    pub project_id: ProjectId,
    pub project_name: String,
    pub target: MachineId,
    pub target_name: String,
    /// The destination as asked (the target may expand `~`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub phase: ProvisionPhase,
    /// What happens now, for the progress line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default)]
    pub bytes_sent: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes_total: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<ProvisionResult>,
    pub updated_at: DateTime<Utc>,
}

/// What the target set up.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ProvisionResult {
    /// The project as the target registered it.
    pub project: Project,
    /// Env files written.
    #[serde(default)]
    pub env_written: Vec<String>,
    /// Env files left as they were, because the folder already had them.
    #[serde(default)]
    pub env_kept: Vec<String>,
    /// Whether every repository came from its remote (no bundle was needed).
    #[serde(default)]
    pub cloned_from_remote: bool,
}

/// The payload of an `OutboxKind::Provision` item. Env files are named only; their contents are read and
/// sealed when the item is delivered.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ProvisionRequest {
    pub operation_id: Uuid,
    pub project_id: ProjectId,
    pub project_name: String,
    /// The destination on the target; `None` takes the folder the target proposes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default)]
    pub env_files: Vec<String>,
}

/// The `input` of a [`PROJECT_PROVISION_TOOL`] card.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ProvisionCardInput {
    /// The provisioning the answer queues: `projects.provision.status` follows it.
    pub operation_id: Uuid,
    pub plan: ProvisionPlan,
    /// What waits for it: "delegate", "fork", "move" or "add".
    pub then: String,
    /// The agent's reason, when it asked with `kybern_project_add_to_machine`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

// ---- peer.provision.* ----

/// `peer.provision.probe`: does the target have this repository, and where would it go?
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PeerProvisionProbeParams {
    /// The repositories: one for a single project, each member's for a group (the first is the primary).
    pub repos: Vec<RepoIdentity>,
    /// Where each of `repos` goes inside the folder (`.` for a single project).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub members: Vec<String>,
    #[serde(default)]
    pub kind: ProjectKind,
    /// The project's name, for the proposed folder.
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PeerProvisionProbe {
    pub os: String,
    /// The target's home folder, so a client can show `~/projects/kybern`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub home: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub existing: Vec<ProvisionExisting>,
    pub suggested_path: String,
    pub path_check: PathCheck,
}

/// `peer.provision.prepare`: make the repository `rel` of the destination exist, cloning it when possible.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PeerProvisionPrepareParams {
    pub operation_id: Uuid,
    /// The destination folder (the project folder; a group's members go inside it).
    pub path: String,
    /// `.` or a group member's folder.
    pub rel: String,
    pub repo: RepoIdentity,
    /// The source's `origin` URL with any credentials removed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// The source's HEAD: the target ends on this commit.
    pub commit: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PrepareState {
    /// The checkout is there at the commit.
    Ready,
    /// The folder already was this repository: it is used as it is.
    Existing,
    /// Send a bundle (`full`: the whole history; else only what no remote has).
    NeedsBundle,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PeerProvisionPrepareResult {
    pub state: PrepareState,
    /// The folder as the target spells it.
    pub path: String,
    #[serde(default)]
    pub full: bool,
    /// Whether it was cloned from the remote.
    #[serde(default)]
    pub cloned: bool,
    /// Why cloning from the remote did not work (credentials stripped), when it was tried.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clone_error: Option<String>,
}

/// `peer.provision.import`: the bundle `transfer_id` is staged (`peer.provision.chunk`); import it into `rel`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PeerProvisionImportParams {
    pub operation_id: Uuid,
    /// The staged bundle's id: the operation's own for `.`, else the member's.
    pub transfer_id: Uuid,
    pub path: String,
    pub rel: String,
    pub total: u64,
    pub sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    pub commit: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_url: Option<String>,
}

/// One env file, sealed to the target's machine key.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SealedEnvFile {
    pub path: String,
    /// Base64 of the sealed contents.
    pub sealed: String,
}

/// `peer.provision.finish`: write the env files and register the project.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PeerProvisionFinishParams {
    pub operation_id: Uuid,
    pub path: String,
    pub name: String,
    #[serde(default)]
    pub kind: ProjectKind,
    /// A group's member folders.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub members: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub env_files: Vec<SealedEnvFile>,
    #[serde(default)]
    pub cloned_from_remote: bool,
}

/// The context an env file is sealed under: bound to the operation, both machines and the file, so a sealed
/// file replayed in another operation, from another sender, to another machine or as another file does not open.
pub fn env_file_context(operation_id: Uuid, from: &str, to: &str, path: &str) -> Vec<u8> {
    format!("kybern-provision-env-v1\0{operation_id}\0{from}\0{to}\0{path}").into_bytes()
}
