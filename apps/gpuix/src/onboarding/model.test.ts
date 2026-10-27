import { describe, expect, test } from 'bun:test'
import type { AccountSummary, ProviderKind, ProviderStatus } from '../../../../packages/kybern-client/src/types.ts'
import { BLUR_MAX, normalizeVariantMaterial } from '../platform/translucency.ts'
import { applyMaterialPatch } from './prefsModel.ts'
import {
  agentCommand, applyOverride, blurPercent, contentSlider, continueLabel, deriveAgent, isReturningUser, limitFor, materialPatch, materialSummary, optionOf, pickDefault, shouldOnboard,
  statusLine, type AgentState, type GateInput,
} from './model.ts'

const gate = (over: Partial<GateInput> = {}): GateInput => ({ listsLoaded: true, connected: true, projects: 0, threads: 0, threadOpen: false, completed: false, forced: false, ...over })

describe('gate', () => {
  test('opens on a brand-new install', () => expect(shouldOnboard(gate())).toBe(true))
  test('waits for the daemon and the lists', () => {
    expect(shouldOnboard(gate({ listsLoaded: false }))).toBe(false)
    expect(shouldOnboard(gate({ connected: false }))).toBe(false)
  })
  test('never opens for a returning user', () => {
    expect(shouldOnboard(gate({ projects: 1 }))).toBe(false)
    expect(shouldOnboard(gate({ threads: 2 }))).toBe(false)
    expect(shouldOnboard(gate({ threadOpen: true }))).toBe(false)
    expect(shouldOnboard(gate({ completed: true }))).toBe(false)
  })
  test('the developer flag opens it on an existing data directory', () => {
    expect(shouldOnboard(gate({ forced: true, projects: 3, completed: true }))).toBe(true)
    expect(shouldOnboard(gate({ forced: true, listsLoaded: false }))).toBe(false)
  })
  test('a window with data and no mark is a returning user', () => {
    expect(isReturningUser({ projects: 1, threads: 0, completed: false })).toBe(true)
    expect(isReturningUser({ projects: 0, threads: 0, completed: false })).toBe(false)
    expect(isReturningUser({ projects: 1, threads: 0, completed: true })).toBe(false)
  })
})

describe('import mode', () => {
  test('maps to the daemon limit', () => {
    expect(limitFor('latest')).toBe(50)
    expect(limitFor('all')).toBeNull()
    expect(limitFor('none')).toBe(0)
  })
})

describe('default agent', () => {
  const ready = (...kinds: ProviderKind[]) => kinds
  test('follows provider order until the user picks', () => {
    expect(pickDefault(ready('codex', 'cursor'), null)).toBe('codex')
    // Claude Code finishes detecting later and takes over.
    expect(pickDefault(ready('codex', 'cursor', 'claude-code'), null)).toBe('claude-code')
    expect(pickDefault(ready('pi', 'omp'), null)).toBe('omp')
  })
  test('stays put once picked', () => {
    expect(pickDefault(ready('claude-code', 'codex'), 'codex')).toBe('codex')
    expect(pickDefault(ready('codex', 'claude-code', 'cursor'), 'cursor')).toBe('cursor')
  })
  test('a pick that is no longer ready is dropped', () => expect(pickDefault(ready('claude-code'), 'codex')).toBe('claude-code'))
  test('nothing ready, no default', () => expect(pickDefault([], null)).toBeNull())
})

describe('status line (SPEC §3d)', () => {
  const states = (s: Partial<Record<ProviderKind, AgentState>>) => s
  const mac = 'this Mac'
  test('still checking, none ready', () => expect(statusLine(states({ 'claude-code': 'checking', codex: 'checking' }), null, mac)).toBe('Looking for agents on this Mac…'))
  test('names the machine', () => expect(statusLine(states({ codex: 'checking' }), null, 'studio-mini')).toBe('Looking for agents on studio-mini…'))
  test('none ready', () => expect(statusLine(states({ 'claude-code': 'missing', codex: 'signin' }), null, mac)).toBe('Install or sign in to an agent to continue. Click one to start.'))
  test('one ready, one to sign in to', () => expect(statusLine(states({ 'claude-code': 'ready', codex: 'signin', cursor: 'missing' }), 'claude-code', mac)).toBe('Claude Code is ready. Sign in to Codex to use both, side by side.'))
  test('one ready, three to sign in to', () => expect(statusLine(states({ 'claude-code': 'ready', codex: 'signin', omp: 'unknown', pi: 'signin' }), 'claude-code', mac)).toBe('Claude Code is ready. Sign in to Codex, Oh My Pi, and pi to use them all, side by side.'))
  test('one ready, nothing to sign in to', () => expect(statusLine(states({ 'claude-code': 'ready', codex: 'missing', pi: 'missing' }), 'claude-code', mac)).toBe('Claude Code is ready. Add more agents anytime to use them side by side.'))
  test('two ready', () => expect(statusLine(states({ 'claude-code': 'ready', codex: 'ready' }), 'claude-code', mac)).toBe('You can use Claude Code and Codex side by side. New chats start with Claude Code.'))
  test('three or more ready', () => expect(statusLine(states({ 'claude-code': 'ready', codex: 'ready', cursor: 'ready', pi: 'ready' }), 'claude-code', mac)).toBe('All 4 agents are ready to use side by side. New chats start with Claude Code.'))
  test('the default is the user pick, not the first ready', () => expect(statusLine(states({ 'claude-code': 'ready', codex: 'ready' }), 'codex', mac)).toContain('New chats start with Codex.'))
  test('the button never names a harness', () => {
    expect(continueLabel(0)).toBe('Continue')
    expect(continueLabel(1)).toBe('Continue with 1 agent')
    expect(continueLabel(4)).toBe('Continue with 4 agents')
  })
})

describe('agent state', () => {
  const status = (over: Partial<ProviderStatus> = {}): ProviderStatus => ({ kind: 'codex', display_name: 'Codex', available: true, supported_permission_modes: [], supports_fork: false, supports_model_switch: false, instances: [], ...over })
  const account = (state: AccountSummary['status']): AccountSummary => ({ provider: { kind: 'codex', instance: 'default' }, name: 'default', status: state, is_default: true, projects: [], managed: false, can_sign_out: false })
  test('checking until the daemon answers', () => {
    expect(deriveAgent(undefined, [], false)).toBe('checking')
    expect(deriveAgent(undefined, [], true)).toBe('checking')
  })
  test('missing, update, ready, sign in, unknown', () => {
    expect(deriveAgent(status({ available: false }), [], true)).toBe('missing')
    expect(deriveAgent(status({ available: false, binary_path: '/usr/bin/codex' }), [], true)).toBe('update')
    expect(deriveAgent(status(), [account('signed_in')], true)).toBe('ready')
    expect(deriveAgent(status(), [account('needs_sign_in')], true)).toBe('signin')
    expect(deriveAgent(status(), [account('unknown')], true)).toBe('unknown')
    expect(deriveAgent(status(), [], true)).toBe('unknown')
  })
  test('what the user is doing wins', () => {
    expect(applyOverride('signin', 'waiting')).toBe('waiting')
    expect(applyOverride('missing', 'installing')).toBe('installing')
    expect(applyOverride('unknown', 'assumed')).toBe('ready')
    expect(applyOverride('missing', 'assumed')).toBe('missing')
  })
  test('commands are typed, per agent', () => {
    expect(agentCommand('opencode', 'install')).toBe('npm install -g opencode-ai')
    expect(agentCommand('codex', 'update')).toBe('npm install -g @openai/codex@latest')
    expect(agentCommand('claude-code', 'login')).toBe('claude auth login')
    expect(agentCommand('cursor', 'install')).toBeNull()
  })
})

describe('window material', () => {
  const base = normalizeVariantMaterial({})
  test('the options map to VariantMaterial', () => {
    expect(materialPatch('solid', 'darwin')).toEqual({ material: 'solid' })
    expect(materialPatch('sidebar', 'darwin')).toEqual({ material: 'translucent', sidebarOpacity: 85, contentOpacity: 100, surfaceOpacity: 60, blur: BLUR_MAX })
    expect(materialPatch('full', 'darwin')).toEqual({ material: 'translucent', sidebarOpacity: 85, contentOpacity: 85, surfaceOpacity: 60, blur: BLUR_MAX })
  })
  test('on Windows the sidebar keeps Mica and the whole window is Acrylic', () => {
    expect(materialPatch('sidebar', 'win32').blur).toBeNull()
    expect(materialPatch('full', 'win32').blur).toBe(BLUR_MAX)
  })
  test('written values round-trip to the same option', () => {
    for (const option of ['solid', 'sidebar', 'full'] as const) expect(optionOf(applyMaterialPatch(base, materialPatch(option, 'darwin')))).toBe(option)
    const full = applyMaterialPatch(base, materialPatch('full', 'darwin'))
    expect(full).toMatchObject({ sidebarOpacity: 85, contentOpacity: 85, blur: BLUR_MAX })
    expect(full.surfaceOpacity).toBe(60)
  })
  test('the content slider switches sidebar and full', () => {
    expect(contentSlider(99).option).toBe('full')
    expect(contentSlider(60).option).toBe('full')
    expect(contentSlider(100).option).toBe('sidebar')
    const dragged = applyMaterialPatch(applyMaterialPatch(base, materialPatch('sidebar', 'darwin')), contentSlider(70).patch)
    expect(optionOf(dragged)).toBe('full')
    expect(optionOf(applyMaterialPatch(dragged, contentSlider(100).patch))).toBe('sidebar')
  })
  test('the closed Adjust row', () => {
    const m = applyMaterialPatch(base, materialPatch('full', 'darwin'))
    expect(blurPercent(m.blur)).toBe(100)
    expect(materialSummary(m, 60)).toBe('Sidebar 85% · Content 85% · Elements 60% · Blur 100%')
    expect(materialSummary(m, 60, false)).toBe('Sidebar 85% · Content 85% · Elements 60%')
  })
})
