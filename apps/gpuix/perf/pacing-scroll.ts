/** Real app, deterministic paged PR workload; native submission timestamps.
 * bun perf/pacing-scroll.ts <label> [dark|light] [0|1 reduced]
 * Scene submits are not physical presentation fences. Input probes include RPC.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { connectStdio } from '@gpuix/react/automation'
import { actionFixture } from '../src/pulls/verify.fixture.ts'
import { pacingLock } from './pacing-lock.ts'

const label = process.argv[2] ?? 'baseline', theme = process.argv[3] ?? 'dark', reduce = process.argv[4] ?? '0'
const out = '/Users/mymac/projects/ade/previews/gpuix/round7/pacing'
mkdirSync(out, { recursive: true })
const release = await pacingLock(), fixture = actionFixture({ long: true })
const child = spawn('bun', [path.join(import.meta.dir, 'pacing-app.ts')], { env: { ...process.env, ...fixture.env, KYBERN_APPEARANCE: theme, KYBERN_REDUCED_MOTION: reduce, KYBERN_FRAME_TIMES: '1', KYBERN_DEBUG_ISLANDS: '1' }, stdio: ['pipe', 'pipe', 'pipe'] })
let raw = '', pending = '', commits = 0, renders = 0
const costs:{renderMs:number;layoutMs:number;layoutCalls:number}[]=[]
const frames: { native: number; received: number }[] = []
child.stderr.on('data', chunk => {
  const value = String(chunk); raw += value; pending += value
  const end = pending.lastIndexOf('\n'); if (end < 0) return
  for (const line of pending.slice(0, end).split('\n')) {
    const m = line.match(/\[kybern-submit\] ([\d.]+)/)
    if (m) frames.push({ native: Number(m[1]), received: performance.now() })
    if (line.includes('[pacing-commit]')) commits++
    if (line.includes('[islands] render ')) renders++
    const cost=line.match(/\[kybern-work\] renderMs=([\d.]+) layoutMs=([\d.]+) layoutCalls=(\d+)/)
    if(cost)costs.push({renderMs:Number(cost[1]),layoutMs:Number(cost[2]),layoutCalls:Number(cost[3])})
  }
  pending = pending.slice(end + 1)
})
const percentile = (values: number[], fraction: number) => [...values].sort((a,b) => a-b)[Math.min(values.length-1, Math.floor(values.length*fraction))] ?? null
let app: Awaited<ReturnType<typeof connectStdio>> | undefined
try {
  app = await Promise.race([
    connectStdio({ write: v => { child.stdin.write(v) }, feed: listener => { child.stdout.on('data', v => listener(String(v))) }, close: async () => { child.kill() } }),
    new Promise<never>((_,reject) => child.once('exit', code => reject(Error(`Exited ${code}: ${raw.slice(-3000)}`)))),
  ])
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 60000 })
  await app.getByTestId('rail-pulls').click()
  await app.getByTestId('pr-row-108').waitFor()
  const results: unknown[] = []
  for (const scene of ['list', 'summary', 'changes', 'timeline']) {
    if (scene === 'summary') { await app.getByTestId('pr-row-108').click(); await app.getByTestId('pr-summary').waitFor() }
    if (scene === 'changes' || scene === 'timeline') { await app.getByTestId(`pr-tab-${scene}`).click(); await app.getByTestId(scene === 'changes' ? 'pr-native-diff' : 'pr-select-r1').waitFor() }
    // Native virtual-list itself has no automation hitbox; use the surrounding
    // PR page, whose geometry is recorded, or the native diff viewport.
    const target = app.getByTestId(scene === 'changes' ? 'pr-native-diff' : 'page-pulls')
    const deadline = Date.now() + 10000
    let b: { x: number; y: number; width: number; height: number } | undefined
    while (!b) {
      try { b = await target.bounds() } catch (e) { if (Date.now() > deadline) throw e; await Bun.sleep(20) }
    }
    // Resolve bounds once: tree inspection must not throttle each wheel packet.
    const point = { x: scene === 'list' ? b.x+176 : scene === 'changes' ? b.x+b.width/2 : b.x+352+(b.width-352)/2, y: b.y+b.height/2 }
    const first = frames.length, c0 = commits, r0 = renders, work0=costs.length, latency: number[] = [], packets: number[] = []
    const start = performance.now()
    for (let i = 0; i < 180; i++) {
      const sent = performance.now(), count = frames.length
      await app.mouse.wheel(point, 0, i < 90 ? -14 : 14)
      packets.push(performance.now()-sent)
      if (packets.at(-1)! > 250) break
      // Input is scheduled at 60 Hz. This is the workload, not an app tween.
      const deadline = start + (i+1)*1000/60
      if (deadline > performance.now()) await Bun.sleep(deadline-performance.now())
      const next = frames.slice(count).find(f => f.received >= sent)
      if (next) latency.push(next.received-sent)
    }
    const times = frames.slice(first), intervals = times.slice(1).map((v,i) => v.native-times[i]!.native)
    const work=costs.slice(work0)
    results.push({ scene, frameCount: times.length, p50: percentile(intervals,.5), p95: percentile(intervals,.95), rpcToSubmissionReceiptP50: percentile(latency,.5), rpcToSubmissionReceiptP95: percentile(latency,.95), latencySamples: latency.length, commits: commits-c0, islandRenders: renders-r0, renderMsP50:percentile(work.map(v=>v.renderMs),.5),renderMsP95:percentile(work.map(v=>v.renderMs),.95),layoutMsP50:percentile(work.map(v=>v.layoutMs),.5),layoutMsP95:percentile(work.map(v=>v.layoutMs),.95),layoutCallsP50:percentile(work.map(v=>v.layoutCalls),.5), elapsedMs: performance.now()-start, packets, intervals })
    if (packets.some(v => v > 250)) {
      writeFileSync(`${out}/${label}-${theme}-${reduce}.json`, JSON.stringify({ pid: child.pid, label, theme, reduce, results, stalled: true }, null, 2))
      break
    }
    if (process.env.KYBERN_PACING_SCREENSHOTS !== '0') await app.screenshot({ path: `${out}/${label}-${theme}-${reduce}-${scene}.png` })
    writeFileSync(`${out}/${label}-${theme}-${reduce}.json`, JSON.stringify({ pid: child.pid, label, theme, reduce, results }, null, 2))
    console.log(JSON.stringify({...results.at(-1) as object, intervals: undefined,packets:undefined}))
  }
  writeFileSync(`${out}/${label}-${theme}-${reduce}.json`, JSON.stringify({ pid: child.pid, label, theme, reduce, results }, null, 2))
} finally {
  writeFileSync(`${out}/${label}-${theme}-${reduce}.log`, raw)
  try { await app?.close() } catch {}
  child.kill(); fixture.close(); release()
}
