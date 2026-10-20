import { useEffect, useSyncExternalStore } from 'react'
import type {
  TaskItem,
  TaskItemsChangedNotification,
  TaskItemsCreateParams,
  TaskItemsUpdateParams,
  TaskPriority,
} from '../../../../packages/kybern-client/src/types.ts'
import { readTaskPrefs, type TaskViewPrefs } from '@/state/tasksModel'
import { getClient, getState, useApp } from '../state.ts'
import { activeEnvironment, onEnvironmentChange } from '../shell/environment.ts'
import { load, save } from '../shell/persist.ts'
import { toast } from '../shell/toasts.tsx'

const PREFS = 'kybern.tasks.prefs:local'
interface State {
  tasks: Record<string, TaskItem>
  loaded: boolean
  error: string | null
  prefs: TaskViewPrefs
  query: string
  openId: string | null
  focused: string | null
  selected: ReadonlySet<string>
  anchor: string | null
  quick: { status: 'inbox' | 'todo'; projectId: string | null; priority?: TaskPriority; groupKey: string; nonce: number } | null
  composer: string[] | null
  menu: 'status' | 'priority' | null
}
const initialState = (): State => ({
  tasks: {},
  loaded: false,
  error: null,
  prefs: readTaskPrefs(load(PREFS, null)),
  query: '',
  openId: null,
  focused: null,
  selected: new Set(),
  anchor: null,
  quick: null,
  composer: null,
  menu: null,
})
let state: State = initialState()
const listeners = new Set<() => void>()
export const taskState = () => state
export function setTasks(patch: Partial<State>) {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}
export function useTasks<T>(selector: (s: State) => T) {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => selector(state),
  )
}
export function prefs(patch: Partial<TaskViewPrefs>) {
  const next = { ...state.prefs, ...patch }
  setTasks({ prefs: next })
  save(PREFS, next)
}
export function openTask(id: string | null) {
  setTasks({ openId: id, focused: id ?? state.focused, composer: null, menu: null, quick: null })
}
export function chooseFilter(filter: TaskViewPrefs['filter']) {
  prefs({ filter })
  setTasks({ openId: null, selected: new Set(), query: '', composer: null, quick: null })
}
export function quickAdd(status: 'inbox' | 'todo' = 'inbox', home?: { projectId?: string | null; priority?: TaskPriority }) {
  const filter = state.prefs.filter
  const projectId =
    home?.projectId !== undefined
      ? home.projectId
      : filter.startsWith('project:')
        ? filter.slice(8)
        : filter === 'global'
          ? null
          : (getState().threads.find((thread) => thread.id === getState().selectedId)?.project_id ?? getState().draft.projectId ?? null)
  const groupKey =
    state.prefs.view === 'board' || state.prefs.grouping === 'status'
      ? `status:${status}`
      : state.prefs.grouping === 'project'
        ? `project:${projectId ?? 'global'}`
        : `priority:${home?.priority ?? 0}`
  setTasks({ quick: { status, projectId, priority: home?.priority, groupKey, nonce: Date.now() }, openId: null, composer: null })
}
export function pick(id: string, sequence: string[], range = false) {
  const selected = new Set(state.selected)
  const a = state.anchor ? sequence.indexOf(state.anchor) : -1
  const b = sequence.indexOf(id)
  if (range && a >= 0 && b >= 0) sequence.slice(Math.min(a, b), Math.max(a, b) + 1).forEach((key) => selected.add(key))
  else if (selected.has(id)) selected.delete(id)
  else selected.add(id)
  setTasks({ selected, focused: id, anchor: range ? (state.anchor ?? id) : id })
}
export function upsert(task: TaskItem) {
  const old = state.tasks[task.id]
  if (old && (old.revision > task.revision || (old.revision === task.revision && old.updated_at > task.updated_at))) return
  setTasks({ tasks: { ...state.tasks, [task.id]: task } })
}
function change(map: Record<string, TaskItem>, event: TaskItemsChangedNotification) {
  const next = { ...map }
  if (event.deleted_id) delete next[event.deleted_id]
  if (event.task) {
    const old = next[event.task.id]
    if (!old || event.task.revision > old.revision || (event.task.revision === old.revision && event.task.updated_at >= old.updated_at))
      next[event.task.id] = event.task
  }
  return next
}
let generation = 0
let pending: TaskItemsChangedNotification[] | null = null
export async function refreshTasks() {
  const client = getClient()
  if (!client) return
  const token = ++generation
  const queue: TaskItemsChangedNotification[] = []
  pending = queue
  setTasks({ error: null })
  try {
    const result = await client.call('tasks.items.list', {})
    if (token !== generation) return
    let map = Object.fromEntries(result.tasks.map((task) => [task.id, task]))
    for (const event of queue) map = change(map, event)
    setTasks({ tasks: map, loaded: true })
  } catch (error) {
    if (token === generation) {
      let map = state.tasks
      for (const event of queue) map = change(map, event)
      setTasks({ tasks: map, error: String(error) })
    }
  } finally {
    if (pending === queue) pending = null
  }
}
/** Mounted in the workspace, so the rail's review dot follows changes off page too. */
export function useTasksFeed() {
  const status = useApp((s) => s.status)
  useEffect(() => {
    const client = getClient()
    if (status !== 'open' || !client) return
    const off = client.onNotification('tasks.items.changed', (value) => {
      const event = value as TaskItemsChangedNotification
      if (pending) pending.push(event)
      else setTasks({ tasks: change(state.tasks, event) })
    })
    void refreshTasks()
    return () => {
      off()
      generation++
      pending = null
    }
  }, [status])
}
// A switch starts from the new environment's tasks and saved view; a list
// request or queued change for the previous one is dropped.
onEnvironmentChange(() => {
  generation++
  pending = null
  setTasks(initialState())
})
export async function createTask(params: TaskItemsCreateParams) {
  const client = getClient()
  if (!client) throw new Error('Reconnect to add a task.')
  const owner = activeEnvironment()
  const task = await client.call('tasks.items.create', params)
  if (owner === activeEnvironment()) upsert(task)
  return task
}
export async function updateTask(id: string, patch: Omit<TaskItemsUpdateParams, 'id'>) {
  try {
    const client = getClient()
    if (!client) throw new Error('Reconnect and try again.')
    const owner = activeEnvironment()
    const task = await client.call('tasks.items.update', { id, ...patch })
    if (owner === activeEnvironment()) upsert(task)
    return task
  } catch (error) {
    toast.error('Unable to save task', { description: String(error) })
    throw error
  }
}
export function updateMany(ids: string[], patch: Omit<TaskItemsUpdateParams, 'id'>) {
  // Each write has its own failure feedback; successful siblings remain saved.
  return Promise.allSettled(ids.map((id) => updateTask(id, patch)))
}
export async function deleteTasks(ids: string[]) {
  const deleted: string[] = []
  // One client for the whole batch: a switch midway must not send these ids to another environment.
  const client = getClient()
  const owner = activeEnvironment()
  for (const id of ids) {
    if (owner !== activeEnvironment()) return
    try {
      if (!client) throw new Error('Reconnect and try again.')
      await client.call('tasks.items.delete', { id })
      if (owner !== activeEnvironment()) return
      deleted.push(id)
      const tasks = { ...state.tasks }
      delete tasks[id]
      const selected = new Set(state.selected)
      selected.delete(id)
      setTasks({ tasks, selected, openId: state.openId === id ? null : state.openId })
    } catch (error) {
      toast.error('Unable to delete task', { description: String(error) })
    }
  }
  if (deleted.length)
    toast(deleted.length === 1 ? 'Task deleted' : `${deleted.length} tasks deleted`, {
      duration: 8000,
      action: {
        label: 'Undo',
        onClick: () => {
          void Promise.allSettled(
            deleted.map(async (id) => {
              try {
                if (owner !== activeEnvironment() || !client) return
                const task = await client.call('tasks.items.restore', { id })
                if (owner === activeEnvironment()) upsert(task)
              } catch (error) {
                toast.error('Unable to restore task', { description: String(error) })
              }
            }),
          )
        },
      },
    })
}

let typing = false
export const taskTyping = (value: boolean) => {
  typing = value
}
export const isTaskTyping = () => typing
