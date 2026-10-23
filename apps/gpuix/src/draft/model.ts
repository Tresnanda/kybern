// The new chat screen's rules as plain functions (ADE-62 spec §4, round 2 §2.1): which threads and tasks the pick-up lists,
// how the project name steps down with its length, how many pick-up rows fit, and the Continue rows' trailing meta.
import { isLiveRun, latestRun, priorityWeight } from '@/state/tasksModel'
import { isSubagentThread } from '../../../../packages/kybern-client/src/subagents.ts'
import type { TaskItem, Thread } from '../../../../packages/kybern-client/src/types.ts'

/** Rows per pick-up group. */
export const PICKUP_ROWS = 3

/**
 * Continue: the project's most recently updated threads. Subagents, delegated children, archived threads and the one on
 * screen are left out. Running and waiting threads need no rule of their own: they are always recent.
 */
export function continueThreads(threads: readonly Thread[], projectId: string | null, currentId?: string | null, limit = PICKUP_ROWS): Thread[] {
  if (!projectId) return []
  return threads
    .filter((th) => th.project_id === projectId && !th.parent_thread_id && !isSubagentThread(th) && !th.delegation && th.status !== 'archived' && th.id !== currentId)
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0))
    .slice(0, limit)
}

/**
 * Up next: the project's to-do and inbox tasks that no run is working on (running and needs-review tasks have a thread and
 * show under Continue). Urgent → high → medium → low → none, then to-do before inbox, then rank, then the latest edit.
 */
export function upNextTasks(tasks: Iterable<TaskItem>, projectId: string | null, limit = PICKUP_ROWS): TaskItem[] {
  if (!projectId) return []
  const open: TaskItem[] = []
  for (const task of tasks)
    if (task.scope === 'project' && task.project_id === projectId && (task.status === 'todo' || task.status === 'inbox') && !isLiveRun(latestRun(task))) open.push(task)
  return open
    .sort((a, b) =>
      priorityWeight(a.priority) - priorityWeight(b.priority)
      || (a.status === b.status ? 0 : a.status === 'todo' ? -1 : 1)
      || a.rank - b.rank
      || (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0))
    .slice(0, limit)
}

/**
 * The project name's size, by character count so nothing is measured: up to 28 characters 34/44, up to 40 28/36, longer
 * 24/31 (it then truncates at the column and shows the whole name in a tooltip).
 */
export function heroType(name: string): { size: 34 | 28 | 24; lineHeight: number } {
  const length = [...name].length
  if (length <= 28) return { size: 34, lineHeight: 44 }
  if (length <= 40) return { size: 28, lineHeight: 36 }
  return { size: 24, lineHeight: 31 }
}

/**
 * The hero chevron for a name size: the glyph box is about half the type size, its stroke follows the 600-weight stems, and
 * `nudge` moves its centre from the line box's centre down onto the middle of the lowercase body (baseline to x-height),
 * where a lowercase project name's optical centre sits. Values were set by eye on zoomed captures at each size.
 */
export function heroChevron(size: 34 | 28 | 24): { box: number; stroke: number; nudge: number; gap: number } {
  if (size === 34) return { box: 18, stroke: 2.6, nudge: 3, gap: 8 }
  if (size === 28) return { box: 15, stroke: 2.7, nudge: 2.5, gap: 7 }
  return { box: 13, stroke: 2.8, nudge: 2, gap: 6 }
}

/** Rows per group that fit between the card's bottom (+32) and the pane's bottom (−24): `floor((space − 24) / 32)`, at most 3. */
export function pickupRowsFor(paneBottom: number, cardBottom: number): number {
  const space = paneBottom - (cardBottom + 32) - 24
  return Math.max(0, Math.min(PICKUP_ROWS, Math.floor((space - 24) / 32)))
}

/** A Continue row's trailing text: its live state, else how long ago it changed (`Now`, `12m`, `2h`, `Yesterday`, `Mon`, `Oct 3`). */
export function continueMeta(thread: Pick<Thread, 'status' | 'updated_at'>, now = Date.now(), locale?: string): { text: string; tone: 'working' | 'waiting' | 'time' } {
  if (thread.status === 'running') return { text: 'Working', tone: 'working' }
  if (thread.status === 'awaiting-approval') return { text: 'Waiting for you', tone: 'waiting' }
  const at = Date.parse(thread.updated_at)
  if (Number.isNaN(at)) return { text: '', tone: 'time' }
  const minutes = Math.floor(Math.max(0, now - at) / 60_000)
  if (minutes < 1) return { text: 'Now', tone: 'time' }
  if (minutes < 60) return { text: `${minutes}m`, tone: 'time' }
  const day = (ms: number) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() }
  const days = Math.round((day(now) - day(at)) / 86_400_000)
  if (days <= 0) return { text: `${Math.floor(minutes / 60)}h`, tone: 'time' }
  if (days === 1) return { text: 'Yesterday', tone: 'time' }
  if (days < 7) return { text: new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(at), tone: 'time' }
  return { text: new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(at), tone: 'time' }
}

/**
 * The one task attached to a new chat (Up next): clicking a row attaches it, clicking the attached row detaches it, and
 * clicking another replaces it. A task from another project is dropped when the draft's project changes.
 */
export function toggleAttached(current: string | null, id: string): string | null {
  return current === id ? null : id
}
export function attachedForProject(attached: TaskItem | null | undefined, projectId: string | null): TaskItem | null {
  return attached && attached.project_id === projectId ? attached : null
}

/**
 * Keyboard movement in the pick-up (spec §3): ↑/↓ within a group, ←/→ to the same row index in the other group (clamped),
 * ↑ from the first row leaves to the composer (`null`).
 */
export function movePickup(at: { group: 0 | 1; row: number }, key: 'up' | 'down' | 'left' | 'right', counts: readonly [number, number]): { group: 0 | 1; row: number } | null {
  if (key === 'up') return at.row === 0 ? null : { group: at.group, row: at.row - 1 }
  if (key === 'down') return { group: at.group, row: Math.min(at.row + 1, counts[at.group] - 1) }
  const other = (at.group === 0 ? 1 : 0) as 0 | 1
  if (!counts[other]) return at
  if ((key === 'right' && at.group === 1) || (key === 'left' && at.group === 0)) return at
  return { group: other, row: Math.min(at.row, counts[other] - 1) }
}

/** A prompt flies into the bubble only up to 6 bubble lines; a longer one (or a scrolled editor) fades instead. */
export const MORPH_MAX_LINES = 6
/** More images than this fade in place instead of travelling with the prompt. */
export const MORPH_MAX_IMAGES = 4
