/**
 * ADE-97 Actions performance: the branch-grouped list of 100 runs (24 branches) and a 40-job run's graph while its edges flow.
 * Mock RPC only. Reports React commits of the tab (`KYBERN_ACTIONS_PROFILE`: React's actual render+commit ms per commit), the
 * native draws' render and layout ms (`KYBERN_FRAME_COSTS`), frame intervals (`[kybern-submit]`) and the app's CPU over each
 * window (`perf/sample.ts`).
 *
 *   NAPI_RS_NATIVE_LIBRARY_PATH=… bun src/pulls/verify.actions-perf.ts [--out <json>]
 */
import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { distribution } from '../../perf/bench/model.ts'
import { parseResources, Telemetry } from '../../perf/bench/telemetry.ts'
import { launchFixture } from '../requests/harness.ts'
import { actionFixture } from './verify.fixture.ts'

const argv = process.argv.slice(2)
const out = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : undefined
const commits: { at: number; phase: string; ms: number }[] = []
const t = new Telemetry()
const stderr = (chunk: string) => {
  t.stderr(chunk)
  for (const m of chunk.matchAll(/\[actions-commit\] (\w+) ([\d.]+)/g)) commits.push({ at: performance.now(), phase: m[1]!, ms: Number(m[2]) })
}
const fixture = actionFixture({ actionsBig: true })
const f = await launchFixture(path.join(import.meta.dir, '../main.tsx'), {
  KYBERN_WINDOW_SIZE: '1280x820', ...fixture.env, KYBERN_APPEARANCE: 'dark', KYBERN_ACTIONS_PROFILE: '1',
  KYBERN_FRAME_TIMES: '1', KYBERN_FRAME_COSTS: '1', KYBERN_FULL_RATE: '1', KYBERN_REDUCED_MOTION: '0',
}, { stderr })
const a = f.app
const GPUIX = path.resolve(import.meta.dir, '../..')
const sample = (seconds: number) => new Promise<string>((resolve, reject) => execFile('bun', [path.join(GPUIX, 'perf/sample.ts'), String(seconds), `GPUIX=${f.pid}`], { encoding: 'utf8' }, (error, stdout) => error ? reject(error) : resolve(stdout)))
const window = async (name: string, seconds: number, during?: () => Promise<void>) => {
  const mark = t.mark(), from = performance.now()
  const resources = sample(seconds)
  await during?.()
  const raw = await resources
  const r = t.result(mark)
  const ours = commits.filter(c => c.at >= from)
  const row = { name, seconds, commits: ours.length, commitMs: distribution(ours.map(c => c.ms)), commitTotalMs: Math.round(ours.reduce((n, c) => n + c.ms, 0) * 10) / 10, frames: r.frames, renderMs: r.work.renderMs, layoutMs: r.work.layoutMs, resources: parseResources(raw) }
  console.log(`${name}: commits ${row.commits} (p50 ${row.commitMs.p50?.toFixed(2)} p95 ${row.commitMs.p95?.toFixed(2)} max ${row.commitMs.max?.toFixed(2)} ms, total ${row.commitTotalMs} ms) | frames ${r.frames.count} p50 ${r.frames.p50?.toFixed(1)} p95 ${r.frames.p95?.toFixed(1)} >16.7 ${r.frames.over16_7} | draws render p50/p95 ${r.work.renderMs.p50?.toFixed(2)}/${r.work.renderMs.p95?.toFixed(2)} layout p95 ${r.work.layoutMs.p95?.toFixed(2)} | cpu ${row.resources.cpuPercent}%`)
  return row
}
const rows: object[] = []
try {
  await a.getByTestId('app-ready').waitFor({ timeoutMs: 60000 })
  await a.getByTestId('rail-pulls').click(); await Bun.sleep(400)
  // Opening the tab: the first read and its render.
  let mark = commits.length
  const opened = performance.now()
  await a.getByTestId('pulls-tab-actions').click()
  await a.getByTestId('actions-branch-perf/wide-matrix').waitFor({ timeoutMs: 15000 })
  const mount = commits.slice(mark)
  console.log(`open list (100 runs, ${fixture.params.filter(p => p.method === 'github.actions.runs').length} read): ${mount.length} commits, ${mount.map(c => c.ms.toFixed(1)).join(' / ')} ms, visible after ${Math.round(performance.now() - opened)} ms`)
  rows.push({ name: 'open list', commits: mount.map(c => c.ms) })
  await Bun.sleep(1500)
  rows.push(await window('list idle', 5))
  // A refresh that changes nothing re-renders nothing below the page (beads interned, rows memoized).
  rows.push(await window('list refresh x3 (unchanged)', 6, async () => { for (let i = 0; i < 3; i++) { await a.getByTestId('actions-refresh').click(); await Bun.sleep(1500) } }))
  // The 40-job run: its graph, then 8 s of flowing edges (the flow runs 7.2 s from when it mounts).
  mark = commits.length
  await a.getByTestId('actions-branch-perf/wide-matrix').click()
  await a.getByTestId('actions-graph').waitFor({ timeoutMs: 15000 })
  await Bun.sleep(300)
  const graph = commits.slice(mark)
  console.log(`open 40-job graph: ${graph.length} commits, ${graph.map(c => c.ms.toFixed(1)).join(' / ')} ms`)
  rows.push({ name: 'open 40-job graph', commits: graph.map(c => c.ms) })
  rows.push(await window('graph, edges flowing', 6))
  await Bun.sleep(2000)
  rows.push(await window('graph after the flow (clocks only)', 5))
  // kybern's CI with two running checks: the flow that does run.
  mark = commits.length
  await a.getByTestId('actions-branch-fix/reading-position').click()
  await a.getByTestId('actions-graph-flow').waitFor({ timeoutMs: 15000 })
  console.log(`open 8-job running graph: ${commits.length - mark} commits, ${commits.slice(mark).map(c => c.ms.toFixed(1)).join(' / ')} ms`)
  rows.push(await window('CI graph, two edges flowing', 6))
  await Bun.sleep(2000)
  rows.push(await window('CI graph after the flow (clocks only)', 5))
  if (out) writeFileSync(out, JSON.stringify(rows, null, 2))
} finally {
  await f.close()
  fixture.close()
}
