import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'

const out = '/Users/mymac/projects/ade/previews/gpuix/perf/markdown'
interface Result {
  scene: string; fullRate?: string; offeredPackets?: number; magnitude?: number
  firstContentMs?: number; frames?: number; p50?: number; p95?: number; p99?: number
  over16_7?: number; over33?: number; renderP50?: number; renderP95?: number
  layoutP95?: number; layoutCallsP50?: number; inputToCpuPaintP95?: number; offeredToAppKitHandlerEndP95?: number
  nativeBuildMarkersBefore?: string[]; nativeBuildMarkersAfter?: string[]; nativeBuildMarkersDuring?: string[]
  resourceText?: string; endReached?: boolean; closed?: boolean
}
const load = (label: string) => (JSON.parse(readFileSync(`${out}/${label}-dark.json`, 'utf8')) as { results: Result[] }).results
const resources = (text: string) => {
  const match = text.match(/total\s+([\d.]+) MiB\s+cpu\s+([\d.]+)%\s+gpu\s+([\d.]+) ms over ([\d.]+)s/)
  assert.ok(match, 'Resource sampler result is missing')
  return { footprintMiB: Number(match[1]), cpuPercent: Number(match[2]), gpuMs: Number(match[3]), seconds: Number(match[4]) }
}
const rows = ['before-preview', 'after-preview', 'before-pr', 'after-pr', 'before-current-native', 'after-large', 'after-containers'].flatMap(label =>
  load(label).map(result => {
    for (const key of ['nativeBuildMarkersBefore', 'nativeBuildMarkersAfter', 'nativeBuildMarkersDuring'] as const) assert.deepEqual(result[key], [])
    if (result.scene !== 'closed-idle') assert.equal(result.fullRate, '1')
    return { label, ...result, resourceText: undefined, intervals: undefined, ...resources(result.resourceText!) }
  }),
)
for (const scene of ['preview', 'pr']) {
  const before = rows.find(row => row.label === `before-${scene}` && row.scene !== 'closed-idle')!
  const after = rows.find(row => row.label === `after-${scene}` && row.scene !== 'closed-idle')!
  assert.equal(before.offeredPackets, after.offeredPackets)
  assert.equal(before.magnitude, after.magnitude)
}
for(const row of rows.filter(row=>row.label==='after-containers'&&row.scene!=='closed-idle')) {
  assert.ok(row.layoutCallsP50!<1000,`${row.scene}: warm layout must remain bounded`)
  assert.ok(row.renderP95!<16.7,`${row.scene}: warm render exceeds the 60 Hz budget`)
}
const pixels=JSON.parse(readFileSync(`${out}/app-pixel-comparison.json`,'utf8'))
assert.equal(pixels.length,8)
for(const result of pixels)assert.equal(result.changed,0)
const lifecycle = load('after-reachability')
assert.equal(lifecycle.length, 6)
for (const result of lifecycle) { assert.equal(result.endReached, true); assert.equal(result.closed, true) }
const summary = { fullRate: '1', theme: 'dark', window: '1440x900', warmupSeconds: 10, sampleSeconds: 15,
  input: '120 Hz synthetic precise AppKit wheel with contact and momentum; native submission and CPU-paint proxies', rows, lifecycle }
writeFileSync(`${out}/summary.json`, JSON.stringify(summary, null, 2) + '\n')
console.log('| Scenario | Frame p50/p95/p99 ms | >16.7/>33 ms | Render p95 ms | Handler/CPU paint p95 ms | CPU % | GPU ms/15 s | MiB | First content ms |')
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
const fmt = (value?: number) => value == null ? '—' : value.toFixed(2)
for (const row of rows) console.log(`| ${row.label}/${row.scene} | ${[row.p50, row.p95, row.p99].map(fmt).join('/')} | ${row.over16_7 ?? '—'}/${row.over33 ?? '—'} | ${fmt(row.renderP95)} | ${fmt(row.offeredToAppKitHandlerEndP95)}/${fmt(row.inputToCpuPaintP95)} | ${fmt(row.cpuPercent)} | ${fmt(row.gpuMs)} | ${row.footprintMiB} | ${fmt(row.firstContentMs)} |`)
