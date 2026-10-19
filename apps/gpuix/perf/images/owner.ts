/** Untimed ownership diagnosis. No performance/resource sample is collected. */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { launchFixture } from '../../src/requests/harness.ts'
import { gradientPng } from '../../visual/fixture.ts'
import { lease } from '../bench/lease.ts'
import { onExit } from '../bench/lifetime.ts'
import { requireScreen } from '../bench/screen-state.ts'
import { metadata } from '../memory/metadata.ts'
const data = '/Users/mymac/projects/ade-gpuix-scratch/perf-images-owner'
const out = '/Users/mymac/projects/ade/previews/gpuix/perf/images/owner-before'
const addon = path.resolve(import.meta.dir, '../../native/build/images-before.node')
mkdirSync(data, { recursive: true }); mkdirSync(out, { recursive: true })
const client = path.join(data, 'client'), images = path.join(data, 'memory-images'), stacks = path.join(data, 'stacks')
for (const dir of [client, images, stacks]) mkdirSync(dir, { recursive: true })
const png = gradientPng(1536, 1024)
for (let index = 0; index < 48; index++) writeFileSync(path.join(images, `${index}.png`), png)
while (readdirSync('/tmp').some(name => name.startsWith('kybern-gpuix-quiet.'))) await Bun.sleep(1000)
const release = await lease(), leave = onExit(release), screenBefore = requireScreen()
process.env.KYBERN_MEMORY_STACKS = '1'; metadata(out, addon, false)
let raw = ''
const f = await launchFixture(path.join(import.meta.dir, '../memory/lab.tsx'), { KYBERN_DATA_DIR: data, KYBERN_CLIENT_CONFIG_DIR: client, KYBERN_URL: '', KYBERN_TOKEN: '', NAPI_RS_NATIVE_LIBRARY_PATH: addon, KYBERN_MEMORY_EDITOR_EDITABLE: '1', KYBERN_MEMORY_COUNTERS: '1', GPUIX_BACKGROUND: '1', KYBERN_FULL_RATE: '1', MallocStackLogging: '1', MallocStackLoggingNoCompact: '1', MallocStackLoggingDirectory: stacks }, { stderr: text => { raw += text } })
const stop = onExit(f.close)
const timer = setTimeout(() => process.kill(process.pid, 'SIGTERM'), 250000)
const command = (name: string, program: string, args: string[]) => {
  let text: string
  try { text = execFileSync(program, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 }) }
  catch (error) { const failure = error as Error & { stdout?: Buffer; stderr?: Buffer }; text = `${failure.message}\n${failure.stdout?.toString() ?? ''}\n${failure.stderr?.toString() ?? ''}` }
  writeFileSync(path.join(out, name), text); return text
}
try {
  await f.app.getByTestId('app-ready').waitFor()
  const port = JSON.parse(readFileSync(path.join(client, 'memory-control.json'), 'utf8')).port
  const control = async (body: object) => (await fetch(`http://127.0.0.1:${port}`, { method: 'POST', body: JSON.stringify(body) })).json() as Promise<{ native: { editorImages: { entries: number } } }>
  await control({ action: 'scene', kind: 'editor-many', index: 0 })
  const deadline = Date.now() + 30000
  let open
  do { await Bun.sleep(100); open = await control({ action: 'stats' }); assert(Date.now() < deadline, '24 images must decode') } while (open.native.editorImages.entries !== 24)
  const bounds = await f.app.getByTestId('memory-editor-many').bounds()
  await f.app.mouse.click({ x: bounds.x + 24, y: bounds.y + 12 }); await Bun.sleep(1000)
  writeFileSync(path.join(out, 'open.json'), JSON.stringify(open, null, 2))
  await control({ action: 'scene', kind: 'home', index: 0 }); await Bun.sleep(3000)
  const closed = await control({ action: 'stats' }); assert.equal(closed.native.editorImages.entries, 0)
  writeFileSync(path.join(out, 'closed.json'), JSON.stringify(closed, null, 2))
  const heap = command('heap.txt', 'heap', ['-s', '-H', String(f.pid)])
  const kib = heap.match(/Sizes:\s*(\d+)KB\[/)?.[1]; assert(kib)
  const pattern = `malloc[${Number(kib) * 1024}]`
  const exact = command('addresses-exact.txt', 'heap', ['--noContent', `--addresses=${pattern}`, String(f.pid)])
  const addresses = /^\s*0x[0-9a-f]+\b/im.test(exact) ? exact : command('addresses-all.txt', 'heap', ['-s', '-H', '--noContent', '--addresses=all', String(f.pid)])
  const pointer = addresses.split('\n').flatMap(line => line.match(/^\s*(0x[0-9a-f]+)\b/i)?.[1] ?? [])[0]
  assert(pointer, 'Sorted all-address fallback must find the largest live allocation')
  command('calltree.txt', 'malloc_history', [String(f.pid), '-callTree', '-noContent', pointer])
  command('history.txt', 'malloc_history', [String(f.pid), '-fullStacks', pointer])
  command('owners.txt', 'leaks', ['--noContent', '--fullStacks', `--traceTree=${pointer}`, String(f.pid)])
  command('roots.txt', 'leaks', ['--noContent', '--conservative', `--trace=${pointer}`, String(f.pid)])
  writeFileSync(path.join(out, 'screen.json'), JSON.stringify({ screenBefore, screenAfter: requireScreen(), buildMarkers: readdirSync('/tmp').filter(name => name.startsWith('kybern-gpuix-native-build.')), role: 'Untimed allocation-owner diagnosis during build-only time; no performance/resource values' }, null, 2))
} finally { clearTimeout(timer); writeFileSync(path.join(out, 'native.log'), raw); await f.close(); stop(); release(); leave() }
