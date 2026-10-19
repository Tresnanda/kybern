/**
 * Hands-on round 5 items 3 and 4 in the real app: the right dock with every panel closed, and the composer's `@` menu.
 *   bun scripts/hr5-polish-states.ts [dock|mention ...]
 */
import assert from 'node:assert/strict'
import { launch, onTestDisplay, OUT, threadId, waitUntil } from './hr5-polish-lib.ts'
const which = process.argv.slice(2).filter((a) => !a.startsWith('-'))
const run = (name: string) => which.length === 0 ? name !== 'dock-narrow' : which.includes(name)
for (const theme of ['dark', 'light'] as const) {
  if (run('dock')) {
    const app = await launch({ theme, thread: 'Narrow composer' })
    try {
      await Bun.sleep(1800)
      await app.call('keystrokes' as never, { keys: 'cmd-j' } as never)
      await waitUntil(async () => (await app.getByTestId('dock-tabs').count()) > 0, 10_000, 'dock tabs')
      for (let i = 0; i < 12; i++) {
        const closes = app.getByTestId(/^dock-tab-close-/ as never)
        const count = await app.getByTestId('dock-tabs').count()
        void closes; void count
        let closed = false
        for (const id of ['agents', 'preview', 'terminal', 'review', 'artifacts', 'project', 'notes', 'tasks', 'activity', 'changes', 'explorer', 'files']) {
          const c = app.getByTestId(`dock-tab-close-${id}`)
          if ((await c.count()) > 0) { await app.getByTestId(`dock-tab-${id}`).hover(); await Bun.sleep(100); await c.click(); await Bun.sleep(250); closed = true }
        }
        if (!closed) break
      }
      await Bun.sleep(800); await app.clock.fastForward(16)
      assert.ok(onTestDisplay(app.pid), 'test display')
      await app.screenshot({ path: `${OUT}/dock-empty-gpuix-${theme}.png` })
      const painted = String((await app.call('getPaintedText', {})).text).includes('No panels open')
      // Quick action: choosing a panel here opens it exactly as the + menu does.
      await app.getByTestId('dock-empty-terminal').click()
      await waitUntil(async () => (await app.getByTestId('dock-tab-terminal').count()) > 0 && (await app.getByTestId('dock-empty').count()) === 0, 8000, 'quick action opens the panel')
      console.log('dock', theme, 'painted', painted)
    } finally { await app.closeAll() }
  }
  if (run('dock-narrow')) {
    // The narrowest dock the app allows (416), open with no panels (saved dock choice for the thread).
    const app = await launch({ theme, thread: 'Narrow composer', ui: { 'kybern.dock.choices': [[await threadId('Narrow composer'), { open: true, tabs: [], tab: null, width: 416, instant: false }]] } })
    try {
      await waitUntil(async () => (await app.getByTestId('dock-empty').count()) > 0, 15_000, 'empty dock')
      await Bun.sleep(1000); await app.clock.fastForward(16)
      assert.ok(onTestDisplay(app.pid), 'test display')
      console.log('dock bounds', JSON.stringify(await app.getByTestId('dock-empty').bounds()))
      await app.screenshot({ path: `${OUT}/dock-empty-narrow-gpuix-${theme}.png` })
    } finally { await app.closeAll() }
  }
  if (run('mention')) {
    const app = await launch({ theme, thread: 'Narrow composer' })
    try {
      await Bun.sleep(1800)
      await app.getByTestId('composer').fill(`@${process.env.MENTION_QUERY ?? ''}`)
      await waitUntil(async () => (await app.getByTestId('completion').count()) > 0, 10_000, 'menu')
      if (process.env.MENTION_CHIP) { await app.getByTestId(`completion-category-${process.env.MENTION_CHIP}`).click(); await Bun.sleep(900) }
      await Bun.sleep(900); await app.clock.fastForward(16)
      assert.ok(onTestDisplay(app.pid), 'test display')
      await app.screenshot({ path: `${OUT}/mention${process.env.MENTION_QUERY ? '-' + process.env.MENTION_QUERY : ''}${process.env.DESK_CHIP ?? process.env.MENTION_CHIP ?? ''}-gpuix-${theme}.png` })
      console.log('mention', theme, 'ok')
    } finally { await app.closeAll() }
  }
}
if (run('sidebar')) for (const theme of ['dark', 'light'] as const) for (const sidebar of [208, 256]) {
  const app = await launch({ theme, sidebar })
  try {
    await Bun.sleep(2500); await app.clock.fastForward(16)
    assert.ok(onTestDisplay(app.pid), 'test display')
    await app.screenshot({ path: `${OUT}/sidebar-empty-gpuix-${theme}-${sidebar}.png` })
    console.log('sidebar', theme, sidebar, String((await app.call('getPaintedText', {})).text).includes('No projects yet'))
  } finally { await app.closeAll() }
}
process.exit(0)
