import { onEnvironmentChange } from '../shell/environment.ts'
// Back and forward through the main views (`state/navHistory.ts` and
// `state/navigation.ts`). The stack rules below are the desktop's, line for line:
// its module type-imports the desktop store, which this app's typecheck cannot
// load, so it is mirrored here rather than imported. Keep the two in step.
//
// Every change of the main view is a step, recorded by one subscription rather
// than at each place that selects a view. Back/forward restore a step without
// adding one.
import { useSyncExternalStore } from 'react'
import { getState, selectDraft, selectThread, subscribe } from '../state.ts'
import { getNav, setNav, subscribeNav, type NavEntry, type NavHistory, type Page } from './store.ts'
import { loadView, saveView } from '../environments/workspace.ts'

/** Not persisted: history starts fresh with each window. */
export const NAV_HISTORY_LIMIT = 50
export type NavMode = 'push' | 'replace'

export function navEntryKey(entry: NavEntry): string {
  switch (entry.kind) {
    case 'thread':
      return `thread:${entry.id}`
    case 'draft':
      return `draft:${entry.draft.projectId ?? ''}:${entry.draft.purpose ?? ''}`
    default:
      return entry.kind
  }
}

export function sameNavEntry(a: NavEntry | undefined, b: NavEntry | undefined): boolean {
  return !!a && !!b && navEntryKey(a) === navEntryKey(b)
}

/** Record a view change. Returns the same object when nothing changes. */
export function recordNavEntry(history: NavHistory, entry: NavEntry, mode: NavMode = 'push'): NavHistory {
  const { entries, index } = history
  const current = entries[index]
  if (sameNavEntry(current, entry)) return history
  // A draft is a scratch page: choosing another project's draft, or sending it, swaps it.
  const swap = current && (mode === 'replace' || (current.kind === 'draft' && entry.kind === 'draft'))
  if (swap) {
    const next = entries.slice()
    next[index] = entry
    if (sameNavEntry(next[index - 1], entry)) {
      next.splice(index, 1)
      return { entries: next, index: index - 1 }
    }
    if (sameNavEntry(next[index + 1], entry) && mode === 'replace') {
      next.splice(index, 1)
      return { entries: next, index }
    }
    return { entries: next, index }
  }
  const kept = entries.slice(0, index + 1)
  kept.push(entry)
  const overflow = Math.max(0, kept.length - NAV_HISTORY_LIMIT)
  return { entries: overflow ? kept.slice(overflow) : kept, index: kept.length - 1 - overflow }
}

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

// ---- the store side (`state/navigation.ts`) ----

/** The view on screen, or null while nothing is chosen yet. */
export function currentEntry(): NavEntry | null {
  const page = getNav().page
  if (page !== 'home') return { kind: page }
  const s = getState()
  if (s.selectedId) return { kind: 'thread', id: s.selectedId }
  return { kind: 'draft', draft: s.draft }
}

/**
 * Whether a recorded view can still be shown. Deleted threads are skipped;
 * archived ones still open. Until the lists load nothing is dropped.
 */
export function isNavEntryValid(entry: NavEntry): boolean {
  const s = getState()
  const loaded = s.status === 'open' && (s.projects.length > 0 || s.threads.length > 0)
  if (entry.kind === 'thread') return !loaded || s.threads.some((t) => t.id === entry.id) || !!getNav().children[entry.id]
  if (entry.kind === 'draft') return !loaded || !entry.draft.projectId || s.projects.some((p) => p.id === entry.draft.projectId)
  return true
}

let restoring = false
let nextMode: NavMode = 'push'
let lastKey: string | null = null
/** Set once boot has chosen (or restored) a view; only then is the view remembered for this environment. */
let booted = false

/** Run a selection that is not the reader's own move (boot, a draft that became a thread). */
export function replaceNavigation(run: () => void) {
  const previous = nextMode
  nextMode = 'replace'
  try {
    run()
  } finally {
    nextMode = previous
  }
}

function record() {
  const entry = currentEntry()
  if (!entry) return
  const key = navEntryKey(entry)
  if (key === lastKey) return
  const previous = getNav().history.entries[getNav().history.index]
  lastKey = key
  if (entry.kind === 'thread') clearUnread(entry.id)
  if (booted) saveView(entry)
  if (restoring) return
  // A draft that was sent became this thread: the draft step is swapped, like `selectCreatedThread`.
  let mode = nextMode
  if (previous?.kind === 'draft' && entry.kind === 'thread') {
    const thread = getState().threads.find((t) => t.id === entry.id)
    if (thread && Date.now() - Date.parse(thread.created_at) < 15_000) mode = 'replace'
  }
  const history = recordNavEntry(getNav().history, entry, mode)
  if (history !== getNav().history) setNav({ history })
}

function clearUnread(id: string) {
  if (!getNav().unread[id]) return
  const unread = { ...getNav().unread }
  delete unread[id]
  setNav({ unread })
}

let started = false
let stops: (() => void)[] = []
/** Start recording history. Called once by the app shell. */
export function startNavHistory() {
  if (started) return
  started = true
  stops.push(subscribe(record), subscribeNav(record))
  // Boot picks the first project's draft (desktop `hydrate`); it is not a step to come back to.
  const stopBoot = subscribe(() => {
    const s = getState()
    if (!s.projects.length && !s.threads.length) return
    stopBoot()
    // Return to the view this environment was last showing, when it still exists (desktop `readWorkspace`).
    // An open thread comes back with the split view; the saved view adds the page it was left on.
    const saved = process.env.KYBERN_GPUIX_THREAD ? null : loadView()
    const page = saved && saved.kind !== 'thread' && saved.kind !== 'draft'
    if (saved && (page || !(s.selectedId || s.draft.projectId)) && isNavEntryValid(saved)) { replaceNavigation(() => applyEntry(saved)); booted = true; record(); return }
    if (s.selectedId || s.draft.projectId || process.env.KYBERN_GPUIX_THREAD) { booted = true; return }
    const first = s.projects[0]
    if (first) replaceNavigation(() => selectDraft(first.id))
    booted = true
  })
  stops.push(stopBoot)
  record()
}

function applyEntry(entry: NavEntry) {
  if (entry.kind === 'thread') {
    setNav({ page: 'home' })
    if (getState().selectedId !== entry.id) void selectThread(entry.id)
  } else if (entry.kind === 'draft') {
    setNav({ page: 'home' })
    selectDraft(entry.draft.projectId, entry.draft.purpose)
  } else {
    setNav({ page: entry.kind as Page })
  }
}

function move(delta: -1 | 1): boolean {
  const moved = moveNavHistory(getNav().history, delta, isNavEntryValid)
  if (!moved) return false
  restoring = true
  try {
    setNav({ history: moved.history })
    applyEntry(moved.entry)
  } finally {
    restoring = false
  }
  lastKey = navEntryKey(moved.entry)
  return true
}

/** Close Settings if it is open, otherwise step to the nearest valid view. */
export function goBack(): boolean {
  if (getNav().settingsOpen) {
    setNav({ settingsOpen: false })
    return true
  }
  return move(-1)
}

/** Forward is not offered while Settings covers the view. */
export function goForward(): boolean {
  if (getNav().settingsOpen) return false
  return move(1)
}

// 0: neither, 1: back, 2: forward, 3: both. A primitive keeps subscribers quiet
// until an arrow actually changes.
function availability(): number {
  const nav = getNav()
  const back = nav.settingsOpen || canMoveNavHistory(nav.history, -1, isNavEntryValid)
  const forward = !nav.settingsOpen && canMoveNavHistory(nav.history, 1, isNavEntryValid)
  return (back ? 1 : 0) + (forward ? 2 : 0)
}

function subscribeBoth(notify: () => void) {
  const a = subscribe(notify)
  const b = subscribeNav(notify)
  return () => {
    a()
    b()
  }
}

/** Which arrows have somewhere to go. */
export function useNavigationAvailability(): { canBack: boolean; canForward: boolean } {
  const value = useSyncExternalStore(subscribeBoth, availability)
  return { canBack: (value & 1) !== 0, canForward: (value & 2) !== 0 }
}

// ---- the actions the panel, rail, palette and shortcuts share ----

/** Open a thread on Home (a history step like any other). */
export function openThread(id: string) {
  setNav({ page: 'home', settingsOpen: false })
  if (getState().selectedId !== id) void selectThread(id)
}

/** `newThread()` (`state/nav.ts`): a project's draft, or a free chat. */
export function newThread(projectId?: string, purpose?: 'thread' | 'coordinator') {
  setNav({ page: 'home' })
  selectDraft(projectId, purpose)
}

/**
 * The rail's destinations (`NavRail.tsx` `go` + `selectHome`). From Settings,
 * Home returns to the workspace; from another page, to the chat it left; on
 * Home itself, Home starts a free chat.
 */
export function goPage(page: Page) {
  const nav = getNav()
  setNav({ settingsOpen: false })
  if (page !== 'home') return setNav({ page })
  if (nav.settingsOpen && nav.page === 'home') return
  if (nav.page === 'home') return selectDraft()
  const s = getState()
  if (s.selectedId && !s.threads.some((t) => t.id === s.selectedId) && !getNav().children[s.selectedId]) selectDraft()
  setNav({ page: 'home' })
}

onEnvironmentChange(() => { for (const stop of stops) stop(); stops = []; started = false; lastKey = null; restoring = false; nextMode = 'push'; booted = false }, -100)
