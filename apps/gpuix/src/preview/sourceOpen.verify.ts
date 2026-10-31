import assert from 'node:assert/strict'
import { mock } from 'bun:test'
if (!process.env.KYBERN_DATA_DIR?.includes('gpuix-scratch')) throw Error('Scratch data required')
const environment = { id: 'local', local: true, name: 'Primary', dataDir: process.env.KYBERN_DATA_DIR! }
mock.module('../shell/environment.ts', () => ({ activeEnvironment: () => environment, environmentKey: () => environment.id, useEnvironment: () => environment, environmentEndpoint: async () => null }))
const forwards: string[] = [], opens: any[] = [], revoked: string[] = [], relays: string[] = []
let port = 41000, serial = 0, probes = 0, offline = false, unsupported = false, delayed: (() => void) | undefined
const client = { info: { machine_id: 'primary', environment_id: 'primary', hostname: 'Primary' }, endpoint: { url: 'ws://127.0.0.1:9999/ws' }, call: async (method: string, p: any) => {
  if (method === 'ports.forward') {
    forwards.push(p.machine)
    if (offline) throw Error(`${p.machine} is offline`)
    if (p.machine === 'slow') await new Promise<void>(resolve => { delayed = resolve })
    return { local_port: ++port }
  }
  if (method === 'previews.probe') { probes++; return { reachable: true, title: 'Source app' } }
  if (method === 'previews.close') { revoked.push(p.ticket); return {} }
  if (method === 'previews.server.open' && unsupported) throw Object.assign(Error('Method not found'), { code: -32601 })
  if (method === 'previews.server.open' && p.proxy && new URL(p.url).protocol === 'https:') throw Object.assign(Error("HTTPS servers cannot be proxied yet. Use the server's HTTP port, or open its HTTPS address directly on that machine."), { code: -32602, data: { code: 'unsupported_proxy' } })
  if (method === 'previews.open') { assert.equal(p.thread_id, 'thread'); p = { url: p.target, proxy: p.proxy } }
  else assert.equal(method, 'previews.server.open')
  assert.equal(p.thread_id, undefined, 'a foreign thread id must never reach the serving daemon')
  opens.push(p)
  return { target: { kind: 'server', url: p.url, port: Number(new URL(p.url).port) }, ...(p.proxy ? { ticket: `t${++serial}`, path: `/preview-proxy/t${serial}/` } : {}) }
} }
const noop = () => {}
mock.module('../state.ts', () => ({ getClient: () => client, localClient: () => client, threadClient: () => client, projectClient: () => client, callThread: (_id: unknown, method: string, params: unknown) => client.call(method, params), ownProjectId: (t: any) => t.ownProjectId ?? t.project_id, getState: () => ({ threads: [{ id: 'thread', cwd: '/scratch' }], projects: [] }), DEFAULT_PANE: 'main', createPane: noop, closePaneState: noop, focusPane: noop, getFocusedPaneId: () => 'main', getPane: () => undefined, getPaneState: () => undefined, getThreadOpen: () => undefined, selectPaneThread: noop, selectThread: async () => {}, setPane: noop, setPaneAlias: noop, subscribe: () => noop }))

mock.module('./browser.ts', () => ({ launchBrowser: async () => {} }))
mock.module('./relay.ts', () => ({ openRelay: async (url: string) => { relays.push(url); return { url: 'http://127.0.0.1:49999/', close: () => {} } } }))
const { openRemoteServer, openPreview, previewState, closePreview, retryPreview } = await import('./store.ts')
const { recentsKeyForThread } = await import('./recents.ts')
const { load } = await import('../shell/persist.ts')
const { parseSourceRecents } = await import('./recentSources.ts')
const source = (id: string) => ({ id, name: id, port: 5173, path: '/app?q=1#hash' })
await openRemoteServer('foreign-thread', source('a'))
assert.equal(opens.at(-1).url, 'http://localhost:41001/app?q=1#hash')
assert.equal(probes, 0, 'forwarded pages must reach the web view without a preflight HTTP request')
assert.equal(previewState('foreign-thread').entries[0]?.machine?.id, 'a')
await openRemoteServer('foreign-thread', source('b'))
const key = recentsKeyForThread('foreign-thread')
const recents = parseSourceRecents(load<string | null>(key, null))
assert.deepEqual(recents.map(r => [r.machine?.id, r.machine?.port, r.machine?.path, r.value]), [
  ['b', 5173, '/app?q=1#hash', 'http://localhost:5173/app?q=1#hash'], ['a', 5173, '/app?q=1#hash', 'http://localhost:5173/app?q=1#hash'],
])
closePreview('foreign-thread')
await openRemoteServer('foreign-thread', recents[1]!.machine!)
assert.equal(opens.at(-1).url, 'http://localhost:41003/app?q=1#hash', 'reopen recreates forwarding instead of remembering its old local port')
closePreview('foreign-thread'); offline = true
assert.equal(await openRemoteServer('foreign-thread', source('a')), false)
assert.match(previewState('foreign-thread').error!, /a is offline/)
offline = false
await retryPreview('foreign-thread')
assert.equal(forwards.at(-1), 'a', 'Retry preserves the failed source rather than substituting another same-port server')
const slow = openRemoteServer('foreign-thread', source('slow'))
await new Promise(resolve => setImmediate(resolve))
await openRemoteServer('foreign-thread', source('b'))
delayed!(); await slow
assert.equal(previewState('foreign-thread').entries.at(-1)?.machine?.id, 'b')
environment.local = false
await openRemoteServer('foreign-thread', source('a'))
assert.equal(opens.at(-1).proxy, true)
assert.equal(relays.at(-1), 'http://127.0.0.1:9999/preview-proxy/t1/')
assert.equal(previewState('foreign-thread').entries.at(-1)?.frameUrl, 'http://127.0.0.1:49999/app?q=1#hash')
const count = forwards.length
await openRemoteServer('foreign-thread', source('primary'))
assert.equal(forwards.length, count, 'a server on the primary daemon is already there')
assert.equal(opens.at(-1).url, 'http://localhost:5173/app?q=1#hash')
closePreview('foreign-thread')
assert.equal(revoked.length, 2)
unsupported = true
for (const local of [false, true]) {
  environment.local = local
  for (const id of ['a', 'primary']) {
    assert.equal(await openRemoteServer('foreign-thread', source(id)), false)
    assert.match((previewState('foreign-thread').load as any).message, /Update Kybern on Primary/)
    closePreview('foreign-thread')
  }
}
unsupported = false
environment.local = false
const beforeHttps = { probes, opens: opens.length }
assert.equal(await openRemoteServer('foreign-thread', { ...source('a'), scheme: 'https' }), false)
assert.equal(previewState('foreign-thread').load.phase, 'error')
assert.match((previewState('foreign-thread').load as any).message, /HTTPS servers cannot be proxied yet/)
assert.deepEqual({ probes, opens: opens.length }, beforeHttps, 'reject unsupported HTTPS before a probe can hide the actionable error behind a TLS failure')
closePreview('foreign-thread')
environment.local = true
await openRemoteServer('foreign-thread', { ...source('a'), scheme: 'https' })
assert.equal(opens.at(-1).url.startsWith('https://localhost:'), true, 'direct local HTTPS preserves its scheme')
closePreview('foreign-thread')
await openPreview('thread', 'http://localhost:3030/docs?x=1')
const manual = parseSourceRecents(load<string | null>(recentsKeyForThread('thread'), null))[0]!
assert.equal(manual.machine?.id, 'primary')
assert.equal(manual.machine?.port, 3030)
assert.equal(manual.machine?.path, '/docs?x=1')
closePreview('thread')
console.log('PASS source-specific forwarding, persisted original source, reopen/retry, stale response, foreign thread, remote environment and proxy cleanup')
