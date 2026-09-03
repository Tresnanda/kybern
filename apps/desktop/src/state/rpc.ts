// Owns the daemon connection: boots the client, subscribes to every thread's
// events, folds them into the store, and exposes typed actions for the views.

import { toast } from "sonner"
import { reloadOnHotUpdate } from "@/lib/hot"

import { isWindowFocused, notify, resolveEndpoint } from "@/lib/tauri"
import {
  KybernClient,
  type ApprovalDecision,
  type ApprovalId,
  type Diff,
  type PermissionMode,
  type ProjectId,
  type ProviderKind,
  type ProviderInstance,
  type SkillInfo,
  type ThreadEvent,
  type ThreadId,
  type TurnId,
  type UserMessage,
} from "@/protocol"

import { applyEvent, seedFromGet } from "./transcript"
import { diffKey, useStore } from "./store"

let client: KybernClient | null = null
let httpBase = ""
let token = ""
const diffLoads = new Map<string, Promise<void>>()

export function rpc(): KybernClient {
  if (!client) throw new Error("Not connected")
  return client
}

export async function boot(): Promise<void> {
  const store = useStore.getState()
  store.set({ connection: { state: "connecting" } })
  let ep
  try {
    ep = await resolveEndpoint()
  } catch (e) {
    store.set({ connection: { state: "failed", detail: e instanceof Error ? e.message : String(e) } })
    return
  }
  httpBase = ep.http_base
  token = ep.token
  client = new KybernClient({ url: ep.url, token: ep.token })
  client.onStatus((status, detail) => {
    const s = useStore.getState()
    if (status === "open") {
      s.set({ connection: { state: "open" } })
      void loadAll()
    } else if (status === "reconnecting") {
      s.set({ connection: { state: "reconnecting", detail } })
    } else if (status === "closed") {
      s.set({ connection: { state: "failed", detail: detail ?? "Connection closed" } })
    }
  })
  client.subscribeEvents({}, onEvent, () => void loadAll())
  client.connect()
}

async function loadAll(): Promise<void> {
  const c = rpc()
  const s = useStore.getState()
  try {
    const [info, providers, projects, threads, settings] = await Promise.all([
      c.call("daemon.info", {}),
      c.call("providers.list", {}),
      c.call("projects.list", {}),
      c.call("threads.list", {}),
      c.call("settings.get", {}),
    ])
    s.set({
      info,
      providers: providers.providers,
      settings,
      projects: Object.fromEntries(projects.projects.map((p) => [p.id, p])),
      threads: Object.fromEntries(threads.threads.map((t) => [t.id, t])),
    })
    const sel = useStore.getState().selected
    if (sel.kind === "thread") void loadThread(sel.id)
    else if (sel.kind === "none") {
      const first = projects.projects[0]
      if (first) useStore.getState().selectDraft(first.id)
    }
  } catch (e) {
    toast.error("Unable to load workspace", { description: errorText(e) })
  }
}

export async function loadThread(id: ThreadId): Promise<void> {
  const res = await rpc().call("threads.get", { thread_id: id })
  useStore.getState().updateTranscript(id, (prev) => seedFromGet(res, prev))
  void loadCheckpoints(id)
}

async function loadCheckpoints(id: ThreadId) {
  try {
    const r = await rpc().call("threads.checkpoints", { thread_id: id })
    useStore.getState().updateTranscript(id, (t) => ({ ...t, checkpoints: r.checkpoints }))
    const have = useStore.getState().diffs
    for (const c of r.checkpoints) {
      if (c.after && !have[diffKey(id, c.turn_id)]) void loadDiff(id, c.turn_id)
    }
  } catch {
    // non-git projects have none
  }
}

function onEvent(ev: ThreadEvent) {
  const s = useStore.getState()
  if (ev.kind === "thread_created") {
    s.set((st) => ({ threads: { ...st.threads, [ev.thread.id]: ev.thread } }))
  }
  s.updateTranscript(ev.thread_id, (t) => applyEvent(t, ev))

  if (ev.kind === "turn_completed" || ev.kind === "turn_failed") {
    void loadDiff(ev.thread_id, ev.turn_id ?? undefined)
    void loadDiff(ev.thread_id)
    void announce(ev)
    void flushQueue(ev.thread_id)
  }
  if (ev.kind === "approval_requested") void announce(ev)
}

async function announce(ev: ThreadEvent) {
  const st = useStore.getState()
  if (st.settings && !st.settings.notifications) return
  const focused = await isWindowFocused()
  const viewing = st.selected.kind === "thread" && st.selected.id === ev.thread_id
  if (focused && viewing) return
  const title = st.threads[ev.thread_id]?.title ?? "Thread"
  if (ev.kind === "approval_requested") await notify(title, `Needs approval: ${ev.approval.summary}`)
  else if (ev.kind === "turn_completed") await notify(title, ev.stop_reason === "completed" ? "Finished working" : `Stopped: ${ev.stop_reason}`)
  else if (ev.kind === "turn_failed") await notify(title, `Failed: ${ev.error}`)
}

export function loadDiff(threadId: ThreadId, turnId?: TurnId): Promise<void> {
  const includePatch = !!turnId
  const requestKey = `${diffKey(threadId, turnId)}:${includePatch ? "patch" : "stat"}`
  const pending = diffLoads.get(requestKey)
  if (pending) return pending

  const request = (async () => {
    try {
      const d = await rpc().call("threads.diff", {
        thread_id: threadId,
        ...(turnId ? { turn_id: turnId } : {}),
        include_patch: includePatch,
      })
      useStore.getState().set((s) => ({ diffs: { ...s.diffs, [diffKey(threadId, turnId)]: d } }))
    } catch {
      // no git, no diff
    } finally {
      diffLoads.delete(requestKey)
    }
  })()
  diffLoads.set(requestKey, request)
  return request
}

export function loadFileDiff(threadId: ThreadId, path: string, turnId?: TurnId): Promise<Diff> {
  return rpc().call("threads.diff", {
    thread_id: threadId,
    ...(turnId ? { turn_id: turnId } : {}),
    include_patch: true,
    path,
  })
}

// ---- actions ----

export async function createThread(opts: {
  projectId: ProjectId
  provider: ProviderInstance
  permissionMode: PermissionMode
  model?: string
  effort?: string
  useWorktree?: boolean
  baseBranch?: string
  message?: UserMessage
}): Promise<ThreadId> {
  const t = await rpc().call("threads.create", {
    project_id: opts.projectId,
    provider: opts.provider,
    permission_mode: opts.permissionMode,
    model: opts.model,
    effort: opts.effort,
    use_worktree: opts.useWorktree,
    base_branch: opts.baseBranch,
    message: opts.message,
  })
  const s = useStore.getState()
  s.set((st) => ({ threads: { ...st.threads, [t.id]: t } }))
  s.selectThread(t.id)
  void loadThread(t.id)
  return t.id
}

export async function sendMessage(threadId: ThreadId, message: UserMessage): Promise<void> {
  await rpc().call("threads.send", { thread_id: threadId, message })
}

/** Send the next queued message once the running turn has ended. */
async function flushQueue(threadId: ThreadId): Promise<void> {
  const s = useStore.getState()
  const next = (s.queued[threadId] ?? [])[0]
  if (!next) return
  s.dequeue(threadId, next.id)
  try {
    await sendMessage(threadId, next.message)
  } catch (e) {
    toast.error("Unable to send queued message", { description: errorText(e) })
  }
}

export async function searchFiles(projectId: ProjectId, query: string, limit = 30): Promise<string[]> {
  const r = await rpc().call("files.search", { project_id: projectId, query, limit })
  return r.files
}

export async function listSkills(projectId: ProjectId, provider: ProviderKind): Promise<SkillInfo[]> {
  const result = await rpc().call("skills.list", { project_id: projectId, provider })
  return result.skills
}

/** Start a new thread with another agent, seeded with the conversation so far. */
export async function handOff(threadId: ThreadId, provider: ProviderInstance, model?: string): Promise<ThreadId> {
  const s = useStore.getState()
  const thread = s.threads[threadId]
  if (!thread) throw new Error("Thread not found")
  const t = s.transcripts[threadId]
  const lines: string[] = []
  for (const b of t?.blocks ?? []) {
    if (b.kind === "user") {
      const text = b.message.parts
        .map((p) => (p.type === "text" ? p.text : p.type === "file_mention" ? `@${p.path}` : p.type === "skill" ? `$${p.name}` : `[${p.type}]`))
        .join("")
      lines.push(`User:\n${text}`)
    } else if (b.kind === "assistant" && b.text.trim()) {
      lines.push(`Assistant:\n${b.text.trim()}`)
    } else if (b.kind === "tool") {
      const detail = typeof b.call.input === "object" && b.call.input ? JSON.stringify(b.call.input).slice(0, 200) : ""
      lines.push(`Tool ${b.call.name}: ${detail}`)
    }
  }
  const seed = [
    "You are taking over a coding session that another agent started in this repository. Continue from where it left off.",
    "Do not redo completed work. Read the transcript, then ask what to do next if the last request is already done.",
    "",
    "Transcript so far:",
    "",
    lines.join("\n\n"),
  ].join("\n")
  return createThread({
    projectId: thread.project_id,
    provider,
    permissionMode: thread.permission_mode,
    model,
    message: { parts: [{ type: "text", text: seed }] },
  })
}

export async function interrupt(threadId: ThreadId): Promise<void> {
  await rpc().call("threads.interrupt", { thread_id: threadId })
}

export async function respondApproval(id: ApprovalId, decision: ApprovalDecision): Promise<void> {
  await rpc().call("approvals.respond", { approval_id: id, ...decision })
}

export async function updateThread(threadId: ThreadId, patch: { title?: string; pinned?: boolean; permission_mode?: PermissionMode; model?: string; effort?: string }) {
  const t = await rpc().call("threads.update", { thread_id: threadId, ...patch })
  useStore.getState().set((st) => ({ threads: { ...st.threads, [t.id]: t } }))
}

export async function archiveThread(threadId: ThreadId) {
  await rpc().call("threads.archive", { thread_id: threadId })
  const s = useStore.getState()
  s.set((st) => {
    const threads = { ...st.threads }
    const t = threads[threadId]
    if (t) threads[threadId] = { ...t, status: "archived" }
    const selected = st.selected.kind === "thread" && st.selected.id === threadId ? ({ kind: "none" } as const) : st.selected
    return { threads, selected }
  })
}

export async function revertTo(threadId: ThreadId, turnId: TurnId) {
  const r = await rpc().call("threads.revert", { thread_id: threadId, turn_id: turnId })
  void loadThread(threadId)
  void loadDiff(threadId)
  return r
}

export async function addProject(path: string, name?: string) {
  const p = await rpc().call("projects.add", { path, name })
  useStore.getState().set((st) => ({ projects: { ...st.projects, [p.id]: p } }))
  return p
}

export async function removeProject(projectId: ProjectId) {
  await rpc().call("projects.remove", { project_id: projectId })
  useStore.getState().set((st) => {
    const projects = { ...st.projects }
    delete projects[projectId]
    return { projects }
  })
}

export async function uploadFile(file: File): Promise<{ id: string; name: string; media_type: string; size: number }> {
  try {
    const response = await fetch(`${httpBase}/assets`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": file.type || "application/octet-stream", "x-kybern-filename": file.name },
      body: file,
    })
    if (!response.ok) {
      const detail = (await response.text()).trim()
      throw new Error(detail || `Upload failed (${response.status})`)
    }
    return response.json()
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error("Kybern couldn’t reach the attachment service. Restart Kybern, then try again.", { cause: error })
    }
    throw error
  }
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// Stateful module: a hot update would drop the live connection, so reload instead.
reloadOnHotUpdate(import.meta.hot)
