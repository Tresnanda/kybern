// Kybern's notes-and-tasks tools for agents (`kybern_notes_search` … `kybern_task_claim`).
//
// The screen-control tools get their own row label and result view from
// `toolSurface.ts`; these get the same treatment here. Every harness reports
// them under its own spelling (`mcp__kybern__kybern_task_create` for Claude,
// `kybern_task_create` for pi), and the daemon returns one JSON object as an
// MCP text block. Nothing here touches the store: the transcript card reads
// live state itself.

import type { JsonValue, ToolCall } from "@/protocol"
import { kybernRefKey, kybernRefsIn } from "../../../../packages/kybern-client/src/chatLinks.ts"

export type AgentItemToolName =
  | "notes_search"
  | "note_read"
  | "tasks_list"
  | "task_read"
  | "note_create"
  | "note_append"
  | "note_update"
  | "task_create"
  | "task_update"
  | "task_claim"

export interface AgentItemTool {
  name: AgentItemToolName
  /** What the tool is about, for its icon. */
  kind: "note" | "task"
  /** Writes ask for approval and get a result card. */
  write: boolean
}

const TOOL_PATTERN =
  /(?:^|[^a-z0-9])kybern_(notes_search|note_read|tasks_list|task_read|note_create|note_append|note_update|task_create|task_update|task_claim)$/

/** The Kybern notes-or-tasks tool a call ran, under any harness's namespacing. */
export function agentItemTool(name: string): AgentItemTool | null {
  const match = TOOL_PATTERN.exec(name.toLowerCase())
  if (!match) return null
  const tool = match[1] as AgentItemToolName
  return {
    name: tool,
    kind: tool.startsWith("note") ? "note" : "task",
    write: /_(create|append|update|claim)$/.test(tool),
  }
}

export interface AgentNoteResult {
  kind: "note"
  /** Set on writes: what the tool did. */
  action: "created" | "appended" | "updated" | null
  id: string
  title: string
  scope: string
  projectId: string | null
  threadId: string | null
  createdByThread: string | null
}

export interface AgentTaskResult {
  kind: "task"
  action: "created" | "updated" | "claimed" | null
  id: string
  key: string
  title: string
  status: string
  priority: number
  projectId: string | null
  createdByThread: string | null
  criteriaDone: number
  criteriaTotal: number
  /** What an update changed, in the daemon's words ("check 2 criteria"). */
  changes: string[]
}

export interface AgentListResult {
  kind: "notes" | "tasks"
  count: number
  truncated: boolean
}

export type AgentItemResult = AgentNoteResult | AgentTaskResult | AgentListResult

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
const string = (value: unknown): string => (typeof value === "string" ? value : "")
const optional = (value: unknown): string | null => (typeof value === "string" && value ? value : null)
const number = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0)

function readResult(value: Record<string, unknown>): AgentItemResult | null {
  if (Array.isArray(value.notes)) return { kind: "notes", count: value.notes.length, truncated: value.truncated === true }
  if (Array.isArray(value.tasks)) return { kind: "tasks", count: value.tasks.length, truncated: value.truncated === true }
  const id = string(value.id)
  if (!id) return null
  const action = string(value.action)
  if (value.kind === "note") {
    return {
      kind: "note",
      action: action === "created" || action === "appended" || action === "updated" ? action : null,
      id,
      title: string(value.title),
      scope: string(value.scope),
      projectId: optional(value.project_id),
      threadId: optional(value.thread_id),
      createdByThread: optional(value.created_by_thread),
    }
  }
  if (value.kind === "task") {
    return {
      kind: "task",
      action: action === "created" || action === "updated" || action === "claimed" ? action : null,
      id,
      key: string(value.key),
      title: string(value.title),
      status: string(value.status),
      priority: number(value.priority),
      projectId: optional(value.project_id),
      createdByThread: optional(value.created_by_thread),
      criteriaDone: number(value.criteria_done),
      criteriaTotal: number(value.criteria_total),
      changes: Array.isArray(value.changes) ? value.changes.filter((item): item is string => typeof item === "string") : [],
    }
  }
  return null
}

/**
 * The daemon's answer inside whatever envelope the harness put around it: an MCP
 * `content` array (Claude, Codex), a nested `result`, or the bare JSON text.
 */
export function parseAgentItemResult(output: JsonValue | null | undefined): AgentItemResult | null {
  const seen = new Set<unknown>()
  const visit = (value: unknown, depth: number): AgentItemResult | null => {
    if (depth > 6 || value === null || value === undefined || seen.has(value)) return null
    if (typeof value === "string") {
      const text = value.trim()
      if (!text.startsWith("{") || text.length > 512 * 1024) return null
      try {
        return visit(JSON.parse(text), depth + 1)
      } catch {
        return null
      }
    }
    if (typeof value !== "object") return null
    seen.add(value)
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item, depth + 1)
        if (found) return found
      }
      return null
    }
    const object = value as Record<string, unknown>
    const direct = readResult(object)
    if (direct) return direct
    for (const key of ["structuredContent", "structured", "result", "content", "output", "text"] as const) {
      const found = visit(object[key], depth + 1)
      if (found) return found
    }
    return null
  }
  return visit(output, 0)
}

/** A write's result worth a card: it names one note or task the tool changed. */
export function agentItemWriteResult(result: AgentItemResult | null): AgentNoteResult | AgentTaskResult | null {
  return result && (result.kind === "note" || result.kind === "task") && result.action ? result : null
}

export interface AgentItemWrite {
  /** The tool call that wrote it. */
  id: string
  result: AgentNoteResult | AgentTaskResult
}

/**
 * Where a settled turn shows its notes and tasks. An item the final answer
 * references (a link, a bare URI or inline code) already appears there as a chip,
 * so its card is not repeated under the answer: it stays inline in the work fold,
 * at the call that created it (or, for an item that only changed, its last call).
 * Every other item keeps one card under the answer, from its latest write.
 * `writes` are in call order.
 */
export function placeItemCards(writes: readonly AgentItemWrite[], answer: string | null | undefined): { below: AgentItemWrite[]; inlineCallIds: ReadonlySet<string> } {
  const mentioned = new Set(kybernRefsIn(answer).map(kybernRefKey))
  const perItem = new Map<string, AgentItemWrite[]>()
  for (const write of writes) {
    const key = `${write.result.kind}:${write.result.id.toLowerCase()}`
    perItem.set(key, [...(perItem.get(key) ?? []), write])
  }
  const below: AgentItemWrite[] = []
  const inlineCallIds = new Set<string>()
  for (const [key, history] of perItem) {
    if (mentioned.has(key)) inlineCallIds.add((history.find((write) => write.result.action === "created") ?? history.at(-1)!).id)
    else below.push(history.at(-1)!)
  }
  below.sort((a, b) => writes.indexOf(a) - writes.indexOf(b))
  return { below, inlineCallIds }
}

/** A task key the agent passed (`ADE-14`), not an id or link. */
function inputTaskKey(input: JsonValue): string {
  const task = string(record(input)?.task).trim()
  return /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(task) ? task.toUpperCase() : ""
}

const quoted = (title: string) => {
  const clean = title.replace(/\s+/g, " ").trim()
  if (!clean) return ""
  return `“${clean.length > 60 ? `${clean.slice(0, 59).trimEnd()}…` : clean}”`
}

/** The row's one-line label, in the tense of the call's state. */
export function agentItemLabel(tool: AgentItemTool, input: JsonValue, result: AgentItemResult | null, complete: boolean, isError: boolean): string {
  const key = (result?.kind === "task" ? result.key : "") || inputTaskKey(input)
  const noteTitle = result?.kind === "note" ? quoted(result.title) : ""
  const query = string(record(input)?.query).trim()
  if (isError) {
    switch (tool.name) {
      case "notes_search": return "Failed to search notes"
      case "note_read": return "Failed to read a note"
      case "tasks_list": return "Failed to list tasks"
      case "task_read": return key ? `Failed to read ${key}` : "Failed to read a task"
      case "note_create": return "Failed to create a note"
      case "note_append": return "Failed to add to a note"
      case "note_update": return "Failed to update a note"
      case "task_create": return "Failed to create a task"
      case "task_update": return key ? `Failed to update ${key}` : "Failed to update a task"
      case "task_claim": return key ? `Failed to claim ${key}` : "Failed to claim a task"
    }
  }
  switch (tool.name) {
    case "notes_search":
      return `${complete ? "Searched" : "Searching"} notes${query ? ` for ${quoted(query)}` : ""}`
    case "note_read":
      return complete ? (noteTitle ? `Read note ${noteTitle}` : "Read a note") : "Reading a note"
    case "tasks_list":
      return complete ? "Listed tasks" : "Listing tasks"
    case "task_read":
      return complete ? (key ? `Read task ${key}` : "Read a task") : key ? `Reading task ${key}` : "Reading a task"
    case "note_create":
      return complete ? "Created note" : "Creating a note"
    case "note_append":
      return complete ? "Added to note" : "Adding to a note"
    case "note_update":
      return complete ? "Updated note" : "Updating a note"
    case "task_create":
      return complete ? "Created task" : "Creating a task"
    case "task_update":
      return complete ? (key ? `Updated task ${key}` : "Updated a task") : key ? `Updating task ${key}` : "Updating a task"
    case "task_claim":
      return complete ? (key ? `Claimed ${key}` : "Claimed a task") : key ? `Claiming ${key}` : "Claiming a task"
  }
}

/** The card's meta line, after the status and project the card reads live. */
export function agentItemChangeSummary(result: AgentNoteResult | AgentTaskResult): string {
  if (result.kind === "note") return result.action === "appended" ? "Added text" : result.action === "updated" ? "Edited" : ""
  if (result.action === "claimed") return "Working on it in this chat"
  if (result.action === "updated" && result.changes.length > 0) {
    const text = result.changes.join(", ")
    return text.charAt(0).toUpperCase() + text.slice(1)
  }
  return ""
}

/** Pretty JSON for the expanded raw result of a read, or the text unchanged. */
export function agentItemResultText(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith("{")) return text
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2)
  } catch {
    return text
  }
}

/** Whether a call is one of these tools; for grouping and icons. */
export function isAgentItemCall(call: Pick<ToolCall, "name">): boolean {
  return agentItemTool(call.name) !== null
}

/** A task body preview split into its prose and its top-level checklist, for the approval card. */
export function splitChecklistPreview(text: string): { text: string; items: { text: string; checked: boolean }[] } {
  const prose: string[] = []
  const items: { text: string; checked: boolean }[] = []
  let fenced = false
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
    const item = fenced ? null : /^[-*+] \[([ xX])\] (.*)$/.exec(line)
    if (item) items.push({ text: item[2]!.trim(), checked: item[1] !== " " })
    else prose.push(line)
  }
  return { text: prose.join("\n").trim(), items }
}
