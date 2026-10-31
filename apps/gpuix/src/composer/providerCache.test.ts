import { expect, test } from 'bun:test'
import { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import { MachineClientProxy } from '../../../../packages/kybern-client/src/machineClient.ts'
import { providerCacheKey } from './store.ts'

// ADE-109: the provider catalog cache was keyed by the client's address, and another machine's client has none, so every
// machine of the network would have shared one catalog. It is keyed by machine id.
test('each machine keeps its own provider catalog', () => {
  const instabox = new MachineClientProxy('instabox'), vps = new MachineClientProxy('vps')
  expect(instabox.endpoint.url).toBe(vps.endpoint.url)
  expect(providerCacheKey(instabox)).not.toBe(providerCacheKey(vps))
  expect(providerCacheKey(instabox)).toBe('machine-instabox')
})

test('the local daemon is keyed by the id it reports, whatever address reaches it', () => {
  const tunnel = (port: number) => ({ info: { machine_id: 'mac', environment_id: 'mac' }, endpoint: { url: `ws://127.0.0.1:${port}/ws`, token: 't' } })
  expect(providerCacheKey(tunnel(4190) as never)).toBe('machine-mac')
  expect(providerCacheKey(tunnel(51234) as never)).toBe('machine-mac')
  expect(providerCacheKey(new KybernClient({ url: 'ws://127.0.0.1:4190/ws', token: 't' }))).toBeNull()
})
