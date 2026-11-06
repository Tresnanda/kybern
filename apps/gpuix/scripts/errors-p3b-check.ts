// On-screen check of #232 families 4-5 on the real components (`scripts/errors-p3b-entry.tsx`): each failure paints its plain headline and one
// sentence, the technical text stays behind Show details, and the fix buttons are there. Light and dark screenshots go to
// KYBERN_VERIFY_OUTPUT, else native/build/errors-p3b.
//   bun scripts/errors-p3b-check.ts
import assert from 'node:assert/strict'
import path from 'node:path'
import { capture, launch, outputDir, settled, step } from '../native/check-harness.ts'

const out = outputDir('errors-p3b')
const RAW = /RpcCallError|EPERM|os error|exit status|invalid params|not found: note|error sending request|Permission denied \(publickey\)|C:\\/

async function run(appearance: 'light' | 'dark') {
  const f = await launch(path.join(import.meta.dir, 'errors-p3b-entry.tsx'), { KYBERN_APPEARANCE: appearance, KYBERN_OPAQUE: '1', KYBERN_REDUCED_MOTION: '1' })
  const a = f.app
  const painted = async () => (await a.call('getPaintedText', {})).text.join('\n')
  const count = (id: string) => a.getByTestId(id).count()
  const click = async (id: string) => { await a.getByTestId(id).waitFor({ timeoutMs: 5000 }); await a.getByTestId(id).click() }
  try {
    await a.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
    const text = await settled(painted, (t) => t.includes('SatyaMas is offline') && t.includes('kybern command'), 6000)
    if (process.env.DEBUG_TEXT) console.log(text)

    await step(`${appearance}: every failure has a plain headline`, async () => {
      for (const title of [
        'SatyaMas is offline', // a terminal on another machine
        'Kybern isn\'t allowed to save main.ts', // the file editor (a refused write)
        'Couldn\'t load the artifacts', // a dock panel
        'Code is using this worktree', // a Windows file lock names the program
        'That machine didn’t accept your SSH key',
        'Can’t reach that machine',
        'Couldn\'t install the kybern command', // EPERM linking to PATH (a toast)
      ]) assert.ok(text.includes(title), `"${title}" is painted`)
      assert.ok(/Couldn.t open this note/.test(text), 'the note failure is worded')
      assert.ok(/Couldn.t add the task/.test(text), 'the task failure is worded')
      assert.ok(text.includes('Your work is safe'), 'the worktree failure says the work is safe')
      assert.ok(text.includes('ssh-copy-id kybern@192.168.1.20'), 'the SSH fix shows the command to run')
    })

    await step(`${appearance}: no raw error is painted`, async () => {
      const raw = RAW.exec(text)
      assert.equal(raw, null, `raw text painted: ${raw?.[0]}`)
    })

    await step(`${appearance}: the fixes are buttons and run`, async () => {
      for (const id of ['file-problem-primary', 'artifacts-problem-primary', 'worktree-problem-retry', 'about-problem-primary']) assert.equal(await count(id), 1, `${id} is on screen`)
      assert.equal(await count('task-problem-primary'), 0, 'no retry where the surface has none')
      await click('file-problem-primary')
      assert.equal(await settled(async () => a.getByTestId('pressed').textContent(), (v) => v === 'save-retry'), 'save-retry')
    })

    await step(`${appearance}: the technical text is behind Show details`, async () => {
      await click('file-problem-details')
      const opened = await settled(painted, (t) => t.includes('EPERM'))
      assert.ok(opened.includes('EPERM'), 'the file error opens its details')
      assert.equal(await count('file-problem-copy'), 1, 'with a copy button')
    })
    await Bun.sleep(300)
    await capture(f, path.join(out, `errors-p3b-${appearance}.png`))
  } catch (error) { console.error(f.diagnostics()); throw error } finally { await f.close() }
}

await run('light')
await run('dark')
console.log('ok  errors-p3b-check')
process.exit(0)
