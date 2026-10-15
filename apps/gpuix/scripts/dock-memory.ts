// Attribution run without screenshots (capture buffers can affect footprint).
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { launch } from '@gpuix/react/automation'
import { absent, openDock, painted } from './dock-waits.ts'
const run = promisify(execFile)
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const base = process.argv.includes('--base')
let pid: number | undefined
const watchdog = setTimeout(() => { if (pid) try { process.kill(pid, 'SIGTERM') } catch {}; process.exit(1) }, 240_000)
const app = await launch({ command: 'bun', args: [base ? '/Users/mymac/projects/ade-gpuix/apps/gpuix/src/main.tsx' : path.join(import.meta.dir, '../src/main.tsx')], env: { ...process.env, GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: 'dark' } })
async function sample(name: string) {
  const result = await run('bun', [path.join(import.meta.dir, '../perf/sample.ts'), '15', `GPUIX=${pid}`])
  console.log(`[memory] ${name}\n${result.stdout}`)
}
async function choose(tab: string) {
  await app.getByTestId('dock-add').click()
  await app.getByTestId(`dock-add-${tab}`).waitFor({ timeoutMs: 3000 })
  await app.getByTestId(`dock-add-${tab}`).click()
  await app.getByTestId(`dock-tab-${tab}`).waitFor({ timeoutMs: 3000 })
}
try {
  pid = (await app.call('initialize', { protocolVersion: 1, client: 'dock-memory' })).pid
  console.log(`[memory] pid=${pid} base=${base}`)
  await app.getByTestId('header-title').waitFor({ timeoutMs: 60_000 })
  await sample(base ? 'feat/gpuix-mvp closed, never opened' : 'dock branch closed, never opened')
  if (!base) {
    await app.getByTestId('dock-toggle').click()
    await openDock(app.getByTestId('right-dock'))
    await app.getByTestId('app-ready').hover()
    await sample('Agents open, settled scratch thread')
    await choose('changes')
    await app.getByTestId('dock-file-diff-dock-large.ts').waitFor({ timeoutMs: 15_000 })
    await app.getByTestId('dock-file-diff-dock-large.ts').click()
    await painted(app.getByTestId('dock-native-diff-dock-large.ts'))
    await sample('Diff open, 10,000-line file, native virtual scroller')
    await choose('explorer')
    await app.getByTestId('dock-file-dock-large.ts').waitFor({ timeoutMs: 15_000 })
    await app.getByTestId('dock-file-dock-large.ts').click()
    await painted(app.getByTestId('dock-code-chunk-0'))
    await sample('Explorer open, same file, bounded 256 KiB read / 64-line virtual chunks')
    await app.getByTestId('dock-collapse').click()
    await absent(app.getByTestId('right-dock'))
    await sample('Dock closed after unmounting big file')
  }
} finally {
  await Promise.race([app.close(), wait(2000)])
  if (pid) try { process.kill(pid, 'SIGTERM') } catch {}
  clearTimeout(watchdog)
}
