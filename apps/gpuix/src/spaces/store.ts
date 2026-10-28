// Spaces as the daemon reports them (`docs/specs/spaces.md` §7.2). The active
// space is client state in `nav/store.ts`; this holds only the list and whether
// the daemon has the feature.
import { useSyncExternalStore } from 'react'
import { RpcCallError } from '../../../../packages/kybern-client/src/client.ts'
import { SPACES_CHANGED_NOTIFICATION, type Project, type Space, type SpaceColor, type SpaceId, type SpaceLogo } from '../../../../packages/kybern-client/src/types.ts'
import { SPACE_COPY } from '../../../../packages/kybern-client/src/spaces.ts'
import { onEnvironmentChange } from '../shell/environment.ts'
import { toast } from '../shell/toasts.tsx'
import { getClient, getState, refreshLists, set, setForeignSpace } from '../state.ts'
import { getNav, setNav } from '../nav/store.ts'
import { markSpaceCreated } from './ui.ts'

const METHOD_NOT_FOUND = -32601

export interface SpacesState {
  /** `null` until the first `spaces.list` answers; `false` on a daemon without spaces. */
  supported: boolean | null
  spaces: Space[]
}

let state: SpacesState = { supported: null, spaces: [] }
const listeners = new Set<() => void>()

export const getSpaces = () => state

// Another machine's projects have no space here: they are listed in the default space (`state.ts`).
setForeignSpace(() => state.supported ? (state.spaces[0]?.id ?? null) : null)

/** Replace the state wholesale (tests and automation). */
export const setSpacesState = (next: SpacesState) => setSpaces(next)

function setSpaces(next: SpacesState) {
  if (next.supported === state.supported && next.spaces === state.spaces) return
  state = next
  for (const listener of listeners) listener()
}

export function subscribeSpaces(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useSpaces<T>(select: (s: SpacesState) => T): T {
  return useSyncExternalStore(subscribeSpaces, () => select(state))
}

/** The list replaces the old one only when a space actually differs, so quiet notifications wake nothing. */
function sameSpaces(a: Space[], b: Space[]): boolean {
  return a.length === b.length && a.every((space, i) => {
    const other = b[i]!
    return space.id === other.id && space.updated_at === other.updated_at && space.position === other.position && space.name === other.name
  })
}

function adopt(spaces: Space[]) {
  setSpaces({ supported: true, spaces: sameSpaces(state.spaces, spaces) ? state.spaces : spaces })
}

/** Read the spaces once per connection. Any failure but "no such method" leaves `supported` null to retry on the next open. */
export async function loadSpaces(): Promise<void> {
  const client = getClient()
  if (!client) return
  try {
    const result = await client.call('spaces.list', {})
    if (getClient() === client) adopt(result.spaces)
  } catch (error) {
    if (getClient() !== client) return
    if (error instanceof RpcCallError && error.code === METHOD_NOT_FOUND) setSpaces({ supported: false, spaces: [] })
  }
}

let stopNotifications: (() => void) | undefined
/** Follow `spaces.changed` from any client. Called with each fresh connection (`nav/live.ts`). */
export function followSpaces(): () => void {
  const client = getClient()
  if (!client) return () => {}
  stopNotifications?.()
  stopNotifications = client.onNotification(SPACES_CHANGED_NOTIFICATION, (params) => {
    if (getClient() !== client) return
    const spaces = (params as { spaces?: Space[] } | null)?.spaces
    if (Array.isArray(spaces)) adopt(spaces)
  })
  return () => { stopNotifications?.(); stopNotifications = undefined }
}

// ---- actions ----

function requireClient() {
  const client = getClient()
  if (!client) throw new Error(SPACE_COPY.saveFailure)
  return client
}

export async function createSpace(name: string, color?: SpaceColor, logo?: SpaceLogo, options: { pop?: boolean } = {}): Promise<Space> {
  const space = await requireClient().call('spaces.create', { name, ...(color ? { color } : {}), ...(logo ? { logo } : {}) })
  // The tile this window's pointer created pops in once (`takeSpaceCreated`); remote creates do not.
  if (options.pop) markSpaceCreated(space.id)
  // Applied now, so this window does not wait for the notification; it carries the same list.
  if (!state.spaces.some((s) => s.id === space.id)) adopt([...state.spaces, space].sort((a, b) => a.position - b.position))
  return space
}

export async function updateSpace(spaceId: SpaceId, patch: { name?: string; color?: SpaceColor; logo?: SpaceLogo }): Promise<Space> {
  const space = await requireClient().call('spaces.update', { space_id: spaceId, ...patch })
  adopt(state.spaces.map((s) => (s.id === space.id ? space : s)))
  return space
}

/** Deletes a space and returns where its projects went. The caller settles the active space. */
export async function deleteSpace(spaceId: SpaceId) {
  const result = await requireClient().call('spaces.delete', { space_id: spaceId })
  const remaining = state.spaces.filter((s) => s.id !== spaceId).map((s, position) => ({ ...s, position }))
  adopt(remaining)
  // The projects moved on the daemon; their notification follows, but this window need not wait for it.
  set({ projects: getState().projects.map((p) => (p.space_id === spaceId ? { ...p, space_id: result.moved_to } : p)) })
  return result
}

/** Move `spaceId` one place up or down the rail. */
export async function moveSpace(spaceId: SpaceId, delta: -1 | 1): Promise<void> {
  const ids = state.spaces.map((s) => s.id)
  const from = ids.indexOf(spaceId)
  const to = from + delta
  if (from < 0 || to < 0 || to >= ids.length) return
  ;[ids[from], ids[to]] = [ids[to]!, ids[from]!]
  const result = await requireClient().call('spaces.reorder', { space_ids: ids })
  adopt(result.spaces)
}

/** Put a project's id at the end of the reader's order, after the target space's ordered projects. */
function moveToEndOfOrder(projectId: string) {
  const projectOrder = getNav().projectOrder.filter((id) => id !== projectId)
  projectOrder.push(projectId)
  setNav({ projectOrder })
}

/**
 * Move a project to another space (§7.9): the list updates at once and reverts if the
 * daemon refuses. The success toast offers Undo, which moves it back without a toast of its own.
 */
export async function moveProjectToSpace(project: Pick<Project, 'id' | 'name'>, target: Space, options: { undo?: boolean } = {}): Promise<boolean> {
  const client = getClient()
  const before = getState().projects.find((p) => p.id === project.id)
  if (!client || !before || before.space_id === target.id) return false
  const previous = before.space_id ?? null
  const orderBefore = getNav().projectOrder
  const patch = (spaceId: string | null) => set({ projects: getState().projects.map((p) => (p.id === project.id ? { ...p, space_id: spaceId } : p)) })
  patch(target.id)
  moveToEndOfOrder(project.id)
  try {
    await client.call('projects.update', { project_id: project.id, space_id: target.id })
  } catch {
    patch(previous)
    setNav({ projectOrder: orderBefore })
    toast.error(SPACE_COPY.moveFailure(project.name))
    return false
  }
  void refreshLists()
  if (options.undo !== false) {
    const origin = previous && state.spaces.find((s) => s.id === previous)
    toast(SPACE_COPY.movedToast(project.name, target.name), origin ? { action: { label: SPACE_COPY.undo, onClick: () => void moveProjectToSpace(project, origin, { undo: false }) } } : undefined)
  }
  return true
}

onEnvironmentChange(() => { stopNotifications = undefined; setSpaces({ supported: null, spaces: [] }) }, -50)
