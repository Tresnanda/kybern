// Settings › Accounts: every account of every machine, merged by identity (`accounts/unified.ts`), as a list beside a
// detail pane, the way System Settings shows Internet Accounts. The list says where each account works in one line; the
// pane gives each machine one status and at most one action (`accounts/detail.ts`), then the account's own choices.
// Shared sign-ins close the page: one pop-up per agent that another machine can lend.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ACCOUNT_COLORS, ACCOUNT_COLOR_LABELS, isAccountColor, isNameValid, withoutSignIn } from '../shared/lib/accounts.ts'
import { limitFamily, bindingLimit, PROVIDER_NAMES, windowLabel } from '../shared/lib/providerUsage.ts'
import type { MachineId, ProviderKind } from '../../../../packages/kybern-client/src/types.ts'
import { goPage } from '../nav/history.ts'
import { N } from '../nav/glyphs.ts'
import { toastProblem } from '../problems/toast.ts'
import { Dialog, Menu, MenuItem, MenuLabel, MenuSeparator, Tip } from '../nav/overlay.tsx'
import { useNav } from '../nav/store.ts'
import { showDialog } from '../dialogs/store.ts'
import { CloseX, MachineChecks } from '../dialogs/Account.tsx'
import { toast } from '../shell/toasts.tsx'
import { getClient, useApp } from '../state.ts'
import { motion } from '@gpuix/react'
import { EASE } from '../motion/kit.tsx'
import { Label, ProviderMark, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { GlassEdge } from '../kit/GlassEdge.tsx'
import { settingsCardStyle, useGlass } from '../platform/glass.ts'
import { AccountAvatar, AccountDot, AccountUsageRing } from '../usage/AccountMark.tsx'
import { askAccountLimits, setUsageAnchor, updateProviderSettings, useAccountFlash } from '../usage/accounts.ts'
import { Checkbox } from '../kit/Checkbox.tsx'
import { Skeleton } from '../kit/Skeleton.tsx'
import { Switch } from '../kit/Switch.tsx'
import { TextField } from '../kit/Field.tsx'
import { useControls } from '../kit/controls.ts'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { DURATION } from '../motion/tokens.ts'
import { PageBlock, Select, selectOwnsEscape, useSettingsModal } from './controls.tsx'
import { Button } from '../kit/Button.tsx'
import { IconButton } from '../kit/IconButton.tsx'
import { openSettingsTab } from './SettingsScreen.tsx'
import { useSettings } from './store.ts'
import { AccountIdleCompactionSelect } from './Compaction.tsx'
import { refreshAllAccounts, useAccountsEverywhere, useOffers, type UnifiedView } from '../accounts/store.ts'
import { canSignInTerminal, canStyle, makeDefault, removeFrom, setProfile, shareSignIns, signIn, signInInstead, signInTerminals, signInWith, signOutOn, signOutTerminalOn } from '../accounts/actions.ts'
import { planOnMachine } from '../accounts/queue.ts'
import { LENDABLE_KINDS, LOGIN_SHARING_FEATURE, listedOffers } from '../accounts/offers.ts'
import { supportsPerKind, supportsShared, type Sharing } from '../accounts/adapter.ts'
import { OfferRows } from '../accounts/OfferCard.tsx'
import { accountSummary, agentRows, machineRows, stateLabel, stateTone, type MachineRow } from '../accounts/detail.ts'
import { copyText } from '../transcript/store.ts'
import { isUpdating } from '../../../../packages/kybern-client/src/updateRun.ts'
import { IDLE_COMPACTION_HARNESSES } from '../../../../packages/kybern-client/src/compaction.ts'
import { retryMachineUpdate, useUpdateRun } from '../machines/network.ts'
import { leftOf, outdatedMachineLabel, outdatedMachines, standings, type HarnessGroup, type MachineAccounts, type UnifiedAccount } from '../accounts/unified.ts'

/** Skeleton rows fade in after 150 ms (the fade's own `delay`, no timer), so a fast answer never flashes them. */
const SKELETON_DELAY = PATCHED_NATIVE ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { delay: 0.15, duration: DURATION.quick, ease: [0.23, 1, 0.32, 1] as [number, number, number, number] } } : undefined

const list = (names: readonly string[]) => new Intl.ListFormat('en', { style: 'long', type: 'conjunction' }).format(names)
const agentName = (kind: ProviderKind) => PROVIDER_NAMES[kind] ?? kind

/** What a person types in that machine's terminal, for a daemon that can't do it from the app. */
export const TERMINAL_COMMANDS: Partial<Record<ProviderKind, { signIn: string; signOut: string }>> = {
  'claude-code': { signIn: 'claude auth login', signOut: 'claude auth logout' },
  codex: { signIn: 'codex login', signOut: 'codex logout' },
  cursor: { signIn: 'cursor-agent login', signOut: 'cursor-agent logout' },
  antigravity: { signIn: 'agy', signOut: 'agy' },
  'grok-build': { signIn: 'grok login', signOut: 'grok logout' },
}
const copyCommand = (command: string) => { void copyText(command); toast.success(`Copied ${command}`) }

/** The heading's end-aligned action. Hidden for older daemons, which cannot add accounts from the app. */
export function AccountsHeaderAction() {
  const view = useAccountsEverywhere()
  if (view.legacy) return null
  return <Button testId="account-add" icon={N.plus} label="Add account" onClick={() => showDialog({ kind: 'account' })}>Add account</Button>
}

type Pending =
  | { kind: 'remove' | 'signout'; account: UnifiedAccount; machine?: string }
  | { kind: 'terminal'; account: UnifiedAccount; machineId: string; machine: string }
  | { kind: 'projects'; account: UnifiedAccount }
  | { kind: 'stop-sharing'; provider: ProviderKind | null; lender: Sharing }

/** A list item: an account, or an agent that has no account yet, only signed-out logins. */
type Item = { id: string; kind: ProviderKind; account?: UnifiedAccount; group: HarnessGroup }

/** The selection outlives the page, so coming back shows the account last looked at. */
let lastSelected: string | null = null

export function Accounts() {
  const view = useAccountsEverywhere()
  const { offers } = useOffers(view)
  const providers = useNav((s) => s.providers)
  const providersLoaded = useNav((s) => s.providersLoaded)
  const [pending, setPending] = useState<Pending | null>(null)
  useSettingsModal(!!pending)
  // Read every machine's accounts and usage while this tab opens.
  useEffect(() => { void refreshAllAccounts(); askAccountLimits() }, [])
  const groups = useMemo(() => orderGroups(view, providers.map((p) => p.kind)), [view.groups, view.machines, providers])
  const items = useMemo(() => groups.flatMap((group): Item[] => group.accounts.length
    ? group.accounts.map((account) => ({ id: account.id, kind: group.kind, account, group }))
    : [{ id: `${group.kind}:@agent`, kind: group.kind, group }]), [groups])
  const listed = listedOffers(offers)
  const outdated = useMemo(() => outdatedMachines(view.machines), [view.machines])
  const missing = providers.filter((p) => !withoutSignIn(p.kind) && view.machines.every((m) => m.providers?.find((x) => x.kind === p.kind)?.available === false))
  const [selected, setSelected] = useState<string | null>(lastSelected)
  const current = items.find((item) => item.id === selected) ?? items[0]
  const select = (id: string) => { lastSelected = id; setSelected(id) }
  const close = () => setPending(null)
  const loading = !(view.loaded && providersLoaded) && items.length === 0
  return <>
    {listed.length > 0 && <OfferRows offers={listed} view={view} />}
    {loading && outdated.length === 0 && <PageBlock><div testId="accounts-loading" role="status" paintTransform={SKELETON_DELAY} style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingBottom: 30 }}>{[0, 1].map((i) => <Skeleton key={i} height={72} radius={12} />)}</div></PageBlock>}
    {current && <PageBlock testId="accounts-split"><div style={{ display: 'flex', flexDirection: 'column', paddingBottom: 30 }}>
      <SplitCard>
        <AccountList items={items} selected={current.id} view={view} onSelect={select} />
        {current.account
          ? <AccountDetail key={current.id} account={current.account} view={view} onPending={setPending} />
          : <AgentDetail key={current.id} group={current.group} view={view} />}
      </SplitCard>
      {/* A dialog sits in the block that opened it: one at the end of this long page could be culled by the virtual list. */}
      {pending && pending.kind !== 'stop-sharing' && <AccountDialog pending={pending} view={view} onClose={close} />}
    </div></PageBlock>}
    {!current && !loading && outdated.length > 0 && <OutdatedMachinesCard machines={outdated} />}
    <SharedSignIns view={view} pending={pending?.kind === 'stop-sharing' ? pending : null} onPending={setPending} onClose={close} />
    {missing.length > 0 && <PageBlock><div testId="accounts-notes" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', paddingBottom: 30 }}><Note>{`${list(missing.map((p) => p.display_name))} ${missing.length === 1 ? 'isn’t' : 'aren’t'} installed. Set ${missing.length === 1 ? 'it' : 'them'} up in `}</Note><TextLink testId="accounts-agent-providers" onClick={() => openSettingsTab('agents')}>Agent providers</TextLink><Note>.</Note></div></PageBlock>}
  </>
}

/** The agents in the order the agent list has them, then any only another machine has. */
function orderGroups(view: UnifiedView, order: ProviderKind[]): HarnessGroup[] {
  const rank = (kind: ProviderKind) => { const i = order.indexOf(kind); return i < 0 ? order.length : i }
  // omp, OpenCode and pi have no account: they are listed only for profiles set up before Kybern stopped offering them.
  return view.groups.filter((group) => group.accounts.length > 0 || group.signedOutTerminals.some((entry) => entry.online)).sort((a, b) => rank(a.kind) - rank(b.kind))
}

function Note({ children, color }: { children: string; color?: string }) {
  const t = useTheme()
  return <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}><Label color={color ?? t.textSecondary} size={12} lineHeight={19.2}>{children}</Label></div>
}
function TextLink({ children, onClick, testId }: { children: string; onClick: () => void; testId?: string }) {
  const t = useTheme()
  return <div testId={testId} role="button" tabIndex={0} onClick={onClick} onKeyDown={(e) => { if (e.key === 'enter' || e.key === 'space') onClick() }} style={{ display: 'flex', cursor: 'pointer' }}><Label color={t.textSecondary} size={12} lineHeight={19.2} style={{ textDecoration: 'underline' }}>{children}</Label></div>
}

/** Each machine too old to send account keys, with the update action; shown alone when there are no accounts to list. */
function OutdatedMachinesCard({ machines }: { machines: readonly MachineAccounts[] }) {
  const t = useTheme()
  const g = useGlass()
  return <PageBlock><div testId="accounts-outdated" style={{ display: 'flex', flexDirection: 'column', paddingBottom: 30 }}>
    <div style={{ display: 'flex', flexDirection: 'column', ...settingsCardStyle(t, g), overflow: 'hidden' }}><GlassEdge radius={12} color={g.highlight} />
      {machines.map((machine, index) => <div key={machine.machineId} testId={`accounts-outdated-${machine.machineId}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingLeft: 18, paddingRight: 14, paddingTop: 12, paddingBottom: 12, borderTopWidth: index === 0 ? 0 : 1, borderColor: t.v('--app-settings-card-border') }}>
        <Label color={t.text} size={14} lineHeight={21} weight={500} truncate>{outdatedMachineLabel(machine.name)}</Label>
        <UpdateButton machine={machine} />
      </div>)}
    </div>
  </div></PageBlock>
}

function UpdateButton({ machine, testId }: { machine: Pick<MachineAccounts, 'machineId' | 'name'>; testId?: string }) {
  const updateRun = useUpdateRun()
  const row = updateRun[machine.machineId]
  const updating = !!row && isUpdating(row)
  return <Button testId={testId ?? `accounts-update-${machine.machineId}`} size="sm" busy={updating} disabled={updating} onClick={() => void retryMachineUpdate(machine.machineId).catch((error) => toastProblem(error, { action: `update ${machine.name}`, machine: machine.name }))}>Update</Button>
}

// ── The list ─────────────────────────────────────────────────────────────────

const LIST_WIDTH = 248

function SplitCard({ children }: { children: ReactNode }) {
  const t = useTheme()
  const g = useGlass()
  return <div testId="accounts-card" style={{ display: 'flex', flexDirection: 'row', alignItems: 'stretch', minHeight: 420, ...settingsCardStyle(t, g), overflow: 'hidden' }}><GlassEdge radius={12} color={g.highlight} />{children}</div>
}

function AccountList({ items, selected, view, onSelect }: { items: readonly Item[]; selected: string; view: UnifiedView; onSelect: (id: string) => void }) {
  const t = useTheme()
  const providers = useNav((s) => s.providers)
  const ids = items.map((item) => item.id)
  // Arrow keys move the selection, as a macOS source list does.
  const move = (from: string, by: number) => { const next = ids[ids.indexOf(from) + by]; if (next) onSelect(next) }
  return <div testId="accounts-list" role="listbox" aria-label="Accounts" style={{ display: 'flex', flexDirection: 'column', width: LIST_WIDTH, flexShrink: 0, gap: 1, paddingLeft: 6, paddingRight: 6, paddingTop: 6, paddingBottom: 6, borderRightWidth: 1, borderColor: t.v('--app-settings-card-border') }}>
    {items.map((item, index) => {
      const heading = index === 0 || items[index - 1]!.kind !== item.kind
      const name = providers.find((p) => p.kind === item.kind)?.display_name ?? agentName(item.kind)
      return <div key={item.id} style={{ display: 'flex', flexDirection: 'column' }}>
        {heading && <div testId={`accounts-${item.kind}`} style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 8, paddingRight: 8, paddingTop: index === 0 ? 6 : 12, paddingBottom: 4 }}><ProviderMark kind={item.kind} size={12} /><Label color={t.textSecondary} size={12} lineHeight={16} weight={600} truncate>{name}</Label></div>}
        <ListRow item={item} view={view} selected={item.id === selected} onSelect={() => onSelect(item.id)} onMove={(by) => move(item.id, by)} />
      </div>
    })}
  </div>
}

/** The login this computer uses for the account: its named one, else its terminal one. */
const loginHere = (account: UnifiedAccount, view: Pick<UnifiedView, 'primaryId'>) => {
  const here = account.presences.filter((p) => p.machineId === view.primaryId)
  return here.find((p) => !p.terminal) ?? here[0]
}

function ListRow({ item, view, selected, onSelect, onMove }: { item: Item; view: UnifiedView; selected: boolean; onSelect: () => void; onMove: (by: number) => void }) {
  const t = useTheme()
  const c = useControls()
  const account = item.account
  const here = account ? loginHere(account, view) : undefined
  const flash = useAccountFlash(item.kind, here?.instance ?? '')
  const summary = account ? accountSummary(account, machineRows(account, view.machines), view.machines.length) : { text: 'Not signed in', warn: false }
  const line = account?.isDefault && !summary.warn ? [view.machines.length > 1 ? 'Default' : null, summary.text].filter(Boolean).join(' · ') || 'Default' : summary.text
  const left = account ? leftOf(account, Date.now()) : null
  const name = account?.name ?? 'Not signed in'
  return <div testId={`account-row-${item.id}`} role="option" aria-selected={selected} aria-label={name} tabIndex={0}
    onClick={onSelect}
    onKeyDown={(e) => { if (e.key === 'down') onMove(1); else if (e.key === 'up') onMove(-1); else if (e.key === 'enter' || e.key === 'space') onSelect() }}
    style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 9, minHeight: 44, paddingLeft: 8, paddingRight: 8, paddingTop: 6, paddingBottom: 6, borderRadius: 8, cursor: 'pointer', backgroundColor: selected ? c.optionSelected : 'transparent', ...(selected ? {} : { hover: { backgroundColor: t.hover } }), focusVisible: { borderColor: c.accent } }}>
    {flash && <FlashOverlay />}
    <AccountAvatar kind={item.kind} color={account?.color} instance={account?.color ? 'named' : here && !here.terminal ? here.instance : 'default'} size={28} />
    <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
      <Label color={t.text} size={13} lineHeight={18} weight={500} truncate>{name}</Label>
      {line && <div testId={`account-summary-${item.id}`} style={{ display: 'flex', minWidth: 0 }}><Label color={summary.warn ? t.warning : t.textSecondary} size={12} lineHeight={16} truncate>{line}</Label></div>}
    </div>
    {left !== null && <div testId={`account-left-${item.id}`} style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}><AccountUsageRing left={left} size={14} /><Label color={t.textSecondary} size={12} lineHeight={16} style={{ fontVariantNumeric: 'tabular-nums' } as never}>{`${Math.round(left)}%`}</Label></div>}
  </div>
}

/** A row that was just added flashes once as its accent background fades out (`account-row-flash`, 600 ms). */
function FlashOverlay() {
  const t = useTheme()
  if (REDUCED_MOTION) return null
  return <motion.div initial={{ opacity: 1 }} animate={{ opacity: 0 }} transition={{ duration: 0.6, ease: [...EASE.smoothOut] as [number, number, number, number] }} style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, borderRadius: 8, backgroundColor: t.v('--color-background-accent'), pointerEvents: 'none' }} />
}

// ── The detail pane ──────────────────────────────────────────────────────────

function Pane({ children, testId }: { children: ReactNode; testId: string }) {
  return <div testId={testId} style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, flexShrink: 1, minWidth: 0, gap: 22, paddingLeft: 22, paddingRight: 22, paddingTop: 20, paddingBottom: 22 }}>{children}</div>
}

/** A rounded group of rows inside the pane, hairlines between them. */
function Group({ children, label, testId }: { children: ReactNode; label?: string; testId?: string }) {
  const t = useTheme()
  const rows = (Array.isArray(children) ? children : [children]).flat().filter(Boolean) as ReactNode[]
  if (!rows.length) return null
  return <div testId={testId} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
    {label && <Label color={t.textSecondary} size={12} lineHeight={16} weight={600} style={{ paddingLeft: 2 }}>{label}</Label>}
    <div style={{ display: 'flex', flexDirection: 'column', borderWidth: 1, borderColor: t.v('--app-settings-card-border'), borderRadius: 10 }}>
      {rows.map((row, i) => <div key={i} style={{ display: 'flex', flexDirection: 'column', borderTopWidth: i ? 1 : 0, borderColor: t.v('--app-settings-card-border') }}>{row}</div>)}
    </div>
  </div>
}

function PaneRow({ title, children, testId }: { title: string; children?: ReactNode; testId?: string }) {
  const t = useTheme()
  return <div testId={testId} style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: 44, paddingLeft: 14, paddingRight: 12, paddingTop: 6, paddingBottom: 6 }}>
    <Label color={t.text} size={13} lineHeight={19} style={{ flexGrow: 1, flexShrink: 1, minWidth: 0 }}>{title}</Label>
    {children && <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>{children}</div>}
  </div>
}

function PaneHeader({ kind, color, instance, title, detail, children }: { kind: ProviderKind; color?: string; instance?: string; title: string; detail?: string; children?: ReactNode }) {
  const t = useTheme()
  return <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
    <AccountAvatar kind={kind} color={color} instance={instance} size={40} />
    <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
      <div testId="account-detail-name" style={{ display: 'flex', minWidth: 0 }}><Label color={t.text} size={17} lineHeight={22} weight={600} truncate>{title}</Label></div>
      {detail && <Label color={t.textSecondary} size={13} lineHeight={19} truncate>{detail}</Label>}
    </div>
    {children}
  </div>
}

function AccountDetail({ account, view, onPending }: { account: UnifiedAccount; view: UnifiedView; onPending: (next: Pending) => void }) {
  const here = loginHere(account, view)
  const rows = machineRows(account, view.machines)
  const named = account.presences.filter((p) => !p.terminal)
  const styled = !view.legacy && !account.terminalOnly && canStyle(view, account)
  const agent = agentName(account.kind)
  const removable = new Set(named.map((p) => p.machineId)).size
  const projects = here ? here.projects.length : 0
  return <Pane testId={`account-detail-${account.id}`}>
    <PaneHeader kind={account.kind} color={account.color} instance={account.color ? 'named' : here && !here.terminal ? here.instance : 'default'} title={account.name} detail={[account.email && account.email !== account.name ? account.email : null, account.plan].filter(Boolean).join(' · ')}>
      <UsageCell account={account} view={view} />
    </PaneHeader>
    {rows.length > 0 && <Group label="Machines" testId={`account-machines-${account.id}`}>
      {rows.map((row) => <MachineLine key={row.machineId} row={row} account={account} view={view} onPending={onPending} />)}
    </Group>}
    {!view.legacy && <Group testId={`account-choices-${account.id}`}>
      <PaneRow title={`Default for ${agent}`}>
        {/* There is always one default: it changes by making another account the default, so this one stays on. */}
        <Tip label={`Make another account the default for ${agent} to change this`} disabled={!account.isDefault} side="top" size={32}>
          <div style={{ display: 'flex' }}><Switch testId={`account-default-${account.id}`} aria-label={`Default for ${agent}`} checked={account.isDefault} onCheckedChange={(on) => { if (on && !account.isDefault) void makeDefault(view, account) }} /></div>
        </Tip>
      </PaneRow>
      {account.key && <PaneRow title="Suggest it when another account runs out">
        <Switch testId={`account-suggest-${account.id}`} aria-label="Suggest it when another account runs out" checked={!account.manualOnly} onCheckedChange={(on) => void setProfile(view, account, { manual_only: !on }).catch((error) => toastProblem(error, { action: 'save that choice' }))} />
      </PaneRow>}
      {here && <PaneRow title="Projects">
        {projects > 0 && <MutedText>{projects === 1 ? '1 project' : `${projects} projects`}</MutedText>}
        <Button testId={`account-projects-${account.id}`} size="sm" onClick={() => onPending({ kind: 'projects', account })}>Choose…</Button>
      </PaneRow>}
      {here && <IdleRow account={account} instance={here.instance} />}
    </Group>}
    {styled && <Group testId={`account-profile-${account.id}`}>
      <PaneRow title="Name"><NameField account={account} view={view} /></PaneRow>
      <PaneRow title="Color"><ColorPicker account={account} view={view} /></PaneRow>
    </Group>}
    {removable > 0 && !view.legacy && <div style={{ display: 'flex' }}>
      <Button testId={`account-remove-${account.id}`} size="sm" variant="secondary" danger onClick={() => onPending({ kind: 'remove', account })}>{removable > 1 ? 'Remove from all machines…' : 'Remove account…'}</Button>
    </div>}
  </Pane>
}

/** "Compact idle threads" for the agents that have it. */
function IdleRow({ account, instance }: { account: UnifiedAccount; instance: string }) {
  if (!IDLE_COMPACTION_HARNESSES.includes(account.kind)) return null
  return <PaneRow title="Compact idle threads"><AccountIdleCompactionSelect kind={account.kind} instance={instance} testId={`account-idle-${account.id}`} /></PaneRow>
}

function MutedText({ children }: { children: string }) {
  const t = useTheme()
  return <Label color={t.textSecondary} size={13} lineHeight={19}>{children}</Label>
}

/** An agent with no account yet: each machine where its own login is signed out, with a sign-in there. */
function AgentDetail({ group, view }: { group: HarnessGroup; view: UnifiedView }) {
  const rows = agentRows(group, view.machines)
  const providers = useNav((s) => s.providers)
  const name = providers.find((p) => p.kind === group.kind)?.display_name ?? agentName(group.kind)
  return <Pane testId={`account-detail-${group.kind}:@agent`}>
    <PaneHeader kind={group.kind} instance="default" title={name} detail="Not signed in" />
    {rows.length > 0 && <Group label="Machines" testId={`agent-machines-${group.kind}`}>
      {rows.map((row) => <AgentMachineLine key={row.machineId} row={row} kind={group.kind} view={view} />)}
    </Group>}
  </Pane>
}

function MachineName({ row }: { row: Pick<MachineRow, 'machine' | 'isLocal'> }) {
  const t = useTheme()
  return <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
    <Label color={t.text} size={13} lineHeight={19} truncate>{row.machine}</Label>
    {row.isLocal && <Label color={t.textTertiary} size={12} lineHeight={19} style={{ flexShrink: 0 }}>This computer</Label>}
  </div>
}

function Status({ row, testId }: { row: MachineRow; testId: string }) {
  const t = useTheme()
  const tone = stateTone(row.state)
  const color = tone === 'warn' ? t.warning : tone === 'quiet' ? t.textTertiary : t.textSecondary
  const dot = tone === 'ok' ? t.v('--success') : tone === 'warn' ? t.warning : tone === 'neutral' ? t.textTertiary : null
  return <div testId={testId} style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 1, minWidth: 0 }}>
    {dot && <div style={{ width: 7, height: 7, borderRadius: 3.5, flexShrink: 0, backgroundColor: dot }} />}
    <Label color={color} size={13} lineHeight={19} truncate>{stateLabel(row)}</Label>
  </div>
}

function MachineFrame({ row, testId, children }: { row: MachineRow; testId: string; children: ReactNode }) {
  return <div testId={testId} style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 42, paddingLeft: 14, paddingRight: 8, paddingTop: 5, paddingBottom: 5 }}>
    <MachineName row={row} />
    {children}
  </div>
}

/** Where the menu would be, so rows without one keep their statuses aligned. */
function MenuSpace() { return <div style={{ width: 24, height: 24, flexShrink: 0 }} /> }

function MachineLine({ row, account, view, onPending }: { row: MachineRow; account: UnifiedAccount; view: UnifiedView; onPending: (next: Pending) => void }) {
  const machine = view.machines.find((m) => m.machineId === row.machineId)!
  const target = { machineId: row.machineId, name: row.machine }
  const id = `${account.id}-${row.machineId}`
  const named = row.standing?.presences.find((p) => !p.terminal)
  const terminal = row.standing?.presences.find((p) => p.terminal && p.state !== 'signed_out')
  const commands = TERMINAL_COMMANDS[account.kind]
  const agent = agentName(account.kind)
  // The one action the state allows, beside its status.
  let action: ReactNode = null
  if (row.state === 'outdated') action = <UpdateButton machine={target} testId={`machine-update-${id}`} />
  else if (row.state === 'not_signed_in' || (row.state === 'signed_out' && (named || !row.standing))) action = <Button testId={`machine-signin-${id}`} size="sm" onClick={() => signInWith(view, account, target)}>Sign in</Button>
  else if (row.state === 'signed_out') {
    // Only the machine's own login has the account: sign that in, or say what to type there.
    action = canSignInTerminal(account.kind, machine.features)
      ? <Button testId={`machine-signin-${id}`} size="sm" onClick={() => signInTerminals(account.kind, [{ machineId: row.machineId, machine: row.machine }])}>Sign in</Button>
      : commands ? <Menu testId={`machine-signin-how-${id}`} align="end" minWidth={220} trigger={() => <Button testId={`machine-signin-${id}`} size="sm">Sign in</Button>}>
        <MenuLabel>{`Run in a terminal on ${row.machine}`}</MenuLabel>
        <MenuItem id="copy" testId={`machine-copy-${id}`} label={`Copy ${commands.signIn}`} onSelect={() => copyCommand(commands.signIn)} />
      </Menu> : null
  }
  // Everything else that machine can do with the account, behind ⋯.
  const items: ReactNode[] = []
  const working = row.state === 'signed_in' || row.state === 'uses'
  if (working && named) items.push(<MenuItem key="again" id="again" testId={`machine-again-${id}`} label="Sign in again" onSelect={() => signIn([planOnMachine(account, target)])} />)
  if (working && named?.canSignOut) items.push(<MenuItem key="signout" id="signout" testId={`machine-signout-${id}`} label="Sign out…" onSelect={() => onPending({ kind: 'signout', account, machine: row.machineId })} />)
  if (working && !named && terminal?.state === 'signed_in') {
    if (supportsShared(machine.features)) items.push(<MenuItem key="signout" id="signout" testId={`machine-signout-${id}`} label="Sign out…" onSelect={() => onPending({ kind: 'terminal', account, machineId: row.machineId, machine: row.machine })} />)
    else if (commands) items.push(<MenuLabel key="how">{`Sign out of ${agent} in a terminal on ${row.machine}`}</MenuLabel>, <MenuItem key="copy" id="copy-out" testId={`machine-copy-out-${id}`} label={`Copy ${commands.signOut}`} onSelect={() => copyCommand(commands.signOut)} />)
  }
  if (row.state === 'borrowed' || row.state === 'unreachable') items.push(<MenuItem key="instead" id="instead" testId={`machine-instead-${id}`} label={`Sign in on ${row.machine} instead`} onSelect={() => void signInInstead(account, target)} />)
  if (named && row.state !== 'offline' && row.state !== 'outdated') {
    if (items.length) items.push(<MenuSeparator key="sep" />)
    items.push(<MenuItem key="remove" id="remove" testId={`machine-remove-${id}`} label={`Remove from ${row.machine}…`} destructive onSelect={() => onPending({ kind: 'remove', account, machine: row.machineId })} />)
  }
  return <MachineFrame row={row} testId={`machine-row-${id}`}>
    <Status row={row} testId={`machine-status-${id}`} />
    {action}
    {items.length > 0 && !view.legacy ? <MachineMenu id={id} machine={row.machine}>{items}</MachineMenu> : <MenuSpace />}
  </MachineFrame>
}

function MachineMenu({ id, machine, children }: { id: string; machine: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  useSettingsModal(open)
  return <Menu testId={`machine-menu-${id}`} align="end" minWidth={208} onOpenChange={setOpen} trigger={() => <IconButton testId={`machine-more-${id}`} size="sm" icon={N.ellipsis} label={`More for ${machine}`} active={open} />}>{children}</Menu>
}

function AgentMachineLine({ row, kind, view }: { row: MachineRow; kind: ProviderKind; view: UnifiedView }) {
  const machine = view.machines.find((m) => m.machineId === row.machineId)!
  const id = `${kind}-${row.machineId}`
  const commands = TERMINAL_COMMANDS[kind]
  let action: ReactNode = null
  if (row.state === 'outdated') action = <UpdateButton machine={{ machineId: row.machineId, name: row.machine }} testId={`machine-update-${id}`} />
  else if (row.state === 'not_signed_in') action = canSignInTerminal(kind, machine.features)
    ? <Button testId={`machine-signin-${id}`} size="sm" onClick={() => signInTerminals(kind, [{ machineId: row.machineId, machine: row.machine }])}>Sign in</Button>
    : commands ? <Menu testId={`machine-signin-how-${id}`} align="end" minWidth={220} trigger={() => <Button testId={`machine-signin-${id}`} size="sm">Sign in</Button>}>
      <MenuLabel>{`Run in a terminal on ${row.machine}`}</MenuLabel>
      <MenuItem id="copy" testId={`machine-copy-${id}`} label={`Copy ${commands.signIn}`} onSelect={() => copyCommand(commands.signIn)} />
    </Menu> : null
  return <MachineFrame row={row} testId={`machine-row-${id}`}><Status row={row} testId={`machine-status-${id}`} />{action}<MenuSpace /></MachineFrame>
}

function UsageCell({ account, view }: { account: UnifiedAccount; view: UnifiedView }) {
  const t = useTheme()
  const now = Date.now()
  const left = leftOf(account, now)
  if (left === null) return null
  const binding = bindingLimit(account.limit!.entry.limits, now)!
  const window = windowLabel(binding.limit).toLowerCase()
  const family = limitFamily(binding.limit)
  const from = account.limit!.machineId === view.primaryId ? '' : ` · read on ${view.machines.find((m) => m.machineId === account.limit!.machineId)?.name}`
  const here = loginHere(account, view)
  return <Tip label={`${Math.round(left)}% of the ${window} limit left${family ? ` for ${family}` : ''}${from}`} side="top" size={64}>
    <Button testId={`account-usage-${account.id}`} variant="ghost" size="sm" label={`${Math.round(left)}% left`} onClick={() => { if (here) setUsageAnchor(account.kind, here.instance); goPage('usage') }}>
      <AccountUsageRing left={left} size={16} />
      <Label color={t.textSecondary} size={13} lineHeight={16} weight={500} style={{ fontVariantNumeric: 'tabular-nums' } as never}>{`${Math.round(left)}% left`}</Label>
    </Button>
  </Tip>
}

function NameField({ account, view }: { account: UnifiedAccount; view: UnifiedView }) {
  const [draft, setDraft] = useState(account.name)
  const [error, setError] = useState(false)
  const saving = useRef(false)
  const canceled = useRef(false)
  useEffect(() => { setDraft(account.name); setError(false) }, [account.name])
  const save = async () => {
    if (canceled.current) { canceled.current = false; return }
    const name = draft.trim()
    if (name === account.name || saving.current) return
    if (!isNameValid(name)) { setError(true); return }
    saving.current = true
    try {
      await setProfile(view, account, { name })
      toast.success(`Renamed to ${name}`)
    } catch (problem) {
      toastProblem(problem, { action: 'rename the account' })
    } finally { saving.current = false }
  }
  return <Tip label="Enter a name up to 120 characters." disabled={!error} open={error || undefined} side="top" size={200}>
    <div style={{ display: 'flex' }}><TextField testId="account-rename" label={`${account.name} name`} size="sm" width={200} value={draft} invalid={error}
      onChange={(value) => { setDraft(value); setError(false) }}
      onBlur={() => void save()}
      onSubmit={() => void save()}
      onKeyDown={(e: { key?: string }) => { if (e.key === 'escape') { canceled.current = true; setDraft(account.name); setError(false) } }} /></div>
  </Tip>
}

function ColorPicker({ account, view }: { account: UnifiedAccount; view: UnifiedView }) {
  const t = useTheme()
  const current = isAccountColor(account.color) ? account.color : null
  const choose = (value: string) => void setProfile(view, account, { color: value }).catch((error) => toastProblem(error, { action: 'change the color' }))
  return <div role="radiogroup" aria-label="Color" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
    {ACCOUNT_COLORS.map((value) => <div key={value} testId={`account-color-${value}`} role="radio" aria-checked={current === value} aria-label={ACCOUNT_COLOR_LABELS[value]} tabIndex={0}
      onClick={() => choose(value)} onKeyDown={(e) => { if (e.key === 'enter' || e.key === 'space') choose(value) }}
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, borderColor: current === value ? t.text : 'transparent', cursor: 'pointer' }}>
      <AccountDot color={value} size={14} />
    </div>)}
  </div>
}

// ── Shared sign-ins ──────────────────────────────────────────────────────────

const NOBODY = '@each'

/** One pop-up per agent another machine can lend (`login.broker.per_kind.v1`); one for every agent before it. */
function SharedSignIns({ view, pending, onPending, onClose }: { view: UnifiedView; pending: Extract<Pending, { kind: 'stop-sharing' }> | null; onPending: (next: Pending) => void; onClose: () => void }) {
  const t = useTheme()
  const g = useGlass()
  const providers = useNav((s) => s.providers)
  const here = view.machines[0]
  if (!here || view.machines.length < 2 || !here.features.includes(LOGIN_SHARING_FEATURE)) return null
  const perKind = supportsPerKind(here.features)
  // Only the agents someone has: an account, or the agent installed on a machine.
  const used = (kind: ProviderKind) => view.groups.some((group) => group.kind === kind && group.accounts.length > 0) || view.machines.some((m) => m.providers?.some((p) => p.kind === kind && p.available))
  const kinds: (ProviderKind | null)[] = perKind ? LENDABLE_KINDS.filter(used) : [null]
  if (!kinds.length) return null
  const candidates = view.lenderOptions ?? view.machines.filter((m) => m.online && m.features.includes(LOGIN_SHARING_FEATURE)).map((m) => ({ machineId: m.machineId, name: m.name, canShare: true }))
  return <PageBlock testId="accounts-sharing"><div style={{ display: 'flex', flexDirection: 'column', paddingBottom: 30 }}>
    <Label color={t.text} size={14} lineHeight={19.6} weight={600} style={{ paddingLeft: 2 }}>Shared sign-ins</Label>
    <Label color={t.textSecondary} size={13} lineHeight={19.5} style={{ paddingLeft: 2, marginTop: 4, marginBottom: 12 }}>A machine without its own sign-in uses the one you choose.</Label>
    <div style={{ display: 'flex', flexDirection: 'column', ...settingsCardStyle(t, g), overflow: 'hidden' }}><GlassEdge radius={12} color={g.highlight} />
      {kinds.map((kind, index) => {
        const lender = kind ? view.lenders?.[kind] ?? null : view.sharing
        const title = kind ? providers.find((p) => p.kind === kind)?.display_name ?? agentName(kind) : 'All agents'
        const options = [{ value: NOBODY, label: 'Each machine signs in' }, ...candidates.map((c) => ({ value: c.machineId, label: `From ${c.name}`, disabled: !c.canShare && c.machineId !== lender?.machineId }))]
        if (lender && !candidates.some((c) => c.machineId === lender.machineId)) options.push({ value: lender.machineId, label: `From ${lender.machine}`, disabled: false })
        const choose = (value: string) => {
          if (value === (lender?.machineId ?? NOBODY)) return
          if (value === NOBODY) { if (lender) onPending({ kind: 'stop-sharing', provider: kind, lender }); return }
          const name = candidates.find((c) => c.machineId === value)?.name ?? lender?.machine ?? 'that machine'
          void shareSignIns(value as MachineId, name, undefined, kind ?? undefined)
        }
        const id = kind ?? 'all'
        return <div key={id} testId={`sharing-row-${id}`} style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingLeft: 18, paddingRight: 14, paddingTop: 11, paddingBottom: 11, borderTopWidth: index ? 1 : 0, borderColor: t.v('--app-settings-card-border') }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexGrow: 1, flexShrink: 1, minWidth: 0 }}>{kind && <ProviderMark kind={kind} size={14} />}<Label color={t.text} size={14} lineHeight={21} weight={500} truncate>{title}</Label></div>
            <Select testId={`sharing-${id}`} label={`${title} sign-ins`} value={lender?.machineId ?? NOBODY} options={options} onChange={choose} />
          </div>
          {lender && !lender.usable && lender.reason && <div testId={`sharing-note-${id}`} style={{ display: 'flex', paddingLeft: kind ? 22 : 0 }}><Label color={t.warning} size={12} lineHeight={18}>{lender.reason}</Label></div>}
        </div>
      })}
    </div>
    {pending && <ConfirmDialog testId="accounts-stop-sharing"
      title={pending.provider ? `Stop sharing ${agentName(pending.provider)} sign-ins?` : `Stop sharing ${pending.lender.machine}’s sign-ins?`}
      body="Machines that use them ask you to sign in when their current sign-in ends." confirm="Stop sharing"
      onConfirm={() => shareSignIns(null, pending.lender.machine, undefined, pending.provider ?? undefined)} onClose={onClose} />}
  </div></PageBlock>
}

// ── Dialogs ──────────────────────────────────────────────────────────────────

function AccountDialog({ pending, view, onClose }: { pending: Exclude<Pending, { kind: 'stop-sharing' }>; view: UnifiedView; onClose: () => void }) {
  switch (pending.kind) {
    case 'remove': return <MachinesDialog mode="remove" account={pending.account} only={pending.machine} view={view} onClose={onClose} />
    case 'signout': return <MachinesDialog mode="signout" account={pending.account} only={pending.machine} view={view} onClose={onClose} />
    case 'terminal': return <TerminalSignOutDialog account={pending.account} machineId={pending.machineId} machine={pending.machine} onClose={onClose} />
    case 'projects': return <ProjectsDialog account={pending.account} view={view} onClose={onClose} />
  }
}

function DialogShell({ children, onClose, testId, width = 448 }: { children: ReactNode; onClose: () => void; testId: string; width?: number }) {
  return <Dialog testId={testId} width={width} onClose={() => { if (!selectOwnsEscape()) onClose() }}>{children}</Dialog>
}
function DialogFooter({ children }: { children: ReactNode }) {
  return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, paddingLeft: 16, paddingRight: 16, paddingTop: 12, paddingBottom: 12 }}>{children}</div>
}
function DialogText({ title, body }: { title: string; body?: string }) {
  const t = useTheme()
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 16, paddingRight: 16, paddingTop: 16, paddingBottom: 8 }}>
    <Label color={t.text} size={18} lineHeight={22.5} weight={600}>{title}</Label>
    {body && <Label color={t.textSecondary} size={14} lineHeight={19.25}>{body}</Label>}
  </div>
}

function ConfirmDialog({ testId, title, body, confirm, onConfirm, onClose }: { testId: string; title: string; body: string; confirm: string; onConfirm: () => Promise<unknown>; onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  const run = async () => { setBusy(true); try { await onConfirm(); onClose() } finally { setBusy(false) } }
  return <DialogShell testId={testId} onClose={() => { if (!busy) onClose() }}>
    <DialogText title={title} body={body} />
    <DialogFooter><Button testId={`${testId}-cancel`} size="lg" onClick={onClose}>Cancel</Button><Button testId={`${testId}-confirm`} size="lg" variant="destructive" busy={busy} disabled={busy} onClick={() => void run()}>{confirm}</Button></DialogFooter>
  </DialogShell>
}

/** The agent's own login on that machine is what its terminal uses: signing it out signs the terminal out too. */
function TerminalSignOutDialog({ account, machineId, machine, onClose }: { account: UnifiedAccount; machineId: string; machine: string; onClose: () => void }) {
  const agent = agentName(account.kind)
  return <ConfirmDialog testId="account-terminal-signout" title={`Sign out of ${agent} on ${machine}?`} body={`${agent} in ${machine}’s terminal signs out too.`} confirm="Sign out" onConfirm={() => signOutTerminalOn(account.kind, machineId, machine)} onClose={onClose} />
}

/** Remove or sign out: on one machine (`only`), or on the machines ticked, all of them at first. */
function MachinesDialog({ mode, account, only, view, onClose }: { mode: 'remove' | 'signout'; account: UnifiedAccount; only?: string; view: UnifiedView; onClose: () => void }) {
  const eligible = standings({ presences: account.presences.filter((p) => !p.terminal && (!only || p.machineId === only) && (mode === 'remove' || (p.state === 'signed_in' && p.canSignOut))) })
  const rows = eligible.map((standing) => ({ machine: { machineId: standing.machineId, name: standing.machine }, blocker: standing.online ? null : 'Offline' }))
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(() => new Set())
  const [busy, setBusy] = useState(false)
  const targets = rows.filter((row) => !row.blocker && !unticked.has(row.machine.machineId)).map((row) => row.machine.machineId)
  const managed = account.presences.some((p) => !p.terminal && p.managed && targets.includes(p.machineId))
  const terminals = account.presences.filter((p) => p.terminal && p.state === 'signed_in' && (!only || p.machineId === only)).map((p) => p.machine)
  const where = view.machines.length > 1 && rows.length === 1 ? ` from ${rows[0]!.machine.name}` : ''
  const on = view.machines.length > 1 && rows.length === 1 ? ` on ${rows[0]!.machine.name}` : ''
  const body = mode === 'signout' ? undefined
    : [managed ? 'Kybern signs it out and deletes its folder.' : 'Kybern stops using it. Its folder and sign-in stay.', terminals.length ? `The terminal on ${list(terminals)} stays signed in to ${agentName(account.kind)}.` : null].filter(Boolean).join(' ')
  const run = async () => {
    setBusy(true)
    const done = mode === 'remove' ? await removeFrom(account, targets) : await signOutOn(account, targets)
    setBusy(false)
    if (done) onClose()
  }
  return <DialogShell testId={`account-${mode}`} onClose={() => { if (!busy) onClose() }}>
    <DialogText title={mode === 'remove' ? `Remove ${account.name}${where}?` : `Sign out ${account.name}${on}?`} body={body} />
    {rows.length > 1 && <div style={{ display: 'flex', flexDirection: 'column', paddingLeft: 16, paddingRight: 16, paddingTop: 4, paddingBottom: 4 }}><MachineChecks rows={rows} unticked={unticked} onToggle={(id) => setUnticked((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })} /></div>}
    <DialogFooter><Button testId={`account-${mode}-cancel`} size="lg" onClick={onClose}>Cancel</Button><Button testId={`account-${mode}-confirm`} size="lg" variant="destructive" busy={busy} disabled={busy || !targets.length} onClick={() => void run()}>{mode === 'remove' ? 'Remove account' : 'Sign out'}</Button></DialogFooter>
  </DialogShell>
}

function ProjectsDialog({ account, view, onClose }: { account: UnifiedAccount; view: UnifiedView; onClose: () => void }) {
  const t = useTheme()
  const projects = useApp((s) => s.projects)
  const { settings } = useSettings()
  const kind = account.kind
  // Project choices belong to the machine this window is at, where the projects are.
  const instance = loginHere(account, view)!.instance
  const local = useMemo(() => projects.filter((p) => !(p as { machineId?: string }).machineId), [projects])
  const stored = settings?.providers[kind]?.project_accounts ?? {}
  const [checked, setChecked] = useState(() => new Set(local.filter((p) => stored[p.path] === instance).map((p) => p.path)))
  const [saving, setSaving] = useState(false)
  const otherName = (path: string) => {
    const other = stored[path]
    if (!other || other === instance) return null
    return view.groups.find((g) => g.kind === kind)?.accounts.find((a) => a.presences.some((p) => p.machineId === view.primaryId && p.instance === other))?.name ?? null
  }
  const sorted = useMemo(() => [...local].sort((a, b) => a.name.localeCompare(b.name)), [local])
  const save = async () => {
    if (!getClient()) return
    setSaving(true)
    try {
      await updateProviderSettings(kind, (current) => {
        const next = { ...current.project_accounts }
        for (const project of local) {
          if (checked.has(project.path)) next[project.path] = instance
          else if (next[project.path] === instance) delete next[project.path]
        }
        return { ...current, project_accounts: next }
      })
      onClose()
    } catch (error) {
      toastProblem(error, { action: 'save the projects' })
    } finally {
      setSaving(false)
    }
  }
  const toggle = (path: string) => setChecked((prev) => { const next = new Set(prev); if (next.has(path)) next.delete(path); else next.add(path); return next })
  return <DialogShell testId="account-projects" onClose={onClose}>
    <DialogText title={`Use ${account.name} for projects`} body={`These projects use ${account.name} instead of the default. Their worktrees do too.`} />
    <CloseX onClose={onClose} />
    <div testId="account-projects-list" aria-label="Projects" style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 288, overflowY: 'scroll', paddingLeft: 16, paddingRight: 16, paddingTop: 4, paddingBottom: 12 }}>
      {sorted.map((project) => {
        const other = otherName(project.path)
        return <div key={project.id} testId={`account-project-${project.id}`} role="checkbox" aria-checked={checked.has(project.path)} aria-label={project.name} tabIndex={0} onClick={() => toggle(project.path)} onKeyDown={(e) => { if (e.key === 'enter' || e.key === 'space') toggle(project.path) }} style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 36, paddingLeft: 8, paddingRight: 8, paddingTop: 6, paddingBottom: 6, borderRadius: 8, cursor: 'pointer', hover: { backgroundColor: t.hover } }}>
          <Checkbox checked={checked.has(project.path)} aria-label={project.name} style={{ pointerEvents: 'none' }} />
          <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 }}><Label color={t.text} size={14} lineHeight={21} truncate>{project.name}</Label><Label color={t.textSecondary} size={13} lineHeight={19.5} truncate>{project.path}</Label></div>
          {other && <Label color={t.textSecondary} size={13} lineHeight={19.5}>{`Uses ${other}`}</Label>}
        </div>
      })}
      {sorted.length === 0 && <div style={{ paddingLeft: 8, paddingRight: 8, paddingTop: 12, paddingBottom: 12 }}><Label color={t.textSecondary} size={14} lineHeight={21}>No projects yet. Add a project from the sidebar.</Label></div>}
    </div>
    <DialogFooter><Button testId="account-projects-cancel" size="lg" variant="ghost" onClick={onClose}>Cancel</Button><Button testId="account-projects-save" size="lg" variant="primary" disabled={saving} onClick={() => void save()}>Save</Button></DialogFooter>
  </DialogShell>
}
