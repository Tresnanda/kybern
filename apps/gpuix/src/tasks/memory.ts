/** Scratch-only, screenshot-free memory attribution. Own fixtures and window are always cleaned up. */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { launch, type App, type Locator } from '@gpuix/react/automation'
import { KybernClient } from '../../../../packages/kybern-client/src/client.ts'

const scratch = '/Users/mymac/projects/ade-gpuix-scratch/data'
if (process.env.KYBERN_DATA_DIR !== scratch) throw new Error('KYBERN_DATA_DIR must name the GPUIX scratch daemon.')
const port = readFileSync(path.join(scratch, 'daemon.port'), 'utf8').trim()
const token = readFileSync(path.join(scratch, 'daemon.token'), 'utf8').trim()
const client = new KybernClient(
  { url: `ws://127.0.0.1:${port}/ws`, token },
  {
    createSocket: (url, token) =>
      new WebSocket(url, { headers: { origin: 'tauri://localhost', Authorization: `Bearer ${token}` } } as unknown as string[]),
  },
)
await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Connection timeout')), 10000)
  client.onStatus((status) => {
    if (status === 'open') {
      clearTimeout(timer)
      resolve()
    }
  })
  client.connect()
})
const ids: string[] = []
let app: App | null = null
const report: { run: number; stage: string; footprint: number; rows: number }[] = []
async function until<T>(fn: () => Promise<T>, accept: (v: T) => boolean, label: string) {
  const start = Date.now()
  while (true) {
    const value = await fn()
    if (accept(value)) return value
    if (Date.now() - start > 20000) throw new Error(`Timeout: ${label}`)
    await Bun.sleep(100)
  }
}
async function click(target: Locator) {
  await target.waitFor({ timeoutMs: 20000 })
  const b = await until(
    () => target.bounds().catch(() => null),
    (b) => !!b && b.width > 0 && b.height > 0,
    'bounds',
  )
  await app!.mouse.click({ x: b!.x + b!.width / 2, y: b!.y + b!.height / 2 })
}
async function sample(run: number, stage: string, pid: number) {
  // Synchronize on a painted tree, not a timer. No screenshot allocation anywhere in this script.
  await app!.call('getPaintedText', {})
  const text = execFileSync('footprint', ['-p', String(pid)], { encoding: 'utf8' })
  const value = text.match(/Footprint:\s+([\d.]+)\s+([KMG]B)/)!
  const footprint = Number(value[1]) * (value[2] === 'GB' ? 1024 : value[2] === 'KB' ? 1 / 1024 : 1)
  const nodes = await app!.getByType('div').all()
  const rows = nodes.filter((node) => node.testId?.startsWith('task-row-')).length
  report.push({ run, stage, footprint, rows })
  console.log(JSON.stringify(report.at(-1)))
  writeFileSync('/Users/mymac/projects/ade/previews/gpuix/tasks/memory.json', JSON.stringify(report, null, 2))
}
try {
  const project = (await client.call('projects.list', {})).projects.find((p) => p.name === 'scratch-project')!
  for (let i = 0; i < 209; i++) {
    const task = await client.call('tasks.items.create', {
      scope: 'project',
      project_id: project.id,
      title: `Memory fixture ${i + 1}`,
      body: 'A short description.\n\n- [ ] Verify the interface',
      status: i % 2 ? 'inbox' : 'todo',
      priority: 0,
    })
    ids.push(task.id)
  }
  for (let run = 1; run <= 2; run++) {
    app = await launch({
      command: 'bun',
      args: [path.resolve(import.meta.dir, '../main.tsx')],
      env: {
        GPUIX_BACKGROUND: '1',
        KYBERN_APPEARANCE: 'dark',
        KYBERN_DATA_DIR: scratch,
        NAPI_RS_NATIVE_LIBRARY_PATH: process.env.NAPI_RS_NATIVE_LIBRARY_PATH,
      },
    })
    const { pid } = await app.call('initialize', { protocolVersion: 1, client: 'tasks-memory' })
    console.log('PID', pid)
    await app.getByTestId('app-ready').waitFor({ timeoutMs: 60000 })
    await app.getByTestId('composer').waitFor({ timeoutMs: 60000 })
    await sample(run, 'Home', pid)
    await click(app.getByTestId('rail-tasks'))
    await app.getByTestId('tasks-sidebar').waitFor()
    await click(app.getByTestId(`task-filter-project:${project.id}`))
    if (await app.getByTestId('task-board').count()) await click(app.getByText('List'))
    await app.getByTestId(`task-row-${ids[0]}`).waitFor()
    await until(
      () =>
        app!
          .getByTestId(`task-row-${ids[0]}`)
          .bounds()
          .catch(() => null),
      (b) => !!b && b.height > 0,
      'painted list',
    )
    await sample(run, 'Tasks list (209)', pid)
    await click(app.getByText('Board'))
    await app.getByTestId('task-board').waitFor()
    await until(
      () =>
        app!
          .getByTestId('task-column-todo')
          .bounds()
          .catch(() => null),
      (b) => !!b && b.height > 0,
      'painted board',
    )
    await sample(run, 'Tasks board (209)', pid)
    await click(app.getByTestId(`task-drag-${ids[0]}`))
    await app.getByTestId('task-detail').waitFor()
    await until(
      () =>
        app!
          .getByTestId('task-edit')
          .bounds()
          .catch(() => null),
      (b) => !!b && b.height > 0,
      'painted task detail',
    )
    await sample(run, 'Task detail', pid)
    await click(app.getByTestId('rail-home'))
    await app.getByTestId('composer').waitFor()
    await sample(run, 'Back Home', pid)
    await app.close()
    app = null
  }
  writeFileSync('/Users/mymac/projects/ade/previews/gpuix/tasks/memory.json', JSON.stringify(report, null, 2))
} finally {
  if (app) await app.close()
  for (const id of ids) await client.call('tasks.items.delete', { id }).catch(() => {})
  client.close()
}
