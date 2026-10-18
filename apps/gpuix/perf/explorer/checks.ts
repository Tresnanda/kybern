import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import { launchFixture, assertScratchEnv } from '../../src/requests/harness.ts'
import { absent, openDock, painted, until } from '../../scripts/dock-waits.ts'

assertScratchEnv({ KYBERN_URL: '' })
const data = process.env.KYBERN_DATA_DIR!
const root = path.join(data, 'regression-project')
const out = '/Users/mymac/projects/ade/previews/gpuix/perf/explorer/checks'
mkdirSync(out, { recursive: true })
for (const dir of ['a-folder/nested', 'large']) mkdirSync(path.join(root, dir), { recursive: true })
writeFileSync(path.join(root, 'a-folder/nested/inside.ts'), 'export const inside = true;\n')
writeFileSync(path.join(root, 'dock-example.ts'), 'export const example = 1;\nexport const next = 2;\n')
writeFileSync(path.join(root, 'readme.md'), '# Explorer check\n\nA **formatted** paragraph.\n')
writeFileSync(path.join(root, 'z-long.ts'), `export const value = "${'long source '.repeat(120)}END_OF_LONG_LINE";\n`)
for (let i = 0; i < 400; i++) writeFileSync(path.join(root, `large/file-${String(i).padStart(3, '0')}.ts`), `export const value = ${i};\n`)
const client = new KybernClient({ url: `ws://127.0.0.1:${readFileSync(path.join(data, 'daemon.port'), 'utf8').trim()}/ws`, token: readFileSync(path.join(data, 'daemon.token'), 'utf8').trim() })
client.connect(); while (client.status !== 'open') await Bun.sleep(25)
const project = (await client.call('projects.list', {})).projects.find(p => p.path === root) ?? await client.call('projects.add', { path: root, name: 'Explorer regression' })
const thread = (await client.call('threads.list', {})).threads.find(t => t.project_id === project.id) ?? await client.call('threads.create', { project_id: project.id, title: 'Explorer regression', provider: { kind: 'claude-code', instance: 'default' } })
client.close()
const reset = () => writeFileSync(path.join(data, 'gpuix-ui.json'), JSON.stringify({ 'kybern.dock.choices': [], 'kybern.workspace.selected': { kind: 'thread', id: thread.id }, 'kybern.split-view.v1': { version: 1, root: { kind: 'leaf', id: 'main', threadId: thread.id }, focusedPaneId: 'main' } }))
for (const appearance of ['dark', 'light']) {
  reset()
  const env = { ...process.env, KYBERN_URL: '', GPUIX_BACKGROUND: '1', KYBERN_GPUIX_THREAD: thread.id, KYBERN_APPEARANCE: appearance, KYBERN_FULL_RATE: '1', KYBERN_VERIFY_OUTPUT: out, BUN_OPTIONS: `--preload ${path.join(import.meta.dir, 'dock-fixture-preload.ts')}` }
  const dock = Bun.spawn(['bun', 'src/dock/verify-dock-check.ts', ...(appearance === 'light' ? ['--light'] : [])], { env, stdout: 'inherit', stderr: 'inherit' })
  assert.equal(await dock.exited, 0, `existing dock check (${appearance})`)
  for (const reduced of ['0', '1']) {
    reset()
    const f = await launchFixture(path.resolve('src/main.tsx'), { ...env, KYBERN_REDUCED_MOTION: reduced })
    const app = f.app
    let stage = 'boot'
    const show = async (id: string) => { stage = id; console.log(`[keyboard] ${appearance}/${reduced}: ${stage}`); await painted(app.getByTestId(id)); await app.clock.fastForward(600) }
    try {
      await until(async () => (await app.getByTestId('header-title').textContent()).includes('Explorer regression'), 'regression thread')
      if (!await app.getByTestId('right-dock').count()) await app.getByTestId('app-ready').press('cmd-j')
      await openDock(app.getByTestId('right-dock'))
      await app.getByTestId('dock-add').click(); await app.getByTestId('dock-add-explorer').click()
      await show('dock-file-a-folder')
      await app.getByTestId('dock-file-a-folder').click()
      await show('dock-file-a-folder/nested')
      await app.getByTestId('dock-file-a-folder/nested').click()
      await show('dock-file-a-folder/nested/inside.ts')
      await app.getByTestId('dock-file-a-folder/nested/inside.ts').click()
      await show('dock-code-chunk-0')
      await app.getByTestId('dock-file-a-folder').click()
      await absent(app.getByTestId('dock-file-a-folder/nested'))
      await app.getByTestId('dock-file-large').click()
      await show('dock-file-large/file-000.ts')
      // The collection remains reachable while rich offscreen bodies unmount.
      assert.equal(await app.getByTestId('dock-file-large/file-399.ts').count(), 0)
      const tree = app.getByTestId('dock-file-tree-focus')
      await tree.press('end'); await app.clock.fastForward(32)
      for (let i = 0; i < 3; i++) { await tree.press('up'); await app.clock.fastForward(32) }
      await show('dock-file-large/file-399.ts')
      await app.getByTestId('dock-file-large/file-399.ts').click()
      await app.getByText('large › file-399.ts').waitFor()
      await tree.press('home'); await app.clock.fastForward(32)
      await show('dock-file-large')
      await app.getByTestId('dock-file-large').click()
      await absent(app.getByTestId('dock-file-large/file-000.ts'))
      await app.getByTestId('dock-file-z-long.ts').click()
      await show('dock-code-chunk-0')
      const horizontal = await app.getByTestId('dock-file-horizontal').bounds(), before = await app.getByTestId('dock-code-chunk-0').bounds()
      await app.mouse.wheel({ x: horizontal.x + 50, y: horizontal.y + 10 }, -1500, 0)
      await until(async () => (await app.getByTestId('dock-code-chunk-0').bounds()).x < before.x - 500, 'horizontal source scroll')
      await app.getByTestId('dock-file-close').click(); await absent(app.getByTestId('dock-file-content'))
      await app.screenshot({ path: `${out}/keyboard-${appearance}-${reduced}.png` })
      console.log(`PASS ${appearance}/${reduced}: lazy deep tree, bounded rich rows, End/Home, last-file selection, collapse, horizontal scroll, close`)
    } catch (error) {
      console.error(`Keyboard failure at ${stage}:`, error, f.diagnostics())
      await app.screenshot({ path: `${out}/keyboard-failure-${appearance}-${reduced}.png` }).catch(() => {})
      writeFileSync(`${out}/keyboard-failure-${appearance}-${reduced}.tree.json`, JSON.stringify(await app.call('getTree', {}).catch(() => null)))
      throw error
    } finally { await f.close() }
  }
}
const motion = Bun.spawn(['bun', 'native/explorer-motion-check.ts'], { env: { ...process.env, KYBERN_URL: '', KYBERN_VERIFY_OUTPUT: path.join(out, 'motion') }, stdout: 'inherit', stderr: 'inherit' })
assert.equal(await motion.exited, 0, 'existing native Explorer motion check')
for (const [label, command] of [
  ['typecheck', ['pnpm', 'typecheck']],
  ['perf-typecheck', ['pnpm', 'exec', 'tsc', '-p', 'perf/explorer/tsconfig.json']],
  ['tests', ['bun', 'test', './src']],
] as const) {
  const check = Bun.spawn([...command], { env: process.env, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr] = await Promise.all([new Response(check.stdout).text(), new Response(check.stderr).text()])
  writeFileSync(path.join(out, `${label}.log`), stdout + stderr)
  assert.equal(await check.exited, 0, label)
  console.log(`PASS ${label}`)
}

writeFileSync(path.join(out, 'passed.json'), JSON.stringify({ dock: ['dark', 'light'], keyboard: ['dark/normal', 'dark/reduced', 'light/normal', 'light/reduced'], motion: ['dark/normal', 'dark/reduced', 'light/normal', 'light/reduced'], typecheck: true, perfTypecheck: true, sourceTests: true }, null, 2))
