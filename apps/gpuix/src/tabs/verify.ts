/**
 * In-thread tabs (ADE-54) against a scratch daemon: each scenario writes a saved layout (`kybern.split-view.v2`) into the
 * scratch data dir, launches the app in the background, drives it and screenshots the window.
 *
 *   bun src/tabs/verify.ts [--fresh] [--theme dark|light|both] [--out DIR] [scenario ...]
 *   bun src/tabs/verify.ts --down        # stop the scratch daemon
 *
 * Scratch only: `/Users/mymac/projects/ade-gpuix-scratch/tabs-ade54` (never ~/.kybern, never port 4219).
 */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { App } from '@gpuix/react/automation'
import { launchFixture } from '../requests/harness.ts'

process.env.VISUAL_SCRATCH ??= '/Users/mymac/projects/ade-gpuix-scratch/tabs-ade54'
const fixture = await import('../../visual/fixture.ts')
// After the scratch dir is set: `live.ts` reads the fixture's paths when it loads.
const { captureWindow } = await import('../transcript/live.ts')
const { DATA_DIR, CLIENT_DIR, CREDS_DIR, SCRATCH } = fixture

const args = process.argv.slice(2)
if (args.includes('--down')) { const s = fixture.readState(); fixture.stopPid(s?.daemonPid); console.log('[tabs] daemon stopped'); process.exit(0) }
const option = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const OUT = option('--out') ?? '/Users/mymac/projects/ade/.kybern-artifacts/ade-54-58/L3'
const themes = (option('--theme') ?? 'dark') === 'both' ? ['dark', 'light'] : [option('--theme') ?? 'dark']
const only = args.filter((a, i) => !a.startsWith('--') && !['--out', '--theme'].includes(args[i - 1] ?? ''))
mkdirSync(OUT, { recursive: true })

let state = await fixture.startDaemon(args.includes('--fresh'))
if (!state.seeded) { await fixture.seed(state); state = fixture.readState()! }
const client = await fixture.connect(state)
const { threads } = await client.call('threads.list', { include_subagents: true })
const byTitle = (title: string) => { const t = threads.find((th) => th.title === title); assert.ok(t, `thread ${title}`); return t! }
const main = byTitle('Date helper cleanup')
const changes = byTitle('Inline file changes')
const parent = byTitle('Native subagents')
const child = threads.find((th) => th.parent_thread_id === parent.id && th.subagent)!
const other = byTitle('Long review thread')
const { notes } = await client.call('notes.list', {})
const note = notes.find((n) => n.title === 'Design review notes') ?? notes[0]!
const { tasks } = await client.call('tasks.items.list', {})
const task = tasks.find((t) => t.body.includes('- [ ]')) ?? tasks[0]!

// Source files for the file tabs, in the scratch project only.
const root = main.cwd
const files: Record<string, string> = {
  'src/Explorer.tsx': "// Explorer: the dock file tree.\nimport { useResize } from '../kit/Resize.tsx'\nimport { Icon } from '../icons.tsx'\n\nexport function Explorer({ root }: { root: string }) {\n  const col = useResize({ initial: 240, min: 176, max: 520 })\n  const [open, setOpen] = useState(new Set<string>())\n  return <Tree root={root} open={open} width={col.width} />\n}\n",
  'src/theme.ts': "export const theme = { radius: 8, accent: '#3386d6' }\n",
  'src/Resize.tsx': "export function useResize(options: { initial: number; min: number; max: number }) {\n  return { width: options.initial }\n}\n",
  'docs/notes.md': '# Notes\n\nThe **tab strip** sits in the thread header.\n\n- Chat first\n- Documents after it\n',
}
for (let i = 0; i < 9; i++) files[`src/module-${String(i + 1).padStart(2, '0')}-with-a-long-name.ts`] = `export const value${i} = ${i}\n`
for (const [file, text] of Object.entries(files)) { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), text) }

const terminal = await client.call('terminals.create', { thread_id: main.id, cols: 100, rows: 24 })
await client.call('terminals.input', { terminal_id: terminal.id, data: Buffer.from('echo "tabs: one tab per terminal session"\n').toString('base64') })

const file = (p: string, preview = false) => ({ tab: { kind: 'file', path: p, root: 'project' }, key: `file:project:${p}`, preview })
const group = (threadId: string, entries: { tab: object; key: string; preview?: boolean }[], active: string) => ({ threadId, tabs: [{ kind: 'chat' }, ...entries.map((e) => e.tab)], active, preview: entries.find((e) => e.preview)?.key ?? null })
const only1 = (threadId: string, entries: { tab: object; key: string }[], active: string) => ({ threadId, tabs: entries.map((e) => e.tab), active, preview: null })
const leaf = (id: string, threadId: string | null) => ({ kind: 'leaf', id, threadId })
const split = (id: string, direction: 'horizontal' | 'vertical', first: object, second: object, ratio = 0.5) => ({ kind: 'split', id, direction, first, second, ratio })

type Scenario = { name: string; size?: string; ui: Record<string, unknown>; drive?: (app: App) => Promise<void> }
const docs = [file('src/Explorer.tsx'), file('src/theme.ts', true), { tab: { kind: 'diff' }, key: 'diff:*' }]
const scenarios: Scenario[] = [
  { name: 'chat-only', ui: { 'kybern.split-view.v2': { version: 2, root: leaf('main', main.id), focusedPaneId: 'main', groups: { main: group(main.id, [], 'chat') } } } },
  { name: 'documents', ui: { 'kybern.split-view.v2': { version: 2, root: leaf('main', main.id), focusedPaneId: 'main', groups: { main: group(main.id, docs, 'file:project:src/Explorer.tsx') } } } },
  {
    name: 'overflow', size: '1000x700',
    ui: { 'kybern.split-view.v2': { version: 2, root: leaf('main', main.id), focusedPaneId: 'main', groups: { main: group(main.id, Object.keys(files).filter((f) => f.includes('module')).map((f) => file(f)), 'file:project:src/module-05-with-a-long-name.ts') } } },
    drive: async (app) => { await app.getByTestId('tabs-main-overflow').click(); await Bun.sleep(400) },
  },
  { name: 'terminal', ui: { 'kybern.split-view.v2': { version: 2, root: leaf('main', main.id), focusedPaneId: 'main', groups: { main: group(main.id, [file('src/theme.ts'), { tab: { kind: 'terminal', id: terminal.id }, key: `terminal:${terminal.id}` }], `terminal:${terminal.id}`) } } } },
  { name: 'diff', ui: { 'kybern.split-view.v2': { version: 2, root: leaf('main', changes.id), focusedPaneId: 'main', groups: { main: group(changes.id, [{ tab: { kind: 'diff', path: 'date.ts' }, key: 'diff:date.ts' }], 'diff:date.ts') } } } },
  {
    name: 'browser', ui: { 'kybern.split-view.v2': { version: 2, root: leaf('main', main.id), focusedPaneId: 'main', groups: { main: group(main.id, [{ tab: { kind: 'preview' }, key: 'preview' }], 'preview') } } },
    drive: async (app) => {
      const server = await app.getByTestId(`preview-server-${PREVIEW_PORT}`)
      for (let i = 0; i < 40 && !(await server.count()); i++) await Bun.sleep(250)
      if (await server.count()) { await server.click(); await Bun.sleep(2500) }
    },
  },
  { name: 'subagent', ui: { 'kybern.split-view.v2': { version: 2, root: leaf('main', parent.id), focusedPaneId: 'main', groups: { main: group(parent.id, [{ tab: { kind: 'thread', id: child.id, title: child.title }, key: `thread:${child.id}` }], `thread:${child.id}`) } } } },
  {
    // The dock keeps the tree; one click opens the italic preview tab, the next click replaces it.
    name: 'explorer-preview',
    ui: { 'kybern.split-view.v2': { version: 2, root: leaf('main', main.id), focusedPaneId: 'main', groups: { main: group(main.id, [], 'chat') } }, 'kybern.dock.choices': [[main.id, { open: true, tabs: ['explorer', 'changes', 'agents'], tab: 'explorer', width: 440 }]] },
    drive: async (app) => {
      await app.getByTestId('dock-file-src').click(); await Bun.sleep(600)
      await app.getByTestId('dock-file-src/Explorer.tsx').click(); await Bun.sleep(600)
      assert.equal(await app.getByTestId('tab-file:project:src/Explorer.tsx').count(), 1, 'preview tab opened')
      await app.getByTestId('dock-file-src/theme.ts').click(); await Bun.sleep(600)
      assert.equal(await app.getByTestId('tab-file:project:src/Explorer.tsx').count(), 0, 'preview tab replaced')
      assert.equal(await app.getByTestId('tab-file:project:src/theme.ts').count(), 1, 'new preview tab')
      // Enter on the tree keeps it (as a double click would); the next click opens a second tab.
      await app.getByTestId('dock-file-tree-focus').press('enter'); await Bun.sleep(300)
      await app.getByTestId('dock-file-src/Resize.tsx').click(); await Bun.sleep(800)
      assert.equal(await app.getByTestId('tab-file:project:src/theme.ts').count(), 1, 'kept tab stays')
      assert.equal(await app.getByTestId('tab-file:project:src/Resize.tsx').count(), 1, 'second preview tab')
      await app.getByTestId('tab-file:project:src/theme.ts').click(); await Bun.sleep(600)
      console.log('[tabs] PASS explorer preview tabs')
    },
  },
  {
    // ⌘2 / ⌘1, ⌃Tab, ⌘W, ⌘⇧T, ⌘\ (a document into a new group), ⌘⌥← back to the chat's group, and a drag reorder.
    name: 'keyboard',
    ui: { 'kybern.split-view.v2': { version: 2, root: leaf('main', main.id), focusedPaneId: 'main', groups: { main: group(main.id, [file('src/Explorer.tsx'), file('src/theme.ts'), file('docs/notes.md')], 'chat') } } },
    drive: async (app) => {
      const root = app.getByTestId('app-ready')
      const active = async (key: string) => (await app.getByTestId(`tab-body-${key}`).count()) === 1
      await root.press('cmd-2'); await Bun.sleep(400)
      assert.ok(await active('file:project:src/Explorer.tsx'), '⌘2 opens the first document')
      await root.press('ctrl-tab'); await Bun.sleep(400)
      assert.ok(await active('file:project:src/theme.ts'), '⌃Tab cycles')
      await app.getByTestId('tab-body-file:project:src/theme.ts').press('cmd-w'); await Bun.sleep(500)
      assert.equal(await app.getByTestId('tab-file:project:src/theme.ts').count(), 0, '⌘W closes the tab')
      await root.press('cmd-shift-t'); await Bun.sleep(500)
      assert.equal(await app.getByTestId('tab-file:project:src/theme.ts').count(), 1, '⌘⇧T reopens it')
      await app.getByTestId('tab-file:project:docs/notes.md').click(); await Bun.sleep(400)
      assert.ok(await active('file:project:docs/notes.md'), 'a click selects a tab')
      // Drag the last tab before the first document.
      const from = await app.getByTestId('tab-file:project:docs/notes.md').center()
      const to = await app.getByTestId('tab-file:project:src/Explorer.tsx').bounds()
      await drag(app, from, { x: to.x + 6, y: to.y + to.height / 2 })
      const order = await Promise.all(['docs/notes.md', 'src/Explorer.tsx'].map(async (f) => (await app.getByTestId(`tab-file:project:${f}`).bounds()).x))
      assert.ok(order[0]! < order[1]!, `drag reordered (${order})`)
      await root.press('cmd-3'); await Bun.sleep(300)
      await root.press('cmd-\\'); await Bun.sleep(1500)
      assert.equal(await app.getByTestId('split-header-main').count(), 1, '⌘\\ moved the document into a new group')
      await root.press('cmd-alt-left'); await Bun.sleep(400)
      // ⌘W on the chat keeps today's behaviour (the tab never closes): checked last.
      await root.press('cmd-1'); await Bun.sleep(300)
      assert.equal(await app.getByTestId('tab-body-chat').count(), 0)
      console.log('[tabs] PASS keyboard: ⌘1-9, ⌃Tab, ⌘W, ⌘⇧T, drag reorder, ⌘\\')
    },
  },
  {
    // Note and task links from a thread open as tabs beside the chat.
    name: 'note-task',
    ui: { 'kybern.split-view.v2': { version: 2, root: split('s1', 'horizontal', leaf('a', main.id), leaf('b', main.id), 0.55), focusedPaneId: 'a', groups: {
      a: group(main.id, [{ tab: { kind: 'note', id: note.id }, key: `note:${note.id}` }], `note:${note.id}`), b: only1(main.id, [{ tab: { kind: 'task', id: task.id }, key: `task:${task.id}` }], `task:${task.id}`),
    } } },
  },
  {
    name: 'split-two',
    ui: { 'kybern.split-view.v2': { version: 2, root: split('s1', 'horizontal', leaf('a', main.id), leaf('b', main.id)), focusedPaneId: 'a', groups: { a: group(main.id, [], 'chat'), b: only1(main.id, [file('src/Explorer.tsx'), file('src/theme.ts')], 'file:project:src/Explorer.tsx') } } },
  },
  {
    name: 'split-2x2',
    ui: { 'kybern.split-view.v2': { version: 2, root: split('s1', 'horizontal', split('s2', 'vertical', leaf('a', main.id), leaf('c', main.id)), split('s3', 'vertical', leaf('b', main.id), leaf('d', other.id))), focusedPaneId: 'b', groups: {
      a: group(main.id, [], 'chat'), b: only1(main.id, [file('src/Explorer.tsx')], 'file:project:src/Explorer.tsx'),
      c: only1(main.id, [{ tab: { kind: 'diff' }, key: 'diff:*' }, file('docs/notes.md')], 'file:project:docs/notes.md'), d: group(other.id, [], 'chat'),
    } } },
  },
]

/** Press, travel 7 px so the capture layer mounts, wait for it to paint, move in steps and release (as `tasks/verify.ts`). */
async function drag(app: App, from: { x: number; y: number }, to: { x: number; y: number }) {
  await app.mouse.move(from)
  await app.mouse.down(from)
  await app.mouse.move({ x: from.x - 7, y: from.y }, { pressedButton: 0 })
  await app.getByTestId('tabs-drag-layer').waitFor({ timeoutMs: 5000 })
  await Bun.sleep(100)
  for (let i = 1; i <= 8; i++) await app.mouse.move({ x: from.x + (to.x - from.x) * i / 8, y: from.y + (to.y - from.y) * i / 8 }, { pressedButton: 0 })
  await Bun.sleep(150)
  await app.mouse.up(to)
  await Bun.sleep(600)
}

// A local page for the browser tab (discovered by the daemon's server scan).
const PREVIEW_PORT = 47611
const page = Bun.serve({ port: PREVIEW_PORT, fetch: () => new Response('<!doctype html><title>Tabs preview</title><body style="font:15px system-ui;padding:32px"><h1>Preview tab</h1><p>One native web view per thread, placed in the tab’s slot.</p></body>', { headers: { 'content-type': 'text/html; charset=utf-8' } }) })

const uiFile = path.join(DATA_DIR, 'gpuix-ui.json')
const results: string[] = []
for (const theme of themes) for (const scenario of scenarios) {
  if (only.length && !only.includes(scenario.name)) continue
  // Each scenario starts from its own saved layout only (the previous run's dock or sidebar choices do not carry over).
  writeFileSync(uiFile, JSON.stringify({ 'kybern.tabs.threads': [], ...scenario.ui }))
  const fixtureApp = await launchFixture(path.join(import.meta.dir, '../main.tsx'), {
    GPUIX_BACKGROUND: '1', KYBERN_OPAQUE: '1', KYBERN_REDUCED_MOTION: '1', KYBERN_APPEARANCE: theme,
    KYBERN_DATA_DIR: DATA_DIR, KYBERN_CLIENT_CONFIG_DIR: CLIENT_DIR, KYBERN_GPUIX_CREDENTIALS_DIR: CREDS_DIR, KYBERN_URL: '', KYBERN_TOKEN: '',
    KYBERN_WINDOW_SIZE: scenario.size ?? '1440x900',
  })
  const app = fixtureApp.app
  try {
    await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
    await app.getByTestId('tab-chat').waitFor({ timeoutMs: 30_000 }).catch(() => {})
    await Bun.sleep(2500)
    await scenario.drive?.(app)
    const out = path.join(OUT, `${scenario.name}-${theme}.png`)
    // The browser's page is a native web view that GPUI's own screenshot omits: capture the window instead.
    if (scenario.name === 'browser') captureWindow(fixtureApp.pid, out)
    else await app.screenshot({ path: out })
    results.push(out)
    console.log(`[tabs] ${scenario.name} ${theme} → ${out}`)
  } catch (error) {
    console.error(`[tabs] ${scenario.name} ${theme} failed:`, error)
  } finally {
    await fixtureApp.close()
  }
}
page.stop(true)
void client.call('terminals.close', { terminal_id: terminal.id }).catch(() => {})
await Bun.sleep(200)
client.close?.()
console.log(`[tabs] ${results.length} screenshots in ${OUT} (scratch ${SCRATCH})`)
process.exit(0)
