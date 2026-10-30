// The socket every GPUIX daemon connection opens: native sockets authenticate the
// upgrade with a header and use the trusted app origin, like the mobile client's
// `createNativeSocket`.
import type { SocketFactory } from '../../../../packages/kybern-client/src/machines.ts'

export const createGpuixSocket: SocketFactory = (url, token, headers) =>
  new WebSocket(url, {
    // `headers` carries `X-Kybern-Relay-Auth` on a relay route; `Authorization` is the target's token.
    headers: { ...headers, origin: 'tauri://localhost', Authorization: `Bearer ${token}` },
  } as unknown as string[])
