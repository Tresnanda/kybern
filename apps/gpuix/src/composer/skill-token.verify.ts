// A skill picked from the `$` menu renders as its chip on the very first frame, before any further typing: the native text
// already holds the chip's label (icon room + name) and the accent decoration covers it. Before the fix the pick wrote the
// raw `$review-ui` with the references of the previous render, and the chip only appeared after the next keystroke.
//   bun src/composer/skill-token.verify.ts
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { launchFixture } from '../requests/harness.ts'
const out = process.env.KYBERN_VERIFY_OUTPUT ?? '/Users/mymac/projects/ade/previews/composer-tray/skill-token'
mkdirSync(out, { recursive: true })
const until = async (check: () => Promise<boolean>, label: string) => { for (let i = 0; i < 100; i++) { try { if (await check()) return } catch {} await Bun.sleep(40) } throw Error(`Timed out: ${label}`) }
for (const variant of ['dark', 'light'] as const) {
  const scratch = mkdtempSync(tmpdir() + '/gpuix-skill-')
  const f = await launchFixture(import.meta.dir + '/conversation.fixture.tsx', { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: variant, KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_GPUIX_CREDENTIALS_DIR: scratch, KYBERN_GPUIX_ENVIRONMENT: 'local', KYBERN_URL: '', KYBERN_TOKEN: '' })
  try {
    const app = f.app, composer = app.getByTestId('composer')
    await app.getByTestId('conversation-ready').waitFor()
    await until(async () => (await app.getByTestId('connected').textContent()) === 'open', 'connected')
    const painted = async () => String((await app.call('getPaintedText', {})).text)
    const menu = async () => (await app.getByTestId('completion').count()) > 0
    await composer.fill('$review')
    await until(menu, 'skill menu')
    await until(async () => (await painted()).includes('Review an interface change'), 'skill row')
    await composer.press('enter')
    await until(async () => !(await menu()), 'menu closed')
    await Bun.sleep(250)
    const first = await painted()
    await app.screenshot({ path: `${out}/picked-${variant}.png` })
    console.log(`painted after pick: ${JSON.stringify(first.slice(first.indexOf('review-ui') - 12, first.indexOf('review-ui') + 14))}`)
    assert.ok(!first.includes('$review-ui'), 'the raw $review-ui token never paints')
    assert.ok(first.includes('  review-ui'), 'the chip label (icon room + name) paints at once')
    // The text alone was right before the fix too; what was missing is the chip's accent (`--color-accent-blue`, #0169cc).
    const box = await composer.bounds()
    const accent = Number(execFileSync('swift', [import.meta.dir + '/../../scripts/accent-pixels.swift', `${out}/picked-${variant}.png`, String(Math.round(box.x * 2)), String(Math.round(box.y * 2)), '400', String(Math.round(Math.min(box.height, 24) * 2)), '1', '105', '204'], { encoding: 'utf8' }).trim())
    console.log(`accent pixels after pick: ${accent}`)
    assert.ok(accent > 40, 'the chip is decorated on the first frame, before any further typing')
    await composer.press('x')
    await Bun.sleep(250)
    await app.screenshot({ path: `${out}/typed-${variant}.png` })
    console.log(`ok ${variant}`)
  } finally { await f.close() }
}
process.exit(0)
