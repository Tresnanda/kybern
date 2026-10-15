import path from 'node:path'
import { launch } from '@gpuix/react/automation'
const out = process.argv[2]!
const app = await launch({ command: 'bun', args: [path.join(import.meta.dir, 'motion-lab.tsx')], env: { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: 'dark' } })
await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
await new Promise((r) => setTimeout(r, 800))
let at = await app.clock.pause()
await app.getByTestId('toggle').click()
await new Promise((r) => setTimeout(r, 300)) // measuring frame(s) before the tween starts
at = await app.clock.pause()
await app.captureFrames(path.join(out, 'open'), [at, at + 60, at + 120, at + 240])
await app.clock.resume()
await new Promise((r) => setTimeout(r, 500))
at = await app.clock.pause()
await app.getByTestId('toggle').click()
await new Promise((r) => setTimeout(r, 100))
await app.captureFrames(path.join(out, 'close'), [at, at + 60, at + 120, at + 240])
await app.clock.resume()
at = await app.clock.pause()
await app.getByTestId('rise').click()
await new Promise((r) => setTimeout(r, 100))
await app.captureFrames(path.join(out, 'rise'), [at, at + 60, at + 120, at + 260])
await app.clock.resume()
await app.close()
