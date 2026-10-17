// Tauri reference for editor9.gpuix.ts.
import { resetSample } from './editor9-reset.mjs'
const rail = (name) => (p) => p.getByRole('button', { name, exact: true }).first().click()
const settle = (p, ms = 700) => p.waitForTimeout(ms)
const park = (p) => p.mouse.move(1275, 815)
const reset = async (p) => { const q = new URL(p.url()).searchParams; await resetSample(q.get('url'), q.get('token')) }
const open = async (p) => { await reset(p); await p.reload(); await p.waitForSelector('button[aria-label="Notes"]'); await settle(p, 800); await rail('Notes')(p); await settle(p, 1200); await p.locator('[data-note-card][aria-label="Editor sample"]').first().click(); await settle(p, 1500) }
const into = async (p) => { await open(p); await p.locator('.note-title-field').click(); await p.keyboard.press('End'); await p.keyboard.press('ArrowDown'); await settle(p, 300) }
const keys = async (p, ...list) => { for (const k of list) await p.keyboard.press(k); await settle(p, 400) }
const detail = async (p) => { await rail('Tasks')(p); await settle(p, 800); await p.getByText('Ship notes image blocks').first().click(); await settle(p, 1200) }
export const screens = {
  'editor9-note': async (p) => { await open(p); await park(p) },
  'editor9-note-end': async (p) => { await into(p); await keys(p, 'Meta+ArrowDown'); await park(p) },
  'editor9-note-slash': async (p) => { await into(p); await keys(p, 'Meta+ArrowDown', 'Enter', '/'); await settle(p, 400); await park(p) },
  'editor9-note-slash-query': async (p) => { await into(p); await keys(p, 'Meta+ArrowDown', 'Enter', '/', 'h', 'e'); await settle(p, 400); await park(p) },
  'editor9-note-select': async (p) => { await into(p); await keys(p, 'Shift+ArrowDown', 'Shift+ArrowDown', 'Shift+ArrowDown'); await park(p) },
  // A plain click places the caret inside the link (End hangs headless WebKit's ProseMirror here).
  'editor9-note-link': async (p) => { await into(p); await p.locator('.note-prose a[href="https://kybern.dev/docs"]').first().click({ position: { x: 30, y: 8 } }); await settle(p, 600); await park(p) },
  'editor9-desc-select': async (p) => { await detail(p); await p.locator('.tk-desc .ProseMirror').click(); await p.keyboard.press('Meta+ArrowDown'); await p.keyboard.press('Shift+Alt+ArrowLeft'); await settle(p, 600); await park(p) },
}
