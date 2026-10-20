// V-cost idle for P3: after the dock, tab, pane, menu, tooltip and dialog motions have all played (live clock) the window must be idle:
// ~0 submissions, CPU and GPU (perf/sample.ts). Two targets: the kit lab (overlays) and the real app against the scratch daemon that
// motion-p3-app.ts left running (dock open/close, tab add/close, pane switches, an Explorer file, the + menu).
//   NAPI_RS_NATIVE_LIBRARY_PATH=$PWD/native/build/gpuix-native.darwin-arm64.node VISUAL_SCRATCH=… bun native/ui-lease.ts gpuix-p3 bun scripts/motion-p3-idle.ts [lab|app]
import '../src/native/local-build.ts'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { launchFixture } from '../src/tasks/round7b-harness.ts'
import { CLIENT_DIR, CREDS_DIR, DATA_DIR } from '../visual/fixture.ts'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const target = process.argv[2] ?? 'lab'
const sample = (pid: number) => execFileSync('bun', [path.join(import.meta.dir, '../perf/sample.ts'), '15', `GPUIX=${pid}`], { encoding: 'utf8' })
if (target === 'lab') {
  const f = await launchFixture(path.join(import.meta.dir, 'motion-p3-lab.tsx'), { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: 'dark', KYBERN_OPAQUE: '1', KYBERN_DATA_DIR: DATA_DIR, KYBERN_CLIENT_CONFIG_DIR: CLIENT_DIR, KYBERN_URL: '', KYBERN_TOKEN: '' })
  try {
    const a = f.app; await a.getByTestId('app-ready').waitFor()
    const ready = (await a.getByTestId('app-ready').element()).id
    await sleep(800)
    const click = async (id: string) => { const c = await a.getByTestId(id).center(); await a.mouse.move(c); await a.mouse.down(c); await a.mouse.up(c); await sleep(450) }
    // Every overlay once: menu open/pick, dialog open/close, alert, sheet, select, the switch, segmented, badge, empty state, reveal and swap.
    await click('menu-main'); await click('menu-item-one'); await a.mouse.move({ x: 930, y: 580 })
    for (const k of ['d']) { await a.call('focus', { elementId: ready }); await a.call('keyDown', { key: k }); await sleep(500) }
    await click('dialog-close'); await sleep(400)
    for (const k of ['a', 's', 'v', 'g', 'n', 'e', 'r', 'h', 'i']) { await a.call('focus', { elementId: ready }); await a.call('keyDown', { key: k }); await sleep(450) }
    await a.call('keyDown', { key: 'escape' }); await sleep(500)
    await a.call('focus', { elementId: ready }); await a.call('keyDown', { key: 'r' }); await sleep(450)
    await a.mouse.move({ x: 930, y: 580 })
    await sleep(10_000)
    console.log(`lab idle:\n${sample(f.pid)}`)
  } finally { await f.close() }
} else {
  const f = await launchFixture(path.join(import.meta.dir, '../src/main.tsx'), { GPUIX_BACKGROUND: '1', KYBERN_OPAQUE: '1', KYBERN_APPEARANCE: 'dark', KYBERN_REDUCED_MOTION: '0', KYBERN_DATA_DIR: DATA_DIR, KYBERN_CLIENT_CONFIG_DIR: CLIENT_DIR, KYBERN_GPUIX_CREDENTIALS_DIR: CREDS_DIR, KYBERN_ENVIRONMENT_NAME: 'Development environment', KYBERN_WINDOW_SIZE: '1280x820' })
  try {
    const a = f.app; await a.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 }); await sleep(2500)
    const click = async (id: string) => { const c = await a.getByTestId(id).center(); await a.mouse.move(c); await a.mouse.down(c); await a.mouse.up(c); await sleep(500) }
    const thread = (await a.getByType('div').all()).find(n => n.testId?.startsWith('thread-') && n.bounds && n.bounds.height > 0)
    if (thread?.testId) await click(thread.testId); await sleep(1200)
    if (!await a.getByTestId('dock-tabs').count()) await click('dock-toggle')
    await sleep(800)
    await click('dock-add'); await click('dock-add-agents'); await click('dock-add'); await click('dock-add-explorer')
    await click('dock-tab-agents'); await click('dock-tab-explorer'); await click('dock-file-src'); await click('dock-file-src/dock-example.ts')
    await click('dock-tab-close-explorer'); await click('dock-collapse'); await click('dock-toggle')
    await a.mouse.move({ x: 1275, y: 815 })
    await sleep(10_000)
    console.log(`app idle:\n${sample(f.pid)}`)
  } finally { await f.close() }
}
process.exit(0)
