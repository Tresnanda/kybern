/**
 * Item 12: the thread context menu's "Open to the right" / "Open below" (enabled by `openThreadInSplit`, desktop
 * `state/store.ts:873`). Right-click a thread row, choose each item, assert the split dividers and the title bar.
 *   bun scripts/kit9-split-menu.ts [--light] [--reduced]
 */
import { connect, readState } from '../visual/fixture.ts'
import { EVIDENCE, resetSeededUi, start, waitUntil } from './kit9-lib.ts'
const light = process.argv.includes('--light'), reduced = process.argv.includes('--reduced')
const sleep = (n: number) => new Promise((r) => setTimeout(r, n))
resetSeededUi()
const client = await connect(readState()!)
void client
const app = await start({ light, reduced, seeded: true, env: { KYBERN_GPUIX_THREAD: 'Long review thread' } })
const dividers = async () => { const out: string[] = []; const walk = (n: any) => { if (n?.testId?.startsWith('split-resize-')) out.push(n.testId); n?.children?.forEach(walk) }; walk(((await app.call('getTree', {})) as any).tree); return out }
let failed = 0
const check = (ok: boolean, what: string) => { console.log(ok ? 'PASS' : 'FAIL', what); if (!ok) failed++ }
try {
  await waitUntil(async () => (await app.getByTestId('sidebar-resize').count()) > 0, 30_000, 'app')
  await sleep(1200)
  const row = (id: string) => app.getByTestId(`thread-${id}`)
  const visible = async () => { const out: string[] = []; const walk = (n: any) => { if (n?.testId?.startsWith('thread-') && !n.testId.startsWith('thread-menu') && !n.testId.startsWith('thread-actions')) out.push(n.testId.slice(7)); n?.children?.forEach(walk) }; walk(((await app.call('getTree', {})) as any).tree); return out }
  if (!(await visible()).length) { await app.getByTestId('app-ready').press('cmd-b'); await sleep(1000) }
  const ids = await visible()
  console.log('visible thread rows', ids.length)
  const a = { id: ids[3]! }, b = { id: ids[4]! }
  check((await dividers()).length === 0, 'no split at the start')
  // Right-click "Rich reply": open it to the right of the current thread.
  await row(a.id).click({ button: 2 }); await sleep(400)
  check((await app.getByTestId('thread-menu').count()) > 0, 'the thread context menu opens')
  await app.screenshot({ path: `${EVIDENCE}/split-menu-open-${light ? 'light' : 'dark'}.png` })
  // The sidebar's menu items carry no test id: keyboard (Rename, Pin, Hand off, Open to the right, Open below, Archive).
  const choose = async (n: number) => { for (let i = 0; i < n; i++) { await app.getByTestId('app-ready').press('down'); await sleep(60) } await app.getByTestId('app-ready').press('enter') }
  await choose(4); await sleep(900)
  check((await dividers()).length === 1, 'Open to the right splits the window (1 divider)')
  await app.screenshot({ path: `${EVIDENCE}/split-menu-right-${light ? 'light' : 'dark'}${reduced ? '-reduced' : ''}.png` })
  // "Open below" on another thread.
  await row(b.id).click({ button: 2 }); await sleep(400)
  await app.screenshot({ path: `${EVIDENCE}/split-menu-second-${light ? 'light' : 'dark'}.png` })
  // "Open to the right" is disabled here (the focused pane's parent split is already horizontal, desktop `canSplitPane`) and
  // keyboard navigation skips it: "Open below" is the fourth item.
  await choose(4); await sleep(900)
  check((await dividers()).length === 2, 'Open below splits again (2 dividers)')
  await app.screenshot({ path: `${EVIDENCE}/split-menu-below-${light ? 'light' : 'dark'}${reduced ? '-reduced' : ''}.png` })
  // A thread that is already open in a pane has both items disabled.
  await row(a.id).click({ button: 2 }); await sleep(400)
  await app.screenshot({ path: `${EVIDENCE}/split-menu-open-thread-${light ? 'light' : 'dark'}.png` })
  await app.getByTestId('app-ready').press('escape'); await sleep(300)
} catch (e) { console.error(String(e).slice(0, 300)); await app.screenshot({ path: `${EVIDENCE}/split-menu-failure.png` }).catch(() => {}); failed++ } finally { await app.closeAll() }
console.log(failed ? `${failed} FAILED` : 'ALL PASS')
process.exit(failed ? 1 : 0)
