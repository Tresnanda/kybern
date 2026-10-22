/**
 * Tables for the interleaved translucency gate. Reads the JSON lines `gate2.ts` writes.
 *
 *   bun perf/bench/gate2-report.ts <file.jsonl> [--tag primary] [--pairs window:solid,window:sidebar,sidebar:solid,solid-aa:solid] [--aa solid-aa:solid|none] [--rounds 1,2] [--json out.json]
 *
 * Unit of analysis is the block (one arm, one round, one scenario = three windows). A block value is the median of its
 * windows (the >33 ms count is their sum, i.e. per 45 s). A pair is the same round and scenario for the two arms, and is
 * invalid when its submission counts differ by more than 10%. Round 0 (the warm-up pass) is never used.
 */
import {readFileSync,writeFileSync} from 'node:fs'
import {bootstrap,median,sameCadence,verdict,type Verdict} from './gate2-stats.ts'
import type {WindowRow} from './gate2.ts'

type Metric = {key: string; label: string; rel: boolean; threshold: number | null; get: (w: WindowRow) => number | null; sum?: boolean; scenarios: 'active' | 'idle'}
const per = (w: WindowRow, v: number | null) => v == null || !w.frames ? null : v / w.frames
const cpuMsPerFrame = (w: WindowRow) => w.cpuPercent == null || w.sampleSeconds == null || !w.frames ? null : w.cpuPercent * w.sampleSeconds * 10 / w.frames
export const METRICS: Metric[] = [
  {key: 'p95', label: 'Frame p95 ms', rel: false, threshold: 1.5, get: w => w.p95, scenarios: 'active'},
  {key: 'over33', label: 'Intervals > 33 ms per 45 s', rel: false, threshold: 2, get: w => w.over33, sum: true, scenarios: 'active'},
  {key: 'cpuPts', label: 'GPUIX CPU points', rel: false, threshold: 5, get: w => w.cpuPercent, scenarios: 'active'},
  {key: 'cpuFrame', label: 'GPUIX CPU ms / frame (%)', rel: true, threshold: 10, get: cpuMsPerFrame, scenarios: 'active'},
  {key: 'gpuFrame', label: 'GPUIX GPU ms / frame (%)', rel: true, threshold: 15, get: w => per(w, w.gpuMs), scenarios: 'active'},
  {key: 'wsCpu', label: 'WindowServer CPU points', rel: false, threshold: 4, get: w => w.wsCpuPercent, scenarios: 'active'},
  {key: 'wsGpu', label: 'WindowServer GPU ms (%)', rel: true, threshold: 20, get: w => w.wsGpuMs, scenarios: 'active'},
  {key: 'frames', label: 'Submissions per 15 s window (%)', rel: true, threshold: null, get: w => w.frames, scenarios: 'active'},
  {key: 'gpuTotal', label: 'GPUIX GPU ms per window (%)', rel: true, threshold: null, get: w => w.gpuMs, scenarios: 'active'},
  {key: 'mib', label: 'GPUIX MiB', rel: false, threshold: null, get: w => w.footprintMiB, scenarios: 'active'},
  {key: 'idleCpu', label: 'Idle CPU points', rel: false, threshold: 1.5, get: w => w.cpuPercent, scenarios: 'idle'},
  {key: 'idleMib', label: 'Idle MiB', rel: false, threshold: 15, get: w => w.footprintMiB, scenarios: 'idle'},
  {key: 'idleWsGpu', label: 'Idle WindowServer GPU ms (%)', rel: true, threshold: 20, get: w => w.wsGpuMs, scenarios: 'idle'},
  {key: 'idleWsCpu', label: 'Idle WindowServer CPU points', rel: false, threshold: null, get: w => w.wsCpuPercent, scenarios: 'idle'},
]

export function readRows(file: string, tag: string) {
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as WindowRow).filter(r => r.tag === tag)
}
const blockKey = (arm: string, round: number, scenario: string) => `${arm}|${round}|${scenario}`
export function blocks(rows: WindowRow[]) {
  const groups = new Map<string, WindowRow[]>()
  for (const r of rows) if (r.round > 0 && r.status === 'ok') { const k = blockKey(r.arm, r.round, r.scenario); groups.set(k, [...(groups.get(k) ?? []), r]) }
  return groups
}
const blockValue = (windows: WindowRow[] | undefined, m: Metric) => {
  if (!windows?.length) return null
  const values = windows.flatMap(w => { const v = m.get(w); return v == null || Number.isNaN(v) ? [] : [v] })
  if (!values.length) return null
  return m.sum ? values.reduce((a, b) => a + b, 0) / values.length * 3 : median(values)
}

export type Row = {pair: string; scenario: string; metric: string; label: string; threshold: number | null; rel: boolean; n: number; invalid: number; est: number | null; lo: number | null; hi: number | null; aaHi: number | null; verdict: Verdict | 'info'}
export function compare(rows: WindowRow[], x: string, base: string, aa: {x: string; base: string} | null, scenarios: string[]) {
  const all = blocks(rows), out: Row[] = [], rounds = [...new Set(rows.filter(r => r.round > 0).map(r => r.round))].sort((a, b) => a - b)
  const deltas = (a: string, b: string, scenario: string, m: Metric) => {
    const ds: number[] = []; let invalid = 0
    for (const round of rounds) {
      const wa = all.get(blockKey(a, round, scenario)), wb = all.get(blockKey(b, round, scenario))
      const va = blockValue(wa, m), vb = blockValue(wb, m)
      if (va == null || vb == null) continue
      if (m.scenarios === 'active') {
        const fa = median(wa!.map(w => w.frames ?? 0))!, fb = median(wb!.map(w => w.frames ?? 0))!
        if (!sameCadence(fa, fb)) { invalid++; continue }
      }
      if (m.rel) { if (vb === 0) continue; ds.push((va - vb) / vb * 100) } else ds.push(va - vb)
    }
    return {ds, invalid}
  }
  for (const scenario of scenarios) for (const m of METRICS.filter(m => m.scenarios === (scenario.startsWith('idle-') ? 'idle' : 'active'))) {
    const {ds, invalid} = deltas(x, base, scenario, m), ci = bootstrap(ds, 11)
    const aaCi = aa ? bootstrap(deltas(aa.x, aa.base, scenario, m).ds, 13) : null
    out.push({pair: `${x} vs ${base}`, scenario, metric: m.key, label: m.label, threshold: m.threshold, rel: m.rel, n: ds.length, invalid, est: ci?.est ?? null, lo: ci?.lo ?? null, hi: ci?.hi ?? null, aaHi: aaCi?.hi ?? null, verdict: m.threshold == null ? 'info' : verdict(ci, m.threshold, aaCi)})
  }
  return out
}

/** CPU fails only when both the point rule and the per-frame rule fail (research doc: "+5 points, or +10% CPU ms per frame"). */
export function cpuVerdict(rows: Row[], scenario: string): Verdict {
  const a = rows.find(r => r.scenario === scenario && r.metric === 'cpuPts')?.verdict, b = rows.find(r => r.scenario === scenario && r.metric === 'cpuFrame')?.verdict
  if (a === 'FAIL' && b === 'FAIL') return 'FAIL'
  if (a === 'uninformative' && b === 'uninformative') return 'uninformative'
  if (a === 'insufficient' || b === 'insufficient') return 'insufficient'
  return a === 'unresolved' || b === 'unresolved' ? 'unresolved' : 'pass'
}

const f = (n: number | null, d = 2) => n == null ? '—' : n.toFixed(d)
export function markdown(rows: WindowRow[], pairs: string[], aaSpec: string | null) {
  const scenarios = [...new Set(rows.map(r => r.scenario))]
  const aa = aaSpec ? {x: aaSpec.split(':')[0]!, base: aaSpec.split(':')[1]!} : null
  const lines: string[] = [], summary: Row[] = []
  const status = new Map<string, number>(); for (const r of rows) status.set(r.status, (status.get(r.status) ?? 0) + 1)
  lines.push(`Windows: ${rows.length} (${[...status].map(([k, v]) => `${v} ${k}`).join(', ')}); warm-up round 0 excluded from every table.`, '')
  // Absolute medians per arm and scenario (median of round medians).
  const all = blocks(rows), arms = [...new Set(rows.map(r => r.arm))], rounds = [...new Set(rows.filter(r => r.round > 0).map(r => r.round))].sort((a, b) => a - b)
  const abs = ['p95', 'over33', 'cpuPts', 'cpuFrame', 'gpuFrame', 'wsCpu', 'wsGpu', 'frames', 'mib'], idleAbs = ['idleCpu', 'idleMib', 'idleWsGpu', 'idleWsCpu']
  const metric = (key: string) => METRICS.find(m => m.key === key)!
  lines.push('#### Absolute values (median over rounds of block medians)', '', '| Scenario | Arm | ' + [...abs, ...idleAbs].map(k => metric(k).label.replace(/ \(%\)/, '').replace(' ms / frame', ' ms/frame')).join(' | ') + ' |', '|---|---|' + [...abs, ...idleAbs].map(() => '---:').join('|') + '|')
  for (const scenario of scenarios) for (const arm of arms) {
    const idle = scenario.startsWith('idle-'), keys = idle ? idleAbs : abs
    const cells = [...abs, ...idleAbs].map(k => keys.includes(k) ? f(median(rounds.flatMap(r => { const v = blockValue(all.get(blockKey(arm, r, scenario)), metric(k)); return v == null ? [] : [v] })), k === 'frames' || k === 'wsGpu' || k === 'idleWsGpu' ? 0 : 2) : '')
    lines.push(`| ${scenario} | ${arm} | ${cells.join(' | ')} |`)
  }
  const idleRows = rows.filter(r => r.scenario.startsWith('idle-') && r.status === 'ok')
  const idleActive = idleRows.filter(r => (r.frames ?? 0) > 0 || (r.gpuMs ?? 0) > 0)
  lines.push('', `Idle invariant (submissions and GPUIX GPU ms stay 0): ${idleRows.length - idleActive.length}/${idleRows.length} windows at 0${idleActive.length ? `; **violations**: ${idleActive.map(r => `${r.arm} r${r.round} run ${r.run}: ${r.frames} submissions, ${r.gpuMs} ms`).join('; ')}` : ''}.`, '')
  for (const spec of [...pairs, ...(aaSpec && !pairs.includes(aaSpec) ? [aaSpec] : [])]) {
    const [x, base] = spec.split(':') as [string, string]
    const cmp = compare(rows, x, base, spec === aaSpec ? null : aa, scenarios); summary.push(...cmp)
    lines.push(`#### ${x} − ${base}${spec === aaSpec ? ' (A/A control: the same mode twice)' : ''}`, '', 'Δ is the median of per-round paired differences, with a 90% bootstrap CI over rounds. Percent rows are relative to the base arm. A/A upper is the A/A CI upper bound for that metric.', '',
      '| Scenario | Metric | Δ | 90% CI | Pairs (invalid) | Limit | A/A upper | Result |', '|---|---|---:|---|---:|---:|---:|---|')
    for (const r of cmp) lines.push(`| ${r.scenario} | ${r.label} | ${f(r.est)}${r.rel ? '%' : ''} | ${r.lo == null ? '—' : `${f(r.lo)} … ${f(r.hi)}`} | ${r.n} (${r.invalid}) | ${r.threshold == null ? '—' : `+${r.threshold}${r.rel ? '%' : ''}`} | ${spec === aaSpec ? '—' : f(r.aaHi)} | ${r.verdict === 'FAIL' ? '**FAIL**' : r.verdict} |`)
    const cpuRows = scenarios.filter(s => !s.startsWith('idle-')).map(s => `${s}: ${cpuVerdict(cmp, s)}`)
    const fails = cmp.filter(r => r.verdict === 'FAIL' && r.metric !== 'cpuPts' && r.metric !== 'cpuFrame').map(r => `${r.scenario} ${r.label}`)
    const cpuFails = scenarios.filter(s => !s.startsWith('idle-') && cpuVerdict(cmp, s) === 'FAIL').map(s => `${s} CPU`)
    const unin = cmp.filter(r => r.verdict === 'uninformative').map(r => `${r.scenario} ${r.label}`)
    lines.push('', `CPU rule (points AND per-frame must both fail): ${cpuRows.join('; ')}.`, `**${x} vs ${base}: ${[...fails, ...cpuFails].length ? `FAILS — ${[...fails, ...cpuFails].join('; ')}` : 'no metric fails'}.**${cmp.some(r => r.verdict === 'insufficient') ? ` ${cmp.filter(r => r.verdict === 'insufficient').length} metrics have fewer than 3 valid pairs and are insufficient, not passed.` : ''}${unin.length ? ` Uninformative this session (A/A reaches the limit): ${unin.join('; ')}.` : ''}`, '')
  }
  return {text: lines.join('\n'), summary}
}

if (import.meta.main) {
  const args = process.argv.slice(2), file = args[0]?.startsWith('--') ? undefined : args[0]
  const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined }
  if (!file) throw Error('usage: bun perf/bench/gate2-report.ts <file.jsonl> [--tag primary] [--pairs a:b,c:d] [--aa solid-aa:solid] [--json out.json]')
  const only = opt('rounds')?.split(',').map(Number), rows = readRows(file, opt('tag') ?? 'primary').filter(r => !only || only.includes(r.round)), pairs = (opt('pairs') ?? 'window:solid,window:sidebar,sidebar:solid').split(','), aaOpt = opt('aa') ?? 'solid-aa:solid', aa = aaOpt === 'none' ? null : aaOpt
  const {text, summary} = markdown(rows, pairs, aa)
  console.log(text)
  const json = opt('json'); if (json) writeFileSync(json, JSON.stringify(summary, null, 1))
}
