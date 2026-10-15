import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { launchFixture } from '../requests/harness.ts'
for (const reduced of ['0', '1']) {
  const scratch = mkdtempSync(tmpdir() + '/gpuix-collapse-')
  const f = await launchFixture(import.meta.dir + '/collapse.fixture.tsx', { GPUIX_BACKGROUND: '1', KYBERN_REDUCED_MOTION: reduced, KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_GPUIX_CREDENTIALS_DIR: scratch })
  try {
    await f.app.getByTestId('collapse-ready').waitFor()
    const check = async (height: number) => {
      await Bun.sleep(100)
      await f.app.clock.fastForward(600)
      await Bun.sleep(32)
      await f.app.clock.fastForward(32)
      const body = await f.app.getByTestId('collapse-body').bounds(), after = await f.app.getByTestId('collapse-after').bounds()
      assert.equal(body.height, height)
      assert.ok(after.y >= body.y + body.height - 1, `Following row overlaps disclosure: ${JSON.stringify({body, after})}`)
    }
    await check(60)
    await f.app.getByTestId('collapse-grow').click()
    await check(150)
    await f.app.getByTestId('collapse-toggle').click()
    await f.app.clock.fastForward(600)
    assert.equal(await f.app.getByTestId('collapse-body').count(), 0)
    await f.app.getByTestId('collapse-toggle').click()
    await check(150)
    await f.app.getByTestId('collapse-grow').click()
    await check(240)
    console.log(`PASS reduced=${reduced}: initially open, grow, close/unmount, reopen, grow again; following row never overlaps`)
  } finally { await f.close(); rmSync(scratch, { recursive: true, force: true }) }
}
