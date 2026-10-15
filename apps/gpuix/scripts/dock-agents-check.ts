// Read-only inspection of an existing thread's populated lineage and activity.
// Never clicks stop, archive, remove, or sends a message.
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { launch } from '@gpuix/react/automation'
import { openDock, until } from './dock-waits.ts'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const variant = process.argv.includes('--light') ? 'light' : 'dark'
const out = '/Users/mymac/projects/ade/previews/gpuix/dock'
mkdirSync(out, { recursive: true })
let pid: number | undefined
const watchdog = setTimeout(() => { if (pid) try { process.kill(pid, 'SIGTERM') } catch {}; process.exit(1) }, 180_000)
const app = await launch({ command: 'bun', args: [path.join(import.meta.dir, '../src/main.tsx')], env: { ...process.env, GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: variant } })
try {
  pid = (await app.call('initialize', { protocolVersion: 1, client: 'dock-agents-check' })).pid
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 20_000 })
  await app.getByTestId('header-title').waitFor({ timeoutMs: 60_000 })
  await app.getByTestId('dock-toggle').click()
  await openDock(app.getByTestId('right-dock'))
  await app.screenshot({ path: path.join(out, `09-lineage-loading-${variant}.png`) })
  await app.getByTestId('dock-agents-list').waitFor({ timeoutMs: 60_000 })
  await app.getByTestId('app-ready').hover()
  await app.screenshot({ path: path.join(out, `09-lineage-${variant}.png`) })
  const tree = (await app.call('getTree', {})).tree
  function find(node: typeof tree): string | undefined {
    if (!node) return
    if (node.testId?.startsWith('dock-agent-') && !node.testId.startsWith('dock-agent-tree-')) return node.testId
    for (const child of node.children ?? []) { const id = find(child); if (id) return id }
  }
  const row = find(tree)
  if (!row) throw new Error('Expected a populated lineage')
  await app.getByTestId(row).click()
  await until(async () => !!await app.getByText('Open').count(), 'agent detail')
  await app.screenshot({ path: path.join(out, `10-lineage-detail-${variant}.png`) })
  await app.getByTestId('dock-add').click()
  await app.getByTestId('dock-add-activity').waitFor({ timeoutMs: 3000 })
  await app.getByTestId('dock-add-activity').click()
  await app.getByTestId('dock-activity-list').waitFor({ timeoutMs: 60_000 })
  await app.screenshot({ path: path.join(out, `11-activity-${variant}.png`) })
  console.log('[agents] PASS: populated lineage, disclosure, Activity')
} finally {
  await Promise.race([app.close(), wait(2000)])
  if (pid) try { process.kill(pid, 'SIGTERM') } catch {}
  clearTimeout(watchdog)
}
