/** Rail probe on the seeded Long review thread: bun scripts/shell3-rail.ts [--light] */
import { OUT, startScratch, waitUntil, exists } from './shell3-lib.ts'
import assert from 'node:assert/strict'
const light = process.argv.includes('--light')
const app = await startScratch({ light, thread: 'Long review thread' })
try {
await waitUntil(exists(app, 'message-rail'), 30_000, 'message rail')
await Bun.sleep(800)
console.log('rail', JSON.stringify(await app.getByTestId('message-rail').bounds()))
for (const i of [0, 9, 19]) console.log('jump', i, JSON.stringify(await app.getByTestId(`message-jump-${i}`).bounds().catch(() => 'none')))
await app.getByTestId('message-jump-4').hover()
await waitUntil(exists(app, 'message-preview'), 5000, 'preview card')
await Bun.sleep(700)
console.log('card', JSON.stringify(await app.getByTestId('message-preview').bounds()))
await app.screenshot({ path: `${OUT}/rail-hover-${light ? 'light' : 'dark'}.png` })
// Jump: the prompt should land in the middle of the pane (the desktop centres it).
const pane = await app.getByTestId('transcript-surface').bounds()
for (const i of [9, 2, 24]) {
  await app.getByTestId(`message-jump-${i}`).hover()
  await waitUntil(exists(app, 'message-preview'), 3000, 'preview before click')
  await Bun.sleep(200)
  await app.getByTestId(`message-jump-${i}`).click()
  await Bun.sleep(1200)
  const tree = (await app.call('getTree',{})).tree
  const text = (node: any): string => (node.text ?? '') + (node.children ?? []).map(text).join('')
  const find = (node: any): any => {
    if (node?.testId?.startsWith('turn-user:') && text(node).startsWith(`Question ${i + 1}:`)) return node
    return node?.children?.map(find).find(Boolean)
  }
  const user = find(tree)
  assert(user?.bounds, `Question ${i+1} is not painted`)
  const centre = user.bounds.y + (user.bounds.height - 16)/2 - pane.y
  assert(Math.abs(centre - pane.height/2) < 3, `Question ${i+1} centre ${centre}, expected ${pane.height/2}`)
  await app.screenshot({path:`${OUT}/jump-${i}-${light?'light':'dark'}.png`})
  console.log(`PASS jump ${i}: prompt centre ${centre} of ${pane.height}`)
}
for(const page of ['usage','home']){await app.getByTestId(`rail-${page}`).hover();await Bun.sleep(180);await app.getByTestId(`rail-${page}`).click()}
await waitUntil(exists(app,'message-rail'),8000,'rail after restoring a middle anchor')
console.log('PASS rail restored at middle anchor')
} finally { await app.close() }
