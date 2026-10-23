// Opening, closing and moving in-thread tabs (ADE-54). Every opener in the app goes through `openTab`: it finds the group that
// should hold the tab (the one that already has it, else the focused group of that thread, else the thread's first group),
// and a thread with no group on screen just remembers the tab for when it is shown.
import { getClient, getFocusedPaneId, focusPane, getPaneState, getState, getThreadOpen, selectThread, setPaneAlias } from '../state.ts'
import { bufferKey, getBuffer } from '../dock/fileBuffers.ts'
import { requestCloseDirty } from './closeDirtyRequest.ts'
import { closePane, closeTab, collectThreadPanes, getGroup, getGroups, groupsOfThread, moveTabToGroup, reopenClosedTab, splitTab, updateGroup, updateMemory, getSplitRoot, splitFocusedPane, type SplitDirection } from '../split/store.ts'
import { activateIn, CHAT, cycleIn, hasTab, normalizeTab, numberIn, openIn, permanentIn, reorderIn, tabKey, type Tab } from './model.ts'
import { getNav, setNav } from '../nav/store.ts'

/** Pane ids of child-thread tabs, mapped to the leaf that hosts them (links inside a child tab open in its host group). */
const hosts = new Map<string, string>()
export function registerHostedPane(paneId: string, leafId: string) { hosts.set(paneId, leafId); return () => { if (hosts.get(paneId) === leafId) hosts.delete(paneId) } }
export const hostLeaf = (paneId: string) => hosts.get(paneId) ?? paneId
setPaneAlias(hostLeaf)

export interface OpenOptions {
  /** A single click from a list: the italic tab the next preview open replaces. */
  preview?: boolean
  /** Focus the group (default true). */
  focus?: boolean
  /** Prefer this leaf when it shows the thread (the pane the opener lives in). */
  leaf?: string
  /** Make it the group's active tab (default true). False adds it beside the others: an agent's open never covers the chat. */
  activate?: boolean
}

/** The leaf that should take a new tab of `threadId`, or null when the thread is off screen. */
export function leafForThread(threadId: string, prefer?: string): string | null {
  const leaves = groupsOfThread(threadId)
  if (!leaves.length) return null
  const focused = getFocusedPaneId()
  if (prefer && leaves.includes(prefer)) return prefer
  return leaves.includes(focused) ? focused : leaves[0]!
}

export function openTab(threadId: string, requested: Tab, options: OpenOptions = {}): boolean {
  // One file is one tab however its path was spelled (`normalizeTab`).
  const tab = normalizeTab(requested)
  const key = tabKey(tab)
  const leaves = groupsOfThread(threadId)
  const holder = leaves.find((id) => hasTab(getGroup(id), key))
  const target = holder ?? leafForThread(threadId, options.leaf)
  const activate = options.activate !== false
  if (!target) { updateMemory(threadId, (g) => openIn(g, tab, options.preview, activate)); return false }
  updateGroup(target, (g) => openIn(g, tab, options.preview, activate))
  if (activate && options.focus !== false) focusPane(target)
  return true
}

/** Open from inside a pane (a transcript, a child tab): the thread is the pane's group's. A subagent's page has no tab strip, so
 *  what it opens (a file link, an image, a diagram) becomes a tab of its parent thread, and the pane goes to the parent (⌘[ returns). */
export function openTabFromPane(paneId: string, requested: Tab, options: OpenOptions = {}) {
  const leaf = hostLeaf(paneId)
  const pane = getPaneState(paneId)
  const threadId = getGroup(leaf).threadId ?? pane.selectedId
  if (!threadId) return false
  const thread = pane.open.thread?.id === threadId ? pane.open.thread : null
  // A thread file named by its absolute path (an agent's tool call, a chat link) is the same tab as its workspace-relative path.
  const tab = normalizeTab(requested, thread?.cwd)
  const parent = thread?.subagent ? thread.parent_thread_id : null
  if (parent) {
    const shown = groupsOfThread(parent).length > 0
    const opened = openTab(parent, tab, options)
    // `openThread` (nav/history.ts) without importing it: history → state → … → this module would be a cycle.
    if (!shown) { focusPane(leaf); setNav({ page: 'home', settingsOpen: false }); void selectThread(parent) }
    return opened
  }
  return openTab(threadId, tab, { ...options, leaf })
}

/** A preview tab the reader worked in (scroll, edit, drag) is kept. */
export function keepTab(leafId: string, key: string) { updateGroup(leafId, (g) => permanentIn(g, key)) }
export function selectTab(leafId: string, key: string) { updateGroup(leafId, (g) => activateIn(g, key)); focusPane(leafId) }
export function reorderTab(leafId: string, key: string, to: number) { updateGroup(leafId, (g) => reorderIn(g, key, to)) }
export { moveTabToGroup, splitTab }

/** The unsaved-edits buffer behind a file tab of `threadId` (`dock/fileBuffers.ts`), or null when its project is unknown. */
export function fileTabBuffer(threadId: string | null, tab: Tab): string | null {
  if (tab.kind !== 'file' || !threadId) return null
  if (tab.root === 'thread') return bufferKey({ threadId }, tab.path)
  const thread = getState().threads.find((t) => t.id === threadId) ?? getNav().children[threadId] ?? getThreadOpen(threadId)?.thread
  return thread?.project_id ? bufferKey({ projectId: thread.project_id }, tab.path) : null
}

/** Close with the tab's own clean-up: a terminal's shell is closed with its tab, as the dock's terminal tabs did. A file with
 *  unsaved edits asks first (Save / Don't save / Cancel). */
export function closeTabAction(leafId: string, key: string) {
  const group = getGroup(leafId)
  const tab = group.tabs.find((t) => tabKey(t) === key)
  if (!tab || tab.kind === 'chat') return
  if (tab.kind === 'terminal') void getClient()?.call('terminals.close', { terminal_id: tab.id }).catch(() => {})
  const buffer = fileTabBuffer(group.threadId, tab)
  if (buffer && getBuffer(buffer)?.dirty && tab.kind === 'file') {
    requestCloseDirty({ leafId, key, buffer, name: tab.path.split('/').pop() || tab.path })
    return
  }
  closeTab(leafId, key)
}

/** The focused group, when it shows a thread (keyboard shortcuts act on it). */
export function focusedGroup() {
  const leaf = getFocusedPaneId()
  const group = getGroups()[leaf]
  return group?.threadId ? { leaf, group } : null
}

/** Whether the thread page and its tabs are on screen (not another page, Settings or the palette): ⌘W and ⌘⇧T act only then. */
export function tabsInView(): boolean {
  const nav = getNav()
  return nav.page === 'home' && !nav.settingsOpen && !nav.paletteOpen
}

/** ⌘W: the focused group's active tab. On the chat tab (or an empty pane) of a split it closes the pane (ADE-67); in a single
 *  pane it returns false (the window closes), as it does while the tabs are not on screen, so a tab the reader cannot see is
 *  never closed. */
export function closeActiveTab(): boolean {
  if (!tabsInView()) return false
  const focused = focusedGroup()
  if (!focused || focused.group.active === CHAT) return closeFocusedPane()
  setNav({ keyboardNav: true })
  closeTabAction(focused.leaf, focused.group.active)
  return true
}
/** ⌘⇧W (ADE-67): close the focused pane. False in a single pane and while the tabs are not on screen. */
export function closeFocusedPane(): boolean {
  if (!tabsInView()) return false
  const leaf = getFocusedPaneId()
  const root = getSplitRoot()
  if (root.kind === 'leaf' || !collectThreadPanes(root).some((pane) => pane.id === leaf)) return false
  setNav({ keyboardNav: true })
  closePane(leaf)
  return true
}
export function reopenTab(): boolean {
  if (!tabsInView()) return false
  const focused = focusedGroup()
  return !!focused && reopenClosedTab(focused.leaf)
}
export function cycleTabs(delta: number): boolean {
  const focused = focusedGroup()
  if (!focused || focused.group.tabs.length < 2) return false
  updateGroup(focused.leaf, (g) => cycleIn(g, delta))
  return true
}
export function numberTab(n: number): boolean {
  const focused = focusedGroup()
  if (!focused) return false
  updateGroup(focused.leaf, (g) => numberIn(g, n))
  return true
}
/** ⌘\ / ⌘⇧\: a document tab moves into a new group beside; on the chat tab, today's second thread pane. */
export function splitActive(direction: SplitDirection): boolean {
  const focused = focusedGroup()
  if (focused && focused.group.active !== CHAT && splitTab(focused.leaf, focused.group.active, direction)) return true
  return splitFocusedPane(direction)
}

/** ⌘⌥←/→/↑/↓: focus the nearest group in that direction, by the groups' on-screen rects. */
export function focusGroupToward(direction: 'left' | 'right' | 'up' | 'down', rects: Map<string, { x: number; y: number; width: number; height: number }>): boolean {
  if (getSplitRoot().kind === 'leaf') return false
  const from = rects.get(getFocusedPaneId())
  if (!from) return false
  const cx = from.x + from.width / 2, cy = from.y + from.height / 2
  let best: { id: string; score: number } | null = null
  for (const [id, r] of rects) {
    if (id === getFocusedPaneId()) continue
    const x = r.x + r.width / 2, y = r.y + r.height / 2
    const dx = x - cx, dy = y - cy
    const along = direction === 'left' ? -dx : direction === 'right' ? dx : direction === 'up' ? -dy : dy
    const across = direction === 'left' || direction === 'right' ? Math.abs(dy) : Math.abs(dx)
    if (along <= 1) continue
    const score = along + across * 2
    if (!best || score < best.score) best = { id, score }
  }
  if (!best) return false
  setNav({ keyboardNav: true })
  focusPane(best.id)
  return true
}
