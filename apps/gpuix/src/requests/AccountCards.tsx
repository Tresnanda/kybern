// The two account cards above the composer: at a usage limit, one tap continues on the preselected account; when the
// thread's account isn't signed in on its machine, one tap uses another account there or signs the missing one in. Kybern
// never moves a thread to another account by itself.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ProviderInstance } from '../../../../packages/kybern-client/src/types.ts'
import { Icon } from '../icons.tsx'
import { Button } from '../kit/Button.tsx'
import { SplitButton } from '../kit/SplitButton.tsx'
import { Menu, MenuItem } from '../nav/overlay.tsx'
import { N } from '../nav/glyphs.ts'
import { loadTarget, useComposer } from '../composer/store.ts'
import { showDialog } from '../dialogs/store.ts'
import { toastProblem } from '../problems/toast.ts'
import { activeEnvironment } from '../shell/environment.ts'
import { threadClient, type StateThread } from '../state.ts'
import { Para } from '../transcript/kit.tsx'
import { useTheme } from '../ui.tsx'
import { AccountMarkStack } from '../usage/AccountMark.tsx'
import { askAccountLimits } from '../usage/accounts.ts'
import { readMachine, useAccountsEverywhere } from '../accounts/store.ts'
import { switchChoices, type AccountAway, type SwitchChoice } from '../accounts/limit.ts'
import { signInOn } from '../accounts/actions.ts'

function AccountCard({ testId, title, children }: { testId: string; title: string; children: ReactNode }) {
  const t = useTheme()
  return <div testId={testId} style={{ display: 'flex', flexDirection: 'column', padding: 8, paddingLeft: 14, paddingRight: 14, borderBottomWidth: 1, borderColor: t.borderLight, minWidth: 0 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
      <Icon source={N.alert} size={14} color={t.warning} />
      <Para color={t.text} size={12} weight={500} style={{ flexGrow: 1, flexShrink: 1, minWidth: 0 }}>{title}</Para>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexShrink: 0 }}>{children}</div>
    </div>
  </div>
}

/** The thread's machine, as the cards name it. */
function useThreadMachine(thread: StateThread) {
  const view = useAccountsEverywhere()
  const machineId = thread.machineId ?? view.primaryId
  const machine = view.machines.find((m) => m.machineId === machineId)
  // Its accounts' limits decide what is preselected.
  useEffect(() => { if (machineId === view.primaryId) askAccountLimits(); else void readMachine(machineId) }, [machineId])
  const target = { machineId, name: machine?.name ?? 'this machine' }
  return { view, machineId, target, several: view.machines.length > 1 }
}

const detail = (choice: SwitchChoice) => (choice.left === null ? undefined : `${Math.round(choice.left)}% left`)

function choiceItems(choices: readonly SwitchChoice[], current: SwitchChoice | null, pick: (choice: SwitchChoice) => void) {
  return choices.map((choice) => <MenuItem key={choice.instance} id={choice.instance} testId={`usage-choice-${choice.instance}`} label={choice.account.name} detail={detail(choice)} checked={choice.instance === current?.instance} iconNode={<AccountMarkStack kind={choice.account.kind} color={choice.account.color} size={14} />} onSelect={() => pick(choice)} />)
}

export function LimitRecovery({ thread }: { thread: StateThread }) {
  const { view, machineId, target, several } = useThreadMachine(thread)
  const suggestion = useComposer((d) => (d.target?.threadId === thread.id ? d.target.state.suggested_account : undefined))
  const { choices, suggested, elsewhere } = switchChoices(view.groups, machineId, thread.provider, suggestion, Date.now())
  const [picked, setPicked] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // One id per choice: a retried tap continues the same message, a new choice starts a new one.
  const attempt = useRef<string | null>(null)
  const choice = choices.find((c) => c.instance === picked) ?? suggested
  const pick = (next: SwitchChoice) => { setPicked(next.instance); attempt.current = null }
  const go = (next: SwitchChoice) => {
    setBusy(true)
    attempt.current ??= crypto.randomUUID()
    const owner = activeEnvironment()
    const client = threadClient(thread.id, thread.machineId)!
    void client.call('threads.switch_continue', { thread_id: thread.id, provider: { kind: thread.provider.kind, instance: next.instance }, message_id: attempt.current })
      .then(() => { if (owner === activeEnvironment()) return loadTarget(thread.id, thread.machineId) })
      .catch((error) => { if (owner === activeEnvironment()) toastProblem(error, { action: `continue on ${next.account.name}` }) })
      .finally(() => setBusy(false))
  }
  const missing = elsewhere[0]
  return <AccountCard testId="usage-limit-recovery" title="Usage limit reached">
    {choice
      ? choices.length > 1
        ? <SplitButton size="sm" testId="usage-switch-continue" menuTestId="usage-switch-menu" menuLabel="Choose another account" disabled={busy} keepMenu onClick={() => go(choice)} menu={choiceItems(choices, choice, pick)}>{`Continue on ${choice.account.name}`}</SplitButton>
        : <Button size="sm" variant="primary" testId="usage-switch-continue" disabled={busy} onClick={() => go(choice)}>{`Continue on ${choice.account.name}`}</Button>
      // Nothing to preselect (each is marked "Only when I choose" or almost out): the person picks.
      : choices.length > 0
        ? <Menu testId="usage-switch-menu" align="end" trigger={() => <Button size="sm" testId="usage-switch-choose" chevron>Choose an account</Button>}>{choiceItems(choices, null, pick)}</Menu>
        : missing
          ? <Button size="sm" variant="primary" testId="usage-sign-in-elsewhere" onClick={() => signInOn(missing, target)}>{several ? `Sign in ${missing.name} on ${target.name}` : `Sign in ${missing.name}`}</Button>
          : <Button size="sm" testId="usage-add-account" onClick={() => showDialog({ kind: 'account', provider: thread.provider.kind })}>Add an account</Button>}
  </AccountCard>
}

/** Move the thread to `provider` and keep it there. */
async function moveThreadTo(thread: StateThread, provider: ProviderInstance) {
  const client = threadClient(thread.id, thread.machineId)!
  const { target } = await client.call('threads.target.get', { thread_id: thread.id })
  await client.call('threads.target.set', { thread_id: thread.id, target: { ...target, provider }, inherit_account: false })
  await loadTarget(thread.id, thread.machineId)
}

export function AccountAwayCard({ thread, away }: { thread: StateThread; away: AccountAway }) {
  const { view, machineId, target, several } = useThreadMachine(thread)
  const suggestion = useComposer((d) => (d.target?.threadId === thread.id ? d.target.state.suggested_account : undefined))
  const { choices, suggested } = switchChoices(view.groups, machineId, away.provider, suggestion, Date.now())
  const [busy, setBusy] = useState(false)
  const choice = suggested ?? choices[0]
  const account = away.account
  const where = several ? ` on ${target.name}` : ''
  const use = (next: SwitchChoice) => {
    setBusy(true)
    void moveThreadTo(thread, { kind: away.provider.kind, instance: next.instance })
      .catch((error) => toastProblem(error, { action: `use ${next.account.name}` }))
      .finally(() => setBusy(false))
  }
  return <AccountCard testId="account-away" title={`${away.name ?? 'This thread’s account'} isn’t signed in${where}`}>
    <Button size="sm" variant={choice ? 'secondary' : 'primary'} testId="account-away-sign-in" onClick={() => (account ? signInOn(account, target) : showDialog({ kind: 'account', provider: away.provider.kind }))}>Sign in</Button>
    {choice && <Button size="sm" variant="primary" testId="account-away-use" busy={busy} disabled={busy} onClick={() => use(choice)}>{`Use ${choice.account.name}${several ? ' here' : ''}`}</Button>}
  </AccountCard>
}
