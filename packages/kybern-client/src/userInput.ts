import type { ApprovalRequest, ContentPart } from "./types.ts"

export const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
export const string = (value: unknown): string => typeof value === "string" ? value : ""
export const array = (value: unknown): unknown[] => Array.isArray(value) ? value : []

export function isUserInput(approval: ApprovalRequest): boolean {
  return ["AskUserQuestion", "request_user_input", "opencode_question", "mcp_elicitation", "ui_select", "ui_confirm", "ui_input", "ui_editor"].includes(approval.tool_name)
}

export function questionsFor(approval: ApprovalRequest) {
  return array(record(approval.input).questions).map((item, index) => {
    const question = record(item)
    return {
      id: string(question.id) || String(index),
      title: string(question.question),
      header: string(question.header),
      multiple: question.multiSelect === true || question.multiple === true,
      custom: question.custom !== false,
      secret: question.isSecret === true,
      options: array(question.options).map((item) => typeof item === "string" ? { label: item, description: "" } : { label: string(record(item).label), description: string(record(item).description) }),
    }
  })
}

export function questionResponse(approval: ApprovalRequest, answers: string[][]): unknown {
  const questions = questionsFor(approval)
  if (answers.length !== questions.length || answers.some((answer) => !answer.length || answer.some((s) => !s.trim()))) throw new Error("Answer each question before continuing.")
  if (approval.tool_name === "opencode_question") return { answers }
  if (approval.tool_name === "AskUserQuestion") return { answers: Object.fromEntries(questions.map((q, i) => [q.title, answers[i]!.join(", ")])) }
  return { answers: Object.fromEntries(questions.map((q, i) => [q.id, { answers: answers[i] }])) }
}

/** A harness asking for consent to drive an app on this machine, sent as an MCP elicitation. */
export interface ConnectorApproval {
  /** The connector that wants access, e.g. "Computer Use". */
  connector: string
  /** The app it wants to control, as the harness names it. */
  app: string | null
  /** The harness's own question, kept as a fallback prompt. */
  message: string
  /** The harness's risk note, shown under the prompt. */
  subtitle: string
  /** Persistence scopes the harness accepts in the reply, e.g. ["session", "always"]. */
  persist: string[]
}

/** Codex tags per-app Computer Use consent as an elicitation with no form fields. */
export function connectorApproval(approval: ApprovalRequest): ConnectorApproval | null {
  if (approval.tool_name !== "mcp_elicitation") return null
  const input = record(approval.input)
  const meta = record(input._meta)
  if (string(meta.codex_approval_kind) !== "mcp_tool_call") return null
  const params = array(meta.tool_params_display).map(record)
  const app = params.find((param) => string(param.name) === "app") ?? params[0]
  return {
    connector: string(meta.connector_name) || string(input.serverName) || "This tool",
    app: app ? string(app.value) || null : null,
    message: string(input.message),
    subtitle: string(meta.subtitle),
    persist: array(meta.persist).map(String),
  }
}

/** `@Computer`: Kybern's own computer-use mention, offered in the plugin catalog. */
export const COMPUTER_MENTION_PATH = "kybern://computer"

/** The same catalog entry the daemon lists for project chats, for chats without a project. */
export const COMPUTER_MENTION_SKILL = {
  name: "computer",
  display_name: "Computer",
  description: "Use apps on this Mac for this request",
  path: COMPUTER_MENTION_PATH,
  scope: "plugin",
  enabled: true,
} as const

/** A `{ type: "mention" }` content part: plugins, `@Computer`, and Kybern notes and tasks. */
export type MentionPart = Extract<ContentPart, { type: "mention" }>

/** Notes mentioned in a prompt: the daemon expands `kybern://note/<id>` to the note's text in the provider's copy. */
export const NOTE_MENTION_PREFIX = "kybern://note/"
/** Tasks mentioned in a prompt: the daemon expands `kybern://task/<id>` to the task's details in the provider's copy. */
export const TASK_MENTION_PREFIX = "kybern://task/"

export const noteMentionPath = (id: string): string => `${NOTE_MENTION_PREFIX}${id}`
export const taskMentionPath = (id: string): string => `${TASK_MENTION_PREFIX}${id}`

/** What a Kybern mention path points at, or null for a plugin or any other path. */
export function parseKybernMention(path: string): { kind: "note" | "task"; id: string } | { kind: "computer" } | null {
  if (path === COMPUTER_MENTION_PATH) return { kind: "computer" }
  for (const [kind, prefix] of [["note", NOTE_MENTION_PREFIX], ["task", TASK_MENTION_PREFIX]] as const) {
    if (path.startsWith(prefix)) {
      const id = path.slice(prefix.length).trim()
      return id ? { kind, id } : null
    }
  }
  return null
}

const mentionLabel = (value: string, fallback: string) => value.replace(/\s+/g, " ").trim() || fallback

/** The mention part for a note. The chip reads as the note's title. */
export function noteMentionPart(note: { id: string; title: string }): MentionPart {
  const title = mentionLabel(note.title, "Untitled note")
  return { type: "mention", name: title, path: noteMentionPath(note.id), display_name: title }
}

/** The mention part for a task. The chip reads as its key and title ("ADE-14 Fix login"). */
export function taskMentionPart(task: { id: string; key: string; title: string }): MentionPart {
  const title = mentionLabel(task.title, "Untitled task")
  return { type: "mention", name: title, path: taskMentionPath(task.id), display_name: task.key ? `${task.key} ${title}` : title }
}

/** Kybern's own consent for computer use, asked by the daemon rather than a harness. */
export function computerConsent(approval: ApprovalRequest): { app: string; foreground: boolean } | null {
  if (approval.tool_name !== "kybern_computer_use") return null
  const input = record(approval.input)
  return { app: string(input.app) || "this app", foreground: string(input.mode) === "foreground" }
}

/** The accept reply for a connector approval; `persist` asks the harness not to ask again in that scope. */
export function connectorApprovalResponse(persist: "session" | null): unknown {
  return persist ? { action: "accept", content: {}, _meta: { persist } } : { action: "accept", content: {} }
}

/** `tool_name` of the daemon's approval card for an agent writing notes or tasks. */
export const NOTES_TASKS_APPROVAL_TOOL = "kybern_notes_tasks"

export type NotesTasksAction = "create_note" | "append_note" | "update_note" | "create_task" | "update_task" | "claim_task"

/** Kybern's own consent before an agent files or changes a note or task. */
export interface NotesTasksConsent {
  action: NotesTasksAction
  kind: "note" | "task"
  /** The daemon's one line, e.g. "Create task 'Fix login' in ade". */
  summary: string
  /** The new title, for creates and renames. */
  title: string | null
  /** The project a new item goes to; null for a global one. */
  project: string | null
  /** The existing note or task a change applies to. */
  target: { id: string; key: string | null; title: string } | null
  /** What an update changes, in the daemon's words. */
  changes: string[]
  /** New text: a body, an append, or a task's description and checklist. */
  preview: string
  priority: number
  priorityLabel: string | null
  /** How many acceptance criteria a new task has. */
  criteria: number
}

const NOTES_TASKS_ACTIONS: readonly NotesTasksAction[] = ["create_note", "append_note", "update_note", "create_task", "update_task", "claim_task"]

export function notesTasksConsent(approval: ApprovalRequest): NotesTasksConsent | null {
  if (approval.tool_name !== NOTES_TASKS_APPROVAL_TOOL) return null
  const input = record(approval.input)
  const action = string(input.action) as NotesTasksAction
  if (!NOTES_TASKS_ACTIONS.includes(action)) return null
  const target = record(input.target)
  const targetId = string(target.id)
  return {
    action,
    kind: action.endsWith("_task") ? "task" : "note",
    summary: approval.summary,
    title: string(input.title) || null,
    project: string(input.project) || null,
    target: targetId ? { id: targetId, key: string(target.key) || null, title: string(target.title) } : null,
    changes: array(input.changes).filter((item): item is string => typeof item === "string"),
    preview: string(input.preview),
    priority: typeof input.priority === "number" ? input.priority : 0,
    priorityLabel: string(input.priority_label) || null,
    criteria: typeof input.criteria === "number" ? input.criteria : 0,
  }
}
