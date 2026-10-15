// Self-contained native integration probe. Owns two ephemeral daemons and a file-only profile.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { KybernClient } from '../../../packages/kybern-client/src/client.ts'
import { launchFixture } from '../src/requests/harness.ts'
const root = path.resolve(import.meta.dir, '../../..')
const scratch = mkdtempSync(path.join(tmpdir(), 'gpuix-integration-'))
const children: ReturnType<typeof spawn>[] = []
const clients: KybernClient[] = []
let fixture: Awaited<ReturnType<typeof launchFixture>> | undefined
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(label: string, check: () => boolean | Promise<boolean>, ms = 30000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await check()) return; await wait(30) }
  throw Error(`Timed out: ${label}`)
}
async function daemon(name: string) {
  const dir = path.join(scratch, name); mkdirSync(dir)
  const child = spawn(path.join(root, 'target/debug/kybernd'), ['--data-dir', dir, '--port', '0'], { stdio: 'ignore' }); children.push(child)
  await until(`${name} daemon`, () => existsSync(path.join(dir, 'daemon.port')))
  const port = readFileSync(path.join(dir, 'daemon.port'), 'utf8').trim()
  if (port === '4219' || port === '0') throw Error('Unsafe or invalid scratch port')
  const token = readFileSync(path.join(dir, 'daemon.token'), 'utf8').trim()
  const client = new KybernClient({ url: `ws://127.0.0.1:${port}/ws`, token }); clients.push(client); client.connect()
  await until(`${name} connection`, () => client.status === 'open')
  const projectDir = path.join(dir, 'project'); mkdirSync(projectDir)
  const project = await client.call('projects.add', { path: projectDir, name: `integration-${name}` })
  return { dir, port, token, client, project }
}
try {
  const a = await daemon('a'), b = await daemon('b')
  const note = await a.client.call('notes.create', { scope: 'global', title: 'Isolation probe note A', body: 'Only environment A.' })
  const task = await a.client.call('tasks.items.create', { scope: 'global', title: 'Isolation probe task A', body: 'Only environment A.' })
  const config = path.join(scratch, 'profile'), creds = path.join(scratch, 'creds'); mkdirSync(config); mkdirSync(creds)
  writeFileSync(path.join(config, 'environments.json'), JSON.stringify({ selected_id: 'local', environments: [{ id: 'scratch-b', name: 'Scratch B', local: false, url: `http://127.0.0.1:${b.port}` }] }))
  writeFileSync(path.join(creds, 'scratch-b.token'), b.token, { mode: 0o600 })
  const env = { GPUIX_BACKGROUND: '1', KYBERN_DATA_DIR: a.dir, KYBERN_CLIENT_CONFIG_DIR: config, KYBERN_GPUIX_CREDENTIALS_DIR: creds, KYBERN_APPEARANCE: 'dark', KYBERN_URL: '', KYBERN_TOKEN: '', KYBERN_GPUIX_THREAD: '', KYBERN_GPUIX_ENVIRONMENT: 'local' }
  fixture = await launchFixture(path.join(root, 'apps/gpuix/src/main.tsx'), env)
  const app = fixture.app
  const present = (id: string) => app.getByTestId(id).count().then(n => n > 0)
  const click = async (id: string) => { await app.getByTestId(id).waitFor({ timeoutMs: 30000 }); await app.getByTestId(id).click() }
  const noteId = `note-card-${note.id}`, taskId = `task-row-${task.id}`
  await app.getByTestId(`project-${a.project.id}`).waitFor({ timeoutMs: 60000 })
  await click('rail-notes'); await app.getByTestId(noteId).waitFor()
  await click('rail-tasks'); await click('task-filter-all'); await app.getByTestId(taskId).waitFor()
  console.log('PASS: A note and task are visible (test IDs)')
  const switchTo = async (id: string, projectId: string) => {
    await click('rail-home'); await click('environment-switcher'); await click(`environment-choice-${id}`)
    await app.getByTestId(`project-${projectId}`).waitFor({ timeoutMs: 30000 })
  }
  await switchTo('scratch-b', b.project.id)
  let samples = 0
  for (const page of ['notes', 'tasks']) {
    await click(`rail-${page}`)
    if (page === 'tasks') await click('task-filter-all')
    const end = Date.now() + 2500
    while (Date.now() < end) {
      if (await present(noteId) || await present(taskId)) throw Error(`A item leaked in B ${page}`)
      const painted = (await app.call('getPaintedText', {})).text.join('\n')
      if (painted.includes(note.title) || painted.includes(task.title)) throw Error(`A item painted in B ${page}`)
      samples++; await wait(16)
    }
  }
  const bNotes = await b.client.call('notes.list', {}), bTasks = await b.client.call('tasks.items.list', {})
  if (bNotes.notes.length || bTasks.tasks.length) throw Error('B is not empty')
  console.log(`PASS: B empty; ${samples} native tree/paint samples had no A items`)
  await switchTo('local', a.project.id)
  await click('rail-notes'); await app.getByTestId(noteId).waitFor()
  await click('rail-tasks'); await click('task-filter-all'); await app.getByTestId(taskId).waitFor()
  console.log('PASS: A note and task restored')
  await click('rail-home')
  await wait(2500)
  console.log((await promisify(execFile)('bun', ['perf/sample.ts', '15', `GPUIX=${fixture.pid}`])).stdout)
} finally {
  if (fixture) { console.log(fixture.diagnostics()); await fixture.close() }
  for (const client of clients) client.close()
  for (const child of children) { child.kill(); await new Promise<void>(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', () => resolve()) }) }
  rmSync(scratch, { recursive: true, force: true })
}
