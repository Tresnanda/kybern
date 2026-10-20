// Tauri reference for tasks3.gpuix.ts.
const rail = (name) => (p) => p.getByRole('button', { name, exact: true }).first().click()
const settle = (p, ms = 700) => p.waitForTimeout(ms)
const park = (p) => p.mouse.move(1275, 815)
const board = async (p) => { await rail('Tasks')(p); await settle(p, 800); await p.getByRole('button', { name: 'Board' }).click(); await settle(p, 800) }
const detail = async (p) => { await rail('Tasks')(p); await settle(p, 800); await p.getByText('Ship notes image blocks').first().click(); await settle(p, 1200) }
export const screens = {
  'tasks3-board-quick-add': async (p) => { await board(p); await p.locator('section.tk-col').first().hover(); await settle(p, 300); await p.getByRole('button', { name: /New task in/ }).first().click({ force: true }); await settle(p, 500); await park(p) },
  'tasks3-board-quick-typed': async (p) => { await board(p); await p.getByRole('button', { name: /New task in/ }).first().click({ force: true }); await settle(p, 500); await p.getByLabel('New task title').fill('Write the release notes'); await settle(p, 400); await park(p) },
  'tasks3-detail-title-focus': async (p) => { await detail(p); await p.locator('.tk-dtitle').click(); await settle(p, 500); await park(p) },
  'tasks3-detail-desc-focus': async (p) => { await detail(p); await p.locator('.tk-desc .ProseMirror').click(); await settle(p, 600); await park(p) },
  'tasks3-detail-criteria-hover': async (p) => { await detail(p); await p.locator('.tk-ci').nth(2).hover(); await settle(p, 400) },
}
