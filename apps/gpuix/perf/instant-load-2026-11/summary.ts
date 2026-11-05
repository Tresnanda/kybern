/**
 * Markdown before/after table from bench results: `bun perf/instant-load-2026-11/summary.ts <before.json> <after.json> [...]`.
 * Cold and first opens are split into run 1 (no client cache yet) and later runs (cached by an earlier run, a relaunch).
 */
import { readFileSync } from 'node:fs'
import { median, p95 } from './meter.ts'

type Sample = { case: string; ms: number; run?: number; roundTrips?: number; bytes?: number; from?: string; liveMs?: number }
const files = process.argv.slice(2)
const results = files.map(file => JSON.parse(readFileSync(file, 'utf8')) as { label: string; samples: Sample[] })
const FIRST = new Set(['cold-restore-long', 'first-open-short', 'first-open-medium'])
const split = (samples: Sample[]) => samples.map(s => FIRST.has(s.case) ? { ...s, case: `${s.case} ${s.run === 0 ? '(no client cache)' : '(seen in an earlier run)'}` } : s)
const cases = [...new Set(results.flatMap(r => split(r.samples).map(s => s.case)))].filter(c => c !== 'daemon-spawn' && c !== 'connect')
const cell = (samples: Sample[], name: string) => {
  const xs = samples.filter(s => s.case === name)
  if (!xs.length) return '–'
  const ms = xs.map(s => s.ms), rt = median(xs.map(s => s.roundTrips ?? NaN)), bytes = median(xs.map(s => s.bytes ?? NaN))
  const from = [...new Set(xs.map(s => s.from).filter(Boolean))].join('/')
  return `${median(ms).toFixed(1)} / ${p95(ms).toFixed(1)} ms, ${Number.isFinite(rt) ? `${rt} RT, ` : ''}${Number.isFinite(bytes) ? `${(bytes / 1024).toFixed(0)} KB` : ''}${from ? ` (${from})` : ''}`
}
console.log(`| Case | ${results.map(r => r.label).join(' | ')} |`)
console.log(`|---|${results.map(() => '---').join('|')}|`)
for (const name of cases) console.log(`| ${name} | ${results.map(r => cell(split(r.samples), name)).join(' | ')} |`)
