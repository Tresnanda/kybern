/** Diagnostic run, excluded from resource/startup timings. */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import { assertScratchEnv } from '../../src/requests/harness.ts'
const out = process.argv[2]!, data = process.env.KYBERN_DATA_DIR!
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
  const sample = Bun.spawn(['sample', process.env.KYBERN_STARTUP_DAEMON_PID!, '4', '1', '-file', out.replace(/\.json$/, '.sample.txt')], { stdout: 'ignore', stderr: 'ignore' })
  const start = performance.now(), requests: number[] = []
  while (performance.now() - start < 5000) { const sent = performance.now(); await client.call('threads.list', {}); requests.push(performance.now() - sent) }
  await sample.exited
  const projects: number[] = []
  for (let i = 0; i < 5; i++) { const sent = performance.now(); await client.call('projects.list', {}); projects.push(performance.now() - sent) }
  const markersAfter = buildMarkers()
  if (markersBefore.length || markersDuring.size || markersAfter.length) { console.error('Discarding daemon run overlapped by native build'); continue }
  writeFileSync(out, JSON.stringify({ fullRate: 'not applicable (daemon only)', requests, projects, footprint: execFileSync('footprint', ['-p', process.env.KYBERN_STARTUP_DAEMON_PID!], { encoding: 'utf8' }) }, null, 2))
  break
  } finally { clearInterval(watcher) }
  }
} finally { client.close() }
