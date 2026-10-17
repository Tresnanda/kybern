/**
 * remote9: preview loopback relay against a real remote environment. A web server runs on the SSH machine (started
 * over SSH, loopback only); the app connects to B through the SSH tunnel and opens it in a thread's dock preview.
 * The page and its root-absolute asset must load through the relay's own loopback origin → tunnel → B's
 * `/preview-proxy/{ticket}` → the server. Takes the UI lock (native webview capture).
 *
 *   bun src/environments/remote9-preview.ts [dark|light]        (KYBERN_REDUCED_MOTION=1 for reduced motion)
 */
import { DATA_A, DATA_B, OUT, PORT_A, PORT_B, SSH_DIR, SSH_ENV, KEYCHAIN, cli, ensureProject, listening, resetClient, startDaemon, startSshd, tunnelPids, until, wait } from './remote9.lib.ts'
import { launchFixture } from '../requests/harness.ts'
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const assert = (ok: unknown, message: string) => { if (!ok) throw Error(`FAIL: ${message}`); console.log(`ok  ${message}`) }
const mode = process.argv[2] ?? 'dark', reduced = process.env.KYBERN_REDUCED_MOTION === '1', tag = `${mode}${reduced ? '-reduced' : ''}`
const SITE_PORT = 4318, site = `${SSH_DIR}/home/site`
await startSshd(); await startDaemon(DATA_A, PORT_A); await startDaemon(DATA_B, PORT_B)
ensureProject(DATA_A, 'remote9-local'); ensureProject(DATA_B, 'remote9-over-ssh')
resetClient()
Object.assign(process.env, { KYBERN_GPUIX_KEYCHAIN_SERVICE: KEYCHAIN, KYBERN_GPUIX_CREDENTIALS_DIR: '', KYBERN_SSH: SSH_ENV.KYBERN_SSH, KYBERN_DATA_DIR: DATA_A })
const { setupSshEnvironment } = await import('./actions.ts')
const { stopSshTunnels } = await import('./ssh.ts')
const env = await setupSshEnvironment({ name: 'Remote over SSH', target: 'kybern-remote9' }, () => {})
stopSshTunnels()

// The server, on the SSH machine: started through the SSH target, bound to its loopback, logging each request.
mkdirSync(site, { recursive: true })
writeFileSync(`${site}/server.ts`, `const log = ${JSON.stringify(`${site}/requests.log`)}
Bun.serve({ hostname: '127.0.0.1', port: ${SITE_PORT}, fetch(req) {
  const url = new URL(req.url); require('node:fs').appendFileSync(log, req.method + ' ' + url.pathname + ' host=' + req.headers.get('host') + '\\n')
  if (url.pathname === '/app.js') return new Response("document.querySelector('h1').textContent = 'Served on the SSH machine · root asset loaded'; parent.postMessage({ kind: 'fixture-page', origin: location.origin, asset: true }, '*')", { headers: { 'content-type': 'text/javascript; charset=utf-8' } })
  return new Response('<!doctype html><meta name=viewport content="width=device-width"><style>body{font:15px system-ui;padding:24px;background:#e7eefc;color:#172346}h1{font-size:24px}</style><h1>Served on the SSH machine</h1><p>Through the preview relay, the SSH tunnel and the remote daemon.</p><script src="/app.js"></script>', { headers: { 'content-type': 'text/html; charset=utf-8' } })
} })
`)
writeFileSync(`${site}/requests.log`, '')
if (!(await listening(SITE_PORT))) execFileSync(`${SSH_DIR}/ssh`, ['-o', 'BatchMode=yes', 'kybern-remote9', `cd ${site} && ( trap '' HUP; exec ${process.execPath} server.ts ) >server.log 2>&1 </dev/null & echo started`], { encoding: 'utf8' })
await until('remote web server', () => listening(SITE_PORT))

const project = (JSON.parse(cli(DATA_B, 'call', 'projects.list', '{}')) as { projects: { id: string; name: string }[] }).projects.find(p => p.name === 'remote9-over-ssh')!
const thread = (JSON.parse(cli(DATA_B, 'call', 'threads.create', JSON.stringify({ project_id: project.id, provider: { kind: 'claude-code', instance: 'default' }, title: 'Preview over SSH' }))) as { id: string }).id

// --- Transport, no UI: the app's relay (`preview/relay.ts`) in front of B's ticket, reached through the SSH tunnel ---
{
  const { ensureSshTunnel } = await import('./ssh.ts')
  const { readCredential } = await import('./credentials.ts')
  const { KybernClient } = await import('../../../../packages/kybern-client/src/client.ts')
  const { httpBase } = await import('../../../../packages/kybern-client/src/address.ts')
  const { openRelay } = await import('../preview/relay.ts')
  const port = await ensureSshTunnel(env.id, env.ssh!)
  const client = new KybernClient({ url: `ws://127.0.0.1:${port}/ws`, token: readCredential(env.id) }, { createSocket: (url, token) => new WebSocket(url, { headers: { origin: 'tauri://localhost', Authorization: `Bearer ${token}` } } as never) })
  client.connect(); await until('client over the tunnel', () => client.status === 'open')
  const opened = await client.call('previews.open', { thread_id: thread, target: `http://127.0.0.1:${SITE_PORT}/`, proxy: true }) as { ticket?: string; path?: string }
  const relay = await openRelay(`${httpBase(client.endpoint.url)}${opened.path}`, httpBase(client.endpoint.url))
  const html = await (await fetch(`${relay.url.replace(/\/$/, '')}/`)).text(), js = await (await fetch(`${relay.url.replace(/\/$/, '')}/app.js`)).text()
  assert(html.includes('Served on the SSH machine') && js.includes('root asset loaded') && new URL(relay.url).port !== String(SITE_PORT), `transport: relay ${relay.url} → tunnel :${port} → B /preview-proxy → the SSH machine's server served the page and its root-absolute asset`)
  relay.close(); await client.call('previews.close', { ticket: opened.ticket! }); client.close(); stopSshTunnels()
  if (process.argv.includes('--transport-only')) { cli(DATA_B, 'call', 'threads.archive', JSON.stringify({ thread_id: thread })); process.exit(0) }
}

// UI lock queue (brief): wait for our turn, hold the lock briefly, then leave the queue.
const QUEUE = '/tmp/kybern-gpuix-ui-queue', LANE = 'remote9'
appendFileSync(QUEUE, `${LANE}\n`)
const first = () => readFileSync(QUEUE, 'utf8').split('\n').find(line => line.trim())?.trim()
await until('UI queue turn', () => first() === LANE, 20 * 60_000)
const { acquirePreviewUiLock } = await import('../../scripts/preview-ui-lock.ts')
let release: (() => void) | undefined
for (const end = Date.now() + 10 * 60_000; !release;) { try { release = acquirePreviewUiLock() } catch { if (Date.now() > end) throw Error('UI lock busy'); await wait(500) } }
const events = path.join(OUT, `preview-events-${tag}.jsonl`); writeFileSync(events, '')
const log = () => readFileSync(events, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
const fixture = await launchFixture(path.join(import.meta.dir, 'remote9-preview.fixture.ts'), { ...SSH_ENV, KYBERN_DATA_DIR: DATA_A, KYBERN_CLIENT_CONFIG_DIR: process.env.KYBERN_CLIENT_CONFIG_DIR!, KYBERN_GPUIX_ENVIRONMENT: env.id, KYBERN_GPUIX_THREAD: thread, KYBERN_R9_THREAD: thread, KYBERN_PREVIEW_EVENTS: events, KYBERN_PREVIEW_TARGET: `http://127.0.0.1:${SITE_PORT}/`, KYBERN_APPEARANCE: mode, KYBERN_REDUCED_MOTION: reduced ? '1' : '0', GPUIX_BACKGROUND: '1', KYBERN_WINDOW_SIZE: '1280x820' })
try {
  await until('preview entry', () => log().some(e => e.type === 'fixture-entry'), 60000)
  const entry = log().find(e => e.type === 'fixture-entry')
  assert(entry.ok && entry.proxy && !entry.local && entry.environment === env.id, 'the SSH environment opens the server through Kybern (proxy), not directly')
  const relay = new URL(entry.frameUrl), tunnel = new URL(entry.url)
  assert(relay.hostname === '127.0.0.1' && Number(relay.port) !== SITE_PORT && tunnel.port === String(env.ssh!.local_port) && tunnel.pathname.startsWith('/preview-proxy/'), `the page runs on the relay's loopback origin ${relay.origin}, which forwards to the tunnel ${tunnel.origin}/preview-proxy/…`)
  await until('page and root asset loaded', () => log().some(e => e.data?.kind === 'fixture-page' && e.data?.asset), 30000)
  const page = log().find(e => e.data?.kind === 'fixture-page').data
  assert(page.origin === relay.origin, 'the page and its root-absolute asset loaded on that origin')
  const requests = readFileSync(`${site}/requests.log`, 'utf8')
  assert(/GET \/ host=127\.0\.0\.1:4318/.test(requests) && /GET \/app\.js/.test(requests), 'the server on the SSH machine served both requests (through the remote daemon, Host rewritten to the server)')
  await wait(800)
  const windowNumber = log().find(e => e.type === 'created')?.windowNumber
  if (windowNumber) execFileSync('screencapture', ['-l', String(windowNumber), '-x', '-o', path.join(OUT, `r9-p-01-preview-over-ssh-${tag}.png`)])
  // Cut the tunnel: the keeper reopens it on the same port and a reload goes through again.
  const loads = () => log().filter(e => e.data?.kind === 'fixture-page' && e.data?.asset).length
  const before = loads(), [pid] = tunnelPids(); process.kill(pid!, 'SIGKILL')
  await until('tunnel back', async () => tunnelPids().length === 1 && tunnelPids()[0] !== pid && await listening(env.ssh!.local_port), 30000)
  await until('reloaded through the new tunnel', async () => { if (loads() > before) return true; try { await fixture.app.getByTestId('preview-reload').click() } catch { /* chrome busy */ } await wait(1000); return loads() > before }, 40000)
  assert(true, 'after the tunnel dropped and came back, Reload loaded the page through the relay again')
  console.log(`PASS remote9 preview relay over SSH (${tag})`)
} catch (e) { console.error(fixture.diagnostics()); throw e } finally {
  await fixture.close()
  release?.()
  writeFileSync(QUEUE, readFileSync(QUEUE, 'utf8').split('\n').filter((line, i, all) => !(line.trim() === LANE && all.findIndex(l => l.trim() === LANE) === i)).join('\n'))
  cli(DATA_B, 'call', 'threads.archive', JSON.stringify({ thread_id: thread }))
}
