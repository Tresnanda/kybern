// Playwright (WebKit) steps for the Tauri reference. Each takes a page.
const rail = (name) => (p) => p.getByRole('button', { name, exact: true }).first().click()
const settle = (p, ms = 700) => p.waitForTimeout(ms)
const notes = async (p) => { await rail('Notes')(p); await settle(p, 1200) }
const park = (p) => p.mouse.move(1275, 815)
const card = (p, title) => p.locator(`[data-note-card][aria-label="${title}"]`).first()
export const screens = {
  'notes-gallery': async (p) => { await notes(p) },
  'notes-list': async (p) => { await notes(p); await p.getByRole('button', { name: 'Display' }).click(); await p.getByRole('menuitemradio', { name: 'List' }).click(); await p.keyboard.press('Escape'); await settle(p, 500); await park(p) },
  'notes-hover': async (p) => { await notes(p); await card(p, 'Project brief').hover(); await settle(p, 500) },
  'notes-search-empty': async (p) => { await notes(p); await p.getByPlaceholder('Search notes').fill('zzzz'); await settle(p, 700); await park(p) },
  'tasks-board': async (p) => { await rail('Tasks')(p); await settle(p, 800); await p.getByRole('button', { name: 'Board' }).click(); await settle(p, 800); await park(p) },
  'tasks-detail': async (p) => { await rail('Tasks')(p); await settle(p, 800); await p.getByText('Ship notes image blocks').first().click(); await settle(p, 1200); await park(p) },
  'tasks-quick-add': async (p) => { await rail('Tasks')(p); await settle(p, 800); await p.keyboard.press('c'); await settle(p, 700); await park(p) },
  'notes-editor': async (p) => { await notes(p); await card(p, 'Design review notes').click(); await settle(p, 1500); await park(p) },
  'notes-editor-scrolled': async (p) => { await notes(p); await card(p, 'Design review notes').click(); await settle(p, 1500); await p.mouse.move(700, 400); await p.mouse.wheel(0, 3000); await settle(p, 800); await park(p) },
  'notes-editor-image': async (p) => { await notes(p); await card(p, 'Moodboard').click(); await settle(p, 1500); await park(p) },
  'notes-quick-capture': async (p) => { await notes(p); await p.keyboard.press('Meta+Shift+N'); await settle(p, 900); await park(p) },
  'tasks-select': async (p) => { await rail('Tasks')(p); await settle(p, 800); await p.getByRole('checkbox', { name: 'Select KYA-1', exact: true }).click({ force: true }); await p.getByRole('checkbox', { name: 'Select KYA-2', exact: true }).click({ force: true }); await settle(p, 700); await park(p) },
  'tasks-list': async (p) => { await rail('Tasks')(p); await settle(p, 1200) },
}
