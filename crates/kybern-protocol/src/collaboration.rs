//! Durable collaboration records shared by the daemon and its clients.

use chrono::{DateTime, Utc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{PermissionMode, ProjectId, ProviderInstance, ProviderKind, ThreadId, TurnId};

pub type GroupId = Uuid;
pub type AssignmentId = Uuid;
pub type CollaborationMessageId = Uuid;
pub type ContextEntryId = Uuid;
pub type OperationId = Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum GroupStatus {
    Active,
    Paused,
    Stopped,
    Completed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CoordinatorMode {
    Ordinary,
    Dedicated,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct CollaborationPolicy {
    #[serde(default)]
    pub allowed_providers: Vec<ProviderKind>,
    #[serde(default = "default_max_active_workers")]
    pub max_active_workers: u32,
    #[serde(default = "default_max_depth")]
    pub max_depth: u32,
    #[serde(default = "default_max_pending_messages")]
    pub max_pending_messages: u32,
    #[serde(default = "default_max_wakeups")]
    pub max_wakeups_per_assignment: u32,
    #[serde(default = "default_true")]
    pub require_worktree_for_editing: bool,
}

const fn default_max_active_workers() -> u32 {
    4
}
const fn default_max_depth() -> u32 {
    2
}
const fn default_max_pending_messages() -> u32 {
    64
}
const fn default_max_wakeups() -> u32 {
    16
}
const fn default_true() -> bool {
    true
}

impl Default for CollaborationPolicy {
    fn default() -> Self {
        Self {
            allowed_providers: Vec::new(),
            max_active_workers: default_max_active_workers(),
            max_depth: default_max_depth(),
            max_pending_messages: default_max_pending_messages(),
            max_wakeups_per_assignment: default_max_wakeups(),
            require_worktree_for_editing: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CollaborationGroup {
    pub id: GroupId,
    pub project_id: ProjectId,
    pub coordinator_thread_id: ThreadId,
    pub objective: String,
    #[serde(default)]
    pub success_criteria: Vec<String>,
    pub status: GroupStatus,
    pub coordinator_mode: CoordinatorMode,
    pub policy: CollaborationPolicy,
    pub revision: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum GroupMemberRole {
    Coordinator,
    Worker,
    Reviewer,
    Integrator,
    Observer,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct GroupMember {
    pub group_id: GroupId,
    pub thread_id: ThreadId,
    pub role: GroupMemberRole,
    pub active: bool,
    pub joined_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AssignmentKind {
    Edit,
    Review,
    Research,
    Integration,
    Coordination,
}

impl AssignmentKind {
    pub fn mutates_workspace(self) -> bool {
        matches!(self, Self::Edit | Self::Integration)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AssignmentStatus {
    Pending,
    Working,
    Waiting,
    Blocked,
    Completed,
    Failed,
    Cancelled,
    AttentionNeeded,
}

impl AssignmentStatus {
    pub fn is_active(self) -> bool {
        matches!(self, Self::Pending | Self::Working | Self::Waiting | Self::Blocked)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct AssignmentResult {
    pub outcome: AssignmentOutcome,
    pub summary: String,
    #[serde(default)]
    pub changes: Vec<String>,
    #[serde(default)]
    pub checks: Vec<String>,
    #[serde(default)]
    pub artifacts: Vec<String>,
    #[serde(default)]
    pub unresolved: Vec<String>,
    pub completed_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AssignmentOutcome {
    Success,
    Partial,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CollaborationAssignment {
    pub id: AssignmentId,
    pub group_id: GroupId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_assignment_id: Option<AssignmentId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_thread_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_child: Option<CollaborationChildSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_by_thread_id: Option<ThreadId>,
    pub title: String,
    pub instructions: String,
    pub kind: AssignmentKind,
    pub status: AssignmentStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dispatch_message_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_revision: Option<String>,
    pub depth: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<AssignmentResult>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uncertainty: Option<String>,
    pub revision: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CollaborationChildSpec {
    pub provider: ProviderInstance,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<PermissionMode>,
    /// Required for editing/integration assignments. Resolved by git, never inferred from dirty state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_revision: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CollaborationMessagePurpose {
    Progress,
    Question,
    Reply,
    ChangeRequest,
    Result,
    Failure,
    Redirect,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CollaborationDeliveryState {
    Persisted,
    Queued,
    Submitted,
    Answered,
    Failed,
    Cancelled,
    Uncertain,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CollaborationMessage {
    pub id: CollaborationMessageId,
    pub operation_id: OperationId,
    pub group_id: GroupId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assignment_id: Option<AssignmentId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_thread_id: Option<ThreadId>,
    pub to_thread_id: ThreadId,
    /// True when the recipient is addressed without becoming a group member.
    #[serde(default)]
    pub external_recipient: bool,
    pub purpose: CollaborationMessagePurpose,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<CollaborationMessageId>,
    pub body: String,
    pub state: CollaborationDeliveryState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery_turn_id: Option<TurnId>,
    pub wakeup_count: u32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ContextEntryKind {
    Brief,
    Plan,
    Decision,
    Research,
    Instruction,
    ResultReference,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ContextEntry {
    pub id: ContextEntryId,
    pub group_id: GroupId,
    pub key: String,
    pub kind: ContextEntryKind,
    pub body: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author_thread_id: Option<ThreadId>,
    pub user_authored: bool,
    pub revision: i64,
    #[serde(default)]
    pub source_refs: Vec<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ContextEntryHistory {
    pub entry_id: ContextEntryId,
    pub revisions: Vec<ContextEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_before_revision: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CollaborationGroupDetail {
    /// Present only for the current persistent coordinator.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coordinator_setup_complete: Option<bool>,
    pub group: CollaborationGroup,
    pub members: Vec<GroupMember>,
    pub assignments: Vec<CollaborationAssignment>,
    pub pending_messages: Vec<CollaborationMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ProjectCoordinator {
    pub thread: crate::Thread,
    pub group: CollaborationGroup,
    pub created: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ThreadMessageRole {
    User,
    Assistant,
    System,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ThreadMessageAttributionKind {
    User,
    Agent,
    Collaboration,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ThreadMessageAttribution {
    pub kind: ThreadMessageAttributionKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collaboration_message_id: Option<CollaborationMessageId>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ThreadReadMessage {
    pub seq: crate::EventSeq,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<TurnId>,
    pub role: ThreadMessageRole,
    pub text: String,
    pub created_at: DateTime<Utc>,
    pub attribution: ThreadMessageAttribution,
    /// Byte offset of this UTF-8-safe text chunk within the settled message.
    #[serde(default)]
    pub text_offset: u64,
    /// Continue this one message at the given offset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_text_offset: Option<u64>,
    #[serde(default)]
    pub text_truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ThreadSearchHit {
    pub thread: crate::Thread,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub matched_at: Option<DateTime<Utc>>,
}
