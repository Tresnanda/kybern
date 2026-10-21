// V-cost idle: after every composer tray and lightbox transition has played and settled, the window draws nothing
// (perf/sample.ts, live clock). The lab starts settled (no working subagent or task), so nothing loops by design.
//   bun native/ui-lease.ts composer-tray bun scripts/composer-tray-idle.ts [--baseline]   (--baseline: no transitions, the harness alone)
import '../src/native/local-build.ts'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { launchFixture } from '../src/tasks/round7b-harness.ts'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const f = await launchFixture(path.join(import.meta.dir, 'composer-tray-lab.tsx'), { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: 'dark', KYBERN_OPAQUE: '1', LAB_SETTLED: '1', KYBERN_DATA_DIR: '/Users/mymac/projects/ade-gpuix-scratch/composer-tray/lab', KYBERN_CLIENT_CONFIG_DIR: '/Users/mymac/projects/ade-gpuix-scratch/composer-tray/lab-client', KYBERN_URL: '', KYBERN_TOKEN: '', NAPI_RS_NATIVE_LIBRARY_PATH: path.resolve(import.meta.dir, '../native/build/gpuix-native.darwin-arm64.node') })
try {
  const a = f.app; await a.getByTestId('app-ready').waitFor()
  const click = async (id: string) => { const c = await a.getByTestId(id).center(); await a.mouse.move(c); await a.mouse.down(c); await a.mouse.up(c); await a.mouse.move({ x: 1100, y: 40 }); await sleep(600) }
  await a.call('focus', { elementId: (await a.getByTestId('app-ready').element()).id })
  await sleep(800)
  if (!process.argv.includes('--baseline')) {
    await click('composer-tray-toggle'); await click('composer-tray-toggle')
    for (const k of ['y', 'q', 'a', 'a']) { await a.call('keyDown', { key: k }); await sleep(500) }
    await click('attachment-image1'); await click('attachment-lightbox-close')
  }
  await sleep(10_000) // warm-up: everything settled
  console.log(execFileSync('bun', [path.join(import.meta.dir, '../perf/sample.ts'), '15', `GPUIX=${f.pid}`], { encoding: 'utf8' }))
} finally { await f.close() }
process.exit(0)
