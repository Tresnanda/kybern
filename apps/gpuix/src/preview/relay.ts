import { createConnection, createServer, type Socket } from 'node:net'

/** The desktop's preview_relay.rs transport: a ticket owns an isolated loopback
 * origin so root-relative assets and WebSocket upgrades reach the proxy. */
export function rewriteRelayHead(head: string, authority: string, prefix: string, port: number): string {
  if (Buffer.byteLength(head, 'latin1') > 65536) throw Error('431 Request Header Fields Too Large')
  const lines = head.split('\r\n'), request = lines.shift()!.split(' ')
  if (request.length !== 3 || request[0] === 'CONNECT' || !request[1].startsWith('/') || request[1].startsWith('//') || !/^HTTP\/1\.[01]$/.test(request[2])) throw Error('405 Method Not Allowed')
  const headers = lines.filter(Boolean).map(line => { const colon = line.indexOf(':'); if (colon < 1) throw Error('400 Bad Request'); return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()] })
  const host = headers.filter(([name]) => name === 'host')
  if (host.length !== 1 || ![`127.0.0.1:${port}`, `localhost:${port}`].includes(host[0][1].toLowerCase())) throw Error('421 Misdirected Request')
  const upgrade = headers.some(([name, value]) => name === 'upgrade' && value.toLowerCase() === 'websocket')
  const kept = headers.filter(([name]) => !['host', 'connection', 'keep-alive', 'proxy-authorization', 'proxy-connection'].includes(name))
  return `${request[0]} ${prefix}${request[1]} ${request[2]}\r\nHost: ${authority}\r\nConnection: ${upgrade ? 'Upgrade' : 'close'}\r\n${kept.map(([name, value]) => `${name}: ${value}\r\n`).join('')}\r\n`
}

export async function openRelay(upstream: string, daemon: string): Promise<{ url: string; close(): void }> {
  const target = new URL(upstream), endpoint = new URL(daemon)
  if (target.origin !== endpoint.origin || target.protocol !== 'http:' || target.username || target.password || target.search || target.hash || !/^\/preview-proxy\/[A-Za-z0-9_-]+\/?$/.test(target.pathname)) throw Error('The preview relay must target the configured daemon ticket.')
  const prefix = target.pathname.replace(/\/$/, ''), sockets = new Set<Socket>()
  const server = createServer(client => {
    sockets.add(client); client.on('close', () => sockets.delete(client)); client.on('error', () => {})
    client.setTimeout(15000, () => client.destroy())
    let pending = Buffer.alloc(0)
    const read = (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]); const end = pending.indexOf('\r\n\r\n')
      if (end < 0) { if (pending.length > 65536) client.destroy(); return }
      client.pause(); client.removeListener('data', read)
      let head: string
      try { head = rewriteRelayHead(pending.subarray(0, end + 4).toString('latin1'), target.host, prefix, (server.address() as { port: number }).port) }
      catch (error) { client.end(`HTTP/1.1 ${error instanceof Error ? error.message : '400 Bad Request'}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`); return }
      const socket = createConnection({ host: target.hostname.replace(/^\[|\]$/g, ''), port: Number(target.port) || 80 })
      sockets.add(socket); socket.on('close', () => { sockets.delete(socket); client.destroy() }); client.on('close', () => socket.destroy())
      socket.once('error', () => client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'))
      socket.once('connect', () => {
        client.setTimeout(0); socket.write(head, 'latin1'); socket.write(pending.subarray(end + 4)); pending = Buffer.alloc(0)
        client.pipe(socket); socket.pipe(client); client.resume()
      })
    }
    client.on('data', read)
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() }) })
  server.unref()
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`, close() { for (const socket of sockets) socket.destroy(); sockets.clear(); server.close() } }
}
