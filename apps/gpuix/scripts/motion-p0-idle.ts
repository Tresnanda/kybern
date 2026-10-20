// V-cost idle: after the P0 lab settles, no frames and no CPU/GPU (perf/sample.ts, live clock). Run under one UI lease:
//   bun native/ui-lease.ts gpuix-p0 bun scripts/motion-p0-idle.ts
import '../src/native/local-build.ts'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { launchFixture } from '../src/tasks/round7b-harness.ts'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const f = await launchFixture(path.join(import.meta.dir, 'motion-p0-lab.tsx'), { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: 'dark', KYBERN_OPAQUE: '1', KYBERN_DATA_DIR: '/Users/mymac/projects/ade-gpuix-scratch/motion-gpuix-p0', KYBERN_CLIENT_CONFIG_DIR: '/Users/mymac/projects/ade-gpuix-scratch/motion-gpuix-p0-client', KYBERN_URL: '', KYBERN_TOKEN: '' })
try {
  const a = f.app; await a.getByTestId('app-ready').waitFor()
  await a.call('focus', { elementId: (await a.getByTestId('app-ready').element()).id })
  await sleep(800)
  for (const k of ['r', 'r', 's', 'c', 'p', 'p', 'o', 'o', 'k', 'm', 'a', 'h', 'n']) { await a.call('keyDown', { key: k }); await sleep(120) }
  await sleep(10_000) // warm-up: everything settled, the popup left, the Presence card is back
  console.log(execFileSync('bun', [path.join(import.meta.dir, '../perf/sample.ts'), '15', `GPUIX=${f.pid}`], { encoding: 'utf8' }))
} finally { await f.close() }
process.exit(0)
