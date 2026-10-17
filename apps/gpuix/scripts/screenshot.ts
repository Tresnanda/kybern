/**
 * Launch the app behind the editor, wait for it to settle and write a PNG.
 *
 *   bun scripts/screenshot.ts [out.png] [--light]
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { launch } from '@gpuix/react/automation'

/** App settings passed through from this shell (data dir, thread, motion). */
function forwarded(): Record<string, string> {
  const keys = ['KYBERN_DATA_DIR', 'KYBERN_CLIENT_CONFIG_DIR', 'KYBERN_URL', 'KYBERN_TOKEN', 'KYBERN_GPUIX_THREAD', 'KYBERN_REDUCED_MOTION', 'KYBERN_OPAQUE']
  return Object.fromEntries(keys.flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : [])))
}

const args = process.argv.slice(2)
const out = args.find((a) => a.endsWith('.png')) ?? 'screenshots/app.png'
mkdirSync(path.dirname(out), { recursive: true })

const app = await launch({
  command: 'bun',
  args: [path.join(import.meta.dir, '../src/main.tsx')],
  env: {
    GPUIX_BACKGROUND: '1',
    KYBERN_APPEARANCE: args.includes('--light') ? 'light' : 'dark',
    ...forwarded(),
  },
})
await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
await new Promise((r) => setTimeout(r, Number(process.env.SETTLE_MS ?? 2500)))
await app.screenshot({ path: out })
await app.close()
console.log(`[screenshot] wrote ${out}`)
