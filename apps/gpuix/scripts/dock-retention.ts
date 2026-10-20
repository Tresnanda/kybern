// No screenshots: inspect memory after each file is opened and unmounted.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { launch } from '@gpuix/react/automation'
import { absent, openDock, painted } from './dock-waits.ts'
const run = promisify(execFile)
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
let pid: number | undefined
const watchdog = setTimeout(() => { if (pid) try { process.kill(pid, 'SIGTERM') } catch {}; process.exit(1) }, 300_000)
const app = await launch({ command: 'bun', args: [path.join(import.meta.dir, '../src/main.tsx')], env: { ...process.env, GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: 'dark' } })
async function sample(label: string) {
  const result = await run('bun', [path.join(import.meta.dir, '../perf/sample.ts'), '15', `GPUIX=${pid}`])
  console.log(`[retention] ${label}\n${result.stdout}`)
}
try {
  pid = (await app.call('initialize', { protocolVersion: 1, client: 'dock-retention' })).pid
  console.log(`[retention] pid=${pid}`)
  await app.getByTestId('header-title').waitFor({ timeoutMs: 60_000 })
  await sample('fresh closed')
  const files = process.argv.includes('--short') ? ['dock-large.ts'] : ['dock-large.ts', 'dock-large.ts', 'dock-large-second.ts']
  for (const [index, file] of files.entries()) {
    await app.getByTestId('dock-toggle').click()
    await openDock(app.getByTestId('right-dock'))
    await app.getByTestId('dock-add').click()
    await app.getByTestId('dock-add-explorer').waitFor({ timeoutMs: 3000 })
    await app.getByTestId('dock-add-explorer').click()
    await app.getByTestId(`dock-file-${file}`).waitFor({ timeoutMs: 15_000 })
    await app.getByTestId(`dock-file-${file}`).click()
    await app.getByTestId('dock-file-content').waitFor({ timeoutMs: 30_000 })
    if (await app.getByTestId('dock-code-chunk-0').count()) await painted(app.getByTestId('dock-code-chunk-0'))
    await sample(`open ${index + 1}: ${file}`)
    await app.getByTestId('dock-collapse').click()
    await absent(app.getByTestId('right-dock'))
    if (await app.getByTestId('dock-file-content').count()) throw new Error('File stayed mounted after close')
    await sample(`closed ${index + 1}`)
  }
} finally {
  await Promise.race([app.close(), wait(2000)])
  if (pid) try { process.kill(pid, 'SIGTERM') } catch {}
  clearTimeout(watchdog)
}
