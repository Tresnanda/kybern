/**
 * The live-event path without the UI: a bare Bun process with the app's
 * KybernClient subscribed to one thread while the scratch daemon's replay
 * binary streams passes into it (see live.ts). `fold` also folds each event
 * into a ThreadState as the app does. Prints the process footprint and its
 * `App-Specific Tag 1` (Bun's allocator and JSC) after each pass.
 *
 *   KYBERN_DATA_DIR=<scratch daemon with the replay binary> bun perf/memlog/socket.ts <raw|fold> <thread> [passes]
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import { applyEvent, emptyThreadState } from '../../../../packages/kybern-client/src/transcript.ts'

const [mode = 'raw', thread, passes = '3'] = process.argv.slice(2)
assert(thread, 'Name the thread')
const data = process.env.KYBERN_DATA_DIR!
assert(data?.includes('scratch'), 'Explicit scratch data directory required')
const cli = process.env.KYBERN_CLI ?? '/Applications/Kybern GPUIX.app/Contents/MacOS/kybern'
const port = readFileSync(path.join(data, 'daemon.port'), 'utf8').trim()
const token = readFileSync(path.join(data, 'daemon.token'), 'utf8').trim()
const client = new KybernClient({ url: `ws://127.0.0.1:${port}/ws`, token }, { createSocket: (url, key) => new WebSocket(url, { headers: { origin: 'tauri://localhost', Authorization: `Bearer ${key}` } } as unknown as string[]) })
const ready = new Promise<void>(resolve => client.onStatus(s => { if (s === 'open') resolve() }))
client.connect(); await ready

let events = 0, open = emptyThreadState()
const { thread: info } = await client.call('threads.get', { thread_id: thread, transcript_limit: 1, include_tool_output: false })
client.subscribeEvents({ thread_id: thread, after_seq: info.last_seq, include_tool_output: false }, event => {
  events++
  if (mode === 'fold') open = applyEvent(open, event as never)
})
const run = (args: string[]) => new Promise<void>(resolve => spawn(cli, ['--data-dir', data, ...args], { env: { HOME: path.join(data, 'home'), PATH: '/usr/bin:/bin' }, stdio: 'ignore' }).on('exit', () => resolve()))
const sample = (name: string) => {
  Bun.gc(true)
  const text = execFileSync('footprint', ['-p', String(process.pid)], { encoding: 'utf8' })
  const tag = /^\s*([\d.]+) (KB|MB|GB)\s+.*App-Specific Tag 1$/m.exec(text)
  console.log(JSON.stringify({ name, events, footprint: /Footprint: ([\d.]+ \w+)/.exec(text)?.[1], tag1: tag ? `${tag[1]} ${tag[2]}` : null, heapMB: Math.round(process.memoryUsage().heapUsed / 1048576), blocks: open.blocks.length }))
}
sample('start')
for (let pass = 1; pass <= Number(passes); pass++) {
  const before = events
  await run(['send', '--detach', thread, 'PROFILE_REPLAY'])
  // Done when events stop for 15 s.
  let last = -1
  while (events !== last || events === before) { last = events; await Bun.sleep(15000) }
  sample(`pass-${pass}`)
}
client.close?.()
process.exit(0)
