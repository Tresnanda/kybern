/** Full-app resources, native scene submissions and automation-to-paint probes.
 * Run serially under motion-fixture.ts, with the round5 UI lock held.
 */
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { connectStdio } from '@gpuix/react/automation'
import { cpuSeconds, gpuNs, footprintMiB } from '../scripts/idle-metrics.ts'
const data = process.env.KYBERN_DATA_DIR ?? ''
if (!data.includes('gpuix-scratch/round5/motion/')) throw Error('Own motion fixture required')
const out = '/Users/mymac/projects/ade/previews/gpuix/round5/motion'
mkdirSync(out, { recursive: true })
const label = process.env.MOTION_LABEL ?? 'after'
const child = spawn('bun', [path.resolve(import.meta.dir, 'motion-app.ts')], {
  env: { ...process.env, GPUIX_BACKGROUND: '1', KYBERN_FRAME_TIMES: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
})
let trace = ''
child.stderr.on('data', chunk => { trace += chunk })
const app = await connectStdio({ write: s => { child.stdin.write(s) }, feed: f => child.stdout.on('data', s => f(String(s))), close: async () => { child.kill() } })
const records: unknown[] = [], inputs: number[] = [], bursts: number[][] = []
const dragProbes: number[] = []
const frames = () => trace.split('\n').flatMap(line => { const m = /\[kybern-frame\] ([\d.]+)/.exec(line); return m ? [Number(m[1])] : [] })
const quantiles = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b)
  return { n: sorted.length, p50: sorted[Math.floor(sorted.length * .5)] ?? null, p95: sorted[Math.floor(sorted.length * .95)] ?? null, max: sorted.at(-1) ?? null }
}
async function sample(scene: string, animate = false) {
  const cpu0 = cpuSeconds(child.pid!), gpu0 = gpuNs().get(child.pid!) ?? 0, t0 = performance.now(), commits0 = (trace.match(/\[motion-commit\]/g) ?? []).length
  const frame0 = frames().length
  if (animate) {
    while (performance.now() - t0 < 15000) {
      const first = frames().length, start = performance.now()
      await app.getByTestId('environment-toggle').click()
      // Count only observed input→changed native bounds, including transport.
      const initial = await app.getByTestId('environment-inset-main').bounds()
      for (;;) {
        const next = await app.getByTestId('environment-inset-main').bounds()
        if (Math.abs(next.width - initial.width) > 0.5 || performance.now() - start > 500) break
      }
      inputs.push(performance.now() - start)
      await Bun.sleep(330)
      bursts.push(frames().slice(first))
      await Bun.sleep(180)
    }
  } else await Bun.sleep(15000)
  const cpu1 = cpuSeconds(child.pid!), gpu1 = gpuNs().get(child.pid!) ?? 0, elapsed = (performance.now() - t0) / 1000
  records.push({ scene, seconds: elapsed, cpuPercent: 100 * (cpu1 - cpu0) / elapsed, gpuMs: (gpu1 - gpu0) / 1e6, footprintMiB: footprintMiB(child.pid!), nativeSceneSubmissions: frames().length - frame0, reactCommits: (trace.match(/\[motion-commit\]/g) ?? []).length - commits0 })
}
try {
  await app.getByTestId('environment-toggle').waitFor({ timeoutMs: 60000 })
  await app.mouse.move({ x: 1270, y: 800 })
  await Bun.sleep(10000)
  if (process.env.MOTION_DRAG_ONLY !== '1') {
    await sample('settled-thread-idle')
    await sample('environment-open-close', true)
  }
  await app.getByTestId('rail-tasks').click()
  await app.getByTestId('task-filter-all').click()
  await app.getByTestId('task-view-board').click()
  await app.mouse.move({ x: 1270, y: 800 })
  await Bun.sleep(5000)
  if (process.env.MOTION_DRAG_ONLY !== '1') await sample('tasks-board-running-column')
  const start = await app.getByText('Idle task 0').center()
  const dragStart = performance.now()
  await app.mouse.move(start); await app.mouse.down(start)
  await app.mouse.move({ x: start.x + 70, y: start.y + 10 }, { pressedButton: 0 })
  await app.getByTestId('task-ghost').waitFor()
  dragProbes.push(performance.now() - dragStart)
  // Warm the newly introduced shader/pipeline once before steady carry.
  await app.getByTestId('task-ghost').bounds()
  const warm = performance.now()
  while (performance.now() - warm < 1000) {
    await app.mouse.move({ x: start.x + 70 + Math.sin((performance.now() - warm) / 250) * 20, y: start.y + 10 }, { pressedButton: 0 })
    await Bun.sleep(16)
  }
  const c0 = cpuSeconds(child.pid!), g0 = gpuNs().get(child.pid!) ?? 0, t0 = performance.now(), first = frames().length
  while (performance.now() - t0 < 15000) {
    const phase = (performance.now() - t0) / 250
    await app.mouse.move({ x: start.x + 70 + Math.sin(phase) * 20, y: start.y + 10 + Math.cos(phase) * 8 }, { pressedButton: 0 })
    await Bun.sleep(16)
  }
  if (await app.getByTestId('task-ghost').count() !== 1) throw Error('Carry interrupted before resource sample ended')
  const c1 = cpuSeconds(child.pid!), g1 = gpuNs().get(child.pid!) ?? 0, elapsed = (performance.now() - t0) / 1000
  records.push({ scene: 'task-board-drag-carry', seconds: elapsed, cpuPercent: 100 * (c1 - c0) / elapsed, gpuMs: (g1 - g0) / 1e6, footprintMiB: footprintMiB(child.pid!), nativeSceneSubmissions: frames().length - first, frameIntervalsMs: quantiles(frames().slice(first + 1).map((v, i) => v - frames()[first + i]!)) })
  await app.mouse.up({ x: start.x + 70, y: start.y + 10 }); await Bun.sleep(1200)
  records.push({ scene: 'after-drag-release', footprintMiB: footprintMiB(child.pid!), heldGhosts: await app.getByTestId('task-ghost').count(), dragStartToObservedBoundsMs: dragProbes })
  const deltas = bursts.flatMap(times => times.slice(1).map((v, i) => v - times[i]!))
  const result = { records, sceneSubmissionIntervalsMs: quantiles(deltas), inputToObservedBoundsMs: quantiles(inputs), bursts: bursts.map(times => times.length), rawBurstIntervalsMs: deltas, inputProbesMs: inputs, host: execFileSync('sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8' }).trim(), nativeBinary: process.env.NAPI_RS_NATIVE_LIBRARY_PATH, limitations: 'Scene submissions, not display presentation. Input is automation RPC to observed native bounds, including transport; not physical key/pointer latency. No energy measurement. Resources exclude daemon and WindowServer. No screenshots during sampling.' }
  writeFileSync(`${out}/resources-${label}.json`, JSON.stringify(result, null, 2))
  console.log(JSON.stringify({records,sceneSubmissionIntervalsMs:result.sceneSubmissionIntervalsMs,inputToObservedBoundsMs:result.inputToObservedBoundsMs}, null, 2))
} finally {
  writeFileSync(`${out}/submissions-${label}.log`, trace)
  await app.close(); child.kill()
}
