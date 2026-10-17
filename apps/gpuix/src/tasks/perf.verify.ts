// Screenshot-free, deterministic running-task and detail workload. Scratch daemon only.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { launch, type App } from '@gpuix/react/automation'
import { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
const data = path.resolve(process.env.KYBERN_DATA_DIR ?? '')
if (!data.endsWith('/ade-gpuix-notes/.p4/data') && !data.includes('gpuix-scratch')) throw Error('Scratch daemon required')
const client = new KybernClient({ url: `ws://127.0.0.1:${readFileSync(path.join(data, 'daemon.port'), 'utf8').trim()}/ws`, token: readFileSync(path.join(data, 'daemon.token'), 'utf8').trim() })
client.connect(); while (client.status !== 'open') await Bun.sleep(50)
const ids: string[] = []
let app: App | undefined
try {
  const project = (await client.call('projects.list', {})).projects.find((p) => p.name === 'scratch-project')!
  for (let i = 0; i < 8; i++) ids.push((await client.call('tasks.items.create', { scope: 'project', project_id: project.id, title: `Performance task ${i + 1}`, body: '## Native task editing\n\nKeep this description readable and preserve its acceptance criteria.\n\n- [ ] Check keyboard and pointer interaction', status: i % 2 ? 'todo' : 'inbox' })).id)
  const db = new Database(path.join(data, 'state.sqlite'))
  db.query("UPDATE task_items SET status='running' WHERE id=?").run(ids[0]!); db.close()
  for (let run = 1; run <= 2; run++) {
    app = await launch({ command: 'bun', args: [path.resolve('src/main.tsx')], env: { GPUIX_BACKGROUND: '1', KYBERN_DATA_DIR: data, KYBERN_APPEARANCE: 'dark', NAPI_RS_NATIVE_LIBRARY_PATH: process.env.NAPI_RS_NATIVE_LIBRARY_PATH! } })
    await app.getByTestId('app-ready').waitFor({ timeoutMs: 30000 })
    const { pid } = await app.call('initialize', { protocolVersion: 1, client: 'tasks-performance' })
    await app.getByTestId('rail-tasks').click()
    await app.getByTestId(`task-filter-project:${project.id}`).waitFor()
    await app.getByTestId(`task-filter-project:${project.id}`).click()
    if (await app.getByTestId('task-back').count()) await app.getByTestId('task-back').click()
    if (await app.getByTestId('task-board').count()) await app.getByTestId('task-view-list').click()
    await app.getByTestId(`task-row-${ids[0]}`).waitFor()
    async function sample(scene: string) {
      await Bun.sleep(10000)
      console.log(`RUN ${run} ${scene}`)
      const child = Bun.spawn(['bun', 'perf/sample.ts', '15', `Tasks=${pid}`], { stdout: 'pipe', stderr: 'pipe' })
      console.log(await new Response(child.stdout).text())
      if (await child.exited) throw Error(await new Response(child.stderr).text())
    }
    await sample('eight tasks, one running glyph')
    await app.getByTestId(`task-row-${ids[1]}`).click()
    await app.getByTestId('task-edit').waitFor(); await app.getByTestId('task-edit').click()
    await app.getByTestId('task-edit-body').waitFor()
    await sample('description editor and formatting controls')
    await app.close(); app = undefined
  }
} finally {
  await app?.close()
  for (const id of ids) await client.call('tasks.items.delete', { id }).catch(() => {})
  client.close()
}
