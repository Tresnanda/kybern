/* eslint-disable @typescript-eslint/no-explicit-any */
import { useStore } from "../src/state/store"
import { emptyThreadState } from "../src/state/transcript"
import type { Thread, UserMessage } from "../src/protocol"

export * from "../src/state/rpc"
export const chatFixture = { calls: [] as { method: string; params: any }[], sent: [] as { threadId: string; message: UserMessage; messageId?: string }[], coordinatorCreates: 0 }
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
  if (method === "skills.list") return { skills: [] }
  if (method === "providers.list") return { providers: state.providers }
  if (method === "queue.list") return { messages: [] }
  throw new Error(`Unexpected chat fixture RPC: ${method}`)
}
