import { KybernClient, type Endpoint } from '../../../../packages/kybern-client/src/client.ts'
import { probeAuth } from '../../../../packages/kybern-client/src/machines.ts'

/** Only an unanswered connection may fall back to starting a daemon over saved SSH. */
export class SavedEndpointUnavailable extends Error {}

/** A saved token and expected machine id remain usable while network discovery is off. */
export async function withVerifiedEndpoint<T>(endpoint: Endpoint, action: (client: KybernClient) => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted()
  const client = new KybernClient(endpoint, { probeAuth: () => probeAuth(endpoint.url, endpoint.token, undefined, false), requestTimeoutMs: 15000, createSocket: (url, token) => new WebSocket(url, { headers: { origin: 'tauri://localhost', Authorization: `Bearer ${token}` } } as never) })
  const abort = () => client.close()
  signal?.addEventListener('abort', abort, { once: true })
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { stop(); reject(new SavedEndpointUnavailable('Unable to reach this saved machine. Check its address and connection, then retry.')) }, 15000)
      const stop = client.onStatus((status, message) => {
        if (status === 'open') { clearTimeout(timer); stop(); resolve() }
        else if (status === 'failed' || status === 'closed') { clearTimeout(timer); stop(); reject(Error(message ?? 'The saved connection closed. Reconnect and retry.')) }
      })
      client.connect()
    })
    signal?.throwIfAborted()
    return await action(client)
  } finally { signal?.removeEventListener('abort', abort); client.close() }
}

