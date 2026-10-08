// Wire types for the kybern daemon protocol, hand-derived from
// crates/kybern-protocol/src/{rpc,auth,model,event,methods}.rs.
//
// Shapes mirror serde exactly:
// - `#[serde(tag = "kind")]` events, `tag = "type"` content parts,
//   `tag = "decision"` approvals, `tag = "role"` transcript entries.
// - Enums are kebab-case (ProviderKind, PermissionMode, ThreadStatus) or
//   snake_case (Scope, StopReason, NoticeLevel, FileStatus).
// - `Option<T>` fields are `T | null` and may be absent when the Rust side
//   uses `skip_serializing_if`. We type both as optional-nullable.
//
// Cross-check against src/protocol/schema/kybern-protocol.schema.json
// (regenerate with `pnpm run gen:schema`).

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 4173;
export const EVENT_NOTIFICATION = "event";
export const EVENTS_READY_NOTIFICATION = "events.ready";
export const EVENTS_LAGGED_NOTIFICATION = "events.lagged";

// ---- ids ----

export type Uuid = string;
export type ProjectId = Uuid;
export const FREE_CHAT_PROJECT_ID: ProjectId = "00000000-0000-0000-0000-000000000001";
export const isFreeChatProject = (projectId: ProjectId): boolean => projectId === FREE_CHAT_PROJECT_ID;
export type ThreadId = Uuid;
export type GroupId = Uuid;
export type AssignmentId = Uuid;
export type CollaborationMessageId = Uuid;
export type ContextEntryId = Uuid;
export type OperationId = Uuid;
export type TurnId = Uuid;
export type MessageId = Uuid;
export type ApprovalId = Uuid;
export type SubscriptionId = Uuid;
export type AssetId = Uuid;
export type TerminalId = Uuid;
/** RFC 3339 timestamp. */
export type DateTime = string;
/** Monotonic per-daemon event sequence number. */
export type EventSeq = number;
/** serde_json::Value */
export type JsonValue = unknown;

// ---- rpc ----

export type RpcId = number | string;

export interface RpcRequest {
  jsonrpc: "2.0";
  id: RpcId;
  method: string;
  params?: JsonValue;
}

export interface RpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: JsonValue;
}

export interface RpcError {
  code: number;
  message: string;
  data?: JsonValue;
}

export interface RpcResponse {
  jsonrpc: "2.0";
  id: RpcId;
  result?: JsonValue;
  error?: RpcError;
}

export type ServerFrame = RpcResponse | RpcNotification;

export const codes = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  UNAUTHORIZED: -32001,
  FORBIDDEN: -32002,
  NOT_FOUND: -32003,
  CONFLICT: -32004,
  PROVIDER_UNAVAILABLE: -32010,
  PROVIDER_ERROR: -32011,
  THREAD_BUSY: -32012,
} as const;

// ---- auth ----

export type Scope =
  | "orchestration_read"
  | "orchestration_operate"
  | "terminal_operate"
  | "review_write"
  | "access_read"
  | "access_write";

/** Query parameter accepted as a fallback for clients that cannot set headers. */
export const AUTH_QUERY_PARAM = "token";

// ---- model ----

export type ProviderKind =
  "claude-code" | "codex" | "opencode" | "pi" | "omp" | "cursor";

export const PROVIDER_DISPLAY_NAME: Record<ProviderKind, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  pi: "pi",
  omp: "Oh My Pi",
  cursor: "Cursor",
};

export interface ProviderInstance {
  kind: ProviderKind;
  instance: string;
}

export type PermissionMode =
  "supervised" | "accept-edits" | "auto" | "full-access";

export interface ProviderAccount { name: string; directory: string }
export interface SessionTarget { provider: ProviderInstance; model?: string | null; effort?: string | null }
export interface ThreadTargetState {
  target: SessionTarget;
  native_session_id?: string | null;
  account_override: boolean;
  effective_permission_mode: PermissionMode;
  pending_permission_mode?: PermissionMode | null;
  quota_limited?: boolean;
}

export interface ProviderModel {
  /** Model selector accepted by the provider. */
  id: string;
  display_name: string;
  /** Concrete id an alias selector resolves to; sessions report this id. */
  resolved_id?: string | null;
  /** The harness's own one-line description, shown under the name. */
  description?: string | null;
  provider?: string | null;
  efforts?: string[];
  default_effort?: string | null;
  is_default?: boolean;
  /** Traits besides effort (context size, fast mode). One row per model; `variants` maps trait values to selectors. */
  parameters?: ModelParameter[];
  /** Selectable trait combinations. `id` on the row is the default one. */
  variants?: ModelVariant[];
}

export interface ModelParameter {
  id: string;
  label: string;
  values: ModelParameterValue[];
  /** Value of the row's default combination. */
  default: string;
}

export interface ModelParameterValue {
  value: string;
  label: string;
}

export interface ModelVariant {
  /** Model selector to send for this combination. */
  id: string;
  params: Record<string, string>;
  /** Empty means the row's efforts. */
  efforts?: string[];
  default_effort?: string | null;
}

export interface ProviderStatus {
  kind: ProviderKind;
  display_name: string;
  available: boolean;
  binary_path?: string | null;
  version?: string | null;
  unavailable_reason?: string | null;
  supported_permission_modes: PermissionMode[];
  supports_fork: boolean;
  supports_model_switch: boolean;
  supports_effort_switch?: boolean;
  supported_efforts?: string[];
  /** Models reported by the installed harness. Empty means no catalog. */
  models?: ProviderModel[];
  instances: string[];
}

export interface Project {
  id: ProjectId;
  name: string;
  /** Absolute path on the daemon host. */
  path: string;
  is_git: boolean;
  worktrees_default?: boolean | null;
  /** Prefix for this project's task keys, e.g. "ADE". */
  task_prefix?: string | null;
  created_at: DateTime;
  updated_at: DateTime;
}

export type ThreadStatus =
  "idle" | "running" | "awaiting-approval" | "failed" | "archived";

export interface WorktreeInfo {
  path: string;
  branch: string;
}

export interface Thread {
  id: ThreadId;
  project_id: ProjectId;
  /** Real Kybern thread relationships; provider-native tasks stay separate. */
  parent_thread_id?: ThreadId | null;
  coordinator_project_id?: ProjectId | null;
  collaboration_group_id?: GroupId | null;
  title: string;
  provider: ProviderInstance;
  model?: string | null;
  effort?: string | null;
  permission_mode: PermissionMode;
  status: ThreadStatus;
  worktree?: WorktreeInfo | null;
  cwd: string;
  provider_session_id?: string | null;
  pinned: boolean;
  created_at: DateTime;
  updated_at: DateTime;
  /** Sequence of the last event on this thread. */
  last_seq: EventSeq;
  /**
   * Set when this thread mirrors one provider-native subagent. It is read-only,
   * `parent_thread_id` is the thread (or subagent) that launched it, and it must
   * stay out of ordinary thread lists. See `isSubagentThread`.
   */
  subagent?: SubagentInfo | null;
  /**
   * Set when another thread delegated this one with `kybern_agent_delegate`.
   * Unlike a subagent it is a normal, writable thread; `parent_thread_id` is the
   * delegating thread. Hidden from ordinary thread lists like subagents.
   */
  delegation?: DelegationInfo | null;
}

export type DelegationRole = "implementation" | "research" | "review" | "design" | "test" | "general";
export type DelegationWorkspace = "shared" | "worktree";
export type DelegationStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted";
/** A delegated child's own worktree: `kept` stays on disk because it was dirty or unmerged. */
export type WorktreeState = "active" | "kept" | "removed";

export interface DiffStat {
  files: number;
  additions: number;
  deletions: number;
}

/** A shared-checkout edit that landed on a path a sibling delegation owns. */
export interface DelegationConflict {
  path: string;
  owner_thread_id: ThreadId;
  at: DateTime;
}

export interface DelegationInfo {
  /** Stable id agents use for this delegation. */
  task_id: Uuid;
  /** Idempotency key of the delegate call. */
  operation_id: Uuid;
  parent_thread_id: ThreadId;
  /** 1 for a direct child of a top-level thread. */
  depth: number;
  role: DelegationRole;
  workspace: DelegationWorkspace;
  /** Globs relative to the checkout root this child owns (shared only). */
  owns?: string[];
  status: DelegationStatus;
  /** The child's final assistant text of the completing turn (at most 16 KiB). */
  result?: string | null;
  error?: string | null;
  /** Repo-relative paths the child edited, at most 200. */
  files_touched?: string[];
  conflicts?: DelegationConflict[];
  /** Worktree: the snapshot commit it was seeded from. */
  base_commit?: string | null;
  /** Worktree: `kybern/<child-id>`. */
  branch?: string | null;
  head_commit?: string | null;
  diffstat?: DiffStat | null;
  worktree_state?: WorktreeState | null;
  started_at: DateTime;
  completed_at?: DateTime | null;
  /** Whether the delegating parent has been handed this outcome. Absent on old rows (treated as true). */
  parent_notified?: boolean;
}

export type ThreadMessagePurpose = "task" | "message" | "question" | "reply" | "warning";
export type ThreadMessageDelivery = "queue" | "steer";
export type ThreadMessageState = "held" | "queued" | "steered" | "delivered" | "answered" | "dismissed" | "failed";
export type HeldResolution = "delivered" | "dismissed";

/** A message one thread sent another through `kybern_thread_send`; the id is also the queued or steered message id. */
export interface ThreadMessageRecord {
  id: MessageId;
  operation_id: Uuid;
  /** Absent when Kybern itself sent it. */
  from_thread_id?: ThreadId | null;
  to_thread_id: ThreadId;
  purpose: ThreadMessagePurpose;
  reply_to?: MessageId | null;
  body: string;
  /** Requested delivery. */
  delivery: ThreadMessageDelivery;
  state: ThreadMessageState;
  held_reason?: string | null;
  created_at: DateTime;
  updated_at: DateTime;
}

/** One delegated agent's outcome inside an `agent_results` part. */
export interface AgentResultItem {
  task_id: Uuid;
  thread_id: ThreadId;
  title: string;
  provider: ProviderKind;
  model?: string | null;
  role: DelegationRole;
  status: DelegationStatus;
  result?: string | null;
  error?: string | null;
  workspace: DelegationWorkspace;
  branch?: string | null;
  /** Worktree only: the commit the child started from; apply `base_commit..head_commit` when the parent checkout is dirty. */
  base_commit?: string | null;
  head_commit?: string | null;
  diffstat?: DiffStat | null;
  /** At most 50. */
  files_touched?: string[];
  conflicts?: DelegationConflict[];
}

/** Subagent metadata of a read-only child thread; title, model and effort live on the thread. */
export interface SubagentInfo {
  /** Runtime task id in the parent thread; with `root_thread_id` it identifies the child. */
  task_id: string;
  /** The thread that owns the provider session. `tasks.stop` / `tasks.background` accept the child thread id. */
  root_thread_id: ThreadId;
  /** Turn of the root thread that launched it. */
  parent_turn_id: TurnId;
  tool_call_id?: string | null;
  provider_thread_id?: string | null;
  /** Provider agent type or role (`Explore`, `worker`). */
  agent_type?: string | null;
  status: RuntimeTaskStatus;
  backgrounded?: boolean;
  last_tool_name?: string | null;
  /** Latest provider progress or result summary as reported. */
  detail?: string | null;
  /** One live line while it works (latest activity, else `Using <tool>`). */
  progress?: string | null;
  /** First line of its final answer once it settled. */
  result?: string | null;
  usage?: Usage | null;
  /** Token count, tool uses and duration as the provider reports them. */
  stats?: RuntimeTaskStats;
  capabilities?: RuntimeTaskCapabilities;
  /** False when the harness reports only lifecycle: the transcript holds just the prompt and outcome. */
  transcript?: boolean;
  started_at: DateTime;
  completed_at?: DateTime | null;
}

// ---- collaboration ----

export type GroupStatus = "active" | "paused" | "stopped" | "completed";
export type CoordinatorMode = "ordinary" | "dedicated";

export interface CollaborationPolicy {
  allowed_providers: ProviderKind[];
  max_active_workers: number;
  max_depth: number;
  max_pending_messages: number;
  max_wakeups_per_assignment: number;
  require_worktree_for_editing: boolean;
}

export interface CollaborationGroup {
  id: GroupId;
  project_id: ProjectId;
  coordinator_thread_id: ThreadId;
  objective: string;
  success_criteria: string[];
  status: GroupStatus;
  coordinator_mode: CoordinatorMode;
  policy: CollaborationPolicy;
  revision: number;
  created_at: DateTime;
  updated_at: DateTime;
}

export interface ProjectCoordinator {
  thread: Thread;
  group: CollaborationGroup;
  created: boolean;
}

export interface ProjectCoordinatorCreateParams {
  operation_id: OperationId;
  project_id: ProjectId;
  provider: ProviderInstance;
  model?: string | null;
  effort?: string | null;
  permission_mode?: PermissionMode | null;
  coordinator_mode?: CoordinatorMode | null;
  initial_goal?: string | null;
}

export interface ProjectCoordinatorSwitchHarnessParams {
  operation_id: OperationId;
  project_id: ProjectId;
  provider: ProviderInstance;
  model?: string | null;
  effort?: string | null;
  permission_mode?: PermissionMode | null;
}

export type GroupMemberRole =
  | "coordinator"
  | "worker"
  | "reviewer"
  | "integrator"
  | "observer";

export interface GroupMember {
  group_id: GroupId;
  thread_id: ThreadId;
  role: GroupMemberRole;
  active: boolean;
  joined_at: DateTime;
}

export type AssignmentKind =
  | "edit"
  | "review"
  | "research"
  | "integration"
  | "coordination";
export type AssignmentStatus =
  | "pending"
  | "working"
  | "waiting"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled"
  | "attention_needed";

export interface AssignmentResult {
  outcome: "success" | "partial" | "failed";
  summary: string;
  changes: string[];
  checks: string[];
  artifacts: string[];
  unresolved: string[];
  completed_at: DateTime;
}

export interface CollaborationAssignment {
  id: AssignmentId;
  group_id: GroupId;
  parent_assignment_id?: AssignmentId | null;
  owner_thread_id?: ThreadId | null;
  requested_child?: CollaborationChildSpec | null;
  created_by_thread_id?: ThreadId | null;
  title: string;
  instructions: string;
  kind: AssignmentKind;
  status: AssignmentStatus;
  dispatch_message_id?: Uuid | null;
  base_revision?: string | null;
  depth: number;
  result?: AssignmentResult | null;
  uncertainty?: string | null;
  revision: number;
  created_at: DateTime;
  updated_at: DateTime;
}

export interface CollaborationChildSpec {
  provider: ProviderInstance;
  model?: string | null;
  effort?: string | null;
  permission_mode?: PermissionMode | null;
  base_revision?: string | null;
}

export type CollaborationMessagePurpose =
  | "progress"
  | "question"
  | "reply"
  | "change_request"
  | "result"
  | "failure"
  | "redirect";
export type CollaborationDeliveryState =
  | "persisted"
  | "queued"
  | "submitted"
  | "answered"
  | "failed"
  | "cancelled"
  | "uncertain";

export interface CollaborationMessage {
  id: CollaborationMessageId;
  operation_id: OperationId;
  group_id: GroupId;
  assignment_id?: AssignmentId | null;
  from_thread_id?: ThreadId | null;
  to_thread_id: ThreadId;
  /** Older daemons omit this field; false means ordinary group delivery. */
  external_recipient?: boolean;
  purpose: CollaborationMessagePurpose;
  reply_to?: CollaborationMessageId | null;
  body: string;
  state: CollaborationDeliveryState;
  delivery_turn_id?: TurnId | null;
  wakeup_count: number;
  created_at: DateTime;
  updated_at: DateTime;
}

export type ContextEntryKind =
  | "plan"
  | "brief"
  | "decision"
  | "research"
  | "instruction"
  | "result_reference";

export interface ContextEntry {
  id: ContextEntryId;
  group_id: GroupId;
  key: string;
  kind: ContextEntryKind;
  body: string;
  author_thread_id?: ThreadId | null;
  user_authored: boolean;
  revision: number;
  source_refs: string[];
  created_at: DateTime;
  updated_at: DateTime;
}

export interface CollaborationGroupDetail {
  coordinator_setup_complete?: boolean | null;
  group: CollaborationGroup;
  members: GroupMember[];
  assignments: CollaborationAssignment[];
  pending_messages: CollaborationMessage[];
}

export interface ContextEntryHistory {
  entry_id: ContextEntryId;
  revisions: ContextEntry[];
  next_before_revision?: number | null;
}

export interface ThreadReferencePart {
  type: "thread_reference";
  thread_id: ThreadId;
  title: string;
  project_id?: ProjectId | null;
}

/** A message from another thread, or from Kybern itself when `from_thread_id` is absent. Providers see flattened text. */
export interface ThreadMessagePart {
  type: "thread_message";
  /** The `thread_messages` row id; also the queued or steered message id. */
  message_id: MessageId;
  from_thread_id?: ThreadId | null;
  from_title: string;
  purpose: ThreadMessagePurpose;
  reply_to?: MessageId | null;
  body: string;
}

/** A batch of delegated-agent outcomes delivered to the delegating thread. */
export interface AgentResultsPart {
  type: "agent_results";
  items: AgentResultItem[];
}

export type ContentPart =
  | { type: "text"; text: string }
  | ThreadReferencePart
  | ThreadMessagePart
  | AgentResultsPart
  | { type: "image"; media_type: string; data: string }
  | {
      type: "attachment";
      asset_id: AssetId;
      name: string;
      media_type: string;
      size: number;
    }
  | { type: "file_mention"; path: string }
  | { type: "skill"; name: string; path: string }
  | { type: "mention"; name: string; path: string; display_name?: string | null };

export interface UserMessage {
  parts: ContentPart[];
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export type RuntimeTaskKind = "agent" | "process" | "monitor";
export type RuntimeTaskStatus =
  | "pending"
  | "running"
  | "waiting"
  | "stopping"
  | "completed"
  | "failed"
  | "stopped"
  | "interrupted";

export type EventOrigin =
  | { kind: "root" }
  | { kind: "agent"; task_id: string; provider_thread_id?: string | null };

export interface RuntimeTaskCapabilities {
  stop: boolean;
  background: boolean;
}

export interface RuntimeTaskStats {
  token_count?: number | null;
  tool_uses?: number | null;
  duration_ms?: number | null;
  cpu_percent?: number | null;
  rss_kb?: number | null;
}

export interface RuntimeTask {
  id: string;
  thread_id: ThreadId;
  origin_turn_id: TurnId;
  started_seq: EventSeq;
  updated_seq: EventSeq;
  kind: RuntimeTaskKind;
  status: RuntimeTaskStatus;
  title: string;
  detail?: string | null;
  provider_type?: string | null;
  parent_id?: string | null;
  tool_call_id?: string | null;
  provider_thread_id?: string | null;
  model?: string | null;
  effort?: string | null;
  backgrounded: boolean;
  last_tool_name?: string | null;
  usage?: Usage | null;
  stats: RuntimeTaskStats;
  capabilities: RuntimeTaskCapabilities;
  started_at: DateTime;
  updated_at: DateTime;
  completed_at?: DateTime | null;
}

export type ThreadActivityState = "working" | "monitoring";

export interface ThreadActivitySummary {
  thread_id: ThreadId;
  state?: ThreadActivityState | null;
  active_agents: number;
  active_processes: number;
  active_monitors: number;
}

export interface ApprovalRequest {
  id: ApprovalId;
  thread_id: ThreadId;
  turn_id: TurnId;
  tool_call_id?: string | null;
  tool_name: string;
  input: JsonValue;
  /** One-line summary, e.g. `bash: git status`. */
  summary: string;
  suggestions: JsonValue[];
  created_at: DateTime;
}

export type ApprovalDecision =
  | { decision: "submit"; response: unknown }
  | { decision: "allow_once" }
  | { decision: "allow_always" }
  | { decision: "deny"; reason?: string | null };

export interface ToolCall {
  id: string;
  name: string;
  input: JsonValue;
  parent_id?: string | null;
}

export type StopReason = "completed" | "interrupted" | "max_turns" | "error";

/** One content height measured at a frame width, in CSS pixels. */
export interface VisualHeight { width: number; height: number }
export interface HtmlVisual {
  id: Uuid;
  title: string;
  /** Agent-requested height cap in CSS pixels. */
  height: number;
  /** Content heights measured at publish, ascending by width; absent when not measured. */
  heights?: VisualHeight[];
}
export type TranscriptEntry =
  | { role: "visual"; turn_id: TurnId; seq: EventSeq; at: DateTime; visual: HtmlVisual }
  | { role: "image"; id: string; turn_id: TurnId; seq: number; at: string; origin: EventOrigin; source: string }
  | {
      role: "user";
      id: MessageId;
      turn_id: TurnId;
      seq: EventSeq;
      message: UserMessage;
      at: DateTime;
    }
  | {
      role: "assistant";
      id: MessageId;
      turn_id: TurnId;
      seq: EventSeq;
      origin: EventOrigin;
      /** Segment index within one `message_id`; the projection splits text at
       * each row-making event so post-tool prose is its own entry. 0 = only. */
      segment?: number;
      text: string;
      thinking?: string | null;
      /** The provider closed this segment's reasoning before the message completed. */
      thinking_complete?: boolean;
      at: DateTime;
      complete: boolean;
    }
  | {
      role: "tool_call";
      turn_id: TurnId;
      seq: EventSeq;
      origin: EventOrigin;
      call: ToolCall;
      output?: JsonValue;
      /** Settled result exists in the event log but was not inlined here. */
      output_omitted?: boolean;
      /** Settled output deltas exist in the event log but were not inlined here. */
      stream_omitted?: boolean;
      is_error: boolean;
      complete: boolean;
      at: DateTime;
    }
  | {
      role: "approval";
      turn_id: TurnId;
      seq: EventSeq;
      approval: ApprovalRequest;
      decision?: ApprovalDecision | null;
    }
  | {
      role: "turn_summary";
      turn_id: TurnId;
      seq: EventSeq;
      stop_reason: StopReason;
      usage: Usage;
      cost_usd?: number | null;
      duration_ms: number;
      terminal_message_id?: MessageId | null;
      at: DateTime;
      error?: string | null;
    }
  | {
      role: "runtime_task";
      turn_id: TurnId;
      seq: EventSeq;
      task: RuntimeTask;
      at: DateTime;
    }
  | {
      role: "notice";
      turn_id: TurnId;
      seq: EventSeq;
      level: NoticeLevel;
      text: string;
      at: DateTime;
    }
  | {
      role: "reverted";
      turn_id: TurnId;
      seq: EventSeq;
      commit: string;
      at: DateTime;
    };

export interface Checkpoint {
  thread_id: ThreadId;
  turn_id: TurnId;
  before: string;
  after?: string | null;
  provider_turn_id?: string | null;
  provider_turn_end?: string | null;
  created_at: DateTime;
}

export type FileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "type_changed"
  | "unknown";

export interface FileChange {
  path: string;
  old_path?: string | null;
  status: FileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface Diff {
  from: string;
  to: string;
  files: FileChange[];
  patch: string;
  patch_truncated?: boolean;
}

// ---- events ----

export type NoticeLevel = "info" | "warning" | "error";

/** Why the daemon closed an agent process; the next message resumes the conversation. */
export type SessionReleaseReason = "manual" | "idle" | "capacity" | "update" | "power";

export interface RecoveredAssistantBlock {
  message_id: MessageId;
  content_index: number;
  text: string;
  thinking: string | null;
  before_tool_call_id: string | null;
  seq: EventSeq;
  at: DateTime;
}

export type EventPayload =
  | { kind: "assistant_message_blocks_recovered"; message_id: MessageId; session_id: string; native_entry_id: string; blocks: RecoveredAssistantBlock[]; terminal_message_id: MessageId }
  | { kind: "html_published"; visual: HtmlVisual }
  | { kind: "async_questions_requested"; request: AsyncQuestionRequest }
  | { kind: "async_questions_answered"; request_id: string; answers: string[]; message_id: MessageId; message: UserMessage }
  | { kind: "thread_created"; thread: Thread }
  | { kind: "thread_updated"; thread: Thread }
  | { kind: "thread_archived" }
  | { kind: "worktree_cleaned"; branch: string; recovery_commit: string }
  | { kind: "worktree_restored"; branch: string }
  | { kind: "project_coordinator_deleted"; project_id: ProjectId; coordinator_thread_id: ThreadId }
  | { kind: "message_queued"; message: QueuedMessage }
  | { kind: "message_removed"; message_id: MessageId }
  | { kind: "message_queue_updated"; message: QueuedMessage }
  | { kind: "subagent_message_updated"; message: SubagentMessage }
  | { kind: "message_steered"; message_id: MessageId; message: UserMessage }
  | { kind: "thread_notes_updated"; notes: ThreadNotes }
  | { kind: "thread_message_held"; message: ThreadMessageRecord }
  /** A thread message changed state after it was created. Sent on the sender's thread and the recipient's. */
  | { kind: "thread_message_updated"; message: ThreadMessageRecord }
  | { kind: "thread_message_resolved"; message_id: MessageId; resolution: HeldResolution }
  | { kind: "collaboration_group_updated"; group: CollaborationGroup }
  | { kind: "collaboration_member_updated"; member: GroupMember }
  | { kind: "collaboration_assignment_updated"; assignment: CollaborationAssignment }
  | { kind: "collaboration_message_updated"; message: CollaborationMessage }
  | { kind: "collaboration_context_updated"; entry: ContextEntry }
  | { kind: "turn_started"; message_id: MessageId; message: UserMessage }
  | { kind: "turn_resumed" }
  | { kind: "session_transitioned"; from: ProviderInstance; to: ProviderInstance; native_resume: boolean; text: string }
  | { kind: "provider_session_bound"; session_id: string; model: string | null }
  | { kind: "provider_session_released"; reason: SessionReleaseReason }
  | { kind: "image_received"; id: string; origin: EventOrigin; source: string }
  | {
      kind: "assistant_text_delta";
      message_id: MessageId;
      origin: EventOrigin;
      delta: string;
    }
  | {
      kind: "assistant_thinking_delta";
      message_id: MessageId;
      origin: EventOrigin;
      delta: string;
    }
  | { kind: "assistant_thinking_completed"; message_id: MessageId; origin: EventOrigin }
  | {
      kind: "assistant_message_completed";
      message_id: MessageId;
      origin: EventOrigin;
      text: string;
      thinking: string | null;
    }
  | { kind: "tool_call_started"; call: ToolCall; origin: EventOrigin }
  | { kind: "tool_call_output_delta"; tool_call_id: string; delta: string }
  | {
      kind: "tool_call_completed";
      tool_call_id: string;
      output: JsonValue;
      /** Set when an opted-in event subscription defers a large result. */
      output_omitted?: boolean;
      /** This daemon can reconstruct the exact persisted output-delta stream. */
      stream_recoverable?: boolean;
      is_error: boolean;
    }
  | { kind: "runtime_task_started"; task: RuntimeTask }
  | { kind: "runtime_task_updated"; task: RuntimeTask }
  | { kind: "runtime_task_completed"; task: RuntimeTask }
  | { kind: "user_input_requested"; approval: ApprovalRequest }
  | { kind: "approval_requested"; approval: ApprovalRequest }
  | {
      kind: "approval_resolved";
      approval_id: ApprovalId;
      decision: ApprovalDecision;
    }
  | {
      kind: "turn_completed";
      stop_reason: StopReason;
      usage: Usage;
      cost_usd: number | null;
      duration_ms: number;
      terminal_message_id?: MessageId | null;
    }
  | { kind: "session_imported"; provider: ProviderKind; session_id: string }
  | { kind: "provider_commands_updated"; commands: ProviderCommand[] }
  | { kind: "provider_usage_updated"; usage: ProviderUsage }
  | { kind: "turn_failed"; error: string }
  | {
      kind: "provider_notice";
      level: NoticeLevel;
      text: string;
      data: JsonValue | null;
    }
  | { kind: "checkpoint_updated"; checkpoint: Checkpoint }
  | { kind: "workspace_reverted"; to_turn_id: TurnId; commit: string };

export interface SavedSession {
  provider: ProviderKind;
  id: string;
  title: string;
  cwd: string;
  updated_at: string;
  model?: string | null;
  thread_id?: ThreadId | null;
}
export interface SessionsListResult {
  sessions: SavedSession[];
  next_cursor: string | null;
}

export type EventKind = EventPayload["kind"];

/** `EventPayload` is `#[serde(flatten)]`ed into the event. */
export type ThreadEvent = {
  seq: EventSeq;
  thread_id: ThreadId;
  turn_id?: TurnId | null;
  at: DateTime;
} & EventPayload;

/** Params of the `event` notification. */
export interface EventNotification {
  subscription_id: SubscriptionId;
  event: ThreadEvent;
}

/** Params of the `events.lagged` notification. */
export interface EventsLaggedNotification {
  dropped: number;
}

// ---- methods ----

export type Empty = Record<string, never>;

export interface DaemonInfo {
  version: string;
  protocol_version: number;
  environment_id: string;
  hostname: string;
  os: string;
  arch: string;
  data_dir: string;
  scopes: Scope[];
  started_at: DateTime;
}

/** What the daemon is holding open right now. */
export interface DaemonActivity {
  connections: number;
  live_sessions: number;
  idle_sessions: number;
  running_threads: number;
  terminals: number;
  queued_messages: number;
  idle_since?: DateTime | null;
  idle_exit_at?: DateTime | null;
  /** Absent when the daemon cannot tell. */
  on_battery?: boolean | null;
}

export interface ProvidersListResult {
  providers: ProviderStatus[];
}

export interface ProjectsListResult {
  projects: Project[];
}

export const PROJECTS_CHANGED_NOTIFICATION = "projects.changed";

/** Sent after a project is added, updated or removed by any client or the daemon. */
export interface ProjectsChangedNotification {
  /** Every project after the change, in `projects.list` order. */
  projects: Project[];
}

export interface ProjectsAddParams {
  path: string;
  name?: string;
}

export interface ProjectsUpdateParams {
  project_id: ProjectId;
  name?: string;
  /** `null` clears the override. */
  worktrees_default?: boolean | null;
  /** 2–5 letters A-Z (uppercased), unique across projects, "TSK" reserved. Existing task keys keep their old prefix. Absent or null leaves it as it is. */
  task_prefix?: string | null;
}

export interface ProjectsRemoveParams {
  project_id: ProjectId;
}

export interface ThreadsListParams {
  project_id?: ProjectId;
  include_archived?: boolean;
  /** Also return read-only subagent threads and delegated children; left out by default. */
  include_subagents?: boolean;
  /** Only the direct subagent and delegated children of this thread (implies `include_subagents`). */
  parent_thread_id?: ThreadId;
}

export interface ThreadMessagesListParams {
  thread_id: ThreadId;
  /** Only messages in these states; omit for every state. */
  states?: ThreadMessageState[] | null;
}

export interface ThreadMessagesListResult {
  /** Messages sent to or from the thread, oldest first, at most the newest 200. */
  messages: ThreadMessageRecord[];
}

export interface DelegationsWorktreeRemoveParams {
  /** The delegated child whose worktree to remove. */
  thread_id: ThreadId;
  /** Required when the worktree is dirty or its branch is unmerged. The branch is deleted only when merged. */
  force?: boolean;
}

export interface ThreadsListResult {
  threads: Thread[];
  activity?: ThreadActivitySummary[];
}

export interface ThreadsSearchParams {
  project_id?: ProjectId | null;
  all_projects?: boolean;
  query?: string | null;
  include_archived?: boolean;
  cursor?: string | null;
  limit?: number;
}

export interface ThreadSearchHit {
  thread: Thread;
  snippet?: string | null;
  matched_at?: DateTime | null;
}

export interface ThreadsSearchResult {
  threads: ThreadSearchHit[];
  next_cursor?: string | null;
}

export interface ThreadReadMessage {
  seq: EventSeq;
  turn_id?: TurnId | null;
  role: "user" | "assistant" | "system";
  text: string;
  text_offset: number;
  next_text_offset?: number | null;
  text_truncated: boolean;
  created_at: DateTime;
  attribution: {
    kind: "user" | "agent" | "collaboration";
    thread_id?: ThreadId | null;
    collaboration_message_id?: CollaborationMessageId | null;
  };
}

export interface ThreadsReadResult {
  thread: Thread;
  messages: ThreadReadMessage[];
  next_before_seq?: EventSeq | null;
  through_seq: EventSeq;
}

export interface ThreadsCreateParams {
  /** Omit to create a free chat in the daemon-owned neutral workspace. */
  project_id?: ProjectId;
  provider: ProviderInstance;
  model?: string;
  effort?: string;
  permission_mode?: PermissionMode;
  use_worktree?: boolean;
  /** Branch to start from: a worktree forks from it, a local thread switches to it first. */
  base_branch?: string;
  title?: string;
  message?: UserMessage;
}

export interface ThreadsGetParams {
  thread_id: ThreadId;
  /** Newest entries, 1..500. Omit for the complete transcript. */
  transcript_limit?: number;
  before_seq?: EventSeq;
  /** Snapshot barrier for loading history while live events continue. */
  through_seq?: EventSeq;
  /** When false, large settled tool results are omitted from the page. */
  include_tool_output?: boolean;
  /** When true, completed output-delta streams are marked for exact lazy hydration. */
  defer_tool_stream?: boolean;
}

export interface ThreadsRecoverOmpAnswerParams { thread_id: ThreadId; turn_id: TurnId }
export interface ThreadsRecoverOmpAnswerResult { recovered: boolean; native_entry_id: string; block_count: number; correction_seq: EventSeq }

export interface ThreadsToolOutputParams {
  thread_id: ThreadId;
  tool_call_id: string;
  start_seq?: EventSeq;
  through_seq?: EventSeq;
  /** Include the exact persisted output-delta stream for this invocation. */
  include_tool_stream?: boolean;
}

export interface ThreadsToolOutputResult {
  output: JsonValue;
  /** Exact concatenation of persisted output deltas for this invocation. */
  stream?: string;
  /** Deltas exist but were not returned because stream hydration was not requested. */
  stream_omitted?: boolean;
  is_error: boolean;
}

export interface AsyncQuestionRequest { id: string; questions: { title: string; options: string[] }[] }
export interface ThreadsAnswerParams { thread_id: ThreadId; request_id: string; answers: string[] }
export interface ThreadsGetResult {
  notes?: ThreadNotes;
  pending_questions?: AsyncQuestionRequest[];
  provider_commands?: ProviderCommand[];
  provider_usage?: ProviderUsage;
  thread: Thread;
  transcript: TranscriptEntry[];
  next_before_seq?: EventSeq | null;
  pending_approvals: ApprovalRequest[];
  runtime_tasks?: RuntimeTask[];
}

export interface ThreadNotes {
  text: string;
  revision: number;
}

// ---- notes ----

// ---- in-app browser preview ----
export type PreviewTargetInfo =
  | { kind: "file"; path: string; root: string; in_project: boolean }
  | { kind: "server"; url: string; port: number }
  | { kind: "external"; url: string };
export interface PreviewFolderRequest { folder: string; grantable: boolean }
export interface PreviewOpenResult {
  target: PreviewTargetInfo;
  ticket?: string;
  /** HTTP path to load, e.g. `/preview-files/{ticket}/mock/index.html`. */
  path?: string;
  needs_permission?: PreviewFolderRequest;
}
export type PreviewProbeError = "connection_refused" | "timed_out" | "dns" | "tls" | "http_status" | "not_http";
export interface PreviewFrameBlock { header: "x-frame-options" | "content-security-policy" | string; value: string }
export interface PreviewProbeResult {
  reachable: boolean;
  status?: number;
  error?: PreviewProbeError;
  blocked_by?: PreviewFrameBlock;
  title?: string;
  location?: string;
}
export interface PreviewServer {
  url: string;
  port: number;
  host: string;
  pid?: number;
  process_name?: string;
  cwd?: string;
  title?: string;
  favicon?: string;
  framework?: string;
  in_project?: boolean;
}
export interface PreviewServersListResult {
  servers: PreviewServer[];
  scanned_at: string;
  method: "lsof" | "proc" | "common_ports" | string;
}
export const PREVIEW_OPEN_REQUESTED_NOTIFICATION = "previews.open_requested";
export interface PreviewOpenRequestedNotification {
  thread_id: ThreadId;
  target: string;
  title?: string;
  requested_by_agent: boolean;
}

export const NOTES_CHANGED_NOTIFICATION = "notes.changed";

export type NoteId = Uuid;
export type NoteScope = "global" | "project" | "thread";

/** A note without its body, as listed. */
export interface NoteSummary {
  id: NoteId;
  scope: NoteScope;
  /** The project of a project note, or the thread's project for a thread note. */
  project_id?: ProjectId | null;
  thread_id?: ThreadId | null;
  /** A thread note's title is the thread's title. */
  title: string;
  /** Plain-text excerpt of the body, markdown syntax removed, at most 240 characters. */
  preview: string;
  checklist: { done: number; total: number };
  pinned: boolean;
  /** Content revision: bumps when the title or body changes. 0 = no saved note yet. */
  revision: number;
  created_at: string;
  updated_at: string;
  /** Set while the note is in Recently deleted. */
  deleted_at?: string | null;
  /** Where a deleted note came from once its project or thread was removed, e.g. "kybern" or "kybern › Fix login". */
  origin?: string | null;
  /** The thread whose agent created the note with its native tools. Absent for notes the user wrote; agents may only append to those. */
  created_by_thread?: ThreadId | null;
}

export interface Note extends NoteSummary {
  /** Markdown. */
  body: string;
}

export interface NotesCreateParams {
  /** Only "global" or "project"; thread notes are created by `notes.update` with `thread_id`. */
  scope: NoteScope;
  project_id?: ProjectId | null;
  title?: string;
  body?: string;
}

export interface NotesUpdateParams {
  /** Exactly one of `id` or `thread_id`. `thread_id` with `expected_revision: 0` creates the thread's note. */
  id?: NoteId | null;
  thread_id?: ThreadId | null;
  /** Fails with CONFLICT (-32004) when the note changed elsewhere. */
  expected_revision: number;
  /** Ignored for thread notes. */
  title?: string | null;
  body?: string | null;
}

// ---- user tasks ("tasks.items.*"; `tasks.list` is runtime agent work) ----

export const TASK_ITEMS_CHANGED_NOTIFICATION = "tasks.items.changed";

export type TaskItemId = Uuid;
export type TaskScope = "global" | "project";
/** `running` and `needs_review` are owned by the latest run; the rest are set by the user. */
export type TaskStatus = "inbox" | "todo" | "running" | "needs_review" | "done" | "canceled";
/** 0 none, 1 urgent, 2 high, 3 medium, 4 low (Linear order). */
export type TaskPriority = 0 | 1 | 2 | 3 | 4;

export interface TaskRun {
  thread_id: ThreadId;
  /** 1-based within the task. */
  number: number;
  provider: ProviderInstance;
  model?: string | null;
  started_at: string;
  ended_at?: string | null;
  /** Live: "running" | "waiting" (approval or question). Settled: "completed" | "failed" | "interrupted". */
  state: "running" | "waiting" | "completed" | "failed" | "interrupted";
  /** What the agent is doing now, e.g. "Editing crates/kybern-drivers/src/cursor.rs". Running runs only. */
  activity?: string | null;
  /** Lines added/removed by the run's changes, when known. */
  diff?: { added: number; removed: number; files: number } | null;
  /** Notes sent with this run and the revision each was at. */
  notes?: { note_id: NoteId; revision: number }[];
}

export interface TaskItem {
  id: TaskItemId;
  /** Display id such as "ADE-14"; global tasks use "TSK". Never reused. */
  key: string;
  scope: TaskScope;
  project_id?: ProjectId | null;
  title: string;
  /** Markdown: description, optionally followed by acceptance criteria as a checklist. */
  body: string;
  status: TaskStatus;
  priority: TaskPriority;
  /** Position within its status column (ascending). */
  rank: number;
  /** Notes attached as context. */
  note_ids: NoteId[];
  /** The note whose checklist line created this task, if any. */
  source_note_id?: NoteId | null;
  /** Saved follow-up text to include in the next run (when no run is idle to receive it). */
  pending_followup?: string | null;
  runs: TaskRun[];
  /** Content revision for title/body edits; conflicts use CONFLICT (-32004). */
  revision: number;
  created_at: string;
  updated_at: string;
  /** When the status last changed. */
  status_changed_at: string;
  /** The thread whose agent created the task with its native tools. Absent for tasks the user created; agents may only append to and check items of those. */
  created_by_thread?: ThreadId | null;
}

export interface TaskItemsCreateParams {
  scope: TaskScope;
  project_id?: ProjectId | null;
  title: string;
  body?: string;
  /** Default "inbox". Only user statuses are accepted. */
  status?: TaskStatus;
  priority?: TaskPriority;
  note_ids?: NoteId[];
  /** Create from a checklist line: the daemon rewrites that line to carry `[KEY](kybern://task/<id>)`. */
  source?: { note_id: NoteId; line_text: string } | null;
}

export interface TaskItemsUpdateParams {
  id: TaskItemId;
  /** Required when title or body change. */
  expected_revision?: number | null;
  title?: string | null;
  body?: string | null;
  /** User statuses only: inbox, todo, done, canceled. A status without `before_id` places the task at the end of that column. */
  status?: TaskStatus | null;
  priority?: TaskPriority | null;
  /** Move between Global and a project (re-keys only if it has no runs). */
  scope?: TaskScope | null;
  project_id?: ProjectId | null;
  note_ids?: NoteId[] | null;
  /** Replaces the saved follow-up; an empty string clears it. */
  pending_followup?: string | null;
  /** Place before this task in the target status column (it must be in that column). */
  before_id?: TaskItemId | null;
}

export interface TaskItemsSendParams {
  id: TaskItemId;
  provider: ProviderInstance;
  model?: string | null;
  effort?: string | null;
  permission_mode?: PermissionMode | null;
  use_worktree?: boolean | null;
  base_branch?: string | null;
  /** Required for global tasks: where the run happens. */
  project_id?: ProjectId | null;
  /** The (possibly edited) prompt text. Exactly one of `prompt` or `message` is required. */
  prompt?: string;
  /** The full first message (text, mentions, skills, files, thread references, attachments). The daemon adds a `kybern://task/<id>` mention for this task at the start when the message has none; the provider's copy expands it to the task. */
  message?: UserMessage;
  /** Notes attached as `kybern://note/<id>` mentions; the daemon expands them in the provider's copy only. Only the notes listed here are sent. A saved `pending_followup` is cleared by the send (the prompt is expected to include it). */
  note_ids?: NoteId[];
}

/** One run per task (`separate`, started in parallel), or one thread that every task records a run for (`combined`). */
export type TaskBatchMode = "separate" | "combined";

/** Send several tasks to an agent at once. Mirrors `TaskItemsSendParams` with `ids`; the same message and agent settings apply to every task. */
export interface TaskItemsSendBatchParams {
  /** The tasks to send, in order. Repeats are ignored. At most 200. */
  ids: TaskItemId[];
  /** Defaults to `separate`. */
  mode?: TaskBatchMode;
  provider: ProviderInstance;
  model?: string | null;
  effort?: string | null;
  permission_mode?: PermissionMode | null;
  use_worktree?: boolean | null;
  base_branch?: string | null;
  /** The project to run global tasks in. Required when any task is global; a project's tasks run in their own project. */
  project_id?: ProjectId | null;
  /** The prompt text. Exactly one of `prompt` or `message` is required. The daemon adds a `kybern://task/<id>` mention for each task at the start. */
  prompt?: string;
  /** The full first message. Each task's mention is added at the start when the message has none for it. */
  message?: UserMessage;
  /** Notes attached as `kybern://note/<id>` mentions to every run. */
  note_ids?: NoteId[];
}

/** A combined run lists every task with the same thread. */
export interface TaskBatchStarted {
  task: TaskItem;
  thread_id: ThreadId;
}

/** A task that did not start; `reason` is words for the user, such as "Already running". */
export interface TaskBatchSkipped {
  id: TaskItemId;
  reason: string;
}

export interface TaskItemsSendBatchResult {
  started: TaskBatchStarted[];
  skipped: TaskBatchSkipped[];
}

export interface TaskItemsFollowupParams {
  id: TaskItemId;
  /** Plain text. Exactly one of `text` or `message` is required. */
  text?: string;
  /** The full follow-up, sent or queued as is. With no run to receive it, text and references are saved as readable text; attachments are refused. */
  message?: UserMessage;
}

export interface TaskItemsChangedNotification {
  task?: TaskItem | null;
  deleted_id?: TaskItemId | null;
}

export interface NotesChangedNotification {
  /** The note after the change, including soft deletes and restores. */
  note?: NoteSummary | null;
  /** Set instead of `note` when a note was permanently removed. */
  purged_id?: NoteId | null;
}

export interface ThreadsUpdateParams {
  thread_id: ThreadId;
  title?: string;
  pinned?: boolean;
  permission_mode?: PermissionMode;
  model?: string;
  effort?: string;
}

export interface ThreadsArchiveParams {
  thread_id: ThreadId;
}

export interface ThreadsSendParams {
  thread_id: ThreadId;
  message: UserMessage;
  message_id?: MessageId | null;
}

export interface ThreadsSendResult {
  turn_id: TurnId;
  message_id: MessageId;
}

export interface ThreadsInterruptParams {
  thread_id: ThreadId;
}

export interface TasksListParams {
  thread_id: ThreadId;
  include_completed?: boolean;
}

export interface TasksListResult {
  tasks: RuntimeTask[];
}

/** `thread_id` may be a subagent thread: the daemon then acts on its own task and ignores `task_id`. */
export interface TaskControlParams {
  thread_id: ThreadId;
  task_id?: string;
}

export interface ThreadsRegenerateTitleParams {
  thread_id: ThreadId;
}

export interface ThreadsCheckpointsParams {
  thread_id: ThreadId;
}

export interface ThreadsCheckpointsResult {
  checkpoints: Checkpoint[];
}

export interface ThreadsDiffParams {
  thread_id: ThreadId;
  turn_id?: TurnId;
  include_patch?: boolean;
  path?: string;
}

export interface ThreadsRevertParams {
  thread_id: ThreadId;
  turn_id: TurnId;
}

export interface ThreadsRevertResult {
  commit: string;
  conversation_rewound: boolean;
}

export interface TerminalInfo {
  id: TerminalId;
  thread_id?: ThreadId | null;
  cwd: string;
  cols: number;
  rows: number;
  title: string;
  alive: boolean;
  exit_code?: number | null;
  created_at: DateTime;
}

export interface TerminalsCreateParams {
  terminal_id?: TerminalId;
  thread_id?: ThreadId;
  cwd?: string;
  cols?: number;
  rows?: number;
  command?: string[];
}

export interface TerminalsListParams {
  thread_id?: ThreadId;
}

export interface TerminalsListResult {
  terminals: TerminalInfo[];
}

export interface TerminalsInputParams {
  terminal_id: TerminalId;
  /** Raw bytes, base64. */
  data: string;
}

export interface TerminalsResizeParams {
  terminal_id: TerminalId;
  cols: number;
  rows: number;
}

export interface TerminalsCloseParams {
  terminal_id: TerminalId;
}

export interface TerminalsSubscribeParams {
  terminal_id: TerminalId;
  replay?: boolean;
}

export interface TerminalOutputNotification {
  terminal_id: TerminalId;
  data: string;
}

export interface TerminalExitedNotification {
  terminal_id: TerminalId;
  exit_code?: number | null;
}

export const TERMINAL_OUTPUT_NOTIFICATION = "terminal.output";
export const TERMINAL_EXITED_NOTIFICATION = "terminal.exited";

/** `decision` is `#[serde(flatten)]`ed next to `approval_id`. */
export type ApprovalsRespondParams = {
  approval_id: ApprovalId;
} & ApprovalDecision;

export interface ApprovalsListParams {
  thread_id?: ThreadId;
}

export interface ApprovalsListResult {
  approvals: ApprovalRequest[];
}

export interface EventsSubscribeParams {
  thread_id?: ThreadId;
  /** Replay persisted events with `seq > after_seq` before going live. */
  after_seq?: EventSeq;
  /** Include large completed tool outputs; omitted keeps legacy full events. */
  include_tool_output?: boolean;
}

export interface EventsSubscribeResult {
  subscription_id: SubscriptionId;
  head_seq: EventSeq;
  /** Available on daemons that send events.ready after replay. */
  replay_ready?: boolean;
}

export interface EventsReadyNotification {
  subscription_id: SubscriptionId;
  head_seq: EventSeq;
}

export interface EventsUnsubscribeParams {
  subscription_id: SubscriptionId;
}

export interface EventsRangeParams {
  thread_id: ThreadId;
  after_seq?: EventSeq;
  limit?: number;
}

export interface EventsRangeResult {
  events: ThreadEvent[];
  has_more: boolean;
}

// ---- settings, usage, git, github ----

export interface ProviderSettings {
  accounts?: Record<string, ProviderAccount>;
  default_account?: string | null;
  project_accounts?: Record<string, string>;
  binary?: string | null;
  model?: string | null;
  env: Record<string, string>;
  /** OMP profile overrides keyed by registered project path. */
  project_profiles?: Record<string, string>;
}

/** Limits on what the daemon keeps alive after work finishes. Minutes; 0 turns a limit off. */
export interface BackgroundSettings {
  session_idle_minutes: number;
  max_idle_sessions: number;
  terminal_idle_minutes: number;
  daemon_idle_exit_minutes: number;
  /** On battery, idle agents are released after a minute and automatic harness updates wait. */
  save_power_on_battery: boolean;
}

/** Extra listeners besides loopback, so paired phones can reach the daemon after a restart. */
export interface AccessSettings {
  tailscale: boolean;
}

export interface Settings {
  default_provider: ProviderKind;
  default_permission_mode: PermissionMode;
  worktrees_default: boolean;
  automatic_worktree_cleanup?: boolean;
  generate_titles: boolean;
  title_provider?: ProviderKind | null;
  providers: Partial<Record<ProviderKind, ProviderSettings>>;
  notifications: boolean;
  auto_update_harnesses: boolean;
  auto_update_daemon: boolean;
  background: BackgroundSettings;
  access: AccessSettings;
  computer_use: ComputerUseSettings;
  /** Limits on agents delegating work to other agents. */
  orchestration: OrchestrationSettings;
  /** Give new agent sessions a short guide to Kybern. Defaults to on. */
  tell_agents_about_kybern: boolean;
  /** Folders outside a project the user allowed Preview to serve files from. */
  preview_allowed_folders?: string[];
}

/** Limits for `kybern_agent_delegate`, read each time an agent delegates. */
export interface OrchestrationSettings {
  /** Most delegated children one thread may have running at once (1-16). */
  max_active_children: number;
  /** Deepest chain of delegation; 1 means only top-level threads delegate (1-4). */
  max_depth: number;
}

/** Whether an agent may ask to use the real cursor and focus. */
export type ComputerForeground = "ask" | "never";

/** Agents drive apps on this Mac through a separately installed CuaDriver. Codex keeps its own plugin. */
export interface ComputerUseSettings {
  enabled: boolean;
  foreground: ComputerForeground;
  /** Draw CuaDriver's agent cursor where agents act. Off by default; it uses much more memory. */
  show_cursor?: boolean;
  /** Apps agents may use in the background without asking. */
  always_allowed_apps?: string[];
}

export type ComputerPermission = "granted" | "missing" | "unknown";

export interface ComputerCheck {
  name: string;
  ok: boolean;
  message: string;
  fix?: string | null;
}

export interface ComputerStatus {
  supported: boolean;
  enabled: boolean;
  installed: boolean;
  app_path?: string | null;
  version?: string | null;
  required_version: string;
  signed: boolean;
  accessibility: ComputerPermission;
  screen_recording: ComputerPermission;
  ready: boolean;
  checks: ComputerCheck[];
}

/** What an agent last saw while using an app. Transient: never stored in the transcript. */
export interface ComputerFrame {
  seq: number;
  window_id: number;
  app: string;
  title?: string | null;
  /** The step that led to this frame, e.g. `Pressed “Equals”`. */
  action?: string | null;
  /** Where that step acted, from 0 to 1 across and down the picture. */
  point?: [number, number] | null;
  media_type: string;
  data: string;
  width: number;
  height: number;
  captured_at: string;
}

export interface ComputerFrameParams {
  thread_id: ThreadId;
  after?: number | null;
}

export interface ComputerFrameResult {
  frame?: ComputerFrame | null;
}

export type ComputerSetupAction = "install" | "grant_permissions";

export interface ComputerSetupParams {
  action: ComputerSetupAction;
}

export type CursorAccount = "signed_in" | "signed_out" | "api_key" | "unknown";

/** The Cursor SDK on the daemon machine, set up from Settings or `kybern cursor`. */
export interface CursorSetupStatus {
  /** The exact `@cursor/sdk` version this daemon installs and requires. */
  sdk_version: string;
  installed: boolean;
  /** The Node.js version the SDK runs on, e.g. `v24.1.0`. */
  node_version?: string | null;
  /** What to fix on the machine before installing, e.g. a missing Node.js. */
  problem?: string | null;
  account: CursorAccount;
  email?: string | null;
  /** An install is running in the background. */
  installing: boolean;
  /** A browser sign-in is waiting for the user. */
  signing_in: boolean;
  /** The page that completes the pending sign-in. */
  login_url?: string | null;
  /** Why the last install or sign-in failed. */
  error?: string | null;
}

export type CursorSetupAction = "install" | "sign_in" | "cancel_sign_in" | "sign_out";

export interface CursorSetupParams {
  action: CursorSetupAction;
}

/** What agents learned about using one app, shown to later sessions. */
export interface ComputerNote {
  bundle_id: string;
  app: string;
  text: string;
  updated_at: string;
}

export interface ComputerNotesResult {
  notes: ComputerNote[];
}

export interface ComputerNoteSetParams {
  bundle_id: string;
  /** The whole note. Empty deletes it. */
  text: string;
  /** The app's display name, for a note that does not exist yet. */
  app?: string | null;
}

export interface SettingsUpdateParams {
  settings: Settings;
}

export type UsageGroup = "provider" | "model" | "day" | "thread";

export interface UsageSummaryParams {
  since?: DateTime;
  group_by?: UsageGroup;
}

export interface UsageRow {
  key: string;
  turns: number;
  usage: Usage;
  cost_usd: number;
}

export interface UsageSummaryResult {
  rows: UsageRow[];
  total: UsageRow;
}

export interface UsageLimitsParams {
  /** Answer from the daemon's cache now; stale providers re-read in the background and arrive as `usage.limits.changed`. */
  cached?: boolean;
  /** Re-read every provider now, even if fresh. */
  refresh?: boolean;
}
/** Where a provider's current limits came from. */
export type LimitsSource = "live" | "session" | "stored";
/** Why a provider's live read did not update its limits. */
export type LimitsStale = "login_refresh" | "throttled" | "unavailable";
export interface ProviderLimits {
  provider: ProviderKind;
  limits: NonNullable<ProviderUsage["limits"]>;
  /** When these values were observed (ISO). Absent from older daemons. */
  updated_at?: string;
  source?: LimitsSource;
  /** Plan name when the provider reports one, e.g. "Pro+". */
  plan?: string;
  /** Why the last live read left these values as they were. Absent while reads succeed. */
  stale?: LimitsStale;
  /** While reads are throttled: when the next one may run (ISO). */
  retry_at?: string;
}
export interface UsageLimitsResult {
  providers: ProviderLimits[];
  /** Providers with a live read in flight. */
  refreshing?: ProviderKind[];
}
/** Params are a full UsageLimitsResult. */
export const USAGE_LIMITS_CHANGED_NOTIFICATION = "usage.limits.changed";

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  state: string;
  head: string;
  base: string;
  is_draft: boolean;
  author: string;
  updated_at: DateTime;
}

export interface GitStatusParams {
  thread_id: ThreadId;
}

export interface GitStatus {
  is_git: boolean;
  branch?: string | null;
  dirty_files: number;
  ahead: number;
  behind: number;
  upstream?: string | null;
  remote_url?: string | null;
  pull_request?: PullRequest | null;
}

export interface GitBranchesParams {
  project_id: ProjectId;
}

export interface BranchInfo {
  name: string;
  is_current: boolean;
  upstream?: string | null;
  /** Committer time of the tip commit, unix seconds. */
  committed_at: number;
}

export interface GitBranchesResult {
  current?: string | null;
  /** Local branches, most recently committed first. Empty when the project is not a repository. */
  branches: BranchInfo[];
}

export interface GitCommitParams {
  thread_id: ThreadId;
  message?: string;
}

export interface GitCommitResult {
  commit: string;
  message: string;
}

export interface PrCreateParams {
  thread_id: ThreadId;
  title?: string;
  body?: string;
  base?: string;
  draft?: boolean;
  commit_first?: boolean;
}

export interface PrListParams {
  project_id: ProjectId;
  state?: string;
  limit?: number;
}

export interface PrListResult {
  pull_requests: PullRequest[];
}

export interface PrDetailParams { project_id: ProjectId; number: number }
export interface PrCheck { name: string; status: string; conclusion: string; url: string }
export interface PrDetailResult { pull_request: PullRequest; body: string; head_sha: string; reviewers: string[]; checks: PrCheck[]; changed_files: number }
export type PrPageKind = "files" | "comments" | "reviews" | "review_comments" | "checks";
export interface PrPageParams { project_id: ProjectId; number: number; kind: PrPageKind; page?: number }
export interface PrFile { path: string; old_path: string | null; status: string; additions: number; deletions: number; patch: string; patch_truncated: boolean }
export interface PrReviewEntry { id: number; author: string; body: string; state: string; path: string | null; line: number | null; side: string | null; url: string; updated_at: string }
export interface PrPageResult { checks?: PrCheck[]; files: PrFile[]; entries: PrReviewEntry[]; page: number; has_more: boolean }
export type PrActionKind = "comment" | "approve" | "request_changes" | "checkout" | "merge" | "close";
export interface PrInlineComment { path: string; line: number; side: string; body: string }
export interface PrActionParams { project_id: ProjectId; number: number; action: PrActionKind; body?: string; inline_comments?: PrInlineComment[]; head_sha?: string; thread_id?: ThreadId; for_repair?: boolean }
export interface WorktreeInspectParams { thread_id: ThreadId }
export interface WorktreeInspectResult { path: string; branch: string; exists: boolean; clean: boolean; merged: boolean; ignored_files: number; blockers: string[]; eligible: boolean }
export interface WorktreeRemoveParams { thread_id: ThreadId; force?: boolean; delete_branch?: boolean }

export interface ProvidersListParams {
  project_id?: ProjectId;
  /** Bypass the daemon's short-lived provider catalog cache. */
  force_refresh?: boolean;
}

export interface FilesSearchParams {
  project_id: ProjectId;
  query?: string;
  limit?: number;
}

export interface FilesSearchResult {
  /** Paths relative to the project root, best match first. */
  files: string[];
  total: number;
}

export type FileEntryKind = "file" | "directory";

export interface FileEntry {
  name: string;
  /** Path relative to the project root. */
  path: string;
  kind: FileEntryKind;
  size?: number | null;
}

export interface FilesListParams {
  project_id: ProjectId;
  /** Directory relative to the project root; empty for the root. */
  path?: string;
}

export interface FilesListResult {
  entries: FileEntry[];
}

export interface FilesReadParams {
  project_id: ProjectId;
  path: string;
  max_bytes?: number;
}

export interface ThreadFileReadParams {
  thread_id: ThreadId;
  path: string;
  max_bytes?: number;
}

export interface FilesReadResult {
  content: string;
  truncated: boolean;
  binary: boolean;
  size: number;
}

export type SkillScope =
  "project" | "repo" | "user" | "system" | "admin" | "app" | "plugin" | "other";

export interface SkillInfo {
  name: string;
  display_name?: string | null;
  description?: string | null;
  path: string;
  scope: SkillScope;
  enabled: boolean;
}

export interface SkillsListParams {
  project_id: ProjectId;
  provider: ProviderKind;
}

export interface SkillsListResult {
  skills: SkillInfo[];
}

export interface AssetInfo {
  id: AssetId;
  name: string;
  media_type: string;
  size: number;
  created_at: DateTime;
}

export interface PairingCreateResult {
  code: string;
  expires_at: DateTime;
  endpoints: string[];
}
/** Which networks the daemon listens on besides loopback. */
export interface Exposure {
  /** This machine's Tailscale IPv4 address when Tailscale runs and the daemon could bind it. */
  tailscale_ip?: string | null;
  tailscale: boolean;
  listeners: string[];
}
export interface ExposureSetParams {
  tailscale: boolean;
}
export interface TokenInfo {
  id: string;
  label: string;
  scopes: Scope[];
  created_at: DateTime;
  last_used_at?: DateTime | null;
  revoked: boolean;
}
export interface ProjectsBrowseResult {
  path: string;
  parent: string | null;
  directories: { name: string; path: string }[];
  has_more: boolean;
}

/** Method name → [params, result]. The single place typed calls are derived from. */
export interface QueuedMessage {
  id: MessageId;
  thread_id: ThreadId;
  message: UserMessage;
}

export interface Methods {
  "queue.add": [QueuedMessage, Record<string, never>];
  "queue.update": [QueuedMessage, Record<string, never>];
  "subagents.send": [QueuedMessage, SubagentMessage];
  "subagents.messages": [ThreadsInterruptParams, SubagentMessage[]];
  "subagents.send_to_parent": [SubagentMessageActionParams, SubagentMessage];
  "threads.steer": [QueuedMessage, ThreadsSendResult];
  "threads.notes.get": [{ thread_id: ThreadId }, ThreadNotes];
  "threads.notes.set": [{ thread_id: ThreadId; text: string; expected_revision: number }, ThreadNotes];
  "notes.list": [Empty, { notes: NoteSummary[] }];
  "notes.get": [{ id?: NoteId | null; thread_id?: ThreadId | null }, { note?: Note | null }];
  "notes.create": [NotesCreateParams, Note];
  "notes.update": [NotesUpdateParams, Note];
  "notes.pin": [{ id: NoteId; pinned: boolean }, NoteSummary];
  "notes.move": [{ id: NoteId; scope: NoteScope; project_id?: ProjectId | null }, NoteSummary];
  "notes.delete": [{ id: NoteId }, NoteSummary];
  "notes.restore": [{ id: NoteId }, NoteSummary];
  "notes.purge": [{ id: NoteId }, Empty];
  "notes.search": [{ query: string; limit?: number | null }, { results: { id: NoteId; snippet: string }[] }];
  "tasks.items.list": [Empty, { tasks: TaskItem[] }];
  "tasks.items.get": [{ id?: TaskItemId | null; key?: string | null }, { task?: TaskItem | null }];
  "tasks.items.create": [TaskItemsCreateParams, TaskItem];
  "tasks.items.update": [TaskItemsUpdateParams, TaskItem];
  "tasks.items.delete": [{ id: TaskItemId }, Empty];
  "tasks.items.restore": [{ id: TaskItemId }, TaskItem];
  "tasks.items.send": [TaskItemsSendParams, { task: TaskItem; thread_id: ThreadId }];
  "tasks.items.send_batch": [TaskItemsSendBatchParams, TaskItemsSendBatchResult];
  "tasks.items.followup": [TaskItemsFollowupParams, { task: TaskItem; sent_to?: ThreadId | null }];
  "queue.list": [{ thread_id?: ThreadId }, { messages: QueuedMessage[] }];
  "queue.remove": [
    { thread_id: ThreadId; id: MessageId },
    Record<string, never>,
  ];
  "daemon.info": [Empty, DaemonInfo];
  "daemon.activity": [Empty, DaemonActivity];
  "sessions.list": [{ provider: ProviderKind; query?: string; project_id?: ProjectId | null; cursor?: string | null }, SessionsListResult];
  "sessions.resume": [{ provider: ProviderKind; session_id: string; project_id?: ProjectId | null }, Thread];
  "providers.accounts.create": [{ kind: ProviderKind; name: string; directory?: string | null }, ProviderInstance];
  "providers.accounts.sign_in": [ProviderInstance, TerminalInfo];
  "providers.accounts.usage": [ProviderInstance, ProviderUsage];
  "providers.accounts.catalog": [{ provider: ProviderInstance; project_id?: ProjectId | null; force_refresh?: boolean }, ProviderStatus];
  "threads.target.get": [{ thread_id: ThreadId }, ThreadTargetState];
  "threads.target.set": [{ thread_id: ThreadId; target: SessionTarget; inherit_account?: boolean }, ThreadTargetState];
  "threads.permissions.apply": [{ thread_id: ThreadId }, Thread];
  "threads.switch_continue": [{ thread_id: ThreadId; provider: ProviderInstance; message_id: MessageId }, ThreadsSendResult];
  "providers.list": [ProvidersListParams, ProvidersListResult];
  "harness_updates.list": [Empty, { updates: HarnessUpdate[] }];
  "harness_updates.run": [{ kind: ProviderKind }, HarnessUpdate];
  "daemon_update.status": [Empty, DaemonUpdate];
  "daemon_update.check": [Empty, DaemonUpdate];
  "daemon_update.run": [Empty, DaemonUpdate];
  "files.search": [FilesSearchParams, FilesSearchResult];
  "files.list": [FilesListParams, FilesListResult];
  "files.read": [FilesReadParams, FilesReadResult];
  "threads.files.read": [ThreadFileReadParams, FilesReadResult];
  "skills.list": [SkillsListParams, SkillsListResult];
  "threads.visuals.publish": [{ thread_id: ThreadId; html: string; title: string; height: number }, { visual: HtmlVisual }];
  "threads.visuals.preview": [{ thread_id: ThreadId; html: string; width?: number; appearance?: "dark" | "light" }, { width: number; content_height: number; captured_height: number; console_messages: {level: string; text: string}[]; missing_images: string[]; screenshot: string }];
  "threads.visuals.read": [{ thread_id: ThreadId; visual_id: Uuid; max_bytes?: number | null }, { html: string; truncated?: boolean }];
  "threads.visuals.frame": [{ thread_id: ThreadId; visual_id: Uuid; max_bytes?: number | null }, { ticket: string }];
  "threads.visuals.revoke": [{ thread_id: ThreadId; ticket: string }, Record<string, never>];
  "previews.open": [{ thread_id: ThreadId; target: string; allow_folder?: boolean; proxy?: boolean }, PreviewOpenResult];
  "previews.close": [{ ticket: string }, Record<string, never>];
  "previews.probe": [{ url: string }, PreviewProbeResult];
  "previews.servers.list": [{ thread_id?: ThreadId | null }, PreviewServersListResult];
  "threads.artifacts.list": [{ thread_id: ThreadId; before_seq?: number | null; limit?: number }, { artifacts: ArtifactTool[]; next_before_seq: number | null }];
  "threads.artifacts.preview": [{ thread_id: ThreadId; path: string }, { ticket: string }];
  "threads.artifacts.read": [{ thread_id: ThreadId; path: string }, FilesReadResult];
  "integrations.list": [{ project_id: ProjectId; provider: ProviderKind }, IntegrationsCatalog];
  "integrations.change": [{ project_id: ProjectId; provider: ProviderKind; id: string; kind: IntegrationKind; scope?: string | null; action: IntegrationAction }, IntegrationChangeResult];
  "integrations.login": [{ thread_id: ThreadId; name: string }, TerminalInfo];
  "daemon.shutdown": [Empty, Empty];
  "projects.list": [Empty, ProjectsListResult];
  "projects.browse": [{ path?: string }, ProjectsBrowseResult];
  "access.pairing.create": [{ label?: string }, PairingCreateResult];
  "access.exposure.get": [Empty, Exposure];
  "access.exposure.set": [ExposureSetParams, Exposure];
  "access.tokens.list": [Empty, { tokens: TokenInfo[] }];
  "access.tokens.revoke": [{ token_id: string }, Empty];
  "projects.add": [ProjectsAddParams, Project];
  "projects.update": [ProjectsUpdateParams, Project];
  "projects.remove": [ProjectsRemoveParams, Empty];
  "threads.list": [ThreadsListParams, ThreadsListResult];
  "threads.search": [ThreadsSearchParams, ThreadsSearchResult];
  "threads.read": [{ thread_id: ThreadId; before_seq?: EventSeq | null; through_seq?: EventSeq | null; limit?: number; message_seq?: EventSeq | null; text_offset?: number | null }, ThreadsReadResult];
  "threads.create": [ThreadsCreateParams, Thread];
  "threads.get": [ThreadsGetParams, ThreadsGetResult];
  "threads.recover_omp_answer": [ThreadsRecoverOmpAnswerParams, ThreadsRecoverOmpAnswerResult];
  "threads.tool_output": [ThreadsToolOutputParams, ThreadsToolOutputResult];
  "threads.update": [ThreadsUpdateParams, Thread];
  "threads.archive": [ThreadsArchiveParams, Empty];
  "threads.send": [ThreadsSendParams, ThreadsSendResult];
  "threads.release": [ThreadsInterruptParams, Empty];
  "threads.answer": [ThreadsAnswerParams, Empty];
  "threads.compact": [ThreadsInterruptParams, ThreadsSendResult];
  "threads.interrupt": [ThreadsInterruptParams, Empty];
  "threads.messages.list": [ThreadMessagesListParams, ThreadMessagesListResult];
  "threads.messages.deliver": [{ message_id: MessageId }, ThreadMessageRecord];
  "threads.messages.dismiss": [{ message_id: MessageId }, ThreadMessageRecord];
  "delegations.worktree_remove": [DelegationsWorktreeRemoveParams, Thread];
  "collaboration.coordinator.get": [{ project_id: ProjectId }, ProjectCoordinator | null];
  "collaboration.coordinator.get_or_create": [ProjectCoordinatorCreateParams, ProjectCoordinator];
  "collaboration.coordinator.delete": [{ operation_id: OperationId; project_id: ProjectId; thread_id: ThreadId }, Thread];
  "collaboration.coordinator.switch_harness": [ProjectCoordinatorSwitchHarnessParams, ProjectCoordinator];
  "collaboration.groups.create": [{ operation_id: OperationId; project_id: ProjectId; coordinator_thread_id: ThreadId; objective: string; success_criteria?: string[]; coordinator_mode?: CoordinatorMode | null; policy?: CollaborationPolicy | null }, CollaborationGroup];
  "collaboration.groups.get": [{ group_id: GroupId }, CollaborationGroupDetail];
  "collaboration.groups.list": [{ project_id?: ProjectId | null; include_stopped?: boolean; cursor?: string | null; limit?: number }, { groups: CollaborationGroup[]; next_cursor?: string | null }];
  "collaboration.groups.update": [{ operation_id: OperationId; group_id: GroupId; expected_revision: number; objective?: string | null; success_criteria?: string[] | null; coordinator_thread_id?: ThreadId | null; coordinator_mode?: CoordinatorMode | null; policy?: CollaborationPolicy | null }, CollaborationGroup];
  "collaboration.groups.control": [{ operation_id: OperationId; group_id: GroupId; action: "pause" | "stop" | "resume" | "complete" }, CollaborationGroup];
  "collaboration.members.attach": [{ operation_id: OperationId; group_id: GroupId; thread_id: ThreadId; role: GroupMemberRole }, GroupMember];
  "collaboration.members.detach": [{ operation_id: OperationId; group_id: GroupId; thread_id: ThreadId }, Empty];
  "collaboration.assignments.create": [{ operation_id: OperationId; group_id: GroupId; parent_assignment_id?: AssignmentId | null; owner_thread_id?: ThreadId | null; child?: CollaborationChildSpec | null; title: string; instructions: string; kind: AssignmentKind }, CollaborationAssignment];
  "collaboration.assignments.get": [{ assignment_id: AssignmentId }, CollaborationAssignment];
  "collaboration.assignments.list": [{ group_id: GroupId; include_finished?: boolean; cursor?: string | null; limit?: number }, { assignments: CollaborationAssignment[]; next_cursor?: string | null }];
  "collaboration.assignments.update": [{ operation_id: OperationId; assignment_id: AssignmentId; expected_revision: number; status: AssignmentStatus; uncertainty?: string | null }, CollaborationAssignment];
  "collaboration.assignments.complete": [{ operation_id: OperationId; assignment_id: AssignmentId; result: AssignmentResult }, CollaborationAssignment];
  "collaboration.assignments.cancel": [{ operation_id: OperationId; assignment_id: AssignmentId; reason?: string | null }, CollaborationAssignment];
  "collaboration.messages.send": [{ operation_id: OperationId; group_id: GroupId; assignment_id?: AssignmentId | null; from_thread_id?: ThreadId | null; to_thread_id: ThreadId; purpose: CollaborationMessagePurpose; reply_to?: CollaborationMessageId | null; body: string }, CollaborationMessage];
  "collaboration.messages.list": [{ group_id: GroupId; thread_id?: ThreadId | null; assignment_id?: AssignmentId | null; cursor?: string | null; limit?: number }, { messages: CollaborationMessage[]; next_cursor?: string | null }];
  "collaboration.context.put": [{ operation_id: OperationId; group_id: GroupId; entry_id?: ContextEntryId | null; key: string; kind: ContextEntryKind; body: string; author_thread_id?: ThreadId | null; user_authored?: boolean; expected_revision?: number | null; source_refs?: string[] }, ContextEntry];
  "collaboration.context.list": [{ group_id: GroupId; keys?: string[]; kinds?: ContextEntryKind[]; cursor?: string | null; limit?: number }, { entries: ContextEntry[]; next_cursor?: string | null }];
  "collaboration.context.history": [{ entry_id: ContextEntryId; before_revision?: number | null; limit?: number }, ContextEntryHistory];
  "collaboration.wait": [{ group_id: GroupId; assignment_ids?: AssignmentId[]; cursor?: string | null; timeout_ms?: number }, { cursor: string; timed_out: boolean; group?: CollaborationGroup; members: GroupMember[]; assignments: CollaborationAssignment[]; messages: CollaborationMessage[]; context_entries: ContextEntry[] }];
  "tasks.list": [TasksListParams, TasksListResult];
  "tasks.stop": [TaskControlParams, RuntimeTask];
  "tasks.background": [TaskControlParams, RuntimeTask];
  "threads.regenerateTitle": [ThreadsRegenerateTitleParams, Thread];
  "threads.checkpoints": [ThreadsCheckpointsParams, ThreadsCheckpointsResult];
  "threads.diff": [ThreadsDiffParams, Diff];
  "threads.revert": [ThreadsRevertParams, ThreadsRevertResult];
  "terminals.create": [TerminalsCreateParams, TerminalInfo];
  "terminals.list": [TerminalsListParams, TerminalsListResult];
  "terminals.input": [TerminalsInputParams, Empty];
  "terminals.resize": [TerminalsResizeParams, Empty];
  "terminals.close": [TerminalsCloseParams, Empty];
  "terminals.subscribe": [TerminalsSubscribeParams, Empty];
  "terminals.unsubscribe": [TerminalsCloseParams, Empty];
  "approvals.respond": [ApprovalsRespondParams, Empty];
  "approvals.list": [ApprovalsListParams, ApprovalsListResult];
  "events.subscribe": [EventsSubscribeParams, EventsSubscribeResult];
  "events.unsubscribe": [EventsUnsubscribeParams, Empty];
  "events.range": [EventsRangeParams, EventsRangeResult];
  "settings.get": [Empty, Settings];
  "settings.update": [SettingsUpdateParams, Settings];
  "computer.status": [Empty, ComputerStatus];
  "computer.setup": [ComputerSetupParams, ComputerStatus];
  "cursor.status": [Empty, CursorSetupStatus];
  "cursor.setup": [CursorSetupParams, CursorSetupStatus];
  "computer.frame": [ComputerFrameParams, ComputerFrameResult];
  "computer.notes.list": [Empty, ComputerNotesResult];
  "computer.notes.set": [ComputerNoteSetParams, ComputerNotesResult];
  "usage.summary": [UsageSummaryParams, UsageSummaryResult];
  "usage.limits": [UsageLimitsParams, UsageLimitsResult];
  "git.status": [GitStatusParams, GitStatus];
  "git.branches": [GitBranchesParams, GitBranchesResult];
  "git.commit": [GitCommitParams, GitCommitResult];
  "github.pr.create": [PrCreateParams, PullRequest];
  "github.pr.list": [PrListParams, PrListResult];
  "github.pr.detail": [PrDetailParams, PrDetailResult];
  "github.pr.page": [PrPageParams, PrPageResult];
  "github.pr.action": [PrActionParams, Empty];
  "threads.worktree.inspect": [WorktreeInspectParams, WorktreeInspectResult];
  "threads.worktree.remove": [WorktreeRemoveParams, WorktreeInspectResult];
}

export type MethodName = keyof Methods;
export type ParamsOf<M extends MethodName> = Methods[M][0];
export type ResultOf<M extends MethodName> = Methods[M][1];

export interface DaemonUpdate {
  status: "not_checked" | "checking" | "current" | "available" | "waiting" | "updating" | "restarting" | "unsupported" | "failed";
  message: string;
  current_version: string;
  latest_version: string | null;
  checked_at: DateTime | null;
}
export interface HarnessUpdate {
  kind: ProviderKind;
  status: "not_checked" | "waiting" | "updating" | "updated" | "current" | "unsupported" | "failed";
  message: string;
  version: string | null;
  checked_at: DateTime | null;
}

export interface ProviderCommand { name: string; description: string }

export interface ProviderUsage {
  context?: { used_tokens: number; window_tokens: number };
  limits?: { name: string; used_percent: number; window_minutes: number | null; resets_at: number | null }[];
}

export type IntegrationKind = "plugin" | "connector";
export type IntegrationAction = "install" | "uninstall" | "enable" | "disable" | "update";
export interface Integration {
  id: string; name: string; kind: IntegrationKind; description: string | null;
  scope: string | null; installed: boolean; enabled: boolean; status: string;
  actions: IntegrationAction[]; connect_url: string | null; can_login: boolean;
}
export interface IntegrationsCatalog { items: Integration[]; warnings: string[] }
export interface IntegrationChangeResult { message: string; connections: Integration[] }

export interface ArtifactTool { seq: number; at: DateTime; call: ToolCall; output: JsonValue | null; is_error: boolean }

export interface SubagentMessage {
  id: MessageId;
  thread_id: ThreadId;
  root_thread_id: ThreadId;
  task_id: string;
  native_task_id: string;
  session_instance_id: string;
  turn_id: TurnId;
  message: UserMessage;
  status: "pending" | "delivered" | "failed";
  error: string | null;
  parent_message_id: MessageId | null;
  parent_queued: boolean;
  created_at: string;
  updated_at: string;
}
export interface SubagentMessageActionParams { thread_id: ThreadId; message_id: MessageId; }
