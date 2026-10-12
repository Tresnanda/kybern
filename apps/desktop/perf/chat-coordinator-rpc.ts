/* eslint-disable @typescript-eslint/no-explicit-any */
import { useStore } from "../src/state/store"
import { emptyThreadState } from "../src/state/transcript"
import type { ApprovalDecision, Note, NoteSummary, Thread, UserMessage } from "../src/protocol"

export * from "../src/state/rpc"
export const chatFixture = { calls: [] as { method: string; params: any }[], sent: [] as { threadId: string; message: UserMessage; messageId?: string }[], coordinatorCreates: 0, notes: new Map<string, Note>() }
const coordinators = new Map<string, Thread>()
const at = "2026-09-14T10:00:00Z"
const connection = { call, onNotification: () => () => {}, onStatus: () => () => {} }
const runtime = { rpc, loadThread }
export function rpc() { return connection }
export function activeRuntime() { return runtime }
export async function searchFiles() { return [] }
export async function listSkills() { return [] }
export async function loadDiff() {}
export async function loadGitStatus() {}
export async function loadFileDiff() {}
export async function loadLineage() {}
export async function loadSubagents() {}
export async function loadHeldMessages() {}
export async function loadThread(threadId: string) {
  const state = useStore.getState()
  if (!state.transcripts[threadId]) state.set((current) => ({ transcripts: { ...current.transcripts, [threadId]: { ...emptyThreadState(), loaded: true, thread: current.threads[threadId] } } }))
}
export async function sendMessage(threadId: string, message: UserMessage) {
  recordSent(threadId, message)
}
function recordSent(threadId: string, message: UserMessage, messageId?: string) {
  chatFixture.sent.push({ threadId, message: structuredClone(message), messageId })
  const state = useStore.getState()
  const current = state.transcript(threadId)
  state.set({ transcripts: { ...state.transcripts, [threadId]: { ...current, blocks: [...current.blocks, { kind: "user", id: `sent-${chatFixture.sent.length}`, turnId: "sent-turn", at, seq: 50 + chatFixture.sent.length, message }] } } })
}
export const queueMessage = sendMessage
/** Answers settle the card the way the daemon does: off the pending list, onto the transcript row, value redacted. */
export async function respondApproval(id: string, decision: ApprovalDecision) {
  await call("approvals.respond", { approval_id: id, ...decision })
}
export const fixtureConnection = connection
const summary = (note: Note): NoteSummary => { const { body, ...rest } = note; void body; return rest }
async function call(method: string, params: any): Promise<any> {
  chatFixture.calls.push({ method, params: structuredClone(params) })
  const state = useStore.getState()
  if (method === "terminals.create") return { id: params.terminal_id, thread_id: params.thread_id, status: "running", cols: params.cols, rows: params.rows }
  if (method.startsWith("terminals.")) return method === "terminals.list" ? { terminals: [] } : {}
  if (method === "threads.search") {
    const query = String(params.query ?? "").toLowerCase()
    return { threads: Object.values(state.threads).filter((thread) => (params.all_projects || !params.project_id || params.project_id === thread.project_id) && (params.include_archived || thread.status !== "archived") && (!query || thread.title.toLowerCase().includes(query))).slice(0, params.limit ?? 12).map((thread) => ({ thread })), next_cursor: null }
  }
  if (method === "coordinator.get") return coordinators.get(params.project_id) ?? null
  if (method === "coordinator.open") {
    const existing = coordinators.get(params.project_id)
    if (existing) return { thread: existing, created: false }
    const thread: Thread = { id: chatFixture.coordinatorCreates ? `project-coordinator-${chatFixture.coordinatorCreates + 1}` : "project-coordinator", project_id: params.project_id, coordinator_project_id: params.project_id, title: "Coordinator", provider: params.provider, model: params.model ?? null, effort: params.effort ?? null, permission_mode: params.permission_mode ?? "supervised", status: "idle", cwd: "/project", pinned: true, created_at: at, updated_at: at, last_seq: 0 }
    coordinators.set(params.project_id, thread); chatFixture.coordinatorCreates += 1
    return { thread, created: true }
  }
  if (method === "coordinator.switch_harness") {
    const current = coordinators.get(params.project_id)
    if (!current) throw new Error("Open the Coordinator before changing its harness.")
    const thread = { ...current, provider: params.provider, model: params.model ?? null, effort: params.effort ?? null, permission_mode: params.permission_mode ?? current.permission_mode }
    coordinators.set(params.project_id, thread)
    return thread
  }
  if (method === "threads.send") {
    recordSent(params.thread_id, params.message, params.message_id)
    return { turn_id: "coordinator-turn", message_id: params.message_id }
  }
  if (method === "threads.target.get") {
    const thread = state.threads[params.thread_id]
    return { target: { provider: thread.provider, model: thread.model ?? null, effort: thread.effort ?? null }, account_override: false, effective_permission_mode: thread.permission_mode, pending_permission_mode: null, native_session_id: null }
  }
  if (method === "providers.accounts.catalog") return state.providers.find((provider) => provider.kind === params.provider.kind)
  if (method === "git.branches") return { current: "main", branches: [] }
  if (method === "notes.search") return { results: [] }
  if (method === "approvals.respond") {
    const stored: ApprovalDecision = params.decision === "submit" ? { decision: "submit", response: { secret: "[redacted]" } } : { decision: params.decision, ...(params.reason ? { reason: params.reason } : {}) } as ApprovalDecision
    state.set((current) => {
      const transcripts = { ...current.transcripts }
      for (const [id, transcript] of Object.entries(transcripts)) {
        if (!transcript.pendingApprovals.some((approval) => approval.id === params.approval_id)) continue
        transcripts[id] = { ...transcript, pendingApprovals: transcript.pendingApprovals.filter((approval) => approval.id !== params.approval_id), blocks: transcript.blocks.map((block) => block.kind === "approval" && block.approval.id === params.approval_id ? { ...block, decision: stored } : block) }
      }
      return { transcripts }
    })
    return {}
  }
  if (method === "projects.update") {
    const project = state.projects[params.project_id]
    return { ...project, ...(params.brief_in_all_threads === undefined ? {} : { brief_in_all_threads: params.brief_in_all_threads }) }
  }
  if (method === "notes.list") return { notes: [...chatFixture.notes.values()].map(summary) }
  if (method === "notes.get") return { note: chatFixture.notes.get(params.id) ?? null }
  if (method === "notes.create") {
    const note: Note = { id: `note-${chatFixture.notes.size + 1}`, scope: params.scope, project_id: params.project_id, title: params.title ?? "", body: params.body ?? "", preview: String(params.body ?? "").slice(0, 240), checklist: { done: 0, total: 0 }, pinned: !!params.project_role, revision: 1, created_at: at, updated_at: at, project_role: params.project_role ?? null }
    chatFixture.notes.set(note.id, note)
    return note
  }
  if (method === "notes.update") {
    const current = chatFixture.notes.get(params.id)
    if (!current) throw new Error("Missing note")
    const note: Note = { ...current, body: params.body ?? current.body, preview: String(params.body ?? current.body).slice(0, 240), revision: current.revision + 1 }
    chatFixture.notes.set(note.id, note)
    return note
  }
  if (method === "skills.list") return { skills: [] }
  if (method === "providers.list") return { providers: state.providers }
  if (method === "queue.list") return { messages: [] }
  throw new Error(`Unexpected chat fixture RPC: ${method}`)
}
