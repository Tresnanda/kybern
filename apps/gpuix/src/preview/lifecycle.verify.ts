import assert from 'node:assert/strict'
import { mock } from 'bun:test'
if (!process.env.KYBERN_DATA_DIR?.includes('gpuix-scratch')) throw Error('Scratch data required')
let serial = 0
const closed: string[] = [], launched: string[] = []
let waitOpen: ((result: unknown) => void) | undefined
let waitLaunch: (() => void) | undefined
const client = { endpoint: { url: 'ws://127.0.0.1:9999/ws' }, call: async (method: string, p: any) => {
 if (method === 'previews.close') { closed.push(p.ticket); return {} }
 const result = { ticket: `ticket-${++serial}`, path: `/preview-proxy/ticket-${serial}`, target: { kind: 'server', url: p.target } }
 if (p.target.endsWith('/delayed')) return await new Promise(resolve => { waitOpen = () => resolve(result) })
 return result
} }
mock.module('../state.ts', () => ({ getClient: () => client, getState: () => ({ threads: [{ id: 'thread', cwd: '/scratch' }], projects: [] }) }))
mock.module('./browser.ts', () => ({ launchBrowser: async (url: string) => { launched.push(url); if (waitLaunch) await new Promise<void>(resolve => { waitLaunch = resolve }) } }))
const { openPreview, closePreview, previewState, setPreview, launchPreview, resetPreviews } = await import('./store.ts')
await openPreview('thread', 'http://localhost/first', false, false)
await openPreview('thread', 'http://localhost/second', false, false)
setPreview('thread', { index: 0 })
await openPreview('thread', 'http://localhost/reload', false, false, true)
assert.equal(previewState('thread').entries.length, 2)
assert.equal(previewState('thread').index, 0)
assert.ok(closed.includes('ticket-1'))
assert.equal(previewState('thread').entries[1]?.address, 'http://localhost/second')
const pending = openPreview('thread', 'http://localhost/delayed', false, false)
closePreview('thread'); waitOpen!({}); await pending
assert.equal(previewState('thread').entries.length, 0)
assert.ok(closed.includes('ticket-4'))
await openPreview('thread', 'http://localhost/again', false, false)
waitLaunch = () => {}
const launching = launchPreview('thread'); closePreview('thread'); waitLaunch!(); await launching; waitLaunch = undefined
assert.equal(previewState('thread').opened, false)
for (let i=0; i<20; i++) await openPreview('thread', `http://localhost/${i}`, false, false)
assert.equal(previewState('thread').entries.length, 16)
setPreview('thread', { floating: true }); closePreview('thread')
assert.equal(previewState('thread').floating, false)
await openPreview('thread', 'http://localhost/reset', false, false)
resetPreviews(); assert.equal(previewState('thread').entries.length, 0)
assert.equal(new Set(closed).size, serial)
console.log('PASS preview replacement, history bounds, stale open/launch, close and environment reset')
