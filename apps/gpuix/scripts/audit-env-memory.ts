// Audit-only relocation of src/environments/verify-memory.ts; assertions and UI steps unchanged.
import { launch } from '@gpuix/react/automation'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const samples: Record<string, string | undefined>[] = []
for (let round = 1; round <= 2; round++) {
  const app = await launch({ command: 'bun', args: ['src/main.tsx'], env: { ...process.env, GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: 'dark', KYBERN_DATA_DIR: process.env.KYBERN_DATA_DIR!, KYBERN_CLIENT_CONFIG_DIR: process.env.KYBERN_CLIENT_CONFIG_DIR!, KYBERN_GPUIX_CREDENTIALS_DIR: process.env.KYBERN_GPUIX_CREDENTIALS_DIR!, KYBERN_GPUIX_THREAD: process.env.KYBERN_GPUIX_THREAD! } })
  const pid = execFileSync('pgrep', ['-P', String(process.pid)], { encoding: 'utf8' }).trim().split('\n')[0]!
  const footprint = () => execFileSync('footprint', ['-p', pid], { encoding: 'utf8' }).match(/Footprint:\s+([\d.]+)\s+([KMG]B)/)?.slice(1).join(' ')
  async function click(id: string) { const control = app.getByTestId(id); await control.waitFor({ timeoutMs: 30000 }); await app.clock.pause(); await app.clock.fastForward(350); await app.clock.resume(); await control.click() }
  try {
    await app.getByTestId('composer').waitFor({ timeoutMs: 60000 })
    await app.getByTestId('environment-toggle').waitFor({ timeoutMs: 60000 })
    const result: Record<string, string | undefined> = { fresh: footprint() }
    await click('environment-switcher'); await click('environment-pair'); await click('pairing-create')
    await app.getByTestId('pairing-address').waitFor({ timeoutMs: 15000 }); await app.getByTestId('pairing-address').fill('http://192.0.2.10:4219'); await app.getByTestId('pairing-qr').waitFor({ timeoutMs: 15000 })
    result.pairing = footprint()
    await click('dialog-close'); await app.getByTestId('composer').waitFor()
    result.closed = footprint()
    await app.getByText('New chat').click(); await app.getByTestId('composer').waitFor()
    result.home = footprint()
    samples.push(result); console.log(`Run ${round}`, result)
  } finally { await app.close() }
}
writeFileSync('/Users/mymac/projects/ade/previews/gpuix/audit-2026-10-16/adapted/qr-memory-no-screenshots.json', JSON.stringify(samples, null, 2))
