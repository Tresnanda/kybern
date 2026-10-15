import path from 'node:path'
import { launch } from '@gpuix/react/automation'
const out = process.argv[2]!
const app = await launch({ command: 'bun', args: [path.join(import.meta.dir, 'shell-appearance.tsx')], env: { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: process.env.START ?? '' } })
await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
const w = (ms: number) => new Promise((r) => setTimeout(r, ms))
await w(1000)
console.log('before:', await app.getByTestId('variant').textContent())
await app.screenshot({ path: path.join(out, 'appearance-before.png') })
await w(3000)
console.log('after:', await app.getByTestId('variant').textContent())
await app.screenshot({ path: path.join(out, 'appearance-after.png') })
await app.close()
