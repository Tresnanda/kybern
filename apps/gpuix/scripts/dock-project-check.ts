// Coordinator dock on the scratch daemon. --write exercises revisioned brief
// saving and a reversible project switch; never targets the real daemon.
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { launch } from '@gpuix/react/automation'
import { absent, openDock, until } from './dock-waits.ts'

if (process.env.KYBERN_DATA_DIR !== '/Users/mymac/projects/ade-gpuix-scratch/data') throw new Error('Use the designated scratch daemon')
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const variant = process.argv.includes('--light') ? 'light' : 'dark'
const out = '/Users/mymac/projects/ade/previews/gpuix/dock'
mkdirSync(out, { recursive: true })
let pid: number | undefined
const watchdog = setTimeout(() => { if (pid) try { process.kill(pid, 'SIGTERM') } catch {}; process.exit(1) }, 90_000)
const app = await launch({ command: 'bun', args: [path.join(import.meta.dir, '../src/main.tsx')], env: { ...process.env, GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: variant } })
try {
  pid = (await app.call('initialize', { protocolVersion: 1, client: 'dock-project-check' })).pid
  await app.getByTestId('header-title').waitFor({ timeoutMs: 60_000 })
  await app.getByTestId('dock-toggle').click()
  await openDock(app.getByTestId('right-dock'))
  await app.getByTestId('dock-add').click()
  await app.getByTestId('dock-add-project').waitFor({ timeoutMs: 3000 })
  await app.getByTestId('dock-add-project').click()
  await app.getByTestId('dock-project-list').waitFor({ timeoutMs: 10_000 })
  await until(async () => !!await app.getByText('Edit').count() || !!await app.getByText('Write').count(), 'brief loaded')
  if (process.argv.includes('--write')) {
    const edit = app.getByTestId('dock-brief-edit')
    await edit.waitFor({ timeoutMs: 60_000 })
    await edit.click()
    await app.getByTestId('dock-brief-editor').waitFor({ timeoutMs: 3000 })
    await app.getByTestId('dock-brief-editor').fill('GPUIX dock verification project. Keep fixtures small and use the scratch daemon.')
    await app.getByTestId('dock-brief-save').click()
    await absent(app.getByTestId('dock-brief-editor'))
    if (await app.getByTestId('dock-brief-editor').count()) throw new Error('Brief did not finish saving')
    console.log('[project] saved brief')
  }
  await app.getByTestId('app-ready').hover()
  await app.screenshot({ path: path.join(out, `06-project-${variant}.png`) })
  // Native list scroll: bring the switch in view before clicking it twice.
  const dock = await app.getByTestId('right-dock').bounds()
  await app.mouse.wheel({ x: dock.x + 100, y: dock.y + dock.height - 100 }, 0, -560)
  await until(async () => { const b = await app.getByTestId('dock-project-brief-switch').bounds(); return b.y < dock.y + dock.height && b.height > 0 }, 'brief switch in viewport')
  if (process.argv.includes('--write')) {
    await app.getByTestId('dock-project-brief-switch').waitFor({ timeoutMs: 3000 })
    const control = app.getByTestId('dock-project-brief-switch')
    const color = async () => {
      const result = await promisify(execFile)('/Applications/kybern.app/Contents/MacOS/kybern', ['--data-dir', process.env.KYBERN_DATA_DIR!, 'projects', 'list', '--json'])
      return JSON.parse(result.stdout).projects.find((p: { id: string }) => p.id === '01a13e25-5696-7933-b9d1-c1aae8fb876d').brief_in_all_threads as boolean
    }
    const before = await color()
    await control.click()
    await until(async () => await color() !== before, 'brief switch saved')
    await control.click()
    await until(async () => await color() === before, 'brief switch restored')
    console.log('[project] brief switch changed and restored')
  }
  await app.screenshot({ path: path.join(out, `07-project-settings-${variant}.png`) })
  console.log('[project] PASS')
} finally {
  await Promise.race([app.close(), wait(2000)])
  if (pid) try { process.kill(pid, 'SIGTERM') } catch {}
  clearTimeout(watchdog)
}
