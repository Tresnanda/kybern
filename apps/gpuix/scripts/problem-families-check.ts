// On-screen check of the phase 3 error copy (#232, families 1 to 3) on the kit gallery's `problem-families` section, which builds each card
// from a real failure through the code the app runs. Asserts the headlines, the fixes and that no raw text shows, then captures the
// section in light and dark.
//   bun scripts/problem-families-check.ts            (PNGs go to KYBERN_VERIFY_OUTPUT, else native/build/problem-families)
import assert from 'node:assert/strict'
import path from 'node:path'
import { capture, launch, outputDir, settled, step } from '../native/check-harness.ts'

const out = outputDir('problem-families')
const LOOKS = { light: { KYBERN_APPEARANCE: 'light' }, dark: { KYBERN_APPEARANCE: 'dark' } } as const

for (const [look, env] of Object.entries(LOOKS)) {
  const f = await launch(path.join(import.meta.dir, 'kit9-gallery-entry.tsx'), { KIT_SECTION: 'problem-families', KYBERN_OPAQUE: '1', KYBERN_REDUCED_MOTION: '1', ...env })
  const a = f.app
  const painted = async () => (await a.call('getPaintedText', {})).text.join('\n')
  try {
    await a.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
    await step(`${look}: the headlines say the outcome or the fix`, async () => {
      const text = await settled(painted, (t) => t.includes('Install Git to see this branch'), 5000)
      for (const title of [
        'Install Git to see this branch', // Review without Git (family 2)
        'SatyaMas is offline', // a machine that is away (family 3)
        'Install Tailscale to turn on the network', // Tailscale missing (family 3)
        'Install Claude Code to finish this reply', // a harness that is not installed (family 1)
        'Install Node.js to set up Cursor', // npm ci / Cursor's SDK (family 1)
        'Some pull requests didn’t load', // a partial list (family 2)
      ]) assert.ok(text.includes(title), `${title} is painted`)
      assert.ok(text.includes('Couldn’t read kybern / app, docs. The rest are listed below.'), 'the partial list names what is missing')
      assert.ok(text.includes('Couldn’t connect to SatyaMas. Check that Kybern is running there, then reconnect.'), 'the banner says what to do')
      assert.ok(text.includes('SatyaMas is offline. Kybern keeps trying') && text.includes('Your message is saved.'), 'a send to an away machine names it and keeps the draft')
    })
    await step(`${look}: the fixes are buttons and no raw text shows`, async () => {
      for (const id of ['fam-state-0-primary', 'fam-state-1-primary', 'fam-state-2-primary', 'fam-row-0-primary', 'fam-row-1-primary', 'fam-row-2-primary']) assert.equal(await a.getByTestId(id).count(), 1, `${id} is on screen`)
      const text = await painted()
      assert.ok(!/RpcCallError|invalid params|program not found|ECONNREFUSED|-32602|Cannot read properties/.test(text), 'no raw error')
      assert.ok(!/on this Mac/.test(text), 'nothing says Mac here')
    })
    await capture(f, path.join(out, `families-${look}.png`))
    console.log('ok', look)
  } finally { await f.close() }
}
process.exit(0)
