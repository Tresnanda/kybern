import { launch } from '@gpuix/react/automation'
import { mkdirSync } from 'node:fs'
const out = '/Users/mymac/projects/ade/previews/gpuix/environments'
mkdirSync(out, { recursive: true })
const app = await launch({ command: 'bun', args: ['src/main.tsx'], env: { ...process.env, GPUIX_BACKGROUND: '1', KYBERN_CLIENT_CONFIG_DIR: '/Users/mymac/projects/ade-gpuix-scratch/environment-client', KYBERN_GPUIX_CREDENTIALS_DIR: '/Users/mymac/projects/ade-gpuix-scratch/environment-credentials', KYBERN_APPEARANCE: process.argv[2] ?? 'dark', KYBERN_DATA_DIR: '/Users/mymac/projects/ade-gpuix-scratch/data', KYBERN_GPUIX_THREAD: '01a13e34-40eb-7682-81b0-7cb58da9cc63' } })
async function click(id: string) {
  console.log('Click', id)
  const control = app.getByTestId(id)
  await control.waitFor({ timeoutMs: 60000 })
  const deadline = Date.now() + 15000
  while (true) {
    try { await control.click(); break } catch (e) { if (Date.now() > deadline) throw e; await new Promise((r) => setTimeout(r, 30)) }
  }
}
try {
  await app.getByTestId('environment-toggle').waitFor({ timeoutMs: 60000 })
  await click('environment-toggle')
  await app.getByTestId('environment-note').waitFor({ timeoutMs: 15000 })
  await app.getByTestId('environment-branch').waitFor({ timeoutMs: 15000 })
  await app.clock.pause(); await app.clock.fastForward(250)
  await app.screenshot({ path: `${out}/panel-${process.argv[2] ?? 'dark'}.png` })
  await app.clock.resume()
  await click('environment-sections')
  await app.getByTestId('environment-section-editor').waitFor()
  await click('environment-section-editor')
  if (await app.getByTestId('environment-editor').count()) throw Error('Editor section was not hidden')
  await click('environment-section-editor')
  await app.getByTestId('environment-editor').waitFor()
  console.log('Panel and section controls verified')
} catch (e) { await app.screenshot({ path: `${out}/failure.png` }); throw e } finally { await app.close() }
