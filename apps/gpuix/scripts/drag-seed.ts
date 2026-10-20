/** Seed the drag scratch daemon: 5 projects x 3 title-only threads, and tasks across statuses. Scratch only. */
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { connect } from '../visual/fixture.ts'

const data = process.env.KYBERN_DATA_DIR!
if (!data?.includes('gpuix-scratch')) throw new Error('Set KYBERN_DATA_DIR to a gpuix-scratch daemon dir')
const state = { daemonPid: 0, port: Number(readFileSync(path.join(data, 'daemon.port'), 'utf8').trim()), token: readFileSync(path.join(data, 'daemon.token'), 'utf8').trim(), seeded: true }
const client = await connect(state)
const root = path.resolve(data, '../drag-proj')
const names = ['alpha-app', 'beta-docs', 'gamma-cli', 'delta-api', 'epsilon-web']
const projects = []
for (const n of names) {
  const dir = path.join(root, n)
  mkdirSync(dir, { recursive: true })
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main'], { cwd: dir })
  projects.push(await client.call('projects.add', { path: dir, name: n }))
}
for (const [pi, p] of projects.entries()) for (let i = 1; i <= 3; i++) await client.call('threads.create', { project_id: p.id, provider: { kind: 'codex', instance: 'default' }, title: `${names[pi]} thread ${i}` })
const S = ['inbox', 'todo', 'done', 'canceled'] as const
for (let i = 0; i < 24; i++) await client.call('tasks.items.create', { scope: 'project', project_id: projects[i % 2]!.id, title: `Drag task ${String(i + 1).padStart(2, '0')}`, body: '', status: S[i < 8 ? 0 : i < 16 ? 1 : i < 22 ? 2 : 3], priority: ((i % 4) + 1) as 1 })
console.log('seeded', projects.length, 'projects')
client.close?.()
process.exit(0)
