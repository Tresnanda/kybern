/* eslint-disable @typescript-eslint/no-explicit-any */
import type { CollaborationAssignment, CollaborationGroup, CollaborationMessage, ContextEntry, Thread, ThreadEvent } from "../src/protocol"
import { collaborationReplay, readReplay } from "./collaboration-replay"

const at = "2026-09-13T08:00:00Z"
let group: CollaborationGroup | null = null
let status: CollaborationGroup["status"] = "active"
let pagedDiscoveryPending = false
const listeners = new Set<(event: ThreadEvent | null) => void>()
export const collaborationFixtureState = { releases: 0, childBaseValid: false, progressRequestValid: false, discoveryCalls: 0, failNextMutation: false, failNextHistory: false, failNextAssignment: false, groupCreates: 0, lastMessageGroup: "", assignmentRequests: [] as Record<string, unknown>[], contextRequests: [] as Record<string, unknown>[] }
export function refreshCollaborationFixture(serverObjective?: string) {
  if (group && serverObjective) group = { ...group, objective: serverObjective, revision: group.revision + 1 }
  listeners.forEach((listener) => listener(null))
}
export function emitThreadMetadataUpdates(thread: Thread, count = 20) {
  for (let index = 0; index < count; index += 1) {
    listeners.forEach((listener) => listener({ seq: index + 1, thread_id: thread.id, at, kind: "thread_updated", thread: { ...thread, updated_at: at } } as ThreadEvent))
  }
}
const context: ContextEntry = { id: "context-current", group_id: "group-1", key: "release-checks", kind: "instruction", body: "Run desktop and mobile checks before handoff.", user_authored: true, author_thread_id: null, revision: 3, source_refs: [], created_at: at, updated_at: at }
const observation: ContextEntry = { ...context, id: "context-observation", key: "webkit-finding", kind: "research", body: "The collaboration dock remains readable at 420 points.", user_authored: false, author_thread_id: "thread-worker", revision: 1 }
const resultReference: ContextEntry = { ...context, id: "context-result-reference", key: "learned-test-command", kind: "result_reference", body: "Run node scripts/check-rendering.mjs collaboration from apps/desktop.", user_authored: false, author_thread_id: "thread-main", revision: 2 }
const longResultSummary = `Lifecycle works; ${"the coordinator retained assignment identity, review state, and readable result metadata across a deliberately long native WebKit summary. ".repeat(6)}END-OF-FULL-RESULT`
const assignments: CollaborationAssignment[] = [
  { id: "assignment-queued", group_id: "group-1", created_by_thread_id: "thread-main", title: "Queue accessibility check", instructions: "Wait for a helper slot, then verify keyboard navigation.", kind: "review", status: "pending", depth: 1, revision: 1, created_at: at, updated_at: at },
  { id: "assignment-running", group_id: "group-1", owner_thread_id: "thread-worker", created_by_thread_id: "thread-main", title: "Implement client flow", instructions: "Build desktop and mobile collaboration controls.", kind: "edit", status: "working", base_revision: "main", depth: 1, revision: 2, created_at: at, updated_at: at },
  { id: "assignment-attention", group_id: "group-1", owner_thread_id: "thread-reviewer", created_by_thread_id: "thread-main", title: "Resolve helper question", instructions: "Confirm the expected retry behavior.", uncertainty: "The helper needs a decision before continuing.", kind: "review", status: "attention_needed", depth: 1, revision: 2, created_at: at, updated_at: at },
  { id: "assignment-blocked", group_id: "group-1", owner_thread_id: "thread-reviewer", created_by_thread_id: "thread-main", title: "Wait for dependency", instructions: "Resume after the dependency lands.", uncertainty: "Blocked on an external dependency.", kind: "integration", status: "blocked", depth: 1, revision: 2, created_at: at, updated_at: at },
  { id: "assignment-result", group_id: "group-1", owner_thread_id: "thread-reviewer", created_by_thread_id: "thread-main", title: "Review integration", instructions: "Review lifecycle and recovery.", kind: "review", status: "completed", depth: 1, revision: 3, created_at: at, updated_at: at, result: { outcome: "partial", summary: longResultSummary, changes: ["apps/desktop/src/views/Collaboration.tsx"], checks: ["Desktop collaboration fixture"], artifacts: ["artifacts/collaboration-redesign/desktop-work.png"], unresolved: ["Physical device reconnect"], completed_at: at } },
  { id: "assignment-failed", group_id: "group-1", owner_thread_id: "thread-reviewer", created_by_thread_id: "thread-main", title: "Run unavailable check", instructions: "Run the unavailable integration check.", kind: "review", status: "failed", depth: 1, revision: 3, created_at: at, updated_at: at, result: { outcome: "failed", summary: "The integration service was unavailable.", changes: [], checks: ["Integration check failed"], artifacts: [], unresolved: ["Retry when the service returns"], completed_at: at } },
]
const completedAssignment = assignments.find((assignment) => assignment.id === "assignment-result")!
const olderAssignment: CollaborationAssignment = { ...completedAssignment, id: "assignment-old", title: "Research coordination", result: { ...completedAssignment.result!, outcome: "success", summary: "Compared coordinator behavior." } }
const messages: CollaborationMessage[] = [{ id: "message-1", operation_id: "operation-1", group_id: "group-1", assignment_id: "assignment-running", from_thread_id: "thread-worker", to_thread_id: "thread-main", purpose: "question", body: `Should the correction replace the old instruction? ${"This deliberately long collaboration message verifies that compact previews remain readable in native WebKit while the complete question stays available on demand. ".repeat(5)}END-OF-FULL-MESSAGE`, state: "submitted", delivery_turn_id: "turn-1", wakeup_count: 1, created_at: at, updated_at: at }]

export function rpc() {
  return { call }
}
const fixtureRuntime = { rpc }
export function activeRuntime() { return fixtureRuntime }
async function call(method: string, params: Record<string, unknown>): Promise<any> {
  if (collaborationReplay) return readReplay(method, params)
  if (collaborationFixtureState.failNextMutation && /\.(create|update|put|send|attach|cancel|control)$/.test(method)) {
    collaborationFixtureState.failNextMutation = false
    throw new Error("Connection lost. Reconnect and try again.")
  }
  if (method === "git.status") return { is_git: true, branch: "worktrees/fixture", dirty_files: 3, ahead: 0, behind: 0 }
  if (method === "threads.release") { collaborationFixtureState.releases += 1; return {} }
  if (method === "collaboration.groups.list") {
    collaborationFixtureState.discoveryCalls += 1
    if (!group) return { groups: [], next_cursor: null }
    if (pagedDiscoveryPending && !params.cursor) return { groups: [{ ...group, id: "group-previous", status: "completed" }], next_cursor: "groups-2" }
    if (pagedDiscoveryPending && params.cursor) pagedDiscoveryPending = false
    return { groups: [{ ...group, status }, { ...group, id: "group-previous", status: "completed" }], next_cursor: null }
  }
  if (method === "collaboration.groups.create") { collaborationFixtureState.groupCreates += 1; group = { id: "group-1", project_id: "project-1", coordinator_thread_id: "thread-main", objective: String(params.objective), success_criteria: (params.success_criteria as string[]) ?? [], status: "active", coordinator_mode: (params.coordinator_mode as CollaborationGroup["coordinator_mode"]) ?? "ordinary", policy: (params.policy as CollaborationGroup["policy"]) ?? { max_active_workers: 4, max_depth: 2, max_pending_messages: 64, max_wakeups_per_assignment: 16, allowed_providers: [], require_worktree_for_editing: true }, revision: 1, created_at: at, updated_at: at }; pagedDiscoveryPending = true; return group }
  if (method === "collaboration.groups.get") { const groupId = String(params.group_id); return { group: { ...group!, id: groupId, status: groupId === "group-previous" ? "completed" : status }, members: [{ group_id: groupId, thread_id: "thread-main", role: "coordinator", active: true, joined_at: at }, { group_id: groupId, thread_id: "thread-worker", role: "worker", active: true, joined_at: at }, { group_id: groupId, thread_id: "thread-reviewer", role: "reviewer", active: true, joined_at: at }], assignments, pending_messages: messages } }
  if (method === "collaboration.assignments.list") return params.cursor ? { assignments: [olderAssignment], next_cursor: null } : Number(params.limit) > 50 ? { assignments: [...assignments, olderAssignment], next_cursor: null } : { assignments, next_cursor: "assignments-2" }
  if (method === "collaboration.messages.list") { collaborationFixtureState.lastMessageGroup = String(params.group_id); const older = { ...messages[0], id: "message-old", purpose: "progress", body: "Initial investigation finished." }; return params.cursor ? { messages: [older], next_cursor: null } : Number(params.limit) > 50 ? { messages: [...messages, older], next_cursor: null } : { messages, next_cursor: "messages-2" } }
  if (method === "collaboration.context.list") return params.cursor ? { entries: [observation, resultReference], next_cursor: null } : Number(params.limit) > 50 ? { entries: [context, observation, resultReference], next_cursor: null } : { entries: [context], next_cursor: "context-2" }
  if (method === "collaboration.context.history") {
    if (collaborationFixtureState.failNextHistory) {
      collaborationFixtureState.failNextHistory = false
      throw new Error("History service unavailable.")
    }
    return params.before_revision ? { entry_id: context.id, revisions: [{ ...context, revision: 1, body: "Run desktop checks." }], next_before_revision: null } : { entry_id: context.id, revisions: [{ ...context }, { ...context, revision: 2, body: "Run desktop and mobile checks." }], next_before_revision: 2 }
  }
  if (method === "collaboration.groups.control") { status = params.action === "pause" ? "paused" : params.action === "stop" ? "stopped" : params.action === "complete" ? "completed" : "active"; group = { ...group!, status, revision: group!.revision + 1 }; return group }
  if (method === "collaboration.groups.update") {
    if (params.expected_revision !== group!.revision) throw new Error("Group changed. Reload it before saving.")
    group = { ...group!, objective: String(params.objective ?? group!.objective), success_criteria: (params.success_criteria as string[]) ?? group!.success_criteria, coordinator_mode: (params.coordinator_mode as CollaborationGroup["coordinator_mode"]) ?? group!.coordinator_mode, policy: (params.policy as CollaborationGroup["policy"]) ?? group!.policy, revision: group!.revision + 1 }; return group
  }
  if (method === "collaboration.context.put") {
    collaborationFixtureState.contextRequests.push(structuredClone(params))
    const target = params.entry_id === resultReference.id ? resultReference : context
    if (params.entry_id && params.expected_revision !== target.revision) throw new Error("Context changed. Reload it before saving.")
    target.body = String(params.body); target.revision += 1; target.user_authored = Boolean(params.user_authored); return target
  }
  if (method === "collaboration.assignments.cancel") return { ...assignments[0], status: "cancelled" }
  if (method === "collaboration.assignments.create") {
    collaborationFixtureState.assignmentRequests.push(structuredClone(params))
    if (collaborationFixtureState.failNextAssignment) {
      collaborationFixtureState.failNextAssignment = false
      refreshCollaborationFixture()
      await new Promise((resolve) => setTimeout(resolve, 250))
      throw new Error("Couldn’t start the agent. Your task is saved here. Try again.")
    }
    const child = params.child as { base_revision?: string } | undefined
    if (child && !child.base_revision?.trim()) throw new Error("fixture rejected child without explicit base_revision")
    collaborationFixtureState.childBaseValid = !!child?.base_revision
    return { id: "assignment-started", group_id: params.group_id, title: params.title, instructions: params.instructions, kind: params.kind, status: "pending", depth: 1, revision: 1, created_at: at, updated_at: at }
  }
  if (method === "collaboration.messages.send") {
    if (params.from_thread_id != null) throw new Error("fixture rejected public from_thread_id impersonation")
    if (params.purpose !== "progress" || params.assignment_id != null) throw new Error("fixture rejected uncorrelated waking message")
    collaborationFixtureState.progressRequestValid = true
    messages.push({ id: `message-${messages.length + 1}`, operation_id: String(params.operation_id), group_id: String(params.group_id), from_thread_id: null, to_thread_id: String(params.to_thread_id), purpose: "progress", body: String(params.body), state: "submitted", delivery_turn_id: null, wakeup_count: 0, created_at: at, updated_at: at })
    return {}
  }
  if (method === "collaboration.members.attach") return {}
  throw new Error(`Unexpected collaboration fixture RPC: ${method}`)
}
export function subscribeCollaboration(listener: (event: ThreadEvent | null) => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
export function errorText(error: unknown) { return error instanceof Error ? error.message : String(error) }
