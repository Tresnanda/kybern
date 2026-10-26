import { closeActiveTab, closeFocusedPane, cycleTabs, focusGroupToward, numberTab, reopenTab, splitActive } from '../tabs/open.ts'
import { paneRects } from '../split/Workspace.tsx'
// Window shortcuts (`App.tsx` `useHotkey` + `state/navigation.ts`): ⌘N new chat,
// ⌘B thread panel, ⌘K search, ⌘[ / ⌘] back and forward, ⌘↑ a subagent's
// parent, ⌘, Settings. In-thread tabs (ADE-54): ⌘1 the chat, ⌘2–⌘9 the tabs (⌘9 the
// last), ⌃Tab / ⌃⇧Tab cycle, ⌘W closes the tab (never the thread; on a split's chat
// tab, the pane), ⌘⇧W closes the focused pane, ⌘⇧T reopens the last closed one,
// ⌘\ / ⌘⇧\ move the tab into a new group (on the chat: a second thread pane), ⌘⌥←/→/↑/↓ (Alt+Shift+arrows off
// macOS, `isFocusGroupModifier`) focus the next group. They work while typing, like the desktop's
// `allowInInput`. Nothing they change animates: they set `keyboardNav` first.
//
// Off macOS ⌘ is Ctrl (`platform/keys.ts`), with these exceptions: back and forward are Alt+← / Alt+→ (Ctrl+[ is Escape
// in a terminal), a subagent's parent is Alt+↑. While a terminal has focus there, Ctrl+key without Shift and Alt+key
// belong to its shell (Ctrl+C, Ctrl+K, Ctrl+W, Alt+← word left…), so no window shortcut or handler takes them; Ctrl+Tab,
// Alt+Shift+arrows and the Ctrl+Shift shortcuts still work there.
//
// `main.tsx` passes `onWindowKeyDown` to `render()`. Other surfaces can add
// their own window shortcuts with `addWindowKeyHandler`; a handler that returns
// true has consumed the event.
import type { EventPayload } from '@gpuix/react'
import { toggleDock } from '../dock/store.ts'
import { getState, set } from '../state.ts'
import { goBack, goForward, newThread, openThread } from './history.ts'
import { getNav, setNav } from './store.ts'
import { isAltOnly, isBackKey, isFocusGroupModifier, isForwardKey, isMacKeys, isOpenParentKey, isOtherCommand, isPrimary, isPrimaryChord } from '../platform/keys.ts'
import { terminalHasFocus } from '../terminal/focus.ts'

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

type Arrow = 'left' | 'right' | 'up' | 'down'
const ARROWS = new Set<string>(['left', 'right', 'up', 'down'])

/** The tab shortcuts that are not ⌘-only: ⌃Tab cycles, ⌘⌥ arrows (Alt+Shift off macOS) move between groups. */
function tabShortcut(event: EventPayload): boolean {
  const m = event.modifiers
  const nav = getNav()
  if (nav.page !== 'home' || nav.settingsOpen || nav.paletteOpen) return false
  if (m?.ctrl && !m.cmd && !m.alt && event.key === 'tab') return cycleTabs(m.shift ? -1 : 1)
  if (isFocusGroupModifier(m) && ARROWS.has(event.key ?? '')) return focusGroupToward(event.key as Arrow, paneRects())
  return false
}

/** Back, forward and a subagent's parent: ⌘[ ⌘] ⌘↑ on macOS, Alt+← Alt+→ Alt+↑ elsewhere. */
function historyShortcut(event: EventPayload): boolean {
  const nav = getNav()
  if (isBackKey(event)) { if (nav.paletteOpen) return false; goBack(); return true }
  if (isForwardKey(event)) { if (nav.paletteOpen) return false; goForward(); return true }
  if (isOpenParentKey(event)) {
    if (nav.settingsOpen || nav.page !== 'home') return false
    const parent = subagentParent()
    if (!parent) return false
    openThread(parent)
    return true
  }
  return false
}

/** Off macOS, while a terminal has focus: Ctrl+key without Shift (but not Ctrl+Tab) and Alt+key are the shell's. */
function terminalOwns(event: EventPayload): boolean {
  if (isMacKeys() || !terminalHasFocus()) return false
  const m = event.modifiers
  return (isPrimaryChord(m) && event.key !== 'tab') || isAltOnly(m)
}

function shortcut(event: EventPayload): boolean {
  const m = event.modifiers
  if (!isPrimary(m) || isOtherCommand(m) || m?.alt) return false
  const key = event.key
  const nav = getNav()
  const home = nav.page === 'home' && !nav.settingsOpen
  if (key === '\\' && home && !nav.paletteOpen) { splitActive(m?.shift ? 'vertical' : 'horizontal'); return true }
  if (key === 't' && m?.shift && home && !nav.paletteOpen) return reopenTab()
  if (key === 'w' && m?.shift && home && !nav.paletteOpen) return closeFocusedPane()
  if (m?.shift) return false
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
    case ',':
      setNav({ settingsOpen: true, paletteOpen: false })
      return true
  }
  return false
}

export function onWindowKeyDown(event: EventPayload) {
  if (event.isHeld || terminalOwns(event)) return
  for (const handler of handlers) if (handler(event)) return
  // Mark the change as keyboard-driven before it lands, so nothing it opens animates.
  const before = getNav().keyboardNav
  if (isShortcut(event)) setNav({ keyboardNav: true })
  if (!shortcut(event) && !historyShortcut(event) && !tabShortcut(event) && !before) setNav({ keyboardNav: false })
}

const isShortcut = (event: EventPayload) => {
  const m = event.modifiers
  if (m?.ctrl && !m.cmd && !m.alt && event.key === 'tab') return true
  if (isFocusGroupModifier(m, 'any') && ARROWS.has(event.key ?? '')) return true
  if (isBackKey(event) || isForwardKey(event) || isOpenParentKey(event)) return true
  return isPrimaryChord(m, { shift: 'any' }) && (!m?.shift || event.key === '\\' || event.key === 't' || event.key === 'w')
}
