// The socket every GPUIX daemon connection opens: native sockets authenticate the
// upgrade with a header and use the trusted app origin, like the mobile client's
// `createNativeSocket`.
import type { SocketFactory } from '../../../../packages/kybern-client/src/machines.ts'

export const createGpuixSocket: SocketFactory = (url, token) =>
  new WebSocket(url, {
    headers: { origin: 'tauri://localhost', Authorization: `Bearer ${token}` },
  } as unknown as string[])
