import { launch } from '@gpuix/react/automation'
import { assertScratchEnv } from '../requests/harness.ts'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
const out = process.env.KYBERN_VERIFY_OUTPUT ?? '/Users/mymac/projects/ade/previews/gpuix/environments'
mkdirSync(out, { recursive: true })
const mode = process.argv[2] ?? 'dark'
assertScratchEnv({ KYBERN_DATA_DIR: process.env.KYBERN_DATA_DIR ?? '/Users/mymac/projects/ade-gpuix-scratch/data' })
const app = await launch({ command: 'bun', args: ['src/main.tsx'], env: { ...process.env, GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: mode, KYBERN_DATA_DIR: process.env.KYBERN_DATA_DIR ?? '/Users/mymac/projects/ade-gpuix-scratch/data', KYBERN_CLIENT_CONFIG_DIR: process.env.KYBERN_CLIENT_CONFIG_DIR ?? '/Users/mymac/projects/ade-gpuix-scratch/environment-client', KYBERN_GPUIX_CREDENTIALS_DIR: process.env.KYBERN_GPUIX_CREDENTIALS_DIR ?? '/Users/mymac/projects/ade-gpuix-scratch/environment-credentials', KYBERN_GPUIX_THREAD: process.env.KYBERN_GPUIX_THREAD ?? '01a13e34-40eb-7682-81b0-7cb58da9cc63' } })
async function click(id: string) {
  console.log('Click', id)
  const control = app.getByTestId(id)
  await control.waitFor({ timeoutMs: 30000 })
  await app.clock.pause(); await app.clock.fastForward(350); await app.clock.resume()
  const deadline = Date.now() + 15000
  while (true) { try { await control.click(); return } catch (e) { if (Date.now() > deadline) throw e; await new Promise((r) => setTimeout(r, 30)) } }
}
async function absent(id: string) {
  const deadline = Date.now() + 15000
  while (await app.getByTestId(id).count()) { if (Date.now() > deadline) throw Error(`Still present: ${id}`); await new Promise((r) => setTimeout(r, 30)) }
}
async function shot(name: string) { await app.clock.pause(); await app.clock.fastForward(300); await app.screenshot({ path: `${out}/${name}-${mode}.png` }); await app.clock.resume() }
async function switchTo(id: string) { await click('environment-switcher'); await click(`environment-choice-${id}`) }
function footprint(pid: string) { const text = execFileSync('footprint', ['-p', pid], { encoding: 'utf8' }); return text.match(/Footprint:\s+([\d.]+)\s+([KMG]B)/)?.slice(1).join(' ') }
try {
  await app.getByTestId('environment-toggle').waitFor({ timeoutMs: 60000 })
  const pid = execFileSync('pgrep', ['-P', String(process.pid)], { encoding: 'utf8' }).trim().split('\n')[0]!
  console.log('GPUIX pid', pid)
  await click('environment-toggle')
  await app.getByTestId('environment-note').waitFor()
  await app.getByTestId('environment-note').fill('Environment A private draft')
  await click('environment-editor')
  await app.getByTestId('composer').fill('Unsent environment A composer draft')
  await app.getByTestId('dock-toggle').waitFor()
  await switchTo('scratch-second')
  await app.getByTestId(`project-${process.env.KYBERN_VERIFY_SECOND_PROJECT ?? '01a13e84-e91e-79c0-8e33-b6f34290a61c'}`).waitFor({ timeoutMs: 30000 })
  await absent('environment-toggle')
  if ((await app.getByText('Environment A private draft').count()) || (await app.getByText('scratch-project').count())) throw Error('A data leaked into B')
  console.log('B has no A thread/project/note')
  await shot('second')
  await switchTo('local')
  await app.getByTestId('environment-toggle').waitFor({ timeoutMs: 30000 })
  await click('environment-toggle')
  await app.getByTestId('environment-note').waitFor()
  if (!readFileSync(`${process.env.KYBERN_DATA_DIR ?? '/Users/mymac/projects/ade-gpuix-scratch/data'}/gpuix-ui.json`, 'utf8').includes('Environment A private draft')) throw Error('Note draft not persisted')
  await shot('restored-panel')
  await click('environment-toggle')
  console.log('After warmup', footprint(pid))
  const memory: (string | undefined)[] = []
  for (let n = 0; n < (process.env.FORMS_ONLY ? 0 : 5); n++) {
    await switchTo('scratch-second'); await app.getByTestId(`project-${process.env.KYBERN_VERIFY_SECOND_PROJECT ?? '01a13e84-e91e-79c0-8e33-b6f34290a61c'}`).waitFor({ timeoutMs: 30000 })
    await switchTo('local'); await app.getByTestId('environment-toggle').waitFor({ timeoutMs: 30000 })
    memory.push(footprint(pid)); console.log(`Round trip ${n + 1}`, memory.at(-1))
  }
  await click('environment-switcher'); await shot('switcher')
  await click('environment-add'); await app.getByTestId('environment-name').waitFor(); await shot('add')
  await click('dialog-close'); await click('environment-switcher'); await click('environment-manage'); await app.getByTestId('environment-manage-list').waitFor(); await shot('manage')
  await click('dialog-close'); await click('environment-switcher'); await click('environment-pair'); await app.getByTestId('pairing-create').waitFor(); await click('pairing-create'); await app.getByTestId('pairing-address').waitFor({ timeoutMs: 15000 })
  await app.getByTestId('pairing-address').fill('http://192.0.2.10:4219')
  await app.getByTestId('pairing-qr').waitFor({ timeoutMs: 15000 }); await shot('pair')
  writeFileSync(`${out}/switch-memory-${mode}.json`, JSON.stringify(memory))
  await click('dialog-close')
  await click('environment-toggle')
  if (process.env.MEASURE) {
    const sample = () => new Promise<string>((resolve, reject) => { const p = spawn('bun', ['perf/sample.ts', '15', `GPUIX=${pid}`]); let output = ''; p.stdout.on('data', (v) => output += v); p.on('exit', (code) => code ? reject(Error(`Perf sample failed ${code}`)) : resolve(output)) })
    const idle = await sample(); console.log('Idle panel', idle); writeFileSync(`${out}/perf-idle.txt`, idle)
    let done = false
    const sampling = sample().finally(() => { done = true })
    let interactions = 0
    while (!done) { await click('environment-toggle'); await click('environment-toggle'); interactions += 2 }
    const active = await sampling; console.log('Active panel', interactions, active); writeFileSync(`${out}/perf-active.txt`, `${interactions} panel toggles\n${active}`)
  }
  console.log('Switching, forms and native QR verified')
} catch (e) { await shot('failure'); throw e } finally { await app.close() }
