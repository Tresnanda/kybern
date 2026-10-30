// Forwarded ports (U3): the forwards this machine's daemon holds, read once and kept current by `ports.changed`. The Preview
// panel's More menu lists them and stops one on a click.
import { useEffect, useState } from 'react'
import { PORTS_CHANGED_NOTIFICATION, type PortForward, type PortsListResult } from '../../../../packages/kybern-client/src/types.ts'
import { localClient } from '../state.ts'

/** The slice of a client the store needs. */
export interface PortsClient {
  call(method: 'ports.list', params: Record<string, never>): Promise<PortsListResult>
  call(method: 'ports.stop', params: { id: string }): Promise<PortsListResult>
  onNotification(method: string, handler: (params: unknown) => void): () => void
}

export interface PortsStore {
  get(): PortForward[]
  subscribe(listener: () => void): () => void
  stop(id: string): Promise<void>
  dispose(): void
}

/** Forwards in a stable order: oldest first. */
const ordered = (forwards: readonly PortForward[]): PortForward[] => [...forwards].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.local_port - b.local_port)

export function createPortsStore(client: PortsClient): PortsStore {
  let forwards: PortForward[] = []
  let disposed = false
  const listeners = new Set<() => void>()
  const set = (next: readonly PortForward[]) => { forwards = ordered(next); for (const listener of listeners) listener() }
  const off = client.onNotification(PORTS_CHANGED_NOTIFICATION, (params) => {
    const next = (params as Partial<PortsListResult> | null)?.forwards
    if (!disposed && Array.isArray(next)) set(next)
  })
  void client.call('ports.list', {}).then((result) => { if (!disposed) set(result.forwards) }, () => {})
  return {
    get: () => forwards,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    stop: async (id) => { const result = await client.call('ports.stop', { id }); if (!disposed) set(result.forwards) },
    dispose: () => { disposed = true; off(); listeners.clear() },
  }
}

/** The forwards of this machine's daemon (the page is shown from here), and the way to stop one. */
export function usePorts(threadId: string): { forwards: PortForward[]; stop: (id: string) => Promise<void> } {
  const [store, setStore] = useState<PortsStore | null>(null)
  const [, bump] = useState(0)
  useEffect(() => {
    const client = localClient()
    if (!client) return
    const next = createPortsStore(client as unknown as PortsClient)
    setStore(next)
    const off = next.subscribe(() => bump((n) => n + 1))
    return () => { off(); next.dispose(); setStore(null) }
  }, [threadId])
  return { forwards: store?.get() ?? [], stop: (id) => store?.stop(id) ?? Promise.resolve() }
}
