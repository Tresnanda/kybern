// Native long-list regression, separate from the matched 17-task timing workload.
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { connect } from '../../visual/fixture.ts'
import { launchFixture } from './round7b-harness.ts'
import { acquirePreviewUiLock } from '../../scripts/preview-ui-lock.ts'
const data = '/Users/mymac/projects/ade-gpuix-scratch/round7-tasks7b'
const out = '/Users/mymac/projects/ade/previews/gpuix/round7/tasks7b'
const client = await connect({ daemonPid: 0, port: 4276, token: readFileSync(`${data}/daemon.token`, 'utf8').trim(), seeded: true })
let tasks = (await client.call('tasks.items.list', {})).tasks
if (process.argv.includes('--seed')) {
  for (let i = 1; i <= 180; i++) {
    const title = `Long list task ${String(i).padStart(3, '0')}`
    if (!tasks.some(task => task.title === title)) await client.call('tasks.items.create', {scope: 'global', title, status: 'todo', priority: 0})
  }
  client.close?.(); process.exit()
}
if (readFileSync('/tmp/kybern-gpuix-ui-queue', 'utf8').trim().split('\n')[0] !== 'tasks7b') throw Error('Queue tasks7b first')
const unlock = acquirePreviewUiLock()
const label = process.env.R7_LABEL ?? 'long-dark-0'
const fixture = await launchFixture(path.resolve('src/tasks/round7b-app.ts'), {GPUIX_BACKGROUND: '1', KYBERN_DATA_DIR: data, KYBERN_OPAQUE: '1', KYBERN_CLIENT_CONFIG_DIR: `${data}/client`, KYBERN_GPUIX_CREDENTIALS_DIR: `${data}/creds`})
const app = fixture.app
const wait = async (test: () => Promise<boolean>, name: string) => {
  const end = Date.now() + 8000
  while (!await test()) { if (Date.now() > end) throw Error(`Timed out: ${name}`); await Bun.sleep(16) }
}
try {
  await app.getByTestId('app-ready').waitFor({timeoutMs: 60000}); await app.clock.resume()
  await app.getByTestId('rail-tasks').click(); await app.getByTestId('task-view-list').waitFor(); await app.getByTestId('task-view-list').click()
  await app.getByTestId('task-list-viewport').waitFor()
  const area = await app.getByTestId('task-list-viewport').bounds(), point = {x: area.x + area.width / 2, y: area.y + area.height / 2}
  await app.mouse.wheel(point, 0, -30000)
  await wait(async () => (await app.call('getPaintedText', {})).text.join('\n').includes('Long list task 180'), 'last row paints')
  let mountedRows = 0
  for (const task of tasks) mountedRows += await app.getByTestId(`task-row-${task.id}`).count()
  if (mountedRows > 40 || !mountedRows) throw Error(`Unexpected mounted rows: ${mountedRows}`)
  const windowId = execFileSync('swift', [path.resolve('src/tasks/round7-window-id.swift'), String(fixture.pid)], {encoding: 'utf8'}).trim()
  execFileSync('screencapture', ['-x', '-o', '-l', windowId, `${out}/${label}-last.png`])
  await app.mouse.wheel(point, 0, 30000)
  await app.getByTestId('task-add-status:todo').waitFor(); await app.getByTestId('task-add-status:todo').click()
  await app.getByTestId('task-quick-title').waitFor(); await app.getByTestId('task-quick-title').press('escape')
  await wait(async () => !!await app.getByTestId(`task-row-${tasks.find(task => task.title.startsWith('Mobile parity'))!.id}`).count(), 'first row restores')
  writeFileSync(`${out}/${label}.json`, JSON.stringify({pass: true, taskCount: tasks.length, mountedRows, last: 'Long list task 180', quickAdd: 'open/cancel', clock: 'real', screenshot: 'window-ID OS capture; separate from timing'}))
} finally { await fixture.close(); client.close?.(); unlock() }
