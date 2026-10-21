/**
 * Where the leaked font-path CFStrings come from. Runs the current addon with
 * the per-tick pool disabled (`KYBERN_TICK_POOL=0`) and malloc stack logging,
 * opens text-heavy content, then prints the newest CFStrings that name a font
 * file and their allocation stacks (`heap` content, `malloc_history`).
 *
 *   KYBERN_DATA_DIR=/Users/mymac/projects/ade-gpuix-scratch/motion-ramfix \
 *   KYBERN_BENCH_PORT=4386 bun perf/ramfix/font-strings.ts
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { seed } from '../bench/seed.ts'
import { launchFixture } from '../../src/requests/harness.ts'
import { onExit } from '../bench/lifetime.ts'

const out = path.join(process.env.KYBERN_RAMFIX_EVIDENCE ?? '/Users/mymac/projects/ade/previews/motion/ramfix', 'font-strings')
mkdirSync(out, { recursive: true })
const addon = path.resolve(import.meta.dir, '../../native/build/gpuix-native.darwin-arm64.node')
const fixture = await seed(process.env.KYBERN_DATA_DIR!, Number(process.env.KYBERN_BENCH_PORT ?? '4386'))
const dropFixture = onExit(() => fixture.close())
const client = path.join(process.env.KYBERN_DATA_DIR!, 'ramfix-font-strings'); mkdirSync(client, { recursive: true })
const f = await launchFixture(path.join(import.meta.dir, 'app.ts'), {
  ...fixture.env, NAPI_RS_NATIVE_LIBRARY_PATH: addon, KYBERN_GPUIX_RESOURCES: '', KYBERND: '', KYBERN_BUNDLED_CLI: '',
  KYBERN_CLIENT_CONFIG_DIR: client, KYBERN_GPUIX_CREDENTIALS_DIR: path.join(client, 'credentials'), KYBERN_GPUIX_THREAD: '',
  GPUIX_BACKGROUND: '1', KYBERN_TICK_POOL: process.env.KYBERN_TICK_POOL ?? '0', KYBERN_IDLE_RELEASE: '0', MallocStackLogging: 'lite',
}).catch(async error => { await fixture.close(); throw error })
dropFixture()
const stop = onExit(async () => { await f.close(); await fixture.close() })
try {
  await f.app.getByTestId('app-ready').waitFor({ timeoutMs: 60000 })
  const port = JSON.parse(readFileSync(path.join(client, 'bench-control.json'), 'utf8')).port as number
  const control = async (action: string, args: Record<string, unknown> = {}) => (await fetch(`http://127.0.0.1:${port}`, { method: 'POST', body: JSON.stringify({ action, ...args }) })).json() as Promise<Record<string, unknown>>
  while (!(await control('state')).listsLoaded) await Bun.sleep(50)
  const count = () => Number(execFileSync('heap', [String(f.pid)], { encoding: 'utf8', maxBuffer: 64 << 20 }).match(/^\s*(\d+)\s+\d+\s+[\d.]+\s+CFString\s+ObjC/m)?.[1] ?? 0)
  await control('home'); await Bun.sleep(3000)
  const before = count()
  for (const thread of [fixture.manifest.long1000, fixture.manifest.long3000, fixture.manifest.running]) { await control('open', { thread }); await Bun.sleep(2500) }
  await control('explorer', { file: fixture.manifest.markdown }); await Bun.sleep(2500)
  await control('dock-close')
  // Every heading level, bold and italic: new sizes and weights of the variable system font.
  const body = Array.from({ length: 6 }, (_, i) => `${'#'.repeat(i + 1)} Heading ${i + 1}\n\nBody **bold ${i}** and *italic ${i}* and \`code ${i}\`.\n`).join('\n')
  const note = await fixture.client.call('notes.create', { scope: 'project', project_id: fixture.manifest.projects[0], title: `Font sizes ${Date.now()}`, body }) as { id: string }
  const memory = JSON.parse(readFileSync(path.join(client, 'memory-control.json'), 'utf8')).port as number
  await fetch(`http://127.0.0.1:${memory}`, { method: 'POST', body: JSON.stringify({ action: 'note', note: note.id }) }); await Bun.sleep(2500)
  await control('home'); await Bun.sleep(3000)
  const after = count()
  // `heap --addresses` prints each string's content (no debugger: Bun refuses attach).
  const listing = execFileSync('heap', [String(f.pid), '-addresses', 'CFString$'], { encoding: 'utf8', maxBuffer: 256 << 20 })
  writeFileSync(path.join(out, 'cfstrings.txt'), listing)
  const lines = listing.split('\n').filter(line => /^0x[0-9a-f]+/.test(line.trim()))
  const fonts = lines.filter(line => /\.(ttf|otf|ttc)\b|postscript-name/.test(line)).map(line => line.trim().match(/^0x[0-9a-f]+/)![0])
  const addresses = lines
  const stacks = fonts.slice(-3).map(a => { try { return execFileSync('malloc_history', [String(f.pid), a], { encoding: 'utf8', maxBuffer: 16 << 20 }) } catch (e) { return String(e) } })
  writeFileSync(path.join(out, 'result.json'), JSON.stringify({ tickPool: process.env.KYBERN_TICK_POOL ?? '0', cfStringsBefore: before, cfStringsAfter: after, sampled: addresses.length, fontStringsInSample: fonts.length }, null, 2))
  writeFileSync(path.join(out, 'stacks.txt'), stacks.join('\n\n'))
  console.log(JSON.stringify({ before, after, fonts: fonts.length }))
} finally { await f.close(); await fixture.close(); stop() }
