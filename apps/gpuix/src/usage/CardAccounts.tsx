// The rail usage card's account half: every account of the agent on any machine, with what is left of it, the machines
// it is on, one click to make it the default everywhere, and sign-in for a machine that lacks it. `NavRail.tsx` mounts
// it between the card header and the limits.
import { useEffect, useRef, useState } from 'react'
import type { ProviderKind } from '../../../../packages/kybern-client/src/types.ts'
import { Icon } from '../icons.tsx'
import { Button } from '../kit/Button.tsx'
import { IconButton } from '../kit/IconButton.tsx'
import { N } from '../nav/glyphs.ts'
import { Label, useTheme } from '../ui.tsx'
import { PROVIDER_NAMES } from '../shared/lib/providerUsage.ts'
import { AccountMarkStack, AccountUsageRing } from './AccountMark.tsx'
import { askAccountLimits } from './accounts.ts'
import { readMachine, useAccountsEverywhere, type UnifiedView } from '../accounts/store.ts'
import { chipsFor, usableMachines } from '../accounts/chips.ts'
import { makeDefault, signIn } from '../accounts/actions.ts'
import { planOnMachine } from '../accounts/queue.ts'
import { isUpdating } from '../../../../packages/kybern-client/src/updateRun.ts'
import { retryMachineUpdate, useUpdateRun } from '../machines/network.ts'
import { toastProblem } from '../problems/toast.ts'
import { leftOf, outdatedMachineLabel, outdatedMachines, type UnifiedAccount } from '../accounts/unified.ts'

/** The card's accounts of an agent: those with an identity or a name, and any login that can be used. */
export function cardAccounts(view: UnifiedView, kind: ProviderKind): UnifiedAccount[] {
  const group = view.groups.find((g) => g.kind === kind)
  return group?.accounts.filter((account) => !account.terminalOnly || usableMachines(account).length > 0) ?? []
}

/** Opening the card re-reads limits live: here, and on every other machine that has one of these accounts. */
export function useCardRefresh(kind: ProviderKind, view: UnifiedView) {
  const remote = cardAccounts(view, kind).flatMap((account) => account.presences.map((p) => p.machineId)).filter((id) => id !== view.primaryId)
  const ids = [...new Set(remote)].sort().join(',')
  useEffect(() => { askAccountLimits({ refresh: true }) }, [kind])
  useEffect(() => { for (const id of ids.split(',').filter(Boolean)) void readMachine(id, { refresh: true }) }, [kind, ids])
}

/** The machines an account is on, short enough for the card: all of them, or the first two and how many more. */
export const machineList = (names: readonly string[], total: number) =>
  names.length === total && total > 2 ? 'All machines' : names.length > 2 ? `${names.slice(0, 2).join(' · ')} +${names.length - 2}` : names.join(' · ')

export function CardAccounts({ kind }: { kind: ProviderKind }) {
  const t = useTheme()
  const view = useAccountsEverywhere()
  const accounts = cardAccounts(view, kind)
  const outdated = outdatedMachines(view.machines)
  const updateRun = useUpdateRun()
  const [changed, setChanged] = useState(false)
  const changedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(changedTimer.current), [])
  const name = PROVIDER_NAMES[kind] ?? kind
  const choose = async (account: UnifiedAccount) => {
    if (account.isDefault) return
    if (!await makeDefault(view, account)) return
    setChanged(true)
    clearTimeout(changedTimer.current)
    changedTimer.current = setTimeout(() => setChanged(false), 2000)
  }
  if (accounts.length < 2 && view.machines.length < 2 && outdated.length === 0) return null
  return <>
    {accounts.length > 0 && <div testId={`rail-accounts-${kind}`} role="radiogroup" aria-label={`Default ${name} account`} style={{ display: 'flex', flexDirection: 'column', gap: 1, marginLeft: -6, marginRight: -6 }}>
      {accounts.map((account) => <CardAccountRow key={account.id} account={account} view={view} onChoose={() => void choose(account)} />)}
    </div>}
    {outdated.length > 0 && <div testId={`rail-accounts-outdated-${kind}`} style={{ display: 'flex', flexDirection: 'column', gap: 1, marginLeft: -6, marginRight: -6 }}>
      {outdated.map((machine) => {
        const row = updateRun[machine.machineId]
        const updating = !!row && isUpdating(row)
        return <div key={machine.machineId} testId={`rail-account-outdated-${machine.machineId}`} style={{ display: 'flex', alignItems: 'center', gap: 10, paddingLeft: 6, paddingRight: 6, paddingTop: 6, paddingBottom: 6, borderRadius: 8 }}>
          <Label color={t.textSecondary} size={13} lineHeight={19.5} truncate style={{ flexGrow: 1, flexShrink: 1, minWidth: 0 }}>{outdatedMachineLabel(machine.name)}</Label>
          <Button testId={`rail-account-update-${machine.machineId}`} size="sm" busy={updating} disabled={updating} onClick={() => void retryMachineUpdate(machine.machineId).catch((error) => toastProblem(error, { action: `update ${machine.name}`, machine: machine.name }))}>Update</Button>
        </div>
      })}
    </div>}
    {changed && <div role="status" style={{ display: 'flex' }}><Label color={t.textSecondary} size={13} lineHeight={19.5}>Default changed</Label></div>}
  </>
}

function CardAccountRow({ account, view, onChoose }: { account: UnifiedAccount; view: UnifiedView; onChoose: () => void }) {
  const t = useTheme()
  const left = leftOf(account, Date.now())
  const machines = usableMachines(account)
  const several = view.machines.length > 1
  const usable = machines.length > 0
  const detail = several ? (usable ? machineList(machines, view.machines.length) : 'Signed out') : account.email && account.email !== account.name ? account.email : account.plan
  // Machines that could have it and don't: one step each, in the sign-in queue.
  const missing = chipsFor(account, view.machines).filter((chip) => chip.state === 'add' || (chip.state === 'signed_out' && !chip.terminal))
  const sign = () => signIn(missing.map((chip) => planOnMachine(account, { machineId: chip.machineId, name: chip.machine })))
  const addLabel = missing.length === 1 ? `Sign in on ${missing[0]!.machine}` : `Sign in on ${missing.length} more machines`
  const body = <>
    <AccountMarkStack kind={account.kind} color={account.color} size={14} />
    <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
      <Label color={t.text} size={14} lineHeight={21} truncate>{account.name}</Label>
      {detail && <Label color={t.textSecondary} size={13} lineHeight={19.5} truncate>{detail}</Label>}
    </div>
  </>
  const row = { display: 'flex', alignItems: 'center', gap: 10, paddingLeft: 6, paddingRight: 6, paddingTop: 6, paddingBottom: 6, borderRadius: 8, ...(account.isDefault ? { backgroundColor: t.buttonSecondary } : {}) } as const
  if (!usable) {
    const here = missing.find((chip) => chip.machineId === view.primaryId) ?? missing[0]
    return <div testId={`rail-account-${account.id}`} style={row}>
      <div role="radio" aria-checked={false} aria-disabled style={{ display: 'flex', alignItems: 'center', gap: 10, flexGrow: 1, flexShrink: 1, minWidth: 0, opacity: 0.7 }}>{body}</div>
      {here && <Button testId={`rail-account-signin-${account.id}`} size="sm" onClick={() => signIn([planOnMachine(account, { machineId: here.machineId, name: here.machine })])}>Sign in</Button>}
    </div>
  }
  return <div testId={`rail-account-${account.id}`} style={{ display: 'flex', alignItems: 'center', gap: 2, borderRadius: 8, ...(account.isDefault ? { backgroundColor: t.buttonSecondary } : {}) }}>
    <div testId={`rail-account-choose-${account.id}`} role="radio" aria-checked={account.isDefault} aria-label={account.name} tabIndex={0} onClick={onChoose} onKeyDown={(e) => { if (e.key === 'enter' || e.key === 'space') onChoose() }} style={{ ...row, flexGrow: 1, flexShrink: 1, minWidth: 0, backgroundColor: 'transparent', cursor: 'pointer', ...(account.isDefault ? {} : { hover: { backgroundColor: t.buttonSecondaryHover } }) }}>
      {body}
      {left !== null && <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}><AccountUsageRing left={left} size={16} /><Label color={t.textSecondary} size={13} lineHeight={19.5} style={{ fontVariantNumeric: 'tabular-nums' } as never}>{`${Math.round(left)}% left`}</Label></div>}
      <div style={{ display: 'flex', width: 14, height: 14, flexShrink: 0 }}>{account.isDefault && <Icon source={N.check} size={14} color={t.text} />}</div>
    </div>
    {missing.length > 0 && <IconButton testId={`rail-account-add-${account.id}`} size="sm" icon={N.plus} label={addLabel} onClick={sign} style={{ marginRight: 4 }} />}
  </div>
}
