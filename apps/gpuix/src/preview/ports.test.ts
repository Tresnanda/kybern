import { expect, test } from 'bun:test'
import type { PortForward } from '../../../../packages/kybern-client/src/types.ts'
import { createPortsStore, type PortsClient } from './ports.ts'

const forward = (id: string, local: number, at = '2026-10-29T10:00:00Z'): PortForward => ({ id, machine_id: 'm', machine_name: 'vps', remote_port: 3000, local_port: local, connections: 0, created_at: at })

function fake(initial: PortForward[]) {
  const handlers = new Set<(params: unknown) => void>()
  const calls: string[] = []
  const client = {
    call: async (method: string, params: { id?: string }) => {
      calls.push(method)
      if (method === 'ports.stop') return { forwards: initial.filter((f) => f.id !== params.id) }
      return { forwards: initial }
    },
    onNotification: (_method: string, handler: (params: unknown) => void) => { handlers.add(handler); return () => { handlers.delete(handler) } },
  } as unknown as PortsClient
  return { client, handlers, calls }
}

test('the store reads the list, follows ports.changed and stops a forward', async () => {
  const { client, handlers, calls } = fake([forward('b', 4001, '2026-10-29T11:00:00Z'), forward('a', 4000)])
  const store = createPortsStore(client)
  let changes = 0
  store.subscribe(() => { changes++ })
  await Promise.resolve(); await Promise.resolve()
  expect(store.get().map((f) => f.id)).toEqual(['a', 'b'])
  for (const handler of handlers) handler({ forwards: [forward('c', 4002)] })
  expect(store.get().map((f) => f.id)).toEqual(['c'])
  await store.stop('c')
  expect(calls).toContain('ports.stop')
  expect(changes).toBeGreaterThanOrEqual(3)
  store.dispose()
  expect(handlers.size).toBe(0)
})

test('a notification without a list is ignored', async () => {
  const { client, handlers } = fake([forward('a', 4000)])
  const store = createPortsStore(client)
  await Promise.resolve(); await Promise.resolve()
  for (const handler of handlers) handler({})
  expect(store.get().length).toBe(1)
})
