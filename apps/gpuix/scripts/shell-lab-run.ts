/** Drive scripts/shell-lab.tsx: toasts, banner, welcome, error boundary. Screenshots go to <out-dir>. */
import path from 'node:path'
import { launch } from '@gpuix/react/automation'
const out = process.argv[2]!
const light = process.argv.includes('--light')
const app = await launch({
  command: 'bun',
  args: [path.join(import.meta.dir, 'shell-lab.tsx')],
  env: { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: light ? 'light' : 'dark', ...(process.env.KYBERN_REDUCED_MOTION ? { KYBERN_REDUCED_MOTION: process.env.KYBERN_REDUCED_MOTION } : {}) },
})
const sfx = light ? '-light' : ''
const shot = (n: string) => app.screenshot({ path: path.join(out, `lab-${n}${sfx}.png`) })
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
await wait(800)
await app.getByTestId('t-success').click()
await wait(500)
await app.getByTestId('t-error').click()
await wait(500)
await app.getByTestId('t-agent').click()
await wait(600)
await shot('toasts')
console.log('toast count', await app.getByTestId('toaster').count())
await app.getByTestId('b-reconnecting').click()
await wait(500)
await shot('banner-reconnecting')
await app.getByTestId('b-failed').click()
await wait(500)
await shot('banner-failed')
await app.getByTestId('b-open').click()
await app.getByTestId('boom').click()
await wait(400)
await shot('error-boundary')
await app.getByTestId('error-reload').click()
await wait(300)
await app.getByTestId('w-connecting').click()
await wait(900)
await shot('welcome-connecting')
await app.getByTestId('w-unavailable').click()
await wait(300)
await shot('welcome-unavailable')
await app.getByTestId('w-empty').click()
await wait(300)
await shot('welcome-empty')
await app.close()
