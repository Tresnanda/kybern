/**
 * Drive the transcript in a background window and take screenshots between steps.
 *
 *   bun scripts/transcript.ts [--light] step...
 *
 * Steps run in order: `click=<testId>`, `clicktext=<text>`, `hover=<testId>`,
 * `wheel=<testId>:<dy>`, `wheelat=<x>:<y>:<dy>`, `wait=<ms>`, `shot=<out.png>`, `count=<testId>`.
 * Settings pass through from the shell (KYBERN_DATA_DIR, KYBERN_GPUIX_THREAD, …).
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { launch } from '@gpuix/react/automation'

function forwarded(): Record<string, string> {
  const keys = ['KYBERN_DATA_DIR', 'KYBERN_URL', 'KYBERN_TOKEN', 'KYBERN_GPUIX_THREAD', 'KYBERN_REDUCED_MOTION', 'KYBERN_OPAQUE']
  return Object.fromEntries(keys.flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : [])))
}

const args = process.argv.slice(2)
const app = await launch({
  command: 'bun',
  args: [path.join(import.meta.dir, '../src/main.tsx')],
  env: { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: args.includes('--light') ? 'light' : 'dark', ...forwarded() },
})
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
try {
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
  await sleep(Number(process.env.SETTLE_MS ?? 3000))
  for (const step of args.filter((a) => !a.startsWith('--'))) {
    const [kind, value = ''] = [step.slice(0, step.indexOf('=')), step.slice(step.indexOf('=') + 1)]
    if (kind === 'click') await app.getByTestId(value).click()
    else if (kind === 'clicktext') await app.getByText(value).click()
    else if (kind === 'hover') await app.getByTestId(value).hover()
    else if (kind === 'clickprefix') {
      // The nth element (from 0, negative counts from the end) whose testId starts with a prefix.
      const [prefix, nth = '0'] = value.split(':')
      const nodes = (await app.getByType('div').all()).filter((n) => n.testId?.startsWith(prefix!) && n.bounds)
      const node = nodes.at(Number(nth))
      if (!node?.bounds) throw new Error(`No element with testId ${prefix}* (${nodes.length} found)`)
      await app.mouse.click({ x: node.bounds.x + Math.min(40, node.bounds.width / 2), y: node.bounds.y + Math.min(12, node.bounds.height / 2) })
    }
    else if (kind === 'wheel') {
      const [id, dy] = value.split(':')
      await app.getByTestId(id!).wheel(0, Number(dy))
    } else if (kind === 'wheelat') {
      const [x, y, dy] = value.split(':').map(Number)
      await app.mouse.wheel({ x: x!, y: y! }, 0, dy!)
    } else if (kind === 'wait') await sleep(Number(value))
    else if (kind === 'count') console.log(`[transcript] ${value}: ${await app.getByTestId(value).count()}`)
    else if (kind === 'shot') {
      mkdirSync(path.dirname(value), { recursive: true })
      await app.screenshot({ path: value })
      console.log(`[transcript] wrote ${value}`)
    } else throw new Error(`Unknown step ${step}`)
    await sleep(250)
  }
} finally {
  await app.close()
}
