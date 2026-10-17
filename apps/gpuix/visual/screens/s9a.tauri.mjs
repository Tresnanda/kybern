// settings9a (items 1-3) in the desktop frontend (WebKit); mirrors s9a.gpuix.ts.
const park = p => p.mouse.move(1275, 815).then(() => p.waitForTimeout(1200))
// The desktop loads agents and accounts when it connects, so a mode that changes them needs a reload to be seen.
const mode = async (p, value) => {
  const ws = new URL(new URL(p.url()).searchParams.get('url')); await p.request.get(`http://${ws.host}/mode?value=${value}`)
  if (value.startsWith('s9-')) { await p.reload(); await p.waitForSelector('button[aria-label="Notes"]', { timeout: 30000 }); await p.waitForTimeout(1500) }
}
const tabs = { general: 'General', accounts: 'Accounts', integrations: 'Integrations', computer: 'Computer use' }
const tab = async (p, name) => { await p.getByRole('button', { name: 'Settings', exact: true }).click(); await p.waitForTimeout(900); await p.getByRole('button', { name: tabs[name], exact: true }).click(); await p.waitForTimeout(1200) }
const bottom = async p => { await p.mouse.move(700, 400); await p.mouse.wheel(0, 6000); await p.waitForTimeout(900) }
const accounts = async p => { await mode(p, 's9-rich'); await tab(p, 'accounts') }
const menu = async (p, item) => { await accounts(p); await p.getByRole('button', { name: 'Work options', exact: true }).click(); if (item) await p.getByRole('menuitem', { name: item }).click(); await p.waitForTimeout(600) }
const start = (value, provider = 'Codex') => async p => {
  await mode(p, value); await tab(p, 'accounts'); await p.getByRole('button', { name: `Add ${provider} account`, exact: true }).click(); await p.waitForTimeout(600)
  await p.getByRole('radio', { name: provider, exact: true }).click(); await p.getByRole('button', { name: /^Continue/ }).click(); await p.waitForTimeout(1800); await park(p)
}
export const screens = {
  's9a-general': async p => { await tab(p, 'general'); await park(p) },
  's9a-general-agent': async p => { await tab(p, 'general'); await p.getByRole('button', { name: /claude-code|Codex|Claude Code/ }).first().click(); await p.waitForTimeout(500) },
  's9a-accounts': async p => { await accounts(p); await park(p) },
  's9a-accounts-menu': async p => { await menu(p); await park(p) },
  's9a-accounts-color': async p => { await accounts(p); await p.getByRole('button', { name: 'Work options', exact: true }).click(); await p.getByRole('menuitem', { name: 'Color' }).click(); await p.waitForTimeout(500); await park(p) },
  's9a-accounts-remove': async p => { await menu(p, 'Remove…'); await park(p) },
  's9a-accounts-projects': async p => { await menu(p, 'Use for projects…'); await park(p) },
  's9a-accounts-rename': async p => { await menu(p, 'Rename…'); await park(p) },
  's9a-accounts-howto': async p => { await accounts(p); await p.getByRole('button', { name: 'How to sign in' }).first().click(); await park(p) },
  's9a-computer': async p => { await mode(p, 's9-computer'); await tab(p, 'computer'); await park(p) },
  's9a-computer-install': async p => { await mode(p, 's9-computer-install'); await tab(p, 'computer'); await park(p) },
  's9a-computer-bottom': async p => { await mode(p, 's9-computer'); await tab(p, 'computer'); await bottom(p); await park(p) },
  's9a-computer-note': async p => { await mode(p, 's9-computer'); await tab(p, 'computer'); await bottom(p); await p.getByRole('button', { name: 'Edit', exact: true }).first().click(); await park(p) },
  's9a-integrations': async p => { await mode(p, 's9-integrations'); await tab(p, 'integrations'); await park(p) },
  's9a-integrations-connectors': async p => { await mode(p, 's9-integrations'); await tab(p, 'integrations'); await p.getByRole('button', { name: 'Connectors', exact: true }).click(); await park(p) },
  's9a-add-pick': async p => { await mode(p, 's9-rich'); await tab(p, 'accounts'); await p.getByRole('button', { name: 'Add account', exact: true }).first().click(); await p.waitForTimeout(600); await park(p) },
  's9a-add-pick-selected': async p => { await mode(p, 's9-rich'); await tab(p, 'accounts'); await p.getByRole('button', { name: 'Add account', exact: true }).first().click(); await p.getByRole('radio', { name: 'Codex', exact: true }).click(); await park(p) },
  's9a-add-advanced': async p => { await mode(p, 's9-rich'); await tab(p, 'accounts'); await p.getByRole('button', { name: 'Add account', exact: true }).first().click(); await p.getByRole('radio', { name: 'Codex', exact: true }).click(); await p.getByRole('button', { name: 'Advanced' }).click(); await park(p) },
  's9a-add-waiting': start('s9-login-waiting'),
  's9a-add-paste': start('s9-login-paste', 'Claude Code'),
  's9a-add-device': start('s9-login-device'),
  's9a-add-success': start('s9-login-success'),
  's9a-add-duplicate': start('s9-login-duplicate'),
  's9a-add-error': start('s9-login-error'),
  's9a-usage-card': async p => { await mode(p, 's9-rich'); await p.waitForTimeout(1500); await p.getByTestId('rail-usage-codex').hover(); await p.waitForTimeout(1500) },
  's9a-usage-card-claude': async p => { await mode(p, 's9-rich'); await p.waitForTimeout(1500); await p.getByTestId('rail-usage-claude-code').hover(); await p.waitForTimeout(1500) },
}
