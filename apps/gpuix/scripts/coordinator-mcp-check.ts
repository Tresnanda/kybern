import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { launchFixture, waitForPainted } from '../src/requests/harness.ts'
const out = path.resolve(process.env.SHOT_OUT ?? '.shots/coordinator-mcp')
mkdirSync(out, { recursive: true })
for (const theme of ['dark', 'light']) {
  const scratch = path.resolve(tmpdir(), 'coordinator-mcp-' + theme)
  mkdirSync(scratch, { recursive: true })
  const fixture = await launchFixture(path.join(import.meta.dir, '../src/settings/coordinator-mcp.fixture.tsx'), {
    GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: theme, KYBERN_OPAQUE: '1', KYBERN_REDUCED_MOTION: '1',
    KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_URL: '', KYBERN_TOKEN: '',
  })
  try {
    const app = fixture.app
    await app.getByTestId('coordinator-mcp-ready').waitFor()
    await waitForPainted(app, 'codebase-memory')
    await app.screenshot({ path: path.join(out, 'coordinator-mcp-' + theme + '-off.png') })
    await app.getByTestId('settings-coordinator-mcp-omp-codebase-memory').click()
    await app.clock.fastForward(500)
    await app.screenshot({ path: path.join(out, 'coordinator-mcp-' + theme + '.png') })
    const text = (await app.call('getPaintedText', {})).text.join('\n')
    assert.ok(text.includes('github') && text.includes('Tools the Coordinator may use'))
    console.log('PASS', theme)
  } finally { await fixture.close() }
}
