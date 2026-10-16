import { test, expect } from 'bun:test'
import { createServer, createConnection } from 'node:net'
import { openRelay, rewriteRelayHead } from './relay.ts'

test('relay keeps the page credentials, rejects foreign origins and authority-form targets', () => {
  const head = rewriteRelayHead('POST /api?x=1 HTTP/1.1\r\nHost: 127.0.0.1:5321\r\nCookie: page=1\r\nAuthorization: Bearer app\r\nConnection: keep-alive\r\nContent-Length: 5\r\n\r\n', '127.0.0.1:4237', '/preview-proxy/T1', 5321)
  expect(head).toContain('POST /preview-proxy/T1/api?x=1 HTTP/1.1\r\nHost: 127.0.0.1:4237')
  expect(head).toContain('cookie: page=1'); expect(head).toContain('authorization: Bearer app'); expect(head).toContain('Connection: close')
  expect(head).not.toContain('keep-alive')
  for (const request of ['CONNECT example.com:443', 'GET http://evil/', 'GET //evil/']) expect(() => rewriteRelayHead(`${request} HTTP/1.1\r\nHost: 127.0.0.1:5321\r\n\r\n`, 'daemon:9', '/preview-proxy/T1', 5321)).toThrow()
  for (const host of ['evil.example:5321', '127.0.0.1:5322', '127.0.0.1:5321\r\nHost: evil']) expect(() => rewriteRelayHead(`GET / HTTP/1.1\r\nHost: ${host}\r\n\r\n`, 'daemon:9', '/preview-proxy/T1', 5321)).toThrow('421')
})

test('relay only accepts the configured daemon ticket endpoint', async () => {
  for (const upstream of ['http://evil/preview-proxy/T1', 'http://127.0.0.1:9/not-a-ticket', 'http://u:p@127.0.0.1:9/preview-proxy/T1', 'http://127.0.0.1:9/preview-proxy/../T1']) await expect(openRelay(upstream, 'http://127.0.0.1:9')).rejects.toThrow('configured daemon')
})

test('relay bounds a complete request head as well as fragmented input', () => {
  expect(() => rewriteRelayHead(`GET / HTTP/1.1\r\nHost: localhost:5321\r\nX-Pad: ${'x'.repeat(65536)}\r\n\r\n`, 'daemon:9', '/preview-proxy/T1', 5321)).toThrow('431')
})

test('root assets and websocket bytes reach the ticket; closing destroys both connections', async () => {
  let seen = ''
  const upstream = createServer(socket => {
    socket.once('data', data => {
      seen = data.toString(); socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
      socket.on('data', chunk => socket.write(chunk))
    })
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const daemon = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`
  const relay = await openRelay(`${daemon}/preview-proxy/T1/`, daemon)
  const port = Number(new URL(relay.url).port), socket = createConnection(port, '127.0.0.1')
  try {
    let response = ''
    const echo = new Promise<void>((resolve, reject) => { socket.on('error', reject); socket.on('data', data => { response += data.toString(); if (response.endsWith('pong')) resolve(); else if (response.includes('\r\n\r\n')) socket.write('pong') }) })
    socket.write(`GET /src/main.ts?token=1 HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`)
    await echo
    expect(seen).toStartWith('GET /preview-proxy/T1/src/main.ts?token=1 HTTP/1.1')
    expect(seen).not.toContain('authorization'); expect(response).toContain('101 Switching Protocols'); expect(response).toEndWith('pong')
  } finally { socket.destroy(); relay.close(); await new Promise<void>(resolve => upstream.close(() => resolve())) }
})
