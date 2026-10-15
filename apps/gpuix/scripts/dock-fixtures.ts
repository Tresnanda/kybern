// Disposable large-file fixtures, only in the designated scratch project.
import { connect, getClient, getState } from '../src/state.ts'
import { until } from './dock-waits.ts'
if (process.env.KYBERN_DATA_DIR !== '/Users/mymac/projects/ade-gpuix-scratch/data') throw new Error('Use the designated scratch daemon')
const project = '01a13e25-5696-7933-b9d1-c1aae8fb876d'
const thread = '01a13e34-40eb-7682-81b0-7cb58da9cc63'
connect()
await until(async () => getState().status === 'open', 'scratch connection')
const client = getClient()!
const remove = process.argv.includes('--remove')
const code = remove
  ? "from pathlib import Path; [Path(name).unlink(missing_ok=True) for name in ['dock-large.ts', 'dock-large-second.ts']]"
  : "from pathlib import Path; [Path(name).write_text(''.join('export const ' + prefix + str(i) + ' = { value: ' + str(i) + ', name: \"fixture\" };\\n' for i in range(10000))) for name, prefix in [('dock-large.ts', 'dockValue'), ('dock-large-second.ts', 'secondValue')]]"
const terminal = await client.call('terminals.create', { thread_id: thread, command: ['python3', '-c', code], cols: 80, rows: 24 })
await until(async () => { const result = await client.call('terminals.list', { thread_id: thread }); return result.terminals.some((t) => t.id === terminal.id && !t.alive) }, 'fixture process exit')
await client.call('terminals.close', { terminal_id: terminal.id })
if (!remove) {
  for (const path of ['dock-large.ts', 'dock-large-second.ts']) {
    const file = await client.call('files.read', { project_id: project, path, max_bytes: 128 })
    if (file.size < 500_000) throw new Error('Fixture too small')
    console.log(path, file.size)
  }
}
if (remove) {
  const result = await client.call('files.list', { project_id: project, path: '' })
  if (result.entries.some((e) => ['dock-large.ts', 'dock-large-second.ts'].includes(e.name))) throw new Error('Large fixtures still present')
  console.log('Removed both large fixtures')
}
process.exit(0)
