/** Summarize evidence without averaging cold and warm startup together. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
const out = process.argv[2]!
if (!out) throw Error('Pass the evidence directory')
function distribution(values: number[] = []) {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? null
  return { n: sorted.length, p50: at(.5), p95: at(.95), p99: at(.99), over16_7: sorted.filter(x => x > 16.7).length, over33: sorted.filter(x => x > 33).length }
}
type Run = { shell: number; sidebar: number; content: number; footprint: unknown; openMs?: number; openFootprint?: unknown; historyMs?: number; historyApplyMs?: number; historyFootprint?: unknown; historyFrames?: number[]; resourceFrames?: number[]; resourceCosts?: { render: number; layout: number }[]; resourceText?: string; idleFrames?: number; input?: { packets: number; elapsed: number; maxOutstanding: number; acknowledgements: number[]; targetHz?: number; samplePackets?: number }; timeline: { phase: string; ms: number; durationMs?: number }[]; rpcs: { method: string; fromSpawnMs: number; ms: number | null; before?: number }[]; buildGuard?: unknown }
const summary: Record<string, unknown> = {}
for (const name of ['before-active-fixed-0', 'after-active-fixed-0', 'before-active-fixed-1', 'after-active-fixed-1', 'control-static-fixed', 'control-dynamic-fixed', 'before-open-cold', 'after-open-cold', 'control-static-active', 'control-dynamic-active', 'before-active-repeat-0', 'after-active-repeat-0', 'before-active-repeat-1', 'after-active-repeat-1', 'before-active-repeat-2', 'after-active-repeat-2', 'before-package-fresh', 'after-package-fresh', 'before-dev', 'before-idle-history', 'before-package', 'before-package-idle', 'stage-import', 'before-open', 'after-open', 'after-dev', 'after-package', 'after-idle-history', 'after-package-idle', 'before-active', 'after-active', 'control-static-import', 'control-static-idle', 'history-120ms-prefetch-0', 'history-120ms-prefetch-1']) {
  const file = path.join(out, name + '.json')
  if (!existsSync(file)) continue
  const runs = JSON.parse(readFileSync(file, 'utf8')) as Run[]
  summary[name] = runs.map(run => ({ shell: run.shell, sidebar: run.sidebar, content: run.content, footprint: run.footprint, openMs: run.openMs, openFootprint: run.openFootprint, historyMs: run.historyMs, historyApplyMs: run.historyApplyMs, historyFootprint: run.historyFootprint, historyFrames: distribution(run.historyFrames), resourceFrames: distribution(run.resourceFrames), render: distribution(run.resourceCosts?.map(c => c.render)), layout: distribution(run.resourceCosts?.map(c => c.layout)), resourceText: run.resourceText, idleFrames: run.idleFrames, input: run.input && { targetHz: run.input.targetHz, samplePackets: run.input.samplePackets, packets: run.input.packets, matchedInput: run.input.targetHz != null && run.input.maxOutstanding < 32 && Math.abs(run.input.packets * 1000 / run.input.elapsed / run.input.targetHz - 1) < .05, actualHz: run.input.packets * 1000 / run.input.elapsed, maxOutstanding: run.input.maxOutstanding, acknowledgementMs: distribution(run.input.acknowledgements) }, timeline: run.timeline, bootListReads: run.rpcs.filter(rpc => rpc.method === 'threads.list' && rpc.fromSpawnMs <= run.content).length, historyRpcs: run.rpcs.filter(rpc => rpc.before != null), buildGuard: run.buildGuard }))
}
writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2))
console.log(path.join(out, 'summary.json'))
