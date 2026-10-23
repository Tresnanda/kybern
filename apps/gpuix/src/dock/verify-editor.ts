/**
 * Editable file tabs (ADE-61) and soft wrap (ADE-60) in the real app, against a scratch daemon built from this checkout (it needs
 * `files.write`): wrapped long lines beside the Explorer, typing with the dirty dot and ⌘S, the "Changed on disk." bar, the
 * Open in… menu, the read-only note of a file over 2 MB, and the frame cost of keystrokes in a 5,000-line file.
 *
 *   KYBERND=<checkout>/target/debug/kybernd bun src/dock/verify-editor.ts [--fresh] [--theme dark|light|both] [--out DIR] [scenario ...]
 *   bun src/dock/verify-editor.ts --down
 *
 * Scratch only: `/Users/mymac/projects/ade-gpuix-scratch/files-ade61` (never ~/.kybern, never port 4219).
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { App } from '@gpuix/react/automation'
import { launchFixture } from '../requests/harness.ts'

process.env.VISUAL_SCRATCH ??= '/Users/mymac/projects/ade-gpuix-scratch/files-ade61'
const fixture = await import('../../visual/fixture.ts')
const { DATA_DIR, CLIENT_DIR, CREDS_DIR } = fixture

const args = process.argv.slice(2)
if (args.includes('--down')) { fixture.stopPid(fixture.readState()?.daemonPid); console.log('[files] daemon stopped'); process.exit(0) }
const option = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const OUT = option('--out') ?? '/Users/mymac/projects/ade/.kybern-artifacts/ade-60-64/61'
const themes = (option('--theme') ?? 'both') === 'both' ? ['dark', 'light'] : [option('--theme')!]
const only = args.filter((a, i) => !a.startsWith('--') && !['--out', '--theme'].includes(args[i - 1] ?? ''))
mkdirSync(OUT, { recursive: true })

let state = await fixture.startDaemon(args.includes('--fresh'))
if (!state.seeded) { await fixture.seed(state); state = fixture.readState()! }
const client = await fixture.connect(state)
const { threads } = await client.call('threads.list', { include_subagents: true })
const main = threads.find((th) => th.title === 'Date helper cleanup')!
assert.ok(main, 'seeded thread')
const root = main.cwd

const long = (n: number) => `export const message${n} = 'A long line that keeps going well past the edge of the tab, so with Wrap lines on it continues on the next row and its number stays with the first one (${n})' + ' and then some more words to be sure it wraps twice on a narrow tab'\n`
const files: Record<string, string> = {
  'src/wrap.ts': `// Long lines wrap at the editor's width (ADE-60).\n${[1, 2, 3].map(long).join('')}\nexport function short() {\n  return 1\n}\n`,
  'src/app.ts': "import { useState } from 'react'\n\nexport function App() {\n  const [count, setCount] = useState(0)\n  return count\n}\n",
  'src/big.ts': Array.from({ length: 5000 }, (_, i) => `export const value${i} = { id: ${i}, label: 'row ${i}', tags: ['a', 'b'] } // line ${i + 1}`).join('\n') + '\n',
  'src/huge.json': JSON.stringify({ rows: Array.from({ length: 40_000 }, (_, i) => ({ id: i, name: `row number ${i}`, value: i * 3 })) }),
}
for (const [file, text] of Object.entries(files)) { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), text) }
assert.ok(files['src/huge.json']!.length > 2 * 1024 * 1024, 'the large file is over 2 MB')

const fileTab = (p: string) => ({ kind: 'file', path: p, root: 'project' })
const layout = (active: string, open: string[], dock = false, width = 440) => ({
  'kybern.tabs.threads': [],
  'kybern.split-view.v2': { version: 2, root: { kind: 'leaf', id: 'main', threadId: main.id }, focusedPaneId: 'main', groups: { main: { threadId: main.id, tabs: [{ kind: 'chat' }, ...open.map(fileTab)], active: `file:project:${active}`, preview: null } } },
  ...(dock ? { 'kybern.dock.choices': [[main.id, { open: true, tabs: ['explorer', 'changes', 'agents'], tab: 'explorer', width }]] } : {}),
})
const editor = (app: App) => app.getByTestId('file-editor')
const typeText = (text: string) => [...text].map((c) => c === ' ' ? 'space' : c === '\n' ? 'enter' : c).join(' ')

type Scenario = { name: string; themes?: string[]; ui: Record<string, unknown>; env?: Record<string, string>; drive?: (app: App, theme: string, f: { frameTimes(): number[]; diagnostics(): string }) => Promise<void>; shot?: boolean }
const scenarios: Scenario[] = [
  { name: 'wrap', ui: layout('src/wrap.ts', ['src/wrap.ts', 'src/app.ts'], true), drive: async (app) => {
    await editor(app).waitFor({ timeoutMs: 15000 }); await Bun.sleep(800)
    if (process.env.PROBE) { const node = await editor(app).element(); console.log(JSON.stringify({ ...node, children: undefined }).slice(0, 1500)); console.log(JSON.stringify(await editor(app).bounds())) }
  } },
  {
    name: 'wrap-off', themes: ['dark'], ui: { ...layout('src/wrap.ts', ['src/wrap.ts'], true), 'kybern.files.wrap': false },
    drive: async (app) => { await editor(app).waitFor({ timeoutMs: 15000 }); await Bun.sleep(800) },
  },
  {
    name: 'editing', shot: false, ui: layout('src/app.ts', ['src/wrap.ts', 'src/app.ts']),
    drive: async (app, theme) => {
      writeFileSync(path.join(root, 'src/app.ts'), files['src/app.ts']!)
      await editor(app).waitFor({ timeoutMs: 15000 }); await Bun.sleep(600)
      const box = await editor(app).bounds()
      // The caret on line 5 ("  return count"), at its end: click right of the text.
      await app.mouse.click({ x: box.x + box.width - 40, y: box.y + 4 + 4 * 20 + 10 })
      await editor(app).press('end'); await editor(app).press(typeText(' + 1'))
      // Enter keeps the indent; a bracket pairs.
      await editor(app).press('enter'); await editor(app).press(typeText('setCount')); await editor(app).press('['); await editor(app).press(typeText('count'))
      await Bun.sleep(700)
      assert.equal(await app.getByTestId('file-unsaved').count(), 1, 'the header says Unsaved')
      await app.screenshot({ path: path.join(OUT, `editing-${theme}.png`) })
      if (theme !== 'dark') return
      await editor(app).press('cmd-s'); await Bun.sleep(1200)
      const saved = readFileSync(path.join(root, 'src/app.ts'), 'utf8')
      assert.ok(saved.includes('return count + 1\n  setCount[count]'), `saved with auto-indent and the pair: ${JSON.stringify(saved)}`)
      assert.equal(await app.getByTestId('file-unsaved').count(), 0, 'clean after ⌘S')
      console.log('[files] PASS typing, auto-indent, bracket pair, ⌘S writes the file')
      await editor(app).press('cmd-z'); await Bun.sleep(300)
      assert.equal(await app.getByTestId('file-unsaved').count(), 1, '⌘Z undoes natively')
      console.log('[files] PASS native undo')
    },
  },
  {
    name: 'conflict', ui: layout('src/app.ts', ['src/app.ts']),
    drive: async (app) => {
      writeFileSync(path.join(root, 'src/app.ts'), files['src/app.ts']!)
      await editor(app).waitFor({ timeoutMs: 15000 }); await Bun.sleep(600)
      await editor(app).click(); await editor(app).press('cmd-up'); await editor(app).press(typeText('// mine\n'))
      await Bun.sleep(300)
      // An agent rewrites the file meanwhile.
      writeFileSync(path.join(root, 'src/app.ts'), files['src/app.ts']!.replace('useState(0)', 'useState(10)'))
      await app.getByTestId('file-conflict').waitFor({ timeoutMs: 8000 })
      await Bun.sleep(300)
    },
  },
  {
    name: 'reload-clean', themes: ['dark'], shot: false, ui: layout('src/app.ts', ['src/app.ts']),
    drive: async (app) => {
      writeFileSync(path.join(root, 'src/app.ts'), files['src/app.ts']!)
      await editor(app).waitFor({ timeoutMs: 15000 }); await Bun.sleep(600)
      writeFileSync(path.join(root, 'src/app.ts'), files['src/app.ts']!.replace('return count', 'return count * 2'))
      await Bun.sleep(3500)
      assert.equal(await app.getByTestId('file-conflict').count(), 0, 'no conflict without edits')
      // Type at the top and save: the saved text has the disk's change, so the buffer followed it.
      await editor(app).click(); await editor(app).press('cmd-up'); await editor(app).press(typeText('// ok\n')); await editor(app).press('cmd-s'); await Bun.sleep(1200)
      const saved = readFileSync(path.join(root, 'src/app.ts'), 'utf8')
      assert.ok(saved.startsWith('// ok\n') && saved.includes('count * 2'), `a clean tab follows the file on disk: ${JSON.stringify(saved)}`)
      console.log('[files] PASS clean tab reloads silently')
    },
  },
  {
    name: 'open-in', ui: layout('src/app.ts', ['src/app.ts']),
    drive: async (app) => {
      await editor(app).waitFor({ timeoutMs: 15000 }); await Bun.sleep(400)
      await app.getByTestId('dock-file-actions').click(); await Bun.sleep(400)
      await app.getByTestId('file-open-cursor').hover(); await Bun.sleep(300)
    },
  },
  {
    name: 'find-close', themes: ['dark'], ui: layout('src/app.ts', ['src/app.ts']),
    drive: async (app) => {
      writeFileSync(path.join(root, 'src/app.ts'), files['src/app.ts']!)
      await editor(app).waitFor({ timeoutMs: 15000 }); await Bun.sleep(600)
      await editor(app).click(); await editor(app).press('cmd-f')
      await app.getByTestId('file-find-field').waitFor({ timeoutMs: 3000 })
      await app.getByTestId('file-find-field').fill('count'); await Bun.sleep(400)
      assert.ok(await app.getByText('1 of 3').count(), '⌘F finds the 3 matches')
      await app.getByTestId('file-find-field').press('enter'); await Bun.sleep(200)
      assert.ok(await app.getByText('2 of 3').count(), 'Enter steps to the next match')
      await app.screenshot({ path: path.join(OUT, 'find-dark.png') })
      await app.getByTestId('file-find-field').press('escape'); await Bun.sleep(300)
      assert.equal(await app.getByTestId('file-find-bar').count(), 0, 'Escape closes find')
      // A dirty tab asks before it closes: Cancel keeps it, Don't save closes it and leaves the file alone.
      await editor(app).press(typeText('x'))
      await Bun.sleep(300)
      await editor(app).press('cmd-w'); await app.getByTestId('close-dirty').waitFor({ timeoutMs: 3000 })
      await Bun.sleep(400)
      await app.screenshot({ path: path.join(OUT, 'close-dirty-dark.png') })
      await app.getByTestId('close-dirty-cancel').click(); await Bun.sleep(500)
      assert.equal(await app.getByTestId('tab-file:project:src/app.ts').count(), 1, 'Cancel keeps the tab')
      await editor(app).press('cmd-w'); await app.getByTestId('close-dirty').waitFor({ timeoutMs: 3000 })
      await app.getByTestId('close-dirty-discard').click(); await Bun.sleep(600)
      assert.equal(await app.getByTestId('tab-file:project:src/app.ts').count(), 0, "Don't save closes the tab")
      assert.equal(readFileSync(path.join(root, 'src/app.ts'), 'utf8'), files['src/app.ts'], "Don't save leaves the file")
      console.log('[files] PASS ⌘F find, Enter next, Escape; dirty close: Cancel / Don\'t save')
    },
    shot: false,
  },
  { name: 'large', ui: layout('src/huge.json', ['src/huge.json']), drive: async (app) => { await app.getByTestId('file-read-only').waitFor({ timeoutMs: 20000 }); await Bun.sleep(1500) } },
  {
    // Frame cost of each keystroke in a 5,000-line file: the draw that follows it (`KYBERN_FRAME_COSTS`).
    name: 'perf', themes: ['dark'], shot: false, ui: layout('src/big.ts', ['src/big.ts']), env: { KYBERN_FRAME_COSTS: '1', KYBERN_FRAME_TIMES: '1' },
    drive: async (app, _theme, f) => {
      writeFileSync(path.join(root, 'src/big.ts'), files['src/big.ts']!)
      await editor(app).waitFor({ timeoutMs: 20000 }); await Bun.sleep(2500)
      await editor(app).click(); await editor(app).press('cmd-down'); await Bun.sleep(800)
      const work = () => [...f.diagnostics().matchAll(/\[kybern-work\] renderMs=([\d.]+) layoutMs=([\d.]+)/g)].map((m) => Number(m[1]))
      const samples: number[] = []
      for (let i = 0; i < 30; i++) {
        const before = work().length
        const t0 = performance.now()
        await editor(app).press('x')
        let after = work()
        for (let w = 0; w < 50 && after.length <= before; w++) { await Bun.sleep(5); after = work() }
        samples.push(after[after.length - 1] ?? NaN)
        if (i === 0) console.log(`[files] first key round trip ${(performance.now() - t0).toFixed(1)} ms`)
        await Bun.sleep(120)
      }
      samples.sort((a, b) => a - b)
      const pick = (q: number) => samples[Math.min(samples.length - 1, Math.floor(q * samples.length))]!.toFixed(2)
      const report = `5000-line file, 30 keystrokes at the end: frame draw after each key median ${pick(0.5)} ms, p95 ${pick(0.95)} ms, max ${samples.at(-1)!.toFixed(2)} ms`
      console.log(`[files] ${report}`)
      writeFileSync(path.join(OUT, 'perf.txt'), report + '\n')
    },
  },
]

// The app keeps the scratch daemon (a version it does not expect would make it start its own).
const daemonVersion = (await client.call('daemon.info', {})).version
const uiFile = path.join(DATA_DIR, 'gpuix-ui.json')
for (const theme of themes) for (const scenario of scenarios) {
  if (only.length && !only.includes(scenario.name)) continue
  if (scenario.themes && !scenario.themes.includes(theme)) continue
  writeFileSync(uiFile, JSON.stringify(scenario.ui))
  const f = await launchFixture(path.join(import.meta.dir, '../main.tsx'), {
    GPUIX_BACKGROUND: '1', KYBERN_OPAQUE: '1', KYBERN_REDUCED_MOTION: '1', KYBERN_APPEARANCE: theme,
    KYBERN_DATA_DIR: DATA_DIR, KYBERN_CLIENT_CONFIG_DIR: CLIENT_DIR, KYBERN_GPUIX_CREDENTIALS_DIR: CREDS_DIR, KYBERN_URL: '', KYBERN_TOKEN: '', KYBERN_GPUIX_VERSION: daemonVersion,
    KYBERN_WINDOW_SIZE: '1280x820', NAPI_RS_NATIVE_LIBRARY_PATH: path.join(import.meta.dir, '../../native/build/gpuix-native.darwin-arm64.node'), ...scenario.env,
  })
  try {
    await f.app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
    await Bun.sleep(1500)
    await scenario.drive?.(f.app, theme, f)
    if (scenario.shot !== false) {
      const out = path.join(OUT, `${scenario.name}-${theme}.png`)
      await f.app.screenshot({ path: out })
      console.log(`[files] ${scenario.name} ${theme} → ${out}`)
    }
  } catch (error) {
    console.error(`[files] ${scenario.name} ${theme} FAILED:`, error)
    await f.app.screenshot({ path: path.join(OUT, `${scenario.name}-${theme}-failed.png`) }).catch(() => {})
    process.exitCode = 1
  } finally { await f.close() }
}
process.exit(process.exitCode ?? 0)
