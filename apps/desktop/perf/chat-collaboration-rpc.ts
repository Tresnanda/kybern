/* eslint-disable @typescript-eslint/no-explicit-any */
import { useStore } from "../src/state/store"
import { emptyThreadState } from "../src/state/transcript"
import type { CollaborationAssignment, ContextEntry, Thread, ThreadEvent, UserMessage } from "../src/protocol"

export * from "../src/state/rpc"
const listeners = new Set<(event: ThreadEvent | null) => void>()
export const chatFixture = { calls: [] as { method: string; params: any }[], sent: [] as { threadId: string; message: UserMessage; messageId?: string }[], coordinatorCreates: 0, setupComplete: false, deleteError: false, completeSetup() { this.setupComplete = true; listeners.forEach((listener) => listener(null)) } }
const coordinators = new Map<string, any>()
const at = "2026-09-14T10:00:00Z"
const coordinatorPlan: ContextEntry = { id: "coordinator-plan", group_id: "coordinator-group", key: "current-plan", kind: "plan", body: "Confirm the local workflow, delegate the desktop and mobile changes, then review both results.", author_thread_id: "project-coordinator", user_authored: false, revision: 2, source_refs: [], created_at: at, updated_at: at }
const coordinatorFinding: ContextEntry = { id: "coordinator-finding", group_id: "coordinator-group", key: "native-review", kind: "research", body: "The draft stays inert until Send, and the coordinator reopens with its project knowledge intact.", author_thread_id: "project-coordinator", user_authored: false, revision: 1, source_refs: [], created_at: at, updated_at: at }
const coordinatorResult: CollaborationAssignment = { id: "coordinator-result", group_id: "coordinator-group", owner_thread_id: "project-coordinator", created_by_thread_id: "project-coordinator", title: "Review coordinator integration", instructions: "Verify the desktop and mobile coordinator flows.", kind: "review", status: "completed", depth: 1, revision: 2, created_at: at, updated_at: at, result: { outcome: "success", summary: "Verified the inert draft, harness switching, project plan, and returned work across desktop and mobile.", changes: ["Desktop and mobile coordinator UX"], checks: ["Native WebKit fixture", "Mobile typecheck"], artifacts: [], unresolved: [], completed_at: at } }
const connection = { call }
const runtime = { rpc, loadThread }
export function rpc() { return connection }
export function activeRuntime() { return runtime }
export function subscribeCollaboration(listener: (event: ThreadEvent | null) => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
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
  if (method === "threads.search") {
    const query = String(params.query ?? "").toLowerCase()
    return { threads: Object.values(state.threads).filter((thread) => (params.all_projects || !params.project_id || params.project_id === thread.project_id) && (params.include_archived || thread.status !== "archived") && (!query || thread.title.toLowerCase().includes(query))).slice(0, params.limit ?? 12).map((thread) => ({ thread })), next_cursor: null }
  }
  if (method === "collaboration.coordinator.get") return coordinators.get(params.project_id) ?? null
  if (method === "collaboration.coordinator.get_or_create") {
    const existing = coordinators.get(params.project_id)
    if (existing) return { ...existing, created: false }
    const thread: Thread = { id: chatFixture.coordinatorCreates ? `project-coordinator-${chatFixture.coordinatorCreates + 1}` : "project-coordinator", project_id: params.project_id, coordinator_project_id: params.project_id, collaboration_group_id: "coordinator-group", title: "Project coordinator", provider: params.provider, model: params.model ?? null, effort: params.effort ?? null, permission_mode: params.permission_mode ?? "supervised", status: "idle", cwd: "/project", pinned: true, created_at: at, updated_at: at, last_seq: 0 }
    const result = { thread, group: groupFor(thread), created: true }
    coordinators.set(params.project_id, result); chatFixture.coordinatorCreates += 1
    return result
  }
  if (method === "collaboration.coordinator.delete") {
    if (chatFixture.deleteError) throw new Error("Stop agents before deleting the coordinator; unfinished assignments remain.")
    const current = coordinators.get(params.project_id)
    if (!current || current.thread.id !== params.thread_id) throw new Error("coordinator changed")
    coordinators.delete(params.project_id)
    chatFixture.setupComplete = false
    return { ...state.threads[params.thread_id], status: "archived", coordinator_project_id: null }
  }
  if (method === "collaboration.coordinator.switch_harness") {
    const current = coordinators.get(params.project_id)
    if (!current) throw new Error("Open the project coordinator before changing its harness.")
    const thread = { ...current.thread, provider: params.provider, model: params.model ?? null, effort: params.effort ?? null, permission_mode: params.permission_mode ?? current.thread.permission_mode }
    const result = { ...current, thread, created: false }
    coordinators.set(params.project_id, result)
    return result
  }
  if (method === "threads.send") {
    recordSent(params.thread_id, params.message, params.message_id)
    return { turn_id: "coordinator-turn", message_id: params.message_id }
  }
  if (method === "collaboration.groups.list") return { groups: [...coordinators.values()].map((item) => item.group), next_cursor: null }
  if (method === "collaboration.groups.get") {
    const main = Object.values(state.threads).find((thread) => thread.collaboration_group_id === params.group_id && !thread.parent_thread_id)!
    const assignments = params.group_id === "coordinator-group" ? [coordinatorResult] : []
    return { coordinator_setup_complete: main.coordinator_project_id ? chatFixture.setupComplete : undefined, group: groupFor(main), members: Object.values(state.threads).filter((thread) => thread.collaboration_group_id === params.group_id).map((thread) => ({ group_id: params.group_id, thread_id: thread.id, role: thread.parent_thread_id ? "worker" : "coordinator", active: true, joined_at: at })), assignments, pending_messages: [] }
  }
  if (method === "collaboration.assignments.list") return { assignments: params.group_id === "coordinator-group" ? [coordinatorResult] : [], next_cursor: null }
  if (method === "collaboration.messages.list") return { messages: [], next_cursor: null }
  if (method === "collaboration.context.list") return { entries: params.group_id === "coordinator-group" ? [coordinatorPlan, coordinatorFinding] : [], next_cursor: null }
  if (method === "collaboration.context.history") return { entry_id: params.entry_id, revisions: params.entry_id === coordinatorPlan.id ? [coordinatorPlan] : [coordinatorFinding], next_before_revision: null }
  if (method === "skills.list") return { skills: [] }
  if (method === "providers.list") return { providers: state.providers }
  if (method === "queue.list") return { messages: [] }
  throw new Error(`Unexpected chat fixture RPC: ${method}`)
}
function groupFor(thread: Thread) {
  return { id: thread.collaboration_group_id, project_id: thread.project_id, coordinator_thread_id: thread.id, objective: "Help with this project", success_criteria: [], status: "active", coordinator_mode: thread.coordinator_project_id ? "dedicated" : "ordinary", policy: { allowed_providers: [], max_active_workers: 4, max_depth: 2, max_pending_messages: 64, max_wakeups_per_assignment: 16, require_worktree_for_editing: true }, revision: 1, created_at: at, updated_at: at }
}
