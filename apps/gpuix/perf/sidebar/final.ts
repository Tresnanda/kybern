/** Matched A/B/P1 controls. Run inside quiet.ts, each batch takes its own UI lease. */
import path from 'node:path'
const out = '/Users/mymac/projects/ade/previews/gpuix/perf/sidebar'
async function run(args: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn(['bun', ...args], { env: { ...process.env, ...env }, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
  const stop = () => child.kill()
  process.on('SIGTERM', stop); process.on('SIGINT', stop)
  try { if (await child.exited) throw Error(args.join(' ') + ' failed') }
  finally { process.off('SIGTERM', stop); process.off('SIGINT', stop) }
}
if (process.argv.includes('--buffer-probe')) {
  for (const buffer of ['1536', '3072']) await run(['perf/sidebar/run.ts', `candidate-buffer-${buffer}-fast`], {
    SIDEBAR_SCENE: 'settled', SIDEBAR_MAGNITUDE: '30', KYBERN_SIDEBAR_BUFFER: buffer,
  })
} else if (process.argv.includes('--batch')) {
  const scene = process.argv[3]!, repeat = Number(process.argv[4])
  for (const variant of repeat % 2 ? ['candidate','p1','baseline'] : ['baseline','p1','candidate']) {
    await run(['perf/sidebar/run.ts', `${variant}-final-${scene}-${repeat}`], { SIDEBAR_SCENE: scene })
  }
} else if (process.argv.includes('--cold-pair')) {
  const repeat = Number(process.argv[3])
  for (const variant of repeat % 2 ? ['candidate','baseline'] : ['baseline','candidate']) {
    await run(['perf/sidebar/fixture.ts', 'bun', 'perf/sidebar/cold.ts', `${out}/cold-final-${variant}-${repeat}.json`, '--packaged'], {
      KYBERN_STARTUP_RUNS: '2', KYBERN_STARTUP_EXECUTABLE: path.resolve(`dist/sidebar-${variant}.app/Contents/MacOS/Kybern GPUIX`),
    })
  }
} else if (process.argv.includes('--cold-fixture')) {
  // A fresh daemon/projection cache for both members, one fair lease per pair.
  for (let repeat=0;repeat<3;repeat++) await run(['perf/sidebar/lease.ts','bun','perf/sidebar/final.ts','--cold-pair',String(repeat)])
} else {
  // Each matched triple is about 90 seconds, below the five-minute lease cap.
  for (const scene of ['settled','running','mixed']) for (let repeat=0;repeat<2;repeat++) {
    await run(['perf/sidebar/lease.ts','bun','perf/sidebar/final.ts','--batch',scene,String(repeat)])
  }
  for (const variant of ['baseline', 'p1', 'candidate']) await run(['perf/sidebar/lease.ts', 'bun', 'perf/sidebar/run.ts', `${variant}-final-fast`], { SIDEBAR_SCENE: 'settled', SIDEBAR_MAGNITUDE: '30' })
  await run(['perf/sidebar/lease.ts', 'bun', 'perf/sidebar/run.ts', 'candidate-final-wide-overdraw'], { SIDEBAR_SCENE: 'settled', KYBERN_OVERDRAW: '512' })
  for (const variant of ['baseline', 'candidate']) {
    await run(['perf/sidebar/lease.ts', 'bun', 'perf/sidebar/run.ts', `${variant}-final-idle`], { SIDEBAR_IDLE: '1', SIDEBAR_SCENE: 'settled' })
    await run(['perf/sidebar/lease.ts', 'bun', 'perf/sidebar/run.ts', `${variant}-final-profile`], { SIDEBAR_PROFILE: '1', SIDEBAR_SCENE: 'settled' })
  }
  for (const theme of ['dark', 'light']) for (const variant of ['baseline', 'candidate']) {
    await run(['perf/sidebar/lease.ts', 'bun', 'perf/sidebar/run.ts', `${variant}-visual`], { SIDEBAR_VISUAL: '1', SIDEBAR_SCENE: 'settled', KYBERN_APPEARANCE: theme })
  }
}
