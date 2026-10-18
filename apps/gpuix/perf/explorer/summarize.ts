import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { pngPixels } from '../../native/clip-pixels.ts'

const out = '/Users/mymac/projects/ade/previews/gpuix/perf/explorer'
type Result = { scene: string; frames: number; p50: number | null; p95: number | null; p99: number | null; over16_7: number; over33: number; max: number; renderP95: number; inputToCpuPaintP95: number; deliveredAtOfferEnd: number; offeredToAppKitHandlerEndP95: number; firstContentMs: number; resourceText: string }
const read = (label: string) => JSON.parse(readFileSync(`${out}/${label}-dark.json`, 'utf8')).results as Result[]
const before = [...read('baseline-clean-tree'), ...read('baseline-clean-preview'), ...read('baseline-clean-source')]
const after = read('final-clean')
const resources = (result: Result) => {
  const match = result.resourceText.match(/total\s+([\d.]+) MiB\s+cpu\s+([\d.]+)%\s+gpu\s+([\d.]+) ms/)
  assert.ok(match, result.resourceText)
  return { footprintMiB: Number(match[1]), cpuPercent: Number(match[2]), gpuMs: Number(match[3]) }
}
const comparisons = before.map(previous => {
  const next = after.find(r => r.scene === previous.scene)
  assert.ok(next, previous.scene)
  return { scene: previous.scene, before: { ...previous, resourceText: undefined, ...resources(previous) }, after: { ...next, resourceText: undefined, ...resources(next) } }
})
if (existsSync(`${out}/final-combined-dark.json`)) {
  for (const next of read('final-combined').filter(r => r.scene !== 'closed-idle')) {
    const previous = read(next.scene === 'long.ts' ? 'baseline-combined-code' : 'baseline-combined-preview')[0]!
    comparisons.push({ scene: `full tree + ${next.scene}`, before: { ...previous, resourceText: undefined, ...resources(previous) }, after: { ...next, resourceText: undefined, ...resources(next) } })
  }
}
writeFileSync(`${out}/comparison.json`, JSON.stringify({ fullRate: '1', profile: false, comparisons, idle: { clean: after.find(r => r.scene === 'closed-idle'), combined: existsSync(`${out}/final-combined-dark.json`) ? read('final-combined').find(r => r.scene === 'closed-idle') : undefined } }, null, 2))
const visual = []
for (const theme of ['dark', 'light']) for (const scene of theme === 'dark' ? ['tree', 'preview.md', 'long.md', 'long.ts', 'minified.ts', 'large.json'] : ['tree', 'preview.md', 'long.ts']) for (const phase of ['', '-scrolled']) {
  const label = theme === 'light' ? '-light' : ''
  const a = pngPixels(`${out}/baseline-visual${label}-${theme}-${scene}${phase}.png`), b = pngPixels(`${out}/final-visual${label}-${theme}-${scene}${phase}.png`)
  assert.equal(a.width, b.width); assert.equal(a.height, b.height)
  // Explorer body only: provider-catalog/Handoff header state and unrelated
  // project rows are asynchronous and outside the changed surface.
  const crop = { x: Math.ceil(a.width * .438), y: Math.ceil(a.height * .115), right: a.width - 8, bottom: a.height - 8 }
  let changed = 0, max = 0
  for (let y = crop.y; y < crop.bottom; y++) for (let x = crop.x; x < crop.right; x++) {
    const aa = a.at(x,y), bb = b.at(x,y)
    const delta = Math.max(...aa.map((v,c) => Math.abs(v-bb[c]!)))
    max = Math.max(max,delta); if (delta > 2) changed++
  }
  visual.push({ theme, scene, phase: phase || 'initial', crop, changed, max })
}
writeFileSync(`${out}/visual-comparison.json`, JSON.stringify(visual, null, 2))
const f = (value: number | null) => value == null ? '—' : value.toFixed(2)
console.log('| Scene | Frames before→after | p50/p95/p99 ms before → after | >16.7/>33 before → after | Max ms before→after | CPU % | GPU ms/15s | MiB |')
console.log('|---|---:|---|---|---|---|---|---|')
for (const { scene, before: b, after: a } of comparisons) console.log(`| ${scene} | ${b.frames}→${a.frames} | ${f(b.p50)}/${f(b.p95)}/${f(b.p99)} → ${f(a.p50)}/${f(a.p95)}/${f(a.p99)} | ${b.over16_7}/${b.over33} → ${a.over16_7}/${a.over33} | ${f(b.max)}→${f(a.max)} | ${f(b.cpuPercent)}→${f(a.cpuPercent)} | ${f(b.gpuMs)}→${f(a.gpuMs)} | ${b.footprintMiB}→${a.footprintMiB} |`)
console.log('Visuals:', visual)
