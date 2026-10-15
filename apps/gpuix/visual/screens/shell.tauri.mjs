const park = (p) => p.mouse.move(1275, 815)
const home = async (p) => { await p.getByRole('button', { name: 'Home', exact: true }).first().click(); await p.waitForTimeout(800) }
export const screens = {
  'shell-home': async (p) => { await home(p); await park(p) },
  'shell-sidebar-collapsed': async (p) => { await home(p); await p.getByRole('button', { name: 'Toggle thread sidebar' }).click(); await p.waitForTimeout(700); await park(p) },
  'shell-sidebar-hover': async (p) => { await home(p); await p.mouse.move(130, 354); await p.waitForTimeout(500) },
  'shell-new-chat-hover': async (p) => { await home(p); await p.mouse.move(116, 147); await p.waitForTimeout(500) },
}
