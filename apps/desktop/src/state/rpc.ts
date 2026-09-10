import { writeProviderCache } from "./providerCache"
// Owns the daemon connection: boots the client, subscribes to every thread's
// events, folds them into the store, and exposes typed actions for the views.

import { toast } from "sonner"
import { reloadOnHotUpdate } from "@/lib/hot"

import { isWindowFocused, notify, type EndpointInfo } from "@/lib/tauri"
import { diffSummaryRequest } from "@/lib/workload"
import {
  codes,
  KybernClient,
  ConnectionClosedError,
  RpcCallError,
  type ApprovalDecision,
  type ApprovalId,
  type Diff,
  type GitStatus,
  type PermissionMode,
  type ProjectId,
  type ProviderKind,
  type ProviderInstance,
  type ProviderStatus,
  type RuntimeTask,
  type SkillInfo,
  type ThreadEvent,
  type ThreadId,
  type TurnId,
  type UserMessage,
} from "@/protocol"

import { applyEvent, compactThreadState, seedFromGet, prependThreadHistory } from "./transcript"
import { createSnapshotReplay } from "./snapshotReplay"
import { mergeSequencedSnapshot } from "./bootstrap"
import { collectSplitThreadIds } from "./splitView"
import {
  diffKey,
  isThreadVisible,
  isRuntimeTaskActive,
  mergeRuntimeTasks,
  summarizeRuntimeTasks,
  type EnvironmentStore,
} from "./store"

export function createEnvironmentRuntime(useStore: EnvironmentStore) {
  let client: KybernClient | null = null
  let httpBase = ""
  let token = ""
  const diffLoads = new Map<string, Promise<void>>()
  const fileDiffLoads = new Map<string, Promise<Diff>>()
  const gitStatusLoads = new Map<ThreadId, Promise<GitStatus | null>>()
  const threadLoads = new Map<ThreadId, Promise<void>>()
  const historyLoads = new Map<ThreadId, { promise: Promise<void>; buffer: ReturnType<typeof createSnapshotReplay> }>()
  const providerLoads = new Map<string, Promise<ProviderStatus[]>>()
  const snapshots = new Map<ThreadId, ReturnType<typeof createSnapshotReplay>>()
  let disposed = false
  let hydrationGeneration = 0
  let canReuseSnapshots = false
  const reusableSnapshots = new Set<ThreadId>()
  const uploads = new AbortController()

  function rpc(): KybernClient {
    if (!client) throw new ConnectionClosedError("Not connected")
    return client
  }

  function connect(ep: EndpointInfo): void {
    const store = useStore.getState()
    store.set({ connection: { state: "connecting" } })
    httpBase = ep.http_base
    token = ep.token
    client = new KybernClient(
      { url: ep.url, token: ep.token },
      { expectedEnvironmentId: useStore.getState().environmentId }
    )
    client.onStatus((status, detail) => {
      const s = useStore.getState()
      if (status !== "open") {
        canReuseSnapshots = false
        hydrationGeneration++
      }
      if (status === "open") {
        s.set({ connection: { state: "open" }, info: client?.info ?? null })
      } else if (status === "reconnecting") {
        s.set({ connection: { state: "reconnecting", detail } })
      } else if (status === "closed" || status === "failed") {
        s.set({
          connection: {
            state: "failed",
            detail: detail ?? "Connection closed",
          },
        })
      }
    })
    client.subscribeEvents({}, onEvent, (_headSeq, replay) => {
      const generation = ++hydrationGeneration
      if (replay.resumed && replay.supported) {
        canReuseSnapshots = false
        return
      }
      // Old daemons and fresh subscriptions need authoritative snapshots.
      reusableSnapshots.clear()
      canReuseSnapshots = true
      void loadWorkspace(generation)
    }, (_headSeq, resumed) => {
      if (!resumed || disposed) return
      canReuseSnapshots = true
      void loadWorkspace(++hydrationGeneration)
    })
    client.connect()
  }

  async function loadWorkspace(generation: number): Promise<void> {
    const c = rpc()
    void loadProviderCatalog(undefined, false, generation).catch((error) => {
      if (isCurrentHydration(generation)) {
        toast.error("Unable to load coding agents", {
          id: "provider-catalog-load",
          description: errorText(error),
        })
      }
    })

    try {
      void loadQueue()
      const [info, projects, threads, settings] = await Promise.all([
        c.call("daemon.info", {}),
        c.call("projects.list", {}),
        c.call("threads.list", {}),
        c.call("settings.get", {}),
      ])
      if (!isCurrentHydration(generation)) return

      useStore.getState().set((state) => {
        const mergedThreads = mergeSequencedSnapshot(
          state.threads,
          threads.threads
        )
        const incomingThreads = new Map(
          threads.threads.map((thread) => [thread.id, thread])
        )
        const incomingActivity = Object.fromEntries(
          (threads.activity ?? []).map((summary) => [
            summary.thread_id,
            summary,
          ])
        )
        const threadActivity = { ...incomingActivity }
        for (const [threadId, current] of Object.entries(
          state.threadActivity
        )) {
          const currentThread = state.threads[threadId as ThreadId]
          const incomingThread = incomingThreads.get(threadId as ThreadId)
          if (
            !incomingThread ||
            (currentThread && currentThread.last_seq > incomingThread.last_seq)
          ) {
            threadActivity[threadId as ThreadId] = current
          }
        }
        return {
          info,
          settings,
          projects: Object.fromEntries(projects.projects.map((p) => [p.id, p])),
          threads: mergedThreads,
          threadActivity,
        }
      })
      const activeThreadIds = Object.values(useStore.getState().threads)
        .filter((thread) => thread.status !== "archived")
        .map((thread) => thread.id)
      useStore.getState().reconcileSplitThreads(activeThreadIds)

      const hydrated = useStore.getState()
      if (
        (hydrated.selected.kind === "draft" &&
          !hydrated.projects[hydrated.selected.draft.projectId]) ||
        (hydrated.selected.kind === "thread" &&
          !hydrated.threads[hydrated.selected.id])
      ) {
        hydrated.set({ selected: { kind: "none" } })
      }
      const next = useStore.getState()
      const visibleThreadIds = new Set(collectSplitThreadIds(next.splitView))
      if (next.selected.kind === "thread")
        visibleThreadIds.add(next.selected.id)
      for (const threadId of visibleThreadIds) void loadThread(threadId)

      if (visibleThreadIds.size === 0 && next.selected.kind === "none") {
        const first = projects.projects[0]
        if (first) useStore.getState().selectDraft(first.id)
      }
    } catch (e) {
      if (isCurrentHydration(generation)) {
        toast.error("Unable to load workspace", { description: errorText(e) })
      }
    }
  }

  function isCurrentHydration(generation: number): boolean {
    return !disposed && generation === hydrationGeneration && client?.status === "open"
  }

  function loadThread(id: ThreadId, force = false): Promise<void> {
    const pending = threadLoads.get(id)
    if (pending) return pending
    if (!force && canReuseSnapshots && reusableSnapshots.has(id) && useStore.getState().transcripts[id]?.loaded)
      return Promise.resolve()

    historyLoads.delete(id)
    const request = (async () => {
      try {
        const generation = hydrationGeneration
        const requested = Math.max(60, useStore.getState().transcripts[id]?.blocks.length ?? 0)
        let res: Awaited<ReturnType<typeof getSnapshot>> | undefined
        async function getSnapshot() {
          return rpc().call("threads.get", { thread_id: id, ...(requested <= 500 ? { transcript_limit: requested } : {}) })
        }
        let events: ThreadEvent[] | null = null
        for (let attempt = 0; attempt < 3; attempt++) {
          const buffer = createSnapshotReplay()
          snapshots.set(id, buffer)
          res = await getSnapshot()
          if (!isCurrentHydration(generation)) return
          events = buffer.after(res.thread.last_seq)
          if (events) break
        }
        if (!res || !events) throw new Error("Thread is updating too quickly to load. Open it again to retry.")
        snapshots.delete(id)
        const store = useStore.getState()
        store.set((state) => {
          const allTasks = mergeRuntimeTasks(state.runtimeTasks[id] ?? [], res.runtime_tasks ?? [])
          const tasks = isThreadVisible(state, id) ? allTasks : allTasks.filter(isRuntimeTaskActive)
          return {
            runtimeTasks: { ...state.runtimeTasks, [id]: tasks },
            threadActivity: {
              ...state.threadActivity,
              [id]: summarizeRuntimeTasks(id, tasks),
            },
          }
        })
        const snapshot = res
        const replay = events
        store.updateTranscript(id, (prev) => {
          let next = seedFromGet(snapshot, prev)
          for (const event of replay) next = applyEvent(next, event)
          return isThreadVisible(useStore.getState(), id) ? next : compactThreadState(next)
        })
        const cached = useStore.getState().transcripts
        for (const cachedId of reusableSnapshots)
          if (!cached[cachedId]?.loaded) reusableSnapshots.delete(cachedId)
        if (cached[id]?.loaded) reusableSnapshots.add(id)
        if (isThreadVisible(store, id)) void loadCheckpoints(id)
      } catch (error) {
        if (disposed) return
        const store = useStore.getState()
        if (error instanceof RpcCallError && error.code === codes.NOT_FOUND) {
          store.set((state) => {
            const threads = { ...state.threads }
            delete threads[id]
            return { threads }
          })
          store.removeThreadFromSplit(id)
          toast("Thread is no longer available")
        } else if (store.connection.state === "open") {
          toast.error("Unable to load thread", {
            id: `thread-load:${id}`,
            description: errorText(error),
          })
        }
      }
    })()

    threadLoads.set(id, request)
    void request.finally(() => {
      if (threadLoads.get(id) === request) { threadLoads.delete(id); snapshots.delete(id) }
    })
    return request
  }

  function loadEarlier(id: ThreadId): Promise<void> {
    const pending = historyLoads.get(id)
    if (pending) return pending.promise
    const base = useStore.getState().transcripts[id]
    if (!base?.loaded || base.nextBeforeSeq == null || threadLoads.has(id) || rpc().status !== "open") return Promise.resolve()
    const generation = hydrationGeneration
    const record = { promise: Promise.resolve(), buffer: createSnapshotReplay() }
    historyLoads.set(id, record)
    useStore.getState().updateTranscript(id, (state) => ({ ...state, loadingEarlier: true }))
    record.promise = rpc().call("threads.get", {
      thread_id: id, transcript_limit: 60, before_seq: base.nextBeforeSeq, through_seq: base.lastSeq,
    }).then((page) => {
      if (!isCurrentHydration(generation) || historyLoads.get(id) !== record) return
      const replay = record.buffer.after(base.lastSeq)
      if (!replay) throw new Error("Thread is updating too quickly. Try loading earlier messages again.")
      useStore.getState().updateTranscript(id, (current) => prependThreadHistory(base, page, replay, current))
    }).catch((error) => {
      if (isCurrentHydration(generation)) toast.error("Unable to load earlier messages", { description: errorText(error) })
    }).finally(() => {
      if (historyLoads.get(id) === record) {
        historyLoads.delete(id)
        useStore.getState().updateTranscript(id, (state) => ({ ...state, loadingEarlier: false }))
      }
    })
    return record.promise
  }

  function refreshProviders(projectId?: ProjectId): Promise<ProviderStatus[]> {
    return loadProviderCatalog(projectId, true)
  }

  async function loadProviderCatalog(
    projectId: ProjectId | undefined,
    forceRefresh: boolean,
    generation?: number
  ): Promise<ProviderStatus[]> {
    const requestGeneration = generation ?? hydrationGeneration
    const key = `${requestGeneration}:${projectId ?? "global"}`
    const pending = providerLoads.get(key)
    if (pending) return pending

    if (isCurrentHydration(requestGeneration)) {
      useStore.getState().set({ providersLoading: true })
    }
    const request = (async () => {
      try {
        const result = await rpc().call("providers.list", {
          ...(projectId ? { project_id: projectId } : {}),
          ...(forceRefresh ? { force_refresh: true } : {}),
        })
        if (isCurrentHydration(requestGeneration)) {
          useStore.getState().set({ providers: result.providers })
          if (!projectId) writeProviderCache(useStore.getState().environmentId, result.providers)
        }
        return result.providers
      } finally {
        providerLoads.delete(key)
        if (isCurrentHydration(requestGeneration)) {
          useStore.getState().set({ providersLoading: false })
        }
      }
    })()
    providerLoads.set(key, request)
    return request
  }

  async function loadCheckpoints(id: ThreadId) {
    try {
      const generation = hydrationGeneration
      const r = await rpc().call("threads.checkpoints", { thread_id: id })
      if (!isCurrentHydration(generation) || !isThreadVisible(useStore.getState(), id)) return
      useStore
        .getState()
        .updateTranscript(id, (t) => ({ ...t, checkpoints: r.checkpoints }))
    } catch {
      // non-git projects have none
    }
  }

  function onEvent(ev: ThreadEvent) {
    if (disposed) return
    snapshots.get(ev.thread_id)?.add(ev)
    historyLoads.get(ev.thread_id)?.buffer.add(ev)
    const s = useStore.getState()
    if (ev.kind === "approval_resolved") toast.dismiss(`agent-input:${ev.approval_id}`)
    if (ev.kind === "workspace_reverted") reusableSnapshots.delete(ev.thread_id)
    if (
      ev.kind === "message_queued" ||
      ev.kind === "message_queue_updated" ||
      ev.kind === "message_removed" ||
      ev.kind === "turn_started"
    ) {
      void loadQueue()
    }
    if (ev.kind === "thread_created") {
      s.set((st) => ({ threads: { ...st.threads, [ev.thread.id]: ev.thread } }))
    }
    if (
      ev.kind === "runtime_task_started" ||
      ev.kind === "runtime_task_updated" ||
      ev.kind === "runtime_task_completed"
    ) {
      storeRuntimeTask(ev.task)
    }
    s.receiveEvent(ev)

    if (ev.kind === "turn_completed" || ev.kind === "turn_failed") {
      const current = useStore.getState()
      const visible = isThreadVisible(current, ev.thread_id)
      if (visible) void loadDiff(ev.thread_id, ev.turn_id ?? undefined)
      if (
        visible &&
        (current.envOpen ||
          (current.rightOpen && current.rightTab === "changes"))
      ) {
        void loadDiff(ev.thread_id)
        void loadGitStatus(ev.thread_id)
      }
      void announce(ev)
    }
    if (ev.kind === "approval_requested" || ev.kind === "user_input_requested") void announce(ev)
  }

  const announced = new Map<string, number>()
  const completedTurns = new Map<string, string>()
  const notificationsStartedAt = Date.now()

  async function announce(ev: ThreadEvent) {
    // Historical replay updates the transcript without replaying old alerts.
    if (Date.parse(ev.at) < notificationsStartedAt || ev.seq <= (announced.get(ev.thread_id) ?? 0)) return
    announced.set(ev.thread_id, ev.seq)
    const st = useStore.getState()
    if (!st.settings?.notifications) return
    let focused = document.hasFocus()
    try { focused = await isWindowFocused() } catch { /* Browser focus is the fallback. */ }
    // Focus lookup crosses the native bridge. Recheck current task state:
    // another background wave may have arrived while it was in flight.
    if (disposed) return
    const current = useStore.getState()
    const viewing = isThreadVisible(current, ev.thread_id)
    if (focused && viewing) return
    if (ev.kind === "turn_completed" && ev.stop_reason === "completed") {
      if (completedTurns.get(ev.thread_id) === ev.turn_id) return
      if (current.runtimeTasks[ev.thread_id]?.some((task) =>
        task.origin_turn_id === ev.turn_id &&
        (task.status === "running" || task.status === "waiting" || task.status === "pending"),
      )) return
      if (ev.turn_id) completedTurns.set(ev.thread_id, ev.turn_id)
    }
    const title = current.threads[ev.thread_id]?.title || "Thread"
    const body = ev.kind === "user_input_requested" ? "Needs your input"
      : ev.kind === "approval_requested" ? `Needs approval: ${ev.approval.summary}`
      : ev.kind === "turn_failed" ? `Failed: ${ev.error}`
      : ev.kind === "turn_completed" && ev.stop_reason === "completed" ? "Finished working"
      : null
    if (!body) return
    toast(title, {
      id: ev.kind === "user_input_requested" || ev.kind === "approval_requested" ? `agent-input:${ev.approval.id}` : `agent:${ev.thread_id}:${ev.seq}`,
      description: body,
      duration: ev.kind === "user_input_requested" || ev.kind === "approval_requested" ? Infinity : 6000,
      action: { label: "Open thread", onClick: () => { useStore.getState().selectThread(ev.thread_id); void loadThread(ev.thread_id) } },
    })
    if (!focused) await notify(title, body)
  }

  function loadDiff(threadId: ThreadId, turnId?: TurnId): Promise<void> {
    const requestKey = `${diffKey(threadId, turnId)}:stat`
    const pending = diffLoads.get(requestKey)
    if (pending) return pending

    const request = (async () => {
      try {
        const generation = hydrationGeneration
        const d = await rpc().call(
          "threads.diff",
          diffSummaryRequest(threadId, turnId)
        )
        if (!isCurrentHydration(generation)) return
        useStore
          .getState()
          .set((s) => ({
            diffs: { ...s.diffs, [diffKey(threadId, turnId)]: d },
          }))
      } catch {
        // no git, no diff
      } finally {
        diffLoads.delete(requestKey)
      }
    })()
    diffLoads.set(requestKey, request)
    return request
  }

  function loadFileDiff(
    threadId: ThreadId,
    path: string,
    turnId?: TurnId
  ): Promise<Diff> {
    const requestKey = `${diffKey(threadId, turnId)}:${path}`
    const pending = fileDiffLoads.get(requestKey)
    if (pending) return pending

    const request = rpc().call("threads.diff", {
      thread_id: threadId,
      ...(turnId ? { turn_id: turnId } : {}),
      include_patch: true,
      path,
    })
    fileDiffLoads.set(requestKey, request)
    void request.then(
      () => fileDiffLoads.delete(requestKey),
      () => fileDiffLoads.delete(requestKey)
    )
    return request
  }

  /** Coalesce the relatively expensive status snapshot (which can invoke `gh`). */
  function loadGitStatus(threadId: ThreadId): Promise<GitStatus | null> {
    const pending = gitStatusLoads.get(threadId)
    if (pending) return pending

    const request = (async () => {
      try {
        const generation = hydrationGeneration
        const status = await rpc().call("git.status", { thread_id: threadId })
        if (!isCurrentHydration(generation)) return null
        useStore
          .getState()
          .set((state) => ({
            gitStatuses: { ...state.gitStatuses, [threadId]: status },
          }))
        return status
      } catch {
        return null
      } finally {
        gitStatusLoads.delete(threadId)
      }
    })()
    gitStatusLoads.set(threadId, request)
    return request
  }

  // ---- actions ----

  async function createThread(opts: {
    paneId?: import("@/state/splitView").PaneId
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
    if (opts.paneId) s.focusSplitPane(opts.paneId)
    s.selectThread(t.id)
    void loadThread(t.id)
    return t.id
  }

  async function sendMessage(
    threadId: ThreadId,
    message: UserMessage
  ): Promise<void> {
    await rpc().call("threads.send", { thread_id: threadId, message })
  }

  let queueLoadGeneration = 0
  async function loadQueue(): Promise<void> {
    const generation = ++queueLoadGeneration
    try {
      const result = await rpc().call("queue.list", {})
      if (generation !== queueLoadGeneration) return
      const queued: ReturnType<typeof useStore.getState>["queued"] = {}
      for (const message of result.messages)
        (queued[message.thread_id] ??= []).push(message)
      useStore.getState().set({ queued })
    } catch (error) {
      if (rpc().status === "open")
        toast.error("Unable to load follow-ups", {
          description: errorText(error),
        })
    }
  }
  async function queueMessage(
    threadId: ThreadId,
    message: UserMessage
  ): Promise<void> {
    await rpc().call("queue.add", {
      thread_id: threadId,
      id: crypto.randomUUID(),
      message,
    })
    await loadQueue()
  }
  async function removeQueuedMessage(
    threadId: ThreadId,
    id: string
  ): Promise<void> {
    await rpc().call("queue.remove", { thread_id: threadId, id })
    await loadQueue()
  }

  async function searchFiles(
    projectId: ProjectId,
    query: string,
    limit = 30
  ): Promise<string[]> {
    const r = await rpc().call("files.search", {
      project_id: projectId,
      query,
      limit,
    })
    return r.files
  }

  async function listSkills(
    projectId: ProjectId,
    provider: ProviderKind
  ): Promise<SkillInfo[]> {
    const result = await rpc().call("skills.list", {
      project_id: projectId,
      provider,
    })
    return result.skills
  }

  /** Start a new thread with another agent, seeded with the conversation so far. */
  async function handOff(
    threadId: ThreadId,
    provider: ProviderInstance,
    model?: string
  ): Promise<ThreadId> {
    const s = useStore.getState()
    const thread = s.threads[threadId]
    if (!thread) throw new Error("Thread not found")
    const cached = s.transcripts[threadId]
    const t = cached?.loaded ? cached : seedFromGet(await rpc().call("threads.get", { thread_id: threadId }))
    const lines: string[] = []
    for (const b of t?.blocks ?? []) {
      if (b.kind === "user") {
        const text = b.message.parts
          .map((p) =>
            p.type === "text"
              ? p.text
              : p.type === "file_mention"
                ? `@${p.path}`
                : p.type === "skill"
                  ? `$${p.name}`
                  : p.type === "mention"
                    ? `@${p.display_name ?? p.name}`
                    : `[${p.type}]`
          )
          .join("")
        lines.push(`User:\n${text}`)
      } else if (b.kind === "assistant" && b.text.trim()) {
        lines.push(`Assistant:\n${b.text.trim()}`)
      } else if (b.kind === "tool") {
        const detail =
          typeof b.call.input === "object" && b.call.input
            ? JSON.stringify(b.call.input).slice(0, 200)
            : ""
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

  async function interrupt(threadId: ThreadId): Promise<void> {
    await rpc().call("threads.interrupt", { thread_id: threadId })
  }

  async function stopRuntimeTask(
    threadId: ThreadId,
    taskId: string
  ): Promise<void> {
    const task = await rpc().call("tasks.stop", {
      thread_id: threadId,
      task_id: taskId,
    })
    storeRuntimeTask(task)
  }

  async function backgroundRuntimeTask(
    threadId: ThreadId,
    taskId: string
  ): Promise<void> {
    const task = await rpc().call("tasks.background", {
      thread_id: threadId,
      task_id: taskId,
    })
    storeRuntimeTask(task)
  }

  function storeRuntimeTask(task: RuntimeTask) {
    useStore.getState().set((state) => {
      const current = state.runtimeTasks[task.thread_id] ?? []
      const visible = isThreadVisible(state, task.thread_id)
      const summary = visible ? task : { ...task, detail: task.detail?.slice(0, 512), title: task.title.slice(0, 256) }
      const all = mergeRuntimeTasks(current, [summary])
      const tasks = visible ? all : all.filter(isRuntimeTaskActive)
      return {
        runtimeTasks: { ...state.runtimeTasks, [task.thread_id]: tasks },
        threadActivity: {
          ...state.threadActivity,
          [task.thread_id]: summarizeRuntimeTasks(task.thread_id, tasks),
        },
      }
    })
  }

  async function respondApproval(
    id: ApprovalId,
    decision: ApprovalDecision
  ): Promise<void> {
    await rpc().call("approvals.respond", { approval_id: id, ...decision })
  }

  async function updateThread(
    threadId: ThreadId,
    patch: {
      title?: string
      pinned?: boolean
      permission_mode?: PermissionMode
      model?: string
      effort?: string
    }
  ) {
    const t = await rpc().call("threads.update", {
      thread_id: threadId,
      ...patch,
    })
    useStore.getState().set((st) => ({ threads: { ...st.threads, [t.id]: t } }))
  }

  async function archiveThread(threadId: ThreadId) {
    await rpc().call("threads.archive", { thread_id: threadId })
    const s = useStore.getState()
    s.set((st) => {
      const threads = { ...st.threads }
      const t = threads[threadId]
      if (t) threads[threadId] = { ...t, status: "archived" }
      return { threads }
    })
    useStore.getState().removeThreadFromSplit(threadId)
  }

  async function revertTo(threadId: ThreadId, turnId: TurnId) {
    const r = await rpc().call("threads.revert", {
      thread_id: threadId,
      turn_id: turnId,
    })
    void loadThread(threadId, true)
    void loadDiff(threadId)
    return r
  }

  async function addProject(path: string, name?: string) {
    const p = await rpc().call("projects.add", { path, name })
    useStore
      .getState()
      .set((st) => ({ projects: { ...st.projects, [p.id]: p } }))
    return p
  }

  async function removeProject(projectId: ProjectId) {
    await rpc().call("projects.remove", { project_id: projectId })
    useStore.getState().set((st) => {
      const projects = { ...st.projects }
      delete projects[projectId]
      return { projects }
    })
  }

  async function uploadFile(
    file: File
  ): Promise<{ id: string; name: string; media_type: string; size: number }> {
    try {
      const response = await fetch(`${httpBase}/assets`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": file.type || "application/octet-stream",
          "x-kybern-filename": file.name,
        },
        body: file,
        signal: uploads.signal,
      })
      if (!response.ok) {
        const detail = (await response.text()).trim()
        throw new Error(detail || `Upload failed (${response.status})`)
      }
      return response.json()
    } catch (error) {
      if (error instanceof TypeError) {
        throw new Error(
          "Kybern couldn’t reach the attachment service. Restart Kybern, then try again.",
          { cause: error }
        )
      }
      throw error
    }
  }

  async function artifactPreviewUrl(threadId: string, path: string): Promise<string> {
    const result = await rpc().call("threads.artifacts.preview", { thread_id: threadId, path })
    return `${httpBase}/artifact-preview/${encodeURIComponent(result.ticket)}`
  }

  async function fetchThreadImage(threadId: string, path: string, signal: AbortSignal, preview = false): Promise<Blob> {
    const response = await fetch(`${httpBase}/threads/${encodeURIComponent(threadId)}/image?path=${encodeURIComponent(path)}${preview ? "&preview=true" : ""}`, { headers: { authorization: `Bearer ${token}` }, signal })
    if (!response.ok) throw new Error((await response.text()).trim() || "Unable to load image. Try again.")
    return response.blob()
  }

  function disconnect() {
    disposed = true
    snapshots.clear()
    historyLoads.clear()
    reusableSnapshots.clear()
    useStore.getState().releaseCachedData()
    hydrationGeneration++
    uploads.abort()
    client?.close("Environment disconnected")
  }
  return {
    connect,
    disconnect,
    rpc,
    loadThread,
    loadEarlier,
    refreshProviders,
    loadDiff,
    loadFileDiff,
    loadGitStatus,
    createThread,
    sendMessage,
    queueMessage,
    removeQueuedMessage,
    searchFiles,
    listSkills,
    handOff,
    interrupt,
    stopRuntimeTask,
    backgroundRuntimeTask,
    respondApproval,
    updateThread,
    archiveThread,
    revertTo,
    addProject,
    removeProject,
    uploadFile,
    fetchThreadImage,
    artifactPreviewUrl,
  }
}

export type EnvironmentRuntime = ReturnType<typeof createEnvironmentRuntime>
let currentRuntime: EnvironmentRuntime | null = null
export function setEnvironmentRuntime(runtime: EnvironmentRuntime | null) {
  currentRuntime = runtime
}
export function activeRuntime(): EnvironmentRuntime {
  if (!currentRuntime)
    throw new ConnectionClosedError("Choose a connected environment")
  return currentRuntime
}
export async function boot(): Promise<void> {
  const { bootEnvironments } = await import("./environments")
  await bootEnvironments()
}
export const rpc: EnvironmentRuntime["rpc"] = (...args) =>
  activeRuntime().rpc(...args)
export const loadEarlier: EnvironmentRuntime["loadEarlier"] = (...args) => activeRuntime().loadEarlier(...args)
export const loadThread: EnvironmentRuntime["loadThread"] = (...args) =>
  activeRuntime().loadThread(...args)
export const refreshProviders: EnvironmentRuntime["refreshProviders"] = (
  ...args
) => activeRuntime().refreshProviders(...args)
export const loadDiff: EnvironmentRuntime["loadDiff"] = (...args) =>
  activeRuntime().loadDiff(...args)
export const loadFileDiff: EnvironmentRuntime["loadFileDiff"] = (...args) =>
  activeRuntime().loadFileDiff(...args)
export const loadGitStatus: EnvironmentRuntime["loadGitStatus"] = (...args) =>
  activeRuntime().loadGitStatus(...args)
export const createThread: EnvironmentRuntime["createThread"] = (...args) =>
  activeRuntime().createThread(...args)
export const sendMessage: EnvironmentRuntime["sendMessage"] = (...args) =>
  activeRuntime().sendMessage(...args)
export const queueMessage: EnvironmentRuntime["queueMessage"] = (...args) =>
  activeRuntime().queueMessage(...args)
export const removeQueuedMessage: EnvironmentRuntime["removeQueuedMessage"] = (
  ...args
) => activeRuntime().removeQueuedMessage(...args)
export const searchFiles: EnvironmentRuntime["searchFiles"] = (...args) =>
  activeRuntime().searchFiles(...args)
export const listSkills: EnvironmentRuntime["listSkills"] = (...args) =>
  activeRuntime().listSkills(...args)
export const handOff: EnvironmentRuntime["handOff"] = (...args) =>
  activeRuntime().handOff(...args)
export const interrupt: EnvironmentRuntime["interrupt"] = (...args) =>
  activeRuntime().interrupt(...args)
export const stopRuntimeTask: EnvironmentRuntime["stopRuntimeTask"] = (
  ...args
) => activeRuntime().stopRuntimeTask(...args)
export const backgroundRuntimeTask: EnvironmentRuntime["backgroundRuntimeTask"] =
  (...args) => activeRuntime().backgroundRuntimeTask(...args)
export const respondApproval: EnvironmentRuntime["respondApproval"] = (
  ...args
) => activeRuntime().respondApproval(...args)
export const updateThread: EnvironmentRuntime["updateThread"] = (...args) =>
  activeRuntime().updateThread(...args)
export const archiveThread: EnvironmentRuntime["archiveThread"] = (...args) =>
  activeRuntime().archiveThread(...args)
export const revertTo: EnvironmentRuntime["revertTo"] = (...args) =>
  activeRuntime().revertTo(...args)
export const addProject: EnvironmentRuntime["addProject"] = (...args) =>
  activeRuntime().addProject(...args)
export const removeProject: EnvironmentRuntime["removeProject"] = (...args) =>
  activeRuntime().removeProject(...args)
export const uploadFile: EnvironmentRuntime["uploadFile"] = (...args) =>
  activeRuntime().uploadFile(...args)

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// Stateful module: a hot update would drop the live connection, so reload instead.
reloadOnHotUpdate(import.meta.hot)

export const fetchThreadImage: EnvironmentRuntime["fetchThreadImage"] = (...args) => activeRuntime().fetchThreadImage(...args)
