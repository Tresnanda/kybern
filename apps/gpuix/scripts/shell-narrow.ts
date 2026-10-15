/** Narrow window: a saved 480px panel shrinks to leave the dock's 416px (seam 476 at 900px wide). */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { launch } from '@gpuix/react/automation'
const data = process.env.KYBERN_DATA_DIR!
writeFileSync(path.join(data, 'gpuix-ui.json'), JSON.stringify({ 'kybern.sidebar.width': 480, 'kybern.window.frame': '100 100 900 640 0 0 1440 900 ' }))
const app = await launch({ command: 'bun', args: [path.join(import.meta.dir, '../src/main.tsx')], env: { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: 'dark', KYBERN_DATA_DIR: data } })
await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
await new Promise((r) => setTimeout(r, 3000))
const b = await app.getByTestId('sidebar-resize').bounds()
console.log('seam at', b.x + 8, '(expected 476)')
await app.close()
