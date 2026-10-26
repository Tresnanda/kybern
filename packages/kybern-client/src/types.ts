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

export interface ProviderAccount {
  name: string;
  directory: string;
  /** Palette key: blue | green | purple | pink | teal | amber. */
  color?: string | null;
  email?: string | null;
  plan?: string | null;
}
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
  /** When on, every new thread in the project also gets the project brief and an index of its notes at session start. */
  brief_in_all_threads: boolean;
  /** This project's overrides of the Coordinator settings; absent fields use the global value. See `effectiveCoordinatorSettings`. */
  coordinator?: CoordinatorOverrides | null;
  /** The space this project belongs to. Absent only for free chat and on daemons without spaces. */
  space_id?: SpaceId | null;
  /** `group` for a parent folder of several git repositories. Absent means single. See `isGroupProject`. */
  kind?: ProjectKind;
  /** Group members in order; the first is the primary (the group folder itself when it is a member, else the first by path). */
  members?: ProjectMember[];
  /** Top-level entries of the group folder copied into each new worktree container. */
  worktree_copy?: string[];
  /** The user hid the "Add shared instructions" offer for this group. */
  instructions_offer_dismissed?: boolean;
  created_at: DateTime;
  updated_at: DateTime;
}

export type ProjectKind = "single" | "group";
/** `missing`: the folder is gone; `not_git`: it exists but is no longer a repository. */
export type MemberStatus = "ok" | "missing" | "not_git";

/** One git repository of a group project. */
export interface ProjectMember {
  /** '/'-separated, relative to `Project.path`; "." is the group folder itself. */
  path: string;
  /** Last path component, or the group folder's name for "."; disambiguated with the parent segment when two clash. */
  name: string;
  status: MemberStatus;
}

/** A group thread's record of one member, fixed when the thread starts. */
export interface ThreadMember {
  /** Relative to the project folder and to the thread cwd. */
  path: string;
  name: string;
  /** False when left out of a worktree chat: no worktree; the agent treats `source_path` as read-only. */
  included: boolean;
  /** Absolute path of the member's checkout when the thread started. */
  source_path: string;
  /** Worktree mode: this member's worktree inside the container (branch `kybern/<thread-id>`). */
  worktree?: WorktreeInfo | null;
  /** Branch the worktree forked from (worktree) or checked out at start (local). */
  base_branch?: string | null;
  base_commit?: string | null;
  worktree_state?: WorktreeState | null;
  /** Missing or not a repository when the thread started, so not available to it. */
  missing?: boolean;
}

export type SpaceId = Uuid;
export type SpaceColor = "blue" | "green" | "purple" | "pink" | "teal" | "amber" | "red" | "graphite";
export type SpaceLogo =
  | { kind: "initials" }
  /** A slug from the client's curated set; clients that do not know it draw initials. */
  | { kind: "icon"; icon: string }
  /** A square 128×128 PNG the daemon derived from an upload (`GET /assets/{id}`). */
  | { kind: "image"; asset_id: AssetId };

/** A group of projects (work, personal…). Every project except free chat is in exactly one. */
export interface Space {
  id: SpaceId;
  /** 1–32 characters, trimmed; unique ignoring case. */
  name: string;
  color: SpaceColor;
  logo: SpaceLogo;
  /** 0-based order in the rail. */
  position: number;
  /** Exactly one space is the default: it can be renamed and restyled but not deleted. Daemons before 0.15.0 omit it. */
  is_default?: boolean;
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
  /**
   * Group threads: the members this thread started with, in project order. Never
   * changes when the project's members change. For a group worktree thread
   * `worktree.path` and `cwd` are the container holding one worktree per member.
   */
  members?: ThreadMember[];
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

/**
 * A Coordinator delegation that used another harness or model than the default for its
 * role. `provider` and `model` are the default that was set aside; the child's own are on
 * its thread.
 */
export interface DefaultOverride {
  provider: ProviderInstance;
  model?: string | null;
  /** The Coordinator's reason, as it passed it in `override_reason`. */
  reason: string;
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
  /** Set when a Coordinator chose another harness or model than its role's default. */
  default_override?: DefaultOverride | null;
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

// ---- coordinator ----

export interface CoordinatorGetParams {
  project_id: ProjectId;
}

export interface CoordinatorOpenParams {
  project_id: ProjectId;
  /** Used only when the Coordinator is created. */
  provider: ProviderInstance;
  model?: string | null;
  effort?: string | null;
  permission_mode?: PermissionMode | null;
  /**
   * The user's opening words. When the Coordinator is created for a project without a
   * brief they become the user's first answer in its setup interview; with a brief the
   * daemon sends them as an ordinary first message. Never saved as the brief.
   */
  opening_message?: string | null;
  /** Older clients' name for `opening_message`, treated the same way. */
  initial_brief?: string | null;
  /** The id the Coordinator gets if this call creates it; ignored when the project has one. A repeat reports `created: true` again. */
  thread_id?: ThreadId;
  /** The client's id for the opening message. */
  message_id?: MessageId;
}

/** "Redo setup": start the Coordinator's setup interview again. Refused while it runs a turn. */
export interface CoordinatorSetupParams {
  project_id: ProjectId;
}

export interface CoordinatorOpenResult {
  thread: Thread;
  /** False when the project already had a Coordinator. */
  created: boolean;
}

export interface CoordinatorSwitchHarnessParams {
  project_id: ProjectId;
  provider: ProviderInstance;
  model?: string | null;
  effort?: string | null;
  permission_mode?: PermissionMode | null;
}

export interface CoordinatorRefreshContextParams {
  thread_id: ThreadId;
}

export interface CoordinatorRefreshContextResult {
  rotation_id: string;
}

/** Replace the handoff of the Coordinator's latest context refresh. */
export interface CoordinatorEditHandoffParams {
  thread_id: ThreadId;
  rotation_id: string;
  text: string;
}

/** Why a Coordinator's provider session was replaced. */
export type RotationReason = "budget" | "idle" | "manual" | "harness_switch";

/** Whether the old session wrote a handoff that passed validation. */
export type HandoffStatus = { status: "written" } | { status: "missing"; why: string };

export interface RepoHead {
  repo: string;
  branch?: string | null;
  sha: string;
}

/** Counts of what Kybern carried into a fresh Coordinator session. */
export interface RotationCarried {
  children: number;
  pull_requests: number;
  tasks: number;
  commits: number;
  head?: RepoHead[];
}

/** The harness and model on one side of a rotation. */
export interface HarnessRef {
  kind: ProviderKind;
  model?: string | null;
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
  | { type: "mention"; name: string; path: string; display_name?: string | null }
  | SystemRowPart;

/** What a `system_row` part announces. */
export type SystemRowKind = "coordinator_setup" | "coordinator_tidy_notes";

/**
 * A row Kybern itself adds to a conversation, such as "Setup started". Clients draw it as
 * a small system row, never a user bubble; it may sit in front of the user's own parts.
 */
export interface SystemRowPart {
  type: "system_row";
  kind: SystemRowKind;
  text: string;
}

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
  /** Running delegated children; absent from older daemons. */
  active_children?: number;
  /** What this thread's oldest waiting request asks for. */
  pending_request?: PendingRequestKind | null;
  /** A delegated descendant waits on the user: `question` when any of them asks one. */
  pending_child_request?: PendingRequestKind | null;
}

/** Whether a waiting request asks the user to answer or to approve. */
export type PendingRequestKind = "approval" | "question";

/** One question of a request, in one shape for every harness (`kybern_protocol::UserInputQuestion`). */
export interface UserInputQuestion {
  /** The key the answer goes under. */
  id: string;
  header?: string | null;
  /** Markdown. */
  question: string;
  options: UserInputOption[];
  multi_select: boolean;
  allow_custom: boolean;
  secret: boolean;
  /** The harness can take images and files with the answer. */
  attachments: boolean;
}

export interface UserInputOption {
  label: string;
  description?: string | null;
  /** Text or code shown while the option is focused. Markdown. */
  preview?: string | null;
  /** The harness's own id for the option (Cursor). */
  value?: string | null;
}

/** A file or picture sent with an answer. */
export interface UserInputAttachment {
  kind: "image" | "file" | "window";
  name: string;
  asset_id?: AssetId | null;
  /** Absolute path, for a file. */
  path?: string | null;
}

/** The answer to one question; sent as `{ kybern_answers: UserInputAnswer[] }` and turned into the harness's own response by the daemon. */
export interface UserInputAnswer {
  id: string;
  answers: string[];
  attachments?: UserInputAttachment[];
}

/** The delegating agent that answered a request for the user. */
export interface RequestAnswerer {
  thread_id: ThreadId;
  title: string;
}

export const NORMALIZED_ANSWERS_KEY = "kybern_answers";
/** `tool_name` of a question Cursor asks through `cursor/ask_question`. */
export const CURSOR_QUESTION_TOOL = "cursor_ask_question";

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
  /** The questions in one shape for every harness; absent when it is not a question, or from an older daemon. */
  questions?: UserInputQuestion[];
}

/** `tool_name` of the daemon's card asking the user for one secret (`kybern_request_secret`). `input` is a `SecretRequestInput`. The answer is `{ decision: "submit", response: { secret } }` or a deny; stored and broadcast copies carry `REDACTED_SECRET` instead of the value. */
export const SECRET_REQUEST_TOOL = "kybern_request_secret";
/** What stored and broadcast copies of a secret answer contain instead of it. */
export const REDACTED_SECRET = "[redacted]";
/** Longest secret, in bytes, the daemon accepts. */
export const MAX_SECRET_BYTES = 16 * 1024;

/** The `input` of a `SECRET_REQUEST_TOOL` approval. */
export interface SecretRequestInput {
  /** Short name of the secret, shown as the card title. */
  label: string;
  /** Why the agent needs it, shown as the card body. */
  reason: string;
  /** The variable the daemon writes, e.g. `STRIPE_KEY`. */
  env_key: string;
  /** The file it is written to, relative to the thread workspace, e.g. `.env`. */
  file: string;
  /** The key is already in the file, so saving replaces its current value. */
  replaces: boolean;
  /** Hint for the empty field, if the agent gave one. */
  placeholder?: string | null;
}

/** `tool_name` of the daemon's card asking the user to point at something (`kybern_request_pick`). `input` is a `PickRequestInput`. The answer is `{ decision: "submit", response }` with the picked target (shape per `PickKind`) or a deny. */
export const PICK_REQUEST_TOOL = "kybern_request_pick";
/** Largest answer, in bytes of JSON, a pick card may submit. */
export const MAX_PICK_RESPONSE_BYTES = 48 * 1024;

/** What the user is asked to point at. */
export type PickKind = "preview_element" | "visual_element" | "file" | "folder" | "image" | "window";

/** The `input` of a `PICK_REQUEST_TOOL` approval. */
export interface PickRequestInput {
  kind: PickKind;
  /** What the agent needs, in a sentence the user can act on. */
  prompt: string;
}

/** `tool_name` of the daemon's sign-in card (`kybern_request_login`). `input` is a `LoginRequestInput`. A client only answers with a deny (the decline row); every other step goes through `requests.act` and the card's `RequestProgress`. The daemon resolves the card with `{ status: "signed_in" | "already_signed_in", cli, account? }`. */
export const LOGIN_REQUEST_TOOL = "kybern_request_login";
/** `tool_name` of the private card behind `kybern askpass` (sudo, ssh and git prompts). `input` is a `PromptRequestInput`. Never answered automatically. The answer is `{ decision: "submit", response: { secret } }` (masked), `{ value }` (visible) or `{ confirmed }` (yes/no), or a deny; a `secret` is redacted in stored copies. */
export const PROMPT_REQUEST_TOOL = "kybern_askpass";
/** `tool_name` of the daemon's macOS permission card (`kybern_request_permission`). `input` is a `PermissionRequestInput`. A client only answers with a deny; the rest goes through `requests.act`. */
export const PERMISSION_REQUEST_TOOL = "kybern_request_permission";
/** Longest askpass answer, in bytes. */
export const MAX_PROMPT_ANSWER_BYTES = 4096;

/** The `input` of a `LOGIN_REQUEST_TOOL` approval. */
export interface LoginRequestInput {
  /** The CLI to sign in, e.g. `gh`. */
  cli: string;
  /** The service's name for the title, e.g. `GitHub`. */
  service: string;
  reason: string;
  /** The Account line, e.g. "github.com, any account you choose". */
  account: string;
  /** The Access line (scopes), when the CLI has any. */
  access?: string | null;
  /** What the sign-in changes, e.g. "`gh` for this Mac, so your terminal uses it too". */
  signs_in: string;
  /** The command the terminal path runs, e.g. `gh auth login`. */
  command: string;
  /** Row order of the ways offered: `browser` and `terminal`. */
  methods: string[];
  /** The agent supplied the command; the CLI is not in Kybern's table. */
  custom?: boolean;
}

/** The `input` of a `PROMPT_REQUEST_TOOL` approval. */
export interface PromptRequestInput {
  /** `sudo`, `ssh_passphrase`, `ssh_host_key`, `git_username`, `git_password` or `other`. */
  purpose: string;
  /** The prompt as the program printed it. */
  prompt: string;
  /** Mask the field. */
  secret: boolean;
  /** Ask yes or no (an SSH host key). No default answer, `Return` stays inert. */
  confirm: boolean;
  /** The command that asked, from the parent processes. */
  command?: string | null;
  /** The harness's display name, e.g. `Claude Code`. */
  harness: string;
  host?: string | null;
  /** An SSH host key's type, e.g. `ED25519`. */
  key_type?: string | null;
  fingerprint?: string | null;
  /** 1 on the first ask, 2 or more when the same command asked again (a wrong password). */
  attempt: number;
  /** Seconds the helper waits before it fails the command. */
  wait_seconds: number;
}

/** The `input` of a `PERMISSION_REQUEST_TOOL` approval. */
export interface PermissionRequestInput {
  /** `camera`, `microphone`, `screen_recording`, `accessibility`, `local_network`, `full_disk_access`, `notifications` or `location`. */
  pane: string;
  app: string;
  bundle_id?: string | null;
  app_path?: string | null;
  reason: string;
  /** e.g. "Privacy & Security › Camera". */
  pane_label: string;
  /** The `x-apple.systempreferences:` link that opens the pane. */
  url: string;
  /** The user must add the app to a list (Full Disk Access, Accessibility). */
  needs_app_added: boolean;
  /** The app needs a relaunch once the permission is on. */
  relaunch: boolean;
  /** Kybern can see the grant itself; otherwise the user confirms it. */
  detects: boolean;
}

/** `deadline` inside an `AskUserQuestion` approval's `input` (the daemon's `kybern_ask_user` with a default and a wait). The daemon answers with `defaults` at `ends_at` unless paused (`requests.act` `pause` / `resume`) or held (`hold`); the answer then carries `auto: { at, waited_seconds }`. */
export interface QuestionDeadline {
  /** Question text → the option label chosen when the deadline fires. */
  defaults: Record<string, string>;
  seconds: number;
  started_at: DateTime;
  ends_at: DateTime;
}

export type RequestKind = "login" | "permission" | "question" | "terminal";
export type RequestPhase = "asking" | "waiting" | "paste_code" | "verifying" | "done" | "failed" | "not_granted" | "paused" | "held";

/** Live state of a request card; pushed as `requests.progress` and listed by the `requests.progress` method. Not persisted. */
export interface RequestProgress {
  approval_id: ApprovalId;
  thread_id: ThreadId;
  kind: RequestKind;
  phase: RequestPhase;
  /** `browser` or `terminal` for a login. */
  method?: string | null;
  /** A login's sign-in page, or a permission's System Settings link. */
  url?: string | null;
  user_code?: string | null;
  /** The terminal a sign-in or `kybern_run_in_terminal` opened (open it as a tab). */
  terminal?: TerminalInfo | null;
  account?: string | null;
  error?: string | null;
  /** When the wait ends: a login's timeout or a question's deadline. */
  ends_at?: DateTime | null;
  /** Time left while a deadline is paused, in milliseconds. */
  remaining_ms?: number | null;
  updated_at: DateTime;
}
export const REQUESTS_PROGRESS_NOTIFICATION = "requests.progress";

/** Limits for questions that answer themselves after a deadline (`kybern_ask_user`). */
export interface AskDeadlineSettings {
  enabled: boolean;
  /** The longest wait an agent can set, in seconds. */
  max_seconds: number;
}

/**
 * `tool_name` of the Coordinator's "Save this as the project brief?" card. `input` is a
 * `BriefProposalInput`; the answer is `{ decision: "submit", response: { text } }` with the
 * user's final wording (non-empty, at most `MAX_BRIEF_BYTES`) or a deny.
 */
export const COORDINATOR_BRIEF_TOOL = "kybern_coordinator_brief";
/**
 * `tool_name` of the Coordinator's "Apply these Coordinator settings?" card. `input` is a
 * `SettingsProposalInput`; the answer is `{ decision: "submit", response: { accepted: [path, ...] } }`
 * (at least one path from `input.changes`) or a deny.
 */
export const COORDINATOR_SETTINGS_TOOL = "kybern_coordinator_settings";
/**
 * `tool_name` of the Coordinator's "Apply N note changes?" card. `input` is a
 * `NoteChangesProposalInput`; the answer is `{ decision: "submit", response: { accepted: [path, ...] } }`
 * (at least one path from `input.changes`) or a deny.
 */
export const COORDINATOR_NOTES_TOOL = "kybern_coordinator_notes";
/** `tool_name` of the Coordinator's git approvals (push, open a pull request, merge one). Answered allow once or deny. */
export const LEAD_GIT_TOOL = "kybern_git";
/** Longest project brief, in bytes. */
export const MAX_BRIEF_BYTES = 16 * 1024;

/** The `input` of a `COORDINATOR_BRIEF_TOOL` approval. */
export interface BriefProposalInput {
  /** The proposed brief, markdown. */
  text: string;
  /** The project already has a brief that saving replaces. */
  replaces: boolean;
}

/** One proposed change in a `SettingsProposalInput`. */
export interface SettingChange {
  /** `lead_autonomy`, `lead_workspace`, `lead_push_without_asking`, `lead_max_children` or `role_defaults.<role>`; also the value `accepted` lists. */
  path: string;
  /** Short label for the row, e.g. `Autonomy`. */
  label: string;
  /** The effective value today: an enum's snake_case string, a `RoleDefault`, or `null` when none is set. */
  old: JsonValue;
  /** The proposed value, in the same shape. */
  new: JsonValue;
}

/** The `input` of a `COORDINATOR_SETTINGS_TOOL` approval. */
export interface SettingsProposalInput {
  /** Why the Coordinator proposes these, in its words. */
  reason: string;
  changes: SettingChange[];
}

/** What one row of a `NoteChangesProposalInput` does: add a dated claim, or add one and retire the line it replaces. */
export type NoteChangeOp = "append" | "supersede";

/** One proposed change in a `NoteChangesProposalInput`. */
export interface NoteChange {
  /** The row's id, numbered from 1; also the value `accepted` lists. */
  path: string;
  note_id: NoteId;
  note_title: string;
  op: NoteChangeOp;
  /** The markdown added to the note, a dated claim. */
  text: string;
  /** For `supersede`: the exact line, or part of it, that is retired (struck through). */
  supersedes?: string | null;
  /** Sets the note's category when it has none. */
  category?: NoteCategory | null;
}

/** The `input` of a `COORDINATOR_NOTES_TOOL` approval. */
export interface NoteChangesProposalInput {
  /** Why the Coordinator proposes these, in its words. */
  reason: string;
  changes: NoteChange[];
}

/** The `input` of a `LEAD_GIT_TOOL` approval. */
export type LeadGitCardInput =
  | { op: "push"; remote: string; branch: string; ahead: number }
  | { op: "open_pr"; remote: string; branch: string; ahead: number; title: string; body: string; base: string }
  | { op: "merge_pr"; number: number; title: string; checks: PrChecksSummary; method: "squash" | "merge" };

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
  /** Set when the agent waits for the reader's answer; the question is a `VISUAL_ANSWER_TOOL` card. */
  ask?: VisualAsk | null;
}
export interface VisualAsk { schema?: JsonValue | null }
export type VisualAnswerStatus = "answered" | "replied" | "skipped" | "cancelled" | "timed_out";
/** The receipt under an answered visual. */
export interface VisualAnswerRecord { status: VisualAnswerStatus; answer?: JsonValue | null; label?: string | null; at: DateTime }
/** `tool_name` of the daemon's card behind `kybern_html_publish` with `await_answer`. `input` is a `VisualAnswerInput`; the answer is `{ decision: "submit", response: { answer, label } }`, `{ response: { reply } }` for a typed reply, or a deny to skip. */
export const VISUAL_ANSWER_TOOL = "kybern_visual_answer";
export interface VisualAnswerInput { visual_id: Uuid; title: string; schema?: JsonValue | null }
/** One control in a visual's picture, in CSS pixels from the page's top-left. */
export interface VisualControl { x: number; y: number; w: number; h: number; r: number; role: string }
export interface HtmlSnapshotResult { key: string; width: number; height: number; scale: number; clamped?: boolean; clamp: number; controls: VisualControl[] }
export type TranscriptEntry =
  | { role: "visual"; turn_id: TurnId; seq: EventSeq; at: DateTime; visual: HtmlVisual; answer?: VisualAnswerRecord | null }
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
      /** Allowed by Full access without asking the user. */
      auto?: boolean;
      /** The delegating agent that answered for the user. */
      answered_by?: RequestAnswerer | null;
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
    }
  | {
      /** Deselected repositories of a group worktree thread changed outside its worktree during this turn. */
      role: "outside_repo_changed";
      turn_id: TurnId;
      seq: EventSeq;
      repos: OutsideRepoChange[];
      at: DateTime;
    }
  | {
      /** A Coordinator context refresh: pending while the handoff is written, then its outcome. */
      role: "rotation";
      /** The turn the refresh followed (nil before the first turn). */
      turn_id: TurnId;
      seq: EventSeq;
      rotation_id: string;
      reason: RotationReason;
      pending: boolean;
      used_tokens: number;
      window_tokens?: number | null;
      handoff?: string | null;
      handoff_status?: HandoffStatus | null;
      /** The user edited the handoff after the refresh. */
      edited?: boolean;
      carried?: RotationCarried | null;
      from?: HarnessRef | null;
      to?: HarnessRef | null;
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
  /** Group threads: one entry per included member. `before`/`after` above are the primary's. */
  repos?: RepoCheckpoint[];
  /** A member could not be snapshotted; rewinding to this turn is refused. */
  incomplete?: boolean;
}

export interface RepoCheckpoint {
  repo: string;
  before: string;
  after?: string | null;
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
  /** Group threads: the member this file belongs to. `path` stays relative to the thread cwd (`api/src/x.rs`). */
  repo?: string | null;
}

export interface Diff {
  from: string;
  to: string;
  files: FileChange[];
  patch: string;
  patch_truncated?: boolean;
  /** Group threads: per-member totals in project order, including included members with no changes. */
  repos?: RepoDiff[];
}

export interface RepoDiff {
  repo: string;
  from: string;
  to: string;
  files: number;
  additions: number;
  deletions: number;
}

/** A deselected member whose original checkout changed during a turn of a group worktree thread. */
export interface OutsideRepoChange {
  repo: string;
  name: string;
  /** Absolute path of the original checkout. */
  source_path: string;
  dirty_files: number;
  /** HEAD moved during the turn (a commit, checkout or reset). */
  head_moved?: boolean;
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
  | { kind: "visual_answered"; visual_id: Uuid; status: VisualAnswerStatus; answer?: JsonValue | null; label?: string | null; message_id?: MessageId | null; message?: UserMessage | null }
  | { kind: "async_questions_requested"; request: AsyncQuestionRequest }
  | { kind: "async_questions_answered"; request_id: string; answers: string[]; message_id: MessageId; message: UserMessage }
  | { kind: "thread_created"; thread: Thread }
  | { kind: "thread_updated"; thread: Thread }
  | { kind: "thread_archived" }
  | { kind: "worktree_cleaned"; branch: string; recovery_commit: string }
  | { kind: "worktree_restored"; branch: string }
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
      /** The delegating agent that answered for the user; absent when the user did. */
      answered_by?: RequestAnswerer | null;
    }
  /** A harness permission request Kybern allowed because the thread is in Full access. */
  | { kind: "approval_auto_allowed"; approval: ApprovalRequest }
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
  | { kind: "workspace_reverted"; to_turn_id: TurnId; commit: string }
  /** After a turn of a group worktree thread: deselected members' checkouts changed. Never reverted. */
  | { kind: "outside_repo_changed"; repos: OutsideRepoChange[] }
  /** A Coordinator context refresh began; sends queue until `context_rotated`. */
  | { kind: "context_rotation_started"; rotation_id: string; reason: RotationReason; used_tokens: number; window_tokens?: number | null }
  | {
      kind: "context_rotated";
      rotation_id: string;
      reason: RotationReason;
      handoff?: string | null;
      handoff_status: HandoffStatus;
      carried: RotationCarried;
      from: HarnessRef;
      to: HarnessRef;
      /** The refresh failed before the old session was released: it carries on with its context. */
      session_kept?: boolean;
    }
  | { kind: "handoff_edited"; rotation_id: string; text: string };

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
  /** The space for a new project; the first space when absent. An existing path is returned unchanged. */
  space_id?: SpaceId;
  /** `group` adds a group project; `members` is then required. */
  kind?: ProjectKind;
  /** Member paths relative to `path` (or absolute inside it). At least 2, where "." counts as one. */
  members?: string[];
}

export interface ProjectsUpdateParams {
  project_id: ProjectId;
  name?: string;
  /** `null` clears the override. */
  worktrees_default?: boolean | null;
  /** 2–5 letters A-Z (uppercased), unique across projects, "TSK" reserved. Existing task keys keep their old prefix. Absent or null leaves it as it is. */
  task_prefix?: string | null;
  /** Give every new thread in the project the brief and a notes index. Absent leaves the switch as it is. */
  brief_in_all_threads?: boolean;
  /**
   * Replaces the project's Coordinator overrides. Absent leaves them as they are; `null`
   * removes every override; an object sets exactly the fields it holds (a field left out
   * falls back to the global setting). Send the whole object each time.
   */
  coordinator?: CoordinatorOverrides | null;
  /** Moves the project to this space. */
  space_id?: SpaceId;
  /** Group projects only: replaces the member list (same rules as add). Existing threads keep theirs. */
  members?: string[];
  /** Group projects only: replaces the entries copied into new worktree containers. */
  worktree_copy?: string[];
  /** Hides (true) or brings back (false) the "Add shared instructions" offer. */
  instructions_offer_dismissed?: boolean;
}

export interface ProjectsRemoveParams {
  project_id: ProjectId;
}

// ---- group projects ----

/** A git repository found inside a folder, offered as a group member. */
export interface RepoCandidate {
  /** Relative to the scanned folder; "." for the folder itself. */
  path: string;
  name: string;
  /** Current branch, or the short SHA when detached. */
  branch?: string | null;
  detached?: boolean;
  /** A submodule of this candidate path: listed, not selectable. */
  submodule_of?: string | null;
  /** Already a single project (informational; both may exist). */
  project_id?: ProjectId | null;
  /** Came from "Add folder…" rather than the scan. */
  added?: boolean;
}

/** A folder that can't be a member, or a repository an operation skipped, with a user-facing sentence. */
export interface RejectedFolder {
  path: string;
  reason: string;
}

export interface ProjectsScanReposParams {
  /** Absolute folder on the daemon host (`~` expanded). */
  path: string;
  /** Folders picked with "Add folder…" (absolute or relative to `path`). */
  include?: string[];
  /** Folder levels below `path`. Default 2, max 4. */
  depth?: number;
}

export interface ProjectsScanReposResult {
  path: string;
  /** Folder name, the default project name. */
  name: string;
  is_git: boolean;
  /** Primary first ("." when present), then by path. */
  candidates: RepoCandidate[];
  rejected?: RejectedFolder[];
  /** Set when the folder is already a project. */
  existing_project_id?: ProjectId | null;
  /** Stopped at 200 candidates or 20,000 folders. */
  truncated?: boolean;
}

export interface MemberState {
  path: string;
  name: string;
  status: MemberStatus;
  branch?: string | null;
  detached?: boolean;
  dirty_files: number;
  remote_url?: string | null;
  /** The member's own instruction file relative to the group folder (`api/AGENTS.md`). */
  instructions?: string | null;
}

/** A top-level entry of the group folder that may go in `Project.worktree_copy`. */
export interface CopyCandidate {
  name: string;
  is_dir: boolean;
}

export interface ProjectsMembersStatusResult {
  members: MemberState[];
  /** Which shared instruction files exist in the group folder. */
  agents_md: boolean;
  claude_md: boolean;
  /** Entries for "Also copy into worktrees", sorted by name. */
  copy_candidates?: CopyCandidate[];
}

/** One repository of the project as the map saw it. */
export interface ProjectMapRepo {
  /** Member path relative to the project folder; "." for a single project or the group folder itself. */
  path: string;
  name: string;
  /** The branch work lands on: the remote's default, else `main` or `master`, else the current branch. */
  default_branch?: string;
  /** The branch checked out when the map was built; absent when HEAD is detached. */
  branch?: string;
  /** Full HEAD commit id the map describes. */
  head: string;
  /** Tracked files counted, at most 20 000. */
  files: number;
  /** More files are tracked than were counted. */
  truncated?: boolean;
}

/** A directory (top two levels) with its tracked-file count. */
export interface ProjectMapArea {
  repo: string;
  /** Relative to the repository, '/'-separated; "." is the repository root. */
  path: string;
  files: number;
  /** Name from the manifest in this directory. */
  name?: string;
  /** `cargo`, `npm`, `go` or `python`, when a manifest is here. */
  manifest?: string;
}

/** A command the project itself documents. */
export interface ProjectMapCommand {
  repo: string;
  /** The file it comes from, relative to the repository. */
  source: string;
  /** Script, alias or target name; for a fenced block, the heading text copied verbatim. */
  name: string;
  run: string;
}

/** Commits per directory (two levels deep) over the last 30 days. */
export interface ProjectMapBusy {
  repo: string;
  path: string;
  commits: number;
}

export type ProjectMapChangeKind = "deleted" | "renamed";

/** A file deleted or renamed in the last 14 days. */
export interface ProjectMapChange {
  repo: string;
  kind: ProjectMapChangeKind;
  /** The path that is gone (deleted), or the new path (renamed). */
  path: string;
  /** Renamed only: the old path. */
  from?: string;
  commit: string;
  /** Commit date, strict ISO 8601. */
  date: string;
  subject: string;
}

/** A daemon-built, commit-stamped description of a project. Built from git and manifests only. */
export interface ProjectMap {
  built_at: string;
  repos: ProjectMapRepo[];
  layout: ProjectMapArea[];
  commands: ProjectMapCommand[];
  busy: ProjectMapBusy[];
  removed: ProjectMapChange[];
  /** What sessions receive: at most 6 KiB, starting `Map as of {repo}@{sha}`. */
  header: string;
}

export interface ProjectsMapResult {
  project_id: ProjectId;
  map: ProjectMap;
}

export interface ProjectsInstructionsCreateResult {
  /** Files written in the group folder, e.g. ["AGENTS.md", "CLAUDE.md"]. Never overwrites. */
  created: string[];
}

export const THREADS_WORKSPACE_PROGRESS_NOTIFICATION = "threads.workspace_progress";

/** Transient progress while `threads.create` prepares worktrees (`total: 1` for single-repo threads). */
export interface ThreadsWorkspaceProgress {
  thread_id: ThreadId;
  /** Repositories whose worktree exists. */
  done: number;
  total: number;
  /** Member path being created; absent for single-repo threads and at the end. */
  current?: string | null;
}

export interface SpacesListResult {
  spaces: Space[];
}
export interface SpacesCreateParams {
  name: string;
  color?: SpaceColor;
  logo?: SpaceLogo;
}
export interface SpacesUpdateParams {
  space_id: SpaceId;
  name?: string;
  color?: SpaceColor;
  logo?: SpaceLogo;
}
export interface SpacesDeleteParams {
  space_id: SpaceId;
}
export interface SpacesDeleteResult {
  /** The space the deleted space's projects moved to. */
  moved_to: SpaceId;
  moved_projects: number;
}
export interface SpacesReorderParams {
  /** Every space id exactly once, in the new order. */
  space_ids: SpaceId[];
}

export const SPACES_CHANGED_NOTIFICATION = "spaces.changed";

/** Sent after a space is created, updated, deleted or reordered, by any client. */
export interface SpacesChangedNotification {
  /** Every space after the change, in order. */
  spaces: Space[];
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
    kind: "user" | "agent";
    thread_id?: ThreadId | null;
  };
}

export interface ThreadsReadResult {
  thread: Thread;
  messages: ThreadReadMessage[];
  next_before_seq?: EventSeq | null;
  through_seq: EventSeq;
}

export interface ThreadsCreateParams {
  /** Pin the selected account, including the CLI account. */
  pin_account?: boolean;
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
  /** Client-chosen id (UUID v7) for the new thread. A repeat with the same id returns that thread, never a second one, and sends `message` only if it was not delivered. */
  thread_id?: ThreadId;
  /** The client's id for `message` (as `threads.send` `message_id`); a repeat is answered from the first delivery. */
  message_id?: MessageId;
  /** Group projects, worktree mode: member paths to include. Omit for all; ignored in local mode. */
  members?: string[];
  /** Group projects: base branch per member path (worktree fork point, or the branch a local checkout switches to). */
  base_branches?: Record<string, string>;
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
  /** When true, a page also returns the earlier rows of its oldest turn, so it starts at a turn boundary. */
  whole_turns?: boolean;
  /** With before_seq: only the transcript page; thread-wide state comes back empty. */
  transcript_only?: boolean;
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
/** What a project note is for: the user's brief, or the setup note the Coordinator keeps. Ordinary notes (memory) have no role. */
export type ProjectNoteRole = "brief" | "setup";
/** What kind of memory a project note holds. Decision and gotcha notes are history: agents add dated claims instead of rewriting them. */
export type NoteCategory = "preference" | "decision" | "convention" | "gotcha";
/** Why a note may be outdated: a claim cites a file that changed since the commit it names. */
export interface StaleInfo {
  /** The cited path that changed, as the note writes it. */
  path: string;
  /** Short id of the latest commit that changed it. */
  commit: string;
}

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
  /** Set on a project's brief and setup notes (one of each per project). Only the user edits the brief; only the project's Coordinator writes the setup note. */
  project_role?: ProjectNoteRole | null;
  /** The kind of memory this note holds. Absent for ordinary notes. */
  category?: NoteCategory | null;
  /** Set when a claim cites a file that changed after its commit; computed by the daemon from git. Show "May be outdated · {path} changed". */
  stale?: StaleInfo | null;
  /** A project note without a category written before categories existed (see `NotesListResult.history_since`). Show "Undated, before {date}". */
  undated?: boolean;
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
  /** Creates the project's pinned brief or setup note (scope "project" with a `project_id`). Absent for an ordinary note. */
  project_role?: ProjectNoteRole | null;
  category?: NoteCategory | null;
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
  /** Sets the note's category. Absent leaves it as it is. */
  category?: NoteCategory | null;
  /** Removes the note's category. Not together with `category`. */
  clear_category?: boolean;
}

/** Result of `notes.list`. */
export interface NotesListResult {
  notes: NoteSummary[];
  /** When categories were introduced. Uncategorized project notes created before it are `undated`. */
  history_since?: string | null;
}

/** Stale notes a project needs before the Coordinator offers to tidy them. */
export const NOTES_TIDY_THRESHOLD = 5;
/** Days the "Tidy notes" offer stays quiet after "Not now". */
export const NOTES_TIDY_SNOOZE_DAYS = 7;

/** The state of a project's "Tidy notes" card ("N notes may be outdated"). */
export interface TidyOffer {
  /** Live project notes whose claims cite files that changed since. */
  stale: NoteId[];
  /** Show the card: at least `NOTES_TIDY_THRESHOLD` stale notes and not snoozed. */
  offer: boolean;
  /** While set and in the future, the offer is snoozed. */
  snoozed_until?: string | null;
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
  /** Client-chosen id for the run's thread (see `ThreadsCreateParams.thread_id`). A repeat returns the run it started; after a failed first message the thread is kept for a retry with this id. */
  thread_id?: ThreadId;
  /** The client's id for the first message. */
  message_id?: MessageId;
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
  /** Nil when `queued`. */
  turn_id: TurnId;
  message_id: MessageId;
  /** The message waits in the thread's queue (a Coordinator's context is being refreshed) and starts the next turn by itself. */
  queued?: boolean;
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
  /** Whether an agent's question may carry a default and a wait, and the longest wait. */
  ask_deadlines?: AskDeadlineSettings;
  /** Folders outside a project the user allowed Preview to serve files from. */
  preview_allowed_folders?: string[];
}

/** Limits for `kybern_agent_delegate`, read each time an agent delegates. */
export interface OrchestrationSettings {
  /** Most delegated children one thread may have running at once (1-16). */
  max_active_children: number;
  /** The same limit when the delegating thread is a project's Coordinator (1-16). */
  lead_max_children: number;
  /** Deepest chain of delegation; 1 means only top-level threads delegate (1-4). */
  max_depth: number;
  /** The harness, model and effort a Coordinator uses for each kind of work when it does not ask for another. Absent from older daemons. */
  role_defaults?: RoleDefaults;
  /** How freely the Coordinator acts. Absent from older daemons (`propose_large`). */
  lead_autonomy?: LeadAutonomy;
  /** Where the Coordinator's children work when it does not say. Absent from older daemons (`shared`). */
  lead_workspace?: DelegationWorkspace;
  /** Push and open pull requests without asking. Merging a pull request always asks. */
  lead_push_without_asking?: boolean;
  /** Refresh the Coordinator's context once it passes this many tokens; 0 is off. Absent from older daemons (200 000). */
  rotation_budget_tokens?: number;
}

/** How freely a Coordinator acts before asking the user. */
export type LeadAutonomy = "act" | "propose_large" | "propose_first";

/** The roles with a configurable default (`general` has none). */
export type CoordinatorRole = Exclude<DelegationRole, "general">;

/** The harness, model and effort used for one kind of delegated work. An unset field follows the delegating thread. */
export interface RoleDefault {
  provider?: ProviderInstance | null;
  model?: string | null;
  effort?: string | null;
}

export type RoleDefaults = Partial<Record<CoordinatorRole, RoleDefault>>;

/** A project's overrides of the Coordinator settings. Absent fields fall back to `OrchestrationSettings`; `role_defaults` replaces the global entry of each role it lists. */
export interface CoordinatorOverrides {
  role_defaults?: RoleDefaults;
  lead_autonomy?: LeadAutonomy | null;
  lead_workspace?: DelegationWorkspace | null;
  lead_push_without_asking?: boolean | null;
  /** Most delegated children the Coordinator may have running (1-16). */
  lead_max_children?: number | null;
  /** Context refresh budget for this project's Coordinator; 0 is off. */
  rotation_budget_tokens?: number | null;
}

/** The Coordinator settings in force for one project. */
export interface EffectiveCoordinatorSettings {
  role_defaults: RoleDefaults;
  lead_autonomy: LeadAutonomy;
  lead_workspace: DelegationWorkspace;
  lead_push_without_asking: boolean;
  lead_max_children: number;
  /** 0 when context refresh is off. Absent from older daemons. */
  rotation_budget_tokens?: number;
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

/** Where `secrets.target` and `secrets.store` look. Pass exactly one. */
export interface SecretsWorkspace {
  thread_id?: string | null;
  project_id?: string | null;
}

export interface SecretsTargetParams extends SecretsWorkspace {
  env_key: string;
  /** Env file relative to the workspace. Default `.env`. */
  file?: string | null;
}

/** What storing into a file would do, checked without a value. */
export interface SecretsTargetResult {
  file: string;
  /** The key is already in the file; storing replaces it. */
  replaces: boolean;
  /** Git ignores the file (true outside a repository). */
  ignored: boolean;
  /** Git tracks the file, so it can never take a secret. */
  tracked: boolean;
  /** The file already exists. */
  exists: boolean;
}

export interface SecretsStoreParams extends SecretsWorkspace {
  env_key: string;
  /** The secret. Written to the file and never stored, traced or returned. */
  value: string;
  file?: string | null;
  /** Add the file to the `.gitignore` beside it first, when git does not ignore it yet. */
  add_to_gitignore?: boolean;
}

export interface SecretsStoreResult {
  env_key: string;
  file: string;
  replaced: boolean;
  gitignore_updated: boolean;
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
  /** Also read these accounts (the composer's thread account). */
  instances?: ProviderInstance[];
  /** Also read every named account. */
  all_accounts?: boolean;
}
/** Where a provider's current limits came from. */
export type LimitsSource = "live" | "session" | "stored";
/** Why a provider's live read did not update its limits. */
export type LimitsStale = "login_refresh" | "throttled" | "unavailable" | "from_last_run";
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
  /** Set on per-account entries; unset on the global default per kind. */
  instance?: string;
}
export interface UsageLimitsResult {
  providers: ProviderLimits[];
  /** Providers with a live read in flight. */
  refreshing?: ProviderKind[];
  /** Per-account entries (`instance` set). Absent from older daemons. */
  accounts?: ProviderLimits[];
}

export type AccountStatus = "signed_in" | "needs_sign_in" | "signed_out" | "unknown";
export interface AccountIdentity { email?: string; plan?: string; organization?: string }
export interface AccountSummary {
  /** Instance "default" is the CLI account. */
  provider: ProviderInstance;
  name: string;
  color?: string;
  identity?: AccountIdentity;
  status: AccountStatus;
  is_default: boolean;
  projects: string[];
  directory?: string;
  managed: boolean;
  can_sign_out: boolean;
}
export type AccountLoginMode = "browser" | "paste" | "device_code" | "terminal";
export type AccountLoginPhase = "starting" | "waiting" | "verifying" | "signed_in" | "failed" | "canceled";
export interface AccountLoginStartParams {
  kind: ProviderKind;
  instance?: string;
  mode: AccountLoginMode;
  directory?: string;
  upstream?: string;
}
export interface AccountLogin {
  id: string;
  kind: ProviderKind;
  instance?: string;
  mode: AccountLoginMode;
  phase: AccountLoginPhase;
  url?: string;
  user_code?: string;
  terminal?: TerminalInfo;
  identity?: AccountIdentity;
  suggested_name?: string;
  suggested_color?: string;
  duplicate_of?: string;
  previous_email?: string;
  error?: string;
  expires_at: string;
}
/** Params are an AccountLogin. */
export const ACCOUNTS_LOGIN_CHANGED_NOTIFICATION = "providers.accounts.login.changed";
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
  author_avatar_url?: string;
  author_is_bot?: boolean;
  created_at?: DateTime;
  additions?: number;
  deletions?: number;
  /** APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED */
  review_decision?: string;
  /** MERGEABLE | CONFLICTING | UNKNOWN */
  mergeable?: string;
  labels?: PrLabel[];
  checks_summary?: PrChecksSummary;
  /** Group projects: the member repository (path relative to the group folder). Absent for single projects. */
  repo?: string;
}
export interface PrLabel { name: string; color: string }
export interface PrChecksSummary { total: number; passed: number; failed: number; pending: number; skipped: number }

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
  /** Group threads: one entry per member in project order, excluded ones too. The fields above are the primary's. */
  repos?: RepoGitStatus[];
}

/** One member's git state in a group thread (the `GitStatus` fields are flattened in). */
export interface RepoGitStatus extends Omit<GitStatus, "repos"> {
  repo: string;
  name: string;
  included: boolean;
  status: MemberStatus;
}

export interface GitBranchesParams {
  project_id: ProjectId;
  /** Group projects: the member whose branches to list. Defaults to the primary. */
  repo?: string;
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
  /** The primary's commit, or the first member committed in a group thread. */
  commit: string;
  message: string;
  /** Group threads: every member committed, in project order. */
  commits?: RepoCommit[];
}

export interface RepoCommit {
  repo: string;
  commit: string;
  message: string;
}

export interface PrCreateGroupParams {
  thread_id: ThreadId;
  /** Default: every included member with changes and a GitHub remote. */
  repos?: string[];
  draft?: boolean;
  /** Defaults to true. */
  commit_first?: boolean;
}

export interface RepoPullRequest {
  repo: string;
  pull_request: PullRequest;
}

export interface PrCreateGroupResult {
  pull_requests: RepoPullRequest[];
  /** `path` is the member; `reason` says why it got no pull request. */
  skipped?: RejectedFolder[];
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
  /** Group projects: every member's pull requests in member order, each tagged with `repo`. */
  pull_requests: PullRequest[];
  /** Group projects only: one row per member, with why its list is missing. */
  repos?: PrListRepo[];
}
export interface PrListRepo {
  /** Member path, relative to the group folder ("." is the folder itself). */
  repo: string;
  name: string;
  /** "No GitHub remote", a missing folder or the `gh` error. */
  error?: string;
  /** Not on GitHub (no remote `gh` knows): nothing to list, and no error to show. */
  skipped?: boolean;
}

/** `repo`: the member of a group project (a `PullRequest.repo`); a group project requires it. */
export interface PrDetailParams { project_id: ProjectId; number: number; repo?: string }
export interface PrCheck { name: string; status: string; conclusion: string; url: string }
export interface PrDetailResult { pull_request: PullRequest; body: string; head_sha: string; reviewers: string[]; checks: PrCheck[]; changed_files: number
  /** CLEAN | BLOCKED | BEHIND | DIRTY | UNSTABLE | DRAFT | HAS_HOOKS | UNKNOWN */
  merge_state_status?: string
  reviews?: PrReviewer[]
  /** Issue comments plus review threads; absent when the count query failed. */
  comment_count?: number
  merged_at?: DateTime
  merged_by?: string
  closed_at?: DateTime
}
/** APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | REQUESTED */
export interface PrReviewer { login: string; avatar_url?: string; is_bot?: boolean; state: string }
export type PrPageKind = "files" | "comments" | "reviews" | "review_comments" | "checks";
export interface PrPageParams { project_id: ProjectId; number: number; kind: PrPageKind; page?: number; repo?: string }
export interface PrFile { path: string; old_path: string | null; status: string; additions: number; deletions: number; patch: string; patch_truncated: boolean }
export interface PrReviewEntry { id: number; author: string; body: string; state: string; path: string | null; line: number | null; side: string | null; url: string; updated_at: string; avatar_url?: string; author_is_bot?: boolean }
export interface PrPageResult { checks?: PrCheck[]; files: PrFile[]; entries: PrReviewEntry[]; page: number; has_more: boolean }
export type PrActionKind = "comment" | "approve" | "request_changes" | "checkout" | "merge" | "close";
export interface PrInlineComment { path: string; line: number; side: string; body: string }
export interface PrActionParams { project_id: ProjectId; number: number; action: PrActionKind; body?: string; inline_comments?: PrInlineComment[]; head_sha?: string; thread_id?: ThreadId; for_repair?: boolean; repo?: string }
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
  /** A `version` from an earlier read: an unchanged file returns `unchanged` with no content. */
  if_version?: string;
}

export interface ThreadFileReadParams {
  thread_id: ThreadId;
  path: string;
  max_bytes?: number;
  if_version?: string;
}

/** Replace an existing text file (atomically). `expected_version` makes a newer file on disk a CONFLICT error. */
export interface FilesWriteParams {
  project_id: ProjectId;
  path: string;
  content: string;
  expected_version?: string;
}

export interface ThreadFileWriteParams {
  thread_id: ThreadId;
  path: string;
  content: string;
  expected_version?: string;
}

export interface FilesWriteResult {
  version: string;
  size: number;
}

export interface ThreadFilesResolveParams {
  thread_id: ThreadId;
  /** Paths as written, without a `:line` or `#L` suffix. At most 200. */
  paths: string[];
}

export interface ThreadFilesResolveResult {
  /** Per requested path: the file relative to the thread cwd, or null. */
  paths: (string | null)[];
}

export interface FilesReadResult {
  content: string;
  truncated: boolean;
  binary: boolean;
  size: number;
  /** Opaque on-disk version (modification time and size). */
  version?: string;
  /** True when `if_version` still matched; `content` is empty. */
  unchanged?: boolean;
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
  /** Omit to follow defaults; "default" selects the CLI account. */
  instance?: string;
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
  "notes.list": [Empty, NotesListResult];
  "notes.get": [{ id?: NoteId | null; thread_id?: ThreadId | null }, { note?: Note | null }];
  "notes.create": [NotesCreateParams, Note];
  "notes.update": [NotesUpdateParams, Note];
  "notes.pin": [{ id: NoteId; pinned: boolean }, NoteSummary];
  "notes.move": [{ id: NoteId; scope: NoteScope; project_id?: ProjectId | null }, NoteSummary];
  "notes.delete": [{ id: NoteId }, NoteSummary];
  "notes.restore": [{ id: NoteId }, NoteSummary];
  "notes.purge": [{ id: NoteId }, Empty];
  "notes.search": [{ query: string; limit?: number | null }, { results: { id: NoteId; snippet: string }[] }];
  "notes.tidy_offer": [{ project_id: ProjectId }, TidyOffer];
  "notes.tidy_snooze": [{ project_id: ProjectId }, TidyOffer];
  "notes.tidy_start": [{ project_id: ProjectId }, { thread_id: ThreadId; notes: number }];
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
  "providers.accounts.list": [{ kind?: ProviderKind | null; refresh?: boolean }, { accounts: AccountSummary[] }];
  "providers.accounts.login.start": [AccountLoginStartParams, AccountLogin];
  "providers.accounts.login.get": [{ id: string }, AccountLogin];
  "providers.accounts.login.input": [{ id: string; code: string }, AccountLogin];
  "providers.accounts.login.cancel": [{ id: string }, AccountLogin];
  "providers.accounts.login.finish": [{ id: string; name: string; color?: string | null; make_default?: boolean }, ProviderInstance];
  "providers.accounts.update": [{ kind: ProviderKind; instance: string; name?: string | null; color?: string | null }, AccountSummary];
  "providers.accounts.sign_out": [ProviderInstance, AccountSummary];
  "providers.accounts.remove": [ProviderInstance, Empty];
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
  "files.write": [FilesWriteParams, FilesWriteResult];
  "threads.files.read": [ThreadFileReadParams, FilesReadResult];
  "threads.files.write": [ThreadFileWriteParams, FilesWriteResult];
  "threads.files.resolve": [ThreadFilesResolveParams, ThreadFilesResolveResult];
  "skills.list": [SkillsListParams, SkillsListResult];
  "threads.visuals.publish": [{ thread_id: ThreadId; html: string; title: string; height: number; await_answer?: boolean | null; answer_schema?: JsonValue | null; timeout_seconds?: number | null }, { visual: HtmlVisual }];
  "threads.visuals.snapshot": [{ thread_id: ThreadId; visual_id: Uuid; width: number; theme: JsonValue; lock?: JsonValue | null }, HtmlSnapshotResult];
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
  "projects.list": [{ refresh_git?: boolean }, ProjectsListResult];
  "projects.browse": [{ path?: string }, ProjectsBrowseResult];
  "access.pairing.create": [{ label?: string }, PairingCreateResult];
  "access.exposure.get": [Empty, Exposure];
  "access.exposure.set": [ExposureSetParams, Exposure];
  "access.tokens.list": [Empty, { tokens: TokenInfo[] }];
  "access.tokens.revoke": [{ token_id: string }, Empty];
  "projects.add": [ProjectsAddParams, Project];
  "projects.update": [ProjectsUpdateParams, Project];
  "projects.remove": [ProjectsRemoveParams, Empty];
  "projects.scan_repos": [ProjectsScanReposParams, ProjectsScanReposResult];
  "projects.members.status": [{ project_id: ProjectId }, ProjectsMembersStatusResult];
  "projects.map": [{ project_id: ProjectId }, ProjectsMapResult];
  "projects.instructions.create": [{ project_id: ProjectId }, ProjectsInstructionsCreateResult];
  "spaces.list": [Empty, SpacesListResult];
  "spaces.create": [SpacesCreateParams, Space];
  "spaces.update": [SpacesUpdateParams, Space];
  "spaces.delete": [SpacesDeleteParams, SpacesDeleteResult];
  "spaces.reorder": [SpacesReorderParams, SpacesListResult];
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
  "coordinator.get": [CoordinatorGetParams, Thread | null];
  "coordinator.open": [CoordinatorOpenParams, CoordinatorOpenResult];
  "coordinator.setup": [CoordinatorSetupParams, Thread];
  "coordinator.switch_harness": [CoordinatorSwitchHarnessParams, Thread];
  "coordinator.refresh_context": [CoordinatorRefreshContextParams, CoordinatorRefreshContextResult];
  "coordinator.edit_handoff": [CoordinatorEditHandoffParams, Record<string, never>];
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
  "requests.progress": [{ thread_id?: ThreadId | null }, { items: RequestProgress[] }];
  "requests.act": [{ approval_id: ApprovalId; action: string; value?: string | null }, Empty];
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
  "secrets.target": [SecretsTargetParams, SecretsTargetResult];
  "secrets.store": [SecretsStoreParams, SecretsStoreResult];
  "usage.summary": [UsageSummaryParams, UsageSummaryResult];
  "usage.limits": [UsageLimitsParams, UsageLimitsResult];
  "git.status": [GitStatusParams, GitStatus];
  "git.branches": [GitBranchesParams, GitBranchesResult];
  "git.commit": [GitCommitParams, GitCommitResult];
  "github.pr.create": [PrCreateParams, PullRequest];
  "github.pr.create_group": [PrCreateGroupParams, PrCreateGroupResult];
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
