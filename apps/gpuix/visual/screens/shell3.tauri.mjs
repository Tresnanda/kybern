import { open } from './conversation.tauri.mjs'
const settle = (p, ms = 700) => p.waitForTimeout(ms)
const park = (p) => p.mouse.move(1275, 815)

export const screens = {
  'shell3-rail': async (p) => { await open(p, 'Long review thread'); await park(p); await settle(p) },
  'shell3-rail-hover': async (p) => { await open(p, 'Long review thread'); await p.locator('[data-slot="preview-rail-item"]').nth(4).hover(); await settle(p, 900) },
  'shell3-spacing': async (p) => { await open(p, 'Rich reply'); await park(p); await settle(p) },
}
