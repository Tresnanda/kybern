import { expect, test } from 'bun:test'
import { CHAT, chatGroup, closeIn, cycleIn, moveBetween, numberIn, openIn, readGroup, readMemory, release, remember, reorderIn, retarget, tabKey, unionOf, writeMemory, type Groups, type Memory, type Tab } from './model.ts'

const file = (path: string, line?: number): Tab => ({ kind: 'file', path, root: 'project', ...(line ? { line } : {}) })
const keys = (g: { tabs: Tab[] }) => g.tabs.map(tabKey)

test('open appends, focuses and dedupes', () => {
  let g = openIn(chatGroup(), file('a.ts'))
  g = openIn(g, file('b.ts'))
  expect(keys(g)).toEqual([CHAT, 'file:project:a.ts', 'file:project:b.ts'])
  g = openIn(g, file('a.ts', 12))
  expect(keys(g)).toHaveLength(3)
  expect(g.active).toBe('file:project:a.ts')
  expect(g.tabs[1]).toEqual(file('a.ts', 12))
})

test('a preview tab is replaced by the next preview open and kept by a permanent one', () => {
  let g = openIn(chatGroup(), file('a.ts'), true)
  expect(g.preview).toBe('file:project:a.ts')
  g = openIn(g, file('b.ts'), true)
  expect(keys(g)).toEqual([CHAT, 'file:project:b.ts'])
  expect(g.preview).toBe('file:project:b.ts')
  // Reopening it for good (double click, a chat link) makes it permanent; the next preview gets a new slot.
  g = openIn(g, file('b.ts'))
  expect(g.preview).toBeNull()
  g = openIn(g, file('c.ts'), true)
  expect(keys(g)).toEqual([CHAT, 'file:project:b.ts', 'file:project:c.ts'])
  // A permanent open of something new leaves the preview slot alone.
  g = openIn(g, { kind: 'diff' })
  expect(g.preview).toBe('file:project:c.ts')
})

test('close picks the right neighbour and never closes the chat', () => {
  let g = [file('a'), file('b'), file('c')].reduce((group, tab) => openIn(group, tab), chatGroup())
  g = openIn(g, file('b'))
  g = closeIn(g, 'file:project:b')
  expect(g.active).toBe('file:project:c')
  g = closeIn(g, 'file:project:c')
  expect(g.active).toBe('file:project:a')
  expect(closeIn(g, CHAT)).toBe(g)
})

test('reorder keeps the chat pinned first; cycle and number shortcuts', () => {
  let g = [file('a'), file('b')].reduce((group, tab) => openIn(group, tab), chatGroup())
  g = reorderIn(g, 'file:project:b', 0)
  expect(keys(g)).toEqual([CHAT, 'file:project:b', 'file:project:a'])
  expect(reorderIn(g, CHAT, 2)).toBe(g)
  expect(g.active).toBe('file:project:b')
  expect(cycleIn(g, 1).active).toBe('file:project:a')
  expect(cycleIn(g, -1).active).toBe(CHAT)
  expect(cycleIn(cycleIn(g, 1), 1).active).toBe(CHAT)
  expect(numberIn(g, 1).active).toBe(CHAT)
  expect(numberIn(g, 2).active).toBe('file:project:b')
  expect(numberIn(g, 9).active).toBe('file:project:a')
  expect(numberIn(g, 5)).toBe(g)
})

test('moving a tab to another group of the same thread; threads never mix', () => {
  const g1 = openIn(chatGroup(), file('a'))
  const groups: Groups = { left: { threadId: 't', ...g1 }, right: { threadId: 't', tabs: [file('b')], active: 'file:project:b', preview: null }, other: { threadId: 'u', ...chatGroup() } }
  const moved = moveBetween(groups, 'left', 'file:project:a', 'right')
  expect(keys(moved.groups.left!)).toEqual([CHAT])
  expect(keys(moved.groups.right!)).toEqual(['file:project:b', 'file:project:a'])
  expect(moved.groups.right!.active).toBe('file:project:a')
  expect(moveBetween(groups, 'left', 'file:project:a', 'other').groups).toBe(groups)
  // The last tab leaving a group empties it, for the caller to close.
  const back = moveBetween(moved.groups, 'right', 'file:project:b', 'left')
  const last = moveBetween(back.groups, 'right', 'file:project:a', 'left')
  expect(last.emptied).toEqual(['right'])
  expect(last.groups.right!.tabs).toEqual([])
  // The chat can move too.
  expect(keys(moveBetween(groups, 'left', CHAT, 'right').groups.right!)[0]).toBe(CHAT)
})

test('a pane that changes thread returns its tabs and restores the next thread', () => {
  const memory: Memory = new Map([['u', openIn(chatGroup(), file('u.ts'))]])
  const groups: Groups = { main: { threadId: 't', ...openIn(chatGroup(), file('t.ts')) } }
  const away = retarget(groups, memory, 'main', 'u')
  expect(keys(away.groups.main!)).toEqual([CHAT, 'file:project:u.ts'])
  expect(keys(memory.get('t')!)).toEqual([CHAT, 'file:project:t.ts'])
  const home = retarget(away.groups, memory, 'main', null)
  expect(home.groups.main!.threadId).toBeNull()
  expect(keys(memory.get('u')!)).toEqual([CHAT, 'file:project:u.ts'])
})

test('a second pane on a thread already on screen takes only the chat; the emptied group is reported', () => {
  const memory: Memory = new Map()
  const groups: Groups = { a: { threadId: 't', ...chatGroup() }, b: { threadId: null, ...chatGroup() } }
  const result = retarget(groups, memory, 'b', 't')
  expect(result.emptied).toEqual(['a'])
  expect(keys(result.groups.b!)).toEqual([CHAT])
  const full: Groups = { a: { threadId: 't', ...openIn(chatGroup(), file('x')) }, b: { threadId: null, ...chatGroup() } }
  const kept = retarget(full, memory, 'b', 't')
  expect(kept.emptied).toEqual([])
  expect(keys(kept.groups.a!)).toEqual(['file:project:x'])
})

test('a closed group merges into its thread; memory is the union of every group', () => {
  const memory: Memory = new Map()
  const groups: Groups = { a: { threadId: 't', ...chatGroup() }, b: { threadId: 't', tabs: [file('b')], active: 'file:project:b', preview: null } }
  const { b, ...rest } = groups
  const merged = release(rest, memory, 't', b!)
  expect(keys(merged.a!)).toEqual([CHAT, 'file:project:b'])
  remember(groups, memory, 'b')
  expect(keys(memory.get('t')!)).toEqual([CHAT, 'file:project:b'])
  expect(memory.get('t')!.active).toBe('file:project:b')
  expect(unionOf([]).tabs).toEqual([{ kind: 'chat' }])
})

test('stored state is cleaned and bounded', () => {
  expect(readGroup({ tabs: [{ kind: 'nope' }, file('a'), file('a'), { kind: 'file', path: 1 }], active: 'missing', preview: 'file:project:a' })).toEqual({ tabs: [file('a')], active: 'file:project:a', preview: 'file:project:a' })
  expect(readGroup({ tabs: [] })).toBeNull()
  const memory = readMemory([['t', { tabs: [file('a')], active: 'file:project:a' }], 'junk', ['u', null]])
  expect(keys(memory.get('t')!)).toEqual([CHAT, 'file:project:a'])
  expect(memory.size).toBe(1)
  const many: Memory = new Map(Array.from({ length: 90 }, (_, i) => [`t${i}`, chatGroup()]))
  expect(writeMemory(many)).toHaveLength(80)
  expect(many.has('t0')).toBe(false)
})

test('content-addressed keys are stable', () => {
  expect(tabKey({ kind: 'mermaid', code: 'graph TD; a-->b' })).toBe(tabKey({ kind: 'mermaid', code: 'graph TD; a-->b' }))
  expect(tabKey({ kind: 'mermaid', code: 'graph TD; a-->b' })).not.toBe(tabKey({ kind: 'mermaid', code: 'graph TD; a-->c' }))
})
