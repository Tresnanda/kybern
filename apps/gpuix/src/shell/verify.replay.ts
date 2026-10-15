/** Actual installed scratch daemon, no turn: rename events across hydration and reconnect. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import { connect, getClient, getState, onOpenEvent, resetClient, selectThread } from '../state.ts'
const data = process.env.KYBERN_DATA_DIR!, id = process.env.KYBERN_GPUIX_THREAD!
if (!data?.includes('gpuix-scratch-shell-') || !id) throw Error('Use the shell scratch fixture')
delete process.env.KYBERN_GPUIX_THREAD
const wait = async (ready: () => boolean) => { const end = Date.now() + 15000; while (!ready()) { if (Date.now() > end) throw Error('Timed out'); await Bun.sleep(20) } }
const control = new KybernClient({ url: `ws://127.0.0.1:${readFileSync(path.join(data, 'daemon.port'), 'utf8').trim()}/ws`, token: readFileSync(path.join(data, 'daemon.token'), 'utf8').trim() })
control.connect(); connect()
const client = getClient()!
const seen: number[] = []
const stop = onOpenEvent((event) => { if (event.kind === 'thread_updated') seen.push(event.seq) })
try {
  await wait(() => client.status === 'open' && control.status === 'open')
  const original = client.call.bind(client)
  let gotSnapshot = false, release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  client.call = (async (method: string, params: unknown) => {
    const result = await original(method as never, params as never)
    if (method === 'threads.get') { gotSnapshot = true; await gate }
    return result
  }) as typeof client.call
  const hydration = selectThread(id)
  await wait(() => gotSnapshot)
  await control.call('threads.update', { thread_id: id, title: 'During hydration' })
  release(); await hydration
  client.call = original
  await wait(() => getState().open.thread?.title === 'During hydration')
  // Test-only transport interruption, preserving the client's subscription cursor.
  const socket = (client as unknown as { ws: WebSocket | null }).ws
  assert.ok(socket)
  socket.close()
  await wait(() => client.status !== 'open')
  await control.call('threads.update', { thread_id: id, title: 'During reconnect' })
  await wait(() => client.status === 'open' && getState().open.thread?.title === 'During reconnect')
  assert.equal(seen.length, 2)
  assert.equal(new Set(seen).size, 2)
  console.log('PASS hydration gap replay, reconnect replay, exactly one delivery per update')
} finally { stop(); resetClient(); control.close() }
