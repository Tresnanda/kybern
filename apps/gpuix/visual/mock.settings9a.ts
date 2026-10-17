/**
 * Mocked daemon answers for the settings9a visual screens (Settings › Accounts / Computer use /
 * Integrations, the Add account sheet and the rail usage card). The same answers feed the desktop
 * frontend and GPUIX through the settings proxy, so both draw identical data. `mode` is set with
 * `/mode?value=s9-…`; any other mode falls through to the proxy's own mocks.
 */
const nowSec = () => Math.floor(Date.now() / 1000)
const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString()

const provider = (kind: string, display_name: string, available: boolean) => ({ kind, display_name, available, binary_path: available ? `/fixture/bin/${kind}` : null, version: available ? '1.0.0' : null, models: [{ id: 'm', display_name: 'Model', is_default: true, efforts: ['low', 'medium', 'high'], default_effort: 'medium' }], supports_effort_switch: true, supported_efforts: ['low', 'medium', 'high'], supported_permission_modes: ['supervised', 'auto', 'full-access'], supports_fork: true, supports_model_switch: true, instances: [] })
const providers = [provider('claude-code', 'Claude Code', true), provider('codex', 'Codex', true), provider('cursor', 'Cursor', false)]

const account = (kind: string, instance: string, name: string, extra: Record<string, unknown> = {}) => ({ provider: { kind, instance }, name, status: 'signed_in', is_default: false, projects: [], managed: instance !== 'default', can_sign_out: instance !== 'default', ...extra })
const accounts = [
  account('claude-code', 'default', 'CLI account', { is_default: true, status: 'needs_sign_in', identity: { email: 'me@example.test', plan: 'Max' } }),
  account('claude-code', 'client', 'Client work', { color: 'purple', status: 'signed_out', identity: { email: 'client@example.test' } }),
  account('codex', 'default', 'CLI account', { identity: { email: 'me@example.test', plan: 'Plus' } }),
  account('codex', 'work', 'Work', { color: 'blue', is_default: true, projects: ['/fixture/projects/app'], identity: { email: 'work@example.test', plan: 'Pro' } }),
  account('codex', 'side', 'Side projects', { color: 'amber', status: 'needs_sign_in', identity: { email: 'side@example.test' } }),
]
const limit = (name: string, used: number, minutes: number, resetsInMinutes: number) => ({ name, used_percent: used, window_minutes: minutes, resets_at: nowSec() + resetsInMinutes * 60 })
const limits = (): unknown => {
  const entry = (kind: string, instance: string | undefined, a: number, b: number, plan: string) => ({ provider: kind, ...(instance ? { instance } : {}), limits: [limit('primary', a, 300, 134), limit('secondary', b, 10080, 4 * 24 * 60)], updated_at: iso(2), plan })
  return {
    providers: [entry('claude-code', undefined, 41, 22, 'Max'), entry('codex', undefined, 35, 12, 'Pro')],
    accounts: [entry('claude-code', 'default', 41, 22, 'Max'), entry('codex', 'default', 62, 18, 'Plus'), entry('codex', 'work', 35, 12, 'Pro')],
    refreshing: [],
  }
}

const login = (patch: Record<string, unknown>) => ({ id: 'login-1', kind: 'codex', mode: 'browser', phase: 'waiting', expires_at: new Date(Date.now() + 15 * 60_000).toISOString(), ...patch })
const LOGINS: Record<string, Record<string, unknown>> = {
  's9-login-waiting': { mode: 'browser', phase: 'waiting', url: 'https://auth.openai.com/oauth/authorize?x=1' },
  's9-login-paste': { kind: 'claude-code', mode: 'paste', phase: 'waiting', url: 'https://claude.com/cai/oauth/authorize?x=1' },
  's9-login-device': { mode: 'device_code', phase: 'waiting', url: 'https://auth.openai.com/codex/device', user_code: 'ABCD-1234' },
  's9-login-success': { mode: 'browser', phase: 'signed_in', identity: { email: 'new@example.test', plan: 'Plus' }, suggested_name: 'New account', suggested_color: 'green' },
  's9-login-duplicate': { mode: 'browser', phase: 'signed_in', identity: { email: 'work@example.test', plan: 'Pro' }, duplicate_of: 'work' },
  's9-login-error': { mode: 'browser', phase: 'failed', error: 'The sign-in page timed out. Try again.' },
}

const notes = [
  { bundle_id: 'com.apple.Notes', app: 'Notes', text: 'Use the sidebar to switch folders.\nNew notes open at the top of the list.\nPress Return to leave the title.', updated_at: iso(60 * 24) },
  { bundle_id: 'com.apple.calculator', app: 'Calculator', text: 'Clear with the C button before starting a new sum.', updated_at: iso(60 * 48) },
]

const integrations = {
  items: [
    { id: 'frontend-design', name: 'frontend-design', kind: 'plugin', description: 'Create distinctive, production-grade frontend interfaces with high design quality.', scope: 'user', installed: true, enabled: true, status: 'Installed · v1.2.0', actions: ['disable', 'uninstall'], connect_url: null, can_login: false },
    { id: 'code-review', name: 'code-review', kind: 'plugin', description: 'Review a pull request with parallel agents.', scope: 'user', installed: true, enabled: false, status: 'Installed · v0.9.4', actions: ['enable', 'update', 'uninstall'], connect_url: null, can_login: false },
    { id: 'linear', name: 'Linear', kind: 'connector', description: 'Search issues and projects.', scope: null, installed: true, enabled: true, status: 'Needs sign-in', actions: [], connect_url: 'https://claude.ai/settings/connectors', can_login: true },
    { id: 'notion', name: 'Notion', kind: 'connector', description: null, scope: null, installed: false, enabled: false, status: 'Available', actions: [], connect_url: 'https://claude.ai/settings/connectors', can_login: false },
  ],
  warnings: [],
}

export function settings9aMock(method: string, mode: string, params: Record<string, unknown> | undefined): unknown | undefined {
  if (!mode.startsWith('s9-')) return undefined
  switch (method) {
    case 'providers.list': return { providers }
    case 'providers.accounts.list': return { accounts }
    case 'usage.limits': return limits()
    case 'computer.status':
      if (mode === 's9-computer') return { supported: true, enabled: true, installed: true, app_path: '/Applications/CuaDriver.app', version: '0.4.2', required_version: '0.4.0', signed: true, accessibility: 'granted', screen_recording: 'missing', ready: false, checks: [] }
      if (mode === 's9-computer-install') return { supported: true, enabled: true, installed: false, required_version: '0.4.0', signed: false, accessibility: 'unknown', screen_recording: 'unknown', ready: false, checks: [{ name: 'installed', ok: false, message: 'CuaDriver isn’t installed in Applications.' }] }
      return undefined
    case 'computer.notes.list': return mode === 's9-computer' ? { notes } : undefined
    case 'integrations.list': return mode === 's9-integrations' ? integrations : undefined
    case 'providers.accounts.login.start': return mode in LOGINS ? login({ kind: params?.kind ?? 'codex', ...LOGINS[mode] }) : undefined
    case 'providers.accounts.login.get':
    case 'providers.accounts.login.input':
    case 'providers.accounts.login.cancel': return mode in LOGINS ? login({ ...LOGINS[mode] }) : undefined
    case 'providers.accounts.login.finish': return { kind: 'codex', instance: 'new' }
    default: return undefined
  }
}
