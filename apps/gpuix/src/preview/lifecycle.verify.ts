import assert from 'node:assert/strict'
import { mock } from 'bun:test'
if (!process.env.KYBERN_DATA_DIR?.includes('gpuix-scratch')) throw Error('Scratch data required')
let serial = 0
let probe: any = { reachable: true }, waitProbe: ((value: unknown) => void) | undefined
const opened: any[] = []
const closed: string[] = [], launched: string[] = []
let waitOpen: ((result: unknown) => void) | undefined
let waitLaunch: (() => void) | undefined
const client = { endpoint: { url: 'ws://127.0.0.1:9999/ws' }, call: async (method: string, p: any) => {
 if (method === 'previews.probe') { if (p.url.endsWith('/probe-delayed')) return await new Promise(resolve => { waitProbe = resolve }); return probe }
 if (method === 'previews.close') { closed.push(p.ticket); return {} }
 opened.push(p)
 const result = { ticket: `ticket-${++serial}`, path: `/preview-proxy/ticket-${serial}`, target: { kind: 'server', url: p.target } }
 if (p.target.endsWith('/delayed')) return await new Promise(resolve => { waitOpen = () => resolve(result) })
 return result
} }
// The store opens previews as tabs (ADE-54), which pulls in the split store's pane helpers; they are inert here.
const noop = () => {}
mock.module('../state.ts', () => ({ getClient: () => client, getState: () => ({ threads: [{ id: 'thread', cwd: '/scratch' }], projects: [] }), DEFAULT_PANE: 'main', createPane: noop, closePaneState: noop, focusPane: noop, getFocusedPaneId: () => 'main', getPane: () => undefined, getPaneState: () => undefined, selectPaneThread: noop, selectThread: async () => {}, setPane: noop, setPaneAlias: noop, subscribe: () => noop }))
mock.module('./browser.ts', () => ({ launchBrowser: async (url: string) => { launched.push(url); if (waitLaunch) await new Promise<void>(resolve => { waitLaunch = resolve }) } }))
const { openPreview, closePreview, previewState, setPreview, launchPreview, resetPreviews, retryPreview, setPreviewProxy } = await import('./store.ts')
await openPreview('thread', 'http://localhost/first', false, false)
await openPreview('thread', 'http://localhost/second', false, false)
setPreview('thread', { index: 0 })
await openPreview('thread', 'http://localhost/reload', false, false, true)
assert.equal(previewState('thread').entries.length, 2)
assert.equal(previewState('thread').index, 0)
assert.ok(closed.includes('ticket-1'))
assert.equal(previewState('thread').entries[1]?.address, 'http://localhost/second')
const pending = openPreview('thread', 'http://localhost/delayed', false, false)
while (!waitOpen) await Bun.sleep(0)
closePreview('thread'); waitOpen!({}); await pending
assert.equal(previewState('thread').entries.length, 0)
assert.ok(closed.includes('ticket-4'))
await openPreview('thread', 'http://localhost/again', false, false)
waitLaunch = () => {}
const launching = launchPreview('thread'); assert.equal(launched.at(-1), 'http://localhost/again'); closePreview('thread'); waitLaunch!(); await launching; waitLaunch = undefined
assert.equal(previewState('thread').opened, false)
for (let i=0; i<20; i++) await openPreview('thread', `http://localhost/${i}`, false, false)
assert.equal(previewState('thread').entries.length, 16)
setPreview('thread', { floating: true }); closePreview('thread')
assert.equal(previewState('thread').floating, false)
await openPreview('thread', 'http://localhost/reset', false, false)
resetPreviews(); assert.equal(previewState('thread').entries.length, 0)
assert.equal(new Set(closed).size, serial)
probe = { reachable: true, blocked_by: { header: 'x-frame-options', value: 'DENY' } }
await openPreview('thread', 'http://localhost/blocked')
assert.equal(previewState('thread').load.phase, 'blocked')
assert.equal(previewState('thread').entries[0]?.proxy, false)
const serialBeforeProxy = serial
setPreviewProxy('thread', true)
while (previewState('thread').busy) await Bun.sleep(0)
assert.equal(previewState('thread').load.phase, 'ready'); assert.equal(serial, serialBeforeProxy + 1)
assert.equal(opened.at(-1).proxy, true)
probe = { reachable: false, error: 'connection_refused' }
await openPreview('thread', 'http://localhost/waiting')
assert.equal(previewState('thread').load.phase, 'waiting')
const since = (previewState('thread').load as any).startedAt
await retryPreview('thread'); assert.equal((previewState('thread').load as any).startedAt, since)
probe = { reachable: false, error: 'tls' }
await openPreview('thread', 'https://localhost/tls')
assert.equal(previewState('thread').load.phase, 'error'); assert.equal((previewState('thread').load as any).error, 'tls')
const delayedProbe = openPreview('thread', 'http://localhost/probe-delayed')
closePreview('thread'); waitProbe!({ reachable: true }); await delayedProbe
assert.equal(previewState('thread').entries.length, 0)
console.log('PASS probe blocked/proxy/waiting clock/TLS error and stale probe; preview replacement, history bounds, stale open/launch, close and environment reset')
