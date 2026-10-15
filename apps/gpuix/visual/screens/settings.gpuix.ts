import { type Step, click, settle, park } from '../screens.gpuix.ts'
const tabs = ['general', 'appearance', 'notifications', 'agents', 'accounts', 'integrations', 'computer', 'background', 'about']
export const screens: Record<string, Step> = Object.fromEntries(tabs.map(tab => [`settings-${tab}`, async (app) => { await click(app, 'rail-settings'); await click(app, `settings-tab-${tab}`); await settle(1200); await park(app) }]))
screens['settings-search'] = async app => { await click(app, 'rail-settings'); await app.getByTestId('settings-search').fill('theme'); await settle(); await park(app) }
screens['settings-search-empty'] = async app => { await click(app, 'rail-settings'); await app.getByTestId('settings-search').fill('zzzz'); await settle(); await park(app) }
screens['settings-hover'] = async app => { await click(app, 'rail-settings'); await app.getByTestId('settings-tab-appearance').hover(); await settle() }
screens['usage-empty'] = async app => { await click(app, 'rail-usage'); await settle(1200); await park(app) }
const mode = async (fx: Parameters<Step>[1], value: string) => { await fetch(`http://127.0.0.1:${fx.extra.settings!.port}/mode?value=${value}`) }
const pulls: Step = async (app, fx) => { await mode(fx, ''); await click(app, 'rail-pulls'); await settle(1200) }
const detail: Step = async (app, fx) => { await pulls(app, fx); await click(app, 'pr-row-108'); await settle(1200) }
screens['pulls-list'] = async (app, fx) => { await pulls(app, fx); await park(app) }
screens['pulls-summary'] = async (app, fx) => { await detail(app, fx); await park(app) }
screens['pulls-changes'] = async (app, fx) => { await detail(app, fx); await click(app, 'pr-tab-changes'); await park(app) }
screens['pulls-timeline'] = async (app, fx) => { await detail(app, fx); await click(app, 'pr-tab-timeline'); await park(app) }
screens['pulls-review'] = async (app, fx) => { await detail(app, fx); await click(app, 'pr-review'); await park(app) }
screens['pulls-merge-menu'] = async (app, fx) => { await detail(app, fx); await click(app, 'pr-merge-menu'); await park(app) }
screens['pulls-empty'] = async (app, fx) => { await mode(fx, 'empty'); await click(app, 'rail-pulls'); await settle(1200); await park(app) }
screens['pulls-error'] = async (app, fx) => { await mode(fx, 'error'); await click(app, 'rail-pulls'); await settle(1200); await park(app) }
screens['usage-empty'] = async (app, fx) => { await mode(fx, 'usage-empty'); await click(app, 'rail-usage'); await settle(1200); await park(app) }
screens['usage-populated'] = async (app, fx) => { await mode(fx, ''); await click(app, 'rail-usage'); await settle(1200); await park(app) }
screens['dialog-account'] = async app => { await click(app, 'rail-settings'); await click(app, 'settings-tab-accounts'); await click(app, 'account-add'); await park(app) }
screens['palette'] = async app => { await app.getByTestId('app-ready').press('cmd-k'); await settle(900); await park(app) }

screens['pulls-draft'] = async (app, fx) => { await mode(fx, 'draft'); await click(app, 'rail-pulls'); await settle(1200); await click(app, 'pr-row-108'); await settle(1200); await park(app) }

screens['dialog-project'] = async app => { await click(app,'app-menu'); await app.getByText('Add project').click(); await settle(1200); await park(app) }
screens['dialog-worktree'] = async (app,fx) => { await click(app,`thread-${fx.extra.settings!.threadId}`); await settle(1200); await click(app,'thread-actions'); await click(app,'header-worktree-cleanup'); await settle(1200); await park(app) }

screens['settings-focus'] = async app => { await click(app,'rail-settings'); await click(app,'settings-search'); await settle(); await park(app) }
screens['pulls-hover'] = async (app,fx) => { await pulls(app,fx); await app.getByTestId('pr-row-108').hover(); await settle() }

screens['dialog-worktree-checked'] = async (app,fx) => { await screens['dialog-worktree']!(app,fx); await click(app,'worktree-delete-branch'); await park(app) }
