import type { ApprovalRequest } from "./types.ts"

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
