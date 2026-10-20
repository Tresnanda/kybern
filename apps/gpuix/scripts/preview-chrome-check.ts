import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { KybernClient } from '../../../packages/kybern-client/src/client.ts'
import { launchFixture, waitForPainted } from '../src/requests/harness.ts'
import { acquirePreviewUiLock } from './preview-ui-lock.ts'
async function main() {
const scratch = '/Users/mymac/projects/ade-gpuix-scratch/round6/preview', data = path.join(scratch, 'data'), out = '/Users/mymac/projects/ade/previews/gpuix/round6/preview'
mkdirSync(out, { recursive: true }); mkdirSync(path.join(scratch, 'project/mock/deep'), { recursive: true })
const client = new KybernClient({ url: `ws://127.0.0.1:${readFileSync(path.join(data, 'daemon.port'), 'utf8').trim()}/ws`, token: readFileSync(path.join(data, 'daemon.token'), 'utf8').trim() })
client.connect(); while (client.status !== 'open') await Bun.sleep(30)
let project = (await client.call('projects.list', {})).projects.find(p => p.name === 'scratch-project')
if (!project) project = await client.call('projects.add', { path: path.join(scratch, 'project'), name: 'scratch-project' })
const thread = await client.call('threads.create', { project_id: project.id, title: 'Preview chrome verification', provider: { kind: 'claude-code', instance: 'default' }, model: 'claude-haiku-5-5' })
const file = path.join(project.path, 'mock/index.html'), next = path.join(project.path, 'mock/deep/next.html')
const html = (name: string, content = '') => `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>${name}</title><style>body{font:14px system-ui;padding:20px;background:#e9eef8;color:#172346}h1{font-size:24px}button,input{font:inherit;padding:8px;border-radius:6px}</style><h1>${name}</h1>${content}<script>parent.postMessage({kind:'fixture-page',name:${JSON.stringify(name)},path:location.pathname+location.search+location.hash},'*');addEventListener('message',e=>{if(e.data?.kind==='fixture-next')location.href='deep/next.html?mode=1#step'})</script>`
writeFileSync(file, html('File index', '<p>Use the address and reload controls.</p>')); writeFileSync(next, html('Bridge page', '<p>Bridge reload must retain this page, query and fragment.</p>'))
const requests: string[] = []
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const u = new URL(req.url); requests.push(u.pathname + u.search)
  if (u.pathname === '/asset.js') return new Response(`parent.postMessage({kind:'fixture-server',path:location.pathname+location.search},'*')`, { headers: { 'content-type': 'text/javascript' } })
  if (u.pathname === '/slow') await Bun.sleep(1000)
  return new Response(html('Local app', '<input placeholder="Edit the app"><script src="/asset.js"></script>'), { headers: { 'content-type': 'text/html', ...(u.pathname === '/blocked' ? { 'x-frame-options': 'DENY' } : {}) } })
} })
const serverUrl = `http://127.0.0.1:${server.port}`
try {
  for (const appearance of ['dark', 'light']) for (const reduced of ['0', '1']) {
    const tag = `${appearance}-${reduced === '1' ? 'reduced' : 'normal'}`
    if (process.env.KYBERN_PREVIEW_CASE && process.env.KYBERN_PREVIEW_CASE !== tag) continue
    const events = path.join(out, `chrome-events-${tag}.jsonl`); writeFileSync(events, '')
    const fixture = await launchFixture(path.join(import.meta.dir, 'preview-chrome.fixture.ts'), { KYBERN_DATA_DIR: data, KYBERN_CLIENT_CONFIG_DIR: path.join(scratch, `client-${tag}`), KYBERN_GPUIX_CREDENTIALS_DIR: path.join(scratch, 'credentials'), KYBERN_GPUIX_THREAD: thread.id, KYBERN_APPEARANCE: appearance, KYBERN_REDUCED_MOTION: reduced, GPUIX_BACKGROUND: '1', KYBERN_PREVIEW_EVENTS: events, KYBERN_PREVIEW_TARGET: file, KYBERN_WINDOW_SIZE: '1280x820', NAPI_RS_NATIVE_LIBRARY_PATH: '/Users/mymac/projects/ade-gpuix/apps/gpuix/native/build/gpuix-native.darwin-arm64.node' })
    const a = fixture.app, log = () => readFileSync(events, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    const wait = async (predicate: () => boolean, label: string) => { const deadline = Date.now() + 15000; while (!predicate()) { if (Date.now() > deadline) throw Error(`${label}: ${fixture.diagnostics()}\n${JSON.stringify(log().slice(-25))}`); await Bun.sleep(30) } }
    const count = (name: string) => log().filter(e => e.data?.kind === 'fixture-page' && e.data.name === name).length
    let window = 0
    const shot = (name: string) => execFileSync('screencapture', ['-l', String(window), '-x', path.join(out, `${name}-${tag}.png`)])
    const openAddress = async (value: string) => { await a.getByTestId('preview-address-rest').click(); await a.getByTestId('preview-address').fill(value); await a.getByTestId('preview-address').press('enter') }
    try {
      await a.getByTestId('dock-preview').waitFor(); await wait(() => count('File index') === 1, 'file load'); window = log().find(e => e.type === 'created').windowNumber
      await a.getByTestId('preview-address-rest').waitFor(); await waitForPainted(a, 'scratch-project'); shot('chrome-file')
      await a.getByTestId('preview-address-rest').click(); await a.getByTestId('preview-address').fill('unfinished address'); await a.getByTestId('preview-address').press('escape'); await a.getByTestId('preview-address-rest').waitFor(); assert.equal(count('File index'), 1)
      await a.getByTestId('app-ready').press('cmd-l'); await a.getByTestId('preview-address').waitFor(); await a.getByTestId('preview-address').press('escape')
      await a.getByTestId('app-ready').press('ctrl-alt-g'); await wait(() => count('Bridge page') === 1 && log().some(e => e.type === 'state' && e.pagePath === 'mock/deep/next.html?mode=1#step'), 'bridge navigation')
      await a.getByTestId('preview-reload').click(); await wait(() => count('Bridge page') === 2, 'reload at bridge path'); assert.equal(count('File index'), 1)
      await a.getByTestId('preview-more').click(); await a.getByTestId('preview-explorer').click(); await waitForPainted(a, 'next.html'); await a.getByTestId('dock-file-mock/deep/next.html').waitFor(); await waitForPainted(a, 'Bridge reload must retain'); shot('chrome-explorer')
      await a.getByTestId('app-ready').press('cmd-l'); await a.getByTestId('preview-address').waitFor(); await a.getByTestId('preview-address').press('escape')
      await a.getByTestId('preview-more').click(); await a.getByTestId('preview-fresh').click(); await wait(() => count('Bridge page') === 3, 'fresh ticket at bridge path'); assert.equal(count('File index'), 1); shot('chrome-bridge-reload')
      await openAddress(`${serverUrl}/blocked`)
      await waitForPainted(a, "can't be shown in a panel"); shot('chrome-blocked'); await a.getByTestId('preview-allow-proxy').click(); await wait(() => log().some(e => e.data?.kind === 'fixture-server' && e.data.path === '/blocked'), 'proxy strips frame restriction')
      await a.getByTestId('preview-more').click(); await a.getByTestId('preview-proxy').click(); await waitForPainted(a, "can't be shown in a panel")
      await openAddress(`${serverUrl}/nested/page?mode=1`); await wait(() => log().some(e => e.data?.kind === 'fixture-server' && e.data.path === '/nested/page?mode=1'), 'nested server direct')
      await a.getByTestId('preview-more').click(); await a.getByTestId('preview-proxy').click(); await wait(() => log().filter(e => e.data?.kind === 'fixture-server' && e.data.path === '/nested/page?mode=1').length >= 2, 'nested server relay')
      await a.getByTestId('preview-more').click(); await a.getByTestId('preview-fresh').click(); await wait(() => log().some(e => e.data?.kind === 'fixture-server' && e.data.path.includes('__kybern_reload=')), 'server reload without cache'); shot('chrome-server')
      await openAddress(`${serverUrl}/slow`); await a.getByTestId('preview-loading').waitFor(); await a.getByTestId('preview-reload').click(); await wait(() => log().at(-1)?.loading === false || log().some(e => e.type === 'state' && e.loading === false && e.address === `${serverUrl}/slow`), 'stop loading'); await wait(() => log().some(e => e.type === 'state' && !e.busy && e.address === `${serverUrl}/slow`), 'slow request settled'); await a.getByTestId('preview-address-rest').waitFor()
      await openAddress('http://127.0.0.1:4257/'); await waitForPainted(a, 'Waiting for the server'); shot('chrome-waiting')
      await a.getByTestId('preview-more').click(); await a.getByTestId('preview-close').click(); await a.getByTestId('preview-recent-0').waitFor(); shot('chrome-recents'); await a.getByTestId('preview-forget-0').click()
      console.log(`PASS ${tag}: segmented address/edit/Escape/Command-L; bridge reload + fresh ticket; Explorer ancestors; blocked/proxy toggle; nested server/assets; no-cache; loading/stop; waiting; recents/remove`)
    } catch (error) { if (window) shot('chrome-failed'); console.error((await a.call('getPaintedText', {})).text.join('\n')); console.error(fixture.diagnostics()); throw error }
    finally { await fixture.close(); const deadline = Date.now() + 3000; for (;;) { try { process.kill(fixture.pid, 0) } catch { break } if (Date.now() > deadline) throw Error('Preview fixture did not stop'); await Bun.sleep(30) } }
  }
} finally { server.stop(true); await client.call('threads.archive', { thread_id: thread.id }); client.close() }
assert.ok(requests.some(req => req.startsWith('/nested/page?mode=1')))

}
const release = acquirePreviewUiLock()
try { await main() } finally { release() }
