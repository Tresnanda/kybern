import path from 'node:path'
import { launch } from '@gpuix/react/automation'
const app = await launch({ command: 'bun', args: [path.join(import.meta.dir, 'backdrop-lab.tsx')], env: { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: process.argv[3] ?? 'light', KYBERN_REDUCED_MOTION: '1', ...(process.env as Record<string, string>) } })
await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
await new Promise((r) => setTimeout(r, Number(process.env.WAIT_MS ?? 1200)))
await app.screenshot({ path: process.argv[2]! })
await app.close()
