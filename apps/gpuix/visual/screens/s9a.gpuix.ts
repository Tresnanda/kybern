// settings9a (items 1-3): Settings › General / Accounts / Integrations / Computer use, the Add account
// sheet and the rail usage card, in GPUIX. Mocked daemon answers come from `mock.settings9a.ts`.
import { type Step, click, park, settle } from '../screens.gpuix.ts'
type App = Parameters<Step>[0]
const mode = async (fx: Parameters<Step>[1], value: string) => { await fetch(`http://127.0.0.1:${fx.extra.settings!.port}/mode?value=${value}`) }
const tab = async (app: App, name: string) => { await click(app, 'rail-settings'); await click(app, `settings-tab-${name}`); await settle(1200) }
const bottom = async (app: App) => { await app.mouse.wheel({ x: 700, y: 400 }, 0, -6000); await settle(900) }
const accounts: Step = async (app, fx) => { await mode(fx, 's9-rich'); await tab(app, 'accounts') }
const add = (value: string, provider = 'codex'): Step => async (app, fx) => {
  await mode(fx, value); await tab(app, 'accounts'); await click(app, `account-add-${provider}`); await settle(600)
  await click(app, `account-provider-${provider}`); await click(app, 'account-start'); await settle(1800); await park(app)
}
export const screens: Record<string, Step> = {
  's9a-general': async (app) => { await tab(app, 'general'); await park(app) },
  's9a-general-agent': async (app) => { await tab(app, 'general'); await click(app, 'settings-default-agent'); await settle(500) },
  's9a-accounts': async (app, fx) => { await accounts(app, fx); await park(app) },
  's9a-accounts-menu': async (app, fx) => { await accounts(app, fx); await click(app, 'account-actions-codex-work'); await park(app) },
  's9a-accounts-color': async (app, fx) => { await accounts(app, fx); await click(app, 'account-actions-codex-work'); await click(app, 'account-actions-codex-work-color'); await park(app) },
  's9a-accounts-remove': async (app, fx) => { await accounts(app, fx); await click(app, 'account-actions-codex-work'); await click(app, 'account-actions-codex-work-remove'); await settle(600); await park(app) },
  's9a-accounts-projects': async (app, fx) => { await accounts(app, fx); await click(app, 'account-actions-codex-work'); await click(app, 'account-actions-codex-work-projects'); await settle(600); await park(app) },
  's9a-accounts-rename': async (app, fx) => { await accounts(app, fx); await click(app, 'account-actions-codex-work'); await click(app, 'account-actions-codex-work-rename'); await settle(500); await park(app) },
  's9a-accounts-howto': async (app, fx) => { await accounts(app, fx); await click(app, 'account-how-claude-code'); await park(app) },
  's9a-computer': async (app, fx) => { await mode(fx, 's9-computer'); await tab(app, 'computer'); await park(app) },
  's9a-computer-install': async (app, fx) => { await mode(fx, 's9-computer-install'); await tab(app, 'computer'); await park(app) },
  's9a-computer-bottom': async (app, fx) => { await mode(fx, 's9-computer'); await tab(app, 'computer'); await bottom(app); await park(app) },
  's9a-computer-note': async (app, fx) => { await mode(fx, 's9-computer'); await tab(app, 'computer'); await bottom(app); await click(app, 'computer-note-edit-com.apple.Notes'); await park(app) },
  's9a-integrations': async (app, fx) => { await mode(fx, 's9-integrations'); await tab(app, 'integrations'); await park(app) },
  's9a-integrations-connectors': async (app, fx) => { await mode(fx, 's9-integrations'); await tab(app, 'integrations'); await click(app, 'integrations-kind-connector'); await park(app) },
  's9a-add-pick': async (app, fx) => { await mode(fx, 's9-rich'); await tab(app, 'accounts'); await click(app, 'account-add'); await settle(600); await park(app) },
  's9a-add-pick-selected': async (app, fx) => { await mode(fx, 's9-rich'); await tab(app, 'accounts'); await click(app, 'account-add'); await click(app, 'account-provider-codex'); await park(app) },
  's9a-add-advanced': async (app, fx) => { await mode(fx, 's9-rich'); await tab(app, 'accounts'); await click(app, 'account-add'); await click(app, 'account-provider-codex'); await click(app, 'account-advanced'); await park(app) },
  's9a-add-waiting': add('s9-login-waiting'),
  's9a-add-paste': add('s9-login-paste', 'claude-code'),
  's9a-add-device': add('s9-login-device'),
  's9a-add-success': add('s9-login-success'),
  's9a-add-duplicate': add('s9-login-duplicate'),
  's9a-add-error': add('s9-login-error'),
  's9a-usage-card': async (app, fx) => { await mode(fx, 's9-rich'); await settle(1500); await app.getByTestId('rail-usage-codex').hover(); await settle(1500) },
  's9a-usage-card-claude': async (app, fx) => { await mode(fx, 's9-rich'); await settle(1500); await app.getByTestId('rail-usage-claude-code').hover(); await settle(1500) },
}
