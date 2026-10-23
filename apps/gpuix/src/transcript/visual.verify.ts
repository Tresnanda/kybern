// Inline visual reply (`views/VisualReply.tsx`): the figure sits on the thread with no frame;
// hovering it reveals a glass control 8px inside the top-right corner (tooltip "Open in a tab");
// the control opens the document as a visual tab (ADE-54), and ⌘1 returns to the chat. The embedded document is captured with `screencapture -l` (the GPUI
// screenshot API omits child NSViews). The pointer is synthetic (GPUI-level): a real pointer reaches the
// document's wrapper, which reports the same hover (`kybern-visual-hover`).
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { captureWindow, EVIDENCE, launchLive, until } from './live.ts'
const out = process.env.KYBERN_VERIFY_OUTPUT ?? `${EVIDENCE}/visual`
mkdirSync(out, { recursive: true })
for (const theme of ['dark', 'light'] as const) for (const reduced of [false, true]) {
  const tag = `${theme}${reduced ? '-reduced' : ''}`
  const f = await launchLive({ theme, reduced, thread: 'Visual reply' })
  try {
    const app = f.app
    await until(async () => (await app.getByTestId('visual-frame').count()) > 0, 'frame slot', 15000)
    await Bun.sleep(3000)
    await app.mouse.move({ x: 20, y: 800 }); await Bun.sleep(300)
    assert.equal(await app.getByTestId('visual-error').count(), 0, 'no error card')
    assert.equal(await app.getByTestId('visual-skeleton').count(), 0, 'skeleton gone once loaded')
    assert.equal(await app.getByTestId('visual-expand').count(), 0, 'control hidden at rest')
    captureWindow(f.pid, `${out}/rest-${tag}.png`)
    const slot = await app.getByTestId('visual-frame').bounds()
    await app.getByTestId('visual-frame').hover(); await Bun.sleep(500)
    await until(async () => (await app.getByTestId('visual-expand').count()) > 0, 'control on hover')
    const control = await app.getByTestId('visual-expand').bounds()
    console.log('control', JSON.stringify(control), 'slot', JSON.stringify(slot))
    assert.ok(Math.abs((slot.x + slot.width - 8) - (control.x + control.width)) < 1.5 && Math.abs((slot.y + 8) - control.y) < 1.5, `8px inside the top-right corner: slot ${JSON.stringify(slot)} control ${JSON.stringify(control)}`)
    captureWindow(f.pid, `${out}/hover-${tag}.png`)
    await app.getByTestId('visual-expand').click(); await Bun.sleep(700)
    await until(async () => (await app.getByTestId('visual-tab').count()) > 0, 'visual tab')
    captureWindow(f.pid, `${out}/tab-${tag}.png`)
    await app.getByTestId('app-ready').press('cmd-1'); await Bun.sleep(500)
    await until(async () => (await app.getByTestId('visual-tab').count()) === 0, 'back to the chat')
    console.log(`PASS ${tag}: rest without chrome, hover control ${control.width}x${control.height} at 8px, open in a tab and back`)
  } catch (error) { console.log(f.diagnostics()); throw error } finally { await f.close() }
}
process.exit(0)
