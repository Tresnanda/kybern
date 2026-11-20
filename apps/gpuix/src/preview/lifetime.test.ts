import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { PortForward } from '../../../../packages/kybern-client/src/types.ts'
import { FORWARD_KEEP_MS, forwardInUse, loopbackPort, previewUse, watchPreviewLifetime, type UseSource } from './lifetime.ts'

const forward = (id: string, patch: Partial<PortForward> = {}): PortForward => ({ id, machine_id: 'instabox', machine_name: 'instabox', remote_port: 3000, local_port: 3000, connections: 0, created_at: '2026-11-03T10:00:00Z', origin: 'preview', ...patch })
const shown = (port = 3000): UseSource => ({ entries: [{ address: `http://localhost:${port}`, url: `http://localhost:${port}`, machine: { id: 'instabox', port: 3000 } }] })

/** A browser per thread, its tab, the daemon's forwards, and a clock the test moves. `kept` lists each `ports.keep` call. */
function world(forwards: PortForward[], options: { failKeep?: boolean } = {}) {
  let now = 0
  const timers = new Map<number, { at: number; run: () => void }>()
  let serial = 0
  const browsers = new Map<string, UseSource>(), tabs = new Set<string>(), listeners = new Set<() => void>()
  const kept: string[][] = [], disposed: string[] = []
  const changed = () => { for (const listener of listeners) listener() }
  const stopWatching = watchPreviewLifetime({
    threads: () => [...browsers.keys()],
    open: id => tabs.has(id),
    dispose: id => { disposed.push(id); browsers.delete(id) },
    uses: () => [...browsers.values()].map(previewUse),
    forwards: () => forwards,
    keep: async ids => { kept.push(ids); if (options.failKeep) throw new Error('Method not found') },
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    setTimer: (run, ms) => { timers.set(++serial, { at: now + ms, run }); return serial },
    clearTimer: id => { timers.delete(id as number) },
  })
  /** Run every timer due within `ms`, in order. */
  const advance = (ms: number) => {
    const end = now + ms
    for (;;) {
      const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      timers.delete(next[0]); now = Math.max(now, next[1].at); next[1].run()
    }
    now = end
  }
  return {
    open(id: string, source: UseSource = shown()) { tabs.add(id); browsers.set(id, source); changed() },
    close(id: string) { tabs.delete(id); changed() },
    setForwards(next: PortForward[]) { forwards = next; changed() },
    advance, kept, disposed, browsers, stopWatching, timers,
  }
}

test('a shown preview forward is renewed at once, then every 10 s, and no longer once its last tab closes', () => {
  const w = world([forward('f1')])
  w.open('thread-a'); w.advance(0)
  expect(w.kept).toEqual([['f1']])
  w.advance(FORWARD_KEEP_MS - 1)
  expect(w.kept).toEqual([['f1']])
  w.advance(1)
  expect(w.kept).toEqual([['f1'], ['f1']])
  w.advance(FORWARD_KEEP_MS * 2)
  expect(w.kept.length).toBe(4)
  w.close('thread-a'); w.advance(0)
  expect(w.disposed).toEqual(['thread-a'])
  w.advance(FORWARD_KEEP_MS * 3)
  expect(w.kept.length).toBe(4)
  // The app never stops a preview forward itself: the daemon's lease ends it.
  expect(w.timers.size).toBe(0)
})

test('one renewal covers every shown forward, and a forward shown later is renewed when it appears', () => {
  const w = world([forward('f1'), forward('f2', { remote_port: 5173, local_port: 5173 })])
  w.open('thread-a'); w.advance(0)
  expect(w.kept).toEqual([['f1']])
  w.advance(4000)
  w.open('thread-b', shown(5173)); w.advance(0)
  expect(w.kept).toEqual([['f1'], ['f2']])
  w.advance(FORWARD_KEEP_MS - 4000)
  expect(w.kept.at(-1)).toEqual(['f1', 'f2'])
})

test('a forward is renewed while another thread still shows it', () => {
  const w = world([forward('f1')])
  w.open('thread-a'); w.open('thread-b'); w.advance(0)
  w.close('thread-a'); w.advance(FORWARD_KEEP_MS)
  expect(w.kept.at(-1)).toEqual(['f1'])
  const before = w.kept.length
  w.close('thread-b'); w.advance(FORWARD_KEEP_MS * 2)
  expect(w.kept.length).toBe(before)
})

test('a browser that is opening the server already keeps its forward', () => {
  const w = world([forward('f1')])
  w.open('thread-a', { entries: [], attemptedMachine: { id: 'instabox', port: 3000 } }); w.advance(0)
  expect(w.kept).toEqual([['f1']])
})

test('a tab moved between groups in one update never reads as closed', () => {
  const w = world([forward('f1')])
  w.open('thread-a'); w.advance(0)
  // Taken out of one group and put in another before the next tick.
  w.close('thread-a'); w.open('thread-a', w.browsers.get('thread-a')); w.advance(FORWARD_KEEP_MS)
  expect(w.disposed).toEqual([])
  expect(w.kept).toEqual([['f1'], ['f1']])
})

test("manual forwards and an older daemon's forwards (no origin) are never renewed", () => {
  const w = world([forward('f1', { origin: undefined }), forward('f2', { origin: 'manual' })])
  w.open('thread-a'); w.advance(FORWARD_KEEP_MS * 3)
  expect(w.kept).toEqual([])
  // A preview forward made manual while its tab is open stops being renewed.
  const made = world([forward('f3')])
  made.open('thread-a'); made.advance(0)
  made.setForwards([forward('f3', { origin: undefined })]); made.advance(FORWARD_KEEP_MS * 3)
  expect(made.kept).toEqual([['f3']])
})

test('a daemon without ports.keep is asked again on the next renewal and nothing breaks', () => {
  const w = world([forward('f1')], { failKeep: true })
  w.open('thread-a'); w.advance(FORWARD_KEEP_MS)
  expect(w.kept).toEqual([['f1'], ['f1']])
})

test('the agent opens a forward by its local address, and Fast mode loads its HTTPS port', () => {
  const agent = forward('f1', { local_port: 41000 })
  expect(forwardInUse(agent, [previewUse({ entries: [{ address: 'http://localhost:41000/app', url: 'http://localhost:41000/app' }] })])).toBe(true)
  const fast = forward('f2', { local_port: 41001, https_port: 41002 })
  expect(forwardInUse(fast, [previewUse({ entries: [{ address: 'http://localhost:9', url: 'https://localhost:41002/' }] })])).toBe(true)
  expect(forwardInUse(fast, [previewUse({ entries: [{ address: 'https://example.com', url: 'https://example.com' }] })])).toBe(false)
  expect(loopbackPort('http://127.0.0.1:41000')).toBe(41000)
  expect(loopbackPort('/Users/me/index.html')).toBeNull()
  const w = world([agent])
  w.open('thread-a', { entries: [{ address: 'http://localhost:41000/app', url: 'http://localhost:41000/app' }] }); w.advance(0)
  expect(w.kept).toEqual([['f1']])
})

test('stopping the watcher stops the renewals', () => {
  const w = world([forward('f1')])
  w.open('thread-a'); w.advance(0)
  w.stopWatching(); w.advance(FORWARD_KEEP_MS * 2)
  expect(w.kept).toEqual([['f1']])
  expect(w.timers.size).toBe(0)
})

test('a closed browser tab leaves nothing for the next one: page, history, relay, ticket and Fast choice', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gpuix-scratch-preview-lifetime-'))
  try {
    const child = Bun.spawn(['bun', path.join(import.meta.dir, 'lifetime.verify.ts')], { env: { ...process.env, KYBERN_DATA_DIR: dir, KYBERN_CLIENT_CONFIG_DIR: path.join(dir, 'config') }, stdout: 'pipe', stderr: 'pipe' })
    const output = await new Response(child.stderr).text()
    expect(await child.exited, output).toBe(0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
