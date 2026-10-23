// The question card's states, as the spec sheet lists them: `QCARD_THEMES=dark,light,glass bun src/requests/qcard.shots.ts [mode…]`.
// Writes `<out>/<mode>-<theme>.png` (QCARD_OUT; default `.kybern-artifacts/ade-69-71/qcard-build`). Asserts the copy and the keys
// it drives on the way. Run with `NAPI_RS_NATIVE_LIBRARY_PATH` set to a patched addon.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchFixture } from './harness.ts'

const out = process.env.QCARD_OUT ?? '/Users/mymac/projects/ade/.kybern-artifacts/ade-69-71/qcard-build'
const themes = (process.env.QCARD_THEMES ?? 'dark,light,glass').split(',')
const modes = process.argv.slice(2).length ? process.argv.slice(2) : ['arrival', 'a-preview', 'a-markdown', 'a-free', 'b-narrow', 'b-clamp', 'b-markdown', 'free-text', 'free-only', 'attach', 'multi', 'middle', 'deadline']
mkdirSync(out, { recursive: true })
for (const theme of themes) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'gpuix-qcard-'))
  const glass = theme.startsWith('glass')
  const fixture = await launchFixture(path.join(import.meta.dir, 'qcard.fixture.tsx'), {
    GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: theme.endsWith('light') ? 'light' : 'dark', KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_GPUIX_CREDENTIALS_DIR: scratch,
    KYBERN_URL: '', KYBERN_TOKEN: '', KYBERN_GPUIX_ENVIRONMENT: 'local', KYBERN_REDUCED_MOTION: '1',
    ...(glass ? { FIXTURE_WALLPAPER: path.resolve(import.meta.dir, '../../../desktop/public/release-background.png'), KYBERN_WINDOW_MATERIAL: 'window', KYBERN_WINDOW_OPACITY: '83', KYBERN_WINDOW_CONTENT_OPACITY: '83' } : { KYBERN_OPAQUE: '1' }),
  })
  const app = fixture.app
  const settle = (ms = 300) => app.clock.fastForward(ms)
  const painted = async () => (await app.call('getPaintedText', {})).text.join('\n')
  const card = () => app.getByTestId('question-panel')
  const shot = async (name: string) => { await settle(); await app.screenshot({ path: `${out}/${name}-${theme}.png` }); console.log('shot', name, theme) }
  try {
    // The first mode switch after launch races the window's own activation; warm up on another mode.
    await app.getByTestId('fixture-middle').click(); await settle(500)
    for (const mode of modes) {
      const fixtureMode = mode === 'a-free' ? 'free-text' : mode === 'free-text' ? 'b-narrow' : mode
      await app.getByTestId(`fixture-${fixtureMode}`).click()
      await card().waitFor({ timeoutMs: 10000 })
      await settle(500)
      // The click on the mode button hides the ring (a pointer click); a key on the card brings it back. ↑ on the first row moves nothing.
      if (mode !== 'deadline') await card().press('up')
      if (mode === 'arrival') {
        const text = await painted()
        assert.ok(text.includes('Which branch should the pull request target?') && text.includes('Something else…') && text.includes('Send'), 'the question is the title, the free row and Send show')
        assert.ok(!text.includes('Question 1 of 1') && !text.includes('Write your own answer'), 'no "1 of 1", no old free-answer copy')
        assert.ok(text.includes('to choose') && /\b3\b/.test(text), 'the hint counts every row (1–3)')
      }
      if (mode === 'a-preview' || mode === 'a-markdown') { await card().press('down'); assert.ok((await app.getByTestId('question-split').count()) === 1, 'a 700 pt card shows the preview beside the rows') }
      if (mode === 'b-narrow') assert.ok((await app.getByTestId('question-split').count()) === 0, 'a 440 pt card opens the preview under the row')
      if (mode === 'a-free' || mode === 'free-text') {
        await card().press('3')
        await settle()
        await app.getByTestId('question-answer').fill(mode === 'a-free' ? 'Grid, but collapse the sidebar under 900 pt' : 'Grid, but collapse the sidebar under 900 pt')
        if (mode === 'a-free') assert.ok((await painted()).includes('Your own answer has no preview'))
      }
      if (mode === 'b-clamp') {
        assert.ok((await painted()).includes('Show all 10 lines'), 'a long preview clamps at six lines')
        await shot(mode)
        await card().press('cmd-e')
        await settle()
        assert.ok((await painted()).includes('Show less'), '⌘E expands the preview')
        await shot('b-clamp-expanded')
        continue
      }
      if (mode === 'attach') {
        await app.getByTestId('question-attach').click(); await settle()
        await app.getByTestId('question-attach-file').click(); await settle()
        assert.equal(await app.getByTestId('question-attachment').count(), 1, 'File… adds a chip')
        await app.getByTestId('question-attach').click(); await settle()
      }
      if (mode === 'multi') {
        await card().press('1'); await card().press('2'); await card().press('down'); await settle()
        // The tooltip's delay runs on real time: move the pointer onto Attach and wait for it.
        const at = await app.getByTestId('question-attach').center()
        await app.mouse.move({ x: at.x - 6, y: at.y }); await app.mouse.move(at)
        await app.getByTestId('tooltip').waitFor({ timeoutMs: 6000 }).catch(() => console.log('no tooltip opened'))
      }
      if (mode === 'middle') {
        await card().press('enter'); await settle(); await card().press('down'); await settle()
        const text = await painted()
        assert.ok(text.includes('Density') && text.includes('2 of 3') && text.includes('Back') && text.includes('Next'), 'the middle step: header word, 2 of 3, Back, Next')
      }
      if (mode === 'deadline') assert.ok((await painted()).includes('Wait for me'), 'Wait for me sits on the hint line')
      await shot(mode)
    }
    // Keys: ↵ sends the arrival row; ↑ stops at the first row; the free row's field keeps its draft on esc.
    await app.getByTestId('fixture-arrival').click(); await card().waitFor({ timeoutMs: 10000 }); await settle(500)
    await card().press('up'); await card().press('down'); await card().press('down'); await card().press('enter'); await settle()
    assert.equal(await app.getByTestId('question-answer').count(), 1, '↵ on an empty Something else… opens the field')
    await app.getByTestId('question-answer').fill('staging'); await app.getByTestId('question-answer').press('escape'); await settle()
    assert.ok((await painted()).includes('staging'), 'esc keeps the draft as the row label')
    await card().press('enter'); await settle()
    await app.getByTestId('responded').waitFor({ timeoutMs: 5000 })
    const sent = (await app.getByTestId('responded').element()) as unknown as { ariaLabel?: string; label?: string }
    console.log('ok: keys; sent', JSON.stringify(sent).slice(0, 200))
  } finally { await fixture.close(); rmSync(scratch, { recursive: true, force: true }) }
}
