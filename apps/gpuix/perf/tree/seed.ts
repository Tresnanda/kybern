/** Tree-connector workload (lane tree): the shared bench dataset (perf/bench/seed.ts) plus one parent thread
 * with delegated and subagent children two levels deep, and a long settled turn whose "Worked for" disclosure
 * holds tool groups, nested child calls and interleaved prose. Records come from RPC; child metadata and
 * provider events are synthetic SQLite rows (no import RPC), applied before a daemon restart. No agent runs. */
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { seed } from '../bench/seed.ts'

export const DATA = '/Users/mymac/projects/ade-gpuix-scratch/tree'
// 4374 (the lane's assigned port) was already held by another lane's daemon.
export const PORT = 4384
export type TreeManifest = { parent: string; children: Record<string, string>; project: string }

export const uuid = (key: string) => { const h = createHash('sha256').update(`tree-v1:${key}`).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}` }
const at = (minute: number, second = 0) => new Date(Date.UTC(2026, 9, 20, 9, minute, second)).toISOString()

/** The children: key, title, parent key (null: the parent thread), kind, status. */
const CHILDREN = [
  ['explore', 'Explore the sidebar rows', null, 'subagent', 'completed'],
  ['dock', 'Audit the dock Agents tree and its lineage rows', null, 'delegation', 'completed'],
  ['dock-read', 'Read Agents.tsx', 'dock', 'subagent', 'completed'],
  ['dock-rules', 'Check the shared lineage rules for hidden subagents', 'dock', 'delegation', 'failed'],
  ['test', 'Write the geometry test for stems, ticks and the last elbow', null, 'delegation', 'completed'],
] as const

/** One long settled turn: two command groups, a call with nested child calls, prose between them. */
function workTurn(turn: string): Record<string, unknown>[] {
  const tool = (id: string, name: string, input: Record<string, unknown>, output: string, parent?: string) => [
    { kind: 'tool_call_started', call: { id, name, input, ...(parent ? { parent_id: parent } : {}) }, origin: { kind: 'root' } },
    { kind: 'tool_call_completed', tool_call_id: id, output: { text: output }, is_error: false },
  ]
  const say = (key: string, text: string) => ({ kind: 'assistant_message_completed', message_id: uuid(`${turn}:${key}`), origin: { kind: 'root' }, text, thinking: null })
  const id = (key: string) => uuid(`${turn}:${key}`)
  return [
    { kind: 'turn_started', message_id: id('user'), message: { parts: [{ type: 'text', text: 'Replace the segmented rail with tree connectors in the sidebar, the transcript and the dock.' }] } },
    ...tool(id('c1'), 'Bash', { command: 'rg -n "Guides" apps/gpuix/src/sidebar' }, 'apps/gpuix/src/sidebar/rows.tsx:218:function Guides'),
    ...tool(id('c2'), 'Bash', { command: 'pnpm typecheck && bun test ./src' }, '312 pass, 0 fail'),
    say('p1', 'The rail is drawn per row with padding gaps between the segments. I will move it into one primitive and check the transcript groups next, including the nested activity under a batch call so the stems continue through every level.'),
    ...tool(id('batch'), 'mcp__kybern__batch', { title: 'Inspect the tree surfaces' }, 'Three reads finished.'),
    ...tool(id('b1'), 'Read', { file_path: 'apps/gpuix/src/transcript/rows.tsx' }, 'export const WorkRows = memo(…)', id('batch')),
    ...tool(id('b2'), 'Read', { file_path: 'apps/gpuix/src/transcript/Turn.tsx' }, 'export const Turn = memo(…)', id('batch')),
    ...tool(id('b3'), 'Bash', { command: 'rg -n "marginLeft: 22" apps/gpuix/src/transcript' }, 'rows.tsx:298', id('batch')),
    ...tool(id('r1'), 'Read', { file_path: 'apps/gpuix/src/dock/Agents.tsx' }, 'const AgentRow = memo(…)'),
    ...tool(id('e1'), 'Edit', { file_path: 'apps/gpuix/src/sidebar/rows.tsx', old_string: 'Guides', new_string: 'TreeLines' }, '@@ -1 +1 @@'),
    ...tool(id('c3'), 'Bash', { command: 'bun test ./src/tree' }, '6 pass'),
    ...tool(id('c4'), 'Bash', { command: 'pnpm typecheck' }, 'ok'),
    ...tool(id('c5'), 'Bash', { command: 'git diff --stat' }, '4 files changed'),
    say('p2', 'Done.'),
    ...tool(id('e2'), 'Edit', { file_path: 'apps/gpuix/src/transcript/rows.tsx', old_string: 'marginLeft: 22', new_string: 'TreeGroup' }, '@@ -1 +1 @@'),
    say('answer', 'The connectors are in place: one stem per group, a tick per row and a rounded elbow on the last one.'),
    { kind: 'turn_completed', stop_reason: 'completed', usage: { input_tokens: 1000, output_tokens: 500, cache_read_tokens: 0, cache_write_tokens: 0 }, cost_usd: null, duration_ms: 75_000, terminal_message_id: id('answer') },
  ]
}

export async function seedTree(data = DATA, port = PORT) {
  const fixture = await seed(data, port)
  const file = path.join(data, 'tree-manifest.json')
  if (existsSync(file)) return { ...fixture, tree: JSON.parse(readFileSync(file, 'utf8')) as TreeManifest }
  const project = fixture.manifest.projects[0]!
  const make = async (title: string) => (await fixture.client.call('threads.create', { project_id: project, title, provider: { kind: 'claude-code', instance: 'default' }, model: 'claude-haiku-5-5' })).id as string
  const parent = await make('Tree parent · Replace the sidebar rail')
  const children: Record<string, string> = {}
  for (const [key, title] of CHILDREN) children[key] = await make(title)
  const db = new Database(path.join(data, 'state.sqlite'))
  try {
    db.transaction(() => {
      const insert = db.query('INSERT INTO events(thread_id,turn_id,at,kind,payload) VALUES (?,?,?,?,?)')
      for (let n = 0; n < 3; n++) {
        const turn = uuid(`turn:${n}`)
        for (const [i, event] of workTurn(turn).entries()) insert.run(parent, turn, at(n * 3, i), String(event.kind), JSON.stringify(event))
      }
      for (const [index, [key, title, parentKey, kind, status]] of CHILDREN.entries()) {
        const parentId = parentKey ? children[parentKey]! : parent
        const started = at(10, index), done = at(12, index)
        const info = kind === 'subagent'
          ? { task_id: uuid(`task:${key}`), root_thread_id: parentId, parent_turn_id: uuid('turn:0'), agent_type: 'Explore', status, result: `${title}: finished.`, started_at: started, completed_at: done }
          : { task_id: uuid(`task:${key}`), operation_id: uuid(`op:${key}`), parent_thread_id: parentId, depth: parentKey ? 2 : 1, role: 'review', workspace: 'shared', status, result: status === 'failed' ? null : `${title}: done.`, error: status === 'failed' ? 'The lineage rules changed while it ran.' : null, files_touched: ['apps/gpuix/src/tree/Tree.tsx'], started_at: started, completed_at: done }
        db.query(`UPDATE threads SET parent_thread_id=?, ${kind}=?, status=?, updated_at=? WHERE id=?`).run(parentId, JSON.stringify(info), status === 'failed' ? 'failed' : 'idle', done, children[key]!)
        const turn = uuid(`child-turn:${key}`)
        insert.run(children[key]!, turn, started, 'turn_started', JSON.stringify({ kind: 'turn_started', message_id: uuid(`child-user:${key}`), message: { parts: [{ type: 'text', text: title }] } }))
        insert.run(children[key]!, turn, done, 'assistant_message_completed', JSON.stringify({ kind: 'assistant_message_completed', message_id: uuid(`child-answer:${key}`), origin: { kind: 'root' }, text: `${title}: done.`, thinking: null }))
        insert.run(children[key]!, turn, done, 'turn_completed', JSON.stringify({ kind: 'turn_completed', stop_reason: 'completed', usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 0 }, cost_usd: null, duration_ms: 1000, terminal_message_id: null }))
      }
      for (const id of [parent, ...Object.values(children)]) db.query('UPDATE threads SET last_seq=(SELECT MAX(seq) FROM events WHERE thread_id=?) WHERE id=?').run(id, id)
      db.query('UPDATE threads SET updated_at=? WHERE id=?').run('2026-10-20T10:00:00Z', parent)
    })()
  } finally { db.close() }
  await fixture.restart()
  const tree: TreeManifest = { parent, children, project }
  writeFileSync(file, JSON.stringify(tree, null, 2))
  return { ...fixture, tree }
}

if (import.meta.main) { const f = await seedTree(); console.log(JSON.stringify(f.tree, null, 2)); await f.close() }
