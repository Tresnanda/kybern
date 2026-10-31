// Run through native/ui-lease.ts. Real GPUIX controls, deterministic machine services.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchFixture, waitForPainted } from '../requests/harness.ts'

const out = process.env.KYBERN_VERIFY_OUTPUT
for (const appearance of ['dark', 'light']) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'gpuix-scratch-preview-network-'))
  const log = path.join(scratch, 'calls.jsonl')
  writeFileSync(log, '')
  const fixture = await launchFixture(path.join(import.meta.dir, 'network.fixture.tsx'), {
    KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_GPUIX_CREDENTIALS_DIR: scratch,
    KYBERN_URL: '', KYBERN_TOKEN: '', KYBERN_GPUIX_ENVIRONMENT: 'local', KYBERN_APPEARANCE: appearance,
    GPUIX_BACKGROUND: '1', KYBERN_NO_ACTIVATE: '1', KYBERN_OPAQUE: '1', KYBERN_PREVIEW_CHECK_LOG: log,
  })
  const a = fixture.app
  const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  try {
    await a.getByTestId('preview-network-ready').waitFor()
    await a.getByTestId('preview-server-a-5173').waitFor()
    await a.getByTestId('preview-server-b-3000').waitFor()
    await a.getByTestId('preview-server-c-5173').waitFor()
    await waitForPainted(a, 'All machines')
    await waitForPainted(a, 'Travel laptop')
    const projectY = (await a.getByTestId('preview-server-c-5173').bounds()).y
    const otherY = (await a.getByTestId('preview-server-a-5173').bounds()).y
    assert.ok(projectY < otherY, 'Windows checkout of current logical project precedes unrelated local server')
    if (out) { mkdirSync(out, { recursive: true }); await a.screenshot({ path: path.join(out, `preview-network-${appearance}.png`) }) }
    await a.getByTestId('preview-servers-machine').click()
    await a.getByTestId('preview-servers-c').click()
    assert.equal(await a.getByTestId('preview-server-a-5173').count(), 0)
    assert.equal(await a.getByTestId('preview-server-c-5173').count(), 1)
    await a.getByTestId('preview-servers-machine').click()
    await a.getByTestId('preview-servers-all').click()
    await a.getByTestId('preview-server-a-5173').waitFor()
    await a.getByTestId('preview-server-c-5173').click()
    const deadline = Date.now() + 5000
    while (!calls().some(c => c.method === 'previews.server.open') && Date.now() < deadline) await Bun.sleep(30)
    const forwards = calls().filter(c => c.method === 'ports.forward')
    assert.equal(forwards.at(-1)?.params.machine, 'c')
    assert.equal(forwards.at(-1)?.params.remote_port, 5173)
    assert.equal(calls().find(c => c.method === 'previews.server.open')?.machine, 'a', 'primary daemon opens third-machine source without the thread')
    assert.ok(!calls().some(c => c.method === 'previews.servers.list' && c.machine === 'd'), 'offline machines are not polled')
    assert.ok(!/panic|\[error-boundary\]|TypeError/.test(fixture.diagnostics()), fixture.diagnostics())
    console.log(`PASS ${appearance}: all machines, machine badges, project ordering, same-port identities, filter, offline recent and click-to-forward`)
  } finally { await fixture.close(); rmSync(scratch, { recursive: true, force: true }) }
}
process.exit(0)
