const tabs = { general: 'General', appearance: 'Appearance', notifications: 'Notifications', agents: 'Agent providers', accounts: 'Accounts', integrations: 'Integrations', computer: 'Computer use', background: 'Background activity', about: 'About' }
const open = async p => { await p.getByRole('button', { name: 'Settings', exact: true }).click(); await p.waitForTimeout(900) }
const park = async p => { await p.mouse.move(1275,815); await p.waitForTimeout(1200) }
export const screens = Object.fromEntries(Object.entries(tabs).map(([tab, name]) => [`settings-${tab}`, async p => { await open(p); await p.getByRole('button', { name, exact: true }).click(); await park(p) }]))
screens['settings-search'] = async p => { await open(p); await p.getByPlaceholder('Search settings…').fill('theme'); await park(p) }
screens['settings-search-empty'] = async p => { await open(p); await p.getByPlaceholder('Search settings…').fill('zzzz'); await park(p) }
screens['settings-hover'] = async p => { await open(p); await p.getByRole('button', { name: 'Appearance', exact:true }).hover(); await p.waitForTimeout(900) }
screens['usage-empty'] = async p => { await p.getByRole('button', { name: 'Usage', exact:true }).click(); await park(p) }
const mode = async (p, value) => { const ws = new URL(new URL(p.url()).searchParams.get('url')); await p.request.get(`http://${ws.host}/mode?value=${value}`) }
const pulls = async p => { await mode(p, ''); await p.getByRole('button', { name: 'Pull requests', exact: true }).first().click(); await p.waitForTimeout(1200) }
const detail = async p => { await pulls(p); await p.getByText('Preserve reading position while streaming', { exact: true }).first().click(); await p.waitForTimeout(1200) }
screens['pulls-list'] = async p => { await pulls(p); await park(p) }
screens['pulls-summary'] = async p => { await detail(p); await park(p) }
screens['pulls-changes'] = async p => { await detail(p); await p.getByRole('tab', { name: /^Changes/ }).click(); await park(p) }
screens['pulls-timeline'] = async p => { await detail(p); await p.getByRole('tab', { name: /^Timeline/ }).click(); await park(p) }
screens['pulls-review'] = async p => { await detail(p); await p.getByRole('button', { name: 'Review', exact: true }).click(); await park(p) }
screens['pulls-merge-menu'] = async p => { await detail(p); await p.getByRole('button', { name: 'More merge options' }).click(); await park(p) }
screens['pulls-empty'] = async p => { await mode(p, 'empty'); await p.getByRole('button', { name: 'Pull requests', exact: true }).first().click(); await park(p) }
screens['pulls-error'] = async p => { await mode(p, 'error'); await p.getByRole('button', { name: 'Pull requests', exact: true }).first().click(); await park(p) }
screens['usage-empty'] = async p => { await mode(p, 'usage-empty'); await p.getByRole('button', { name: 'Usage', exact: true }).click(); await park(p) }
screens['usage-populated'] = async p => { await mode(p, ''); await p.getByRole('button', { name: 'Usage', exact: true }).click(); await park(p) }
screens['dialog-account'] = async p => { await open(p); await p.getByRole('button', { name: 'Accounts', exact: true }).click(); await p.getByRole('button', { name: 'Add account', exact: true }).first().click(); await park(p) }
screens['palette'] = async p => { await p.keyboard.press('Meta+k'); await park(p) }

screens['pulls-draft'] = async p => { await mode(p, 'draft'); await p.getByRole('button', { name: 'Pull requests', exact: true }).first().click(); await p.waitForTimeout(1200); await p.getByText('Preserve reading position while streaming', { exact: true }).first().click(); await park(p) }

screens['dialog-project'] = async p => { await p.getByRole('button',{name:'App menu',exact:true}).click(); await p.getByRole('menuitem',{name:/Add project/}).click(); await park(p) }
screens['dialog-worktree'] = async p => { await p.getByText('Visual worktree',{exact:true}).first().click(); await p.waitForTimeout(1200); await p.getByRole('button',{name:'Thread actions',exact:true}).click(); await p.getByRole('menuitem',{name:'Remove worktree…',exact:true}).click(); await park(p) }

screens['settings-focus'] = async p => { await open(p); await p.getByPlaceholder('Search settings…').focus(); await park(p) }
screens['pulls-hover'] = async p => { await pulls(p); await p.getByText('Preserve reading position while streaming',{exact:true}).first().hover(); await p.waitForTimeout(1200) }

screens['dialog-worktree-checked'] = async p => { await screens['dialog-worktree'](p); await p.getByRole('checkbox').last().click(); await park(p) }
