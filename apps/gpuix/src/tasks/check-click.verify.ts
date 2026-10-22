// Board cards: clicking the checkbox selects the task and leaves the board open (ADE-49).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { launch, type App } from '@gpuix/react/automation'
import { KybernClient } from '../../../../packages/kybern-client/src/client.ts'

const data = process.env.KYBERN_DATA_DIR ?? ''
if (!data.includes('gpuix-scratch')) throw Error('Scratch daemon required')
const client = new KybernClient({ url: `ws://127.0.0.1:${readFileSync(path.join(data, 'daemon.port'), 'utf8').trim()}/ws`, token: readFileSync(path.join(data, 'daemon.token'), 'utf8').trim() })
client.connect()
while (client.status !== 'open') await Bun.sleep(50)
let app: App | undefined
try {
  const project = (await client.call('projects.list', {})).projects.find(p => p.name === 'scratch-project')!
  const ids: string[] = []
  for (let n = 0; n < 3; n++) ids.push((await client.call('tasks.items.create', { scope: 'project', project_id: project.id, title: `Check click fixture ${n}`, status: 'todo' })).id)
  app = await launch({ command: 'bun', args: [path.resolve('src/main.tsx')], env: { GPUIX_BACKGROUND: '1', KYBERN_DATA_DIR: data, NAPI_RS_NATIVE_LIBRARY_PATH: process.env.NAPI_RS_NATIVE_LIBRARY_PATH! } })
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 30000 })
  await Bun.sleep(1500)
  await app.getByTestId('rail-tasks').click()
  await app.getByTestId(`task-filter-project:${project.id}`).waitFor({ timeoutMs: 15000 })
  await app.getByTestId(`task-filter-project:${project.id}`).click()
  await Bun.sleep(300)
  if (await app.getByTestId('task-back').count()) await app.getByTestId('task-back').click()
  await app.getByTestId('task-view-board').click()
  await app.getByTestId('task-board').waitFor()
  await Bun.sleep(300)
  for (const id of ids.slice(0, 2)) {
    await app.getByTestId(`task-row-${id}`).hover()
    await Bun.sleep(200)
    await app.getByTestId(`task-select-${id}`).click()
    await Bun.sleep(250)
    assert.equal(await app.getByTestId('task-back').count(), 0, 'Clicking a card checkbox must not open the task')
    assert.equal(await app.getByTestId('task-board').count(), 1)
  }
  assert.equal(await app.getByTestId('task-selection').count(), 1, 'The picked cards must show the selection bar')
  assert.ok((await app.call('getPaintedText', {})).text.some(text => text.includes('2 selected')), 'Both checkbox clicks must select')
  await app.screenshot({ path: path.join(process.env.KYBERN_VERIFY_OUTPUT ?? '.', 'ade49-board-select.png') })
  console.log('Two cards picked through their checkboxes; board stayed open')
  await app.getByTestId(`task-row-${ids[2]}`).click()
  await app.getByTestId('task-back').waitFor({ timeoutMs: 5000 })
  console.log('A plain card click still opens the task')
} finally {
  await app?.close()
  client.close?.()
}
