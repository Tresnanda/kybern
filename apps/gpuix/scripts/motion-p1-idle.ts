// V-cost idle for P1: after the P1 motions have all played (live clock) the window must be idle: ~0 submissions, CPU and GPU.
//   bun native/ui-lease.ts gpuix-p1 bun scripts/motion-p1-idle.ts
import '../src/native/local-build.ts'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { launchFixture } from '../src/tasks/round7b-harness.ts'
const S = '/Users/mymac/projects/ade-gpuix-scratch/motion-gpuix-p1'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const f = await launchFixture(path.join(import.meta.dir, '../src/main.tsx'), { GPUIX_BACKGROUND: '1', KYBERN_OPAQUE: '1', KYBERN_APPEARANCE: 'dark', KYBERN_REDUCED_MOTION: '0', KYBERN_DATA_DIR: `${S}/data`, KYBERN_CLIENT_CONFIG_DIR: `${S}/client`, KYBERN_GPUIX_CREDENTIALS_DIR: `${S}/credentials`, KYBERN_ENVIRONMENT_NAME: 'Development environment', KYBERN_WINDOW_SIZE: '1280x820' })
try {
  const a = f.app; await a.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
  await sleep(2500)
  const click = async (id: string) => { const c = await a.getByTestId(id).center(); await a.mouse.move(c); await a.mouse.down(c); await a.mouse.up(c); await sleep(450) }
  // every P1 motion once: drawer, rail pill, settings layer, hover reveals, chevron, new chat
  await click('sidebar-toggle'); await click('sidebar-toggle'); await click('rail-tasks'); await click('rail-home'); await click('rail-settings'); await click('settings-back')
  await a.mouse.move({ x: 130, y: 354 }); await sleep(500); await a.mouse.move({ x: 1275, y: 815 }); await sleep(500)
  await click('new-chat'); await a.mouse.move({ x: 1275, y: 815 })
  await sleep(10_000) // warm-up: everything settled
  console.log(execFileSync('bun', [path.join(import.meta.dir, '../perf/sample.ts'), '15', `GPUIX=${f.pid}`], { encoding: 'utf8' }))
} finally { await f.close() }
process.exit(0)
