import { open } from './conversation.tauri.mjs'
const settle = (p, ms = 700) => p.waitForTimeout(ms)
const long = async p => {
  await open(p, 'Long review thread')
  const viewport=p.locator('[data-chat-scroll-container]').first()
  await viewport.evaluate(el=>{el.scrollTop=0;el.dispatchEvent(new Event('scroll'))})
  await p.waitForFunction(()=>document.querySelectorAll('[data-slot="preview-rail-item"]').length===30)
  await viewport.evaluate(el=>{el.scrollTop=el.scrollHeight;el.dispatchEvent(new Event('scroll'))})
  await settle(p)
}
const park = (p) => p.mouse.move(1275, 815)

export const screens = {
  'shell3-rail': async (p) => { await long(p); await park(p); await settle(p) },
  'shell3-rail-hover': async (p) => { await long(p); await p.locator('[data-slot="preview-rail-item"]').nth(4).hover(); await settle(p, 900) },
  'shell3-spacing': async (p) => { await open(p, 'Rich reply'); await park(p); await settle(p) },
}
