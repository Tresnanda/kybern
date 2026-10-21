/**
 * Smoke-check the packaged Intel app on Apple Silicon: `dist/Kybern GPUIX (x86_64 test).app` built
 * with `bun scripts/package-app.ts --arch x64 --test` runs under Rosetta with its own x86_64 kybernd.
 * Needs macOS 27 or earlier (macOS 28 drops Rosetta for apps). Each launch makes macOS 27 post a
 * Rosetta-retirement notice naming the bundle, so run it sparingly and only on the test identity.
 * Seeds a fresh scratch daemon with a settled thread (Markdown, code, a table and a Mermaid
 * diagram, which renders in the hidden WKWebView) and a running one (live loader), launches
 * the bundle on each, confirms the process is translated, and writes window screenshots.
 *
 *   INTEL_SCRATCH=/Users/mymac/projects/ade-gpuix-scratch/intel113 INTEL_PORT=4387 \
 *     bun packaging/rosetta-check.ts <out dir>
 */
import { Database } from 'bun:sqlite'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { KybernClient } from '../../../packages/kybern-client/src/client.ts'
import { launchFixture } from './harness.ts'

const SCRATCH = process.env.INTEL_SCRATCH ?? '/Users/mymac/projects/ade-gpuix-scratch/intel113'
if (!SCRATCH.includes('gpuix-scratch')) throw Error('INTEL_SCRATCH must be under gpuix-scratch')
const PORT = Number(process.env.INTEL_PORT ?? 4387)
const OUT = path.resolve(process.argv[2] ?? 'screenshots/rosetta')
const APP = path.resolve(import.meta.dir, '../dist/Kybern GPUIX (x86_64 test).app')
const bundle = `${APP}/Contents`
const archs = (file: string) => execFileSync('lipo', ['-archs', file], { encoding: 'utf8' }).trim()
const bundleId = () => execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', `${bundle}/Info.plist`], { encoding: 'utf8' }).trim()
if (!existsSync(bundle) || archs(`${bundle}/MacOS/Kybern GPUIX`) !== 'x86_64' || bundleId() !== 'dev.kybern.gpuix.test') throw Error('Package the Intel test app first: bun scripts/package-app.ts --arch x64 --test')

// <sys/proc.h> P_TRANSLATED: the process runs under Rosetta.
const translated = (pid: number) => (Number.parseInt(execFileSync('ps', ['-o', 'flags=', '-p', String(pid)], { encoding: 'utf8' }).trim(), 16) & 0x20000) !== 0

rmSync(SCRATCH, { recursive: true, force: true })
const DATA = path.join(SCRATCH, 'data')
// The app keeps per-data-dir view state outside it (see src/shell/verify.fixture.ts); clear it so each launch opens its own thread.
const viewKey = createHash('sha1').update(DATA).digest('hex').slice(0, 12)
const clearViewState = () => { for (const kind of ['workspace', 'appearance']) rmSync(path.join(homedir(), 'Library/Application Support/kybern-gpuix', `${kind}-${viewKey}.json`), { force: true }) }
mkdirSync(DATA, { recursive: true }); mkdirSync(OUT, { recursive: true })
const daemon = spawn(`${bundle}/MacOS/kybernd`, ['--data-dir', DATA, '--port', String(PORT)], { stdio: 'ignore' })
const report: Record<string, unknown> = { daemonTranslated: false }
try {
  for (let i = 0; i < 300 && !(existsSync(path.join(DATA, 'daemon.token')) && existsSync(path.join(DATA, 'daemon.port'))); i++) await Bun.sleep(100)
  report.daemonTranslated = translated(daemon.pid!)
  const token = readFileSync(path.join(DATA, 'daemon.token'), 'utf8').trim()
  const client = new KybernClient({ url: `ws://127.0.0.1:${PORT}/ws`, token }, { createSocket: (url, t) => new WebSocket(url, { headers: { origin: 'tauri://localhost', Authorization: `Bearer ${t}` } } as unknown as string[]) })
  await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(Error('daemon timeout')), 20000); client.onStatus(s => { if (s === 'open') { clearTimeout(timer); resolve() } }); client.connect() })

  const repo = path.join(SCRATCH, 'intel-app')
  mkdirSync(repo, { recursive: true })
  writeFileSync(path.join(repo, 'README.md'), '# intel-app\n')
  const git = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'f@x.io', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'f@x.io' }
  for (const a of [['init', '-q', '-b', 'main'], ['add', '.'], ['commit', '-q', '-m', 'Initial commit']]) Bun.spawnSync(['git', ...a], { cwd: repo, env: git })
  const project = await client.call('projects.add', { path: repo, name: 'intel-app' })
  const create = (title: string) => client.call('threads.create', { project_id: project.id, provider: { kind: 'claude-code', instance: 'default' }, permission_mode: 'supervised', title })
  const settled = await create('Intel Mac under Rosetta')
  const running = await create('Running turn')
  client.close()

  const db = new Database(path.join(DATA, 'state.sqlite'))
  db.exec('PRAGMA busy_timeout = 5000')
  const insert = db.prepare('INSERT INTO events(thread_id, turn_id, at, kind, payload) VALUES (?1, ?2, ?3, ?4, ?5)')
  const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString()
  const user = (thread: string, turn: string, at: number, text: string) => insert.run(thread, turn, ago(at), 'turn_started', JSON.stringify({ kind: 'turn_started', message_id: randomUUID(), message: { parts: [{ type: 'text', text }] } }))
  let turn = randomUUID()
  user(settled.id, turn, 300, 'Does GPUIX run on an Intel Mac?')
  insert.run(settled.id, turn, ago(290), 'assistant_message_completed', JSON.stringify({ kind: 'assistant_message_completed', message_id: randomUUID(), origin: { kind: 'root' }, thinking: null, text: [
    '## Intel build', '', 'This window is the **x86_64** bundle, translated by Rosetta:', '',
    '- `gpuix-native.darwin-x64.node`, cross-built from arm64', '- universal `kybern-webview.dylib` and `notifications.dylib`', '- an x86_64 `kybernd` serving this thread', '',
    '| Piece | Arch |', '| --- | --- |', '| Bun runtime | x86_64 |', '| Addon | x86_64 |', '',
    '```ts', "export const PLATFORM_KEY = `darwin-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-gpuix`", '```', '',
    '```mermaid', 'flowchart LR', '  A[package-app --arch x64] --> B[Kybern GPUIX.app]', '  B --> C{Rosetta}', '  C --> D[Metal on the Apple GPU]', '```',
  ].join('\n') }))
  insert.run(settled.id, turn, ago(280), 'turn_completed', JSON.stringify({ kind: 'turn_completed', stop_reason: 'completed', usage: { input_tokens: 1200, output_tokens: 300 }, cost_usd: null, duration_ms: 9000 }))
  turn = randomUUID()
  user(running.id, turn, 20, 'Keep working while I watch the loader.')
  insert.run(running.id, turn, ago(15), 'assistant_message_completed', JSON.stringify({ kind: 'assistant_message_completed', message_id: randomUUID(), origin: { kind: 'root' }, thinking: null, text: 'Measuring the compositor loops under Rosetta.' }))
  db.close()

  for (const [name, thread] of [['settled', settled.id], ['running', running.id]] as const) {
    clearViewState()
    const begin = performance.now()
    const f = await launchFixture('', {
      KYBERN_GPUIX_APP: APP, GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: 'dark', KYBERN_DATA_DIR: DATA, KYBERN_URL: '', KYBERN_TOKEN: '',
      // Per launch: a shared client config would reopen the previous launch's thread.
      KYBERN_CLIENT_CONFIG_DIR: path.join(SCRATCH, `client-${name}`), KYBERN_GPUIX_CREDENTIALS_DIR: path.join(SCRATCH, 'credentials'),
      KYBERN_GPUIX_ENVIRONMENT: 'local', KYBERN_GPUIX_THREAD: thread, KYBERN_DISABLE_UPDATES: '1', KYBERN_MERMAID_DEBUG: '1',
    })
    try {
      const entry: Record<string, unknown> = { readyMs: Math.round(performance.now() - begin), translated: translated(f.pid) }
      // Open the thread from the sidebar: the first visible thread can win the launch selection.
      const row = f.app.getByTestId(`thread-${thread}`)
      await row.waitFor({ timeoutMs: 15000 })
      await row.click()
      if (name === 'settled') {
        await f.app.getByTestId('mermaid-block').waitFor({ timeoutMs: 30000 })
        // Let the hidden WKWebView render the diagram and GPUI swap in the image.
        for (let i = 0; i < 60 && !/\[mermaid\]/.test(f.diagnostics()); i++) await Bun.sleep(250)
        entry.mermaidLog = f.diagnostics().split('\n').filter(line => line.includes('[mermaid]')).map(line => line.slice(0, 160))
      }
      await Bun.sleep(2500)
      entry.painted = (await f.app.call('getPaintedText', {})).text.join(' ').slice(0, 400)
      await f.app.screenshot({ path: path.join(OUT, `intel-rosetta-${name}.png`) })
      const sample = Bun.spawnSync(['bun', path.resolve(import.meta.dir, '../perf/sample.ts'), '10', `${name}=${f.pid}`])
      entry.sample = sample.stdout.toString().trim()
      report[name] = entry
    } finally { await f.close() }
  }
} finally {
  daemon.kill('SIGTERM')
  clearViewState()
}
writeFileSync(path.join(OUT, 'rosetta-report.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
