// The Add account sheet: one dialog whose body moves between steps (pick,
// waiting, paste, device, terminal, success, duplicate, error) as a sign-in
// runs. The common path is one browser trip: pick an agent, approve in the
// browser, come back to a check mark, a prefilled name and a color. It also
// signs an existing account in again. Mounted once, in App; open it with
// `openAddAccount`.

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { toast } from "sonner"

import { Button } from "@/components/kit/button"
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@/components/kit/collapsible"
import { ComposerPickerMenuPopup } from "@/components/kit/chat/ComposerPickerMenuPopup"
import { Dialog, DialogCreateHandle, DialogDescription, DialogFooter, DialogHeader, DialogPopup, DialogTitle } from "@/components/kit/dialog"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/kit/input-group"
import { Label } from "@/components/kit/label"
import { Menu, MenuGroup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "@/components/kit/menu"
import { Skeleton } from "@/components/kit/skeleton"
import { Switch } from "@/components/kit/switch"
import { AccountAvatar } from "@/components/kybern/accounts/AccountMark"
import { useAccountLogin } from "@/components/kybern/accounts/useAccountLogin"
import { DelayedSpinner, ProviderMark } from "@/components/kybern/bits"
import { MatrixLoader } from "@/components/kybern/motion"
import {
  ACCOUNT_COLORS,
  ACCOUNT_COLOR_LABELS,
  accountColorVar,
  accountDisplayName,
  accountFor,
  initialLoginMode,
  isNameValid,
  loginHost,
  remoteNote,
  shouldFinishOnClose,
  stepFor,
  successDefaults,
  supportsBrowserLogin,
  supportsDeviceCode,
  supportsPasteCode,
  type AccountColor,
  type SheetStep,
} from "@/lib/accounts"
import { copyText } from "@/lib/hooks"
import { ChevronDownIcon, CheckIcon, CircleAlertIcon, CopyIcon, ExternalLinkIcon, EyeIcon } from "@/lib/kit/icons"
import { SETTINGS_CONTROL_BORDER_CLASS_NAME, SETTINGS_INSET_LIST_CLASS_NAME } from "@/lib/kit/settingsPanelStyles"
import { PROVIDER_NAMES } from "@/lib/providerUsage"
import { openExternal, pickFolder } from "@/lib/tauri"
import { cn } from "@/lib/utils"
import type { AccountLogin, AccountLoginMode, ProviderKind, ProviderStatus } from "@/protocol"
import { flashAccount, refreshAccounts, useAccountsLegacy, useAccounts } from "@/state/accounts"
import { activeEnvironment } from "@/state/environments"
import { errorText, rpc } from "@/state/rpc"
import { useStore } from "@/state/store"
import { TerminalInstance } from "@/views/Terminal"

export interface AddAccountRequest {
  /** Start with this agent selected. */
  kind?: ProviderKind
  /** Sign in again to this existing account instead of adding one. */
  instance?: string
}
type Opened = AddAccountRequest & { nonce: number }

const handle = DialogCreateHandle<Opened>()
let nonce = 0

/** Open the sheet. With `instance` it signs that account in again. */
// eslint-disable-next-line react-refresh/only-export-components
export function openAddAccount(request: AddAccountRequest = {}) {
  handle.openWithPayload({ ...request, nonce: ++nonce })
}

export function AddAccountSheet() {
  const last = useRef<Opened | null>(null)
  const closing = useRef<(() => void) | null>(null)
  return (
    <Dialog handle={handle} onOpenChange={(open) => { if (!open) closing.current?.() }}>
      {({ payload }) => {
        // The payload clears when the dialog closes; keep rendering the last one while it fades out.
        if (payload) last.current = payload
        const request = payload ?? last.current
        return (
          <DialogPopup className="max-w-md" bottomStickOnMobile={false}>
            {request && <Flow key={request.nonce} request={request} onClosing={(fn) => { closing.current = fn }} />}
          </DialogPopup>
        )
      }}
    </Dialog>
  )
}

// ── Static pieces ────────────────────────────────────────────────────────────

/** Upstream providers `omp login` can use. Unverified: confirm against `omp login --help` before relying on the ids. */
const OMP_UPSTREAMS = [
  { id: "anthropic", label: "Claude" },
  { id: "openai-codex", label: "ChatGPT" },
  { id: "github-copilot", label: "GitHub Copilot" },
  { id: "google-gemini-cli", label: "Google" },
] as const

const TERMINAL_COPY: Partial<Record<ProviderKind, string>> = {
  opencode: "OpenCode asks for an API key. Paste it into the prompt below.",
  pi: "Pi asks which provider to sign in to. Follow its prompts below.",
}

function agentName(kind: ProviderKind, providers: ProviderStatus[]): string {
  return providers.find((p) => p.kind === kind)?.display_name ?? PROVIDER_NAMES[kind] ?? kind
}

const LINK_CLASS = "cursor-pointer text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/60 rounded-sm"
const BODY_CLASS = "flex flex-col px-4 pt-4 pb-4"

function QuietLink({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return <button type="button" disabled={disabled} className={cn(LINK_CLASS, "disabled:pointer-events-none disabled:opacity-60")} onClick={onClick}>{children}</button>
}

/** Animates the sheet's height to its content (the shared disclosure timing), so a step change never jumps. */
function AnimatedHeight({ children }: { children: ReactNode }) {
  const inner = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState<number | undefined>(undefined)
  useLayoutEffect(() => {
    const node = inner.current
    if (!node) return
    setHeight(node.getBoundingClientRect().height)
    const observer = new ResizeObserver(([entry]) => { if (entry) setHeight(entry.contentRect.height) })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  return (
    <div style={{ height }} className="overflow-hidden transition-[height] duration-220 ease-out motion-reduce:transition-none">
      <div ref={inner}>{children}</div>
    </div>
  )
}

function RemoteNote({ host, transport }: { host: string; transport: "SSH" | "Tailscale" }) {
  return <p className="rounded-lg bg-[var(--color-background-button-secondary)] px-3 py-2 text-[length:var(--app-font-size-ui-sm,11px)] leading-normal text-muted-foreground text-pretty">{remoteNote(host, transport)}</p>
}

// ── Flow ─────────────────────────────────────────────────────────────────────

function Flow({ request, onClosing }: { request: Opened; onClosing: (fn: () => void) => void }) {
  const providers = useStore((s) => s.providers)
  const legacy = useAccountsLegacy()
  const [kind, setKind] = useState<ProviderKind | undefined>(request.kind)
  const [upstream, setUpstream] = useState<string>(OMP_UPSTREAMS[0].id)
  const [folder, setFolder] = useState("")
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const uid = useId()
  const api = useAccountLogin()
  const apiRef = useRef(api)
  useEffect(() => { apiRef.current = api })
  const { login, failure, starting } = api
  // Signing in again: opened for an account, or "Sign in again to Work" from the duplicate step.
  const reauthInstance = login?.instance ?? request.instance
  const reauth = !!reauthInstance
  const accounts = useAccounts(kind)
  const settings = useStore((s) => s.settings)

  const environment = activeEnvironment()
  const remote = environment?.local === false
  const host = environment?.name ?? "this machine"
  const transport: "SSH" | "Tailscale" = environment?.ssh ? "SSH" : "Tailscale"

  const agent = kind ? agentName(kind, providers) : ""
  const target = kind && reauthInstance ? accountFor(accounts, kind, reauthInstance) : undefined
  const targetName = accountDisplayName(reauthInstance, target?.name)

  // Success step values, prefilled from the daemon's suggestion.
  const usedColors = useMemo(() => accounts.map((a) => a.color), [accounts])
  const defaults = useMemo(() => (login && login.phase === "signed_in" ? successDefaults(login, usedColors) : null), [login, usedColors])
  const [name, setName] = useState<string | null>(null)
  const [color, setColor] = useState<AccountColor | null>(null)
  const [makeDefault, setMakeDefault] = useState(false)
  const [finishError, setFinishError] = useState<string | null>(null)
  const [finishing, setFinishing] = useState(false)
  const shownName = name ?? defaults?.name ?? ""
  const shownColor = color ?? defaults?.color ?? "blue"
  const namedCount = accounts.filter((a) => a.provider.instance !== "default").length
  const providerSettings = kind ? settings?.providers[kind] : undefined
  const forcedDefault = namedCount === 0 && !providerSettings?.default_account
  const defaultOn = forcedDefault || makeDefault

  const step: SheetStep | null = failure ? "error" : api.legacyTerminal ? "terminal" : request.instance && !login ? null : stepFor(login)
  const verifying = login?.phase === "verifying"

  const modeFor = (k: ProviderKind): AccountLoginMode => initialLoginMode(k, remote)

  const begin = async (patch: { mode?: AccountLoginMode } = {}) => {
    if (!kind) return
    const mode = patch.mode ?? modeFor(kind)
    if (reauth && legacy) {
      await api.signInLegacy({ kind, instance: reauthInstance! })
      return
    }
    await api.start({
      kind,
      mode,
      ...(reauth ? { instance: reauthInstance } : {}),
      ...(!reauth && folder.trim() ? { directory: folder.trim() } : {}),
      ...(kind === "omp" && !reauth && (mode === "browser" || mode === "paste") ? { upstream } : {}),
    })
  }

  // Signing in again starts straight away, with no pick step.
  const started = useRef(false)
  useEffect(() => {
    if (!reauth || !kind || started.current) return
    started.current = true
    void begin()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const finish = async (): Promise<boolean> => {
    if (!login || !kind) return false
    setFinishing(true)
    setFinishError(null)
    try {
      const result = await rpc().call("providers.accounts.login.finish", { id: login.id, name: shownName.trim(), color: shownColor, make_default: defaultOn })
      await refreshAccounts()
      flashAccount(result.kind, result.instance)
      toast.success(`${shownName.trim()} added`)
      return true
    } catch (error) {
      setFinishError(`${errorText(error)} Check the name, then try again.`)
      return false
    } finally {
      setFinishing(false)
    }
  }

  const close = () => handle.close()

  // Esc, the close button and the backdrop all arrive here. A sign-in that is
  // still running is canceled; one that already succeeded is saved, because
  // signing in counted as consent.
  const stateRef = useRef({ login, shownName, shownColor, defaultOn })
  useEffect(() => { stateRef.current = { login, shownName, shownColor, defaultOn } })
  useEffect(() => {
    onClosing(() => {
      const current = stateRef.current
      if (shouldFinishOnClose(current.login) && current.login && isNameValid(current.shownName)) {
        const id = current.login.id
        const label = current.shownName.trim()
        void rpc().call("providers.accounts.login.finish", { id, name: label, color: current.shownColor, make_default: current.defaultOn }).then(
          async (result) => {
            await refreshAccounts()
            flashAccount(result.kind, result.instance)
            toast.success(`${label} added`)
          },
          (error) => toast.error(`Unable to add ${label}`, { description: `${errorText(error)} Open Settings › Accounts to try again.` }),
        )
        return
      }
      void apiRef.current.cancel()
      if (current.login?.phase === "signed_in" && current.login.instance) void refreshAccounts()
    })
    return () => onClosing(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const cancelAndClose = () => close()
  const showTerminal = () => void api.restart({ mode: "terminal" })

  const tryAgain = () => (reauth && legacy ? begin() : api.retry())

  // ── Render ────────────────────────────────────────────────────────────────
  let body: ReactNode
  let footer: ReactNode

  if (step === "pick" || (!step && !reauth)) {
    const installed = providers.filter((p) => p.available)
    const ready = !!kind && providers.some((p) => p.kind === kind && p.available)
    const primaryLabel = kind && supportsBrowserLogin(kind) && !remote ? "Continue in browser" : "Continue"
    body = (
      <PickStep
        providers={providers}
        kind={kind}
        onKind={(next) => {
          const status = providers.find((p) => p.kind === next)
          if (status && !status.available) {
            useStore.getState().set({ settingsOpen: true, settingsTab: "agents" })
            close()
            return
          }
          setKind(next)
        }}
        upstream={upstream}
        onUpstream={setUpstream}
        folder={folder}
        onFolder={setFolder}
        advancedOpen={advancedOpen}
        onAdvancedOpen={setAdvancedOpen}
        remote={remote}
        installedCount={installed.length}
      />
    )
    footer = (
      <>
        <Button variant="ghost" onClick={cancelAndClose}>Cancel</Button>
        <Button autoFocus={!!request.kind} disabled={!ready || starting} onClick={() => void begin()}>
          {starting ? <DelayedSpinner fallback={null} /> : null}{primaryLabel}
        </Button>
      </>
    )
  } else if (step === "waiting" && login && kind) {
    const url = loginHost(login.url)
    const canCode = supportsPasteCode(kind) || supportsDeviceCode(kind)
    const codeMode: AccountLoginMode = supportsDeviceCode(kind) ? "device_code" : "paste"
    body = (
      <div className={cn(BODY_CLASS, "items-center gap-3 pt-5 text-center")}>
        <div className="flex items-center gap-3"><AccountAvatar kind={kind} size={32} instance={reauthInstance} color={target?.color} /><MatrixLoader variant="orbit" dot={3} gap={2} className="text-muted-foreground" /></div>
        <DialogTitle className="text-balance">{reauth ? `Sign in again to ${targetName}` : "Finish signing in in your browser"}</DialogTitle>
        {url && <DialogDescription className="text-pretty">We opened {url}. Come back here when you&apos;re done.</DialogDescription>}
        <p role="status" className="sr-only">Waiting for sign-in</p>
        {verifying && <Checking />}
        <div className="mt-1 flex flex-col items-center gap-1.5 text-[length:var(--app-font-size-ui-sm,11px)]">
          {login.url && <QuietLink onClick={() => void openExternal(login.url!)}>Open browser again</QuietLink>}
          {canCode && !reauth && (
            <span className="text-muted-foreground">Browser on another device? <QuietLink onClick={() => void api.restart({ mode: codeMode })}>{supportsDeviceCode(kind) ? "Use a code instead" : "Paste code instead"}</QuietLink></span>
          )}
          {canCode && reauth && <QuietLink onClick={() => void api.restart({ mode: codeMode })}>{supportsDeviceCode(kind) ? "Use a code instead" : "Paste code instead"}</QuietLink>}
          <QuietLink onClick={showTerminal}>Having trouble? Show terminal</QuietLink>
        </div>
      </div>
    )
    footer = <Button variant="ghost" onClick={cancelAndClose}>Cancel</Button>
  } else if (step === "paste" && login && kind) {
    body = (
      <PasteStep
        key={api.wrongCodes}
        login={login}
        remote={remote}
        host={host}
        transport={transport}
        wrong={api.codeState === "wrong"}
        sending={api.codeState === "sending" || verifying}
        onSubmit={(code) => void api.submitCode(code)}
        onTerminal={showTerminal}
        formId={uid}
      />
    )
    footer = (
      <>
        <Button variant="ghost" onClick={cancelAndClose}>Cancel</Button>
        <Button type="submit" form={uid}>{api.codeState === "sending" || verifying ? <DelayedSpinner delayMs={400} /> : null}Sign in</Button>
      </>
    )
  } else if (step === "device" && login && kind) {
    const url = loginHost(login.url)
    body = (
      <div className={cn(BODY_CLASS, "gap-3")}>
        <DialogTitle className="pe-8">Enter this code in your browser</DialogTitle>
        {remote && <RemoteNote host={host} transport={transport} />}
        <div className="flex flex-col items-center gap-3 rounded-xl border border-[color:var(--color-border)] px-4 py-5">
          {login.user_code
            ? <output aria-label="One-time code" className="font-mono text-[length:calc(var(--app-font-size-ui-lg,13px)*2)] leading-none font-medium tracking-[0.08em] tabular-nums select-all">{login.user_code}</output>
            : <Skeleton className="h-8 w-48" />}
          <div className="flex flex-wrap justify-center gap-2">
            {login.user_code && <CopyTextButton text={login.user_code} label="Copy code" />}
            {login.url && <Button size="sm" variant="chrome-outline" onClick={() => void openExternal(login.url!)}><ExternalLinkIcon />Open {url ?? "sign-in page"}</Button>}
          </div>
        </div>
        <p className="text-center text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">The code expires in 15 minutes.</p>
        <p role="status" className="sr-only">Waiting for sign-in</p>
        {verifying && <Checking />}
        <div className="text-center text-[length:var(--app-font-size-ui-sm,11px)]"><QuietLink onClick={showTerminal}>Having trouble? Show terminal</QuietLink></div>
      </div>
    )
    footer = <Button variant="ghost" onClick={cancelAndClose}>Cancel</Button>
  } else if (step === "terminal" && kind) {
    const terminalId = api.legacyTerminal?.id ?? login?.terminal?.id
    const description = TERMINAL_COPY[kind] ?? `Follow ${agent}'s prompts below. Kybern checks the sign-in when it finishes.`
    body = (
      <div className={cn(BODY_CLASS, "gap-3")}>
        <DialogTitle>Finish in the terminal</DialogTitle>
        <DialogDescription className="text-pretty">{description}</DialogDescription>
        {legacy && <p className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground text-pretty">Update Kybern on {host} to sign in from the browser.</p>}
        <div className={cn(SETTINGS_INSET_LIST_CLASS_NAME, "relative h-64 min-w-0")}>
          {terminalId
            ? <TerminalInstance key={terminalId} threadId="" tab={{ key: terminalId, title: "Sign in", kind: "shell", terminalId, connectorLogin: true }} active externalTerminal onExit={() => { if (api.legacyTerminal) { void refreshAccounts(); close() } }} onTitle={() => {}} />
            : <Skeleton className="absolute inset-0 rounded-none" />}
        </div>
        {verifying && <Checking />}
      </div>
    )
    footer = <Button variant="ghost" onClick={cancelAndClose}>Cancel</Button>
  } else if (step === "success" && login && kind) {
    const email = login.identity?.email
    const plan = login.identity?.plan
    const org = login.identity?.organization
    const meta = [[agent, plan].filter(Boolean).join(" "), org].filter(Boolean).join(" · ")
    const emailChanged = reauth && !!login.previous_email && !!email && login.previous_email.toLowerCase() !== email.toLowerCase()
    body = (
      <div className={cn(BODY_CLASS, "gap-4")}>
        <div className="flex flex-col items-center gap-2 pt-2 text-center">
          <span className="grid size-10 place-items-center rounded-full bg-success/12 text-success"><CheckIcon aria-hidden className="t-success size-5" /></span>
          <DialogTitle className="text-balance">{email ? `Signed in as ${email}` : "Signed in"}</DialogTitle>
          {meta && <DialogDescription>{meta}</DialogDescription>}
          {emailChanged && <p className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground text-pretty">{targetName} was {login.previous_email}. It now uses {email}.</p>}
        </div>
        {!reauth && (
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor={`${uid}-name`}>Name</Label>
              <InputGroup className={SETTINGS_CONTROL_BORDER_CLASS_NAME}>
                <InputGroupInput id={`${uid}-name`} value={shownName} maxLength={120} aria-invalid={!isNameValid(shownName) || undefined} autoComplete="off" spellCheck={false}
                  onChange={(event) => setName(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter" && isNameValid(shownName)) { event.preventDefault(); void finish().then((ok) => { if (ok) close() }) } }} />
              </InputGroup>
              {!isNameValid(shownName) && <p role="alert" className="text-[length:var(--app-font-size-ui-sm,11px)] text-destructive">Enter a name up to 120 characters.</p>}
            </div>
            <div className="grid gap-1.5">
              <span id={`${uid}-color`} className="text-[length:var(--app-font-size-ui,12px)] font-medium">Color</span>
              <ColorSwatches labelledBy={`${uid}-color`} value={shownColor} onChange={setColor} />
            </div>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor={`${uid}-default`}>Use as default for {agent}</Label>
              <Switch id={`${uid}-default`} checked={defaultOn} disabled={forcedDefault} aria-describedby={forcedDefault ? `${uid}-default-note` : undefined} onCheckedChange={setMakeDefault} />
            </div>
            {forcedDefault && <p id={`${uid}-default-note`} className="-mt-2.5 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground text-pretty">Your first added account becomes the default. You can switch back to the CLI account in Settings › Accounts.</p>}
          </div>
        )}
        {finishError && <p role="alert" className="text-[length:var(--app-font-size-ui-sm,11px)] text-destructive text-pretty">{finishError}</p>}
      </div>
    )
    footer = reauth
      ? <Button autoFocus onClick={() => { void refreshAccounts(); close() }}>Done</Button>
      : (
        <>
          {/* No Cancel: closing a successful sign-in saves it (signing in was the consent). */}
          <Button disabled={!isNameValid(shownName) || finishing} onClick={() => void finish().then((ok) => { if (ok) close() })}>Add account</Button>
        </>
      )
  } else if (step === "duplicate" && login && kind) {
    const existing = accountFor(accounts, kind, login.duplicate_of)
    const isCli = login.duplicate_of === "default"
    const existingName = accountDisplayName(login.duplicate_of, existing?.name)
    const email = login.identity?.email
    body = (
      <div className={cn(BODY_CLASS, "items-center gap-2 pt-4 text-center")}>
        <AccountAvatar kind={kind} size={32} instance={login.duplicate_of} color={existing?.color} />
        <DialogTitle className="text-balance"><bdi>Already added as {existingName}</bdi></DialogTitle>
        <DialogDescription className="text-pretty">
          {isCli ? `This is the account your ${agent} CLI already uses.` : `${email ?? "This email"} is ${agent}'s ${existingName} account.`}
        </DialogDescription>
      </div>
    )
    footer = isCli
      ? <Button autoFocus onClick={cancelAndClose}>Done</Button>
      : (
        <>
          <Button variant="ghost" onClick={cancelAndClose}>Done</Button>
          <Button autoFocus onClick={() => void api.restart({ instance: login.duplicate_of, directory: undefined, upstream: undefined, mode: login.mode })}>Sign in again to {existingName}</Button>
        </>
      )
  } else if (step === "error") {
    const message = failure ?? login?.error ?? "Sign-in didn't finish. Try again, or show the terminal."
    const inTerminal = login?.mode === "terminal"
    body = (
      <div className={cn(BODY_CLASS, "items-center gap-2 pt-4 text-center")}>
        <span className="grid size-10 place-items-center rounded-full bg-destructive/10 text-destructive"><CircleAlertIcon aria-hidden className="size-5" /></span>
        <DialogTitle>Unable to sign in</DialogTitle>
        <DialogDescription role="alert" className="text-pretty [overflow-wrap:anywhere]">{message}</DialogDescription>
      </div>
    )
    footer = (
      <>
        <Button variant="ghost" onClick={cancelAndClose}>Cancel</Button>
        {!inTerminal && kind && !legacy && <Button variant="chrome-outline" onClick={showTerminal}>Show terminal</Button>}
        <Button autoFocus onClick={() => void tryAgain()}>Try again</Button>
      </>
    )
  } else {
    body = <div className={BODY_CLASS}><DialogTitle>Add an account</DialogTitle><Skeleton className="mt-3 h-16 w-full" /></div>
    footer = <Button variant="ghost" onClick={cancelAndClose}>Cancel</Button>
  }

  return (
    <>
      <AnimatedHeight>
        <div key={step ?? "none"} className="account-step-in">{body}</div>
      </AnimatedHeight>
      {footer && <DialogFooter>{footer}</DialogFooter>}
    </>
  )
}

function Checking() {
  return <p role="status" className="flex items-center gap-2 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground"><MatrixLoader variant="pulse" className="size-3" />Checking the sign-in…</p>
}

// ── Steps ────────────────────────────────────────────────────────────────────

function PickStep(props: {
  providers: ProviderStatus[]
  kind: ProviderKind | undefined
  onKind: (kind: ProviderKind) => void
  upstream: string
  onUpstream: (id: string) => void
  folder: string
  onFolder: (value: string) => void
  advancedOpen: boolean
  onAdvancedOpen: (open: boolean) => void
  remote: boolean
  installedCount: number
}) {
  const { providers, kind, remote } = props
  const folderId = useId()
  const label = useId()
  const placeholder = kind === "claude-code" ? "~/.claude-work" : kind === "codex" ? "~/.codex-work" : `~/.${kind ?? "agent"}-work`
  return (
    <>
      <DialogHeader>
        <DialogTitle>Add an account</DialogTitle>
        <DialogDescription>Sign in with another account. Your current sign-ins stay as they are.</DialogDescription>
      </DialogHeader>
      <div className={cn(BODY_CLASS, "gap-4 pt-1")}>
        <div role="radiogroup" aria-label="Agent" className="grid grid-cols-2 gap-2 min-[28rem]:grid-cols-3">
          {providers.map((provider) => {
            const selected = provider.kind === kind
            return (
              <button
                key={provider.kind}
                type="button"
                role="radio"
                aria-checked={selected}
                data-selected={selected || undefined}
                onClick={() => props.onKind(provider.kind)}
                className={cn(
                  "press flex min-w-0 cursor-pointer flex-col items-start gap-2 rounded-xl border border-[color:var(--color-border)] p-3 text-start outline-none transition-[background-color,border-color,opacity] focus-visible:ring-2 focus-visible:ring-ring/60 hover:bg-[var(--color-background-button-secondary-hover)]",
                  selected && "border-[color:var(--color-text-accent)] bg-[var(--color-background-button-secondary)]",
                  !provider.available && "opacity-55",
                )}
              >
                <ProviderMark kind={provider.kind} size={18} />
                <span className="min-w-0 max-w-full truncate text-[length:var(--app-font-size-ui,12px)] font-medium">{provider.display_name}</span>
                {!provider.available && <span className="-mt-1.5 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">Not installed</span>}
              </button>
            )
          })}
        </div>
        {kind === "omp" && (
          <div className="flex items-center justify-between gap-3">
            <span id={label} className="text-[length:var(--app-font-size-ui,12px)] font-medium">Sign in with</span>
            <Menu>
              <MenuTrigger aria-labelledby={label} render={<Button variant="chrome-outline" size="sm" className="min-w-36 justify-between" />}>
                <span className="truncate">{OMP_UPSTREAMS.find((u) => u.id === props.upstream)?.label}</span>
                <ChevronDownIcon className="size-3.5 shrink-0" />
              </MenuTrigger>
              <ComposerPickerMenuPopup align="end" className="min-w-44">
                <MenuGroup>
                  <MenuRadioGroup value={props.upstream} onValueChange={props.onUpstream}>
                    {OMP_UPSTREAMS.map((upstream) => <MenuRadioItem key={upstream.id} value={upstream.id}>{upstream.label}</MenuRadioItem>)}
                  </MenuRadioGroup>
                </MenuGroup>
              </ComposerPickerMenuPopup>
            </Menu>
          </div>
        )}
        {kind && kind !== "opencode" && kind !== "pi" && (
          <Collapsible open={props.advancedOpen} onOpenChange={props.onAdvancedOpen}>
            <CollapsibleTrigger className="group -ms-1 flex items-center gap-1 rounded-sm px-1 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60">
              Advanced
              <ChevronDownIcon className="size-3 transition-transform duration-[var(--duration-fast)] ease-[var(--ease-smooth-out)] group-data-panel-open:rotate-180 motion-reduce:transition-none" />
            </CollapsibleTrigger>
            <CollapsiblePanel>
              <div className="grid gap-1.5 pt-3 pb-1">
                <Label htmlFor={folderId}>Folder</Label>
                <p className="text-[length:var(--app-font-size-ui-sm,11px)] font-medium text-foreground/80">Use an existing folder</p>
                <div className="flex items-center gap-2">
                  <InputGroup className={SETTINGS_CONTROL_BORDER_CLASS_NAME}>
                    <InputGroupInput id={folderId} value={props.folder} placeholder={placeholder} autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(event) => props.onFolder(event.target.value)} />
                  </InputGroup>
                  {!remote && <Button variant="chrome-outline" size="sm" onClick={() => void pickFolder().then((picked) => { if (picked) props.onFolder(picked) })}>Choose…</Button>}
                </div>
                <p className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground text-pretty">Kybern uses the sign-in already saved in this folder and never deletes it.</p>
              </div>
            </CollapsiblePanel>
          </Collapsible>
        )}
      </div>
    </>
  )
}

function PasteStep({ login, remote, host, transport, wrong, sending, onSubmit, onTerminal, formId }: {
  login: AccountLogin
  remote: boolean
  host: string
  transport: "SSH" | "Tailscale"
  wrong: boolean
  sending: boolean
  onSubmit: (code: string) => void
  onTerminal: () => void
  formId: string
}) {
  const [code, setCode] = useState("")
  const [shown, setShown] = useState(false)
  const fieldId = `${formId}-code`
  return (
    <div className={cn(BODY_CLASS, "gap-3")}>
      <DialogTitle className="pe-8">Paste the sign-in code</DialogTitle>
      {remote && <RemoteNote host={host} transport={transport} />}
      <ol className="grid gap-1.5 text-[length:var(--app-font-size-ui,12px)] text-muted-foreground">
        {["Open the sign-in page and approve access.", "Copy the code the page shows.", "Paste it below."].map((text, index) => (
          <li key={text} className="flex gap-2"><span className="grid size-4.5 shrink-0 place-items-center rounded-full bg-[var(--color-background-button-secondary)] text-[length:var(--app-font-size-ui-xs,10px)] font-medium text-foreground tabular-nums">{index + 1}</span><span className="text-pretty">{text}</span></li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="chrome-outline" disabled={!login.url} onClick={() => void openExternal(login.url!)}><ExternalLinkIcon />Open sign-in page</Button>
        {login.url && <CopyTextButton text={login.url} label="Copy link" variant="ghost" />}
      </div>
      <form id={formId} className="grid gap-1.5" onSubmit={(event) => { event.preventDefault(); if (code.trim() && !sending) onSubmit(code) }}>
        <Label htmlFor={fieldId}>Code</Label>
        <InputGroup className={SETTINGS_CONTROL_BORDER_CLASS_NAME}>
          <InputGroupInput id={fieldId} autoFocus={wrong} type={shown ? "text" : "password"} autoComplete="one-time-code" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="Paste code" value={code} aria-invalid={wrong || undefined} aria-describedby={wrong ? `${fieldId}-error` : undefined} className="font-mono"
            onChange={(event) => setCode(event.target.value)} />
          <InputGroupAddon align="inline-end">
            <Button type="button" size="icon-sm" variant="ghost" aria-label="Show code" aria-pressed={shown} onClick={() => setShown((value) => !value)}><EyeIcon className={cn(!shown && "opacity-60")} /></Button>
          </InputGroupAddon>
        </InputGroup>
        {wrong && <p id={`${fieldId}-error`} role="alert" className="text-[length:var(--app-font-size-ui-sm,11px)] text-destructive text-pretty">That code didn&apos;t work. Open the sign-in page again and paste the new code.</p>}
      </form>
      <p role="status" className="sr-only">Waiting for sign-in</p>
      <div className="text-[length:var(--app-font-size-ui-sm,11px)]"><QuietLink onClick={onTerminal}>Having trouble? Show terminal</QuietLink></div>
    </div>
  )
}

function CopyTextButton({ text, label, variant = "chrome-outline" }: { text: string; label: string; variant?: "chrome-outline" | "ghost" }) {
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (!done) return
    const timer = setTimeout(() => setDone(false), 1400)
    return () => clearTimeout(timer)
  }, [done])
  return (
    <Button type="button" size="sm" variant={variant} onClick={() => { void copyText(text); setDone(true) }}>
      {done ? <CheckIcon className="text-success" /> : <CopyIcon />}
      <span aria-live="polite">{done ? "Copied" : label}</span>
    </Button>
  )
}

function ColorSwatches({ value, onChange, labelledBy }: { value: AccountColor; onChange: (color: AccountColor) => void; labelledBy: string }) {
  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className="flex flex-wrap gap-2">
      {ACCOUNT_COLORS.map((color) => {
        const selected = color === value
        return (
          <button
            key={color}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={ACCOUNT_COLOR_LABELS[color]}
            title={ACCOUNT_COLOR_LABELS[color]}
            onClick={() => onChange(color)}
            onKeyDown={(event) => {
              const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0
              if (!step) return
              event.preventDefault()
              const next = ACCOUNT_COLORS[(ACCOUNT_COLORS.indexOf(color) + step + ACCOUNT_COLORS.length) % ACCOUNT_COLORS.length]!
              onChange(next)
              ;(event.currentTarget.parentElement?.querySelector<HTMLElement>(`[aria-label="${ACCOUNT_COLOR_LABELS[next]}"]`))?.focus()
            }}
            tabIndex={selected ? 0 : -1}
            className="press relative grid size-7 cursor-pointer place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-popover"
          >
            <span className="size-4 rounded-full" style={{ backgroundColor: accountColorVar(color) ?? undefined }} />
            <span aria-hidden className={cn("absolute inset-0 rounded-full border-2 transition-opacity duration-[var(--duration-quick)]", selected ? "opacity-100" : "opacity-0")} style={{ borderColor: accountColorVar(color) ?? undefined }} />
          </button>
        )
      })}
    </div>
  )
}
