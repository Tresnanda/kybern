import { createConnection, createServer, isIP, type Socket } from 'node:net'
import { connect as connectTLS, checkServerIdentity } from 'node:tls'

/** The desktop's preview_relay.rs transport: a ticket owns an isolated loopback
 * origin so root-relative assets and WebSocket upgrades reach the proxy. */
/** `extra` headers are added to every forwarded request: a page that reaches another machine through the one you are paired
 * with sends that member's device token in `X-Kybern-Relay-Auth`, so the page itself never holds it. A `document` ticket is one
 * page (`/visual-frame/<ticket>`): only `/` reaches it, as the ticket path itself. */
export function rewriteRelayHead(head: string, authority: string, prefix: string, port: number, extra: readonly (readonly [string, string])[] = [], document = false): string {
  if (Buffer.byteLength(head, 'latin1') > 65536) throw Error('431 Request Header Fields Too Large')
  const lines = head.split('\r\n'), request = lines.shift()!.split(' ')
  if (request.length !== 3 || request[0] === 'CONNECT' || !request[1].startsWith('/') || request[1].startsWith('//') || !/^HTTP\/1\.[01]$/.test(request[2])) throw Error('405 Method Not Allowed')
  const path = request[1].split('?')[0]
  let decoded: string
  try { decoded = decodeURIComponent(path) } catch { throw Error('400 Bad Request') }
  if (/[\\\x00-\x20\x7f]/.test(decoded) || decoded.split('/').some(part => part === '.' || part === '..')) throw Error('400 Bad Request')
  const headers = lines.filter(Boolean).map(line => { const colon = line.indexOf(':'); if (colon < 1) throw Error('400 Bad Request'); return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()] })
  const host = headers.filter(([name]) => name === 'host')
  if (host.length !== 1 || ![`127.0.0.1:${port}`, `localhost:${port}`].includes(host[0][1].toLowerCase())) throw Error('421 Misdirected Request')
  const upgrade = headers.some(([name, value]) => name === 'upgrade' && value.toLowerCase() === 'websocket')
  if (document && (path !== '/' || upgrade)) throw Error('404 Not Found')
  const target = document ? `${prefix}${request[1].slice(1)}` : `${prefix}${request[1]}`
  const kept = headers.filter(([name]) => !['host', 'connection', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'x-kybern-relay-auth'].includes(name))
  return `${request[0]} ${target} ${request[2]}\r\nHost: ${authority}\r\nConnection: ${upgrade ? 'Upgrade' : 'close'}\r\n${kept.map(([name, value]) => `${name}: ${value}\r\n`).join('')}${extra.map(([name, value]) => `${name}: ${value}\r\n`).join('')}\r\n`
}

/** A ticket on the daemon itself, or on another machine of the network through the daemon you are paired with
 * (`/relay/<machine>/http/preview-proxy/<ticket>`, with `relayAuth` as the device token that daemon knows you by).
 * A preview proxies a whole server; an artifact preview or a visual frame is a single page. */
export const RELAY_TICKET_PATH = /^(?:\/relay\/[A-Za-z0-9_-]+\/http)?\/(?:preview-proxy\/[A-Za-z0-9_-]+\/?|(?:artifact-preview|visual-frame)\/[A-Za-z0-9_-]+)$/
const DOCUMENT_TICKET = /\/(?:artifact-preview|visual-frame)\/[A-Za-z0-9_-]+$/

export async function openRelay(upstream: string, daemon: string, options?: { ca?: string | Buffer; relayAuth?: string; onWebSocketFailure?: () => void }): Promise<{ url: string; close(): void }> {
  const target = new URL(upstream), endpoint = new URL(daemon)
  if (target.origin !== endpoint.origin || endpoint.username || endpoint.password || !['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.search || target.hash || !RELAY_TICKET_PATH.test(target.pathname)) throw Error('The preview relay must target the configured daemon ticket.')
  const extra: [string, string][] = options?.relayAuth && target.pathname.startsWith('/relay/') ? [['x-kybern-relay-auth', `Bearer ${options.relayAuth}`]] : []
  const prefix = target.pathname.replace(/\/$/, ''), document = DOCUMENT_TICKET.test(target.pathname), sockets = new Set<Socket>()
  const hostname = target.hostname.replace(/^\[|\]$/g, ''), secure = target.protocol === 'https:'
  const server = createServer(client => {
    sockets.add(client); client.on('close', () => sockets.delete(client)); client.on('error', () => {})
    client.setTimeout(15000, () => client.destroy())
    let pending = Buffer.alloc(0)
    const read = (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]); const end = pending.indexOf('\r\n\r\n')
      if (end < 0) { if (pending.length > 65536) client.destroy(); return }
      client.pause(); client.removeListener('data', read)
      let head: string
      try { head = rewriteRelayHead(pending.subarray(0, end + 4).toString('latin1'), target.host, prefix, (server.address() as { port: number }).port, extra, document) }
      catch (error) { client.end(`HTTP/1.1 ${error instanceof Error ? error.message : '400 Bad Request'}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`); return }
      const connection = { host: hostname, port: Number(target.port) || (secure ? 443 : 80) }
      // Wait for certificate + hostname validation before any page bytes leave.
      // Explicit validation remains on even if the process environment disables TLS checks.
      const socket = secure ? connectTLS({ ...connection, rejectUnauthorized: true,
        servername: isIP(hostname) ? undefined : hostname, ALPNProtocols: ['http/1.1'],
        checkServerIdentity: (_name, certificate) => checkServerIdentity(hostname, certificate),
        ...(options?.ca ? { ca: options.ca } : {}),
      }) : createConnection(connection)
      socket.setTimeout(15000, () => socket.destroy(Error('Preview connection timed out')))
      sockets.add(socket); socket.on('close', () => { sockets.delete(socket); client.destroy() }); client.on('close', () => socket.destroy())
      const upgrade = /\r\nupgrade:\s*websocket\r\n/i.test(head)
      if (upgrade) {
        let status = ''
        const inspect = (chunk: Buffer) => {
          status += chunk.subarray(0, Math.max(0, 256 - status.length)).toString('latin1')
          if (status.includes('\r\n') || status.length >= 256) { socket.removeListener('data', inspect); if (!/^HTTP\/1\.[01] 101(?: |\r\n)/.test(status)) options?.onWebSocketFailure?.() }
        }
        socket.on('data', inspect)
      }
      socket.once('error', () => { if (upgrade) options?.onWebSocketFailure?.(); client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n') })
      socket.once(secure ? 'secureConnect' : 'connect', () => {
        socket.setTimeout(0); client.setTimeout(0); socket.write(head, 'latin1'); socket.write(pending.subarray(end + 4)); pending = Buffer.alloc(0)
        client.pipe(socket); socket.pipe(client); client.resume()
      })
    }
    client.on('data', read)
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() }) })
  server.unref()
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`, close() { for (const socket of sockets) socket.destroy(); sockets.clear(); server.close() } }
}
