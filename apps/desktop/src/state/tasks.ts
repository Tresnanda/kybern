// Tasks data layer: the active environment's tasks (listed on connect, kept current by
// `tasks.items.changed`, listed again after a reconnect), the actions that change them,
// and the Tasks page's own UI state (view preferences, focus, quick add, the run composer).
import { useMemo } from "react"
import { toast } from "sonner"
import { create } from "zustand"

import { reloadOnHotUpdate } from "@/lib/hot"
import {
  codes,
  ConnectionClosedError,
  KybernClient,
  RpcCallError,
  TASK_ITEMS_CHANGED_NOTIFICATION,
  type NoteId,
  type PermissionMode,
  type ProjectId,
  type ProviderInstance,
  type TaskItem,
  type TaskItemId,
  type TaskItemsChangedNotification,
  type TaskItemsCreateParams,
  type TaskItemsSendParams,
  type TaskItemsUpdateParams,
  type TaskPriority,
  type TaskStatus,
  type ThreadId,
  type UserMessage,
} from "@/protocol"
import { activeRuntime, errorText, loadThread } from "./rpc"
import { useStore, type AppState } from "./store"
import {
  DEFAULT_TASK_PREFS,
  isLiveRun,
  latestRun,
  readTaskPrefs,
  splitTaskKey,
  type TaskFilter,
  type TaskViewPrefs,
} from "./tasksModel"

export interface QuickAdd {
  /** The group the row sits in. */
  groupKey: string
  status: TaskStatus
  /** Project for the new task; null = Global. */
  projectId: ProjectId | null
  priority?: TaskPriority
  nonce: number
}

/** The composer at the foot of a task's page: a new run, or a follow-up to the live one. */
export interface RunComposerRequest {
  taskId: TaskItemId
  kind: "run" | "followup"
  /** Changes on every request, so asking again focuses the open composer. */
  nonce: number
}

export interface TaskMenuRequest {
  taskId: TaskItemId
  kind: "status" | "priority"
  nonce: number
}

interface TasksState {
  /** The environment these tasks were read from. */
  ownerKey: string | null
  tasks: Record<TaskItemId, TaskItem>
  loaded: boolean
  /** False when the daemon predates tasks. */
  supported: boolean
  error: string | null
  prefs: TaskViewPrefs
  /** The sidebar's search text. */
  query: string
  /** The row or card with the keyboard focus. */
  focusedId: TaskItemId | null
  quickAdd: QuickAdd | null
  composer: RunComposerRequest | null
  menu: TaskMenuRequest | null
  /** Set when "New task" should focus the detail page's title. */
  titleFocus: TaskItemId | null
}

const prefsKey = (environmentId: string) => `kybern.tasks.prefs:${environmentId}`
const sendKey = (environmentId: string) => `kybern.tasks.send:${environmentId}`

function readStoredPrefs(environmentId: string): TaskViewPrefs {
  try {
    return readTaskPrefs(JSON.parse(globalThis.localStorage?.getItem(prefsKey(environmentId)) ?? "null"))
  } catch {
    return { ...DEFAULT_TASK_PREFS }
  }
}

export const useTasks = create<TasksState>()(() => ({
  ownerKey: null,
  tasks: {},
  loaded: false,
  supported: true,
  error: null,
  prefs: { ...DEFAULT_TASK_PREFS },
  query: "",
  focusedId: null,
  quickAdd: null,
  composer: null,
  menu: null,
  titleFocus: null,
}))

// ---- feed ----

let feedClient: KybernClient | null = null
let generation = 0
/** Changes that arrive while the list loads wait here, then replay over it. */
let waiting: TaskItemsChangedNotification[] | null = null

function newer(existing: TaskItem | undefined, incoming: TaskItem): boolean {
  if (!existing) return true
  if (incoming.revision !== existing.revision) return incoming.revision > existing.revision
  return incoming.updated_at >= existing.updated_at
}

function merge(tasks: Record<TaskItemId, TaskItem>, change: TaskItemsChangedNotification): Record<TaskItemId, TaskItem> {
  const next = { ...tasks }
  if (change.deleted_id) delete next[change.deleted_id]
  const incoming = change.task
  if (incoming && newer(next[incoming.id], incoming)) next[incoming.id] = incoming
  return next
}

function applyChange(change: TaskItemsChangedNotification) {
  if (waiting) {
    waiting.push(change)
    return
  }
  useTasks.setState((state) => ({ tasks: merge(state.tasks, change) }))
}

function upsert(task: TaskItem) {
  // The daemon's answer is the truth, even when an optimistic copy looked newer.
  useTasks.setState((state) => ({ tasks: { ...state.tasks, [task.id]: task } }))
}

async function loadFeed(client: KybernClient, token: number) {
  const queue: TaskItemsChangedNotification[] = []
  waiting = queue
  try {
    const { tasks } = await client.call("tasks.items.list", {})
    if (token !== generation) return
    let map: Record<TaskItemId, TaskItem> = Object.fromEntries(tasks.map((task) => [task.id, task]))
    for (const change of queue) map = merge(map, change)
    useTasks.setState({ tasks: map, loaded: true, supported: true, error: null })
  } catch (error) {
    if (token !== generation) return
    if (error instanceof RpcCallError && error.code === codes.METHOD_NOT_FOUND) {
      useTasks.setState({ loaded: true, supported: false, error: "This environment needs an update to use tasks." })
    } else {
      useTasks.setState({ error: errorText(error) })
    }
  } finally {
    if (waiting === queue) waiting = null
  }
}

/** Follow the active environment's tasks until the returned function is called. */
export function attachTasksFeed(client: KybernClient, ownerKey: string): () => void {
  const token = ++generation
  feedClient = client
  if (useTasks.getState().ownerKey !== ownerKey) {
    useTasks.setState({
      ownerKey,
      tasks: {},
      loaded: false,
      supported: true,
      error: null,
      prefs: readStoredPrefs(ownerKey),
      focusedId: null,
      quickAdd: null,
      composer: null,
      menu: null,
    })
  }
  const off = client.onNotification(TASK_ITEMS_CHANGED_NOTIFICATION, (params) => applyChange(params as TaskItemsChangedNotification))
  void loadFeed(client, token)
  return () => {
    off()
    if (generation === token) {
      feedClient = null
      waiting = null
    }
  }
}

/** Read the list again, for "Try again". */
export function refreshTasks() {
  const client = feedClient ?? activeClient()
  if (client) void loadFeed(client, generation)
}

function activeClient(): KybernClient | null {
  try {
    return activeRuntime().rpc()
  } catch {
    return null
  }
}

function client(): KybernClient {
  const found = feedClient ?? activeClient()
  if (!found) throw new ConnectionClosedError("Reconnect to this environment before trying again")
  return found
}

// ---- lookups ----

export function getTask(id: TaskItemId): TaskItem | undefined {
  return useTasks.getState().tasks[id]
}

/** Find a task by id or by key ("ADE-14"). */
export function findTask(idOrKey: string): TaskItem | undefined {
  const tasks = useTasks.getState().tasks
  if (tasks[idOrKey]) return tasks[idOrKey]
  if (!splitTaskKey(idOrKey)) return undefined
  const key = idOrKey.trim().toUpperCase()
  return Object.values(tasks).find((task) => task.key === key)
}

export function useTask(id: TaskItemId | null | undefined): TaskItem | undefined {
  return useTasks((s) => (id ? s.tasks[id] : undefined))
}

/** A task by id or key, live. For inline references in notes. */
export function useTaskRef(idOrKey: string | null | undefined): TaskItem | undefined {
  const tasks = useTasks((s) => s.tasks)
  return useMemo(() => {
    if (!idOrKey) return undefined
    if (tasks[idOrKey]) return tasks[idOrKey]
    const key = idOrKey.trim().toUpperCase()
    return splitTaskKey(key) ? Object.values(tasks).find((task) => task.key === key) : undefined
  }, [tasks, idOrKey])
}

export function useAllTasks(): TaskItem[] {
  const tasks = useTasks((s) => s.tasks)
  return useMemo(() => Object.values(tasks), [tasks])
}

// ---- view state ----

export function setTaskPrefs(patch: Partial<TaskViewPrefs> | ((prefs: TaskViewPrefs) => Partial<TaskViewPrefs>)) {
  useTasks.setState((state) => {
    const prefs = { ...state.prefs, ...(typeof patch === "function" ? patch(state.prefs) : patch) }
    try {
      const owner = state.ownerKey ?? useStore.getState().environmentId
      globalThis.localStorage?.setItem(prefsKey(owner), JSON.stringify(prefs))
    } catch {
      /* The view still changes for this session. */
    }
    return { prefs }
  })
}

export function setTaskFilter(filter: TaskFilter) {
  setTaskPrefs({ filter })
}

/** Pin a project to the top of the panel's Projects list, or unpin it. */
export function setProjectPinned(projectId: ProjectId, pinned: boolean) {
  setTaskPrefs((prefs) => {
    const rest = prefs.pinnedProjects.filter((id) => id !== projectId)
    return { pinnedProjects: pinned ? [...rest, projectId] : rest }
  })
}

export function setProjectsCollapsed(collapsed: boolean) {
  setTaskPrefs({ projectsCollapsed: collapsed })
}

export function setGroupCollapsed(key: string, collapsed: boolean) {
  setTaskPrefs((prefs) => ({ collapsed: { ...prefs.collapsed, [key]: collapsed } }))
}

export function setTaskQuery(query: string) {
  useTasks.setState({ query })
}

export function setFocusedTask(id: TaskItemId | null) {
  if (useTasks.getState().focusedId !== id) useTasks.setState({ focusedId: id })
}

let nonce = 0

export function startQuickAdd(init: Omit<QuickAdd, "nonce">) {
  useTasks.setState({ quickAdd: { ...init, nonce: ++nonce } })
}

export function stopQuickAdd() {
  if (useTasks.getState().quickAdd) useTasks.setState({ quickAdd: null })
}

export function openTaskMenu(taskId: TaskItemId, kind: "status" | "priority") {
  useTasks.setState({ menu: { taskId, kind, nonce: ++nonce } })
}

export function closeTaskMenu() {
  if (useTasks.getState().menu) useTasks.setState({ menu: null })
}

// ---- navigation ----

/** Open the Tasks page, on one task when given. */
export function openTask(id?: TaskItemId) {
  const store = useStore.getState()
  store.set({ settingsOpen: false })
  store.selectTasks(id)
  if (id) setFocusedTask(id)
}

/** Open the Tasks page on a sidebar filter. */
export function openTasks(filter?: TaskFilter) {
  if (filter) setTaskFilter(filter)
  openTask()
}

/** Show a run's thread. */
export function openRunThread(threadId: ThreadId) {
  const store = useStore.getState()
  store.set({ settingsOpen: false })
  store.selectThread(threadId)
  void loadThread(threadId)
}

/**
 * Open a task's page with its composer showing: a new run, or, while a run is live,
 * a follow-up to it. Asking again while it is open focuses it.
 */
export function openRunComposer(taskId: TaskItemId, kind?: RunComposerRequest["kind"]) {
  const task = getTask(taskId)
  const live = task ? isLiveRun(latestRun(task)) : false
  // One run at a time: while one is live, more instructions go to it as a follow-up.
  const resolved = live ? "followup" : kind ?? "run"
  const selected = useStore.getState().selected
  if (selected.kind !== "tasks" || selected.taskId !== taskId) openTask(taskId)
  useTasks.setState({ composer: { taskId, kind: resolved, nonce: ++nonce } })
}

/**
 * Leaving the task's page hides its composer; coming back shows the page at rest.
 * Called from the workspace on every selection change (`useTasksSync`), because the
 * environment store is swapped in after this module loads.
 */
export function closeRunComposerOffPage(selected: AppState["selected"]) {
  const open = useTasks.getState().composer
  if (open && !(selected.kind === "tasks" && selected.taskId === open.taskId)) useTasks.setState({ composer: null })
}

/** Hide the composer; its draft stays. */
export function closeRunComposer(taskId?: TaskItemId) {
  const open = useTasks.getState().composer
  if (open && (!taskId || open.taskId === taskId)) useTasks.setState({ composer: null })
}

// ---- actions ----

export async function createTask(params: TaskItemsCreateParams): Promise<TaskItem> {
  const task = await client().call("tasks.items.create", params)
  upsert(task)
  return task
}

/** Create a task where the user is, open it, and focus its title. */
export async function createAndOpenTask(init: { projectId: ProjectId | null; status?: TaskStatus; title?: string }): Promise<TaskItem | null> {
  try {
    const task = await createTask({
      scope: init.projectId ? "project" : "global",
      project_id: init.projectId,
      title: init.title ?? "",
      status: init.status ?? "inbox",
    })
    useTasks.setState({ titleFocus: task.id })
    openTask(task.id)
    return task
  } catch (error) {
    toast.error("Unable to create the task", { description: errorText(error) })
    return null
  }
}

/**
 * Make a task from a note's checklist line. The daemon links the line to the task
 * (`[KEY](kybern://task/<id>)`) and keeps its checkbox in step with the task.
 */
export async function createTaskFromNoteLine(input: {
  noteId: NoteId
  /** The line as the note's Markdown has it, so the daemon can find it. */
  lineText: string
  /** The task's title; the line's text without Markdown. Defaults to `lineText`. */
  title?: string
  projectId: ProjectId | null
}): Promise<TaskItem | null> {
  try {
    return await createTask({
      scope: input.projectId ? "project" : "global",
      project_id: input.projectId,
      title: (input.title ?? input.lineText).trim(),
      status: "todo",
      note_ids: [input.noteId],
      source: { note_id: input.noteId, line_text: input.lineText },
    })
  } catch (error) {
    toast.error("Unable to make a task", { description: errorText(error) })
    return null
  }
}

const OPTIMISTIC_FIELDS = ["status", "priority", "scope", "project_id", "note_ids", "pending_followup"] as const

/**
 * Change a task's fields. Status, priority, project, links and rank show at once and
 * settle when the daemon answers; a failure puts them back.
 */
export async function updateTask(
  id: TaskItemId,
  patch: Omit<TaskItemsUpdateParams, "id">,
  options: { rank?: number; failure?: string } = {},
): Promise<TaskItem | null> {
  const before = getTask(id)
  if (!before) return null
  const optimistic: TaskItem = { ...before }
  for (const field of OPTIMISTIC_FIELDS) {
    const value = patch[field]
    if (value !== undefined && value !== null) (optimistic as unknown as Record<string, unknown>)[field] = value
  }
  if (patch.scope === "global") optimistic.project_id = null
  if (patch.status && patch.status !== before.status) optimistic.status_changed_at = new Date().toISOString()
  if (options.rank !== undefined) optimistic.rank = options.rank
  useTasks.setState((state) => ({ tasks: { ...state.tasks, [id]: optimistic } }))
  try {
    const task = await client().call("tasks.items.update", { id, ...patch })
    upsert(task)
    return task
  } catch (error) {
    // Put back what changed, unless something newer arrived meanwhile.
    useTasks.setState((state) => (state.tasks[id] === optimistic ? { tasks: { ...state.tasks, [id]: before } } : {}))
    toast.error(options.failure ?? `Unable to update ${before.key}`, { description: errorText(error) })
    return null
  }
}

export const setTaskStatus = (id: TaskItemId, status: TaskStatus) => updateTask(id, { status }, { failure: "Unable to change the status" })
export const setTaskPriority = (id: TaskItemId, priority: TaskPriority) => updateTask(id, { priority }, { failure: "Unable to change the priority" })
export const setTaskProject = (id: TaskItemId, projectId: ProjectId | null) =>
  updateTask(id, projectId ? { scope: "project", project_id: projectId } : { scope: "global" }, { failure: "Unable to move the task" })
export const setTaskNotes = (id: TaskItemId, noteIds: NoteId[]) => updateTask(id, { note_ids: noteIds }, { failure: "Unable to change linked notes" })

/** Move a task within or across statuses: before `beforeId`, or to the end. */
export function moveTask(id: TaskItemId, move: { status?: TaskStatus; beforeId: TaskItemId | null; rank: number }) {
  const task = getTask(id)
  if (!task) return
  const status = move.status && move.status !== task.status ? move.status : undefined
  return updateTask(id, { ...(status ? { status } : {}), before_id: move.beforeId }, { rank: move.rank, failure: `Unable to move ${task.key}` })
}

/** Save a title or body. Throws CONFLICT when the task changed elsewhere. */
export async function saveTaskContent(id: TaskItemId, expectedRevision: number, content: { title?: string; body?: string }): Promise<TaskItem> {
  const task = await client().call("tasks.items.update", { id, expected_revision: expectedRevision, ...content })
  upsert(task)
  return task
}

export async function fetchTask(id: TaskItemId): Promise<TaskItem | null> {
  const { task } = await client().call("tasks.items.get", { id })
  if (task) upsert(task)
  return task ?? null
}

export const isConflict = (error: unknown): boolean => error instanceof RpcCallError && error.code === codes.CONFLICT

/** Delete a task (it stays restorable); `quiet` skips the toast when the caller offers its own way back. */
export async function deleteTask(id: TaskItemId, options: { quiet?: boolean } = {}): Promise<boolean> {
  const task = getTask(id)
  if (!task) return false
  useTasks.setState((state) => {
    const tasks = { ...state.tasks }
    delete tasks[id]
    return { tasks, focusedId: state.focusedId === id ? null : state.focusedId }
  })
  try {
    await client().call("tasks.items.delete", { id })
  } catch (error) {
    upsert(task)
    toast.error(`Unable to delete ${task.key}`, { description: errorText(error) })
    return false
  }
  if (options.quiet) return true
  toast(`Deleted ${task.key}`, {
    duration: 8000,
    action: { label: "Undo", onClick: () => void restoreTask(id) },
  })
  return true
}

export async function restoreTask(id: TaskItemId): Promise<TaskItem | null> {
  try {
    const task = await client().call("tasks.items.restore", { id })
    upsert(task)
    return task
  } catch (error) {
    toast.error("Unable to restore the task", { description: errorText(error) })
    return null
  }
}

/**
 * `tasks.items.send` with the composer's whole first message (chips, files, skills,
 * attachments) in place of a prompt string. The daemon puts the task's own chip
 * first when the message has none.
 */
export type TaskRunSendParams = Omit<TaskItemsSendParams, "prompt" | "message"> & { message: UserMessage }

/** Start a run in the background. The caller decides whether to open it. */
export async function sendTask(params: TaskRunSendParams): Promise<{ task: TaskItem; thread_id: ThreadId }> {
  const result = await client().call("tasks.items.send", params)
  upsert(result.task)
  return result
}

/**
 * Send a follow-up with its chips and attachments: into an idle run, queued behind a
 * busy one, or saved as text for the next run (the daemon refuses attachments there).
 * Throws, so the composer keeps the message and says what went wrong.
 */
export async function followupTask(id: TaskItemId, message: UserMessage): Promise<{ task: TaskItem; sent_to?: ThreadId | null }> {
  const result = await client().call("tasks.items.followup", { id, message })
  upsert(result.task)
  return result
}

// ---- Send defaults, remembered per project ----

export interface SendPrefs {
  provider?: ProviderInstance
  model?: string | null
  effort?: string | null
  permissionMode?: PermissionMode
  useWorktree?: boolean
  baseBranch?: string | null
}

export function readSendPrefs(projectId: ProjectId | null): SendPrefs {
  try {
    const all = JSON.parse(globalThis.localStorage?.getItem(sendKey(useStore.getState().environmentId)) ?? "{}")
    const value = all?.[projectId ?? "global"]
    return value && typeof value === "object" ? (value as SendPrefs) : {}
  } catch {
    return {}
  }
}

export function writeSendPrefs(projectId: ProjectId | null, prefs: SendPrefs) {
  try {
    const key = sendKey(useStore.getState().environmentId)
    const all = JSON.parse(globalThis.localStorage?.getItem(key) ?? "{}") ?? {}
    all[projectId ?? "global"] = { ...all[projectId ?? "global"], ...prefs }
    globalThis.localStorage?.setItem(key, JSON.stringify(all))
  } catch {
    /* Defaults fall back to settings. */
  }
}

reloadOnHotUpdate(import.meta.hot)
