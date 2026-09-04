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
export const EVENTS_LAGGED_NOTIFICATION = "events.lagged";

// ---- ids ----

export type Uuid = string;
export type ProjectId = Uuid;
export type ThreadId = Uuid;
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

export type ProviderKind = "claude-code" | "codex" | "opencode" | "pi" | "omp" | "cursor";

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

export type PermissionMode = "supervised" | "accept-edits" | "auto" | "full-access";

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

export type ThreadStatus = "idle" | "running" | "awaiting-approval" | "failed" | "archived";

export interface WorktreeInfo {
  path: string;
  branch: string;
}

export interface Thread {
  id: ThreadId;
  project_id: ProjectId;
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

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; media_type: string; data: string }
  | { type: "attachment"; asset_id: AssetId; name: string; media_type: string; size: number }
  | { type: "file_mention"; path: string }
  | { type: "skill"; name: string; path: string };

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
export type RuntimeTaskStatus = "pending" | "running" | "waiting" | "stopping" | "completed" | "failed" | "stopped" | "interrupted";

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
  | { role: "user"; id: MessageId; turn_id: TurnId; seq: EventSeq; message: UserMessage; at: DateTime }
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
      is_error: boolean;
      complete: boolean;
      at: DateTime;
    }
  | { role: "approval"; turn_id: TurnId; seq: EventSeq; approval: ApprovalRequest; decision?: ApprovalDecision | null }
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
  | { role: "runtime_task"; turn_id: TurnId; seq: EventSeq; task: RuntimeTask; at: DateTime }
  | { role: "notice"; turn_id: TurnId; seq: EventSeq; level: NoticeLevel; text: string; at: DateTime }
  | { role: "reverted"; turn_id: TurnId; seq: EventSeq; commit: string; at: DateTime };

export interface Checkpoint {
  thread_id: ThreadId;
  turn_id: TurnId;
  before: string;
  after?: string | null;
  provider_turn_id?: string | null;
  provider_turn_end?: string | null;
  created_at: DateTime;
}

export type FileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "type_changed" | "unknown";

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

export type EventPayload =
  | { kind: "thread_created"; thread: Thread }
  | { kind: "thread_updated"; thread: Thread }
  | { kind: "thread_archived" }
  | { kind: "turn_started"; message_id: MessageId; message: UserMessage }
  | { kind: "provider_session_bound"; session_id: string; model: string | null }
  | { kind: "assistant_text_delta"; message_id: MessageId; origin: EventOrigin; delta: string }
  | { kind: "assistant_thinking_delta"; message_id: MessageId; origin: EventOrigin; delta: string }
  | { kind: "assistant_message_completed"; message_id: MessageId; origin: EventOrigin; text: string; thinking: string | null }
  | { kind: "tool_call_started"; call: ToolCall; origin: EventOrigin }
  | { kind: "tool_call_output_delta"; tool_call_id: string; delta: string }
  | { kind: "tool_call_completed"; tool_call_id: string; output: JsonValue; is_error: boolean }
  | { kind: "runtime_task_started"; task: RuntimeTask }
  | { kind: "runtime_task_updated"; task: RuntimeTask }
  | { kind: "runtime_task_completed"; task: RuntimeTask }
  | { kind: "approval_requested"; approval: ApprovalRequest }
  | { kind: "approval_resolved"; approval_id: ApprovalId; decision: ApprovalDecision }
  | {
      kind: "turn_completed";
      stop_reason: StopReason;
      usage: Usage;
      cost_usd: number | null;
      duration_ms: number;
      terminal_message_id?: MessageId | null;
    }
  | { kind: "turn_failed"; error: string }
  | { kind: "provider_notice"; level: NoticeLevel; text: string; data: JsonValue | null }
  | { kind: "checkpoint_updated"; checkpoint: Checkpoint }
  | { kind: "workspace_reverted"; to_turn_id: TurnId; commit: string };

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

export interface ThreadsCreateParams {
  project_id: ProjectId;
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
}

export interface ThreadsGetResult {
  thread: Thread;
  transcript: TranscriptEntry[];
  pending_approvals: ApprovalRequest[];
  runtime_tasks?: RuntimeTask[];
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
export type ApprovalsRespondParams = { approval_id: ApprovalId } & ApprovalDecision;

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
}

export interface EventsSubscribeResult {
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
}

export interface Settings {
  default_provider: ProviderKind;
  default_permission_mode: PermissionMode;
  worktrees_default: boolean;
  generate_titles: boolean;
  title_provider?: ProviderKind | null;
  providers: Partial<Record<ProviderKind, ProviderSettings>>;
  notifications: boolean;
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

export interface FilesReadResult {
  content: string;
  truncated: boolean;
  binary: boolean;
  size: number;
}

export type SkillScope = "project" | "repo" | "user" | "system" | "admin" | "app" | "other";

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

/** Method name → [params, result]. The single place typed calls are derived from. */
export interface Methods {
  "daemon.info": [Empty, DaemonInfo];
  "providers.list": [ProvidersListParams, ProvidersListResult];
  "files.search": [FilesSearchParams, FilesSearchResult];
  "files.list": [FilesListParams, FilesListResult];
  "files.read": [FilesReadParams, FilesReadResult];
  "skills.list": [SkillsListParams, SkillsListResult];
  "daemon.shutdown": [Empty, Empty];
  "projects.list": [Empty, ProjectsListResult];
  "projects.add": [ProjectsAddParams, Project];
  "projects.update": [ProjectsUpdateParams, Project];
  "projects.remove": [ProjectsRemoveParams, Empty];
  "threads.list": [ThreadsListParams, ThreadsListResult];
  "threads.create": [ThreadsCreateParams, Thread];
  "threads.get": [ThreadsGetParams, ThreadsGetResult];
  "threads.update": [ThreadsUpdateParams, Thread];
  "threads.archive": [ThreadsArchiveParams, Empty];
  "threads.send": [ThreadsSendParams, ThreadsSendResult];
  "threads.interrupt": [ThreadsInterruptParams, Empty];
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
  "git.status": [GitStatusParams, GitStatus];
  "git.branches": [GitBranchesParams, GitBranchesResult];
  "git.commit": [GitCommitParams, GitCommitResult];
  "github.pr.create": [PrCreateParams, PullRequest];
  "github.pr.list": [PrListParams, PrListResult];
}

export type MethodName = keyof Methods;
export type ParamsOf<M extends MethodName> = Methods[M][0];
export type ResultOf<M extends MethodName> = Methods[M][1];
