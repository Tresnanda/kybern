// The active space (`docs/specs/spaces.md` §7.2–7.3). Client state: the daemon has no
// current space. Views follow projects, so opening anything that lives in another
// space makes that space active.
import { useMemo, useSyncExternalStore } from 'react'
import { orderProjects } from '@/state/sidebarOrganize'
import { inSpace, spaceOfProject } from '../../../../packages/kybern-client/src/spaces.ts'
import { isFreeChatProject, type Project, type Space, type SpaceId } from '../../../../packages/kybern-client/src/types.ts'
import { applyEntry, currentEntry, isNavEntryValid, newThread, sameNavEntry } from '../nav/history.ts'
import { getNav, setNav, subscribeNav, type NavEntry } from '../nav/store.ts'
import { getState, subscribe, useApp } from '../state.ts'
import { onEnvironmentChange } from '../shell/environment.ts'
import { getSpaces, subscribeSpaces } from './store.ts'

/**
 * The space to scope to. Null when the daemon has no spaces (the feature is off). While
 * the first `spaces.list` is in flight the persisted id scopes the sidebar already.
 */
export function currentSpaceId(): SpaceId | null {
  const { supported, spaces } = getSpaces()
  const saved = getNav().spaceId
  if (supported === false) return null
  if (supported === null) return saved
  if (saved && spaces.some((space) => space.id === saved)) return saved
  return spaces[0]?.id ?? null
}

function subscribeAll(listener: () => void) {
  const stops = [subscribeNav(listener), subscribeSpaces(listener)]
  return () => { for (const stop of stops) stop() }
}

export function useCurrentSpaceId(): SpaceId | null {
  return useSyncExternalStore(subscribeAll, currentSpaceId)
}

export function useCurrentSpace(): Space | null {
  const id = useCurrentSpaceId()
  const spaces = useSyncExternalStore(subscribeSpaces, () => getSpaces().spaces)
  return useMemo(() => spaces.find((space) => space.id === id) ?? null, [spaces, id])
}

/** The projects of the active space (all of them when the feature is off). Lookups by id keep using `state.projects`. */
export function useSpaceProjects(): Project[] {
  const projects = useApp((s) => s.projects)
  const spaceId = useCurrentSpaceId()
  return useMemo(() => scopedProjects(projects, spaceId), [projects, spaceId])
}

export function scopedProjects(projects: readonly Project[], spaceId: SpaceId | null): Project[] {
  return spaceId === null ? [...projects] : projects.filter((project) => isFreeChatProject(project.id) || project.space_id === spaceId)
}

/** The active space for non-React callers: this space's projects. */
export function spaceProjects(): Project[] {
  return scopedProjects(getState().projects, currentSpaceId())
}

/** Whether an item of `projectId` shows in the active space (null project, free chat and unknown projects always do). */
export const inCurrentSpace = (projectId: string | null | undefined) => inSpace(projectId, getState().projects, currentSpaceId())

// ---- switching ----

const switched = new Set<() => void>()
/** Called after a switch settles; the thread panel scrolls to its top. */
export function onSpaceSwitched(listener: () => void): () => void {
  switched.add(listener)
  return () => switched.delete(listener)
}

let switching = false

/** The project a view belongs to, when it has one. */
function entryProject(entry: NavEntry): string | undefined {
  if (entry.kind === 'draft') return entry.draft.projectId
  if (entry.kind !== 'thread') return undefined
  const s = getState()
  const thread = s.threads.find((t) => t.id === entry.id) ?? getNav().children[entry.id] ?? (s.open.thread?.id === entry.id ? s.open.thread : undefined)
  return thread?.project_id
}

/** Whether a view may be shown in `spaceId`: pages and free chat always, projects only in their own space. */
function entryBelongs(entry: NavEntry, spaceId: SpaceId): boolean {
  return inSpace(entryProject(entry), getState().projects, spaceId)
}

/** The first project of a space in the reader's order, or undefined when it has none. */
function firstProjectOf(spaceId: SpaceId): Project | undefined {
  const projects = getState().projects.filter((p) => !isFreeChatProject(p.id) && p.space_id === spaceId)
  return orderProjects(projects, getNav().projectOrder)[0]
}

/**
 * Make `id` the active space. The view it last showed comes back (when it still exists and
 * belongs to it); otherwise Home with the draft of its first project, or a free chat.
 * Nothing about a switch animates.
 */
export function switchSpace(id: SpaceId, via: 'pointer' | 'keyboard'): boolean {
  const { spaces } = getSpaces()
  if (id === currentSpaceId() || !spaces.some((space) => space.id === id)) return false
  if (via === 'keyboard') setNav({ keyboardNav: true })
  const previous = currentSpaceId()
  const entry = currentEntry()
  const spaceViews = { ...getNav().spaceViews }
  if (previous && entry && entryBelongs(entry, previous)) spaceViews[previous] = entry
  switching = true
  try {
    setNav({ spaceId: id, spaceViews, settingsOpen: false, paletteOpen: false })
    const remembered = spaceViews[id]
    if (remembered && isNavEntryValid(remembered) && entryBelongs(remembered, id)) applyEntry(remembered)
    else newThread(firstProjectOf(id)?.id)
  } finally {
    switching = false
  }
  for (const listener of switched) listener()
  return true
}

/** The space of the open view when it is not the active one. */
function followTarget(): SpaceId | null {
  const effective = currentSpaceId()
  const entry = currentEntry()
  if (!entry) return null
  const projectId = entryProject(entry)
  if (!projectId) return null
  const target = spaceOfProject(getState().projects, projectId)
  if (!target || target === effective) return null
  // Without a loaded list (null) the persisted id is only a hint; with one, the target must exist.
  const { supported, spaces } = getSpaces()
  if (supported === false) return null
  if (supported === true && !spaces.some((space) => space.id === target)) return null
  return target
}

/** Keep the active space and the open view in step, and remember each space's last view. */
function reconcile() {
  if (switching) return
  const target = followTarget()
  if (target) {
    setNav({ spaceId: target })
    return
  }
  // The effective id may be a fallback (a stale saved one): write it back so it persists.
  const effective = currentSpaceId()
  if (effective && getSpaces().supported === true && getNav().spaceId !== effective) setNav({ spaceId: effective })
  const entry = currentEntry()
  if (effective && entry && entryBelongs(entry, effective) && !sameNavEntry(getNav().spaceViews[effective], entry)) {
    setNav({ spaceViews: { ...getNav().spaceViews, [effective]: entry } })
  }
}

let stops: (() => void)[] = []
/** Start following the view. Called once by the app shell. */
export function startSpaces() {
  if (stops.length) return
  stops = [subscribe(reconcile), subscribeNav(reconcile), subscribeSpaces(reconcile)]
  reconcile()
}

onEnvironmentChange(() => { for (const stop of stops) stop(); stops = []; switching = false }, -100)
