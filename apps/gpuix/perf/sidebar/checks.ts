import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import type { App } from '@gpuix/react/automation'
import { until } from '../../scripts/dock-waits.ts'

/** Separate from timings: screenshots, disclosure frames and interaction assertions. */
export async function checkSidebar(app: App, out: string, label: string, theme: string) {
  const prefix = `${out}/${label}-${theme}`
  const shot = (name: string) => app.screenshot({ path: `${prefix}-${name}.png` })
  const away = () => app.mouse.move({ x: 1100, y: 650 })
  const painted = async () => (await app.call('getPaintedText', {})).text.join('\n')
  const ids = async (prefix: string) => {
    const snapshot = await app.call('getTree', {}), found: string[] = []
    const walk = (node: NonNullable<typeof snapshot.tree>) => { if (node.testId?.startsWith(prefix)) found.push(node.testId); node.children?.forEach(walk) }
    if (snapshot.tree) walk(snapshot.tree)
    return found
  }
  const counts = async () => {
    const snapshot = await app.call('getTree', {})
    let nodes = 0, rich = 0, slots = 0
    const walk = (node: NonNullable<typeof snapshot.tree>, inside = false) => {
      const list = inside || node.testId === 'thread-list'
      if (list) { nodes++; if (node.testId?.startsWith('thread-') || node.testId?.startsWith('child-') || /^project-[\da-f]/.test(node.testId ?? '')) rich++; if (node.testId?.startsWith('sidebar-slot:')) slots++ }
      node.children?.forEach(child => walk(child, list))
    }
    if (snapshot.tree) walk(snapshot.tree)
    return { nodes, rich, slots }
  }
  await away(); await Bun.sleep(20_000)
  await shot('initial')
  const initial = await counts()
  const threads = (await ids('thread-')).filter(id => id !== 'thread-list')
  let firstThread = threads[0]!
  for (const id of threads.slice(0, 3)) if ((await app.getByTestId(id).textContent()).startsWith('Sidebar review')) { firstThread = id; break }
  const projectIds = (await ids('project-')).filter(id => /^project-[\da-f]{8}-/.test(id))
  const project = projectIds[0]!
  const row = app.getByTestId(firstThread)
  await row.hover(); await Bun.sleep(450); await shot('hover')
  await Bun.sleep(900); await shot('marquee')
  // Inline rename and its menu must retain the same row beyond the mount buffer.
  await row.click({ button: 2 }); await app.getByTestId('thread-menu').waitFor(); await shot('context')
  await app.getByText('Rename thread').click()
  const rename = app.getByTestId(`rename-${firstThread.slice(7)}`)
  await rename.waitFor(); const beforeRename = 'unchanged (Escape)'
  const viewport = await app.getByTestId('sidebar-viewport').bounds(), point = { x: viewport.x + 100, y: viewport.y + viewport.height / 2 }
  await app.mouse.wheel(point, 0, -5000); await Bun.sleep(400)
  assert.equal(await rename.count(), 1, 'scrolling disposed the active inline editor')
  await rename.press('escape')
  await app.mouse.wheel(point, 0, 10000); await Bun.sleep(500)
  await app.getByTestId(project).hover(); await Bun.sleep(200)
  const toggle = app.getByTestId(`project-toggle-${project.slice(8)}`)
  await toggle.click(); await Bun.sleep(350); await shot('collapsed')
  await app.getByTestId(project).hover(); await toggle.click(); await Bun.sleep(350); await shot('expanded')
  const more = (await ids('more-'))[0]
  if (more) { await app.getByTestId(more).click(); await Bun.sleep(350); await shot('more'); await app.getByTestId(more).click(); await Bun.sleep(350) }
  const children = (await ids('children-'))[0]
  if (children) { await app.getByTestId(children).click(); await Bun.sleep(350); await shot('children-closed'); await app.getByTestId(children).click(); await Bun.sleep(350); await shot('children-open') }
  // Long native wheel jumps remount rich rows; return to the exact first content.
  await app.mouse.wheel(point, 0, -15000); await Bun.sleep(700); await shot('end')
  const atEnd = await counts()
  assert.match(await painted(), /Startup project/)
  await app.mouse.wheel(point, 0, 30000); await Bun.sleep(700)
  assert.ok((await painted()).includes('Startup project 01'), 'first project missing after reverse jump')
  const back = await counts(); await shot('returned')
  if (!label.startsWith('baseline')) { assert.ok(initial.rich < 140, `unbounded initial rows: ${initial.rich}`); assert.ok(atEnd.rich < 180, `unbounded end rows: ${atEnd.rich}`); assert.ok(back.rich < 180, `unbounded returned rows: ${back.rich}`) }

  // Project drag keeps exact pointer offset, landing, Escape and reordered rows.
  const source = await app.getByTestId(project).center()
  const second = projectIds[1]!
  const target = await app.getByTestId(second).center()
  await app.mouse.move(source); await app.mouse.down(source)
  let anchor: { pointer: { x: number; y: number }; ghost: { x: number; y: number } } | undefined
  for (let i = 1; i <= 30; i++) {
    const pointer = { x: source.x, y: source.y + (target.y + 50 - source.y) * i / 30 }
    await app.mouse.move(pointer, { pressedButton: 0 }); await Bun.sleep(8)
    const ghost = await app.getByTestId('project-drag-ghost').bounds()
    if (!anchor) anchor = { pointer, ghost }
    assert.ok(Math.abs(ghost.x - anchor.ghost.x - pointer.x + anchor.pointer.x) <= 1.5)
    assert.ok(Math.abs(ghost.y - anchor.ghost.y - pointer.y + anchor.pointer.y) <= 1.5)
  }
  await shot('drag-held'); await app.mouse.up({ x: source.x, y: target.y + 50 })
  await until(async () => !await app.getByTestId('project-drag-layer').count(), 'project landing')
  await shot('drag-landed')
  assert.ok((await app.getByTestId(project).bounds()).y > (await app.getByTestId(second).bounds()).y, 'project did not reorder')
  const cancel = await app.getByTestId(second).center()
  await app.mouse.move(cancel); await app.mouse.down(cancel); await app.mouse.move({ x: cancel.x + 5, y: cancel.y + 40 }, { pressedButton: 0 })
  await app.getByTestId('app-ready').press('escape')
  await until(async () => !await app.getByTestId('project-drag-layer').count(), 'project cancel')

  // R4-1: positive tooltip dwell, then rapid native pointer sweeps leave none.
  const spots = await Promise.all(['rail-home', 'rail-notes', 'rail-tasks', 'rail-pulls', 'rail-usage', 'rail-settings'].map(id => app.getByTestId(id).center()))
  await away(); await app.mouse.move(spots[1]!); await until(async () => await app.getByTestId('tooltip').count() === 1, 'tooltip dwell')
  await shot('tooltip')
  let tooltipTrials = 0
  for (const gap of [0, 4, 16, 40, 120]) for (let repeat = 0; repeat < 6; repeat++) {
    const requests: Promise<unknown>[] = []
    for (const spot of [...spots, ...spots.slice().reverse(), { x: 1100, y: 650 }]) { requests.push(app.mouse.move(spot)); if (gap) await Bun.sleep(gap) }
    await Promise.all(requests); await Bun.sleep(800)
    assert.equal(await app.getByTestId('tooltip').count(), 0, `stuck tooltip after ${gap}ms sweep`)
    tooltipTrials++
  }
  writeFileSync(`${prefix}-checks.json`, JSON.stringify({ initial, atEnd, back, beforeRename, projectDrag: true, renameLease: true, disclosure: true, children: !!children, tooltipR4_1: true, tooltipTrials }, null, 2))
}
