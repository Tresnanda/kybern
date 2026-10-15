const settle = (p, ms = 700) => p.waitForTimeout(ms)
const park = (p) => p.mouse.move(1275, 815)
const open = async (p, title) => { await p.getByText(title, { exact: true }).first().click(); await settle(p, 1500) }

export const screens = {
  'conversation-transcript': async (p) => { await open(p, 'Date helper cleanup'); await park(p) },
}
