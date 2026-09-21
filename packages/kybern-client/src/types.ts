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

export interface ProviderModel {
  /** Model selector accepted by the provider. */
  id: string;
  display_name: string;
  provider?: string | null;
  efforts?: string[];
  default_effort?: string | null;
  is_default?: boolean;
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

export type ContentPart =
  | { type: "text"; text: string }
  | ThreadReferencePart
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

export type TranscriptEntry =
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

export type EventPayload =
  | { kind: "async_questions_requested"; request: AsyncQuestionRequest }
  | { kind: "async_questions_answered"; request_id: string; answers: string[]; message_id: MessageId; message: UserMessage }
  | { kind: "thread_created"; thread: Thread }
  | { kind: "thread_updated"; thread: Thread }
  | { kind: "thread_archived" }
  | { kind: "project_coordinator_deleted"; project_id: ProjectId; coordinator_thread_id: ThreadId }
  | { kind: "message_queued"; message: QueuedMessage }
  | { kind: "message_removed"; message_id: MessageId }
  | { kind: "message_queue_updated"; message: QueuedMessage }
  | { kind: "message_steered"; message_id: MessageId; message: UserMessage }
  | { kind: "thread_notes_updated"; notes: ThreadNotes }
  | { kind: "collaboration_group_updated"; group: CollaborationGroup }
  | { kind: "collaboration_member_updated"; member: GroupMember }
  | { kind: "collaboration_assignment_updated"; assignment: CollaborationAssignment }
  | { kind: "collaboration_message_updated"; message: CollaborationMessage }
  | { kind: "collaboration_context_updated"; entry: ContextEntry }
  | { kind: "turn_started"; message_id: MessageId; message: UserMessage }
  | { kind: "turn_resumed" }
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

export interface ProjectsAddParams {
  path: string;
  name?: string;
}

export interface ProjectsUpdateParams {
  project_id: ProjectId;
  name?: string;
  /** `null` clears the override. */
  worktrees_default?: boolean | null;
}

export interface ProjectsRemoveParams {
  project_id: ProjectId;
}

export interface ThreadsListParams {
  project_id?: ProjectId;
  include_archived?: boolean;
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

export interface TaskControlParams {
  thread_id: ThreadId;
  task_id: string;
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
  generate_titles: boolean;
  title_provider?: ProviderKind | null;
  providers: Partial<Record<ProviderKind, ProviderSettings>>;
  notifications: boolean;
  auto_update_harnesses: boolean;
  auto_update_daemon: boolean;
  background: BackgroundSettings;
  access: AccessSettings;
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

export interface UsageLimitsParams {}
export interface ProviderLimits {
  provider: ProviderKind;
  limits: NonNullable<ProviderUsage["limits"]>;
}
export interface UsageLimitsResult {
  providers: ProviderLimits[];
}

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
  "threads.steer": [QueuedMessage, ThreadsSendResult];
  "threads.notes.get": [{ thread_id: ThreadId }, ThreadNotes];
  "threads.notes.set": [{ thread_id: ThreadId; text: string; expected_revision: number }, ThreadNotes];
  "queue.list": [{ thread_id?: ThreadId }, { messages: QueuedMessage[] }];
  "queue.remove": [
    { thread_id: ThreadId; id: MessageId },
    Record<string, never>,
  ];
  "daemon.info": [Empty, DaemonInfo];
  "daemon.activity": [Empty, DaemonActivity];
  "sessions.list": [{ provider: ProviderKind; query?: string; project_id?: ProjectId | null; cursor?: string | null }, SessionsListResult];
  "sessions.resume": [{ provider: ProviderKind; session_id: string; project_id?: ProjectId | null }, Thread];
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
  "threads.tool_output": [ThreadsToolOutputParams, ThreadsToolOutputResult];
  "threads.update": [ThreadsUpdateParams, Thread];
  "threads.archive": [ThreadsArchiveParams, Empty];
  "threads.send": [ThreadsSendParams, ThreadsSendResult];
  "threads.release": [ThreadsInterruptParams, Empty];
  "threads.answer": [ThreadsAnswerParams, Empty];
  "threads.compact": [ThreadsInterruptParams, ThreadsSendResult];
  "threads.interrupt": [ThreadsInterruptParams, Empty];
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
  "usage.summary": [UsageSummaryParams, UsageSummaryResult];
  "usage.limits": [UsageLimitsParams, UsageLimitsResult];
  "git.status": [GitStatusParams, GitStatus];
  "git.branches": [GitBranchesParams, GitBranchesResult];
  "git.commit": [GitCommitParams, GitCommitResult];
  "github.pr.create": [PrCreateParams, PullRequest];
  "github.pr.list": [PrListParams, PrListResult];
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
