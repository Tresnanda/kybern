// Settings › Accounts: every account of every machine in one list, grouped by agent and merged by identity
// (`accounts/unified.ts`). Each row says where the account is signed in (machine chips), what is left of its limits, and
// carries its actions; shared sign-ins close the page.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ACCOUNT_COLORS, ACCOUNT_COLOR_LABELS, isAccountColor, isNameValid, withoutSignIn } from '../shared/lib/accounts.ts'
import { limitFamily, bindingLimit, PROVIDER_NAMES, windowLabel } from '../shared/lib/providerUsage.ts'
import type { ProviderKind } from '../../../../packages/kybern-client/src/types.ts'
import { goPage } from '../nav/history.ts'
import { N } from '../nav/glyphs.ts'
import { toastProblem } from '../problems/toast.ts'
import { Dialog, Menu, MenuCheckboxItem, MenuItem, MenuSeparator, MenuSub, Tip } from '../nav/overlay.tsx'
import { useNav } from '../nav/store.ts'
import { showDialog } from '../dialogs/store.ts'
import { CloseX, MachineChecks } from '../dialogs/Account.tsx'
import { toast } from '../shell/toasts.tsx'
import { getClient, useApp } from '../state.ts'
import { motion, useGpuix, type PublicInstance } from '@gpuix/react'
import { nativeCapabilities } from '../native/api.ts'
import { EASE } from '../motion/kit.tsx'
import { ink, Label, ProviderMark, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { GlassEdge } from '../kit/GlassEdge.tsx'
import { settingsCardStyle, useGlass } from '../platform/glass.ts'
import { AccountAvatar, AccountDot, AccountUsageRing } from '../usage/AccountMark.tsx'
import { askAccountLimits, setUsageAnchor, updateProviderSettings, useAccountFlash } from '../usage/accounts.ts'
import { Checkbox } from '../kit/Checkbox.tsx'
import { Skeleton } from '../kit/Skeleton.tsx'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { DURATION } from '../motion/tokens.ts'
import { PageBlock, Row, Section, selectOwnsEscape, useSettingsModal } from './controls.tsx'
import { Button } from '../kit/Button.tsx'
import { IconButton } from '../kit/IconButton.tsx'
import { openSettingsTab } from './SettingsScreen.tsx'
import { useSettings } from './store.ts'
import { AccountIdleCompaction } from './Compaction.tsx'
import { idleCompactionDetail } from '../../../../packages/kybern-client/src/compaction.ts'
import { refreshAllAccounts, useAccountsEverywhere, useOffers, type UnifiedView } from '../accounts/store.ts'
import { canStyle, makeDefault, removeFrom, setProfile, shareSignIns, signOutOn, signOutTerminalOn } from '../accounts/actions.ts'
import { listedOffers } from '../accounts/offers.ts'
import { OfferRows } from '../accounts/OfferCard.tsx'
import { chipsFor, usableMachines } from '../accounts/chips.ts'
import { MachineChip, type ChipActions } from '../accounts/MachineChip.tsx'
import { leftOf, standings, type HarnessGroup, type UnifiedAccount } from '../accounts/unified.ts'

/** Skeleton rows fade in after 150 ms (the fade's own `delay`, no timer), so a fast answer never flashes them. */
const SKELETON_DELAY = PATCHED_NATIVE ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { delay: 0.15, duration: DURATION.quick, ease: [0.23, 1, 0.32, 1] as [number, number, number, number] } } : undefined

const list = (names: readonly string[]) => new Intl.ListFormat('en', { style: 'long', type: 'conjunction' }).format(names)

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
  | { kind: 'stop-sharing' }

export function Accounts() {
  const view = useAccountsEverywhere()
  const { offers } = useOffers(view)
  const providers = useNav((s) => s.providers)
  const providersLoaded = useNav((s) => s.providersLoaded)
  const [pending, setPending] = useState<Pending | null>(null)
  useSettingsModal(!!pending)
  // Read every machine's accounts and usage while this tab opens.
  useEffect(() => { void refreshAllAccounts(); askAccountLimits() }, [])
  const here = view.machines[0]!
  const groups = useMemo(() => orderGroups(view, providers.map((p) => p.kind)), [view.groups, view.machines, providers])
  const listed = listedOffers(offers)
  const away = view.machines.filter((m) => !m.online).map((m) => m.name)
  const outdated = view.machines.filter((m) => !m.isLocal && m.online && m.state === 'legacy').map((m) => m.name)
  const missing = providers.filter((p) => !withoutSignIn(p.kind) && view.machines.every((m) => m.providers?.find((x) => x.kind === p.kind)?.available === false))
  const chipActions: ChipActions = {
    signOut: (account, machineId) => setPending({ kind: 'signout', account, machine: machineId }),
    signOutTerminal: (account, machineId, machine) => setPending({ kind: 'terminal', account, machineId, machine }),
  }
  const close = () => setPending(null)
  // A dialog sits in the list item that opened it: one at the end of this long page could be culled by the virtual list.
  const dialogFor = (kind: ProviderKind) => pending && pending.kind !== 'stop-sharing' && pending.account.kind === kind
    ? <AccountDialog pending={pending} view={view} onClose={close} />
    : null
  return <>
    {view.legacy && <PageBlock><div style={{ paddingBottom: 16 }}><Note>{`Update Kybern on ${here.name} to sign in from the app.`}</Note></div></PageBlock>}
    {listed.length > 0 && <OfferRows offers={listed} view={view} />}
    {groups.map((group) => <AgentSection key={group.kind} group={group} view={view} onPending={setPending} chipActions={chipActions}>{dialogFor(group.kind)}</AgentSection>)}
    {!(view.loaded && providersLoaded) && groups.length === 0 && <PageBlock><div testId="accounts-loading" role="status" paintTransform={SKELETON_DELAY} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{[0, 1].map((i) => <Skeleton key={i} height={72} radius={12} />)}</div></PageBlock>}
    {(away.length > 0 || outdated.length > 0 || missing.length > 0) && <PageBlock><div testId="accounts-notes" style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingBottom: 30 }}>
      {away.length > 0 && <Note>{`${list(away)} ${away.length === 1 ? 'is' : 'are'} offline. Accounts there show when ${away.length === 1 ? 'it’s' : 'they’re'} back.`}</Note>}
      {outdated.length > 0 && <Note>{`Update Kybern on ${list(outdated)} to manage accounts there.`}</Note>}
      {missing.length > 0 && <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline' }}><Note>{`${list(missing.map((p) => p.display_name))} ${missing.length === 1 ? 'isn’t' : 'aren’t'} installed. Set them up in `}</Note><TextLink testId="accounts-agent-providers" onClick={() => openSettingsTab('agents')}>Agent providers</TextLink><Note>.</Note></div>}
    </div></PageBlock>}
    {view.sharing && <Section title="Shared sign-ins"><Row title={`${view.sharing.machine} shares its sign-ins`}>
      <Button testId="accounts-stop-sharing-open" size="sm" onClick={() => setPending({ kind: 'stop-sharing' })}>Stop sharing…</Button>
      {pending?.kind === 'stop-sharing' && <ConfirmDialog testId="accounts-stop-sharing" title={`Stop sharing ${view.sharing.machine}’s sign-ins?`} body="Machines that use them ask you to sign in when their current sign-in ends." confirm="Stop sharing" onConfirm={() => shareSignIns(null, view.sharing!.machine)} onClose={close} />}
    </Row></Section>}
  </>
}

function AccountDialog({ pending, view, onClose }: { pending: Exclude<Pending, { kind: 'stop-sharing' }>; view: UnifiedView; onClose: () => void }) {
  switch (pending.kind) {
    case 'remove': return <MachinesDialog mode="remove" account={pending.account} view={view} onClose={onClose} />
    case 'signout': return <MachinesDialog mode="signout" account={pending.account} only={pending.machine} view={view} onClose={onClose} />
    case 'terminal': return <TerminalSignOutDialog account={pending.account} machineId={pending.machineId} machine={pending.machine} onClose={onClose} />
    case 'projects': return <ProjectsDialog account={pending.account} view={view} onClose={onClose} />
  }
}

/** The agents in the order the agent list has them, then any only another machine has. */
function orderGroups(view: UnifiedView, order: ProviderKind[]): HarnessGroup[] {
  const rank = (kind: ProviderKind) => { const i = order.indexOf(kind); return i < 0 ? order.length : i }
  // omp, OpenCode and pi have no account: they are listed only for profiles set up before Kybern stopped offering them.
  return view.groups.filter((group) => group.accounts.length > 0).sort((a, b) => rank(a.kind) - rank(b.kind))
}

function Note({ children }: { children: string }) {
  const t = useTheme()
  return <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}><Label color={t.textSecondary} size={12} lineHeight={19.2}>{children}</Label></div>
}
function TextLink({ children, onClick, testId }: { children: string; onClick: () => void; testId?: string }) {
  const t = useTheme()
  return <div testId={testId} role="button" tabIndex={0} onClick={onClick} onKeyDown={(e) => { if (e.key === 'enter' || e.key === 'space') onClick() }} style={{ display: 'flex', cursor: 'pointer' }}><Label color={t.textSecondary} size={12} lineHeight={19.2} style={{ textDecoration: 'underline' }}>{children}</Label></div>
}

function AgentSection({ group, view, onPending, chipActions, children }: { group: HarnessGroup; view: UnifiedView; onPending: (next: Pending) => void; chipActions: ChipActions; children?: ReactNode }) {
  const t = useTheme()
  const g = useGlass()
  const providers = useNav((s) => s.providers)
  const name = providers.find((p) => p.kind === group.kind)?.display_name ?? PROVIDER_NAMES[group.kind] ?? group.kind
  return <PageBlock><div testId={`accounts-${group.kind}`} style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingBottom: 30 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 2 }}><ProviderMark kind={group.kind} size={14} /><Label color={t.text} size={14} lineHeight={19.6} weight={600}>{name}</Label></div>
    <div style={{ display: 'flex', flexDirection: 'column', ...settingsCardStyle(t, g), overflow: 'hidden' }}><GlassEdge radius={12} color={g.highlight} />
      {group.accounts.map((account, index) => <AccountRow key={account.id} first={index === 0} account={account} view={view} onPending={onPending} chipActions={chipActions} />)}
    </div>
    {children}
  </div></PageBlock>
}

// ── Row ──────────────────────────────────────────────────────────────────────

/** The login this computer uses for the account: its named one, else its terminal one. */
const loginHere = (account: UnifiedAccount, view: UnifiedView) => {
  const here = account.presences.filter((p) => p.machineId === view.primaryId)
  return here.find((p) => !p.terminal) ?? here[0]
}

function AccountRow({ account, first, view, onPending, chipActions }: { account: UnifiedAccount; first: boolean; view: UnifiedView; onPending: (next: Pending) => void; chipActions: ChipActions }) {
  const t = useTheme()
  const here = loginHere(account, view)
  const flash = useAccountFlash(account.kind, here?.instance ?? '')
  const [renaming, setRenaming] = useState(false)
  const settings = useSettings().settings
  const compaction = here ? settings?.providers[account.kind]?.idle_compaction?.[here.instance] : undefined
  const projects = here ? here.projects.length : 0
  const detail = [
    account.email && account.email !== account.name ? account.email : null,
    account.plan,
    account.manualOnly ? 'Only when I choose' : null,
    projects > 0 ? (projects === 1 ? '1 project' : `${projects} projects`) : null,
    compaction ? idleCompactionDetail(compaction) : null,
  ].filter(Boolean).join(' · ')
  const chips = chipsFor(account, view.machines)
  const instance = here && !here.terminal ? here.instance : 'default'
  return <div testId={`account-row-${account.id}`} style={{ position: 'relative', display: 'flex', alignItems: 'flex-start', gap: 12, paddingLeft: 18, paddingRight: 12, paddingTop: 14, paddingBottom: 14, borderTopWidth: first ? 0 : 1, borderColor: t.v('--app-settings-card-border') }}>
    {flash && <FlashOverlay />}
    <AccountAvatar kind={account.kind} color={account.color} instance={account.color ? 'named' : instance} size={32} />
    <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, flexShrink: 1, minWidth: 0, gap: 8 }}>
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 32, justifyContent: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          {renaming ? <RenameField account={account} view={view} onDone={() => setRenaming(false)} /> : <Label color={t.text} size={14} lineHeight={21} weight={500} truncate>{account.name}</Label>}
          {account.isDefault && !renaming && <div testId={`account-default-${account.id}`} style={{ display: 'flex', alignItems: 'center', height: 16, paddingLeft: 4, paddingRight: 4, borderRadius: 4, backgroundColor: t.buttonSecondary, flexShrink: 0 }}><Label color={t.textSecondary} size={11} lineHeight={14} weight={500}>Default</Label></div>}
        </div>
        {detail && <Label color={t.textSecondary} size={13} lineHeight={19.5} truncate>{detail}</Label>}
      </div>
      {chips.length > 0 && <div testId={`account-chips-${account.id}`} style={{ display: 'flex', flexWrap: 'wrap', gap: 6, minWidth: 0 }}>
        {chips.map((chip) => <MachineChip key={chip.machineId} chip={chip} account={account} view={view} actions={chipActions} />)}
      </div>}
    </div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, height: 32, flexShrink: 0 }}>
      <UsageCell account={account} view={view} />
      {/* Signed-out terminal logins are not an account: their chips are all there is to do. */}
      {!view.legacy && !(account.terminalOnly && usableMachines(account).length === 0) && <AccountMenu account={account} view={view} onRename={() => setRenaming(true)} onPending={onPending} />}
    </div>
  </div>
}

/** A row that was just added flashes once as its accent background fades out (`account-row-flash`, 600 ms). */
function FlashOverlay() {
  const t = useTheme()
  if (REDUCED_MOTION) return null
  return <motion.div initial={{ opacity: 1 }} animate={{ opacity: 0 }} transition={{ duration: 0.6, ease: [...EASE.smoothOut] as [number, number, number, number] }} style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, backgroundColor: t.v('--color-background-accent'), pointerEvents: 'none' }} />
}

function RenameField({ account, view, onDone }: { account: UnifiedAccount; view: UnifiedView; onDone: () => void }) {
  const t = useTheme()
  const [draft, setDraft] = useState(account.name)
  const [error, setError] = useState(false)
  const canceled = useRef(false)
  const saving = useRef(false)
  const save = async () => {
    if (canceled.current || saving.current) return
    const name = draft.trim()
    if (name === account.name) return onDone()
    if (!isNameValid(name)) { setError(true); return }
    saving.current = true
    try {
      await setProfile(view, account, { name })
      toast.success(`Renamed to ${name}`)
      onDone()
    } catch (problem) {
      saving.current = false
      toastProblem(problem, { action: 'rename the account' })
    }
  }
  // The desktop selects the whole name on focus and darkens the border to foreground/30.
  const { renderer } = useGpuix()
  const input = useRef<PublicInstance>(null)
  const [focused, setFocused] = useState(false)
  const selectAll = () => { if (renderer && input.current) try { nativeCapabilities(renderer).setInputSelection(input.current.id, 0, draft.length, false) } catch { /* Older addons keep the caret at the end. */ } }
  return <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 }}>
    <input ref={input} testId="account-rename" aria-label={`${account.name} name`} autoFocus value={draft} onFocus={() => { setFocused(true); selectAll() }} onChange={(e) => { setDraft(e.value ?? ''); setError(false) }} onBlur={() => { setFocused(false); void save() }} onSubmit={() => void save()} onKeyDown={(e) => { if (e.key === 'escape') { canceled.current = true; onDone() } }} style={{ width: '100%', height: 28, minWidth: 0, borderWidth: 1, borderColor: error ? t.v('--destructive') : focused ? ink(t, .3) : t.border, borderRadius: 8, paddingLeft: 10, paddingRight: 10, fontSize: 14, color: t.text, backgroundColor: t.inputGroupFill }} />
    {error && <Label color={t.v('--destructive')} size={13} lineHeight={19.5} style={{ marginTop: 4 }}>Enter a name up to 120 characters.</Label>}
  </div>
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
      <AccountUsageRing left={left} />
      <Label color={t.textSecondary} size={12} lineHeight={16} weight={500}>{`${Math.round(left)}%`}</Label>
    </Button>
  </Tip>
}

// ── Menu ─────────────────────────────────────────────────────────────────────

function AccountMenu({ account, view, onRename, onPending }: { account: UnifiedAccount; view: UnifiedView; onRename: () => void; onPending: (next: Pending) => void }) {
  const [open, setOpen] = useState(false)
  useSettingsModal(open)
  const id = account.id
  const here = loginHere(account, view)
  const named = account.presences.filter((p) => !p.terminal)
  const signedIn = named.some((p) => p.online && p.state === 'signed_in' && p.canSignOut)
  const styled = !account.terminalOnly && canStyle(view, account)
  const color = (value: string) => void setProfile(view, account, { color: value }).catch((error) => toastProblem(error, { action: 'change the color' }))
  return <Menu testId={`account-actions-${id}`} align="end" minWidth={208} onOpenChange={setOpen} trigger={() => <IconButton icon={N.ellipsis} label={`${account.name} actions`} active={open} />}>
    {!account.isDefault && <MenuItem id="default" testId={`account-actions-${id}-default`} label="Make default" onSelect={() => void makeDefault(view, account)} />}
    {styled && <MenuItem id="rename" testId={`account-actions-${id}-rename`} label="Rename…" onSelect={onRename} />}
    {styled && <MenuSub id="color" testId={`account-actions-${id}-color`} label="Color">
      {ACCOUNT_COLORS.map((value) => <MenuItem key={value} id={`color-${value}`} testId={`account-actions-${id}-color-${value}`} label={ACCOUNT_COLOR_LABELS[value]} checked={isAccountColor(account.color) && account.color === value} iconNode={<AccountDot color={value} size={8} />} onSelect={() => color(value)} />)}
    </MenuSub>}
    {account.key && <MenuCheckboxItem id="manual" testId={`account-actions-${id}-manual`} label="Only when I choose" checked={account.manualOnly} onCheckedChange={(manual_only) => void setProfile(view, account, { manual_only }).catch((error) => toastProblem(error, { action: 'save that choice' }))} />}
    {here && <MenuItem id="projects" testId={`account-actions-${id}-projects`} label="Use for projects…" onSelect={() => onPending({ kind: 'projects', account })} />}
    {here && <AccountIdleCompaction kind={account.kind} instance={here.instance} testId={`account-actions-${id}-idle-compaction`} />}
    {(signedIn || named.length > 0) && <MenuSeparator />}
    {signedIn && <MenuItem id="sign_out" testId={`account-actions-${id}-sign_out`} label="Sign out…" onSelect={() => onPending({ kind: 'signout', account })} />}
    {named.length > 0 && <MenuItem id="remove" testId={`account-actions-${id}-remove`} label="Remove…" destructive onSelect={() => onPending({ kind: 'remove', account })} />}
  </Menu>
}

// ── Dialogs ──────────────────────────────────────────────────────────────────

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

function TerminalSignOutDialog({ account, machineId, machine, onClose }: { account: UnifiedAccount; machineId: string; machine: string; onClose: () => void }) {
  const agent = PROVIDER_NAMES[account.kind] ?? account.kind
  return <ConfirmDialog testId="account-terminal-signout" title={`Sign out the terminal login on ${machine}?`} body={`${agent} in ${machine}’s own terminal signs out too.`} confirm="Sign out" onConfirm={() => signOutTerminalOn(account.kind, machineId, machine)} onClose={onClose} />
}

/** Remove or sign out: which machines, all ticked. A terminal login is signed out from its own chip, never here. */
function MachinesDialog({ mode, account, only, view, onClose }: { mode: 'remove' | 'signout'; account: UnifiedAccount; only?: string; view: UnifiedView; onClose: () => void }) {
  const eligible = standings({ presences: account.presences.filter((p) => !p.terminal && (mode === 'remove' || (p.state === 'signed_in' && p.canSignOut))) })
  const rows = eligible.map((standing) => ({ machine: { machineId: standing.machineId, name: standing.machine }, blocker: standing.online ? null : 'Offline' }))
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(() => new Set(only ? rows.filter((r) => r.machine.machineId !== only).map((r) => r.machine.machineId) : []))
  const [busy, setBusy] = useState(false)
  const targets = rows.filter((row) => !row.blocker && !unticked.has(row.machine.machineId)).map((row) => row.machine.machineId)
  const managed = account.presences.some((p) => !p.terminal && p.managed && targets.includes(p.machineId))
  const terminals = account.presences.filter((p) => p.terminal && p.state === 'signed_in').map((p) => p.machine)
  const where = view.machines.length > 1 && rows.length === 1 ? ` on ${rows[0]!.machine.name}` : ''
  const body = mode === 'signout' ? undefined
    : [managed ? 'Kybern signs it out and deletes its folder.' : 'Kybern stops using it. Its folder and sign-in stay.', terminals.length ? `The terminal login on ${list(terminals)} stays signed in.` : null].filter(Boolean).join(' ')
  const run = async () => {
    setBusy(true)
    const done = mode === 'remove' ? await removeFrom(account, targets) : await signOutOn(account, targets)
    setBusy(false)
    if (done) onClose()
  }
  return <DialogShell testId={`account-${mode}`} onClose={() => { if (!busy) onClose() }}>
    <DialogText title={mode === 'remove' ? `Remove ${account.name}${where}?` : `Sign out ${account.name}${where}?`} body={body} />
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
