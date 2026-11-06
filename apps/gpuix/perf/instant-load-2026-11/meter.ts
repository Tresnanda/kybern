/** A metered daemon connection for the headless bench: GPUIX's own socket factory and `KybernClient`, with every
 * received frame counted and every call timed. Optionally through `linkProxy` (added round-trip time / bandwidth). */
import { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import { createGpuixSocket } from '../../src/machines/socket.ts'

export interface CallRecord { method: string; start: number; end: number }
export class Meter {
  received = 0
  frames = 0
  calls: CallRecord[] = []
  /** [arrival time, bytes received so far], one per frame. */
  arrivals: [number, number][] = []
  receive(size: number) { this.frames++; this.received += size; this.arrivals.push([performance.now(), this.received]) }
  /** Bytes received by `at`. */
  receivedBy(at: number) {
    for (let i = this.arrivals.length - 1; i >= 0; i--) if (this.arrivals[i]![0] <= at) return this.arrivals[i]![1]
    return 0
  }
  mark() { return { at: performance.now(), received: this.received, frames: this.frames, calls: this.calls.length } }
  /** Calls between two marks and their dependency depth (a call that started after another ended is one level deeper). */
  span(from: ReturnType<Meter['mark']>, until = performance.now()) {
    const calls = this.calls.slice(from.calls).filter(c => c.start <= until)
    const depth = new Map<CallRecord, number>()
    for (const call of calls) depth.set(call, 1 + Math.max(0, ...calls.filter(o => o !== call && o.end <= call.start).map(o => depth.get(o) ?? 1)))
    return { ms: until - from.at, bytes: Math.max(0, this.receivedBy(until) - from.received), calls: calls.map(c => c.method), roundTrips: Math.max(0, ...depth.values()) }
  }
}

export async function meteredClient(url: string, token: string): Promise<{ client: KybernClient; meter: Meter; connectMs: number }> {
  const meter = new Meter()
  const started = performance.now()
  const client = new KybernClient({ url, token }, {
    createSocket: (u, t) => {
      const socket = createGpuixSocket(u, t)
      socket.addEventListener('message', (event: MessageEvent) => meter.receive(typeof event.data === 'string' ? event.data.length : (event.data as ArrayBuffer).byteLength))
      return socket
    },
  })
  const call = client.call.bind(client)
  client.call = ((method: string, params: unknown) => {
    const record: CallRecord = { method, start: performance.now(), end: Infinity }
    meter.calls.push(record)
    const done = () => { record.end = performance.now() }
    const pending = (call as (m: string, p: unknown) => Promise<unknown>)(method, params)
    pending.then(done, done)
    return pending
  }) as typeof client.call
  client.connect()
  const deadline = Date.now() + 30_000
  while (client.status !== 'open') {
    if (Date.now() > deadline || client.status === 'failed') throw Error(`Bench connection failed: ${client.status}`)
    await Bun.sleep(2)
  }
  return { client, meter, connectMs: performance.now() - started }
}

/**
 * A WebSocket relay that delays every frame by half the round-trip time each way and, with `mbps`, serializes frames
 * over a link of that bandwidth. A stand-in for a remote machine; it is not the real relay route (see README).
 */
export function linkProxy(listenPort: number, target: string, rttMs: number, mbps = 0) {
  // One FIFO per direction drained by a single timer: separate timers with fractional delays can fire out of order,
  // and a reordered `events.ready` before its `events.subscribe` answer is dropped by the client (a hung bench).
  type Link = { busy: number; queue: { at: number; send: () => void }[]; timer?: ReturnType<typeof setTimeout> }
  const pump = (link: Link) => {
    link.timer = undefined
    const now = performance.now()
    while (link.queue.length && link.queue[0]!.at <= now) link.queue.shift()!.send()
    if (link.queue.length) link.timer = setTimeout(() => pump(link), Math.max(0, link.queue[0]!.at - now))
  }
  const deliver = (link: Link, size: number, send: () => void) => {
    const now = performance.now()
    const tx = mbps > 0 ? (size * 8) / (mbps * 1e6) * 1000 : 0
    link.busy = Math.max(now, link.busy) + tx
    link.queue.push({ at: link.busy + rttMs / 2, send })
    if (!link.timer) link.timer = setTimeout(() => pump(link), Math.max(0, link.queue[0]!.at - now))
  }
  const server = Bun.serve<{ auth: string; upstream?: WebSocket; queue: (string | ArrayBuffer)[]; up: Link; down: Link }, never>({
    port: listenPort,
    hostname: '127.0.0.1',
    fetch(req, srv) {
      if (srv.upgrade(req, { data: { auth: req.headers.get('authorization') ?? '', queue: [], up: { busy: 0, queue: [] }, down: { busy: 0, queue: [] } } })) return undefined
      return new Response('upgrade required', { status: 426 })
    },
    websocket: {
      open(ws) {
        const upstream = new WebSocket(target, { headers: { origin: 'tauri://localhost', Authorization: ws.data.auth } } as unknown as string[])
        ws.data.upstream = upstream
        upstream.onopen = () => { for (const m of ws.data.queue) upstream.send(m); ws.data.queue = [] }
        upstream.onmessage = (event) => { const data = event.data as string; deliver(ws.data.down, data.length, () => ws.send(data)) }
        upstream.onclose = () => ws.close()
      },
      message(ws, message) {
        const data = message as string
        deliver(ws.data.up, data.length, () => {
          const upstream = ws.data.upstream!
          if (upstream.readyState === WebSocket.OPEN) upstream.send(data); else ws.data.queue.push(data)
        })
      },
      close(ws) { ws.data.upstream?.close() },
    },
  })
  return { url: `ws://127.0.0.1:${listenPort}/ws`, stop: () => server.stop(true) }
}

export const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)]! : NaN }
export const p95 = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]! : NaN }
