// Which space popover or dialog is open. The rail renders them where they anchor (a tile or
// the "+" tile); the project menu and the palette open them from elsewhere through here.
import { useSyncExternalStore } from 'react'

export interface EditorRequest {
  /** `plus`: anchored to the "+" tile; a space id: to that space's tile. */
  anchor: 'plus' | string
  mode: 'create' | 'edit'
  /** Opened by the keyboard or the palette: no arrival motion. */
  still?: boolean
  /** After creating, move this project into the new space and switch to it. */
  moveProject?: { id: string; name: string }
}

interface UiState {
  editor: EditorRequest | null
  /** The space whose delete dialog is open. */
  deleting: string | null
  /** The space whose tile menu is open. */
  menu: { spaceId: string; at: { x: number; y: number } } | null
}

let state: UiState = { editor: null, deleting: null, menu: null }
const listeners = new Set<() => void>()

export const getSpaceUi = () => state

function set(patch: Partial<UiState>) {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

export function useSpaceUi<T>(select: (s: UiState) => T): T {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => select(state))
}

export const openSpaceEditor = (request: EditorRequest) => set({ editor: request, menu: null })
export const closeSpaceEditor = () => { if (state.editor) set({ editor: null }) }
export const askDeleteSpace = (spaceId: string) => set({ deleting: spaceId, menu: null })
export const closeDeleteSpace = () => { if (state.deleting) set({ deleting: null }) }
export const openSpaceMenu = (spaceId: string, at: { x: number; y: number }) => set({ menu: { spaceId, at } })
export const closeSpaceMenu = () => { if (state.menu) set({ menu: null }) }

// A tile created by this window's pointer pops in once; remote creates and keyboard ones do not.
const fresh = new Set<string>()
export const markSpaceCreated = (id: string) => { fresh.add(id) }
export const takeSpaceCreated = (id: string) => fresh.delete(id)
