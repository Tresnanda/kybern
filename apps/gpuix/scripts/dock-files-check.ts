import path from 'node:path'
import { launch } from '@gpuix/react/automation'
import { absent, openDock, painted, until } from './dock-waits.ts'
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const variant = process.argv.includes('--light') ? 'light' : 'dark'
const out = '/Users/mymac/projects/ade/previews/gpuix/dock'
let pid: number | undefined
const watchdog = setTimeout(() => { if (pid) try { process.kill(pid, 'SIGTERM') } catch {}; process.exit(1) }, 90_000)
const app = await launch({ command: 'bun', args: [path.join(import.meta.dir, '../src/main.tsx')], env: { ...process.env, GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: variant } })
try {
  pid = (await app.call('initialize', { protocolVersion: 1, client: 'dock-files-check' })).pid
  await app.getByTestId('header-title').waitFor({ timeoutMs: 30_000 })
  await app.getByTestId('dock-toggle').click()
  await openDock(app.getByTestId('right-dock'))
  for (const tab of ['changes', 'explorer']) {
    await app.getByTestId('dock-add').click()
    await app.getByTestId(`dock-add-${tab}`).waitFor({ timeoutMs: 3000 })
    await app.getByTestId(`dock-add-${tab}`).click()
    const file = app.getByTestId(tab === 'changes' ? 'dock-file-diff-dock-large.ts' : 'dock-file-dock-large.ts')
    await file.waitFor({ timeoutMs: 15_000 }); await file.click(); await painted(app.getByTestId(tab === 'changes' ? 'dock-native-diff-dock-large.ts' : 'dock-code-chunk-0'))
    await app.getByTestId('app-ready').hover()
    await app.screenshot({ path: path.join(out, `12-large-${tab}-${variant}.png`) })
    const dock = await app.getByTestId('right-dock').bounds()
    await app.mouse.wheel({ x: dock.x + dock.width - 100, y: dock.y + dock.height - 160 }, 0, tab === 'changes' ? -800 : -1180)
    if (tab === 'explorer') await until(async () => (await app.getByTestId('dock-code-chunk-64').bounds()).height >= 1280, 'next code chunk')
    await app.screenshot({ path: path.join(out, `13-large-${tab}-scroll-${variant}.png`) })
    if (tab === 'explorer') {
      await app.getByTestId('dock-file-actions').click()
      await app.getByText('Copy contents').waitFor({ timeoutMs: 3000 })
      await app.getByText('Copy contents').press('escape')
      const second = await app.getByTestId('dock-code-chunk-64').bounds()
      if (second.height < 1200) throw new Error('Second code chunk not painted after scrolling')
      await app.getByTestId('dock-tab-explorer').press('left')
      await absent(app.getByTestId('dock-file-tree'))
      if (await app.getByTestId('dock-file-tree').count()) throw new Error('Keyboard tab switch kept Explorer mounted')
      await app.getByTestId('dock-tab-changes').press('right')
      await app.getByTestId('dock-file-tree').waitFor({ timeoutMs: 3000 })
    }
  }
  console.log('[files] PASS: native diff scroll, code chunk seam, keyboard tab navigation')
} finally {
  await Promise.race([app.close(), wait(2000)])
  if (pid) try { process.kill(pid, 'SIGTERM') } catch {}
  clearTimeout(watchdog)
}
