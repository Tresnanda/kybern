/**
 * Dropdown menu behaviour in the GPUIX kit gallery ("menus" section): hover-open submenu, diagonal pointer travel into it
 * over sibling rows (the case that failed in round 5: the submenu dismissed after entering its panel), leaving, sibling
 * hover, keyboard (Right, Left, Escape, Enter, Down), checkbox/radio selection and destructive rows.
 *
 * Pointer input is GPUIX's native mouse simulation (same GPUI dispatch as OS events); OS-level events are not
 * available in this shell (see kit9-tooltips.ts).
 *
 *   bun scripts/kit9-menus-check.ts [--light] [--reduced]
 */
import assert from 'node:assert/strict'
import { startGallery, waitUntil } from './kit9-lib.ts'
const light = process.argv.includes('--light'), reduced = process.argv.includes('--reduced')
const app = await startGallery('menus', { light, reduced })
const sleep = (n: number) => new Promise((r) => setTimeout(r, n))
const count = (id: string) => app.getByTestId(id).count()
const text = async (needle: string) => (await app.call('getTree', {}) as any).tree && JSON.stringify((await app.call('getTree', {}) as any).tree).includes(needle)
const label = async (prefix: string) => {
  const flat: string[] = []
  const walk = (n: any) => { if (n?.text) flat.push(n.text); for (const c of n?.children ?? []) walk(c) }
  walk((await app.call('getTree', {}) as any).tree)
  return flat.find((s) => s.startsWith(prefix)) ?? ''
}
const move = (x: number, y: number) => app.mouse.move({ x, y })
try {
  await sleep(500)
  const trigger = await app.getByTestId('menu-sub-trigger').bounds()
  const panelOf = async (id: string) => app.getByTestId(id).bounds()
  const rows = { hints: { x: trigger.x + 90, y: trigger.y - 26 + 13 }, color: { x: trigger.x + 90, y: trigger.y + 13 }, remove: { x: trigger.x + 90, y: trigger.y + 26 + 9 + 13 } }
  console.log('trigger', JSON.stringify(trigger))

  // 1. Hover opens after ~100 ms, not before.
  await move(rows.color.x, rows.color.y)
  assert.equal(await count('menu-sub-trigger-menu'), 0, 'must not open instantly')
  await waitUntil(async () => (await count('menu-sub-trigger-menu')) === 1, 1500, 'submenu opens on hover')
  console.log('PASS hover opens the submenu')

  // 2. Diagonal travel over the row below ("Remove account") into the submenu, in small steps like a real hand.
  const sub = await panelOf('menu-sub-trigger-menu')
  const target = { x: sub.x + 60, y: sub.y + 40 }
  const steps = 14
  for (let i = 1; i <= steps; i++) {
    await move(rows.color.x + ((target.x - rows.color.x) * i) / steps + 70 * (i / steps), rows.color.y + ((target.y - rows.color.y) * i) / steps)
    await sleep(16)
  }
  await move(target.x, target.y)
  await sleep(700)
  assert.equal(await count('menu-sub-trigger-menu'), 1, 'diagonal travel into the submenu must keep it open (and 700 ms after entering)')
  console.log('PASS diagonal travel into the submenu; still open 700 ms after entering')

  // 3. Hover inside the submenu, then pick: radio selection, whole tree closes.
  await app.getByTestId('menu-item-rose').hover()
  await sleep(150)
  await app.getByTestId('menu-item-rose').click()
  await waitUntil(async () => (await label('picked')).includes('rose'), 2000, 'rose picked')
  await waitUntil(async () => (await count('menu-menu')) === 0, 2000, 'menu closed after a pick')
  assert((await label('state')).includes('rose'))
  console.log('PASS clicking a submenu item picks it and closes the whole menu')

  // 4. Reopen. Moving to a sibling row (leaving the corridor) closes the submenu; leaving the whole menu closes only the submenu.
  await app.getByTestId('menu-trigger').click()
  await waitUntil(async () => (await count('menu-menu')) === 1, 2000, 'root reopens')
  await sleep(300)
  await move(rows.color.x, rows.color.y)
  await waitUntil(async () => (await count('menu-sub-trigger-menu')) === 1, 1500, 'submenu opens again')
  await move(rows.color.x - 10, rows.color.y + 8)  // straight down, away from the corridor
  await move(rows.remove.x - 10, rows.remove.y)
  await waitUntil(async () => (await count('menu-sub-trigger-menu')) === 0, 1500, 'sibling hover closes the submenu')
  assert.equal(await count('menu-menu'), 1, 'root menu stays open')
  console.log('PASS hovering a sibling row outside the corridor closes the submenu; the root stays')
  await move(rows.color.x, rows.color.y)
  await waitUntil(async () => (await count('menu-sub-trigger-menu')) === 1, 1500, 'submenu opens once more')
  await move(1000, 600)  // far outside every panel
  await waitUntil(async () => (await count('menu-sub-trigger-menu')) === 0, 1500, 'leaving the tree closes the submenu')
  assert.equal(await count('menu-menu'), 1, 'root menu stays open after the pointer leaves')
  console.log('PASS leaving the whole menu closes the submenu only')

  // 5. Keyboard. Focus the root, walk down to Color, Right opens with the first item lit, Down, Left returns, Escape closes.
  const root = app.getByTestId('menu-menu')
  const key = async (k: string) => { await root.press(k); await sleep(120) }
  await move(1000, 600)
  await sleep(200)
  // Items in order: Rename, Copy link, Light, Dark, System, Show hints, Color, Remove account.
  for (let i = 0; i < 7; i++) await key('down')
  await key('right')
  assert.equal(await count('menu-sub-trigger-menu'), 1, 'Right opens the submenu')
  await key('down')            // Blue lit -> Green
  await key('left')            // back to the trigger, submenu closed
  assert.equal(await count('menu-sub-trigger-menu'), 0, 'Left closes the submenu')
  assert.equal(await count('menu-menu'), 1, 'Left must not close the root')
  await key('right')           // reopen: first item lit again
  await key('enter')           // picks Blue
  await waitUntil(async () => (await label('picked')).includes('blue'), 2000, 'enter picks the lit first item')
  assert.equal(await count('menu-menu'), 0, 'picking closes the tree')
  console.log('PASS keyboard: Down to Color, Right opens with the first item lit, Left backs out, Enter picks')

  await app.getByTestId('menu-trigger').click()
  await waitUntil(async () => (await count('menu-menu')) === 1, 2000, 'root reopens (keyboard run)')
  await sleep(300)
  await key('down')
  for (let i = 0; i < 6; i++) await key('down')
  await key('right')
  await key('escape')
  assert.equal(await count('menu-sub-trigger-menu'), 0, 'Escape closes the submenu first')
  assert.equal(await count('menu-menu'), 1, 'the first Escape leaves the root open')
  await key('escape')
  await waitUntil(async () => (await count('menu-menu')) === 0, 2000, 'second Escape closes the root')
  console.log('PASS keyboard: Escape closes the submenu, then the root')

  // Enter on the submenu trigger opens it like Right (Base UI): focus moves in with the first item lit.
  await app.getByTestId('menu-trigger').click()
  await waitUntil(async () => (await count('menu-menu')) === 1, 2000, 'root reopens (Enter run)')
  await sleep(300)
  for (let i = 0; i < 7; i++) await key('down')
  await key('enter')
  assert.equal(await count('menu-sub-trigger-menu'), 1, 'Enter on Color opens the submenu')
  assert.equal(await count('menu-menu'), 1, 'Enter on Color keeps the root open')
  await key('enter')
  await waitUntil(async () => (await label('picked')).includes('blue'), 2000, 'a second Enter picks the lit first item')
  console.log('PASS keyboard: Enter on a submenu trigger opens it with the first item lit')

  // 6. Existing behaviours: checkbox keeps the menu open and toggles, destructive row picks and closes.
  await app.getByTestId('menu-trigger').click()
  await waitUntil(async () => (await count('menu-menu')) === 1, 2000, 'root reopens (checkbox run)')
  await sleep(300)
  await app.getByTestId('menu-item-hints').click()
  await sleep(300)
  assert((await label('state')).includes('nohints'), 'checkbox item toggles')
  assert.equal(await count('menu-menu'), 1, 'checkbox item keeps the menu open')
  await app.getByTestId('menu-item-remove').click()
  await waitUntil(async () => (await label('picked')).includes('remove'), 2000, 'destructive row picked')
  console.log('PASS checkbox toggles without closing; destructive row picks and closes')
  console.log(`ALL PASS (${light ? 'light' : 'dark'}${reduced ? ', reduced motion' : ''})`)
} catch (error) {
  console.log((app as any).diagnostics().split('\n').filter((l: string) => /\[tree\]/.test(l)).slice(-12).join('\n'))
  await app.screenshot({ path: `/Users/mymac/projects/ade/previews/gpuix/phase2/kit9/menus-failure-${light ? 'light' : 'dark'}.png` }).catch(() => {})
  throw error
} finally { await app.closeAll() }
