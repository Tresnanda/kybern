import { afterAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { kybernClientFactory } from '../../../../packages/kybern-client/src/machines.ts'
import { MachineClientProxy } from '../../../../packages/kybern-client/src/machineClient.ts'

// ADE-108: pasting an image into a thread on another machine said "Unable to attach image: Enter the environment
// address". The app holds that machine's `MachineClientProxy`, whose endpoint has no address; the upload must go
// through the connection's own route (here a relay through a member) instead.
const seen: { path: string; auth: string | null; relay: string | null; name: string | null; type: string | null; body: number[] }[] = []
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    seen.push({
      path: new URL(request.url).pathname,
      auth: request.headers.get('authorization'),
      relay: request.headers.get('x-kybern-relay-auth'),
      name: request.headers.get('x-kybern-filename'),
      type: request.headers.get('content-type'),
      body: [...new Uint8Array(await request.arrayBuffer())],
    })
    return Response.json({ id: 'asset-1', name: 'paste.png', media_type: 'image/png', size: 3 })
  },
})
const member = `http://127.0.0.1:${server.port}`
const proxy = new MachineClientProxy('instabox', () => false, () => 'instabox')
proxy.attach(kybernClientFactory(() => ({ close() {}, send() {} }) as never)({
  record: { machineId: 'instabox', name: 'instabox', routes: [], member: true },
  route: { kind: 'relay', url: `${member}/relay/instabox`, via: 'mac' },
  token: 'tok-instabox',
  relayToken: 'tok-mac',
}))

const realMachines = await import('../machines/index.ts')
mock.module('../machines/index.ts', () => ({ ...realMachines, clientFor: () => proxy }))
const { uploadBytes, uploadPath } = await import('./store.ts')
const dir = mkdtempSync(path.join(tmpdir(), 'kybern-remote-upload-'))
afterAll(() => { server.stop(true); rmSync(dir, { recursive: true, force: true }) })

test('a pasted image reaches another machine through its route, with no address on the proxy', async () => {
  expect(proxy.endpoint.url).toBe('')
  expect(proxy.endpoint.token).toBe('')
  const asset = await uploadBytes('paste.png', 'image/png', new Uint8Array([1, 2, 3]), 'thread-1' as never, 'instabox')
  expect(asset.id).toBe('asset-1')
  expect(seen.at(-1)).toEqual({ path: '/relay/instabox/http/assets', auth: 'Bearer tok-instabox', relay: 'Bearer tok-mac', name: 'paste.png', type: 'image/png', body: [1, 2, 3] })
})

test('an attached file goes the same way', async () => {
  const file = path.join(dir, 'shot.png')
  writeFileSync(file, new Uint8Array([9, 8]))
  await uploadPath(file, 'thread-1' as never, 'instabox')
  expect(seen.at(-1)).toMatchObject({ path: '/relay/instabox/http/assets', auth: 'Bearer tok-instabox', relay: 'Bearer tok-mac', name: 'shot.png', body: [9, 8] })
})

test('an upload to a machine that went offline says so', async () => {
  proxy.attach(undefined)
  await expect(uploadBytes('paste.png', 'image/png', new Uint8Array([1]), 'thread-1' as never, 'instabox')).rejects.toThrow('instabox is offline. Try again when it reconnects.')
})
