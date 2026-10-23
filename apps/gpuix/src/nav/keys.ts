import { closeActiveTab, closeFocusedPane, cycleTabs, focusGroupToward, numberTab, reopenTab, splitActive } from '../tabs/open.ts'
import { paneRects } from '../split/Workspace.tsx'
// Window shortcuts (`App.tsx` `useHotkey` + `state/navigation.ts`): ⌘N new chat,
// ⌘B thread panel, ⌘K search, ⌘[ / ⌘] back and forward, ⌘↑ a subagent's
// parent, ⌘, Settings. In-thread tabs (ADE-54): ⌘1 the chat, ⌘2–⌘9 the tabs (⌘9 the
// last), ⌃Tab / ⌃⇧Tab cycle, ⌘W closes the tab (never the thread; on a split's chat
// tab, the pane), ⌘⇧W closes the focused pane, ⌘⇧T reopens the last closed one,
// ⌘\ / ⌘⇧\ move the tab into a new group (on the chat: a second thread pane), ⌘⌥←/→/↑/↓ focus the next group. They work while typing, like the desktop's
// `allowInInput`. Nothing they change animates: they set `keyboardNav` first.
//
// `main.tsx` passes `onWindowKeyDown` to `render()`. Other surfaces can add
// their own window shortcuts with `addWindowKeyHandler`; a handler that returns
// true has consumed the event.
import type { EventPayload } from '@gpuix/react'
import { toggleDock } from '../dock/store.ts'
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

/** The tab shortcuts that are not ⌘-only: ⌃Tab cycles, ⌘⌥ arrows move between groups. */
function tabShortcut(event: EventPayload): boolean {
  const m = event.modifiers
  const nav = getNav()
  if (nav.page !== 'home' || nav.settingsOpen || nav.paletteOpen) return false
  if (m?.ctrl && !m.cmd && !m.alt && event.key === 'tab') return cycleTabs(m.shift ? -1 : 1)
  if (m?.cmd && m.alt && !m.ctrl && !m.shift && (event.key === 'left' || event.key === 'right' || event.key === 'up' || event.key === 'down')) return focusGroupToward(event.key, paneRects())
  return false
}

function shortcut(event: EventPayload): boolean {
  const m = event.modifiers
  if (!m?.cmd || m.ctrl || m.alt) return false
  const key = event.key
  const nav = getNav()
  const home = nav.page === 'home' && !nav.settingsOpen
  if (key === '\\' && home && !nav.paletteOpen) { splitActive(m.shift ? 'vertical' : 'horizontal'); return true }
  if (key === 't' && m.shift && home && !nav.paletteOpen) return reopenTab()
  if (key === 'w' && m.shift && home && !nav.paletteOpen) return closeFocusedPane()
  if (m.shift) return false
  if (home && !nav.paletteOpen && key && /^[1-9]$/.test(key)) return numberTab(Number(key))
  if (key === 'w' && home && !nav.paletteOpen) return closeActiveTab()
  switch (key) {
    case 'k':
      setNav({ paletteOpen: !nav.paletteOpen })
      return true
    case 'n':
      setNav({ settingsOpen: false, paletteOpen: false })
      newThread()
      return true
    case 'b':
      if (nav.settingsOpen || nav.page === 'notes' || nav.page === 'usage') return false
      if (nav.page === 'pulls') setNav({ pullsPeek: !nav.pullsPeek, panelInstant: true })
      else {
        setNav({ panelInstant: true })
        set({ sidebarOpen: !getState().sidebarOpen })
      }
      return true
    case 'j':
      if (nav.settingsOpen || nav.page !== 'home') return false
      toggleDock(true)
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
  if (!shortcut(event) && !tabShortcut(event) && !before) setNav({ keyboardNav: false })
}

const isShortcut = (event: EventPayload) => {
  const m = event.modifiers
  if (m?.ctrl && !m.cmd && !m.alt && event.key === 'tab') return true
  if (m?.cmd && m.alt && !m.ctrl && (event.key === 'left' || event.key === 'right' || event.key === 'up' || event.key === 'down')) return true
  return !!m?.cmd && !m.ctrl && !m.alt && (!m.shift || event.key === '\\' || event.key === 't' || event.key === 'w')
}
