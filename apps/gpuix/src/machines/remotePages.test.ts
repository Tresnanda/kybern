import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import { MachineClientProxy } from '../../../../packages/kybern-client/src/machineClient.ts'
import type { MachineTransport } from '../../../../packages/kybern-client/src/machines.ts'
import { MachineHub } from './hub.ts'

// ADE-109: an artifact preview or a live visual of a thread on another machine built its address from the proxy's
// endpoint, which has none. A web view or the browser cannot send the relay member's header either, so the page loads
// from a loopback relay the app's connection to that machine opens, with the header added there and never in the URL.
const seen: { path: string; auth: string | null; relay: string | null }[] = []
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  seen.push({ path: new URL(request.url).pathname + new URL(request.url).search, auth: request.headers.get('authorization'), relay: request.headers.get('x-kybern-relay-auth') })
  return new Response('<p>page</p>', { headers: { 'content-type': 'text/html' } })
} })
afterAll(() => { server.stop(true) })
const member = `http://127.0.0.1:${server.port}`
const record = { machineId: 'instabox', name: 'instabox', routes: [], member: true }
const hub = new MachineHub({ records: () => [] })
const create = (hub as unknown as { createClient: (args: Parameters<MachineTransport['createClient']>[0]) => KybernClient }).createClient.bind(hub)
const proxied = (args: Parameters<MachineTransport['createClient']>[0]) => {
  const proxy = new MachineClientProxy('instabox', () => false, () => 'instabox')
  proxy.attach(create(args))
  return proxy
}
const routes = {
  relay: { client: proxied({ record, route: { kind: 'relay', url: `${member}/relay/instabox`, via: 'mac' }, token: 'tok-instabox', relayToken: 'tok-mac' }), prefix: '/relay/instabox/http', relay: 'Bearer tok-mac' },
  direct: { client: proxied({ record, route: { kind: 'direct_tailnet', url: member }, token: 'tok-instabox' }), prefix: '', relay: null },
}

for (const [kind, { client, prefix, relay }] of Object.entries(routes)) for (const page of ['/visual-frame/V1', '/artifact-preview/A1']) {
  test(`${page} of another machine loads from a loopback relay on a ${kind} route`, async () => {
    expect(client.endpoint.url).toBe('')
    const opened = await client.openPage(page)
    try {
      expect(opened.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
      expect(opened.url).not.toContain(String(server.port))
      const response = await fetch(opened.url)
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('<p>page</p>')
      // The ticket is the credential: neither device token reaches the page, and only the relay member's header is added.
      expect(seen.at(-1)).toEqual({ path: `${prefix}${page}`, auth: null, relay })
      // A single-page ticket: the loopback origin reaches nothing else of the machine.
      const count = seen.length
      expect((await fetch(`${opened.url}assets`)).status).toBe(404)
      expect(seen.length).toBe(count)
    } finally { opened.close() }
    await expect(fetch(opened.url)).rejects.toThrow()
  })
}

test('a Preview server ticket keeps its whole path through the relay', async () => {
  const opened = await routes.relay.client.openPage('/preview-proxy/P1/')
  try {
    expect((await fetch(`${opened.url}src/main.ts?v=1`)).status).toBe(200)
    expect(seen.at(-1)).toEqual({ path: '/relay/instabox/http/preview-proxy/P1/src/main.ts?v=1', auth: null, relay: 'Bearer tok-mac' })
  } finally { opened.close() }
})

test('an offline machine says so instead of building an address', async () => {
  const proxy = new MachineClientProxy('instabox', () => false, () => 'instabox')
  await expect(proxy.openPage('/visual-frame/V1')).rejects.toThrow('instabox is offline. Try again when it reconnects.')
})

test('the machine the app runs beside keeps serving its pages at its own address', async () => {
  const local = new KybernClient({ url: 'ws://127.0.0.1:4190/ws', token: 'tok-local' })
  const opened = await local.openPage('/visual-frame/V1')
  expect(opened.url).toBe('http://127.0.0.1:4190/visual-frame/V1')
  opened.close()
})

test('visual docs and Preview of a thread on another machine use its relay (ADE-109)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gpuix-scratch-remote-pages-'))
  try {
    const child = Bun.spawn(['bun', path.join(import.meta.dir, 'remotePages.verify.ts')], { env: { ...process.env, KYBERN_DATA_DIR: dir, KYBERN_CLIENT_CONFIG_DIR: path.join(dir, 'config') }, stdout: 'pipe', stderr: 'pipe' })
    const output = await new Response(child.stderr).text()
    expect(await child.exited, output).toBe(0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
