// The Add account sheet: one dialog that picks an agent, a name and the machines, then runs one sign-in per machine
// (`accounts/queue.ts`), each through that machine's own `providers.accounts.login.*` (browser, pasted code, device code or
// a terminal). It also signs one account in again, on this computer or any other machine.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  accountDisplayName,
  accountFor,
  isNameValid,
  loginHost,
  nextFreeColor,
  remoteNote,
  stepFor,
  successDefaults,
  supportsBrowserLogin,
  supportsDeviceCode,
  supportsPasteCode,
  type SheetStep,
} from '../shared/lib/accounts.ts'
import { showDialog } from './store.ts'
import { accountPickerOptions, antigravityAccountsBlocked, type AccountPickerOption } from './accountPicker.ts'
import { ANTIGRAVITY_ACCOUNTS_FEATURE } from '../../../../packages/kybern-client/src/antigravity.ts'
import { PROVIDER_NAMES } from '../shared/lib/providerUsage.ts'
import type { AccountLogin, AccountLoginMode, ProviderKind, ProviderStatus } from '../../../../packages/kybern-client/src/types.ts'
import { Icon } from '../icons.tsx'
import { MatrixLoader } from '../MatrixLoader.tsx'
import { Rise } from '../motion/kit.tsx'
import { N } from '../nav/glyphs.ts'
import { Dialog } from '../nav/overlay.tsx'
import { setNav } from '../nav/store.ts'
import { describe, problemLine } from '../problems/describe.ts'
import { toastProblem } from '../problems/toast.ts'
import { toast } from '../shell/toasts.tsx'
import { plainSentence, type ProblemView } from '../../../../packages/kybern-client/src/problems.ts'
import { useNav } from '../nav/store.ts'
import { Button } from '../kit/Button.tsx'
import { Checkbox } from '../kit/Checkbox.tsx'
import { IconButton } from '../kit/IconButton.tsx'
import { TextField } from '../kit/Field.tsx'
import { useControls } from '../kit/controls.ts'
import { StatusChip } from '../kit/StatusChip.tsx'
import { Chevron } from '../motion/Chevron.tsx'
import { Switch } from '../kit/Switch.tsx'
import { openExternal, pickFolder } from '../settings/external.ts'
import { S } from '../settings/glyphs.ts'
import { profileById } from '../environments/registry.ts'
import { activeEnvironment } from '../shell/environment.ts'
import { copyText } from '../transcript/store.ts'
import { Screen as TerminalScreen } from '../terminal/Terminal.tsx'
import { getClient } from '../state.ts'
import { ink, Label, ProviderMark, useTheme } from '../ui.tsx'
import { FONT_MONO } from '../theme.ts'
import { AccountAvatar } from '../usage/AccountMark.tsx'
import { flashAccount, refreshAccounts, useAccounts, useAccountsLegacy } from '../usage/accounts.ts'
import { useAccountLogin } from './useAccountLogin.ts'
import { SuccessCheck } from '../motion/SuccessCheck.tsx'
import { advance, awaitsKeep, fallbackModeFor, isOneAccount, loginModeFor, makesDefault, mismatch, needsAccountsUpdate, planAdd, resolvedItem, signInHereAction, signInNeedsUpdate, startQueue, updateLine, type ItemResult, type QueueState, type Settled, type SignInItem } from '../accounts/queue.ts'
import { clientOf, computerId, infoOf, readMachine, refreshAllAccounts, refreshOfferInputs, useAccountsEverywhere, type UnifiedView } from '../accounts/store.ts'
import { borrow, discardBorrow, makeDefault, stopBorrowing, updateMachine } from '../accounts/actions.ts'
import { canHandoff, featuresOf, handoffSignIn } from '../accounts/adapter.ts'
import type { MachineAccounts } from '../accounts/unified.ts'

const TERMINAL_COPY: Partial<Record<ProviderKind, string>> = {
  opencode: 'OpenCode asks for an API key. Paste it into the prompt below.',
  pi: 'Pi asks which provider to sign in to. Follow its prompts below.',
  antigravity: 'Antigravity opens your browser to finish signing in with Google. Kybern checks the sign-in when it finishes.',
}

/** How long a waiting sign-in may take to say it waits for a redirect before a code is used instead. */
const HANDOFF_WAIT_MS = 4000

/** A named Antigravity account's terminal runs `agy acp --login`, which prints a link and reads the code back. */
const NAMED_ANTIGRAVITY_TERMINAL_COPY = 'Open the Google link below, then paste the code from Google’s page into the terminal.'

const agentName = (providers: readonly ProviderStatus[], kind: ProviderKind) => providers.find((p) => p.kind === kind)?.display_name ?? PROVIDER_NAMES[kind] ?? kind

export function Account({ close, provider, instance, named = false, items }: { close: () => void; provider?: ProviderKind; instance?: string; named?: boolean; items?: SignInItem[] }) {
  const view = useAccountsEverywhere()
  const here = view.machines[0]!
  // A single-account sign-in opened directly: Grok Build, a named Antigravity account, or an account being signed in
  // again. None of them needs the pick step. Antigravity's own login on this computer is signed in only through items
  // that name it (`ownLogin`, from "this computer's terminal login"); anything else adds a new account.
  const direct = (): SignInItem[] | null => {
    if (items?.length) return items
    if (!provider) return null
    const base = { machineId: here.machineId, machine: here.name, kind: provider, method: 'sign_in' as const }
    if (instance && !(provider === 'antigravity' && instance === 'default')) return [{ ...base, id: `${here.machineId}:${provider}:${instance}`, instance }]
    if (named) return [{ ...base, id: `${here.machineId}:${provider}:new`, named: true }]
    if (provider === 'grok-build') return [{ ...base, id: `${here.machineId}:${provider}:own` }]
    return null
  }
  const [queue, setQueue] = useState<SignInItem[] | null>(direct)
  if (queue) return <QueueDialog key={queue.map((item) => item.id).join(',')} initial={queue} view={view} close={close} />
  return <PickDialog view={view} initialKind={provider} close={close} start={setQueue} />
}

// ── Pick the agent, the name and the machines ────────────────────────────────

/** Why a machine can't take a new sign-in of this agent, or null when it can. */
export function machineBlocker(machine: MachineAccounts, kind: ProviderKind | undefined, computer: string | null): string | null {
  if (!machine.online) return 'Offline'
  if (machine.state === 'legacy' || signInNeedsUpdate(machine, computer)) return UPDATE_NEEDED
  if (!kind) return null
  const status = machine.providers?.find((p) => p.kind === kind)
  if (status && !status.available) return 'Not installed'
  // Adding Antigravity always makes a named account, which older daemons can't.
  if (kind === 'antigravity' && machine.state === 'ready' && !machine.features.includes(ANTIGRAVITY_ACCOUNTS_FEATURE)) return UPDATE_NEEDED
  return null
}

const UPDATE_NEEDED = 'Update needed'

/** "Update" from the machines list: ask that machine to update and say how it went. */
function startUpdate(machine: { machineId: string; name: string }) {
  void updateMachine(machine.machineId).then(
    (update) => { toast(updateLine(update, machine.name)) },
    (error) => { toastProblem(error, { action: `update Kybern on ${machine.name}` }) },
  )
}

function PickDialog({ view, initialKind, close, start }: { view: UnifiedView; initialKind?: ProviderKind; close: () => void; start: (items: SignInItem[]) => void }) {
  const primaryProviders = useNav((s) => s.providers)
  const environment = activeEnvironment()
  const remote = !environment.local
  const [kind, setKind] = useState<ProviderKind | undefined>(initialKind)
  const [folder, setFolder] = useState('')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [name, setName] = useState('')
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set())
  const computer = computerId()
  // An agent installed on any machine can be added; the machines list says where.
  const providers = useMemo(() => primaryProviders.map((p) => (p.available || !view.machines.some((m) => m.providers?.some((x) => x.kind === p.kind && x.available)) ? p : { ...p, available: true })), [primaryProviders, view.machines])
  // Adding Antigravity makes a named account, which a daemon from before them can't.
  const info = getClient()?.info
  const blocked = antigravityAccountsBlocked(!info || !!info.features?.includes(ANTIGRAVITY_ACCOUNTS_FEATURE), environment.name)
  const several = view.machines.length > 1
  const pickerOptions = useMemo(() => accountPickerOptions(providers, several ? undefined : blocked), [providers, blocked, several])
  const selected = kind ? pickerOptions.find((p) => p.kind === kind) : undefined
  const rows = view.machines.map((machine) => ({ machine, blocker: machineBlocker(machine, kind, computer) }))
  const targets = rows.filter((row) => !row.blocker && !unticked.has(row.machine.machineId)).map((row) => row.machine)
  const nameOk = !name.trim() || isNameValid(name)
  const ready = !!selected && selected.available && !selected.disabled && (!several || targets.length > 0) && nameOk
  const choose = (next: ProviderKind) => {
    const option = pickerOptions.find((p) => p.kind === next)
    if (option?.disabled) return
    if (option && !option.available) { setNav({ settingsOpen: true }); close(); void import('../settings/SettingsScreen.tsx').then((m) => m.openSettingsTab('agents')); return }
    setKind(next)
  }
  const go = () => {
    if (!kind || !ready) return
    const machines = several ? targets : [view.machines[0]!]
    const items = planAdd({ kind, name, machines, computer, ...(folder.trim() ? { directory: folder.trim() } : {}) })
    if (kind !== 'antigravity') return start(items)
    showDialog({ kind: 'account', provider: 'antigravity', items })
  }
  return <Dialog onClose={close} width={448} testId="add-account">
    <PickStep providers={pickerOptions} kind={selected?.disabled ? undefined : kind} onKind={choose} folder={folder} onFolder={setFolder} advancedOpen={advancedOpen} onAdvancedOpen={setAdvancedOpen} remote={remote}>
      {kind && kind !== 'antigravity' && <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <FieldLabel>Name</FieldLabel>
        <TextField testId="account-name" label="Name" size="lg" placeholder="Same as the email" invalid={!nameOk} value={name} onChange={setName} width="100%" onSubmit={go} />
        {!nameOk && <ErrorLabel>Use up to 120 characters.</ErrorLabel>}
      </div>}
      {kind && several && <MachineChecks rows={rows} unticked={unticked} onToggle={(id) => setUnticked((prev) => toggled(prev, id))} onUpdate={startUpdate} />}
    </PickStep>
    <Footer>
      <Button size="lg" testId="account-cancel" variant="ghost" onClick={close}>Cancel</Button>
      <Button size="lg" testId="account-start" variant="primary" disabled={!ready} onClick={go}>{kind && !several && !remote && supportsBrowserLogin(kind) ? 'Continue in browser' : 'Continue'}</Button>
    </Footer>
    <CloseX onClose={close} />
  </Dialog>
}

const toggled = (set: ReadonlySet<string>, id: string) => { const next = new Set(set); if (next.has(id)) next.delete(id); else next.add(id); return next }

export function MachineChecks({ rows, unticked, onToggle, onUpdate }: { rows: readonly { machine: Pick<MachineAccounts, 'machineId' | 'name'>; blocker: string | null }[]; unticked: ReadonlySet<string>; onToggle: (machineId: string) => void; onUpdate?: (machine: { machineId: string; name: string }) => void }) {
  const t = useTheme()
  return <div testId="account-machines" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
    <FieldLabel>Machines</FieldLabel>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 180, overflowY: 'scroll', marginLeft: -8, marginRight: -8 }}>
      {rows.map(({ machine, blocker }) => {
        const checked = !blocker && !unticked.has(machine.machineId)
        const toggle = () => { if (!blocker) onToggle(machine.machineId) }
        return <div key={machine.machineId} testId={`account-machine-${machine.machineId}`} role="checkbox" aria-checked={checked} aria-disabled={!!blocker || undefined} aria-label={machine.name} tabIndex={blocker ? -1 : 0} onClick={toggle} onKeyDown={(e) => { if (e.key === 'enter' || e.key === 'space') toggle() }}
          style={{ display: 'flex', alignItems: 'center', gap: 10, height: 32, paddingLeft: 8, paddingRight: 8, borderRadius: 8, cursor: blocker ? 'default' : 'pointer', ...(blocker ? {} : { hover: { backgroundColor: t.hover } }) }}>
          <Checkbox checked={checked} disabled={!!blocker} aria-label={machine.name} style={{ pointerEvents: 'none' }} />
          <Label color={blocker ? t.textTertiary : t.text} size={14} lineHeight={21} truncate style={{ flexGrow: 1 }}>{machine.name}</Label>
          {blocker && <Label color={t.textTertiary} size={13} lineHeight={19.5}>{blocker}</Label>}
          {blocker === UPDATE_NEEDED && onUpdate && <Button testId={`account-update-${machine.machineId}`} size="sm" label={`Update Kybern on ${machine.name}`} onClick={() => onUpdate(machine)}>Update</Button>}
        </div>
      })}
    </div>
  </div>
}

// ── The queue ────────────────────────────────────────────────────────────────

/** Esc, the close button and the backdrop all arrive at the step on screen, which cancels or saves its sign-in. */
type Dismiss = { current: () => void }

function QueueDialog({ initial, view, close }: { initial: SignInItem[]; view: UnifiedView; close: () => void }) {
  const [queue, setQueue] = useState(() => startQueue(initial))
  const dismissStep = useRef<() => void>(() => {})
  const closed = useRef(false)
  const dismiss = () => {
    if (closed.current) return
    closed.current = true
    dismissStep.current()
    close()
  }
  const item = resolvedItem(queue)
  const result = (outcome: ItemResult, settled?: Settled) => setQueue((current) => advance(current, outcome, settled))
  // Nothing was signed in and nothing to report: leave.
  const nothing = !item && Object.values(queue.results).every((r) => r === 'skipped')
  useEffect(() => { if (nothing) dismiss() }, [nothing])
  return <Dialog onClose={dismiss} width={448} testId="add-account">
    {queue.items.length > 1 && <Progress queue={queue} />}
    {item
      ? <ItemStep key={item.id} item={item} view={view} multiple={queue.items.length > 1} onResult={result} dismiss={dismissStep} close={() => { closed.current = true; close() }} />
      : !nothing && <Summary queue={queue} view={view} dismiss={dismissStep} close={dismiss} />}
    <CloseX onClose={dismiss} />
  </Dialog>
}

/** What each step is called in the progress strip: the machine, or the account when one machine gets several. */
const stepName = (items: readonly SignInItem[], item: SignInItem) =>
  items.every((other) => other.machineId === item.machineId) ? item.name ?? item.email ?? PROVIDER_NAMES[item.kind] ?? item.kind : item.machine

const RESULT_WORDS: Record<ItemResult, string> = { signed_in: 'Signed in', already: 'Already signed in', borrowed: 'Signed in', skipped: 'Skipped', failed: 'Not signed in' }

function Progress({ queue }: { queue: QueueState }) {
  const t = useTheme()
  const c = useControls()
  return <div testId="account-progress" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, paddingLeft: 16, paddingRight: 48, paddingTop: 14 }}>
    {queue.items.map((item, index) => {
      const done = queue.results[item.id]
      const current = index === queue.index
      const ok = done && done !== 'skipped' && done !== 'failed'
      return <StatusChip key={item.id} testId={`account-progress-${index}`} tone={ok ? 'success' : 'neutral'}
        lead={ok ? <Icon source={N.check} size={14} color={t.v('--success')} /> : current ? <div style={{ width: 14, height: 14, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><div style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.accent }} /></div> : undefined}>
        {stepName(queue.items, item)}
      </StatusChip>
    })}
  </div>
}

interface StepProps { item: SignInItem; view: UnifiedView; multiple: boolean; onResult: (result: ItemResult, settled?: Settled) => void; dismiss: Dismiss; close: () => void }

/** One machine's step. A machine that must update before it takes the sign-in says so and offers the update; the
 *  sign-in starts once it has. */
function ItemStep(props: StepProps) {
  const { item, view } = props
  const computer = computerId()
  const info = infoOf(item.machineId)
  const machine = view.machines.find((m) => m.machineId === item.machineId)
  // A machine that is away says so instead: nothing can ask it to update.
  const outdated = item.machineId !== computer && machine?.online !== false && (info ? needsAccountsUpdate(info) : signInNeedsUpdate(machine, computer))
  // Held while the machine restarts, when nothing is known about it for a moment.
  const [held, setHeld] = useState(outdated)
  if (outdated && !held) setHeld(true)
  if (held && info && !needsAccountsUpdate(info)) setHeld(false)
  // "Try again" on a machine that couldn't be reached starts the step over.
  const [attempt, setAttempt] = useState(0)
  return outdated || held ? <UpdateStep {...props} /> : <SignInStep key={attempt} {...props} reconnect={() => setAttempt((n) => n + 1)} />
}

function UpdateStep({ item, multiple, onResult, dismiss, close }: StepProps) {
  const [asking, setAsking] = useState(false)
  const [line, setLine] = useState<string | null>(null)
  dismiss.current = () => {}
  const update = () => {
    setAsking(true)
    void updateMachine(item.machineId)
      .then((result) => setLine(updateLine(result, item.machine)), (error) => setLine(problemLine(error, { action: `update Kybern on ${item.machine}` })))
      .finally(() => setAsking(false))
  }
  return <>
    <Rise key="update" kind="row"><Body align="center" top={16} gap={8}>
      <AccountAvatar kind={item.kind} size={32} />
      <Title center>{`Update Kybern on ${item.machine}`}</Title>
      <Desc center testId="account-update-line">{line ?? 'It runs an older Kybern that can’t take sign-ins from here.'}</Desc>
    </Body></Rise>
    <Footer>
      <Button size="lg" testId="account-cancel" variant="ghost" onClick={close}>Cancel</Button>
      {multiple && <Button size="lg" testId="account-skip" variant="ghost" onClick={() => onResult('skipped')}>Skip</Button>}
      <Button size="lg" testId="account-update" variant="primary" busy={asking} disabled={asking} onClick={update}>Update</Button>
    </Footer>
  </>
}

function SignInStep({ item, view, multiple, onResult, dismiss, close, reconnect }: StepProps & { reconnect: () => void }) {
  const t = useTheme()
  const providers = useNav((s) => s.providers)
  const legacyDaemon = useAccountsLegacy()
  const [client] = useState(() => { try { return clientOf(item.machineId) } catch { return null } })
  const computer = computerId()
  const machine = view.machines.find((m) => m.machineId === item.machineId)
  const kind = item.kind
  const remote = item.machineId !== computer
  // "Authorize only": this computer's daemon catches the redirect for the other machine. A code is the fallback.
  const [handoff, setHandoff] = useState(() => remote && !item.ownLogin && canHandoff(kind, computer ? featuresOf(getClient()) : null, machine?.features ?? []))
  const api = useAccountLogin(client, { openPage: !handoff })
  const apiRef = useRef(api)
  useEffect(() => { apiRef.current = api })
  const { login, failure } = api
  const local = item.machineId === view.primaryId
  const legacy = local && legacyDaemon
  const environment = activeEnvironment()
  const transport: 'SSH' | 'Tailscale' = local && !environment.local && profileById(environment.id).ssh ? 'SSH' : 'Tailscale'
  const accounts = machine?.accounts ?? []
  const agent = agentName(providers, kind)
  const reauth = !!item.instance && item.instance !== 'default'
  const antigravityNamed = kind === 'antigravity' && (!!item.named || reauth)
  /** The agent's own login (the terminal login, this computer's `agy`, Grok Build): there is nothing to name or finish. */
  const own = !!item.ownLogin || item.instance === 'default' || kind === 'grok-build'
  const target = reauth ? accountFor(accounts, kind, item.instance) : undefined
  const [method, setMethod] = useState(item.method)
  const targetName = item.name ?? (reauth ? accountDisplayName(item.instance, target?.name) : agent)
  /** A borrow that failed: the problem's words, and signing this machine in itself. */
  const [borrowError, setBorrowError] = useState<{ view: ProblemView; action: string } | null>(null)
  const [unbindError, setUnbindError] = useState<ProblemView | null>(null)
  const [finishError, setFinishError] = useState<string | null>(null)
  const [otherEmail, setOtherEmail] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [codeShown, setCodeShown] = useState(false)
  // A code is single use: each refusal clears the field, like the desktop's remounted input.
  useEffect(() => { setCode('') }, [api.wrongCodes])

  const startLogin = async (patch: { mode?: AccountLoginMode } = {}) => {
    setFinishError(null); setOtherEmail(null); setUnbindError(null)
    try { await stopBorrowing(view, item) } catch (error) { setUnbindError(describe(error, { action: `sign in on ${item.machine}` })); return }
    const mode = patch.mode ?? loginModeFor(item, remote, handoff)
    if (reauth && legacy) { await api.signInLegacy({ kind, instance: item.instance! }); return }
    await api.start({
      kind,
      mode,
      // This computer's own `agy` login is `default`, named explicitly: the daemon never assumes it.
      ...(item.ownLogin ? { instance: 'default' } : item.instance ? { instance: item.instance } : {}),
      // `named` keeps a new Antigravity account apart from the computer's own login, in a terminal too.
      ...(!reauth && antigravityNamed ? { named: true } : {}),
      ...(!reauth && !own && item.directory ? { directory: item.directory } : {}),
    })
  }
  /** The borrow under way: closing or skipping before it is bound cancels it. */
  const borrowing = useRef<AbortController | null>(null)
  const startBorrow = () => {
    setBorrowError(null)
    const attempt = new AbortController()
    borrowing.current = attempt
    const settled = () => { if (borrowing.current === attempt) borrowing.current = null }
    void borrow(view, item, clientOf, attempt.signal).then(() => {
      settled()
      if (!attempt.signal.aborted) onResult('borrowed', { email: item.email })
    }, (error) => {
      settled()
      if (attempt.signal.aborted) return
      const problem = describe(error, { action: `use ${item.lender?.machine}’s sign-in` })
      setBorrowError({ view: problem, action: signInHereAction(error, problem, item.machine).label })
    })
  }

  const started = useRef(false)
  useEffect(() => {
    if (started.current || !client) return
    started.current = true
    if (method === 'borrow') startBorrow()
    else void startLogin()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** The shared preferences as they stand now, or null when they can't be read. */
  const sharedNow = async () => {
    const own = getClient()
    if (!view.supportsShared || !own) return view.shared
    try { return (await own.call('settings.get', {})).accounts_shared ?? {} } catch { return null }
  }
  /** The values a finished new sign-in is saved with. */
  const finishValues = async (done: AccountLogin) => {
    const suggested = successDefaults(done, accounts.filter((a) => a.provider.kind === kind).map((a) => a.color))
    const name = item.name?.trim() || done.identity?.email || suggested.name
    const color = item.color ?? suggested.color ?? nextFreeColor(accounts.map((a) => a.color))
    // The first account a machine can use becomes the default, unless every machine already shares one.
    const shared = await sharedNow()
    return { name, color, make_default: !!shared && makesDefault(accounts, kind, shared) }
  }
  // `handled`: the finished sign-in was looked at; `kept`: it is saved (or being saved), so closing leaves it.
  const handled = useRef<string | null>(null)
  const kept = useRef(false)
  const save = async (finished: AccountLogin) => {
    const values = await finishValues(finished)
    const result = await client!.call('providers.accounts.login.finish', { id: finished.id, ...values })
    if (local) flashAccount(result.kind, result.instance)
    return values
  }
  /** Read the signed-in machine again (and the offers, which the sign-in may have answered). */
  const reread = async () => { void refreshOfferInputs(); await (local ? refreshAccounts({ probe: true }) : readMachine(item.machineId, { probe: true })) }
  /** Nothing to save: the agent's own login, or an account signed in again. */
  const alreadySaved = (finished: AccountLogin) => own || !!finished.instance
  /** "Keep" on an account signed in again as someone else: its machine saves nothing until it is told to. The account
   *  keeps its name and colour. */
  const keep = async (finished: AccountLogin) => {
    const result = await client!.call('providers.accounts.login.finish', { id: finished.id, name: target?.name ?? targetName, color: target?.color ?? item.color ?? null, make_default: false })
    if (local) flashAccount(result.kind, result.instance)
    return { name: item.name, color: item.color }
  }
  const settle = async (finished: AccountLogin) => {
    const email = finished.identity?.email
    if (finished.duplicate_of && !reauth) return onResult('already', { email })
    kept.current = true
    const held = awaitsKeep(finished, infoOf(item.machineId)?.version)
    if (held || (!reauth && !alreadySaved(finished))) {
      try {
        const values = held ? await keep(finished) : await save(finished)
        void reread()
        return onResult('signed_in', { email, name: values.name, color: values.color })
      } catch (error) {
        kept.current = false
        // Daemon errors already say what to do next (the name check says "Enter a name…").
        return setFinishError(problemLine(error, { action: 'save the account' }))
      }
    }
    void reread()
    onResult('signed_in', { email, name: item.name, color: item.color })
  }

  useEffect(() => {
    if (login?.phase !== 'signed_in' || handled.current === login.id) return
    handled.current = login.id
    // The browser was signed in to someone else: ask before saving it as this account.
    const other = mismatch({ email: item.email ?? (reauth ? login.previous_email : undefined) }, login)
    if (other && !(login.duplicate_of && !reauth)) setOtherEmail(other)
    else void settle(login)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [login?.phase, login?.id])

  // An older daemon has no login record: its sign-in ends when the terminal's process exits.
  const legacyId = api.legacyTerminal?.id
  useEffect(() => {
    if (!legacyId || !client) return
    return client.onNotification('terminal.exited', (params) => { if ((params as { terminal_id?: string }).terminal_id === legacyId) { void reread(); onResult('signed_in') } })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legacyId])

  // Closing cancels a running sign-in; one that already succeeded is saved, because signing in counted as consent.
  const leaving = useRef({ login, otherEmail })
  useEffect(() => { leaving.current = { login, otherEmail } })
  const abandoned = useRef(false)
  const abandon = () => {
    if (abandoned.current || kept.current) return
    abandoned.current = true
    if (method === 'borrow') {
      // Under way: cancelling it takes its account away. Failed: so does this, if it couldn't then.
      if (borrowing.current) borrowing.current.abort()
      else void discardBorrow(item)
    }
    const { login: current, otherEmail: other } = leaving.current
    const finished = current?.phase === 'signed_in' ? current : null
    if (finished && alreadySaved(finished) && !other) return
    if (client && finished && !alreadySaved(finished) && !finished.duplicate_of && !other && handled.current !== finished.id) {
      void save(finished).then(reread, (error) => toastProblem(error, { action: 'save the account', goal: 'save the account' }))
    } else void apiRef.current.cancel()
  }
  dismiss.current = abandon
  // Unmounting from outside (a machine going away) still cancels a running sign-in.
  useEffect(() => () => abandon(), [])

  const skip = () => { abandon(); onResult('skipped') }
  const cancel = () => { abandon(); close() }
  const footerLead = <><Button size="lg" testId="account-cancel" variant="ghost" onClick={cancel}>Cancel</Button>{multiple && <Button size="lg" testId="account-skip" variant="ghost" onClick={skip}>Skip</Button>}</>

  // The authorize page this computer's browser has open, once "Authorize" was pressed.
  const [authorizing, setAuthorizing] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  /** The login whose redirect this computer is catching, so its port can be let go with it. */
  const handedOff = useRef<string | null>(null)
  const releaseHandoff = () => {
    const id = handedOff.current
    if (!id) return
    handedOff.current = null
    void getClient()?.call('providers.accounts.login.handoff.cancel', { login_id: id }).catch(() => { /* an older daemon lets go by itself */ })
  }
  /** The running sign-in a handoff is for. */
  const catching = handoff && login && !api.lost && (login.phase === 'starting' || login.phase === 'waiting' || login.phase === 'verifying') ? login.id : null
  const stillCatching = useRef(catching)
  stillCatching.current = catching
  // It ended, started over or switched to a code, or the sheet closed.
  useEffect(() => releaseHandoff, [catching])
  /** Handoff off, and the same sign-in again with a code to paste or enter. */
  const useCode = () => { setHandoff(false); setAuthorizing(null); void api.restart({ mode: fallbackModeFor(kind) }) }
  const authorize = async () => {
    const own = computer ? getClient() : null
    if (!own || !login) return
    setAsking(true)
    try {
      const { url } = await handoffSignIn(own, { machine_id: item.machineId, login_id: login.id })
      handedOff.current = login.id
      // The sheet closed, or this sign-in ended, while this computer was getting ready.
      if (abandoned.current || stillCatching.current !== login.id) return releaseHandoff()
      setAuthorizing(url)
      await openExternal(url)
    } catch {
      // The port is busy here, or the sign-in moved on: a code does the same job.
      useCode()
    } finally { setAsking(false) }
  }
  // A harness that doesn't wait for a redirect after all: don't leave "Authorize" greyed out.
  const stalled = handoff && login?.phase === 'waiting' && !!login.url && !login.handoff
  useEffect(() => {
    if (!stalled) return
    const timer = setTimeout(useCode, HANDOFF_WAIT_MS)
    return () => clearTimeout(timer)
  }, [stalled, login?.id])

  const showTerminal = () => { setHandoff(false); void api.restart({ mode: 'terminal' }) }
  const tryAgain = () => { handled.current = null; if (method === 'borrow') startBorrow(); else if (!login || (reauth && legacy)) void startLogin(); else void api.retry() }
  const signInInstead = () => { void discardBorrow(item); setMethod('sign_in'); void startLogin() }

  const step: SheetStep | null = failure || api.lost ? 'error' : api.legacyTerminal ? 'terminal' : stepFor(login)
  const verifying = login?.phase === 'verifying'
  const onMachine = item.machineId === computerId() ? '' : ` on ${item.machine}`

  let body: ReactNode
  let footer: ReactNode = footerLead
  if (!client) {
    body = <ErrorBody title={`${item.machine} is offline`} message="Try again when it’s back." />
    footer = <>{footerLead}<Button size="lg" testId="account-retry" variant="primary" onClick={reconnect}>Try again</Button></>
  } else if (method === 'borrow') {
    body = borrowError
      ? <ErrorBody title={borrowError.view.title} message={borrowError.view.body} />
      : <Body align="center" top={20}><MatrixLoader variant="orbit" dot={3} gap={2} /><Title center>{`Using ${item.lender?.machine}’s sign-in on ${item.machine}…`}</Title></Body>
    footer = <>{footerLead}{borrowError && <><Button size="lg" testId="account-retry" onClick={tryAgain}>Try again</Button><Button size="lg" testId="account-sign-in-instead" variant="primary" onClick={signInInstead}>{borrowError.action}</Button></>}</>
  } else if (unbindError) {
    body = <ErrorBody title={unbindError.title} message={unbindError.body} />
    footer = <>{footerLead}<Button size="lg" testId="account-retry" variant="primary" onClick={() => void startLogin()}>Try again</Button></>
  } else if (otherEmail && login) {
    // An account that is already added can't be kept a second time: only another sign-in helps.
    const addedAs = login.duplicate_of ? (login.duplicate_of === 'default' ? 'the terminal login' : accountDisplayName(login.duplicate_of, accountFor(accounts, kind, login.duplicate_of)?.name)) : null
    body = <Body align="center" top={16} gap={8}>
      <AccountAvatar kind={kind} size={32} />
      <Title center>{`${item.machine} signed in as ${otherEmail}`}</Title>
      <Desc center>{addedAs ? `It’s already added as ${addedAs}.` : item.email ? `This sign-in is for ${item.email}.` : `${targetName} was ${login.previous_email}.`}</Desc>
    </Body>
    footer = <>{footerLead}{!addedAs && <Button size="lg" testId="account-keep" onClick={() => { setOtherEmail(null); void settle(login) }}>Keep</Button>}<Button size="lg" testId="account-retry" variant="primary" onClick={() => { handled.current = null; setOtherEmail(null); void api.restart({}) }}>Try again</Button></>
  } else if (finishError) {
    body = <ErrorBody title="Couldn’t save the account" message={finishError} />
    footer = <>{footerLead}{login && <Button size="lg" testId="account-retry" variant="primary" onClick={() => { setFinishError(null); void settle(login) }}>Try again</Button>}</>
  } else if (handoff && login && (step === 'waiting' || step === null)) {
    body = <Body align="center" top={20}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}><AccountAvatar kind={kind} size={32} instance={item.instance ?? 'new'} color={item.color ?? target?.color} />{authorizing && <MatrixLoader variant="orbit" dot={3} gap={2} />}</div>
      <Title center>{authorizing ? 'Finish signing in in your browser' : `Sign in to ${agent} on ${item.machine}`}</Title>
      {item.email && <Desc center>{item.email}</Desc>}
      {verifying && <Checking />}
      {!authorizing && <Button size="lg" testId="account-authorize" variant="primary" busy={asking} disabled={asking || !login.handoff} onClick={() => void authorize()}>Authorize</Button>}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, marginTop: 4 }}>
        {authorizing && <QuietLink testId="account-reopen" onClick={() => void openExternal(authorizing).catch((e) => toastProblem(e, { action: 'open the sign-in page' }))}>Open browser again</QuietLink>}
        <QuietLink testId="account-code-instead" onClick={useCode}>{supportsDeviceCode(kind) ? 'Use a code instead' : 'Paste code instead'}</QuietLink>
      </div>
    </Body>
  } else if (step === 'waiting' && login) {
    const url = loginHost(login.url)
    const canCode = supportsPasteCode(kind) || supportsDeviceCode(kind)
    const codeMode: AccountLoginMode = supportsDeviceCode(kind) ? 'device_code' : 'paste'
    body = <Body align="center" top={20}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}><AccountAvatar kind={kind} size={32} instance={item.instance ?? 'new'} color={item.color ?? target?.color} /><MatrixLoader variant="orbit" dot={3} gap={2} /></div>
      <Title center>{reauth ? `Sign in again to ${targetName}${onMachine}` : 'Finish signing in in your browser'}</Title>
      {url && <Desc center>{`We opened ${url}. Come back here when you’re done.`}</Desc>}
      {verifying && <Checking />}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, marginTop: 4 }}>
        {login.url && <QuietLink testId="account-reopen" onClick={() => void openExternal(login.url!).catch((e) => toastProblem(e, { action: 'open the sign-in page' }))}>Open browser again</QuietLink>}
        {canCode && <QuietLink testId="account-code-instead" onClick={() => void api.restart({ mode: codeMode })}>{supportsDeviceCode(kind) ? 'Use a code instead' : 'Paste code instead'}</QuietLink>}
        <QuietLink testId="account-show-terminal" onClick={showTerminal}>Having trouble? Show terminal</QuietLink>
      </div>
    </Body>
  } else if (step === 'paste' && login) {
    const sending = api.codeState === 'sending' || verifying
    const submit = () => { if (code.trim() && !sending) void api.submitCode(code) }
    body = <PasteStep title={multiple || remote ? `Paste ${item.machine}’s sign-in code` : 'Paste the sign-in code'} login={login} remote={remote} host={item.machine} transport={transport} wrong={api.codeState === 'wrong'} unsent={api.codeState === 'unsent'} code={code} onCode={setCode} shown={codeShown} onShown={setCodeShown} onSubmit={submit} onTerminal={showTerminal} />
    footer = <>{footerLead}<Button size="lg" testId="account-paste-submit" variant="primary" busy={sending} disabled={sending} onClick={submit}>Sign in</Button></>
  } else if (step === 'device' && login) {
    const url = loginHost(login.url)
    body = <Body gap={12}>
      <Title pe>{`Enter this code to sign in${onMachine}`}</Title>
      {remote && <RemoteNote host={item.machine} transport={transport} />}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, paddingLeft: 16, paddingRight: 16, paddingTop: 20, paddingBottom: 20, borderWidth: 1, borderColor: t.border, borderRadius: 12 }}>
        {login.user_code ? <Label color={t.text} size={30} lineHeight={30} weight={500} font={FONT_MONO}>{login.user_code}</Label> : <div style={{ width: 192, height: 32, borderRadius: 6, backgroundColor: t.buttonSecondary }} />}
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 8 }}>
          {login.user_code && <CopyButton text={login.user_code} label="Copy code" />}
          {login.url && <Button testId="account-open-page" icon={S.externalLink} onClick={() => void openExternal(login.url!)}>{`Open ${url ?? 'sign-in page'}`}</Button>}
        </div>
      </div>
      <Label color={t.textSecondary} size={13} lineHeight={19.5} style={{ textAlign: 'center' }}>The code expires in 15 minutes.</Label>
      {verifying && <Checking />}
      <div style={{ display: 'flex', justifyContent: 'center' }}><QuietLink testId="account-show-terminal" onClick={showTerminal}>Having trouble? Show terminal</QuietLink></div>
    </Body>
  } else if (step === 'terminal') {
    const info = api.legacyTerminal ?? login?.terminal
    body = <Body gap={12}>
      <Title pe>{`Finish in the terminal${onMachine}`}</Title>
      <Desc>{(antigravityNamed ? NAMED_ANTIGRAVITY_TERMINAL_COPY : TERMINAL_COPY[kind]) ?? `Follow ${agent}’s prompts below. Kybern checks the sign-in when it finishes.`}</Desc>
      {legacy && <Label color={t.textSecondary} size={13} lineHeight={19.5}>{`Update Kybern on ${item.machine} to sign in from the browser.`}</Label>}
      <div testId="account-terminal" style={{ display: 'flex', flexDirection: 'column', height: 256, minWidth: 0, borderWidth: 1, borderColor: t.border, borderRadius: 8, overflow: 'hidden' }}>
        {info ? <TerminalScreen key={info.id} info={info} width={382} {...(local ? {} : { machineId: item.machineId })} /> : <div style={{ flexGrow: 1, backgroundColor: t.buttonSecondary }} />}
      </div>
      {verifying && <Checking />}
    </Body>
  } else if (step === 'duplicate' && login) {
    const existing = accountFor(accounts, kind, login.duplicate_of)
    const isCli = login.duplicate_of === 'default'
    const existingName = accountDisplayName(login.duplicate_of, existing?.name)
    body = <Body align="center" top={16} gap={8}>
      <AccountAvatar kind={kind} size={32} instance={login.duplicate_of} color={existing?.color} />
      <Title center>{isCli ? `Already signed in on ${item.machine}` : `Already added as ${existingName}`}</Title>
      <Desc center>{isCli ? `This is the account your ${agent} terminal login uses.` : `${login.identity?.email ?? 'This email'} is ${agent}’s ${existingName} account.`}</Desc>
    </Body>
  } else if (step === 'error') {
    // The machine restarted, updated or went away under a running sign-in.
    const lost = failure ? null : api.lost === 'offline' ? { title: `Lost the connection to ${item.machine}`, message: 'Try again when it’s back.' }
      : api.lost === 'ended' ? { title: 'The sign-in ended', message: `${item.machine} restarted or stopped waiting for it. Try again.` } : null
    const message = failure ?? (login?.error && plainSentence(login.error)) ?? 'Try again, or show the terminal.'
    body = <ErrorBody title={lost?.title ?? 'Unable to sign in'} message={lost?.message ?? message} />
    footer = <>{footerLead}{!lost && login?.mode !== 'terminal' && !legacy && <Button size="lg" testId="account-show-terminal" onClick={showTerminal}>Show terminal</Button>}<Button size="lg" testId="account-retry" variant="primary" onClick={tryAgain}>Try again</Button></>
  } else {
    body = <Body><Title pe>{`Sign in to ${agent}${onMachine}`}</Title><div style={{ height: 64, marginTop: 12, borderRadius: 6, backgroundColor: t.buttonSecondary }} /></Body>
  }
  return <>
    <Rise key={`${step ?? 'none'}:${otherEmail ?? ''}:${finishError ?? borrowError?.view.title ?? unbindError?.title ?? ''}`} kind="row">{body}</Rise>
    <Footer>{footer}</Footer>
  </>
}

function Summary({ queue, view, dismiss, close }: { queue: QueueState; view: UnifiedView; dismiss: Dismiss; close: () => void }) {
  const t = useTheme()
  const providers = useNav((s) => s.providers)
  const items = queue.items
  const ok = items.filter((item) => ['signed_in', 'already', 'borrowed'].includes(queue.results[item.id] ?? ''))
  const first = items[0]!
  const email = queue.email ?? first.email
  const oneAccount = isOneAccount(items) || items.every((item) => item.kind === first.kind && item.email === first.email && !!first.email)
  const account = oneAccount && email ? view.groups.find((g) => g.kind === first.kind)?.accounts.find((a) => a.email?.toLowerCase() === email.toLowerCase()) : undefined
  const others = view.groups.find((g) => g.kind === first.kind)?.accounts.filter((a) => a.key).length ?? 0
  // A new account on an agent that already has others can take over as the default.
  const offerDefault = !!account && !account.isDefault && others > 1 && !first.instance && ok.length > 0
  const [useDefault, setUseDefault] = useState(false)
  dismiss.current = () => {}
  const done = () => { if (offerDefault && useDefault) void makeDefault(view, account); close() }
  useEffect(() => { void refreshAllAccounts() }, [])
  const agent = agentName(providers, first.kind)
  const everyOk = ok.length === items.length
  const title = items.length === 1
    ? (everyOk ? (email ? `Signed in as ${email}` : `${agent} is signed in`) : `${agent} isn’t signed in on ${first.machine}`)
    : everyOk
      ? (items.every((i) => i.machineId === first.machineId) ? `${first.machine} is set up` : `Signed in on ${items.length} machines`)
      : `Signed in on ${ok.length} of ${items.length}`
  return <>
    <Rise kind="row"><Body gap={16}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, paddingTop: 8 }}>
        {ok.length > 0 && <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 40, height: 40, borderRadius: 20, backgroundColor: t.v('--success') + '1f' }}><SuccessCheck testId="account-success-check" size={20} color={t.v('--success')} /></div>}
        <Title center>{title}</Title>
      </div>
      {items.length > 1 && !everyOk && <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {items.map((item) => <div key={item.id} testId={`account-result-${item.machineId}`} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}><Label color={t.text} size={14} lineHeight={21} truncate>{stepName(items, item)}</Label><Label color={t.textSecondary} size={13} lineHeight={21}>{RESULT_WORDS[queue.results[item.id] ?? 'skipped']}</Label></div>)}
      </div>}
      {offerDefault && <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <Label color={t.text} size={14} lineHeight={21} weight={500}>{`Use for new ${agent} threads`}</Label>
        <Switch testId="account-default" aria-label={`Use for new ${agent} threads`} checked={useDefault} onCheckedChange={setUseDefault} />
      </div>}
    </Body></Rise>
    <Footer><Button size="lg" testId="account-done" variant="primary" onClick={done}>Done</Button></Footer>
  </>
}

// ── Pieces ───────────────────────────────────────────────────────────────────

export function CloseX({ onClose }: { onClose: () => void }) {
  return <IconButton testId="dialog-close" icon={N.x} label="Close" size="lg" onClick={onClose} style={{ position: 'absolute', top: 8, right: 8 }} />
}

/** Wraps, so a button naming a long machine drops to its own line instead of leaving the sheet. */
function Footer({ children }: { children: ReactNode }) {
  return <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', gap: 8, paddingLeft: 16, paddingRight: 16, paddingTop: 12, paddingBottom: 12 }}>{children}</div>
}
/** `BODY_CLASS`: `px-4 pt-4 pb-4`, gap per step. */
function Body({ children, gap = 12, align, top }: { children: ReactNode; gap?: number; align?: 'center'; top?: number }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap, paddingLeft: 16, paddingRight: 16, paddingTop: top ?? 16, paddingBottom: 16, ...(align ? { alignItems: 'center' } : {}) }}>{children}</div>
}
function ErrorBody({ title, message }: { title: string; message: string }) {
  const t = useTheme()
  return <Body align="center" top={16} gap={8}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 40, height: 40, borderRadius: 20, backgroundColor: t.v('--destructive') + '1a' }}><Icon source={S.circleAlert} size={20} color={t.v('--destructive')} /></div>
    <Title center>{title}</Title>
    <Desc center testId="account-error">{message}</Desc>
  </Body>
}
function Title({ children, center, pe }: { children: ReactNode; center?: boolean; pe?: boolean }) {
  const t = useTheme()
  return <Label color={t.text} size={18} lineHeight={22.5} weight={600} style={{ ...(center ? { textAlign: 'center' } : {}), ...(pe ? { paddingRight: 32 } : {}) }}>{children}</Label>
}
function Desc({ children, center, testId }: { children: ReactNode; center?: boolean; testId?: string }) {
  const t = useTheme()
  return <div testId={testId} style={{ display: 'flex', flexDirection: 'column', ...(center ? { alignItems: 'center' } : {}) }}><Label color={t.textSecondary} size={14} lineHeight={19.25} style={center ? { textAlign: 'center' } : {}}>{children}</Label></div>
}
function FieldLabel({ children }: { children: string }) {
  const t = useTheme()
  return <Label color={t.text} size={14} lineHeight={21} weight={500}>{children}</Label>
}
function ErrorLabel({ children }: { children: string }) {
  const t = useTheme()
  return <Label color={t.v('--destructive')} size={13} lineHeight={19.5}>{children}</Label>
}
function QuietLink({ children, onClick, testId }: { children: string; onClick: () => void; testId?: string }) {
  return <Button testId={testId} variant="ghost" size="sm" onClick={onClick}>{children}</Button>
}
function Checking() {
  const t = useTheme()
  return <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 8 }}><MatrixLoader variant="pulse" dot={2} gap={1.33} /><Label color={t.textSecondary} size={13} lineHeight={19.5}>Checking the sign-in…</Label></div>
}
function RemoteNote({ host, transport }: { host: string; transport: 'SSH' | 'Tailscale' }) {
  const t = useTheme()
  return <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, borderRadius: 8, backgroundColor: t.buttonSecondary }}><Label color={t.textSecondary} size={13} lineHeight={19.5}>{remoteNote(host, transport)}</Label></div>
}
function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false)
  useEffect(() => { if (!done) return; const timer = setTimeout(() => setDone(false), 1400); return () => clearTimeout(timer) }, [done])
  return <Button testId="account-copy" icon={done ? N.check : S.copy} onClick={() => { void copyText(text); setDone(true) }}>{done ? 'Copied' : label}</Button>
}

export function PickStep(props: { providers: AccountPickerOption[]; kind: ProviderKind | undefined; onKind: (kind: ProviderKind) => void; folder: string; onFolder: (value: string) => void; advancedOpen: boolean; onAdvancedOpen: (open: boolean) => void; remote: boolean; children?: ReactNode }) {
  const t = useTheme()
  const c = useControls()
  const { providers, kind, remote } = props
  const placeholder = kind === 'claude-code' ? '~/.claude-work' : kind === 'codex' ? '~/.codex-work' : `~/.${kind ?? 'agent'}-work`
  const TILE = Math.floor((448 - 32 - 16) / 3) - 2
  return <>
    {/* `DialogHeader`: px-4 pt-4 pb-2. */}
    <div style={{ display: 'flex', flexDirection: 'column', paddingLeft: 16, paddingRight: 16, paddingTop: 16, paddingBottom: 8 }}>
      <Title pe>Add an account</Title>
    </div>
    <Body gap={16} top={4}>
      <div testId="account-provider" role="radiogroup" aria-label="Agent" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {providers.map((p) => {
          const disabled = !!p.disabled
          const selected = !disabled && p.kind === kind
          const activate = () => { if (!disabled) props.onKind(p.kind) }
          return <div key={p.kind} testId={`account-provider-${p.kind}`} role="radio" aria-checked={selected} aria-disabled={disabled || undefined} tabIndex={disabled ? -1 : 0} onClick={disabled ? undefined : activate} onKeyDown={disabled ? undefined : (e) => { if (e.key === 'enter' || e.key === 'space') activate() }}
            style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8, width: TILE, minWidth: 0, padding: 12, borderWidth: 1, borderColor: selected ? c.accent : t.border, borderRadius: 12, backgroundColor: selected ? c.optionSelected : disabled ? c.disabled.bg : 'transparent', opacity: !p.available || disabled ? 0.55 : 1, cursor: disabled ? 'default' : 'pointer', ...(disabled ? {} : { hover: { backgroundColor: t.buttonSecondaryHover } }) }}>
            <ProviderMark kind={p.kind} size={18} />
            <Label color={t.text} size={14} lineHeight={21} weight={500} truncate>{p.display_name}</Label>
            {!p.available && <Label color={t.textSecondary} size={13} lineHeight={19.5} style={{ marginTop: -6 }}>Not installed</Label>}
            {p.available && p.disabledReason && <Label color={t.textSecondary} size={13} lineHeight={19.5} style={{ marginTop: -6, width: '100%' }}>{p.disabledReason}</Label>}
          </div>
        })}
      </div>
      {props.children}
      {kind && kind !== 'opencode' && kind !== 'pi' && kind !== 'antigravity' && <div style={{ display: 'flex', flexDirection: 'column' }}>
        <Button testId="account-advanced" variant="ghost" size="sm" label="Advanced" trailing={<Chevron open={props.advancedOpen} size={12} color={t.textSecondary} />} onClick={() => props.onAdvancedOpen(!props.advancedOpen)} style={{ alignSelf: 'flex-start', marginLeft: -8 }}>Advanced</Button>
        {props.advancedOpen && <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 12, paddingBottom: 4 }}>
          <Label color={ink(t, 0.8)} size={13} lineHeight={19.5} weight={500}>Use an existing folder on this machine</Label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ flexGrow: 1, display: 'flex', minWidth: 0 }}><TextField testId="account-folder" label="Folder" size="lg" placeholder={placeholder} value={props.folder} onChange={props.onFolder} width="100%" /></div>
            {!remote && <Button testId="account-choose-folder" size="lg" onClick={() => void pickFolder().then((picked) => { if (picked) props.onFolder(picked) })}>Choose…</Button>}
          </div>
          <Label color={t.textSecondary} size={13} lineHeight={19.5}>Kybern uses the sign-in already saved in this folder and never deletes it.</Label>
        </div>}
      </div>}
    </Body>
  </>
}

function PasteStep({ title, login, remote, host, transport, wrong, unsent, code, onCode, shown, onShown, onSubmit, onTerminal }: { title: string; login: { url?: string }; remote: boolean; host: string; transport: 'SSH' | 'Tailscale'; wrong: boolean; unsent: boolean; code: string; onCode: (value: string) => void; shown: boolean; onShown: (value: boolean) => void; onSubmit: () => void; onTerminal?: () => void }) {
  const t = useTheme()
  return <Body gap={12}>
    <Title pe>{title}</Title>
    {remote && <RemoteNote host={host} transport={transport} />}
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
      <Button testId="account-open-page" icon={S.externalLink} disabled={!login.url} onClick={() => void openExternal(login.url!)}>Open sign-in page</Button>
      {login.url && <CopyButtonGhost text={login.url} />}
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <Label color={t.text} size={14} lineHeight={21} weight={500}>Code from the page</Label>
      <TextField testId="account-code" label="Code" size="lg" secure={!shown} autoFocus={wrong} placeholder="Paste code" value={code} onChange={onCode} onSubmit={onSubmit} invalid={wrong} mono={!!code} width="100%" trailing={<IconButton testId="account-code-toggle" icon={S.eye} label="Show code" size="sm" active={shown} onClick={() => onShown(!shown)} />} />
      {wrong && <ErrorLabel>That code didn’t work. Open the sign-in page again and paste the new code.</ErrorLabel>}
      {unsent && <ErrorLabel>{`Couldn’t send the code to ${host}. Try again.`}</ErrorLabel>}
    </div>
    {onTerminal && <QuietLink testId="account-show-terminal" onClick={onTerminal}>Having trouble? Show terminal</QuietLink>}
  </Body>
}
function CopyButtonGhost({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  useEffect(() => { if (!done) return; const timer = setTimeout(() => setDone(false), 1400); return () => clearTimeout(timer) }, [done])
  return <Button testId="account-copy-link" variant="ghost" icon={done ? N.check : S.copy} onClick={() => { void copyText(text); setDone(true) }}>{done ? 'Copied' : 'Copy link'}</Button>
}
