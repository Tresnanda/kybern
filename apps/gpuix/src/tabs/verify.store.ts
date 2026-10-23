// The tab group store in a scratch process (run by `store.test.ts`): a saved v1 split migrates to groups, openers, preview
// replacement, dedupe, split/move between groups, close and reopen, a pane changing thread, and the v2 write.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const file = path.join(process.env.KYBERN_DATA_DIR!, 'gpuix-ui.json')
const leaf = (id: string, threadId: string | null) => ({ kind: 'leaf', id, threadId })
writeFileSync(file, JSON.stringify({
  'kybern.split-view.v1': { version: 1, root: { kind: 'split', id: 's', direction: 'horizontal', ratio: 0.5, first: leaf('a', 't1'), second: leaf('b', 't2') }, focusedPaneId: 'a' },
  'kybern.tabs.threads': [['t1', { tabs: [{ kind: 'chat' }, { kind: 'file', path: 'x.ts', root: 'project' }], active: 'file:project:x.ts' }]],
}))

const state = await import('../state.ts')
const split = await import('../split/store.ts')
const tabs = await import('./open.ts')
const { flush } = await import('../shell/persist.ts')
const keys = (id: string) => split.getGroup(id).tabs.map((t) => (t.kind === 'file' ? t.path : t.kind))

split.startSplitView()
// v1 → groups: each leaf takes its thread's remembered tabs.
assert.deepEqual(keys('a'), ['chat', 'x.ts'])
assert.equal(split.getGroup('a').active, 'file:project:x.ts')
assert.deepEqual(keys('b'), ['chat'])
console.log('PASS v1 migration')

// Preview opens replace each other; a permanent open keeps the tab; reopening focuses it.
state.focusPane('a')
tabs.openTab('t1', { kind: 'file', path: 'y.ts', root: 'project' }, { preview: true })
tabs.openTab('t1', { kind: 'file', path: 'z.ts', root: 'project' }, { preview: true })
assert.deepEqual(keys('a'), ['chat', 'x.ts', 'z.ts'])
assert.equal(split.getGroup('a').preview, 'file:project:z.ts')
tabs.openTab('t1', { kind: 'file', path: 'x.ts', root: 'project', line: 4 })
assert.equal(split.getGroup('a').active, 'file:project:x.ts')
assert.equal(keys('a').length, 3)
// A thread off screen remembers the tab for later.
tabs.openTab('t9', { kind: 'preview' })
assert.deepEqual(split.getMemory('t9')!.tabs.map((t) => t.kind), ['chat', 'preview'])
console.log('PASS open, preview replace, dedupe, off-screen memory')

// ⌘\ on a document: it moves into a new group of the same thread; the 2×2 limit holds.
assert.equal(tabs.splitActive('vertical'), true)
const third = split.collectThreadPanes(split.getSplitRoot()).map((l) => l.id).find((id) => id !== 'a' && id !== 'b')!
assert.deepEqual(keys(third), ['x.ts'])
assert.deepEqual(keys('a'), ['chat', 'z.ts'])
assert.equal(state.getFocusedPaneId(), third)
// Dropping it back on the first strip moves it and closes the emptied group.
assert.equal(split.moveTabToGroup(third, 'file:project:x.ts', 'a', 1), true)
assert.equal(split.collectThreadPanes(split.getSplitRoot()).length, 2)
assert.deepEqual(keys('a'), ['chat', 'x.ts', 'z.ts'])
// Threads never mix.
assert.equal(split.moveTabToGroup('a', 'file:project:x.ts', 'b'), false)
console.log('PASS split a tab off, move it back, no cross-thread moves')

// ⌘W closes the active document, never the chat; ⌘⇧T brings it back where it was.
state.focusPane('a')
tabs.selectTab('a', 'file:project:x.ts')
assert.equal(tabs.closeActiveTab(), true)
assert.deepEqual(keys('a'), ['chat', 'z.ts'])
assert.equal(tabs.reopenTab(), true)
assert.deepEqual(keys('a'), ['chat', 'x.ts', 'z.ts'])
tabs.selectTab('a', 'chat')
assert.equal(tabs.numberTab(9), true)
assert.equal(split.getGroup('a').active, 'file:project:z.ts')
assert.equal(tabs.cycleTabs(1), true)
assert.equal(split.getGroup('a').active, 'chat')
console.log('PASS close, reopen, ⌘1–9, cycle')

// A pane that shows another thread hands its tabs back to the thread and loads the other thread's.
void state.selectPaneThread('a', 't3')
assert.equal(split.getGroup('a').threadId, 't3')
assert.deepEqual(keys('a'), ['chat'])
assert.deepEqual(split.getMemory('t1')!.tabs.map((t) => (t.kind === 'file' ? t.path : t.kind)), ['chat', 'x.ts', 'z.ts'])
void state.selectPaneThread('a', 't1')
assert.deepEqual(keys('a'), ['chat', 'x.ts', 'z.ts'])
console.log('PASS pane retarget and per-thread memory')

flush()
const saved = JSON.parse(readFileSync(file, 'utf8'))
assert.equal(saved['kybern.split-view.v2'].version, 2)
assert.deepEqual(Object.keys(saved['kybern.split-view.v2'].groups).sort(), ['a', 'b'])
assert.equal(saved['kybern.split-view.v2'].groups.a.threadId, 't1')
assert.ok(saved['kybern.tabs.threads'].some(([id]: [string]) => id === 't9'))
console.log('PASS v2 persistence')

// ADE-67: in a split, ⌘W on the chat tab closes that pane (not the window) and ⌘⇧W closes the focused pane; in a single pane
// ⌘W on the chat returns false (the window closes) and ⌘⇧W does nothing. Neither acts while the tabs are off screen.
const { onWindowKeyDown } = await import('../nav/keys.ts')
const { setNav } = await import('../nav/store.ts')
const panes = () => split.collectThreadPanes(split.getSplitRoot()).map((l) => l.id)
const press = (key: string, shift = false) => onWindowKeyDown({ key, modifiers: { cmd: true, shift, ctrl: false, alt: false } } as never)
assert.deepEqual(panes(), ['a', 'b'])
state.focusPane('b')
setNav({ paletteOpen: true })
assert.equal(tabs.closeFocusedPane(), false)
assert.equal(tabs.closeActiveTab(), false)
setNav({ paletteOpen: false })
assert.deepEqual(panes(), ['a', 'b'])
assert.equal(tabs.closeActiveTab(), true)
assert.deepEqual(panes(), ['a'])
assert.equal(state.getFocusedPaneId(), 'a')
assert.equal(tabs.closeActiveTab(), false)
assert.equal(tabs.closeFocusedPane(), false)
console.log('PASS ⌘W on a split chat closes the pane, single pane unchanged')
assert.equal(tabs.splitActive('horizontal'), true)
const second = panes().find((id) => id !== 'a')!
state.focusPane(second)
press('w', true)
assert.deepEqual(panes(), ['a'])
press('w', true)
assert.deepEqual(panes(), ['a'])
// ⌘⇧W on a document tab still closes the whole pane (the tabs join the thread's other group or its memory).
assert.equal(tabs.splitActive('horizontal'), true)
state.focusPane('a')
tabs.selectTab('a', 'file:project:x.ts')
press('w', true)
assert.equal(panes().length, 1)
assert.notEqual(panes()[0], 'a')
console.log('PASS ⌘⇧W closes the focused pane')
process.exit(0)
