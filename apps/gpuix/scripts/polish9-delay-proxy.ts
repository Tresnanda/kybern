// A WebSocket/HTTP pass-through to a scratch daemon that holds back the answers to chosen RPC methods, so a check can
// make provider statuses (or accounts) arrive early, late or in the other order.
//   bun scripts/polish9-delay-proxy.ts <daemonPort> <token> 'providers.list=1500,providers.accounts.list=0'
// Prints the proxy port on the first line of stdout.
const [daemonPort, token, spec = ''] = process.argv.slice(2)
if (!daemonPort || !token) throw new Error('usage: polish9-delay-proxy.ts <daemonPort> <token> [method=ms,...]')
if (Number(daemonPort) === 4219) throw new Error('Port 4219 is the older scratch daemon: leave it alone')
const delays = new Map(spec.split(',').filter(Boolean).map((entry) => { const [method, ms] = entry.split('='); return [method!, Number(ms)] as const }))
const started = Date.now(), log = (text: string) => { if (process.env.POLISH9_PROXY_LOG) console.error(`[proxy ${Date.now() - started}ms] ${text}`) }
// POLISH9_FIRST_ACCOUNTS_WITHOUT=claude-code: the first `providers.accounts.list` answer lacks that agent's accounts, the later one has them.
const withoutKind = process.env.POLISH9_FIRST_ACCOUNTS_WITHOUT
let accountAnswers = 0
type Data = { upstream: WebSocket; methods: Map<unknown, string>; queued: string[] }
const server = Bun.serve<Data>({
  hostname: '127.0.0.1', port: 0,
  fetch(req, s) {
    if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') { const target = new URL(req.url); target.port = daemonPort; return fetch(new Request(target, req)) }
    const upstream = new WebSocket(`ws://127.0.0.1:${daemonPort}/ws`, { headers: { origin: 'tauri://localhost', Authorization: `Bearer ${token}` } } as never)
    if (s.upgrade(req, { data: { upstream, methods: new Map(), queued: [] } })) return
    upstream.close(); return new Response('Not found', { status: 404 })
  },
  websocket: {
    open(ws) {
      ws.data.upstream.onopen = () => { for (const text of ws.data.queued) ws.data.upstream.send(text); ws.data.queued = [] }
      ws.data.upstream.onmessage = (e) => {
        let text = String(e.data)
        let wait = 0
        try { const message = JSON.parse(text); if ('id' in message && !('method' in message)) { const method = ws.data.methods.get(message.id) ?? ''; wait = delays.get(method) ?? 0; if (method.startsWith('providers.')) log(`${method} answered by the daemon, held ${wait}ms`) } } catch { /* forward as is */ }
        if (withoutKind) {
          try {
            const message = JSON.parse(text)
            if (ws.data.methods.get(message.id) === 'providers.accounts.list' && message.result?.accounts && accountAnswers++ === 0) { message.result.accounts = message.result.accounts.filter((a: { provider: { kind: string } }) => a.provider.kind !== withoutKind); text = JSON.stringify(message); log(`first accounts answer without ${withoutKind}`) }
            else if (ws.data.methods.get(message.id) === 'providers.accounts.list') wait = Number(process.env.POLISH9_LATER_ACCOUNTS_MS ?? 0)
          } catch { /* forward as is */ }
        }
        if (wait > 0) setTimeout(() => { try { ws.send(text) } catch { /* the client left */ } }, wait); else ws.send(text)
      }
      ws.data.upstream.onclose = () => ws.close()
    },
    message(ws, raw) {
      const text = String(raw)
      try { const message = JSON.parse(text); if (message.method && 'id' in message) { ws.data.methods.set(message.id, message.method); if (message.method.startsWith('providers.')) log(`${message.method} requested`) } } catch { /* forward as is */ }
      if (ws.data.upstream.readyState === WebSocket.OPEN) ws.data.upstream.send(text); else ws.data.queued.push(text)
    },
    close(ws) { ws.data.upstream.close() },
  },
})
console.log(server.port)
process.once('SIGTERM', () => { server.stop(true); process.exit(0) })
await new Promise(() => {})
