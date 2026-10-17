// Picker states (`visual/kit/sections/pickers.tsx`, `src/kit/gallery/pickers.tsx`): resting triggers and inputs,
// the settings select aligned to its selected item with a hovered row, the composer select under its trigger,
// and the combobox open, filtered and empty.
import type { KitState } from './index.ts'

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms))
// Background GPUIX windows have a parked display link: a tree read renders a current frame before the screenshot.
const fresh = async (app: any) => { await settle(50); await app.getByTestId('app-ready').count() }
// Base UI ignores a single synthetic jump onto a row; travel onto it like a real pointer.
const hoverRow = async (page: any, id: string) => { const b = await page.locator(`[data-testid="${id}"]`).boundingBox(); await page.mouse.move(b.x + 20, b.y - 12, { steps: 2 }); await page.waitForTimeout(50); await page.mouse.move(b.x + 30, b.y + b.height / 2, { steps: 6 }) }
const clip: [number, number, number, number] = [0, 0, 920, 420]

export const states: Record<string, KitState> = {
  'pickers-rest': { section: 'pickers', clip, tauri: async (page) => page.mouse.move(1270, 810), gpuix: async (app) => { await app.mouse.move({ x: 1270, y: 810 }); await fresh(app) } },
  'select-open': {
    section: 'pickers', clip,
    tauri: async (page) => { await page.locator('[data-testid="select-trigger"]').click(); await page.waitForTimeout(300); await hoverRow(page, 'select-option-system') },
    gpuix: async (app) => { await app.getByTestId('select-trigger').click(); await settle(300); await app.getByTestId('select-option-system').hover(); await fresh(app) },
  },
  'select-below': {
    section: 'pickers', clip,
    tauri: async (page) => { await page.locator('[data-testid="select-below-trigger"]').click(); await page.waitForTimeout(300); await hoverRow(page, 'select-below-option-spacious') },
    gpuix: async (app) => { await app.getByTestId('select-below-trigger').click(); await settle(300); await app.getByTestId('select-below-option-spacious').hover(); await fresh(app) },
  },
  'combobox-open': {
    section: 'pickers', clip,
    tauri: async (page) => { await page.locator('[data-testid="combobox-input"]').click(); await page.waitForTimeout(300); await page.mouse.move(1270, 810) },
    gpuix: async (app) => { await app.getByTestId('combobox-input').click(); await settle(300); await app.mouse.move({ x: 1270, y: 810 }); await fresh(app) },
  },
  'combobox-filtered': {
    section: 'pickers', clip,
    tauri: async (page) => { await page.locator('[data-testid="combobox-input"]').click(); await page.keyboard.type('fix'); await page.waitForTimeout(300); await page.keyboard.press('ArrowDown'); await page.mouse.move(1270, 810) },
    gpuix: async (app) => { await app.getByTestId('combobox-input').click(); await app.getByTestId('combobox-input').fill('fix'); await settle(300); await app.getByTestId('combobox-input').press('down'); await app.mouse.move({ x: 1270, y: 810 }); await fresh(app) },
  },
  'combobox-empty': {
    section: 'pickers', clip,
    tauri: async (page) => { await page.locator('[data-testid="combobox-input"]').click(); await page.keyboard.type('zzz'); await page.waitForTimeout(300); await page.mouse.move(1270, 810) },
    gpuix: async (app) => { await app.getByTestId('combobox-input').click(); await app.getByTestId('combobox-input').fill('zzz'); await settle(300); await app.mouse.move({ x: 1270, y: 810 }); await fresh(app) },
  },
  'combobox-chips': {
    section: 'pickers', clip,
    tauri: async (page) => { await page.locator('[data-testid="combobox-chips-input"]').click(); await page.waitForTimeout(300); await page.mouse.move(1270, 810) },
    gpuix: async (app) => { await app.getByTestId('combobox-chips-input').click(); await settle(300); await app.mouse.move({ x: 1270, y: 810 }); await fresh(app) },
  },
}
