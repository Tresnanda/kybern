/** Two live transcripts and a frozen transition must observe their own nodes. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { launchFixture } from '../requests/harness.ts'
for (const reduced of ['0', '1']) for (const theme of ['dark', 'light']) {
  const scratch = mkdtempSync(tmpdir() + '/gpuix-scratch-transcript-split-')
  const f = await launchFixture(import.meta.dir + '/../split/native.fixture.tsx', {
    GPUIX_BACKGROUND: '1', KYBERN_REDUCED_MOTION: reduced, KYBERN_APPEARANCE: theme,
    KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_GPUIX_CREDENTIALS_DIR: scratch,
    // The fixture mocks KybernClient and writes a sentinel port; bypass the real
    // local-daemon discovery/probe so its client exists before App effects run.
    KYBERN_GPUIX_ENVIRONMENT: 'local', KYBERN_URL: 'ws://127.0.0.1:1/ws', KYBERN_TOKEN: 'fixture',
  })
  const app = f.app
  const click = async (id: string) => { await app.getByTestId(id).click(); await app.clock.fastForward(400); await Bun.sleep(100) }
  const healthy = async () => {
    assert.equal(await app.getByTestId('error-fallback').count(), 0)
    const text = (await app.call('getPaintedText', {})).text.join('\n')
    assert.ok(!text.includes('Something went wrong'), text)
    assert.ok(!f.diagnostics().includes('[error-boundary]'), f.diagnostics())
    assert.ok(!f.diagnostics().includes('testId must resolve uniquely'), f.diagnostics())
  }
  try {
    await app.getByTestId('split-fixture').waitFor()
    await app.getByTestId('transcript-surface').waitFor()
    await app.clock.pause()
    // Mount outgoing and incoming views of the same pane simultaneously.
    await app.getByTestId('fixture-child').click()
    await app.clock.fastForward(80)
    await healthy()
    if (reduced === '0') assert.equal(await app.getByTestId('page-outgoing').count(), 1)
    else assert.equal(await app.getByTestId('page-outgoing').count(), 0)
    await app.clock.fastForward(600)
    await click('fixture-keyboard')
    await click('thread-actions')
    await click('header-split-right')
    await click('fixture-other')
    assert.equal(await app.getByTestId('transcript-surface').count(), 2)
    await healthy()
    await click('fixture-child')
    assert.equal(await app.getByTestId('transcript-surface').count(), 2)
    await healthy()
    console.log(`PASS ${theme}, reduced=${reduced}: two formatted transcripts and same-pane transition, no error boundary`)
  } catch(error) { const out=process.env.KYBERN_VERIFY_OUTPUT ?? '/Users/mymac/projects/ade/previews/gpuix/perf/transcript/convo9';mkdirSync(out,{recursive:true});console.error(f.diagnostics());await app.screenshot({path:`${out}/split-failed-${theme}-${reduced}.png`}).catch(()=>{});throw error } finally { await f.close(); rmSync(scratch, {recursive:true,force:true}) }
}
