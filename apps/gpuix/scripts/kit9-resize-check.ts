/**
 * R1-9: "resizing some sidebars shows an error". Drag every resize handle in the app (thread sidebar on Home/thread and Tasks, the
 * right dock with its Notes/Tasks panels, split-view dividers) at fast and slow drags, to both limits and past the window, with
 * jitter, in narrow, minimum and wide windows; after every drag assert that no error boundary rendered, that nothing was logged
 * to the error channel, and that the handle moved within its limits.
 *
 * Pointer input is GPUIX's native mouse simulation (OS-level events are unavailable here, see kit9-tooltips.ts).
 * Needs the seeded scratch daemon with threads: `bun scripts/visual-pair.ts notes-gallery --keep && bun scripts/kit9-seed-threads.ts`.
 *
 *   bun scripts/kit9-resize-check.ts [--light] [--reduced] [--sizes 900x600,1280x820]
 */
import assert from 'node:assert/strict'
import { SEEDED, start, waitUntil, type App } from './kit9-lib.ts'
const arg = (n: string) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : undefined)
const light = process.argv.includes('--light'), reduced = process.argv.includes('--reduced')
const sizes = (arg('--sizes') ?? '900x600,1000x700,1280x820,1700x900').split(',')
const failures: string[] = []
let drags = 0
const sleep = (n: number) => new Promise((r) => setTimeout(r, n))

async function run(size: string) {
  // Saved layout (sidebar width, splits) would leak between runs.
  Bun.spawnSync(['rm', '-f', `${SEEDED.dataDir}/gpuix-ui.json`])
  const app = await start({ light, reduced, seeded: true, size, env: { KYBERN_GPUIX_THREAD: 'Long review thread' } }) as App & { diagnostics: () => string; closeAll: () => Promise<void> }
  const [W, H] = size.split('x').map(Number) as [number, number]
  const tag = (s: string) => `${size} ${s}`
  const exists = (id: string) => async () => (await app.getByTestId(id).count()) > 0
  const click = async (id: string) => { await app.getByTestId(id).hover(); await sleep(120); await app.getByTestId(id).click() }
  const healthy = async (what: string) => {
    if ((await app.getByTestId('error-fallback').count()) > 0) { failures.push(tag(`${what}: an error boundary rendered`)); return false }
    const log = app.diagnostics()
    const bad = log.split('\n').filter((l) => /\[error-boundary\]|panicked|RangeError|TypeError|Maximum update depth|Rendered (more|fewer) hooks|Unhandled/.test(l))
    if (bad.length) { failures.push(tag(`${what}: ${bad[0]!.slice(0, 160)}`)); return false }
    return true
  }
  const drag = async (id: string, label: string) => {
    const horizontal = (await app.getByTestId(id).bounds()).width <= 24
    const before = await app.getByTestId(id).bounds()
    const lo = horizontal ? 0 : 0, hi = horizontal ? W + 400 : H + 400
    const plans: [string, number, number[]][] = [
      ['fast to min', 2, [lo]], ['fast to max', 2, [hi]], ['slow to min', 24, [lo]], ['slow to max', 24, [hi]],
      ['jitter', 30, [lo + 40, hi - 40, lo + 90, hi - 90, (lo + hi) / 2]], ['one px', 3, [(horizontal ? before.x : before.y) + 1]],
    ]
    for (const [name, steps, ends] of plans) {
      for (const end of ends) {
        const from = await app.getByTestId(id).center()
        await app.mouse.move(from); await sleep(60); await app.mouse.down(from)
        for (let i = 1; i <= steps; i++) {
          const v = (horizontal ? from.x : from.y) + ((end - (horizontal ? from.x : from.y)) * i) / steps
          await app.mouse.move(horizontal ? { x: v, y: from.y } : { x: from.x, y: v }, { pressedButton: 0 })
          if (steps > 2) await sleep(8)
        }
        // Release past the window edge for the "to max" plans, inside otherwise.
        await app.mouse.up(horizontal ? { x: end, y: from.y } : { x: from.x, y: end })
        drags++
        if (!(await healthy(`${label} ${name} to ${Math.round(end)}`))) return
        await sleep(30)
      }
    }
    const after = await app.getByTestId(id).bounds()
    if (horizontal && (after.x < -1 || after.x > W)) failures.push(tag(`${label}: handle ended at x=${after.x}, outside the window`))
    console.log(`  ${label}: ok (x ${before.x} → ${after.x}${horizontal ? '' : `, y ${before.y} → ${after.y}`})`)
  }
  try {
    console.log(`== ${size}`)
    await waitUntil(exists('sidebar-resize'), 20_000, 'thread sidebar handle')
    await sleep(800)
    await drag('sidebar-resize', 'thread sidebar')
    await click('dock-toggle'); await waitUntil(exists('dock-resize'), 8000, 'dock handle'); await sleep(500)
    await drag('dock-resize', 'dock')
    for (const tab of ['tasks', 'notes']) {
      if (!(await app.getByTestId(`dock-tab-${tab}`).count())) { await click('dock-add'); await waitUntil(exists(`dock-add-${tab}`), 5000, 'Add panel menu'); await click(`dock-add-${tab}`) } else await click(`dock-tab-${tab}`)
      await waitUntil(exists(`dock-${tab}`), 5000, `${tab} panel`); await sleep(300)
      await drag('dock-resize', `dock (${tab} panel)`)
    }
    await click('dock-toggle'); await sleep(400)
    // Split view dividers.
    await app.getByTestId('app-ready').press('cmd-\\'); await sleep(600)
    const dividers = async () => { const out: string[] = []; const walk = (n: any) => { if (n?.testId?.startsWith('split-resize-')) out.push(n.testId); n?.children?.forEach(walk) }; walk(((await app.call('getTree', {})) as any).tree); return out }
    await waitUntil(async () => (await dividers()).length > 0, 8000, 'split divider')
    const h = await dividers()
    for (const id of h) await drag(id, `split ${id}`)
    await app.getByTestId('app-ready').press('cmd-shift-\\'); await sleep(600)
    for (const id of (await dividers()).filter((id) => !h.includes(id))) await drag(id, `split ${id}`)
    // Tasks page sidebar.
    await click('rail-tasks'); await waitUntil(exists('tasks-sidebar'), 8000, 'Tasks sidebar'); await sleep(400)
    await drag('sidebar-resize', 'tasks sidebar')
    await healthy('end')
  } catch (error) {
    failures.push(tag(`aborted: ${error instanceof Error ? error.message : error}`))
    await app.screenshot({ path: `/Users/mymac/projects/ade/previews/gpuix/phase2/kit9/resize-failure-${size}.png` }).catch(() => {})
  } finally { await app.closeAll() }
}
for (const size of sizes) await run(size)
console.log(`${drags} drags; ${failures.length} failures`)
for (const f of failures) console.log('FAIL', f)
process.exitCode = failures.length ? 1 : 0
