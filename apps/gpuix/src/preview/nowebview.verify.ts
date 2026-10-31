// Previews with no embedded web view (run with KYBERN_GPUIX_NO_WEBVIEW=1): the page opens in the browser as soon as it is ready,
// keeps its ticket while it is the current entry, and gives it back when it is replaced, closed or the environment resets.
import assert from 'node:assert/strict'
import { mock } from 'bun:test'
if (!process.env.KYBERN_DATA_DIR?.includes('gpuix-scratch')) throw Error('Scratch data required')
assert.equal(process.env.KYBERN_GPUIX_NO_WEBVIEW, '1')
let serial = 0
const closed: string[] = [], launched: string[] = []
const client = { endpoint: { url: 'ws://127.0.0.1:9999/ws' }, call: async (method: string, p: any) => {
 if (method === 'previews.probe') return { reachable: true }
 if (method === 'previews.close') { closed.push(p.ticket); return {} }
 return { ticket: `ticket-${++serial}`, path: `/preview-proxy/ticket-${serial}`, target: { kind: 'server', url: p.target } }
} }
const noop = () => {}
mock.module('../state.ts', () => ({ getClient: () => client, localClient: () => client, threadClient: () => client, projectClient: () => client, machineOfThreadId: () => undefined, callThread: (_id: unknown, method: string, params: unknown) => client.call(method, params), ownProjectId: (t: any) => t.ownProjectId ?? t.project_id, getState: () => ({ threads: [{ id: 'thread', cwd: '/scratch' }], projects: [] }), DEFAULT_PANE: 'main', createPane: noop, closePaneState: noop, focusPane: noop, getFocusedPaneId: () => 'main', getPane: () => undefined, getPaneState: () => undefined, getThreadOpen: () => undefined, selectPaneThread: noop, selectThread: async () => {}, setPane: noop, setPaneAlias: noop, subscribe: () => noop }))
let failLaunch = false
mock.module('./browser.ts', () => ({ launchBrowser: async (url: string) => { launched.push(url); if (failLaunch) throw new Error('Could not open the browser. Try opening the address again.') } }))
mock.module('./relay.ts', () => ({ openRelay: async (url: string) => ({ url: 'http://127.0.0.1:4455/', close: () => {} }) }))
const { webHost } = await import('../native/webview.ts')
assert.equal(webHost.available, false)
const { openPreview, closePreview, previewState, setPreview, launchPreview, resetPreviews } = await import('./store.ts')

// A ready server page opens in the browser at once, with no loading bar left running and its ticket still held.
await openPreview('thread', 'http://localhost:3000/', false, false)
assert.deepEqual(launched, ['http://localhost:3000/'])
let s = previewState('thread')
assert.equal(s.load.phase, 'ready'); assert.equal(s.opened, true); assert.equal(s.loading, false); assert.equal(s.error, null)
assert.deepEqual(closed, [])

// Opening another replaces it: the first ticket is released, the second page opens.
await openPreview('thread', 'http://localhost:3001/', false, false)
assert.deepEqual(launched, ['http://localhost:3000/', 'http://localhost:3001/'])
assert.deepEqual(closed, ['ticket-1'])

// A failed launch keeps the page, says so, and Open again clears it.
failLaunch = true
await openPreview('thread', 'http://localhost:3002/', false, false)
assert.match(previewState('thread').error ?? '', /Could not open the browser/); assert.equal(previewState('thread').opened, false)
failLaunch = false
await launchPreview('thread'); assert.equal(previewState('thread').opened, true); assert.equal(previewState('thread').error, null)
assert.equal(launched.at(-1), 'http://localhost:3002/')

// Nothing can float without a web view.
setPreview('thread', { floating: true }); assert.equal(previewState('thread').floating, false)

// Closing and an environment reset release every ticket exactly once.
closePreview('thread'); assert.equal(previewState('thread').entries.length, 0)
await openPreview('thread', 'http://localhost:3003/', false, false)
resetPreviews()
assert.equal(new Set(closed).size, serial); assert.equal(closed.length, serial)
console.log('PASS no web view: preview opens in the browser, keeps and releases its ticket, cannot float')
