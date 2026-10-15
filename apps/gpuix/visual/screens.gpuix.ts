// GPUIX automation steps, keyed like `screens.tauri.mjs`. Each step starts from
// a fresh navigation (the previous screen's state is reset first).
import type { App } from '@gpuix/react/automation'

export type Fixture = { notes: Record<string, string>; tasks: Record<string, string>; taskKeys: Record<string, string>; /** Per-area ids from `fixture.<area>.ts` `ids()`. */ extra: Record<string, Record<string, unknown>> }
export type Step = (app: App, fx: Fixture) => Promise<void>

export const settle = (ms = 900) => new Promise((r) => setTimeout(r, ms))
/** Move the pointer onto the window's bottom-right corner, clear of hover and tooltips. */
export async function park(app: App) {
  await app.mouse.move({ x: 1275, y: 815 })
  await settle(300)
}
export async function click(app: App, testId: string) {
  await app.getByTestId(testId).click()
  await settle(400)
}
export async function go(app: App, page: string) {
  await click(app, 'rail-home')
  // Leave any open note or task, and put the Tasks view back to the list.

  await click(app, `rail-${page}`)
  if (page === 'tasks') await click(app, 'task-view-list').catch(() => {})
  await settle(900)
}
async function notesGallery(app: App) {
  await go(app, 'notes')
  await click(app, 'notes-filter-all')
}
async function listLayout(app: App) {
  await click(app, 'notes-display')
  await click(app, 'notes-layout-list')
}
async function galleryLayout(app: App) {
  await click(app, 'notes-display')
  await click(app, 'notes-layout-gallery')
}

export const screens: Record<string, Step> = {
  'notes-gallery': async (app) => { await notesGallery(app); await park(app) },
  'notes-list': async (app) => { await notesGallery(app); await listLayout(app); await park(app); },
  'notes-hover': async (app, fx) => { await notesGallery(app); await settle(800); await app.getByTestId(`note-card-${fx.notes['Moodboard']}`).hover().catch(() => app.mouse.move({ x: 802, y: 508 })); await settle(500) },
  'notes-search-empty': async (app) => { await notesGallery(app); await app.getByTestId('notes-search').fill('zzzz'); await settle(700); await park(app) },
  'tasks-board': async (app) => { await go(app, 'tasks'); await click(app, 'task-view-board'); await park(app) },
  'tasks-detail': async (app, fx) => { await go(app, 'tasks'); await click(app, `task-drag-${fx.tasks['Ship notes image blocks']}`); await settle(1000); await park(app) },
  'tasks-quick-add': async (app) => { await go(app, 'tasks'); await app.getByTestId('task-new').click(); await settle(700); await park(app) },
  'notes-editor': async (app, fx) => { await notesGallery(app); await app.getByTestId(`note-card-${fx.notes['Design review notes']}`).click().catch(() => app.mouse.click({ x: 800, y: 700 })); await settle(1200); await park(app) },
  'notes-editor-scrolled': async (app, fx) => { await notesGallery(app); await app.getByTestId(`note-card-${fx.notes['Design review notes']}`).click().catch(() => app.mouse.click({ x: 800, y: 700 })); await settle(1200); await app.mouse.wheel({ x: 700, y: 400 }, 0, -3000); await settle(800); await park(app) },
  'notes-editor-image': async (app, fx) => { await notesGallery(app); await app.mouse.click({ x: 802, y: 508 }); await settle(1200); await park(app) },
  'notes-quick-capture': async (app) => { await notesGallery(app); await app.getByTestId('app-ready').press('cmd-shift-n'); await settle(900); await park(app) },
  'tasks-select': async (app, fx) => { await go(app, 'tasks'); await app.getByTestId(`task-row-${fx.tasks['Fix sidebar collapse jitter on resize']}`).hover(); await settle(300); await click(app, `task-select-${fx.tasks['Fix sidebar collapse jitter on resize']}`); await app.getByTestId(`task-row-${fx.tasks['Ship notes image blocks']}`).hover(); await settle(300); await click(app, `task-select-${fx.tasks['Ship notes image blocks']}`); await settle(600); await park(app) },
  'tasks-list': async (app) => { await go(app, 'tasks'); await park(app) },
}
