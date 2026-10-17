// States of the `controls` gallery section (`visual/kit/sections/controls.tsx` ↔ `src/kit/gallery/controls.tsx`).
import type { KitState } from './index.ts'

const CLIP: [number, number, number, number] = [0, 0, 720, 560]
/** GPUIX motion only advances while the hidden gallery window presents frames: run the clock past every tween. */
const settled = async (app: any) => { await app.clock.fastForward(1500) }
const sel = (id: string) => `[data-testid="${id}"]`
/** Keyboard focus: the desktop through Playwright `focus()` (no pointer yet, so `:focus-visible` matches), GPUIX through the automation focus call. */
const focus = (id: string, inner?: string): KitState => ({
  section: 'controls',
  tauri: async (page) => { await page.focus(inner ? `${sel(id)} ${inner}` : sel(id)) },
  gpuix: async (app) => { const node = await app.getByTestId(id).element(); await app.call('focus', { elementId: node.id }); await settled(app) },
  clip: CLIP,
})
/** Pointer resting over a control. */
const hover = (id: string, inner?: string): KitState => ({
  section: 'controls',
  tauri: async (page) => { await page.hover(inner ? `${sel(id)} ${inner}` : sel(id)) },
  gpuix: async (app) => { await app.getByTestId(id).hover(); await settled(app) },
  clip: CLIP,
})
/** Pointer held down on a control (`:active`), photographed after the press transitions settle. */
const hold = (id: string): KitState => ({
  section: 'controls',
  tauri: async (page) => { const b = await page.locator(sel(id)).boundingBox(); await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down() },
  gpuix: async (app) => { const c = await app.getByTestId(id).center(); await app.mouse.move(c); await app.mouse.down(c); await settled(app) },
  clip: CLIP,
})

export const states: Record<string, KitState> = {
  controls: { section: 'controls', gpuix: settled, clip: CLIP },
  // Every control clicked once: switch on, checkbox checked, toggles flipped, segments moved, a new time.
  'controls-changed': {
    section: 'controls',
    tauri: async (page) => {
      for (const id of ['switch-a', 'switch-b', 'check-a', 'check-b', 'toggle-a', 'toggle-b', 'toggle-c']) await page.click(sel(id))
      await page.click(`${sel('seg-a')} [role=radio]:has-text("Month")`)
      await page.click(`${sel('seg-b')} [role=radio]:has-text("Ask")`)
      await page.click(`${sel('time')} [role=listbox][aria-label=Hour] [role=option]:has-text("10")`)
      await page.click(`${sel('time')} [role=listbox][aria-label=Minute] [role=option]:has-text("31")`)
      await page.mouse.move(1270, 810)
    },
    gpuix: async (app) => {
      for (const id of ['switch-a', 'switch-b', 'check-a', 'check-b', 'toggle-a', 'toggle-b', 'toggle-c', 'seg-a-month', 'seg-b-ask', 'time-hour-10', 'time-minute-31']) await app.getByTestId(id).click()
      await app.mouse.move({ x: 1270, y: 810 })
      await settled(app)
    },
    settle: 800,
    clip: CLIP,
  },
  'controls-hover-toggle': hover('toggle-a'),
  'controls-hover-outline': hover('toggle-c'),
  'controls-hover-seg': { ...hover('seg-a', '[role=radio]:has-text("Day")'), gpuix: async (app) => { await app.getByTestId('seg-a-day').hover(); await settled(app) } },
  'controls-hover-time': { ...hover('time', '[role=listbox][aria-label=Hour] [role=option]:has-text("10")'), gpuix: async (app) => { await app.getByTestId('time-hour-10').hover(); await settled(app) } },
  'controls-hold-toggle': hold('toggle-c'),
  'controls-hold-switch': hold('switch-a'),
  'controls-focus-switch': focus('switch-b'),
  'controls-focus-check': focus('check-b'),
  'controls-focus-toggle': focus('toggle-b'),
  'controls-focus-seg': { ...focus('seg-a', '[role=radio][aria-checked=true]'), gpuix: async (app) => { const node = await app.getByTestId('seg-a-week').element(); await app.call('focus', { elementId: node.id }); await settled(app) } },
  // Arrow right from the focused segment: the choice and the focus move to Month.
  'controls-seg-arrow': {
    section: 'controls',
    tauri: async (page) => { await page.focus(`${sel('seg-a')} [role=radio][aria-checked=true]`); await page.keyboard.press('ArrowRight') },
    gpuix: async (app) => { const node = await app.getByTestId('seg-a-week').element(); await app.call('focus', { elementId: node.id }); await app.getByTestId('seg-a-week').press('right'); await settled(app) },
    settle: 700,
    clip: CLIP,
  },
}
