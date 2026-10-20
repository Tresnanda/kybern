import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { launch } from '@gpuix/react/automation'
import { until, openDock, painted, absent } from '../../scripts/dock-waits.ts'
const project = path.resolve('../../.p5/project'), out = '/Users/mymac/projects/ade/previews/gpuix/p5'
assert.ok(process.env.KYBERN_DATA_DIR?.includes('gpuix-scratch'))
mkdirSync(path.join(project, 'a-folder'), { recursive: true })
writeFileSync(path.join(project, 'a-folder/inside.ts'), 'export const inside = true;\n')
writeFileSync(path.join(project, 'z-long.ts'), `export const message = "${'long source '.repeat(120)}END_OF_LONG_LINE";\n`)
try {
  for (const appearance of process.argv.includes('--dark-only') ? ['dark'] : ['dark', 'light']) {
    const app = await launch({ command: 'bun', args: [path.resolve('src/main.tsx')], env: { ...process.env, GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: appearance } })
    try {
      await app.getByTestId('header-title').waitFor({ timeoutMs: 60000 })
      if (!await app.getByTestId('right-dock').count()) await app.getByTestId('app-ready').press('cmd-j')
      await openDock(app.getByTestId('right-dock'))
      await app.getByTestId('dock-add').click(); await app.getByTestId('dock-add-explorer').click()
      await app.getByTestId('dock-file-a-folder').waitFor({ timeoutMs: 10000 })
      const tree = app.getByTestId('dock-file-tree-focus')
      await tree.press('home'); await tree.press('right')
      await app.getByTestId('dock-file-a-folder/inside.ts').waitFor({ timeoutMs: 10000 })
      await tree.press('right'); await tree.press('enter'); await painted(app.getByTestId('dock-code-chunk-0'))
      await app.getByText('a-folder › inside.ts').waitFor({ timeoutMs: 10000 }); await app.screenshot({ path: `${out}/explorer-key-debug-${appearance}.png` });
      await tree.press('left'); await tree.press('left'); await absent(app.getByTestId('dock-file-a-folder/inside.ts'))
      await tree.press('end'); await tree.press('enter'); await painted(app.getByTestId('dock-code-chunk-0'))
      await app.screenshot({ path: `${out}/explorer-keys-${appearance}.png` })
      const b = await app.getByTestId('dock-file-horizontal').bounds()
      const before = await app.getByTestId('dock-code-chunk-0').bounds()
      await app.mouse.wheel({ x: b.x + b.width - 30, y: b.y + 10 }, -20000, 0)
      await until(async () => (await app.getByTestId('dock-code-chunk-0').bounds()).x < before.x - 500, 'horizontal source movement')
      await app.screenshot({ path: `${out}/explorer-horizontal-${appearance}.png` })
      await app.getByTestId('dock-collapse').click(); await absent(app.getByTestId('right-dock'))
      console.log('PASS Explorer keyboard and native horizontal scroll gesture', appearance)
    } finally { await app.close() }
  }
} finally { rmSync(path.join(project, 'a-folder'), { recursive: true, force: true }); rmSync(path.join(project, 'z-long.ts'), { force: true }) }
