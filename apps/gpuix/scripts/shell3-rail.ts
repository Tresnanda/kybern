/** Real-thread rail probe: bun scripts/shell3-rail.ts [--light] */
import { OUT, start, waitUntil, exists } from './shell3-lib.ts'
const light = process.argv.includes('--light')
const app = await start(light)
await waitUntil(exists(app, 'transcript'), 30_000, 'transcript')
await Bun.sleep(1500)
for (const id of ['transcript', 'message-rail', 'transcript-surface']) {
  const n = await app.getByTestId(id).count()
  console.log(id, n, n ? JSON.stringify(await app.getByTestId(id).bounds().catch(() => 'nobounds')) : '')
}
await app.screenshot({ path: `${OUT}/rail-probe-${light ? 'light' : 'dark'}.png` })
await app.close()
