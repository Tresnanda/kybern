// The Add an account picker lists Antigravity alongside the other sign-in agents (issue #347). Its
// first sign-in is this computer's own login, through the one-time Google notice; once that is
// signed in, picking it again adds a named account with a profile of its own.
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { useEffect, type ReactNode } from 'react'
import type { AccountSummary, ProviderKind, ProviderStatus } from '../../../../packages/kybern-client/src/types.ts'
import { showDialog, useDialog } from './store.ts'

let noticeSeen = false
mock.module('../antigravity/notice.ts', () => ({
  antigravityNoticeSeen: () => noticeSeen,
  acknowledgeAntigravityNotice: () => { noticeSeen = true },
  requestAntigravitySignIn: (proceed: () => void) => {
    if (noticeSeen) proceed()
    else showDialog({ kind: 'antigravity-notice', proceed })
  },
}))

const { accountPickerOptions, addsNamedAntigravityAccount, antigravityAccountsBlocked, isAntigravitySignedIn } = await import('./accountPicker.ts')
const { Account, PickStep } = await import('./Account.tsx')
const { ThemeProvider } = await import('../ui.tsx')
const { setNav } = await import('../nav/store.ts')

const entry = createRequire(import.meta.url).resolve('@gpuix/react')
const { createRoot, flushSync } = await import(pathToFileURL(path.join(path.dirname(entry), 'reconciler/reconciler.js')).href)
const { handleGpuixEvent } = await import(pathToFileURL(path.join(path.dirname(entry), 'reconciler/event-registry.js')).href)

function harness() {
  const children = new Map<number, number[]>()
  const custom = new Map<number, Record<string, any>>()
  const styles = new Map<number, Record<string, any>>()
  const listeners = new Map<number, Set<string>>()
  const text = new Map<number, string>()
  let rootId = 0
  const detach = (id: number) => {
    for (const list of children.values()) {
      const at = list.indexOf(id)
      if (at >= 0) list.splice(at, 1)
    }
  }
  const renderer = {
    applyBatch(json: string) {
      const gone: number[] = []
      for (const [op, id, a, b] of JSON.parse(json) as [string, number, any, any][]) {
        if (op === 'createElement') { children.set(id, []); custom.set(id, {}); styles.set(id, {}); listeners.set(id, new Set()) }
        else if (op === 'setCustomProp') custom.get(id)![a] = b
        else if (op === 'setStyle') styles.set(id, (a ?? {}) as Record<string, any>)
        else if (op === 'setEventListener') {
          if (b) listeners.get(id)!.add(a)
          else listeners.get(id)!.delete(a)
        }
        else if (op === 'setText') text.set(id, String(a ?? ''))
        else if (op === 'appendChild') { detach(a); children.get(id)!.push(a) }
        else if (op === 'insertBefore') {
          detach(a)
          const list = children.get(id)!
          const at = list.indexOf(b)
          list.splice(at < 0 ? list.length : at, 0, a)
        }
        else if (op === 'removeChild') detach(a)
        else if (op === 'destroyElement') { detach(id); gone.push(id) }
        else if (op === 'setRoot') rootId = id
      }
      return gone
    },
    setWindowKeyEvents() {},
    setWindowSelectionChange() {},
    addLayoutObserver: () => 1,
    removeLayoutObserver() {},
    isLayoutObserverActive: () => true,
    focusElement() {},
  }
  const root = createRoot(renderer)
  const walk = (id: number, out: number[] = []) => {
    out.push(id)
    for (const child of children.get(id) ?? []) walk(child, out)
    return out
  }
  const textOf = (id: number): string => {
    const parts: string[] = []
    for (const node of walk(id)) {
      const own = text.get(node)
      if (own) parts.push(own)
      const propText = custom.get(node)?.text
      if (typeof propText === 'string') parts.push(propText)
    }
    return parts.join(' ')
  }
  return {
    close: () => { flushSync(() => root.render(null)) },
    render: (node: ReactNode) => { flushSync(() => root.render(node)) },
    find: (testId: string) => walk(rootId).find((id) => custom.get(id)?.testId === testId),
    props: (id: number) => custom.get(id) ?? {},
    style: (id: number) => styles.get(id) ?? {},
    listeners: (id: number) => listeners.get(id) ?? new Set<string>(),
    textOf,
    fire: (id: number, payload: Record<string, unknown>) => flushSync(() => handleGpuixEvent({ elementId: id, ...payload }, renderer)),
  }
}

const provider = (kind: ProviderKind, display_name: string, available = true): ProviderStatus => ({
  kind,
  display_name,
  available,
  supported_permission_modes: [],
  supports_fork: false,
  supports_model_switch: true,
  models: [],
  instances: ['default'],
})

const account = (kind: ProviderKind, status: AccountSummary['status'], patch: Partial<AccountSummary> = {}): AccountSummary => ({
  provider: { kind, instance: 'default' },
  name: 'CLI account',
  status,
  is_default: true,
  projects: [],
  managed: false,
  can_sign_out: false,
  ...patch,
})

const ALL_PROVIDERS: ProviderStatus[] = [
  provider('claude-code', 'Claude Code'),
  provider('codex', 'Codex'),
  provider('cursor', 'Cursor'),
  provider('antigravity', 'Antigravity'),
  provider('grok-build', 'Grok Build'),
  provider('opencode', 'OpenCode'),
  provider('pi', 'Pi'),
  provider('omp', 'Oh My Pi'),
]

afterEach(() => {
  showDialog(null)
  setNav({ providers: [], providersLoaded: false })
  noticeSeen = false
})

describe('accountPickerOptions', () => {
  test('lists Antigravity alongside Claude Code, Codex and Cursor, and still hides Grok Build and non-account agents', () => {
    const options = accountPickerOptions(ALL_PROVIDERS)
    expect(options.map((o) => o.kind)).toEqual(['claude-code', 'codex', 'cursor', 'antigravity'])
    expect(options.every((o) => !o.disabled && o.disabledReason === undefined)).toBe(true)
  })

  test('adds a named Antigravity account only once this computer’s own login is signed in', () => {
    for (const accounts of [[], [account('antigravity', 'signed_out')], [account('antigravity', 'needs_sign_in')], [account('antigravity', 'unknown')]]) {
      expect(addsNamedAntigravityAccount(accounts)).toBe(false)
    }
    expect(addsNamedAntigravityAccount([account('antigravity', 'signed_in')])).toBe(true)
    // A named account doesn't sign this computer in.
    const named = account('antigravity', 'signed_in', { provider: { kind: 'antigravity', instance: 'a1' }, name: 'Work' })
    expect(isAntigravitySignedIn([named, account('antigravity', 'signed_out')])).toBe(false)
    // A daemon without login records can't add one.
    expect(addsNamedAntigravityAccount([account('antigravity', 'signed_in')], true)).toBe(false)

    // Matches Settings › Accounts StatusCell: unknown status with a read identity counts as signed in on current daemons.
    expect(isAntigravitySignedIn([account('antigravity', 'unknown', { identity: { email: 'user@example.com' } })], false)).toBe(true)
    expect(isAntigravitySignedIn([account('antigravity', 'unknown', { identity: { email: 'user@example.com' } })], true)).toBe(false)
  })

  test('asks to update a daemon from before named accounts once this computer is signed in', () => {
    const signedIn = [account('antigravity', 'signed_in')]
    expect(antigravityAccountsBlocked(signedIn, false, true, 'fedora')).toBeUndefined()
    expect(antigravityAccountsBlocked([account('antigravity', 'signed_out')], false, false, 'fedora')).toBeUndefined()
    const reason = antigravityAccountsBlocked(signedIn, false, false, 'fedora')
    expect(reason).toBe('Update Kybern on fedora to add another Antigravity account.')
    const agy = accountPickerOptions(ALL_PROVIDERS, reason).find((o) => o.kind === 'antigravity')!
    expect(agy.disabled).toBe(true)
    expect(agy.disabledReason).toBe(reason)
    // An uninstalled Antigravity stays clickable, so it opens Agent providers instead.
    const uninstalled = ALL_PROVIDERS.map((p) => (p.kind === 'antigravity' ? { ...p, available: false } : p))
    expect(accountPickerOptions(uninstalled, reason).find((o) => o.kind === 'antigravity')!.disabled).toBe(false)
  })
})

describe('PickStep Antigravity tile', () => {
  test('renders Antigravity enabled and hides Advanced', () => {
    const h = harness()
    try {
      const picked: ProviderKind[] = []
      const options = accountPickerOptions(ALL_PROVIDERS)
      h.render(
        <ThemeProvider>
          <PickStep
            providers={options}
            kind={undefined}
            onKind={(k) => picked.push(k)}
            folder=""
            onFolder={() => {}}
            advancedOpen={false}
            onAdvancedOpen={() => {}}
            remote={false}
          />
        </ThemeProvider>,
      )
      const tile = h.find('account-provider-antigravity')!
      expect(tile).toBeDefined()
      expect(h.find('account-provider-grok-build')).toBeUndefined()
      expect(h.style(tile).cursor).toBe('pointer')
      expect(h.style(tile).opacity).toBe(1)
      expect(h.listeners(tile).has('click')).toBe(true)
      h.fire(tile, { eventType: 'click' })
      expect(picked).toEqual(['antigravity'])

      // Selecting Antigravity does not show the Advanced folder section.
      h.render(
        <ThemeProvider>
          <PickStep
            providers={options}
            kind="antigravity"
            onKind={(k) => picked.push(k)}
            folder=""
            onFolder={() => {}}
            advancedOpen={false}
            onAdvancedOpen={() => {}}
            remote={false}
          />
        </ThemeProvider>,
      )
      expect(h.find('account-advanced')).toBeUndefined()
    } finally {
      h.close()
    }
  })

  test('choosing Antigravity on a signed-out computer routes through the one-time Google notice into its own login', () => {
    setNav({ providers: ALL_PROVIDERS, providersLoaded: true })
    const observed: { dialog: ReturnType<typeof useDialog> } = { dialog: null }
    function Observer() {
      const dialog = useDialog()
      useEffect(() => { observed.dialog = dialog }, [dialog])
      return null
    }
    const h = harness()
    try {
      // First time (notice not yet seen): opens antigravity-notice whose proceed opens single-account sign-in.
      noticeSeen = false
      h.render(<ThemeProvider><Observer /><Account close={() => {}} /></ThemeProvider>)
      h.fire(h.find('account-provider-antigravity')!, { eventType: 'click' })
      h.fire(h.find('account-start')!, { eventType: 'click' })
      expect(observed.dialog?.kind).toBe('antigravity-notice')
      if (observed.dialog?.kind === 'antigravity-notice') {
        const proceed = observed.dialog.proceed
        flushSync(() => proceed())
      }
      expect(observed.dialog).toEqual({ kind: 'account', provider: 'antigravity' })

      // After notice is acknowledged: opens single-account sign-in directly.
      flushSync(() => showDialog(null))
      noticeSeen = true
      h.render(<ThemeProvider><Observer /><Account key="second" close={() => {}} /></ThemeProvider>)
      h.fire(h.find('account-provider-antigravity')!, { eventType: 'click' })
      h.fire(h.find('account-start')!, { eventType: 'click' })
      expect(observed.dialog).toEqual({ kind: 'account', provider: 'antigravity' })
    } finally {
      h.close()
    }
  })
})
