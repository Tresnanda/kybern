const settle = (p, ms = 700) => p.waitForTimeout(ms)
const park = (p) => p.mouse.move(1275, 815)
const open = async (p, title) => {
  if (!await p.getByText(title, { exact: true }).count()) { await p.getByText(/^Show \d+ more$/).first().click(); await settle(p, 300) }
  await p.getByText(title, { exact: true }).first().click(); await settle(p, 1500)
}
const ed = (p) => p.locator('[contenteditable=true]').last()
export const screens = {
  'convo9-composer-empty': async (p) => { await open(p, 'Markdown B'); await park(p) },
  'convo9-composer-text': async (p) => { await open(p, 'Markdown B'); await ed(p).click(); await p.keyboard.type('First line of a longer prompt'); await p.keyboard.press('Shift+Enter'); await p.keyboard.type('Second line'); await p.keyboard.press('Shift+Enter'); await p.keyboard.type('Third line'); await park(p) },
  'convo9-composer-mention': async (p) => { await open(p, 'Markdown B'); await ed(p).click(); await p.keyboard.type('@'); await settle(p, 1200); await park(p) },
  'convo9-composer-mention-notes': async (p) => { await open(p, 'Markdown B'); await ed(p).click(); await p.keyboard.type('@'); await settle(p, 900); await p.keyboard.press('ArrowRight'); await settle(p, 900); await p.keyboard.press('ArrowRight'); await settle(p, 1200); await park(p) },
  'convo9-composer-mention-query': async (p) => { await open(p, 'Markdown B'); await ed(p).click(); await p.keyboard.type('Look at @Rel'); await settle(p, 1200); await park(p) },
  'convo9-composer-slash': async (p) => { await open(p, 'Markdown B'); await ed(p).click(); await p.keyboard.type('/'); await settle(p, 1200); await park(p) },
  'convo9-composer-slash-query': async (p) => { await open(p, 'Markdown B'); await ed(p).click(); await p.keyboard.type('/ar'); await settle(p, 1200); await park(p) },
  'convo9-composer-token': async (p) => { await open(p, 'Markdown B'); await ed(p).click(); await p.keyboard.type('Look at @Release'); await settle(p, 1000); await p.keyboard.press('Enter'); await settle(p, 800); await p.keyboard.press('End'); await park(p) },
  'convo9-md-a': async (p) => { await open(p, 'Markdown A'); await park(p) },
  'convo9-md-b': async (p) => { await open(p, 'Markdown B'); await park(p) },
  'convo9-md-c': async (p) => { await open(p, 'Markdown C'); await park(p) },

  'convo9-visual': async (p) => { await open(p, 'Visual reply'); await settle(p, 3500); await park(p) },
  'convo9-visual-hover': async (p) => { await open(p, 'Visual reply'); await settle(p, 3500); await p.locator('[data-visual-reply]').first().hover(); await settle(p, 900) },
  'convo9-visual-expanded': async (p) => { await open(p, 'Visual reply'); await settle(p, 3500); await p.locator('[data-visual-reply]').first().hover(); await settle(p, 500); await p.getByRole('button', { name: 'Expand preview' }).click(); await settle(p, 900); await park(p) },
  'convo9-mermaid': async (p) => { await open(p, 'Mermaid diagram'); await settle(p, 3000); await park(p) },
}
