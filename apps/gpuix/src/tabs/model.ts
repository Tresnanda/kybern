// In-thread tabs (ADE-54): the pure model behind every tab strip of a thread.
//
// A window is one split tree (`split/store.ts`) whose leaves are tab groups. Every group belongs to one thread and holds
// some of that thread's tabs; a tab lives in one group at a time, and the chat tab (the thread itself) cannot close.
// What a thread had open is remembered per thread (`memory`), so leaving and coming back, or a restart, restores it.
// Nothing here touches React, the daemon or disk: `split/store.ts` owns the state and persistence, and calls these.

export type Tab =
  | { kind: 'chat' }
  /** `root: 'project'` reads through `files.read` (Explorer paths); `'thread'` through `threads.files.read` (chat links). */
  | { kind: 'file'; path: string; root: 'project' | 'thread'; line?: number }
  /** One file's diff, or the whole change set without `path`. */
  | { kind: 'diff'; path?: string }
  | { kind: 'terminal'; id: string; title?: string; cli?: string }
  | { kind: 'preview' }
  | { kind: 'review' }
  | { kind: 'pr'; projectId: string; number: number; title?: string }
  | { kind: 'note'; id: string; title?: string }
  | { kind: 'task'; id: string; title?: string }
  | { kind: 'visual'; id: string; title?: string }
  | { kind: 'artifact'; path: string; title?: string; url?: string }
  | { kind: 'mermaid'; code: string; title?: string }
  | { kind: 'image'; source: string; label?: string }
  /** A pinned child thread (native subagent, delegated agent or helper). */
  | { kind: 'thread'; id: string; title?: string }

export type TabKind = Tab['kind']
export const CHAT = 'chat'
export const CHAT_TAB: Tab = { kind: 'chat' }

/** A tab group: the tabs of one split leaf, in strip order. `preview` is the italic tab the next preview open replaces. */
export interface Group {
  tabs: Tab[]
  active: string
  preview: string | null
}
/** A leaf's group and the thread it shows (`null`: home or an empty pane, no strip). */
export interface GroupRecord extends Group {
  threadId: string | null
}
/** What a thread had open, restored when it is shown again. */
export type Memory = Map<string, Group>

/** One string per openable thing: reopening it focuses the existing tab. */
export function tabKey(tab: Tab): string {
  switch (tab.kind) {
    case 'chat': case 'preview': case 'review': return tab.kind
    case 'file': return `file:${tab.root}:${tab.path}`
    case 'diff': return `diff:${tab.path ?? '*'}`
    case 'terminal': return `terminal:${tab.id}`
    case 'pr': return `pr:${tab.projectId}:${tab.number}`
    case 'note': case 'task': case 'visual': case 'thread': return `${tab.kind}:${tab.id}`
    case 'artifact': return `artifact:${tab.path}`
    case 'mermaid': return `mermaid:${hash(tab.code)}`
    case 'image': return `image:${tab.source}`
  }
}

/** FNV-1a: a short, stable key for content-addressed tabs (Mermaid source). */
function hash(text: string) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(36) + text.length.toString(36)
}

export const chatGroup = (): Group => ({ tabs: [CHAT_TAB], active: CHAT, preview: null })
export const hasTab = (group: Group, key: string) => group.tabs.some((tab) => tabKey(tab) === key)
export const activeTab = (group: Group): Tab => group.tabs.find((tab) => tabKey(tab) === group.active) ?? group.tabs[0] ?? CHAT_TAB

/**
 * Open `tab` in `group` and make it active. An open tab is focused (and refreshed: a new line, a title); a preview open
 * replaces the group's current preview tab in place, any other open appends. A permanent open of the preview tab keeps it.
 */
export function openIn(group: Group, tab: Tab, preview = false, activate = true): Group {
  const key = tabKey(tab)
  const at = group.tabs.findIndex((t) => tabKey(t) === key)
  if (at >= 0) {
    const tabs = group.tabs.slice()
    tabs[at] = tab
    return { tabs, active: activate ? key : group.active, preview: group.preview === key && !preview ? null : group.preview }
  }
  const replace = preview && group.preview ? group.tabs.findIndex((t) => tabKey(t) === group.preview) : -1
  const tabs = group.tabs.slice()
  if (replace >= 0) tabs[replace] = tab
  else tabs.push(tab)
  return { tabs, active: activate ? key : group.active, preview: preview ? key : replace >= 0 ? null : group.preview }
}

/** Close a tab. The chat never closes. The next tab to the right (else the left) becomes active. */
export function closeIn(group: Group, key: string): Group {
  if (key === CHAT) return group
  const at = group.tabs.findIndex((t) => tabKey(t) === key)
  if (at < 0) return group
  const tabs = group.tabs.filter((_, i) => i !== at)
  const active = group.active !== key ? group.active : tabs[Math.min(at, tabs.length - 1)] ? tabKey(tabs[Math.min(at, tabs.length - 1)]!) : CHAT
  return { tabs, active, preview: group.preview === key ? null : group.preview }
}

export const permanentIn = (group: Group, key: string): Group => group.preview === key ? { ...group, preview: null } : group
export const activateIn = (group: Group, key: string): Group => hasTab(group, key) && group.active !== key ? { ...group, active: key } : group

/** Move a tab to `to` within its group. The chat stays pinned first; a dragged tab becomes permanent. */
export function reorderIn(group: Group, key: string, to: number): Group {
  const from = group.tabs.findIndex((t) => tabKey(t) === key)
  if (from < 0 || key === CHAT) return group
  const tabs = group.tabs.filter((_, i) => i !== from)
  const floor = tabs[0] && tabKey(tabs[0]) === CHAT ? 1 : 0
  tabs.splice(Math.max(floor, Math.min(tabs.length, to)), 0, group.tabs[from]!)
  return { ...permanentIn(group, key), tabs }
}

/** ⌃Tab / ⌃⇧Tab. */
export function cycleIn(group: Group, delta: number): Group {
  const at = group.tabs.findIndex((t) => tabKey(t) === group.active)
  if (group.tabs.length < 2) return group
  const next = group.tabs[(at + delta + group.tabs.length * 2) % group.tabs.length]!
  return { ...group, active: tabKey(next) }
}

/** ⌘1 is the chat; ⌘2–⌘8 the tabs after it; ⌘9 the last tab (Safari). Out of range: unchanged. */
export function numberIn(group: Group, n: number): Group {
  if (n === 1) return hasTab(group, CHAT) ? activateIn(group, CHAT) : group.tabs[0] ? activateIn(group, tabKey(group.tabs[0])) : group
  const docs = group.tabs.filter((t) => t.kind !== 'chat')
  const target = n === 9 ? docs.at(-1) : docs[n - 2]
  return target ? activateIn(group, tabKey(target)) : group
}

/** Remove a tab from one group (to put it in another). Unlike `closeIn`, this also takes the chat. */
export function takeFrom(group: Group, key: string): Group {
  const at = group.tabs.findIndex((t) => tabKey(t) === key)
  if (at < 0) return group
  const tabs = group.tabs.filter((_, i) => i !== at)
  const next = tabs[Math.min(at, tabs.length - 1)]
  return { tabs, active: group.active === key ? next ? tabKey(next) : '' : group.active, preview: group.preview === key ? null : group.preview }
}

/** Put a tab into a group at `index` (the end by default), active. The chat goes first. */
export function putInto(group: Group, tab: Tab, index?: number): Group {
  const key = tabKey(tab)
  if (hasTab(group, key)) return activateIn(group, key)
  const tabs = group.tabs.slice()
  const floor = tabs[0] && tabKey(tabs[0]) === CHAT ? 1 : 0
  tabs.splice(tab.kind === 'chat' ? 0 : Math.max(floor, Math.min(tabs.length, index ?? tabs.length)), 0, tab)
  return { tabs, active: key, preview: group.preview }
}

/** Append another group's tabs (a group that closes, or a pane that leaves the thread). Order: the chat first, then as they were. */
export function mergeInto(target: Group, source: Group): Group {
  let next = target
  for (const tab of source.tabs) if (!hasTab(next, tabKey(tab))) next = { ...putInto(next, tab), active: next.active }
  return { ...next, preview: next.preview ?? (source.preview && hasTab(next, source.preview) ? source.preview : null) }
}

/** The union of a thread's groups, in group order: what the thread remembers. `focused` names the group whose active tab wins. */
export function unionOf(groups: Group[], focused?: Group): Group {
  if (!groups.length) return chatGroup()
  let union: Group = { tabs: [], active: '', preview: null }
  for (const group of groups) union = mergeInto(union, group)
  const lead = focused ?? groups[0]!
  return { ...union, active: lead.active || tabKey(union.tabs[0] ?? CHAT_TAB), preview: lead.preview }
}

/** A remembered group always carries the chat (first), and an active tab that exists. */
export function normalize(group: Group): Group {
  const tabs = hasTab(group, CHAT) ? group.tabs : [CHAT_TAB, ...group.tabs]
  const fixed = { ...group, tabs }
  return { ...fixed, active: hasTab(fixed, group.active) ? group.active : CHAT, preview: group.preview && hasTab(fixed, group.preview) ? group.preview : null }
}

// --- Cross-group operations over one window's leaves ------------------------------------------------------------------

export type Groups = Record<string, GroupRecord>

const groupsOf = (groups: Groups, threadId: string, except?: string) => Object.entries(groups).filter(([id, g]) => id !== except && g.threadId === threadId)

/**
 * Leaf `leafId` now shows `threadId`. The tabs it held go back to its old thread: into another group of that thread when one is
 * on screen (nothing is lost, the chat included), else into the thread's memory. It takes the new thread's remembered tabs that
 * no other group holds; when another group already shows the thread, it takes only the chat (moved from that group), and a group
 * the move leaves empty is listed in `emptied` for the caller to close.
 */
export function retarget(groups: Groups, memory: Memory, leafId: string, threadId: string | null): { groups: Groups; emptied: string[] } {
  const current = groups[leafId]
  if (current && current.threadId === threadId) return { groups, emptied: [] }
  let next: Groups = { ...groups }
  delete next[leafId]
  if (current?.threadId) next = release(next, memory, current.threadId, current)
  if (!threadId) { next[leafId] = { threadId: null, ...chatGroup() }; return { groups: next, emptied: [] } }
  const others = groupsOf(next, threadId)
  if (!others.length) {
    next[leafId] = { threadId, ...normalize(memory.get(threadId) ?? chatGroup()) }
    return { groups: next, emptied: [] }
  }
  const emptied: string[] = []
  const holder = others.find(([, g]) => hasTab(g, CHAT))
  if (holder) {
    const [id, g] = holder
    const rest = takeFrom(g, CHAT)
    // An emptied group stays (without tabs) until the caller closes its pane, so the leaf still names its thread.
    next[id] = { ...g, ...rest }
    if (!rest.tabs.length) emptied.push(id)
  }
  next[leafId] = { threadId, ...chatGroup() }
  return { groups: next, emptied }
}

/** A group leaves the window (closed pane): its tabs join another group of its thread, or the thread's memory. */
export function release(groups: Groups, memory: Memory, threadId: string, group: Group): Groups {
  const others = groupsOf(groups, threadId)
  if (others.length) {
    const target = others.find(([, g]) => hasTab(g, CHAT)) ?? others[0]!
    return { ...groups, [target[0]]: { ...target[1], ...mergeInto(target[1], group) } }
  }
  memory.set(threadId, normalize(group))
  return groups
}

/**
 * Move a tab between two groups of the same thread (a drag onto another strip, or ⌘\ into a new group). A group left without
 * tabs is listed in `emptied` (kept without tabs for the caller to close). Threads never mix: a move across threads is refused (returns the input).
 */
export function moveBetween(groups: Groups, from: string, key: string, to: string, index?: number): { groups: Groups; emptied: string[] } {
  const source = groups[from], target = groups[to]
  if (!source || !target || from === to || !source.threadId || source.threadId !== target.threadId) return { groups, emptied: [] }
  const tab = source.tabs.find((t) => tabKey(t) === key)
  if (!tab) return { groups, emptied: [] }
  const rest = takeFrom(source, key)
  const next: Groups = { ...groups, [to]: { ...target, ...putInto(target, tab, index) } }
  next[from] = { ...source, ...rest }
  return { groups: next, emptied: rest.tabs.length ? [] : [from] }
}

/** Remember every on-screen thread's union into `memory`. `focusedLeaf` decides the active tab of its own thread. */
export function remember(groups: Groups, memory: Memory, focusedLeaf?: string) {
  const threads = new Set(Object.values(groups).map((g) => g.threadId).filter((id): id is string => !!id))
  for (const threadId of threads) {
    const own = groupsOf(groups, threadId)
    const focused = own.find(([id]) => id === focusedLeaf)?.[1]
    memory.delete(threadId)
    memory.set(threadId, normalize(unionOf(own.map(([, g]) => g), focused)))
  }
}

// --- Persistence ------------------------------------------------------------------------------------------------------

const KINDS: Record<TabKind, (t: Record<string, unknown>) => boolean> = {
  chat: () => true,
  preview: () => true,
  review: () => true,
  file: (t) => typeof t.path === 'string' && (t.root === 'project' || t.root === 'thread') && (t.line === undefined || Number.isInteger(t.line)),
  diff: (t) => t.path === undefined || typeof t.path === 'string',
  terminal: (t) => typeof t.id === 'string',
  pr: (t) => typeof t.projectId === 'string' && Number.isInteger(t.number),
  note: (t) => typeof t.id === 'string',
  task: (t) => typeof t.id === 'string',
  visual: (t) => typeof t.id === 'string',
  thread: (t) => typeof t.id === 'string',
  artifact: (t) => typeof t.path === 'string',
  mermaid: (t) => typeof t.code === 'string' && t.code.length <= 64_000,
  image: (t) => typeof t.source === 'string',
}

export function validTab(value: unknown): value is Tab {
  if (!value || typeof value !== 'object') return false
  const t = value as Record<string, unknown>
  const check = KINDS[t.kind as TabKind]
  return !!check && check(t)
}

/** A stored group, cleaned: unknown tabs dropped, duplicates removed, a missing active tab repaired. `null` when unusable. */
export function readGroup(value: unknown): Group | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as { tabs?: unknown; active?: unknown; preview?: unknown }
  if (!Array.isArray(raw.tabs)) return null
  const seen = new Set<string>()
  const tabs = raw.tabs.filter(validTab).filter((tab) => { const key = tabKey(tab); if (seen.has(key)) return false; seen.add(key); return true })
  if (!tabs.length) return null
  const active = typeof raw.active === 'string' && seen.has(raw.active) ? raw.active : tabKey(tabs[0]!)
  const preview = typeof raw.preview === 'string' && seen.has(raw.preview) ? raw.preview : null
  return { tabs, active, preview }
}

export const MEMORY_LIMIT = 80

/** `[threadId, group][]`, oldest first (an LRU like the dock's choices). */
export function readMemory(value: unknown): Memory {
  const memory: Memory = new Map()
  if (!Array.isArray(value)) return memory
  for (const entry of value.slice(-MEMORY_LIMIT)) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue
    const group = readGroup(entry[1])
    if (group) memory.set(entry[0], normalize(group))
  }
  return memory
}

export function writeMemory(memory: Memory): [string, Group][] {
  while (memory.size > MEMORY_LIMIT) memory.delete(memory.keys().next().value!)
  return [...memory]
}
