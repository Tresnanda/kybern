import { Database } from 'bun:sqlite'
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import { assertScratchEnv } from '../../src/requests/harness.ts'
const data = process.env.KYBERN_DATA_DIR!
assertScratchEnv({ KYBERN_DATA_DIR: data, KYBERN_URL: '' })
const client = new KybernClient({ url: 'ws://127.0.0.1:4324/ws', token: readFileSync(path.join(data, 'daemon.token'), 'utf8').trim() })
client.connect()
try {
  while (client.status !== 'open') await Bun.sleep(10)
  const buildMarkers = () => readdirSync('/tmp').filter(name => name.startsWith('kybern-gpuix-native-build.'))
  for (;;) {
  while (buildMarkers().length) await Bun.sleep(1000)
  const markersBefore = buildMarkers(), markersDuring = new Set<string>()
  const watcher = setInterval(() => { for (const marker of buildMarkers()) markersDuring.add(marker) }, 50)
  try {
  const samples: unknown[] = []
  for (let i = 0; i < 5; i++) for (const [method, params] of [
    ['threads.list', {}],
    ['threads.get', { thread_id: process.env.KYBERN_STARTUP_THREAD!, transcript_limit: 120, include_tool_output: false }],
  ] as const) {
    const start = performance.now(), response = await client.call(method, params)
    samples.push({ method, ms: performance.now() - start, bytes: JSON.stringify(response).length })
  }
  const db = new Database(path.join(data, 'state.sqlite'), { readonly: true })
  const plan = db.query("EXPLAIN QUERY PLAN SELECT seq, thread_id, turn_id, at, payload FROM events WHERE thread_id = ?1 AND seq <= ?2 AND kind IN ('runtime_task_started', 'runtime_task_updated', 'runtime_task_completed', 'provider_session_bound') ORDER BY seq").all(process.env.KYBERN_STARTUP_THREAD!, Number.MAX_SAFE_INTEGER)
  db.close()
  const markersAfter = buildMarkers()
  if (markersBefore.length || markersDuring.size || markersAfter.length) { console.error('Discarding daemon run overlapped by native build'); continue }
  const result = { fullRate: process.env.KYBERN_FULL_RATE ?? 'default (0)', samples, plan }
  console.log(JSON.stringify(result, null, 2))
  if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(result, null, 2))
  break
  } finally { clearInterval(watcher) }
  }
} finally { client.close() }
