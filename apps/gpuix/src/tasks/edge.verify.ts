// Native edge-scroll regression with enough rows to require virtualization.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { launch, type App } from '@gpuix/react/automation'
import { KybernClient } from '../../../../packages/kybern-client/src/client.ts'

const data = process.env.KYBERN_DATA_DIR ?? ''
if (!data.includes('gpuix-scratch') && !data.endsWith('/ade-gpuix-notes/.p4/data')) throw Error('Scratch daemon required')
const client = new KybernClient({ url: `ws://127.0.0.1:${readFileSync(path.join(data, 'daemon.port'), 'utf8').trim()}/ws`, token: readFileSync(path.join(data, 'daemon.token'), 'utf8').trim() })
client.connect()
while (client.status !== 'open') await Bun.sleep(50)
const ids: string[] = []
let app: App | undefined
try {
  const project = (await client.call('projects.list', {})).projects.find(p => p.name === 'scratch-project')!
  for (let n = 0; n < 48; n++) ids.push((await client.call('tasks.items.create', { scope: 'project', project_id: project.id, title: `Edge scroll fixture ${String(n).padStart(2, '0')}`, status: 'inbox' })).id)
  app = await launch({ command: 'bun', args: [path.resolve('src/main.tsx')], env: { GPUIX_BACKGROUND: '1', KYBERN_DATA_DIR: data, NAPI_RS_NATIVE_LIBRARY_PATH: process.env.NAPI_RS_NATIVE_LIBRARY_PATH! } })
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 30000 })
  await Bun.sleep(1500)
  console.log('Open tasks')
  await app.getByTestId('rail-tasks').click()
  await app.getByTestId(`task-filter-project:${project.id}`).waitFor({ timeoutMs: 15000 })
  await Bun.sleep(300)
  await app.getByTestId(`task-filter-project:${project.id}`).click()
  await Bun.sleep(300)
  if (await app.getByTestId('task-back').count()) await app.getByTestId('task-back').click()
  if (await app.getByTestId('task-board').count()) await app.getByTestId('task-view-list').click()
  await app.getByTestId('task-search').fill('Edge scroll fixture')
  await Bun.sleep(500)
  console.log('Read list bounds')
  await app.getByTestId('task-list').waitFor()
  await app.screenshot({ path: '/Users/mymac/projects/ade/previews/gpuix/p4/edge.png' })
  const list = await app.getByTestId('task-list-viewport').bounds()
  let picked: string | undefined
  for (const id of ids) {
    const box = await app.getByTestId(`task-drag-${id}`).bounds().catch(() => null)
    if (box && box.height > 0 && box.y >= list.y && box.y + box.height < list.y + list.height) { picked = id; break }
  }
  assert(picked, 'A populated visible task is required')
  const before = (await app.call('getPaintedText', {})).text.filter(text => text.includes('Edge scroll fixture'))
  console.log('Drag visible row', picked)
  const source = app.getByTestId(`task-drag-${picked}`)
  const start = await source.center()
  await app.mouse.move(start); await app.mouse.down(start)
  await app.mouse.move({ x: start.x + 8, y: start.y }, { pressedButton: 0 })
  await app.getByTestId('task-drag-layer').waitFor()
  const edge = { x: list.x + list.width / 2, y: list.y + list.height - 8 }
  await app.mouse.move(edge, { pressedButton: 0 })
  // Background windows may be occluded, pausing the shared animation clock.
  // Continue pointer movement to exercise functional scrolling without activating the window.
  for (let n = 0; n < 15; n++) { await Bun.sleep(210); await app.mouse.move({ ...edge, x: edge.x + n % 2 }, { pressedButton: 0 }) }
  assert.equal(await app.getByTestId('task-drag-layer').count(), 1)
  const after = (await app.call('getPaintedText', {})).text.filter(text => text.includes('Edge scroll fixture'))
  assert.ok(after.some(text => !before.includes(text)), 'Holding the pointer at the edge must reveal new task rows, not just paint the dragged clone')
  await app.getByTestId('app-ready').press('escape')
  await app.mouse.up(edge)
  await app.getByTestId('task-list').waitFor()
  assert.equal(await app.getByTestId('task-drag-layer').count(), 0)
  console.log('PASS 48-row drag edge autoscroll and Escape release without opening a task')
} finally {
  await app?.close()
  for (const id of ids) await client.call('tasks.items.delete', { id }).catch(() => {})
  client.close()
}
