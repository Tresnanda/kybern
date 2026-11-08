// The All tasks first-load failure (#299), dark and light: the busy words, the unreachable-machine words, and the
// "Try again" button busy after a click. Writes `tasks-load-failure-{busy,offline,trying}-{dark,light}.png` to
// KYBERN_VERIFY_OUTPUT. The words themselves are asserted in `src/tasks/loadFailure.test.ts`.
import '../src/native/local-build.ts'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { launchFixture } from '../src/requests/harness.ts'

const out = process.env.KYBERN_VERIFY_OUTPUT ?? path.join(import.meta.dir, 'build')
mkdirSync(out, { recursive: true })

for (const mode of ['dark', 'light'] as const) {
  for (const cause of ['busy', 'offline'] as const) {
    const scratch = mkdtempSync(path.join(tmpdir(), 'gpuix-tasks-failure-'))
    const f = await launchFixture(path.join(import.meta.dir, 'tasks-load-failure-lab.tsx'), { KYBERN_APPEARANCE: mode, KYBERN_LAB_ERROR: cause, GPUIX_BACKGROUND: '1', KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_URL: '', KYBERN_TOKEN: '' })
    try {
      const a = f.app
      await a.getByTestId('tasks-load-failure').waitFor()
      await Bun.sleep(600)
      await a.screenshot({ path: path.join(out, `tasks-load-failure-${cause}-${mode}.png`) })
      if (cause === 'busy') {
        await a.getByTestId('tasks-load-retry').click()
        await Bun.sleep(500)
        await a.screenshot({ path: path.join(out, `tasks-load-failure-trying-${mode}.png`) })
        assert.ok((await a.getByTestId('tasks-load-failure').bounds()).height > 0, 'the card stays while it tries again')
      }
      console.log(`captured ${cause} ${mode}`)
    } catch (e) { console.error(f.diagnostics()); throw e }
    finally { await f.close() }
  }
}
