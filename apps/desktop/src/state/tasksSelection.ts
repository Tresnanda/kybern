// Multi-select on the Tasks list and board, and what a batch Send to agent needs:
// pure functions over ids in the order they are shown, so the rules (toggle, range,
// extend, prune) and the batch's project and message rules can be tested without the app.
import { parseKybernMention, taskMentionPath } from "../../../../packages/kybern-client/src/userInput.ts"
import type { ContentPart, TaskItem } from "../../../../packages/kybern-client/src/types.ts"
import { isLiveRun, latestRun } from "./tasksModel.ts"

export interface SelectionState {
  selected: ReadonlySet<string>
  /** Where a range starts: the last row toggled, or where an extension began. */
  anchorId: string | null
  /** Where the current range ends, so the next range can replace it instead of adding to it. */
  rangeEndId: string | null
}

export const EMPTY_SELECTION: SelectionState = { selected: new Set(), anchorId: null, rangeEndId: null }

/** ⌘-click, the checkbox and X: flip one task, and make it the start of the next range. */
export function toggleSelection(state: SelectionState, id: string): SelectionState {
  const selected = new Set(state.selected)
  if (!selected.delete(id)) selected.add(id)
  return { selected, anchorId: id, rangeEndId: id }
}

function between(ordered: readonly string[], a: string, b: string): string[] {
  const from = ordered.indexOf(a)
  const to = ordered.indexOf(b)
  if (from < 0 || to < 0) return []
  return ordered.slice(Math.min(from, to), Math.max(from, to) + 1)
}

/**
 * ⇧-click: select from the anchor to `target` in the order shown. The range replaces the
 * previous one from the same anchor, so clicking back toward the anchor shrinks it, and
 * tasks picked on their own elsewhere stay picked. With no anchor the range starts at
 * `pivot` (the focused row), else at `target`.
 */
export function rangeSelection(ordered: readonly string[], state: SelectionState, target: string, pivot?: string | null): SelectionState {
  if (!ordered.includes(target)) return state
  const anchor = state.anchorId && ordered.includes(state.anchorId) ? state.anchorId : pivot && ordered.includes(pivot) ? pivot : target
  const previous = state.rangeEndId && state.anchorId === anchor ? between(ordered, anchor, state.rangeEndId) : []
  const selected = new Set(state.selected)
  for (const id of previous) selected.delete(id)
  for (const id of between(ordered, anchor, target)) selected.add(id)
  return { selected, anchorId: anchor, rangeEndId: target }
}

/**
 * ⇧↑ / ⇧↓: move the focus one row and extend the range to it. Returns the row to focus.
 * Starting a new extension from a focus the previous range did not end at begins a new range.
 */
export function extendSelection(
  ordered: readonly string[],
  state: SelectionState,
  focusedId: string | null,
  direction: 1 | -1,
): { state: SelectionState; target: string | null } {
  if (!ordered.length) return { state, target: null }
  const at = focusedId ? ordered.indexOf(focusedId) : -1
  const next = at < 0 ? (direction === 1 ? 0 : ordered.length - 1) : Math.max(0, Math.min(ordered.length - 1, at + direction))
  const target = ordered[next]!
  const from = at < 0 ? target : focusedId!
  const continuing = state.anchorId !== null && state.rangeEndId === from && ordered.includes(state.anchorId)
  const base: SelectionState = continuing ? state : { ...state, anchorId: from, rangeEndId: null }
  // A new extension selects its starting row too, as Finder and Linear do.
  const started = continuing ? base : { selected: new Set([...base.selected, from]), anchorId: from, rangeEndId: from }
  return { state: rangeSelection(ordered, started, target), target }
}

/** ⌘A: every task shown. The anchor stays where it was. */
export function selectAllSelection(ordered: readonly string[], state: SelectionState): SelectionState {
  if (!ordered.length) return state
  return { selected: new Set([...state.selected, ...ordered]), anchorId: state.anchorId, rangeEndId: null }
}

/** Drop what is no longer there. Returns `state` itself when nothing changed. */
export function pruneSelection(state: SelectionState, keep: (id: string) => boolean): SelectionState {
  let dropped = false
  const selected = new Set<string>()
  for (const id of state.selected) {
    if (keep(id)) selected.add(id)
    else dropped = true
  }
  const anchorGone = state.anchorId !== null && !keep(state.anchorId)
  if (!dropped && !anchorGone) return state
  return { selected, anchorId: anchorGone ? null : state.anchorId, rangeEndId: anchorGone ? null : state.rangeEndId }
}

/** Where the focus goes after these rows are removed: the next one left standing, else the one before. */
export function focusAfterRemoval(ordered: readonly string[], removed: ReadonlySet<string>): string | null {
  const indices = ordered.flatMap((id, index) => (removed.has(id) ? [index] : []))
  if (!indices.length) return null
  const last = indices[indices.length - 1]!
  for (let at = last + 1; at < ordered.length; at++) if (!removed.has(ordered[at]!)) return ordered[at]!
  for (let at = last - 1; at >= 0; at--) if (!removed.has(ordered[at]!)) return ordered[at]!
  return null
}

// ---- batch Send to agent ----

type BatchTask = Pick<TaskItem, "id" | "scope" | "project_id" | "runs">

/** Tasks with a live run are skipped; the rest start. Order is kept. */
export function partitionBatch<T extends BatchTask>(tasks: readonly T[]): { starting: T[]; skipped: T[] } {
  const starting: T[] = []
  const skipped: T[] = []
  for (const task of tasks) (isLiveRun(latestRun(task)) ? skipped : starting).push(task)
  return { starting, skipped }
}

/** The project a task's run happens in: its own, or the one chosen for global tasks. */
export function effectiveProject(task: Pick<BatchTask, "scope" | "project_id">, globalProject: string | null): string | null {
  return task.scope === "project" && task.project_id ? task.project_id : globalProject
}

/** The distinct projects a batch runs in, in the order they first appear. */
export function batchProjects(tasks: readonly Pick<BatchTask, "scope" | "project_id">[], globalProject: string | null): string[] {
  const projects: string[] = []
  for (const task of tasks) {
    const project = effectiveProject(task, globalProject)
    if (project && !projects.includes(project)) projects.push(project)
  }
  return projects
}

/** The task ids a message still mentions, in the order `ids` has them. */
export function mentionedTaskIds(parts: readonly ContentPart[], ids: readonly string[]): string[] {
  const named = new Set<string>()
  for (const part of parts) {
    if (part.type !== "mention") continue
    const mention = parseKybernMention(part.path)
    if (mention?.kind === "task") named.add(mention.id)
  }
  return ids.filter((id) => named.has(id))
}

/**
 * One task's copy of a batch message: the other tasks' chips come out (the daemon puts
 * this task's own chip first when the message has none), and the space each left behind goes too.
 */
export function messageForTask(parts: readonly ContentPart[], taskId: string, batchIds: readonly string[]): ContentPart[] {
  const others = new Set(batchIds.filter((id) => id !== taskId).map(taskMentionPath))
  const kept: ContentPart[] = []
  let trim = false
  for (const part of parts) {
    if (part.type === "mention" && others.has(part.path)) {
      trim = true
      continue
    }
    if (part.type === "text") {
      const text = trim ? part.text.replace(/^[ \t]/, "") : part.text
      trim = false
      const last = kept[kept.length - 1]
      if (last?.type === "text") kept[kept.length - 1] = { type: "text", text: last.text + text }
      else if (text) kept.push({ type: "text", text })
      continue
    }
    trim = false
    kept.push(part)
  }
  // Nothing before the first chip but the space the removed ones left.
  const first = kept[0]
  if (first?.type === "text") {
    const text = first.text.replace(/^\s+/, "")
    if (text) kept[0] = { type: "text", text }
    else kept.shift()
  }
  return kept
}

/** "ADE-3", "ADE-3 and ADE-4", "ADE-3, ADE-4 and ADE-14". */
export function listKeys(keys: readonly string[]): string {
  if (keys.length <= 1) return keys.join("")
  return `${keys.slice(0, -1).join(", ")} and ${keys[keys.length - 1]}`
}

export const runsLabel = (count: number): string => `${count} ${count === 1 ? "run" : "runs"}`
