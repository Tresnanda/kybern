// Overlay states (`visual/kit/sections/overlays.tsx`, `src/kit/gallery/overlays.tsx`): the resting trigger row,
// the alert dialog, each sheet side, the inset sheet, and a select open inside the right sheet (stacked overlays).
import type { KitState } from './index.ts'

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms))
const open = (id: string, then?: string): Pick<KitState, 'tauri' | 'gpuix'> => ({
  tauri: async (page) => { await page.locator(`[data-testid="${id}"]`).click(); await page.waitForTimeout(450); if (then) { await page.locator(`[data-testid="${then}"]`).click(); await page.waitForTimeout(300) } },
  gpuix: async (app) => { await app.getByTestId(id).click(); await settle(450); if (then) { await app.getByTestId(then).click(); await settle(300) } },
})
// Park the pointer away from the triggers so neither app shows a hover fill.
// The GPUIX gallery runs in a background window whose display link is parked: reading the tree renders a
// current frame before the screenshot (in a visible window the display link does this every frame).
const park = { tauri: async (page: any) => page.mouse.move(1270, 810), gpuix: async (app: any) => { await app.mouse.move({ x: 1270, y: 810 }); await settle(50); await app.getByTestId('app-ready').count() } }
const parked = (s: Pick<KitState, 'tauri' | 'gpuix'>): Pick<KitState, 'tauri' | 'gpuix'> => ({
  tauri: async (page) => { await s.tauri?.(page); await park.tauri(page) },
  gpuix: async (app) => { await s.gpuix?.(app); await park.gpuix(app) },
})

export const states: Record<string, KitState> = {
  'overlays-rest': { section: 'overlays', clip: [0, 0, 720, 120] },
  'alert-open': { section: 'overlays', ...parked(open('alert-trigger')) },
  'sheet-right': { section: 'overlays', ...parked(open('sheet-right-trigger')) },
  'sheet-left': { section: 'overlays', ...parked(open('sheet-left-trigger')) },
  'sheet-top': { section: 'overlays', ...parked(open('sheet-top-trigger')) },
  'sheet-bottom': { section: 'overlays', ...parked(open('sheet-bottom-trigger')) },
  'sheet-inset': { section: 'overlays', ...parked(open('sheet-inset-trigger')) },
  'sheet-select': { section: 'overlays', clip: [800, 0, 480, 360], tauri: open('sheet-right-trigger', 'sheet-right-select-trigger').tauri, gpuix: async (app) => { await open('sheet-right-trigger', 'sheet-right-select-trigger').gpuix!(app); await app.getByTestId('sheet-right-select-popup').waitFor({ timeoutMs: 5000 }) } },
}
