/**
 * Idle autorelease growth on a scratch test instance: the full product idles
 * on Home (no running row) while `heap` counts the Objective-C classes that
 * leaked into Bun's never-drained implicit pool. `MallocStackLogging=lite`
 * (KYBERN_RAMFIX_STACKS=1) adds allocation sites for a sample of the leaked
 * CFStrings and arrays.
 *
 *   KYBERN_DATA_DIR=/Users/mymac/projects/ade-gpuix-scratch/motion-ramfix \
 *   KYBERN_BENCH_PORT=4386 bun perf/ramfix/idle-leak.ts <label> [minutes]
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { seed } from '../bench/seed.ts'
import { launchFixture } from '../../src/requests/harness.ts'
import { onExit } from '../bench/lifetime.ts'
import { assertTestDisplayWindow } from '../images/onscreen.ts'

const label = process.argv[2] ?? 'idle'
const minutes = Number(process.argv[3] ?? '10')
const stacks = process.env.KYBERN_RAMFIX_STACKS === '1'
const addon = path.resolve(import.meta.dir, '../../native/build/gpuix-native.darwin-arm64.node')
const out = path.join(process.env.KYBERN_RAMFIX_EVIDENCE ?? '/Users/mymac/projects/ade/previews/motion/ramfix', `idle-${label}`)
mkdirSync(out, { recursive: true })

const CLASSES = ['NSMutableArray', 'NSMutableArray (Storage)', 'CFString', '@autoreleasepool content', '__NSMallocBlock__', 'NSMutableDictionary']
function heapCounts(pid: number) {
  const text = execFileSync('heap', [String(pid)], { encoding: 'utf8', maxBuffer: 64 << 20 })
  const counts: Record<string, number> = {}
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+[\d.]+\s+(.+?)\s{2,}/)
    if (m && CLASSES.includes(m[3]!)) counts[m[3]!] = Number(m[1])
  }
  const footprint = execFileSync('footprint', ['-p', String(pid)], { encoding: 'utf8' }).match(/phys_footprint:\s+([\d.]+ \w+)/)?.[1]
  return { counts, footprint, text }
}

const fixture = await seed(process.env.KYBERN_DATA_DIR!, Number(process.env.KYBERN_BENCH_PORT ?? '4386'))
const dropFixture = onExit(() => fixture.close())
const client = path.join(process.env.KYBERN_DATA_DIR!, `ramfix-${label}`)
mkdirSync(client, { recursive: true })
const f = await launchFixture(path.join(import.meta.dir, '../memory/app.ts'), {
  ...fixture.env, NAPI_RS_NATIVE_LIBRARY_PATH: addon, KYBERN_GPUIX_RESOURCES: '', KYBERND: '', KYBERN_BUNDLED_CLI: '',
  KYBERN_CLIENT_CONFIG_DIR: client, KYBERN_GPUIX_CREDENTIALS_DIR: path.join(client, 'credentials'), KYBERN_GPUIX_THREAD: '',
  GPUIX_BACKGROUND: '1', KYBERN_DEBUG_VISIBILITY: '1', ...(stacks ? { MallocStackLogging: 'lite' } : {}),
}, { stderr: chunk => { if (chunk.includes('[visibility]')) process.stdout.write(chunk) } }).catch(async error => { await fixture.close(); throw error })
dropFixture()
const stop = onExit(async () => { await f.close(); await fixture.close() })
try {
  await f.app.getByTestId('app-ready').waitFor()
  const port = JSON.parse(readFileSync(path.join(client, 'bench-control.json'), 'utf8')).port as number
  const control = async (action: string) => (await fetch(`http://127.0.0.1:${port}`, { method: 'POST', body: JSON.stringify({ action }) })).json() as Promise<Record<string, unknown>>
  while (!(await control('state')).listsLoaded) await Bun.sleep(50)
  await control('home'); await control('idle')
  await assertTestDisplayWindow(f.pid)
  await Bun.sleep(30000)
  const rows: { minute: number; counts: Record<string, number>; footprint?: string }[] = []
  const t0 = Date.now()
  for (;;) {
    const minute = (Date.now() - t0) / 60000
    const { counts, footprint, text } = heapCounts(f.pid)
    rows.push({ minute: Math.round(minute * 100) / 100, counts, footprint })
    console.log(JSON.stringify(rows.at(-1)))
    if (minute >= minutes) { writeFileSync(path.join(out, 'heap-final.txt'), text); break }
    await Bun.sleep(Math.min(150000, Math.max(1000, (minutes - minute) * 60000)))
  }
  const first = rows[0]!.counts, last = rows.at(-1)!.counts, span = rows.at(-1)!.minute - rows[0]!.minute
  const growth = Object.fromEntries(CLASSES.map(c => [c, { delta: (last[c] ?? 0) - (first[c] ?? 0), perMinute: Math.round((((last[c] ?? 0) - (first[c] ?? 0)) / span) * 10) / 10 }]))
  writeFileSync(path.join(out, 'results.json'), JSON.stringify({ label, minutes: span, addon, rows, growth }, null, 2))
  console.log(JSON.stringify(growth, null, 1))
  if (stacks) {
    for (const cls of ['CFString', 'NSMutableArray']) {
      const addresses = execFileSync('heap', [String(f.pid), '-addresses', `${cls}$`], { encoding: 'utf8', maxBuffer: 64 << 20 }).match(/0x[0-9a-f]+/g) ?? []
      assert(addresses.length, `No ${cls} addresses`)
      const sample = addresses.slice(-40).filter((_, i) => i % 4 === 0)
      const traces = sample.map(a => { try { return execFileSync('malloc_history', [String(f.pid), a], { encoding: 'utf8' }) } catch (e) { return String(e) } })
      writeFileSync(path.join(out, `stacks-${cls}.txt`), traces.join('\n\n'))
    }
  }
} finally { await f.close(); await fixture.close(); stop() }
