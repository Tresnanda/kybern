import { expect, test } from 'bun:test'
import { PROTOCOL_VERSION } from '../../../../packages/kybern-client/src/types.ts'
import { enableUnconfigured } from '../machines/setup.ts'
import { SavedEndpointUnavailable, withVerifiedEndpoint } from './savedEndpoint.ts'

function daemon(identity = 'expected', rejectToken = false, protocol = PROTOCOL_VERSION) {
  const methods: string[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request, server) {
      if (rejectToken) return new Response('Access denied', { status: 401 })
      if (server.upgrade(request)) return
      return new Response('Not found', { status: 404 })
    },
    websocket: {
      message(socket, message) {
        const { id, method } = JSON.parse(String(message))
        methods.push(method)
        const result = method === 'daemon.info' ? { protocol_version: protocol, environment_id: identity, machine_id: identity }
          : method === 'network.status' ? { enabled: false, configured: false }
          : { enabled: true, configured: true }
        socket.send(JSON.stringify({ jsonrpc: '2.0', id, result }))
      },
    },
  })
  return { methods, endpoint: { url: `ws://127.0.0.1:${server.port}/ws`, token: 'fixture', environmentId: 'expected' }, close: () => server.stop(true) }
}
test('a saved token reaches and enables a never-configured daemon without discovery', async () => {
  const f = daemon()
  try {
    expect((await withVerifiedEndpoint(f.endpoint, client => enableUnconfigured(client))).enabled).toBe(true)
    expect(f.methods).toEqual(['daemon.info', 'network.status', 'network.set_enabled'])
  } finally { f.close() }
})
test('identity and protocol refusals cannot fall back to SSH bootstrap', async () => {
  for (const f of [daemon('different'), daemon('expected', false, PROTOCOL_VERSION + 1)]) {
    try {
      let failure: unknown
      try { await withVerifiedEndpoint(f.endpoint, client => enableUnconfigured(client)) } catch (error) { failure = error }
      expect(failure).toBeInstanceOf(Error)
      expect(failure).not.toBeInstanceOf(SavedEndpointUnavailable)
      expect(f.methods).toEqual(['daemon.info'])
    } finally { f.close() }
  }
})
test('an HTTP upgrade token rejection is detected and cannot fall back to SSH', async () => {
  const f = daemon('expected', true)
  try {
    let failure: unknown
    try { await withVerifiedEndpoint(f.endpoint, client => enableUnconfigured(client)) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toBeInstanceOf(SavedEndpointUnavailable)
    expect(String(failure)).toContain('revoked')
    expect(f.methods).toEqual([])
  } finally { f.close() }
})
test('cancellation closes the temporary saved connection before any activation', async () => {
  const f = daemon(), controller = new AbortController()
  try {
    await expect(withVerifiedEndpoint(f.endpoint, async client => {
      controller.abort()
      return enableUnconfigured(client, controller.signal)
    }, controller.signal)).rejects.toThrow()
    expect(f.methods).toEqual(['daemon.info'])
  } finally { f.close() }
})
