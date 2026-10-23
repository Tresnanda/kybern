/**
 * Reply images drawn from slot-sized files (`src/transcript/imageFiles.ts`):
 * the thread view, the attachment thumbnail and the lightbox, captured for
 * comparison with `KYBERN_IMAGE_FILES=0` (the full-size `data:` URL path).
 *
 *   KYBERN_DATA_DIR=<scratch with an "Image check" thread> bun perf/memlog/images-check.ts <label> <thread>
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../../src/requests/harness.ts'

const [label = 'after', thread] = process.argv.slice(2)
assert(thread, 'Name the thread')
const data = process.env.KYBERN_DATA_DIR!
assert(data?.includes('scratch'), 'Explicit scratch data directory required')
const out = path.join(data, 'results', `images-${label}`)
mkdirSync(out, { recursive: true })
const client = path.join(data, `client-images-${label}`)
const f = await launchFixture(path.join(import.meta.dir, '../memory/app.ts'), {
  KYBERN_DATA_DIR: data, KYBERN_URL: '', KYBERN_TOKEN: '', KYBERN_GPUIX_RESOURCES: '', KYBERND: '', KYBERN_BUNDLED_CLI: '',
  KYBERN_CLIENT_CONFIG_DIR: client, KYBERN_GPUIX_CREDENTIALS_DIR: path.join(client, 'credentials'), KYBERN_GPUIX_THREAD: '',
  GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: 'dark', KYBERN_OPAQUE: '1', KYBERN_REDUCED_MOTION: '1', KYBERN_WINDOW_SIZE: '1280x900',
})
try {
  await f.app.getByTestId('app-ready').waitFor()
  const port = (name: string) => JSON.parse(readFileSync(path.join(client, `${name}-control.json`), 'utf8')).port as number
  for (const until = Date.now() + 20000; ; await Bun.sleep(50)) { try { port('bench'); break } catch { assert(Date.now() < until) } }
  const control = async (action: string, args: Record<string, unknown> = {}) => (await fetch(`http://127.0.0.1:${port('bench')}`, { method: 'POST', body: JSON.stringify({ action, ...args }) })).json()
  while (!(await control('state') as { listsLoaded: boolean }).listsLoaded) await Bun.sleep(50)
  await control('open', { thread })
  await Bun.sleep(6000)
  const footprint = () => /phys_footprint:\s+([\d.]+ \w+)/.exec(execFileSync('footprint', ['-p', String(f.pid)], { encoding: 'utf8' }))?.[1]
  await f.app.screenshot({ path: path.join(out, 'thread.png') })
  console.log('thread', footprint())
  // The first reply image (the attachment thumbnail is also a response image).
  const images = (await f.app.getByTestId('response-image').all()).filter(n => n.bounds && n.bounds.width > 100)
  const b = images[0]!.bounds!
  await f.app.mouse.click({ x: b.x + b.width / 2, y: b.y + b.height / 2 })
  await Bun.sleep(2000)
  await f.app.screenshot({ path: path.join(out, 'lightbox.png') })
  console.log('lightbox', footprint())
} finally {
  await f.close()
}
