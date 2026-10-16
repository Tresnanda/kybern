/** Rail probe on the seeded Long review thread: bun scripts/shell3-rail.ts [--light] */
import { OUT, startScratch, waitUntil, exists } from './shell3-lib.ts'
const light = process.argv.includes('--light')
const app = await startScratch({ light, thread: 'Long review thread' })
await waitUntil(exists(app, 'message-rail'), 30_000, 'message rail')
await Bun.sleep(800)
console.log('rail', JSON.stringify(await app.getByTestId('message-rail').bounds()))
for (const i of [0, 9, 19]) console.log('jump', i, JSON.stringify(await app.getByTestId(`message-jump-${i}`).bounds().catch(() => 'none')))
await app.getByTestId('message-jump-4').hover()
await waitUntil(exists(app, 'message-preview'), 5000, 'preview card')
await Bun.sleep(700)
console.log('card', JSON.stringify(await app.getByTestId('message-preview').bounds()))
await app.screenshot({ path: `${OUT}/rail-hover-${light ? 'light' : 'dark'}.png` })
await app.close()
