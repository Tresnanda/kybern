// The view each environment was last showing (desktop `readWorkspace`/`persistWorkspace`: `selected`),
// kept with that environment's other UI state in `shell/persist.ts`, so switching back, or relaunching
// into it, lands on the same page, thread or draft instead of Home.
import { load, save } from '../shell/persist.ts'
import type { NavEntry } from '../nav/store.ts'

const KEY = 'kybern.workspace.selected'
const PAGES = ['notes', 'tasks', 'pulls', 'usage'] as const

/** The saved view if it is one the desktop would accept (`validSelection`). */
export function loadView(): NavEntry | null {
  const value = load<unknown>(KEY, null) as Record<string, unknown> | null
  if (!value || typeof value !== 'object') return null
  if (value.kind === 'thread' && typeof value.id === 'string') return { kind: 'thread', id: value.id }
  if (value.kind === 'draft' && value.draft && typeof value.draft === 'object') {
    const draft = value.draft as { projectId?: unknown; purpose?: unknown }
    return { kind: 'draft', draft: { ...(typeof draft.projectId === 'string' ? { projectId: draft.projectId } : {}), ...(draft.purpose === 'thread' || draft.purpose === 'coordinator' ? { purpose: draft.purpose } : {}) } }
  }
  return PAGES.includes(value.kind as never) ? { kind: value.kind as (typeof PAGES)[number] } : null
}

export function saveView(entry: NavEntry) { save(KEY, entry) }
