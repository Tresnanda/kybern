// Settings › Accounts › Login broker (ADE-86 S4, design §9.4): sign in once on one machine and the others use that
// sign-in. The words and states come from `packages/kybern-client/src/loginBroker.ts`; the actions from
// `machines/broker.ts`. The section is hidden on a lone machine, and on a daemon older than the login broker.
import { useEffect, useMemo, useState } from 'react'
import type { MachineId, ProviderKind } from '../../../../packages/kybern-client/src/types.ts'
import { BROKER_KINDS, brokerBlocker, brokerLine, lendableLabel, providerStatus, signInAllSummary, type SignInAllRow } from '../../../../packages/kybern-client/src/loginBroker.ts'
import { PROVIDER_NAMES } from '../shared/lib/providerUsage.ts'
import { errorText } from '../nav/actions.ts'
import { Dialog } from '../nav/overlay.tsx'
import { toast } from '../shell/toasts.tsx'
import { useMachines } from '../machines/index.ts'
import { useNetwork } from '../machines/network.ts'
import { closeSignInAll, moveBroker, signInHereInstead, startSignInAll, submitSignInCode, useBroker, useBrokerSignIn, useSignInAll } from '../machines/broker.ts'
import { StatusDot } from '../sidebar/MachineFilter.tsx'
import { DialogBody, DialogFooter, DialogHeader, ErrorText } from '../environments/kit.tsx'
import { Label, useTheme } from '../ui.tsx'
import { Button } from '../kit/Button.tsx'
import { TextField } from '../kit/Field.tsx'
import { Row, Section, Select } from './controls.tsx'
import { openExternal } from './external.ts'
import { showDialog } from '../dialogs/store.ts'

const NO_BROKER = '__none__'

export function LoginBrokerSection() {
  const t = useTheme()
  const machines = useMachines()
  const net = useNetwork()
  const broker = useBroker()
  const all = useSignInAll()
  const members = net.status?.members ?? []
  const [confirming, setConfirming] = useState<MachineId | null | undefined>(undefined)
  const info = broker.status
  const brokerName = info?.broker?.name ?? machines.find((machine) => machine.machineId === info?.broker?.machine_id)?.name
  const candidates = useMemo(() => machines.filter((machine) => machine.member).map((machine) => {
    const features = members.find((member) => member.machine_id === machine.machineId)?.features ?? []
    return { machineId: machine.machineId, name: machine.name, online: !machine.offline, features }
  }), [machines, members])
  if (broker.unavailable || machines.length < 2) return null
  const fail = (title: string) => (e: unknown) => toast.error(title, { description: errorText(e) })
  const moved = broker.moved
  return <>
    <Section title="Login broker">
      <Row title="Sign in once" description={info?.broker ? `${brokerName ?? 'A machine'} holds the real sign-ins and refreshes them. Your other machines use them without signing in again.` : 'Choose a machine that is always on. Sign in there once, and your other machines use that sign-in.'}>
        <Select compact testId="login-broker-machine" label="Login broker" value={info?.broker?.machine_id ?? NO_BROKER} disabled={broker.busy !== null}
          onChange={(value) => setConfirming(value === NO_BROKER ? null : value)}
          options={[{ value: NO_BROKER, label: 'None' }, ...candidates.map((machine) => ({ value: machine.machineId, label: brokerBlocker(machine) ? `${machine.name} · ${brokerBlocker(machine)}` : machine.name, disabled: !!brokerBlocker(machine) }))]} />
      </Row>
      {info && info.broker && BROKER_KINDS.map((kind) => <HarnessRow key={kind} kind={kind} />)}
      {moved && <Row title="" description={<div testId="login-broker-moved"><Label color={t.textSecondary} size={13} lineHeight={19.5}>{movedText(moved.rebound.length, moved.offline.length, moved.old_signed_out.length, moved.note)}</Label></div>} />}
      {broker.error && <Row title="" description={<ErrorText testId="login-broker-error">{broker.error}</ErrorText>} />}
    </Section>
    {confirming !== undefined && <MoveDialog target={confirming} candidates={candidates} brokerName={brokerName} onClose={() => setConfirming(undefined)} onMove={() => { const target = confirming; setConfirming(undefined); void moveBroker(target).catch(fail('Unable to move the login broker')) }} />}
    {all.kind && <SignInAllDialog />}
  </>
}

function movedText(rebound: number, offline: number, signedOut: number, note: string | undefined): string {
  const parts = [`${rebound} ${rebound === 1 ? 'machine uses' : 'machines use'} the new broker`]
  if (offline) parts.push(`${offline} offline, ${offline === 1 ? 'it' : 'they'} will follow when back`)
  if (signedOut) parts.push('the old broker signed out')
  if (note) parts.push(note)
  return parts.join(' · ')
}

function HarnessRow({ kind }: { kind: ProviderKind }) {
  const broker = useBroker()
  const t = useTheme()
  const harness = PROVIDER_NAMES[kind] ?? kind
  const status = providerStatus(broker.status, kind)
  if (!status) return null
  const brokerName = broker.status?.broker?.name ?? undefined
  const line = brokerLine(status, brokerName, harness)
  const busy = broker.busy === kind
  const fail = (title: string) => (e: unknown) => toast.error(title, { description: errorText(e) })
  const lendable = status.lendable[0]
  const act = () => {
    if (line.action === 'use_broker' && lendable) void useBrokerSignIn(kind, harness, brokerName ?? 'broker', lendable.account).catch(fail(`Unable to use ${brokerName ?? 'the broker'}'s sign-in`))
    else if (line.action === 'sign_in_here' && status.local_account) void signInHereInstead(kind, status.local_account).then(() => showDialog({ kind: 'account', provider: kind, instance: status.local_account })).catch(fail('Unable to sign in here'))
    else if (line.action === 'sign_in_on_broker') void startSignInAll(kind, harness)
  }
  return <Row title={harness} description={<div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><StatusDot tone={line.tone === 'ok' ? 'good' : line.tone === 'problem' ? 'bad' : 'idle'} /><div testId={`login-broker-${kind}`}><Label color={t.textSecondary} size={13} lineHeight={20}>{line.text}</Label></div></div>
    {lendable && status.state === 'not_used' && <Label color={t.textSecondary} size={12} lineHeight={18}>{lendableLabel(lendable)}</Label>}
  </div>}>
    {line.action && <Button testId={`login-broker-action-${kind}`} size="sm" busy={busy} onClick={act}>{line.actionLabel ?? ''}</Button>}
    <Button testId={`login-broker-all-${kind}`} size="sm" variant="secondary" disabled={all_disabled(broker.busy)} onClick={() => void startSignInAll(kind, harness)}>Sign in on all machines</Button>
  </Row>
}

const all_disabled = (busy: string | null) => busy !== null

function MoveDialog({ target, candidates, brokerName, onClose, onMove }: { target: MachineId | null; candidates: { machineId: MachineId; name: string }[]; brokerName: string | undefined; onClose: () => void; onMove: () => void }) {
  const name = target ? candidates.find((machine) => machine.machineId === target)?.name ?? 'that machine' : null
  return <Dialog onClose={onClose} width={480} testId="login-broker-move">
    <DialogHeader title={name ? `Make ${name} the login broker?` : 'Stop using a login broker?'} description={name
      ? `${name} must already be signed in to what it will lend. Your other machines borrow from it first, and only then does ${brokerName ?? 'the old broker'} sign out.`
      : 'Each machine keeps working until its current sign-in ends, and then asks you to sign in on that machine.'} onClose={onClose} />
    <DialogBody footer><Label color="#888" size={13} lineHeight={19.5}>Machines that are offline borrow from the new broker when they are back.</Label></DialogBody>
    <DialogFooter><Button size="lg" onClick={onClose}>Cancel</Button><Button size="lg" variant="primary" testId="login-broker-move-confirm" onClick={onMove}>{name ? 'Move the login broker' : 'Stop using a broker'}</Button></DialogFooter>
  </Dialog>
}

// ── Sign in on all machines ──────────────────────────────────────────────────

const STATE_WORDS: Record<SignInAllRow['state'], string> = {
  waiting: 'Waiting',
  signing_in: 'Signing in…',
  signed_in: 'Signed in',
  already: 'Already signed in',
  failed: 'Needs another try',
  skipped: 'Offline',
  canceled: 'Canceled',
}

function SignInAllDialog() {
  const t = useTheme()
  const all = useSignInAll()
  const harness = all.kind ? PROVIDER_NAMES[all.kind] ?? all.kind : ''
  return <Dialog onClose={closeSignInAll} width={480} testId="sign-in-all">
    <DialogHeader title={`Sign in to ${harness} on all machines`} description="Each machine signs in on its own, one after another. Machines that are already signed in are left alone." onClose={closeSignInAll} />
    <DialogBody footer>
      <div testId="sign-in-all-rows" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {all.rows.map((row) => <SignInAllMachineRow key={row.machineId} row={row} />)}
      </div>
      {!all.running && all.rows.length > 0 && <div testId="sign-in-all-summary"><Label color={t.textSecondary} size={13} lineHeight={19.5}>{signInAllSummary(all.rows)}</Label></div>}
    </DialogBody>
    <DialogFooter>{all.running ? <Button size="lg" testId="sign-in-all-cancel" onClick={closeSignInAll}>Cancel</Button> : <Button size="lg" variant="primary" testId="sign-in-all-done" onClick={closeSignInAll}>Done</Button>}</DialogFooter>
  </Dialog>
}

function SignInAllMachineRow({ row }: { row: SignInAllRow }) {
  const t = useTheme()
  const [code, setCode] = useState('')
  const [wrong, setWrong] = useState('')
  useEffect(() => { setCode(''); setWrong('') }, [row.login?.id])
  const login = row.login
  const submit = () => {
    if (!login || !code.trim()) return
    setWrong('')
    void submitSignInCode(row.machineId, login.id, code.trim()).catch((e) => setWrong(errorText(e)))
    setCode('')
  }
  const tone = row.state === 'signed_in' || row.state === 'already' ? 'good' : row.state === 'failed' ? 'bad' : 'idle'
  return <div testId={`sign-in-all-${row.machineId}`} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><StatusDot tone={tone} /><Label color={t.text} size={14} lineHeight={21} weight={500}>{row.name}</Label><Label color={t.textSecondary} size={13} lineHeight={20}>{STATE_WORDS[row.state]}</Label></div>
    {row.detail && <Label color={t.textSecondary} size={13} lineHeight={19.5}>{row.detail}</Label>}
    {row.state === 'signing_in' && login && <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 16 }}>
      {login.url && <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Button size="sm" testId={`sign-in-all-open-${row.machineId}`} onClick={() => void openExternal(login.url!).catch((e) => toast.error('Unable to open the sign-in page', { description: errorText(e) }))}>Open sign-in page</Button></div>}
      {login.user_code && <div testId={`sign-in-all-code-${row.machineId}`}><Label color={t.text} size={18} lineHeight={24} weight={600}>{login.user_code}</Label></div>}
      {login.mode === 'paste' && <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><TextField testId={`sign-in-all-paste-${row.machineId}`} label="Code" size="md" secure placeholder="Paste code" value={code} onChange={setCode} onSubmit={submit} width={240} invalid={!!wrong} /><Button size="sm" disabled={!code.trim()} onClick={submit}>Submit</Button></div>}
      {wrong && <ErrorText>{wrong}</ErrorText>}
    </div>}
  </div>
}
