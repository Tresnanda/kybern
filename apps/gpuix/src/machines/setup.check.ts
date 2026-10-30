// Run on the integrating agent's native verification lane; one scratch window at a time.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchFixture, waitForPainted } from '../requests/harness.ts'

const out = process.env.SHOT_OUT ?? path.resolve('.kybern-artifacts/machine-setup')
mkdirSync(out, { recursive: true })
for (const theme of ['dark', 'light']) for (const width of [760, 420]) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'gpuix-setup-check-'))
  const fixture = await launchFixture(path.join(import.meta.dir, 'setup.fixture.tsx'), {
    GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: theme, SETUP_WIDTH: String(width),
    KYBERN_REDUCED_MOTION: width === 420 ? '1' : '0', KYBERN_OPAQUE: '1',
    KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_GPUIX_CREDENTIALS_DIR: scratch,
    KYBERN_URL: '', KYBERN_TOKEN: '', KYBERN_GPUIX_ENVIRONMENT: 'local',
  })
  try {
    const app = fixture.app
    await app.getByTestId('setup-fixture-ready').waitFor({ timeoutMs: 15000 })
    await waitForPainted(app, 'Install and connect')
    await app.screenshot({ path: path.join(out, `${theme}-${width}.png`) })
    await app.getByTestId('machine-setup-install-missing').click()
    await waitForPainted(app, 'Installing the daemon and CLI')
    await app.getByTestId('machine-setup-cancel-missing').click()
    await waitForPainted(app, 'Setup canceled. Retry when you are ready.')
    assert.equal(await app.getByTestId('machine-setup-retry-missing').count(), 1)
    // Keyboard activation uses the same kit button, without an extra pointer click.
    await app.getByTestId('machine-setup-retry-missing').press('enter')
    assert.equal(await app.getByTestId('machine-setup-cancel-missing').count(), 0)
    await app.screenshot({ path: path.join(out, `${theme}-${width}-retried.png`) })
    assert(!/panic|uncaught|TypeError/.test(fixture.diagnostics()), fixture.diagnostics())
    console.log(`PASS machine setup ${theme} ${width}: install, cancel, retry, keyboard`)
  } finally { await fixture.close(); rmSync(scratch, { recursive: true, force: true }) }
}
