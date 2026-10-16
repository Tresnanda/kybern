import assert from 'node:assert/strict'
import { readFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { launch } from '@gpuix/react/automation'
import { KybernClient } from '../../../packages/kybern-client/src/client.ts'
const data = process.env.KYBERN_DATA_DIR ?? ''
if (!data.includes('gpuix-scratch/drag-release/')) throw Error('Dedicated drag-release scratch daemon required')
const out = '/Users/mymac/projects/ade/previews/gpuix/drag-release'
mkdirSync(out, { recursive: true })
const client = new KybernClient({ url: `ws://127.0.0.1:${readFileSync(path.join(data, 'daemon.port'), 'utf8').trim()}/ws`, token: readFileSync(path.join(data, 'daemon.token'), 'utf8').trim() })
client.connect()
while (client.status !== 'open') await Bun.sleep(50)
await client.call('projects.add', { path: '/Users/mymac/projects/ade-gpuix-scratch/scratch-project' })
const task = await client.call('tasks.items.create', { scope: 'global', title: 'Short drag must not open this task', status: 'inbox' })
const app = await launch({ command: 'bun', args: [path.resolve('src/main.tsx')], env: { GPUIX_BACKGROUND: '1', KYBERN_DATA_DIR: data, KYBERN_APPEARANCE: process.env.KYBERN_APPEARANCE ?? 'dark', KYBERN_REDUCED_MOTION: process.env.KYBERN_REDUCED_MOTION ?? '0', KYBERN_OPAQUE: '1' } })
try {
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 30000 })
  await app.getByTestId('rail-tasks').click()
  await app.getByTestId('task-filter-all').waitFor()
  await app.getByTestId('task-filter-all').click()
  await app.getByTestId('task-search').fill('Short drag must not open')
  for (const view of ['board', 'list']) {
    await app.getByTestId(`task-view-${view}`).click()
    await app.getByTestId(`task-drag-${task.id}`).waitFor()
    await Bun.sleep(400)
    const start = await app.getByTestId(`task-drag-${task.id}`).center()
    await app.mouse.move(start)
    await app.mouse.down(start)
    await app.mouse.move({ x: start.x + 8, y: start.y }, { pressedButton: 0 })
    // Release immediately: waiting for the overlay hides the source-row release race.
    await app.mouse.up({ x: start.x + 8, y: start.y })
    await Bun.sleep(1200)
    await app.mouse.move({ x: start.x + 35, y: start.y + 12 })
    const opened = await app.getByTestId('task-back').count()
    const held = await app.getByTestId('task-drag-layer').count()
    console.log(JSON.stringify({ view, opened, held }))
    await app.screenshot({ path: `${out}/${view}-${process.env.KYBERN_APPEARANCE ?? 'dark'}-${process.env.KYBERN_REDUCED_MOTION ?? '0'}.png` })
    assert.equal(opened, 0, `${view}: short drag must not open the task`)
    assert.equal(held, 0, `${view}: releasing must remove the carried card`)
    await app.getByTestId(`task-drag-${task.id}`).click()
    await app.getByTestId('task-back').waitFor()
    await app.getByTestId('task-back').click()
    console.log(`PASS ${view}: short drag release and subsequent normal click`)
    for (const gesture of ['jitter', 'escape', 'lost-up']) {
      const point = await app.getByTestId(`task-drag-${task.id}`).center()
      await app.mouse.move(point); await app.mouse.down(point)
      const moved = { x: point.x + (gesture === 'jitter' ? 2 : 10), y: point.y }
      await app.mouse.move(moved, { pressedButton: 0 })
      if (gesture === 'escape') {
        await app.getByTestId('task-drag-layer').waitFor()
        await app.getByTestId('app-ready').press('escape')
      }
      if (gesture !== 'lost-up') await app.mouse.up(moved)
      else {
        await app.getByTestId('task-drag-layer').waitFor()
        // A move with no held button is the recovery signal if mouse-up was lost.
        await app.mouse.move({ x: moved.x + 1, y: moved.y })
      }
      await Bun.sleep(1200)
      assert.equal(await app.getByTestId('task-drag-layer').count(), 0, `${view} ${gesture}: no carried card`)
      assert.equal(await app.getByTestId('task-back').count(), gesture === 'jitter' ? 1 : 0, `${view} ${gesture}: click vs drag`)
      if (gesture === 'jitter') await app.getByTestId('task-back').click()
      console.log(`PASS ${view}: ${gesture}`)
    }
  }
} finally {
  await app.close()
  await client.call('tasks.items.delete', { id: task.id })
  client.close()
}
