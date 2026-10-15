import { readFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { launch } from '@gpuix/react/automation'
import { KybernClient } from '../../../packages/kybern-client/src/client.ts'
import { until, openDock, absent } from './dock-waits.ts'
const data = '/Users/mymac/projects/ade-gpuix-scratch/data'
const out = '/Users/mymac/projects/ade/previews/gpuix/dock2'
mkdirSync(out, { recursive: true })
const port = readFileSync(`${data}/daemon.port`, 'utf8').trim()
const token = readFileSync(`${data}/daemon.token`, 'utf8').trim()
const client = new KybernClient({ url: `ws://127.0.0.1:${port}/ws`, token }, { createSocket: (url, key) => new WebSocket(url, { headers: { origin: 'tauri://localhost', Authorization: `Bearer ${key}` } } as unknown as string[]) })
const ready = new Promise<void>(resolve => client.onStatus(s => { if (s === 'open') resolve() }))
client.connect(); await ready
const project = (await client.call('projects.list', {})).projects.find(p => p.name === 'scratch-project')!
assert.ok(project)
const thread = await client.call('threads.create', { project_id: project.id, title: 'Dock2 verification', provider: { kind: 'claude-code', instance: 'default' }, model: 'claude-haiku-5-5' })
const notes: string[] = [], tasks: string[] = []
let pid: number | undefined
let app: Awaited<ReturnType<typeof launch>> | undefined
const guard = setTimeout(() => { if (pid) process.kill(pid, 'SIGTERM'); process.exit(1) }, 600_000)
try {
  for (let i = 0; i < 14; i++) { const n = await client.call('notes.create', { scope: 'project', project_id: project.id, title: `Dock note ${i + 1}`, body: 'Keep the workspace focused.\n\n- [x] Save this idea\n- [ ] Follow up' }); notes.push(n.id); if (i < 2) await client.call('notes.pin', { id: n.id, pinned: true }) }
  for (let i = 0; i < 60; i++) { const task = await client.call('tasks.items.create', { scope: 'project', project_id: project.id, title: `Dock task ${i + 1}`, status: i % 2 ? 'todo' : 'inbox', priority: i % 5 as 0 | 1 | 2 | 3 | 4 }); tasks.push(task.id) }
  const perf = process.argv.includes('--perf')
  for (const appearance of perf ? ['dark', 'dark'] : ['dark', 'light']) {
    app = await launch({ command: 'bun', args: [path.resolve('scripts/dock2-fixture.tsx')], env: { ...process.env, GPUIX_BACKGROUND: '1', DOCK2_NOTE_DELAY: '1', KYBERN_DATA_DIR: data, KYBERN_GPUIX_THREAD: thread.id, KYBERN_APPEARANCE: appearance } })
    pid = (await app.call('initialize', { protocolVersion: 1, client: 'dock2-check' })).pid
    await app.getByTestId('header-title').waitFor({ timeoutMs: 60000 })
    await app.getByTestId('dock-toggle').click(); await openDock(app.getByTestId('right-dock'))
    for (const tab of ['notes', 'tasks']) {
      await app.getByTestId('dock-add').click(); await app.getByTestId(`dock-add-${tab}`).click()
      await app.getByTestId(`dock-${tab}-list`).waitFor({ timeoutMs: 30000 })
      if (perf) {
        const sample: { stdout: ReadableStream; exited: Promise<number> } = Bun.spawn(['bun', 'perf/sample.ts', '15', `GPUIX=${pid}`], { stdout: 'pipe' }); console.log(`${tab} ${appearance}\n${await new Response(sample.stdout).text()}`); assert.equal(await sample.exited, 0)
      } else {
        if (tab === 'notes' && appearance === 'dark') {
          await app.getByTestId('thread-note-new').fill('Remember the dock follow-up.\n- [ ] Review both appearances')
          await until(async () => !!(await client.call('notes.list', {})).notes.find(n => n.thread_id === thread.id), 'thread note create')
          const own = (await client.call('notes.list', {})).notes.find(n => n.thread_id === thread.id)!
          notes.push(own.id)
          await app.getByTestId('thread-note-new').fill('Typed while the first save was in flight.')
          await app.getByTestId('thread-note-body').waitFor({ timeoutMs: 10000 })
          await until(async () => (await client.call('notes.get', { id: own.id })).note?.body === 'Typed while the first save was in flight.', 'in-flight first-save draft survives')
          await app.getByTestId('thread-note-body').fill('Remember the dock follow-up.\n- [x] Review both appearances')
          await until(async () => (await client.call('notes.get', { id: own.id })).note?.body.includes('[x]') ?? false, 'thread note autosave')
        }
        if (tab === 'tasks' && appearance === 'dark') {
          await app.getByTestId('dock-new-task').click(); await app.getByTestId('dock-task-title').fill('Dock inline Return works'); await app.getByTestId('dock-task-title').press('enter')
          let created: string | undefined
          await until(async () => { created = (await client.call('tasks.items.list', {})).tasks.find(t => t.title === 'Dock inline Return works')?.id; return !!created }, 'inline task submit')
          tasks.push(created!)
          await app.getByTestId('dock-task-title').press('escape')
          await absent(app.getByTestId('dock-task-title'))
        }
        await app.getByTestId('app-ready').hover()
        await app.screenshot({ path: `${out}/${tab}-${appearance}.png` })
      }
    }
    await app.getByTestId('dock-collapse').click(); await absent(app.getByTestId('dock-tasks'))
    await app.close(); app = undefined; pid = undefined
  }
  console.log('PASS dock Notes/Tasks, lazy thread note creation, autosave, Return task creation, unmount')
} finally {
  if (app) await app.close()
  if (pid) try { process.kill(pid, 'SIGTERM') } catch {}
  for (const id of notes) { await client.call('notes.delete', { id }); await client.call('notes.purge', { id }) }
  for (const id of tasks) await client.call('tasks.items.delete', { id })
  await client.call('threads.archive', { thread_id: thread.id })
  client.close(); clearTimeout(guard)
}
