import { readFileSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { launch } from '@gpuix/react/automation'
import { KybernClient } from '../../../packages/kybern-client/src/client.ts'
import { until, openDock, absent } from './dock-waits.ts'
const data = (process.env.KYBERN_DATA_DIR ?? '/Users/mymac/projects/ade-gpuix-scratch/data'), out = '/Users/mymac/projects/ade/previews/gpuix/dock2'
mkdirSync(out, { recursive: true })
const port = readFileSync(`${data}/daemon.port`, 'utf8').trim(), token = readFileSync(`${data}/daemon.token`, 'utf8').trim()
const client = new KybernClient({ url: `ws://127.0.0.1:${port}/ws`, token }, { createSocket: (url, key) => new WebSocket(url, { headers: { origin: 'tauri://localhost', Authorization: `Bearer ${key}` } } as unknown as string[]) })
const ready = new Promise<void>(resolve => client.onStatus(s => { if (s === 'open') resolve() })); client.connect(); await ready
const project = (await client.call('projects.list', {})).projects.find(p => p.name === 'scratch-project')!
assert.ok(project)
const thread = await client.call('threads.create', { project_id: project.id, title: 'Dock2 runtime verification', provider: { kind: 'claude-code', instance: 'default' }, model: 'claude-haiku-5-5' })
let app: Awaited<ReturnType<typeof launch>> | undefined, pid: number | undefined
const perf = process.argv.includes('--perf'), live = process.argv.includes('--live'), populated = process.argv.includes('--populated')
const artifactPath = path.join(project.path, `dock2-artifact-${thread.id}.md`)
if (populated) writeFileSync(artifactPath, '# Scratch artifact\n\nA **formatted** local preview.\n\n- Source stays on your machine.\n- No publication action runs in verification.\n')
const portProbe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') }), controlPort = portProbe.port!
portProbe.stop(true)
const control = async (action = 'status') => await (await fetch(`http://127.0.0.1:${controlPort}/${action}`)).json() as { frames: number; visible: boolean }
const guard = setTimeout(() => { if (pid) process.kill(pid, 'SIGTERM'); process.exit(1) }, 600000)
const sample = async (label: string) => { const child: { stdout: ReadableStream; exited: Promise<number> } = Bun.spawn(['bun', 'perf/sample.ts', '15', `GPUIX=${pid}`], { stdout: 'pipe' }); console.log(`${label}\n${await new Response(child.stdout).text()}`); assert.equal(await child.exited, 0) }
const cleanTerminals = async () => { for (const tab of (await client.call('terminals.list', { thread_id: thread.id })).terminals) await client.call('terminals.close', { terminal_id: tab.id }) }
try {
  for (const appearance of perf ? ['dark', 'dark'] : ['dark', 'light']) {
    app = await launch({ command: 'bun', args: [path.resolve('scripts/dock2-fixture.tsx')], env: { ...process.env, GPUIX_BACKGROUND: '1', KYBERN_DATA_DIR: data, KYBERN_GPUIX_THREAD: thread.id, KYBERN_APPEARANCE: appearance, ...(live ? { DOCK2_LIVE: '1', DOCK2_CONTROL_PORT: String(controlPort) } : {}), ...(populated ? { DOCK2_POPULATED: '1', DOCK2_ARTIFACT: artifactPath } : {}) } })
    pid = (await app.call('initialize', { protocolVersion: 1, client: 'dock2-runtime' })).pid
    await app.getByTestId('header-title').waitFor({ timeoutMs: 60000 })
    if (live) {
      await control('show')
      await app.getByTestId('computer-live').waitFor({ timeoutMs: 30000 })
      if (perf) {
        await sample('live frame polling fixture')
        await control('minimize'); await until(async () => !(await control()).visible, 'native minimized visibility')
        const hidden = (await control()).frames
        await sample('live minimized')
        assert.equal((await control()).frames, hidden, 'minimized window stops polling')
        await control('show'); await until(async () => (await control()).frames > hidden, 'polling resumes after restore')
      }
      else { await app.screenshot({ path: `${out}/live-${appearance}.png` }); await app.getByTestId('computer-live-drag').dragBy(-350, 380); await app.getByTestId('computer-live-image').waitFor({ timeoutMs: 3000 }); await app.screenshot({ path: `${out}/live-snap-${appearance}.png` }) }
      await control('show')
      let closePoint = { x: 0, y: 0 }
      await until(async () => { const b = await app!.getByTestId('computer-live-close').bounds(); closePoint = { x: b.x + b.width / 2, y: b.y + b.height / 2 }; return b.width > 0 }, 'live controls painted')
      await app.mouse.click(closePoint); await absent(app.getByTestId('computer-live'))
      if (perf) {
        const start = (await control()).frames
        await sample('live dismissed')
        assert.equal((await control()).frames, start, 'dismissed card stops polling')
      }
    } else {
      await app.getByTestId('app-ready').press('cmd-j'); await openDock(app.getByTestId('right-dock'))
      for (const tab of populated ? ['review', 'artifacts'] : ['review', 'artifacts', 'preview', 'terminal']) {
        console.log('panel', tab, appearance)
        await app.getByTestId('dock-add').click(); await app.getByTestId(`dock-add-${tab}`).click(); await app.getByTestId(`dock-${tab}`).waitFor({ timeoutMs: 30000 })
        if (tab === 'review' && !populated) await app.getByText('No pull request is linked to this branch.').waitFor({ timeoutMs: 30000 })
        if (tab === 'review' && populated) {
          await app.getByText('Keep the latest output visible').waitFor({ timeoutMs: 30000 })
          if (!perf) {
            await app.screenshot({ path: `${out}/review-populated-${appearance}.png` })
            await app.getByTestId('pr-tab-changes').click(); await app.getByTestId('pr-native-diff').waitFor({ timeoutMs: 30000 })
            const b = await app.getByTestId('pr-native-diff').bounds(); assert.ok(b.width > 250 && b.height > 150)
            await app.screenshot({ path: `${out}/review-changes-${appearance}.png` })
            await app.getByTestId('pr-review').click(); await app.getByTestId('pr-review-body').waitFor({ timeoutMs: 5000 }); await app.screenshot({ path: `${out}/review-popover-${appearance}.png` }); await app.getByTestId('pr-review-popover').press('escape')
          }
        }
        if (tab === 'artifacts' && populated) {
          await app.getByTestId('artifact-1').waitFor({ timeoutMs: 30000 })
          if (!perf) {
            await app.screenshot({ path: `${out}/artifacts-populated-${appearance}.png` })
            await app.getByTestId('artifact-1').getByText('Preview').click(); await app.getByType('markdown').waitFor({ timeoutMs: 30000 }); await app.screenshot({ path: `${out}/artifacts-markdown-${appearance}.png` })
            await app.getByText('Source').click(); await app.getByTestId('dock-code-chunk-0').waitFor({ timeoutMs: 30000 }); await app.screenshot({ path: `${out}/artifacts-source-${appearance}.png` })
            await app.getByText('Back').click()
          }
        }
        if (tab === 'preview' && !perf) { await app.getByTestId('preview-more').click(); await app.getByTestId('preview-device').click(); await app.getByTestId('preview-device-toolbar').waitFor({ timeoutMs: 3000 }); await app.getByTestId('preview-rotate').click() }
        if (tab === 'terminal') {
          await app.getByTestId('terminal-screen').waitFor({ timeoutMs: 30000 })
          let terminalId = ''
          await until(async () => { terminalId = (await client.call('terminals.list', { thread_id: thread.id })).terminals.find(t => t.alive)?.id ?? ''; return !!terminalId }, 'terminal creation')
          if (!perf) {
            for (const key of ['p', 'w', 'd', 'enter']) await app.getByTestId('terminal-screen').press(key)
            await until(async () => !!await app!.getByText(project.path).count(), 'native pwd output')
            await client.call('terminals.input', { terminal_id: terminalId, data: Buffer.from("printf '\\033[32mNative terminal ready\\033[0m\\n'; printf '\\033[34mANSI colors, cursor movement and bounded scrollback\\033[0m\\n'\n").toString('base64') })
            await until(async () => !!await app!.getByText('Native terminal ready').count(), 'ANSI output')
          }
          if (perf) {
            await sample('terminal idle')
            const measure = sample('terminal 200000 lines')
            let finished = false
            const off = client.onNotification('terminal.output', p => { const e = p as { terminal_id: string; data: string }; if (e.terminal_id === terminalId && Buffer.from(e.data, 'base64').toString().includes('\r\n__DOCK2_DONE__\r\n')) finished = true })
            await client.call('terminals.subscribe', { terminal_id: terminalId, replay: false })
            const start = performance.now()
            await client.call('terminals.input', { terminal_id: terminalId, data: Buffer.from('yes | head -n 200000; printf "\\n__DOCK2_DONE__\\n"\n').toString('base64') })
            await until(async () => finished, 'high-output terminal command')
            console.log('200000 lines completed ms', performance.now() - start)
            off(); await client.call('terminals.unsubscribe', { terminal_id: terminalId }); await measure
            await app.getByTestId('terminal-bottom').click(); await until(async () => !!await app!.getByText('__DOCK2_DONE__').count(), 'terminal final output')
          }
          await app.getByTestId('terminal-screen').press('cmd-j'); await absent(app.getByTestId('dock-terminal'))
          await app.getByTestId('app-ready').press('cmd-j'); await openDock(app.getByTestId('right-dock')); await app.getByTestId('terminal-screen').waitFor({ timeoutMs: 30000 })
        } else if (perf) await sample(tab)
        if (!perf) { await app.getByTestId('app-ready').hover(); await app.screenshot({ path: `${out}/${tab}-${appearance}.png` }) }
      }
      if (!perf && !populated) { await app.getByTestId('app-ready').press('cmd-alt-p'); await app.getByTestId('preview-mini').waitFor({ timeoutMs: 10000 }); await app.screenshot({ path: `${out}/preview-mini-${appearance}.png` }); await app.getByTestId('app-ready').press('cmd-alt-p'); await absent(app.getByTestId('preview-mini')) }
    }
    await app.close(); app = undefined; pid = undefined; await cleanTerminals()
  }
  console.log('PASS runtime dock checks')
} finally {
  if (app) await app.close()
  if (pid) try { process.kill(pid, 'SIGTERM') } catch {}
  if (populated) unlinkSync(artifactPath)
  await cleanTerminals(); await client.call('threads.archive', { thread_id: thread.id }); client.close(); clearTimeout(guard)
}
