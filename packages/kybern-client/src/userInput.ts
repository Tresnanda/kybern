import { COORDINATOR_BRIEF_TOOL, COORDINATOR_SETTINGS_TOOL, CURSOR_QUESTION_TOOL, LOGIN_REQUEST_TOOL, NORMALIZED_ANSWERS_KEY, PICK_REQUEST_TOOL, PROMPT_REQUEST_TOOL, SECRET_REQUEST_TOOL, VISUAL_ANSWER_TOOL, type ApprovalRequest, type PendingRequestKind, type ContentPart, type UserInputAnswer, type UserInputAttachment } from "./types.ts"

export const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
export const string = (value: unknown): string => typeof value === "string" ? value : ""
export const array = (value: unknown): unknown[] => Array.isArray(value) ? value : []

export function isUserInput(approval: Pick<ApprovalRequest, "tool_name">): boolean {
  return ["AskUserQuestion", "request_user_input", "opencode_question", CURSOR_QUESTION_TOOL, "mcp_elicitation", "ui_select", "ui_confirm", "ui_input", "ui_editor"].includes(approval.tool_name)
}

export interface QuestionOption {
  label: string
  description: string
  /** Text or code to show while the option is focused. Markdown. */
  preview?: string
}

/** One question of a request, as the cards draw it. */
export interface QuestionSpec {
  id: string
  /** The question. Markdown. */
  title: string
  header: string
  multiple: boolean
  custom: boolean
  secret: boolean
  options: QuestionOption[]
  /** The harness can take images and files with the answer; only daemons that send `questions` say so. */
  attachments?: boolean
}

const option = (item: unknown): QuestionOption => {
  if (typeof item === "string") return { label: item, description: "" }
  const preview = string(record(item).preview)
  return { label: string(record(item).label), description: string(record(item).description), ...(preview.trim() ? { preview } : {}) }
}

/** The request's questions: the daemon's normalized `questions` when it sends them, else read from the harness's `input`.
 *  Pi's dialogs (`ui_*`) and MCP forms keep their own form. */
export function questionsFor(approval: Pick<ApprovalRequest, "tool_name" | "input" | "questions">): QuestionSpec[] {
  if (approval.tool_name.startsWith("ui_")) return []
  if (approval.questions?.length) {
    return approval.questions.map((q) => ({
      id: q.id,
      title: q.question,
      header: q.header ?? "",
      multiple: q.multi_select,
      custom: q.allow_custom,
      secret: q.secret,
      attachments: q.attachments,
      options: q.options.map((o) => ({ label: o.label, description: o.description ?? "", ...(o.preview?.trim() ? { preview: o.preview } : {}) })),
    }))
  }
  return array(record(approval.input).questions).map((item, index) => {
    const question = record(item)
    return {
      id: string(question.id) || String(index),
      title: string(question.question),
      header: string(question.header),
      multiple: question.multiSelect === true || question.multiple === true,
      custom: question.custom !== false,
      secret: question.isSecret === true,
      options: array(question.options).map(option),
    }
  })
}

/** The harness's own response to `answers` (one list per question, in order). A multi-select Claude answer is the list of
 *  labels, never a comma-joined string, so a label with a comma stays whole. */
export function questionResponse(approval: Pick<ApprovalRequest, "tool_name" | "input" | "questions">, answers: string[][]): unknown {
  const questions = questionsFor(approval)
  if (answers.length !== questions.length || answers.some((answer) => !answer.length || answer.some((s) => !s.trim()))) throw new Error("Answer each question before continuing.")
  if (approval.tool_name === "opencode_question") return { answers }
  if (approval.tool_name === "AskUserQuestion") return { answers: Object.fromEntries(questions.map((q, i) => [q.title, q.multiple ? answers[i]! : answers[i]!.join(", ")])) }
  if (approval.tool_name === CURSOR_QUESTION_TOOL) {
    const ids = approval.questions ?? []
    return { answers: questions.map((q, i) => ({ questionId: q.id, selectedOptionIds: answers[i]!.map((label) => ids[i]?.options.find((o) => o.label === label)?.value ?? label) })) }
  }
  return { answers: Object.fromEntries(questions.map((q, i) => [q.id, { answers: answers[i] }])) }
}

/** Answers the daemon turns into the harness's own response, attachments included (`kybern_answers`). Needs a daemon that sent `questions`. */
export function normalizedResponse(questions: Pick<QuestionSpec, "id">[], answers: string[][], attachments: UserInputAttachment[][] = []): { [NORMALIZED_ANSWERS_KEY]: UserInputAnswer[] } {
  if (answers.length !== questions.length || answers.some((answer, i) => !answer.some((s) => s.trim()) && !attachments[i]?.length)) throw new Error("Answer each question before continuing.")
  return {
    [NORMALIZED_ANSWERS_KEY]: questions.map((q, i) => ({
      id: q.id,
      answers: answers[i]!.map((s) => s.trim()).filter(Boolean),
      ...(attachments[i]?.length ? { attachments: attachments[i] } : {}),
    })),
  }
}

/** Whether a request waits for an answer (a question, a form, a sign-in, a secret) or an approval; `ApprovalRequest::pending_kind`. */
export function pendingKind(approval: Pick<ApprovalRequest, "tool_name" | "input">): PendingRequestKind {
  const answers = isUserInput(approval) || [SECRET_REQUEST_TOOL, VISUAL_ANSWER_TOOL, PICK_REQUEST_TOOL, LOGIN_REQUEST_TOOL, PROMPT_REQUEST_TOOL, COORDINATOR_BRIEF_TOOL, COORDINATOR_SETTINGS_TOOL].includes(approval.tool_name)
  return answers && !connectorApproval(approval as ApprovalRequest) ? "question" : "approval"
}

/** The daemon's reason when a restart cut a request off. */
export const DAEMON_RESTARTED = "daemon restarted"

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

/** A secret the user pasted and Kybern stored privately: the daemon turns `kybern://secret/<KEY>?file=<file>` into the name and file, never a value. */
export const SECRET_MENTION_PREFIX = "kybern://secret/"
/** An element the user ⌥-clicked in the Preview or a visual: `kybern://anchor/<base64url JSON>`, expanded by the daemon into bounded page data. */
export const ANCHOR_MENTION_PREFIX = "kybern://anchor/"

/** What an anchor chip carries; every field is bounded again by the daemon. */
export interface AnchorPayload {
  selector: string
  tag?: string
  text?: string
  html?: string
  page_url?: string
  /** The element's `data-kybern-id`, when it is in an inline visual. */
  id?: string
  box?: { x: number; y: number; width: number; height: number }
  /** The daemon asset of the element's crop. */
  screenshot_asset?: string
}

const toBase64Url = (text: string): string => {
  let binary = ""
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}
const fromBase64Url = (value: string): string => {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"))
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))
}

/** The mention part for a stored secret. The chip reads as `$KEY`; the value is in the file only. */
export function secretMentionPart(secret: { key: string; file: string }): MentionPart {
  const file = secret.file === ".env" ? "" : `?file=${encodeURIComponent(secret.file)}`
  return { type: "mention", name: secret.key, path: `${SECRET_MENTION_PREFIX}${secret.key}${file}`, display_name: secret.key }
}

/** The mention part for a pointed-at element. */
export function anchorMentionPart(label: string, payload: AnchorPayload): MentionPart {
  const name = mentionLabel(label, "Element")
  return { type: "mention", name, path: `${ANCHOR_MENTION_PREFIX}${toBase64Url(JSON.stringify(payload))}`, display_name: name }
}

/** What a composer chip path stands for, or null for any other path. */
export function parseComposerChip(path: string): { kind: "secret"; key: string; file: string } | { kind: "anchor"; payload: AnchorPayload } | null {
  if (path.startsWith(SECRET_MENTION_PREFIX)) {
    const [key = "", query = ""] = path.slice(SECRET_MENTION_PREFIX.length).split("?")
    if (!key) return null
    const file = /(?:^|&)file=([^&]*)/.exec(query)?.[1]
    let decoded = ".env"
    try { if (file) decoded = decodeURIComponent(file) } catch { /* keep the default */ }
    return { kind: "secret", key, file: decoded }
  }
  if (path.startsWith(ANCHOR_MENTION_PREFIX)) {
    try {
      const payload = JSON.parse(fromBase64Url(path.slice(ANCHOR_MENTION_PREFIX.length))) as AnchorPayload
      return payload && typeof payload === "object" && typeof payload.selector === "string" ? { kind: "anchor", payload } : null
    } catch { return null }
  }
  return null
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
