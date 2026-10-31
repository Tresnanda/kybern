// ADE-109, run by remotePages.test.ts in its own process (module mocks): a live visual, a visual opened in the browser and a
// Preview server of a thread on another machine all load from a loopback relay that adds the relay member's token itself.
import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import type { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import type { MachineTransport } from '../../../../packages/kybern-client/src/machines.ts'
if (!process.env.KYBERN_DATA_DIR?.includes('gpuix-scratch')) throw Error('Scratch data required')

const seen: { path: string; auth: string | null; relay: string | null }[] = []
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const url = new URL(request.url)
  seen.push({ path: url.pathname + url.search, auth: request.headers.get('authorization'), relay: request.headers.get('x-kybern-relay-auth') })
  return new Response('<p>page</p>', { headers: { 'content-type': 'text/html' } })
} })
const { MachineHub } = await import('./hub.ts')
const hub = new MachineHub({ records: () => [] })
const create = (hub as unknown as { createClient: (args: Parameters<MachineTransport['createClient']>[0]) => KybernClient }).createClient.bind(hub)
const routed = create({ record: { machineId: 'instabox', name: 'instabox', routes: [], member: true }, route: { kind: 'relay', url: `http://127.0.0.1:${server.port}/relay/instabox`, via: 'mac' }, token: 'tok-instabox', relayToken: 'tok-mac' })

// The thread's machine: no address of its own (a `MachineClientProxy`), its pages through the routed connection.
const calls: [string, any][] = []
let serial = 0
const remote = {
  info: { machine_id: 'instabox', environment_id: 'instabox', hostname: 'instabox' },
  endpoint: { url: '', token: '', environmentId: 'instabox' },
  openPage: (path: string, options?: object) => routed.openPage(path, options),
  call: async (method: string, params: any) => {
    calls.push([method, params])
    if (method === 'threads.visuals.frame') return { ticket: `V${++serial}` }
    if (method === 'previews.probe') return { reachable: true, title: 'Remote app' }
    if (method === 'previews.open') return params.proxy ? { target: { kind: 'server', url: params.target, port: 5173 }, ticket: 'P1', path: '/preview-proxy/P1/' } : { target: { kind: 'server', url: params.target, port: 5173 } }
    return {}
  },
}
const local = { info: { machine_id: 'mac', environment_id: 'mac', hostname: 'mac' }, endpoint: { url: 'ws://127.0.0.1:1/ws' }, call: async () => { throw Error('the local daemon must not serve another machine\'s thread') } }

const environment = { id: 'local', local: true, name: 'Primary', dataDir: process.env.KYBERN_DATA_DIR! }
mock.module('../shell/environment.ts', () => ({ activeEnvironment: () => environment, environmentKey: () => environment.id, useEnvironment: () => environment, environmentEndpoint: async () => null }))
const noop = () => {}
mock.module('../state.ts', () => ({ getClient: () => local, localClient: () => local, threadClient: () => remote, projectClient: () => remote, machineOfThreadId: () => 'instabox', callThread: (_id: unknown, method: string, params: unknown) => remote.call(method, params), ownProjectId: (t: any) => t.ownProjectId ?? t.project_id, getState: () => ({ threads: [{ id: 'thread', cwd: '/scratch', machineId: 'instabox' }], projects: [] }), DEFAULT_PANE: 'main', createPane: noop, closePaneState: noop, focusPane: noop, getFocusedPaneId: () => 'main', getPane: () => undefined, getPaneState: () => undefined, getThreadOpen: () => undefined, selectPaneThread: noop, selectThread: async () => {}, setPane: noop, setPaneAlias: noop, subscribe: () => noop }))
const created: string[] = []
const realWebview = await import('../native/webview.ts')
const webHost = { ...realWebview.webHost, available: true, create: (_id: string, url: string) => { created.push(url); return created.length }, subscribe: () => noop, destroy: noop, hide: noop, present: noop, theme: noop }
mock.module('../native/webview.ts', () => ({ ...realWebview, webHost }))
const launched: string[] = []
const realOs = await import('../platform/os.ts')
mock.module('../platform/os.ts', () => ({ ...realOs, openTarget: async (url: string) => { launched.push(url) } }))

const pageOf = async (url: string) => { const response = await fetch(url.split('#')[0]!); return { status: response.status, text: await response.text() } }
const loopback = /^http:\/\/127\.0\.0\.1:\d+\/(#.*)?$/

// A live visual: the frame ticket's page, with its theme fragment, from the loopback relay; destroying it closes the relay.
const { claimDoc, docId, reloadDoc, openVisualInBrowser } = await import('../transcript/visualDocs.ts')
const theme = { mode: 'dark' } as never
claimDoc('thread', 'visual-1', 'inline', theme)
for (let i = 0; i < 100 && !created.length; i++) await new Promise(resolve => setTimeout(resolve, 10))
assert.match(created[0]!, loopback)
assert.ok(!created[0]!.includes('tok-'), 'no token in the page address')
assert.deepEqual(await pageOf(created[0]!), { status: 200, text: '<p>page</p>' })
assert.deepEqual(seen.at(-1), { path: '/relay/instabox/http/visual-frame/V1', auth: null, relay: 'Bearer tok-mac' })
reloadDoc(docId('thread', 'visual-1'))
await assert.rejects(fetch(created[0]!.split('#')[0]!), 'the old frame relay closed with its document')
for (let i = 0; i < 100 && created.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 10))
assert.deepEqual(await pageOf(created[1]!), { status: 200, text: '<p>page</p>' })
assert.equal(seen.at(-1)!.path, '/relay/instabox/http/visual-frame/V2')

// Open in the browser: the same relay, kept up for the ticket's minute.
await openVisualInBrowser('thread', 'visual-1', theme)
assert.match(launched[0]!, loopback)
assert.deepEqual(await pageOf(launched[0]!), { status: 200, text: '<p>page</p>' })
assert.deepEqual(seen.at(-1), { path: '/relay/instabox/http/visual-frame/V3', auth: null, relay: 'Bearer tok-mac' })

// Preview of a server the thread's agent runs on its machine: proxied there, never this Mac's localhost.
const { openPreview, previewState, closePreview } = await import('../preview/store.ts')
assert.equal(await openPreview('thread', 'http://localhost:5173/app?x=1'), true)
const open = calls.find(([method]) => method === 'previews.open')!
assert.equal(open[1].proxy, true)
const entry = previewState('thread').entries[0]!
assert.match(entry.frameUrl!, /^http:\/\/127\.0\.0\.1:\d+\/app\?x=1$/)
assert.deepEqual(await pageOf(entry.frameUrl!), { status: 200, text: '<p>page</p>' })
assert.deepEqual(seen.at(-1), { path: '/relay/instabox/http/preview-proxy/P1/app?x=1', auth: null, relay: 'Bearer tok-mac' })
closePreview('thread')
await assert.rejects(fetch(entry.frameUrl!), 'closing the Preview closes its relay')
assert.ok(calls.some(([method, params]) => method === 'previews.close' && params.ticket === 'P1'))

server.stop(true)
process.exit(0)
