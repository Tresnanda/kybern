// On-screen check of failed turns (#234): a signed-out agent paints "Claude Code is signed out" with Sign in and Use another account, a
// lost connection paints its headline with Try again, the harness's technical text stays behind Show details, and a failure Kybern cannot
// name still reads as words. Light and dark screenshots go to KYBERN_VERIFY_OUTPUT, else native/build/errors-p5.
//   bun scripts/errors-p5-check.ts
import assert from 'node:assert/strict'
import path from 'node:path'
import { capture, launch, outputDir, settled, step } from '../native/check-harness.ts'

const out = process.env.KYBERN_VERIFY_OUTPUT ?? outputDir('errors-p5')

async function run(appearance: 'light' | 'dark') {
  const f = await launch(path.join(import.meta.dir, 'errors-p5-entry.tsx'), { KYBERN_APPEARANCE: appearance, KYBERN_OPAQUE: '1', KYBERN_REDUCED_MOTION: '1' })
  const a = f.app
  const painted = async () => (await a.call('getPaintedText', {})).text.join('\n')
  const count = (id: string) => a.getByTestId(id).count()
  try {
    await a.getByTestId('errors-ready').waitFor({ timeoutMs: 60_000 })
    const text = await settled(painted, (t) => t.includes('Claude Code is signed out'), 8000)
    if (process.env.DEBUG_TEXT) console.log(text)

    await step(`${appearance}: a signed-out agent says so and offers the fix`, async () => {
      assert.ok(text.includes('Claude Code is signed out'), 'the headline is painted')
      assert.ok(text.includes('Sign in, then send your message again.'), 'the body says what to do next and promises nothing')
      assert.ok(text.includes('Sign in') && text.includes('Use another account'), 'both buttons are painted')
      assert.ok(await count('turn-problem-primary') >= 1, 'the primary button is on screen')
      assert.ok(await count('turn-problem-secondary') >= 1, 'the secondary button is on screen')
    })

    await step(`${appearance}: a lost connection names the agent`, async () => {
      assert.ok(text.includes("Couldn't reach Claude Code"), 'the connection headline is painted')
      assert.ok(text.includes('Try again'), 'Try again is painted')
    })

    await step(`${appearance}: the harness text stays behind Show details`, async () => {
      assert.ok(!text.includes('Please run /login') && !text.includes('ECONNREFUSED'), 'no raw harness text painted')
      assert.ok(text.includes('Show details'), 'the disclosure is painted')
    })

    await step(`${appearance}: a failure Kybern cannot name is still a row, not a red line`, async () => {
      assert.ok(text.includes("Couldn't finish this reply"), 'the unnamed failure gets a plain headline')
    })
    await Bun.sleep(300)
    await capture(f, path.join(out, `errors-p5-${appearance}.png`))
  } catch (error) { console.error(f.diagnostics()); throw error } finally { await f.close() }
}

await run('light')
await run('dark')
process.exit(0)
