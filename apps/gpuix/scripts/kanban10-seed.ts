/** Seed (or reset) a scratch daemon with tall and short task cards for the drag-gap check (kanban10-ghost*.ts). Scratch only. */
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { connect } from '../visual/fixture.ts'

const data = process.env.KYBERN_DATA_DIR!
if (!data?.includes('gpuix-scratch')) throw new Error('Set KYBERN_DATA_DIR to a gpuix-scratch daemon dir')
const client = await connect({ daemonPid: 0, port: Number(readFileSync(path.join(data, 'daemon.port'), 'utf8').trim()), token: readFileSync(path.join(data, 'daemon.token'), 'utf8').trim(), seeded: true })
const LONG = 'with a much longer title that wraps over several lines on the board, so this card is clearly taller than its neighbours'
export const SEED: [string, 'inbox' | 'todo'][] = [
  ['Gap short A', 'inbox'],
  [`Gap tall B ${LONG}`, 'inbox'],
  ['Gap short C', 'inbox'],
  [`Gap tall D ${LONG}`, 'inbox'],
  ['Gap short E', 'inbox'],
  ['Gap short F', 'todo'],
  [`Gap tall G ${LONG}`, 'todo'],
  ['Gap short H', 'todo'],
]
// GPUIX shows its first-run screen until a project exists.
if (!(await client.call('projects.list', {})).projects.length) {
  const dir = path.resolve(data, '../gap-project')
  mkdirSync(dir, { recursive: true })
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main'], { cwd: dir })
  await client.call('projects.add', { path: dir, name: 'gap-project' })
}
const existing = (await client.call('tasks.items.list', {})).tasks
for (const [title, status] of SEED) if (!existing.some((t) => t.title === title)) await client.call('tasks.items.create', { scope: 'global', title, body: '', status, priority: 0 })
// Reset: each task back to its seed column, appended in seed order, so every drag starts from the same board.
const tasks = (await client.call('tasks.items.list', {})).tasks
for (const [title, status] of SEED) await client.call('tasks.items.update', { id: tasks.find((t) => t.title === title)!.id, status, before_id: null })
console.log('seeded', SEED.length)
client.close?.()
process.exit(0)
