// Settings › Machines (design §5.2): your network. It replaces the environment switcher. One card per machine with its
// status, version, OS, Tailscale name, harnesses and hardware; Pause and Remove; machines found on the tailnet; Add by
// code; Update all machines. Everything goes through the `network.*` RPCs of the machine the user is at, which any member
// answers for the rest. Words come from `machinesModel.ts`.
import { useEffect, useMemo, useState } from 'react'
import type { FoundMachine, NetworkUpdateAllResult, OutboxItem } from '../../../../packages/kybern-client/src/types.ts'
import { Dialog } from '../nav/overlay.tsx'
import { N } from '../nav/glyphs.ts'
import { errorText } from '../nav/actions.ts'
import { toast } from '../shell/toasts.tsx'
import { footerText } from '../machines/format.ts'
import { machineHub, useMachines } from '../machines/index.ts'
import { addFound, doctor, joinByCode, cancelOutbox, loadMachineInfo, mergeFound, pauseMachine, removeFromNetwork, renameMachine, retryOutbox, setFollowUpdates, setNetworkEnabled, showCode, updateAllMachines, useNetwork } from '../machines/network.ts'
import { showEnvironmentDialog } from '../environments/Dialogs.tsx'
import { stopSshTunnel } from '../environments/ssh.ts'
import { MachineBadge } from '../sidebar/MachineBadge.tsx'
import { StatusDot } from '../sidebar/MachineFilter.tsx'
import { DialogBody, DialogFooter, DialogHeader, ErrorText, Field, Hint } from '../environments/kit.tsx'
import { ink, Label, useTheme } from '../ui.tsx'
import { FONT_MONO } from '../theme.ts'
import { Button } from '../kit/Button.tsx'
import { Checkbox } from '../kit/Checkbox.tsx'
import { IconButton } from '../kit/IconButton.tsx'
import { TextField } from '../kit/Field.tsx'
import { Switch } from '../kit/Switch.tsx'
import { readClipboardAuto, setClipboardAuto } from '../machines/clipboard.ts'
import { Row, Section } from './controls.tsx'
import { buildCards, outboxRows, updateResultRows, updateSummary, type MachineCardModel } from './machinesModel.ts'

export function Machines() {
  const t = useTheme()
  const net = useNetwork()
  const machines = useMachines()
  const [removing, setRemoving] = useState<MachineCardModel | null>(null)
  const status = net.status
  // Each online machine says what it has; the page asks once per machine that answers.
  const online = machines.filter((machine) => !machine.offline).map((machine) => machine.machineId).join(',')
  useEffect(() => { for (const id of online.split(',').filter(Boolean)) if (net.infos[id] === undefined) void loadMachineInfo(id) }, [online])
  const latest = machines.find((machine) => machine.isLocal)?.version
  const cards = useMemo(() => buildCards({ rows: machines, members: status?.members ?? [], infos: net.infos, latest }), [machines, status, net.infos, latest])
  const found = (status?.found ?? []).filter((item) => !item.machine_id || !machines.some((machine) => machine.machineId === item.machine_id))
  const waiting = status?.outbox.queued ?? 0
  return <>
    <Section title="Machines" accessory={machines.length > 1 ? <Label color={t.textSecondary} size={13} lineHeight={19.5}>{footerText(machines, waiting)}</Label> : undefined}>
      {cards.map((card) => <MachineCardRow key={card.machineId} card={card} busy={net.busy === card.machineId} onRemove={() => setRemoving(card)} />)}
      {machines.length < 2 && <Row title="" description={<Hint>This is your only machine. Machines on your Tailscale network show up below, and you can add one with a code.</Hint>} />}
    </Section>
    {!net.unavailable && machines.length > 1 && <ClipboardAuto machineId={machines.find((machine) => machine.isLocal)?.machineId} />}
    {net.unavailable && <Section title="Your network"><Row title="Update this machine's daemon" description="It is older than your network features, so other machines can't be found from here yet. Update Kybern, then come back." /></Section>}
    {!net.unavailable && <TailnetSection found={found} tailscale={status?.tailscale} busy={net.busy} />}
    {!net.unavailable && <AddByCode busy={net.busy === 'join'} />}
    {!net.unavailable && <Outbox items={net.outbox} machines={cards} />}
    {!net.unavailable && <Updates busy={net.busy === 'update'} following={status ? !!status.follow_updates : undefined} machines={cards} result={net.updated} />}
    {!net.unavailable && status && <Section title="Your network">
      <Row title="Let your machines find each other" description="Machines signed in to the same Tailscale account join without a code. Turn this off to leave the network and keep your machines separate."><Switch aria-label="Use your network" testId="machines-enabled" checked={status.enabled} disabled={net.busy === 'enabled'} onCheckedChange={(enabled) => void setNetworkEnabled(enabled).catch((e) => toast.error('Unable to change the network', { description: errorText(e) }))} /></Row>
      <Row title="Check the network" description="Looks at Tailscale, the pairing and each machine, and says what to fix."><Button testId="machines-doctor" busy={net.busy === 'doctor'} onClick={() => void runDoctor()}>Run check</Button></Row>
    </Section>}
    {net.error && !net.unavailable && <Section title="Something went wrong"><Row title="" description={<ErrorText>{net.error}</ErrorText>} /></Section>}
    {removing && <RemoveDialog card={removing} others={cards.filter((card) => card.machineId !== removing.machineId && card.member)} onClose={() => setRemoving(null)} />}
  </>
}

/** Off by default and only for this machine: another machine's copies appear here only when both turned it on. */
function ClipboardAuto({ machineId }: { machineId: string | undefined }) {
  const [on, setOn] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { void readClipboardAuto().then(setOn, () => setOn(false)) }, [])
  if (!machineId) return null
  const change = (next: boolean) => {
    setBusy(true)
    void setClipboardAuto(machineId, next).then(() => setOn(next), (e) => toast.error('Unable to change the clipboard setting', { description: errorText(e) })).finally(() => setBusy(false))
  }
  return <Section title="This machine">
    <Row title="Share clipboard automatically" description="Copies you make here appear on your other machines that also turned this on. Anything that looks like a password or a key is never shared."><Switch aria-label="Share clipboard automatically" testId="machines-clipboard-auto" checked={!!on} disabled={on === null || busy} onCheckedChange={change} /></Row>
  </Section>
}

async function runDoctor() {
  try {
    const report = await doctor()
    const bad = report.checks.filter((check) => check.status !== 'pass')
    if (!bad.length) toast.success('Your network looks healthy', { description: `${report.checks.length} checks passed` })
    else toast.info(`${bad.length} ${bad.length === 1 ? 'thing needs' : 'things need'} a look`, { description: bad.slice(0, 3).map((check) => check.next_step || check.title).join(' · ') })
  } catch (e) { toast.error('Unable to check the network', { description: errorText(e) }) }
}

function MachineCardRow({ card, busy, onRemove }: { card: MachineCardModel; busy: boolean; onRemove: () => void }) {
  const t = useTheme()
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(card.name)
  const { row } = card
  const save = () => {
    setRenaming(false)
    const next = name.trim()
    if (next && next !== card.name) void renameMachine(card.machineId, next).catch((e) => toast.error('Unable to rename', { description: errorText(e) }))
    else setName(card.name)
  }
  const details = [card.facts.join(' · '), card.hardware].filter(Boolean)
  return <div testId={`machine-${card.machineId}`} style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 20, paddingLeft: 18, paddingRight: 18, paddingTop: 16, paddingBottom: 16, opacity: row.offline && !row.paused ? 0.78 : 1 }}>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 28 }}>
        <MachineBadge glyph={row.glyph} size={18} />
        {renaming
          ? <TextField testId={`machine-name-${card.machineId}`} label="Machine name" size="md" width={240} autoFocus value={name} onChange={setName} onSubmit={save} onBlur={save} />
          : <Label color={t.text} size={14} lineHeight={21} weight={500} truncate>{card.name}</Label>}
        {row.isLocal && <Label color={t.textSecondary} size={12} lineHeight={18}>This computer</Label>}
        {card.canRename && !renaming && <IconButton testId={`machine-rename-${card.machineId}`} label={`Rename ${card.name}`} icon={N.pencil} size="sm" onClick={() => { setName(card.name); setRenaming(true) }} />}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><StatusDot tone={card.tone} /><Label color={t.textSecondary} size={13} lineHeight={20}>{card.status}</Label>{card.behind && <Label color={t.textSecondary} size={13} lineHeight={20}>· Needs an update</Label>}</div>
      {details.map((line) => <Label key={line} color={t.textSecondary} size={13} lineHeight={20}>{line}</Label>)}
      {card.harnesses.length > 0 && <Label color={t.textSecondary} size={13} lineHeight={20}>{card.harnesses.join(' · ')}</Label>}
      {!card.member && <Label color={t.textSecondary} size={13} lineHeight={20}>Saved on this device, not in your network.</Label>}
    </div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
      {card.canPause && <Button testId={`machine-pause-${card.machineId}`} size="sm" busy={busy} onClick={() => void pauseMachine(card.machineId, !row.paused).catch((e) => toast.error('Unable to change the machine', { description: errorText(e) }))}>{row.paused ? 'Resume' : 'Pause'}</Button>}
      {!row.isLocal && <Button testId={`machine-remove-${card.machineId}`} size="sm" variant="secondary" danger onClick={onRemove}>Remove</Button>}
    </div>
  </div>
}

function TailnetSection({ found, tailscale, busy }: { found: FoundMachine[]; tailscale: { installed: boolean; running: boolean; detail?: string | null } | undefined; busy: string | null }) {
  const t = useTheme()
  const away = tailscale && (!tailscale.installed || !tailscale.running)
  if (!found.length && !away) return null
  return <Section title="Found on your tailnet">
    {found.map((item) => <Row key={item.found_id} title={item.name} description={[item.os, item.ts_name, item.version ? `Version ${item.version}` : null].filter(Boolean).join(' · ') || 'Running Kybern'}>
      {item.action === 'code'
        ? <Label color={ink(t, 0.6)} size={13} lineHeight={20}>Enter the code shown on {item.name} below</Label>
        : <Button testId={`found-${item.found_id}`} variant="primary" size="sm" busy={busy === `found:${item.found_id}`} onClick={() => void (item.action === 'merge' ? mergeFound(item.found_id) : addFound(item.found_id).then((r) => { if (r.needs_code) toast.info(`Enter the code shown on ${item.name}`, { description: 'It could not be verified from here. Use Add by code.' }) })).catch((e) => toast.error(`Unable to add ${item.name}`, { description: errorText(e) }))}>{item.action === 'merge' ? 'Merge' : 'Add'}</Button>}
    </Row>)}
    {away && <Row title="" description={<Hint>{!tailscale!.installed ? "Tailscale isn't installed on this computer, so other machines can't be found. Add one with a code instead." : tailscale!.detail || "Tailscale isn't running. Start it to find your other machines."}</Hint>} />}
  </Section>
}

function AddByCode({ busy }: { busy: boolean }) {
  const t = useTheme()
  const [code, setCode] = useState('')
  const [address, setAddress] = useState('')
  const [error, setError] = useState('')
  const [shown, setShown] = useState<{ code: string; endpoints: string[] } | null>(null)
  const ready = /^\d{6}$/.test(code.trim()) && !!address.trim()
  const add = async () => {
    setError('')
    try { const card = await joinByCode(code, address); toast.success(`Added ${card.name}`); setCode(''); setAddress('') } catch (e) { setError(errorText(e)) }
  }
  const show = async () => {
    setError('')
    try { const result = await showCode(); setShown({ code: result.code, endpoints: result.endpoints }) } catch (e) { setError(errorText(e)) }
  }
  return <Section title="Add by code">
    <Row title="Add a machine" description="On the other machine, choose Show a code for this machine (or run kybern machines code), then enter the code and its address here." />
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 18, paddingRight: 18, paddingTop: 12, paddingBottom: 14 }}>
      <TextField testId="machines-code" label="Code" width={110} mono value={code} onChange={setCode} placeholder="123456" onSubmit={() => void add()} />
      <TextField testId="machines-address" label="Address" width="100%" shell={{ flexGrow: 1 }} value={address} onChange={setAddress} placeholder="https://machine.ts.net" onSubmit={() => void add()} />
      <Button testId="machines-add" variant="primary" disabled={!ready} busy={busy} onClick={() => void add()}>Add</Button>
    </div>
    <Row title="Add over SSH or an address" description="For a machine that is not on your Tailscale network, or one that runs an older Kybern. Kybern can install and start the daemon there over SSH."><Button testId="machines-add-ssh" onClick={() => showEnvironmentDialog({ kind: 'add' })}>Add a machine</Button></Row>
    <Row title="Show a code for this machine" description="Another machine of yours enters it to add this one."><Button testId="machines-show-code" onClick={() => void show()}>Show a code</Button></Row>
    {shown && <Row title="" description={<div testId="machines-shown-code" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><Label color={t.text} size={22} lineHeight={28} weight={600} font={FONT_MONO}>{shown.code}</Label><Hint>{shown.endpoints.length ? `Address: ${shown.endpoints.join(' · ')}` : 'No reachable address yet.'} The code works for ten minutes.</Hint></div>} />}
    {error && <Row title="" description={<ErrorText testId="machines-error">{error}</ErrorText>} />}
  </Section>
}

function Updates({ busy, following, machines, result }: { busy: boolean; following: boolean | undefined; machines: MachineCardModel[]; result: NetworkUpdateAllResult | null }) {
  const t = useTheme()
  const net = useNetwork()
  const [error, setError] = useState('')
  const behind = machines.filter((card) => card.behind).length
  const names = new Map(machines.map((card) => [card.machineId, card.name]))
  const rows = result ? updateResultRows(result, names) : []
  const run = async () => {
    setError('')
    try { await updateAllMachines() } catch (e) { setError(errorText(e)) }
  }
  return <Section title="Updates">
    <Row title="Update all machines" description={error || (result ? updateSummary(result) : behind ? `${behind} ${behind === 1 ? 'machine is' : 'machines are'} behind. Each one updates itself when it is idle.` : 'Starts an update on every machine that is behind.')}><Button testId="machines-update-all" busy={busy} onClick={() => void run()}>Update all machines</Button></Row>
    {rows.length > 0 && <div testId="machines-update-results" style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 18, paddingRight: 18, paddingTop: 12, paddingBottom: 14 }}>
      {rows.map((row) => <div key={row.machineId} testId={`update-result-${row.machineId}`} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <StatusDot tone={row.started ? 'good' : 'idle'} />
        <Label color={t.text} size={13} lineHeight={20} weight={500}>{row.name}</Label>
        <Label color={t.textSecondary} size={13} lineHeight={20} truncate style={{ flexGrow: 1 }}>{row.text}</Label>
      </div>)}
    </div>}
    <Row title="Keep all machines on the same version" description="A machine updates itself, once it is idle, when another one runs a newer version. A machine managed by the desktop app is left out."><Switch aria-label="Keep all machines on the same version" testId="machines-follow-updates" checked={!!following} disabled={following === undefined || net.busy === 'follow'} onCheckedChange={(enabled) => void setFollowUpdates(enabled).catch((e) => toast.error('Unable to change the setting', { description: errorText(e) }))} /></Row>
  </Section>
}

/** Work waiting for a machine that is away, or stuck: Retry sends it again, Cancel drops it (design §6.4). */
function Outbox({ items, machines }: { items: OutboxItem[]; machines: MachineCardModel[] }) {
  const t = useTheme()
  const net = useNetwork()
  const rows = outboxRows(items, new Map(machines.map((card) => [card.machineId, card.name])))
  if (rows.length === 0) return null
  const fail = (title: string) => (e: unknown) => toast.error(title, { description: errorText(e) })
  return <Section title="Outbox" accessory={<Label color={t.textSecondary} size={13} lineHeight={19.5}>{`${rows.length} waiting`}</Label>}>
    {rows.map((row) => <Row key={row.id} title={row.title} description={row.detail}>
      {row.canRetry && <Button testId={`outbox-retry-${row.id}`} size="sm" busy={net.busy === `outbox:${row.id}`} onClick={() => void retryOutbox(row.id).catch(fail('Unable to retry'))}>Retry</Button>}
      {row.canCancel && <Button testId={`outbox-cancel-${row.id}`} size="sm" variant="secondary" disabled={net.busy === `outbox:${row.id}`} onClick={() => void cancelOutbox(row.id).catch(fail('Unable to cancel'))}>Cancel</Button>}
    </Row>)}
  </Section>
}

function RemoveDialog({ card, others, onClose }: { card: MachineCardModel; others: MachineCardModel[]; onClose: () => void }) {
  const t = useTheme()
  const [stolen, setStolen] = useState(false)
  const [also, setAlso] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const remove = async () => {
    setBusy(true); setError('')
    try {
      if (card.member) await removeFromNetwork({ machine_id: card.machineId, stolen, also_remove: others.filter((other) => also[other.machineId]).map((other) => other.machineId) })
      else {
        const profile = machineHub().set.connection(card.machineId)?.record.legacyProfileId
        await machineHub().set.removeMachine(card.machineId)
        if (profile) stopSshTunnel(profile)
      }
      onClose()
    } catch (e) { setError(errorText(e)); setBusy(false) }
  }
  return <Dialog onClose={onClose} width={480} testId="machine-remove-dialog">
    <DialogHeader title={`Remove ${card.name}?`} description={card.member ? `${card.name} leaves your network on every machine. Its projects and threads stay on it.` : `${card.name} is forgotten on this device. Its projects and threads stay on it.`} onClose={onClose} />
    <DialogBody footer>
      {card.member && <Field label="If it is lost or stolen"><div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Checkbox testId="machine-remove-stolen" aria-label="This machine might be lost or stolen" checked={stolen} onCheckedChange={setStolen} /><Label color={t.text} size={14} lineHeight={21}>This machine might be lost or stolen</Label></div><Hint>Every machine then drops the keys and device tokens it gave it.</Hint></Field>}
      {card.member && others.length > 0 && <Field label="Also remove machines it added">{others.map((other) => <div key={other.machineId} style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Checkbox testId={`machine-remove-also-${other.machineId}`} aria-label={`Also remove ${other.name}`} checked={!!also[other.machineId]} onCheckedChange={(checked) => setAlso({ ...also, [other.machineId]: checked })} /><Label color={t.text} size={14} lineHeight={21}>{other.name}</Label></div>)}</Field>}
      {error && <ErrorText testId="machine-remove-error">{error}</ErrorText>}
    </DialogBody>
    <DialogFooter><Button size="lg" onClick={onClose}>Cancel</Button><Button size="lg" variant="destructive" testId="machine-remove-confirm" busy={busy} onClick={() => void remove()}>{card.member ? 'Remove from network' : 'Forget machine'}</Button></DialogFooter>
  </Dialog>
}
