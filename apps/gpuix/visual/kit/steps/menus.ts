import type { KitState } from './index.ts'
const clip: [number, number, number, number] = [0, 0, 640, 560]
export const states: Record<string, KitState> = {
  'menu-root': { section: 'menus', clip, settle: 700 },
  // Hover the Color row: the submenu opens after Base UI's 100 ms hover delay.
  'menu-sub': {
    section: 'menus',
    clip,
    settle: 900,
    tauri: async (page) => { await page.locator('[data-testid="menu-sub-trigger"]').hover(); await page.waitForTimeout(500) },
    gpuix: async (app) => { await app.getByTestId('menu-sub-trigger').hover(); await new Promise((r) => setTimeout(r, 500)) },
  },
}
