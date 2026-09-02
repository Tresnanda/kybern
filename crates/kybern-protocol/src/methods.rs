//! Every RPC method: its name, required scope, params and result types.
//!
//! Adding a method means adding a struct pair here and an entry in `METHODS`.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde::de::DeserializeOwned;

use crate::auth::Scope;
use crate::event::ThreadEvent;
use crate::model::*;

/// Static description of a method, used for auth checks and docs.
pub trait Method {
    const NAME: &'static str;
    const SCOPE: Option<Scope>;
    type Params: Serialize + DeserializeOwned + JsonSchema;
    type Result: Serialize + DeserializeOwned + JsonSchema;
}

macro_rules! method {
    ($ty:ident, $name:literal, $scope:expr, $params:ty, $result:ty) => {
        pub struct $ty;
        impl Method for $ty {
            const NAME: &'static str = $name;
            const SCOPE: Option<Scope> = $scope;
            type Params = $params;
            type Result = $result;
        }
    };
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct Empty {}

// ---- daemon ----

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DaemonInfo {
    pub version: String,
    pub protocol_version: u32,
    /// Stable id of this daemon install, generated on first start.
    pub environment_id: String,
    pub hostname: String,
    pub os: String,
    pub arch: String,
    pub data_dir: String,
    pub scopes: Vec<Scope>,
    pub started_at: chrono::DateTime<chrono::Utc>,
}
method!(DaemonInfoMethod, "daemon.info", None, Empty, DaemonInfo);

// ---- providers ----

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ProvidersListResult {
    pub providers: Vec<ProviderStatus>,
}
method!(ProvidersList, "providers.list", Some(Scope::OrchestrationRead), Empty, ProvidersListResult);

// ---- projects ----

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ProjectsListResult {
    pub projects: Vec<Project>,
}
method!(ProjectsList, "projects.list", Some(Scope::OrchestrationRead), Empty, ProjectsListResult);

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ProjectsAddParams {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}
method!(ProjectsAdd, "projects.add", Some(Scope::OrchestrationOperate), ProjectsAddParams, Project);

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ProjectsUpdateParams {
    pub project_id: ProjectId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// `Some(None)` clears the override. Encoded as `null` on the wire.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktrees_default: Option<Option<bool>>,
}
method!(ProjectsUpdate, "projects.update", Some(Scope::OrchestrationOperate), ProjectsUpdateParams, Project);

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ProjectsRemoveParams {
    pub project_id: ProjectId,
}
method!(ProjectsRemove, "projects.remove", Some(Scope::OrchestrationOperate), ProjectsRemoveParams, Empty);

// ---- threads ----

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct ThreadsListParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<ProjectId>,
    #[serde(default)]
    pub include_archived: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ThreadsListResult {
    pub threads: Vec<Thread>,
}
method!(ThreadsList, "threads.list", Some(Scope::OrchestrationRead), ThreadsListParams, ThreadsListResult);

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ThreadsCreateParams {
    pub project_id: ProjectId,
    pub provider: ProviderInstance,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<PermissionMode>,
    /// Create a git worktree for this thread. Defaults to the project override, then global off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub use_worktree: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Optionally send a first message in the same call.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<UserMessage>,
}
method!(ThreadsCreate, "threads.create", Some(Scope::OrchestrationOperate), ThreadsCreateParams, Thread);

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ThreadsGetParams {
    pub thread_id: ThreadId,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ThreadsGetResult {
    pub thread: Thread,
    pub transcript: Vec<TranscriptEntry>,
    pub pending_approvals: Vec<ApprovalRequest>,
}
method!(ThreadsGet, "threads.get", Some(Scope::OrchestrationRead), ThreadsGetParams, ThreadsGetResult);

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ThreadsUpdateParams {
    pub thread_id: ThreadId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<PermissionMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}
method!(ThreadsUpdate, "threads.update", Some(Scope::OrchestrationOperate), ThreadsUpdateParams, Thread);

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ThreadsArchiveParams {
    pub thread_id: ThreadId,
}
method!(ThreadsArchive, "threads.archive", Some(Scope::OrchestrationOperate), ThreadsArchiveParams, Empty);

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ThreadsSendParams {
    pub thread_id: ThreadId,
    pub message: UserMessage,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ThreadsSendResult {
    pub turn_id: TurnId,
    pub message_id: MessageId,
}
method!(ThreadsSend, "threads.send", Some(Scope::OrchestrationOperate), ThreadsSendParams, ThreadsSendResult);

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ThreadsInterruptParams {
    pub thread_id: ThreadId,
}
method!(ThreadsInterrupt, "threads.interrupt", Some(Scope::OrchestrationOperate), ThreadsInterruptParams, Empty);

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ThreadsRegenerateTitleParams {
    pub thread_id: ThreadId,
}
method!(ThreadsRegenerateTitle, "threads.regenerateTitle", Some(Scope::OrchestrationOperate), ThreadsRegenerateTitleParams, Thread);

// ---- approvals ----

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ApprovalsRespondParams {
    pub approval_id: ApprovalId,
    #[serde(flatten)]
    pub decision: ApprovalDecision,
}
method!(ApprovalsRespond, "approvals.respond", Some(Scope::OrchestrationOperate), ApprovalsRespondParams, Empty);

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct ApprovalsListParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ApprovalsListResult {
    pub approvals: Vec<ApprovalRequest>,
}
method!(ApprovalsList, "approvals.list", Some(Scope::OrchestrationRead), ApprovalsListParams, ApprovalsListResult);

// ---- events ----

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct EventsSubscribeParams {
    /// Restrict to one thread. Omit to receive every thread's events.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    /// Replay persisted events with `seq > after_seq` before going live. Omit for live only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_seq: Option<EventSeq>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct EventsSubscribeResult {
    pub subscription_id: SubscriptionId,
    /// Latest persisted seq at subscribe time. Replay covers up to and including this.
    pub head_seq: EventSeq,
}
method!(EventsSubscribe, "events.subscribe", Some(Scope::OrchestrationRead), EventsSubscribeParams, EventsSubscribeResult);

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct EventsUnsubscribeParams {
    pub subscription_id: SubscriptionId,
}
method!(EventsUnsubscribe, "events.unsubscribe", Some(Scope::OrchestrationRead), EventsUnsubscribeParams, Empty);

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct EventsRangeParams {
    pub thread_id: ThreadId,
    #[serde(default)]
    pub after_seq: EventSeq,
    #[serde(default = "default_limit")]
    pub limit: u32,
}
fn default_limit() -> u32 {
    500
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct EventsRangeResult {
    pub events: Vec<ThreadEvent>,
    pub has_more: bool,
}
method!(EventsRange, "events.range", Some(Scope::OrchestrationRead), EventsRangeParams, EventsRangeResult);

/// Registry used by the daemon's auth check and the schema dump.
pub struct MethodInfo {
    pub name: &'static str,
    pub scope: Option<Scope>,
}

macro_rules! registry {
    ($($ty:ty),* $(,)?) => {
        pub const METHODS: &[MethodInfo] = &[
            $(MethodInfo { name: <$ty as Method>::NAME, scope: <$ty as Method>::SCOPE }),*
        ];
    };
}

registry!(
    DaemonInfoMethod,
    ProvidersList,
    ProjectsList,
    ProjectsAdd,
    ProjectsUpdate,
    ProjectsRemove,
    ThreadsList,
    ThreadsCreate,
    ThreadsGet,
    ThreadsUpdate,
    ThreadsArchive,
    ThreadsSend,
    ThreadsInterrupt,
    ThreadsRegenerateTitle,
    ApprovalsRespond,
    ApprovalsList,
    EventsSubscribe,
    EventsUnsubscribe,
    EventsRange,
);

pub fn scope_for(method: &str) -> Option<Option<Scope>> {
    METHODS.iter().find(|m| m.name == method).map(|m| m.scope)
}
