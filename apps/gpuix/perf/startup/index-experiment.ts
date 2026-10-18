import { Database } from 'bun:sqlite'
import path from 'node:path'
import { assertScratchEnv } from '../../src/requests/harness.ts'
assertScratchEnv({ KYBERN_DATA_DIR: process.env.KYBERN_DATA_DIR, KYBERN_URL: '' })
const out = process.argv[2]!
for (const phase of ['before', 'after']) {
  if (phase === 'after') {
    const db = new Database(path.join(process.env.KYBERN_DATA_DIR!, 'state.sqlite'))
    db.exec("CREATE INDEX events_runtime_tasks ON events(thread_id, seq) WHERE kind IN ('runtime_task_started', 'runtime_task_updated', 'runtime_task_completed', 'provider_session_bound')")
    db.close()
  }
  const child = Bun.spawn(['bun', 'perf/startup/rpc.ts', path.join(out, `${phase}-index-rpc.json`)], { stdout: 'inherit', stderr: 'inherit' })
  if (await child.exited) throw Error(`${phase} RPC measurement failed`)
}
