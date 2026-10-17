// Model picker keyboard (`components/kybern/ModelPicker.tsx` onKeyDown + roving tabs): ↑/↓ move the
// active row and Enter picks it, ⌘1–9 pick, ←/→ move between tabs, Escape closes. Runs the real app
// against the scratch daemon; the pick changes the scratch thread's model.
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { EVIDENCE, launchLive, until } from '../transcript/live.ts'
import { connect, readState } from '../../visual/fixture.ts'
const out = process.env.KYBERN_VERIFY_OUTPUT ?? `${EVIDENCE}/picker`
mkdirSync(out, { recursive: true })
for (const [theme, reduced] of [['dark', false], ['light', false], ['dark', true], ['light', true]] as const) {
  const label = `${theme}${reduced ? '-reduced' : ''}`
  const title = `Picker keys ${label} ${Date.now()}`
  const seed = await connect(readState()!)
  const { projects } = await seed.call('projects.list', {})
  await seed.call('threads.create', { project_id: projects[0]!.id, provider: { kind: 'claude-code', instance: 'default' }, title } as never)
  seed.close?.()
  const f = await launchLive({ theme, reduced, thread: title })
  try {
    const app = f.app
    // Idle windows paint nothing new; a short clock step flushes the pending frame before the read.
    const text = async () => { await app.clock.fastForward(16); await app.screenshot({ path: `${out}/.flush.png` }); return String((await app.call('getPaintedText', {})).text) }
    const open = async () => {
      await until(async () => (await app.getByTestId('model-picker').count()) > 0, 'picker trigger', 20000)
      await app.getByTestId('model-picker').click()
      await until(async () => (await app.getByTestId('model-search').count()) > 0, 'picker opens')
      await Bun.sleep(400)
    }
    const closed = (why: string) => until(async () => (await app.getByTestId('model-search').count()) === 0, why)
    const current = async () => (await text()).match(/Claude (?:Opus|Fable|Sonnet|Haiku) [\d.]+/)?.[0] ?? ''
    await open()
    await app.screenshot({ path: `${out}/open-${label}.png` })
    const search = app.getByTestId('model-search')
    // ↓↓ from "Agent default" lands on the third row; Enter picks it and closes the picker.
    await search.press('down'); await search.press('down')
    await app.screenshot({ path: `${out}/down-${label}.png` })
    await search.press('enter')
    await closed('Enter closes the picker')
    await until(async () => (await current()) !== 'Claude Opus 5.5' && (await current()) !== '', 'Enter picks the highlighted model')
    console.log(label, 'Enter picked', await current())
    // ⌘3 picks the third model row from the open panel.
    await open()
    await app.getByTestId('model-search').press('cmd-3')
    await closed('⌘3 closes the picker')
    await until(async () => (await text()).includes('Sonnet 5.5'), '⌘3 picks the third model')
    // Filter, then Escape closes without picking.
    await open()
    await app.getByTestId('model-search').fill('haiku')
    await until(async () => { const t = await text(); return t.includes('Haiku') && !t.includes('Opus 5.5') }, 'filter narrows the list').catch(async (e) => { await app.screenshot({ path: `${out}/filter-failed-${label}.png` }); console.log((await text()).slice(-500)); throw e })
    await app.screenshot({ path: `${out}/filter-${label}.png` })
    await app.getByTestId('model-search').press('escape')
    await closed('Escape closes the picker')
    assert.ok((await text()).includes('Sonnet 5.5'), 'Escape must not change the model')
    // ←/→ on the roving tabs move focus to the neighbouring enabled tab.
    await open()
    await until(async () => (await text()).includes('Search Claude Code models'), 'claude tab selected', 15000).catch(async (e) => { console.log((await text()).slice(-600)); await app.screenshot({ path: `${out}/tabs-failed-${label}.png` }); throw e })
    const tab = app.getByTestId('model-tab-claude-code:default')
    await tab.press('right')
    await app.call('keystrokes' as never, { keys: 'enter' } as never)
    await until(async () => !(await text()).includes('Search Claude Code models') && (await text()).includes('Search'), '→ then Enter activates the next tab')
    await app.screenshot({ path: `${out}/tab-right-${label}.png` })
    await app.getByTestId('model-search').press('escape')
    await closed('Escape closes again')
    console.log(`PASS ${label}: ↑↓+Enter, ⌘3, filter, Escape, →+Enter on tabs`)
  } catch (error) { await f.app.screenshot({ path: `${out}/failed-${label}.png` }).catch(() => {}); console.log(f.diagnostics().slice(-1500)); throw error } finally { const id = f.thread?.id; await f.close(); if (id) { const c = await connect(readState()!); await c.call('threads.archive', { thread_id: id }).catch(() => {}); c.close?.() } }
}
process.exit(0)
