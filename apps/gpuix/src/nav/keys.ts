// Window shortcuts (`App.tsx` `useHotkey` + `state/navigation.ts`): ⌘N new chat,
// ⌘B thread panel, ⌘K search, ⌘[ / ⌘] back and forward, ⌘↑ a subagent's
// parent, ⌘, Settings. They work while typing, like the desktop's
// `allowInInput`. Nothing they change animates: they set `keyboardNav` first.
//
// `main.tsx` passes `onWindowKeyDown` to `render()`. Other surfaces can add
// their own window shortcuts with `addWindowKeyHandler`; a handler that returns
// true has consumed the event.
import type { EventPayload } from '@gpuix/react'
import { getState, set } from '../state.ts'
import { goBack, goForward, newThread, openThread } from './history.ts'
import { getNav, setNav } from './store.ts'

type Handler = (event: EventPayload) => boolean | void
const handlers = new Set<Handler>()

export function addWindowKeyHandler(handler: Handler): () => void {
  handlers.add(handler)
  return () => handlers.delete(handler)
}

/** The selected thread's parent, when it is a provider subagent (`openParentShortcut`). */
function subagentParent(): string | null {
  const id = getState().selectedId
  if (!id) return null
  const thread = getNav().children[id] ?? getState().threads.find((t) => t.id === id) ?? getState().open.thread
  return thread?.subagent && thread.parent_thread_id ? thread.parent_thread_id : null
}

function shortcut(event: EventPayload): boolean {
  const m = event.modifiers
  if (!m?.cmd || m.ctrl || m.alt) return false
  const key = event.key
  const nav = getNav()
  if (m.shift) return false
  switch (key) {
    case 'k':
      setNav({ paletteOpen: !nav.paletteOpen })
      return true
    case 'n':
      setNav({ settingsOpen: false, paletteOpen: false })
      newThread()
      return true
    case 'b':
      if (nav.settingsOpen || nav.page === 'notes') return false
      if (nav.page === 'pulls') setNav({ pullsPeek: !nav.pullsPeek, panelInstant: true })
      else {
        setNav({ panelInstant: true })
        set({ sidebarOpen: !getState().sidebarOpen })
      }
      return true
    case '[':
      if (nav.paletteOpen) return false
      goBack()
      return true
    case ']':
      if (nav.paletteOpen) return false
      goForward()
      return true
    case 'up': {
      if (nav.settingsOpen || nav.page !== 'home') return false
      const parent = subagentParent()
      if (!parent) return false
      openThread(parent)
      return true
    }
    case ',':
      setNav({ settingsOpen: true, paletteOpen: false })
      return true
  }
  return false
}

export function onWindowKeyDown(event: EventPayload) {
  if (event.isHeld) return
  for (const handler of handlers) if (handler(event)) return
  // Mark the change as keyboard-driven before it lands, so nothing it opens animates.
  const before = getNav().keyboardNav
  if (isShortcut(event)) setNav({ keyboardNav: true })
  if (!shortcut(event) && !before) setNav({ keyboardNav: false })
}

const isShortcut = (event: EventPayload) => !!event.modifiers?.cmd && !event.modifiers.ctrl && !event.modifiers.alt && !event.modifiers.shift
