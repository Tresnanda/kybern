// Back and forward history for the main view. Pure helpers, so the stack rules are
// testable without React or the store. The store records an entry whenever its
// `selected` view changes; `navigation.ts` walks the stack and validates entries.
//
// Entries are the main views only. Settings, dock and panel state, split layout
// and scroll position are deliberately not history.

import type { AppState } from "./store"

/** A view the user can go back to: everything `selected` can be except "none". */
export type NavEntry = Exclude<AppState["selected"], { kind: "none" }>

export interface NavHistory {
  /** Oldest first. */
  readonly entries: readonly NavEntry[]
  /** The entry for the view on screen, or -1 before the first view. */
  readonly index: number
}

/** Not persisted: history starts fresh with each window. */
export const NAV_HISTORY_LIMIT = 50

export const EMPTY_NAV_HISTORY: NavHistory = { entries: [], index: -1 }

/**
 * `push` adds a step. `replace` swaps the current step, for automatic selections
 * (boot, a removed project, a draft that became a thread) that were not the user's move.
 */
export type NavMode = "push" | "replace"

/** The history entry for a selection, or null when it is not a place to return to. */
export function navEntryFromSelected(selected: AppState["selected"]): NavEntry | null {
  switch (selected.kind) {
    case "none":
      return null
    case "thread":
    case "draft":
    case "pulls":
    case "usage":
    case "notes":
    case "tasks":
      return selected
    default:
      return assertNever(selected)
  }
}

/** Identity of a view; two entries with the same key show the same page. */
export function navEntryKey(entry: NavEntry): string {
  switch (entry.kind) {
    case "thread":
      return `thread:${entry.id}`
    case "draft":
      return `draft:${entry.draft.projectId ?? ""}:${entry.draft.purpose ?? ""}`
    case "pulls":
    case "usage":
      return entry.kind
    case "notes":
      return `notes:${entry.noteId ?? ""}`
    case "tasks":
      return `tasks:${entry.taskId ?? ""}`
    default:
      return assertNever(entry)
  }
}

export function sameNavEntry(a: NavEntry | undefined, b: NavEntry | undefined): boolean {
  return !!a && !!b && navEntryKey(a) === navEntryKey(b)
}

/** Record a view change. Returns the same object when nothing changes. */
export function recordNavEntry(history: NavHistory, entry: NavEntry, mode: NavMode = "push"): NavHistory {
  const { entries, index } = history
  const current = entries[index]
  if (sameNavEntry(current, entry)) return history
  // A draft is a scratch page: choosing another project's draft, or sending it, swaps it.
  const swap = current && (mode === "replace" || (current.kind === "draft" && entry.kind === "draft"))
  if (swap) {
    const next = entries.slice()
    next[index] = entry
    // Replacing can make two neighbours identical; keep one.
    if (sameNavEntry(next[index - 1], entry)) {
      next.splice(index, 1)
      return { entries: next, index: index - 1 }
    }
    if (sameNavEntry(next[index + 1], entry) && mode === "replace") {
      next.splice(index, 1)
      return { entries: next, index }
    }
    return { entries: next, index }
  }
  // Doing something new discards the forward steps.
  const kept = entries.slice(0, index + 1)
  kept.push(entry)
  const overflow = Math.max(0, kept.length - NAV_HISTORY_LIMIT)
  return { entries: overflow ? kept.slice(overflow) : kept, index: kept.length - 1 - overflow }
}

/** Index of the nearest entry in `delta`'s direction that is still valid and is a different page. */
export function findNavTarget(history: NavHistory, delta: -1 | 1, isValid: (entry: NavEntry) => boolean): number | null {
  const current = history.entries[history.index]
  for (let i = history.index + delta; i >= 0 && i < history.entries.length; i += delta) {
    const entry = history.entries[i]!
    if (isValid(entry) && !sameNavEntry(entry, current)) return i
  }
  return null
}

export function canMoveNavHistory(history: NavHistory, delta: -1 | 1, isValid: (entry: NavEntry) => boolean): boolean {
  return findNavTarget(history, delta, isValid) !== null
}

/**
 * Step back or forward to the nearest valid entry. Invalid entries passed on the way
 * (deleted threads, notes, tasks) are dropped, so they never come back as dead stops.
 */
export function moveNavHistory(
  history: NavHistory,
  delta: -1 | 1,
  isValid: (entry: NavEntry) => boolean,
): { history: NavHistory; entry: NavEntry } | null {
  const target = findNavTarget(history, delta, isValid)
  if (target === null) return null
  const low = Math.min(history.index, target)
  const high = Math.max(history.index, target)
  const entries: NavEntry[] = []
  let removedBeforeTarget = 0
  history.entries.forEach((entry, i) => {
    const skipped = i > low && i < high && !isValid(entry)
    if (skipped) {
      if (i < target) removedBeforeTarget++
      return
    }
    entries.push(entry)
  })
  return { history: { entries, index: target - removedBeforeTarget }, entry: history.entries[target]! }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled navigation entry: ${JSON.stringify(value)}`)
}
