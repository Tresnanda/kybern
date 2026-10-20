import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { launchFixture } from '../requests/harness.ts'
const scratch = mkdtempSync(tmpdir() + '/gpuix-scratch-narrow-')
const f = await launchFixture(import.meta.dir + '/native.fixture.tsx', { GPUIX_BACKGROUND: '1', KYBERN_REDUCED_MOTION: '1', PANE_WIDTH: '900', KYBERN_APPEARANCE: 'light', KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_GPUIX_CREDENTIALS_DIR: scratch, KYBERN_GPUIX_ENVIRONMENT: 'local', KYBERN_URL: '', KYBERN_TOKEN: '' })
try {
  const a = f.app
  await a.getByTestId('composer').waitFor()
  await a.getByTestId('fixture-child').click()
  await a.clock.fastForward(16)
  assert.equal(await a.getByTestId('page-outgoing').count(), 0)
  await a.getByTestId('fixture-parent').click()
  await a.clock.fastForward(350)
  await a.getByTestId('app-ready').press('cmd-\\')
  await a.clock.fastForward(350)
  const panes = JSON.parse(await a.getByTestId('fixture-panes').textContent()) as { id: string }[]
  assert.equal(panes.length, 2)
  const first = await a.getByTestId(`pane-${panes[0]!.id}`).bounds()
  const second = await a.getByTestId(`pane-${panes[1]!.id}`).bounds()
  assert.ok(Math.abs(first.x - second.x) < 2 && second.y > first.y + 100, 'narrow horizontal split stacks vertically')
  await a.screenshot({ path: '/Users/mymac/projects/ade/previews/gpuix/p7/narrow-reduced.png' })
  console.log('PASS reduced-motion navigation, split shortcut, narrow vertical fallback')
} finally { console.log(f.diagnostics()); await f.close(); rmSync(scratch, { recursive: true, force: true }) }
