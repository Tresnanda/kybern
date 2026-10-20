// V-cost idle: after the P2 lab settles, no frames and no CPU/GPU (perf/sample.ts, live clock). Run under one UI lease:
//   bun native/ui-lease.ts gpuix-p2 bun scripts/motion-p2-idle.ts
import '../src/native/local-build.ts'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { launchFixture } from '../src/tasks/round7b-harness.ts'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const f = await launchFixture(path.join(import.meta.dir, 'motion-p2-lab.tsx'), { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: 'dark', KYBERN_OPAQUE: '1', KYBERN_DATA_DIR: '/Users/mymac/projects/ade-gpuix-scratch/motion-gpuix-p2', KYBERN_CLIENT_CONFIG_DIR: '/Users/mymac/projects/ade-gpuix-scratch/motion-gpuix-p2-client', KYBERN_URL: '', KYBERN_TOKEN: '' })
try {
  const a = f.app; await a.getByTestId('app-ready').waitFor()
  await a.call('focus', { elementId: (await a.getByTestId('app-ready').element()).id })
  await sleep(800)
  // Every P2 transition once, ending settled with the subagent done (its loader would otherwise loop).
  for (const k of ['z', 'x', 'y', 'q', 'w', 'd', 'd', 'b', 'b', 'i', 'p', 'p', 'l', 'l', 'k', 'k', 'a', 'h', 'h', 'r', 'f']) { await a.call('keyDown', { key: k }); await sleep(260) }
  await sleep(10_000) // warm-up: everything settled
  console.log(execFileSync('bun', [path.join(import.meta.dir, '../perf/sample.ts'), '15', `GPUIX=${f.pid}`], { encoding: 'utf8' }))
} finally { await f.close() }
process.exit(0)
