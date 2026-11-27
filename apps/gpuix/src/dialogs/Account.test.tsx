// The Add an account picker lists Antigravity alongside the other sign-in agents (issue #347). Adding
// it always makes a named account with a profile of its own, through the one-time Google notice; the
// computer's own `agy` login is signed in only when asked for as its terminal login.
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { useEffect } from 'react'
import type { ProviderKind, ProviderStatus } from '../../../../packages/kybern-client/src/types.ts'
import { flushSync, harness } from './gpuixHarness.tsx'
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

const { accountPickerOptions, antigravityAccountsBlocked } = await import('./accountPicker.ts')
const { Account, PickStep } = await import('./Account.tsx')
const { ThemeProvider } = await import('../ui.tsx')
const { setNav } = await import('../nav/store.ts')

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

  test('asks to update a daemon from before named accounts, signed in or not', () => {
    expect(antigravityAccountsBlocked(true, 'fedora')).toBeUndefined()
    const reason = antigravityAccountsBlocked(false, 'fedora')
    expect(reason).toBe('Update Kybern on fedora to add an Antigravity account.')
    const agy = accountPickerOptions(ALL_PROVIDERS, reason).find((o) => o.kind === 'antigravity')!
    expect(agy.disabled).toBe(true)
    expect(agy.disabledReason).toBe(reason)
    // An uninstalled Antigravity stays clickable, so it opens Agent providers instead.
    const uninstalled = ALL_PROVIDERS.map((p) => (p.kind === 'antigravity' ? { ...p, available: false } : p))
    expect(accountPickerOptions(uninstalled, reason).find((o) => o.kind === 'antigravity')!.disabled).toBe(false)
  })
})

describe('sheets opened for Antigravity', () => {
  test('without an account, or for the computer’s own login, they offer adding one and sign nothing in', () => {
    setNav({ providers: ALL_PROVIDERS, providersLoaded: true })
    for (const props of [{ provider: 'antigravity' as const }, { provider: 'antigravity' as const, instance: 'default' }]) {
      const h = harness()
      try {
        h.render(<ThemeProvider><Account close={() => {}} {...props} /></ThemeProvider>)
        expect(h.find('account-provider-antigravity')).toBeDefined()
        expect(h.find('account-start')).toBeDefined()
        expect(h.text()).toContain('Add an account')
      } finally {
        h.close()
      }
    }
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

  test('adding Antigravity on a signed-out computer goes through the Google notice into a new named account, never its own login', () => {
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
      const added = () => (observed.dialog?.kind === 'account' ? observed.dialog.items?.map((item) => [item.kind, item.named, item.ownLogin ?? false, item.instance]) : undefined)
      expect(added()).toEqual([['antigravity', true, false, undefined]])

      // After the notice is acknowledged: straight to the sign-in.
      flushSync(() => showDialog(null))
      noticeSeen = true
      h.render(<ThemeProvider><Observer /><Account key="second" close={() => {}} /></ThemeProvider>)
      h.fire(h.find('account-provider-antigravity')!, { eventType: 'click' })
      h.fire(h.find('account-start')!, { eventType: 'click' })
      expect(added()).toEqual([['antigravity', true, false, undefined]])
    } finally {
      h.close()
    }
  })
})
