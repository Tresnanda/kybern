// Settings › Accounts: every signed-in account of each installed agent, with
// its email, plan, usage and status. The CLI account (the agent's own sign-in)
// comes first; named accounts follow in creation order.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { toast } from "sonner"

import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "@/components/kit/alert-dialog"
import { Badge } from "@/components/kit/badge"
import { Button } from "@/components/kit/button"
import { Checkbox } from "@/components/kit/checkbox"
import { ComposerPickerMenuPopup } from "@/components/kit/chat/ComposerPickerMenuPopup"
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/kit/dialog"
import { InputGroup, InputGroupInput } from "@/components/kit/input-group"
import { Menu, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuSub, MenuSubPopup, MenuSubTrigger, MenuTrigger } from "@/components/kit/menu"
import { Popover, PopoverDescription, PopoverPopup, PopoverTitle, PopoverTrigger } from "@/components/kit/popover"
import { Skeleton } from "@/components/kit/skeleton"
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/kit/tooltip"
import { AccountAvatar, AccountDot } from "@/components/kybern/accounts/AccountMark"
import { AccountUsageRing } from "@/components/kybern/accounts/AccountUsageRing"
import { openAddAccount } from "@/components/kybern/accounts/AddAccountSheet"
import { CopyButton, ProviderMark } from "@/components/kybern/bits"
import { ACCOUNT_COLORS, ACCOUNT_COLOR_LABELS, isAccountColor, isCliInstance, isNameValid } from "@/lib/accounts"
import { EllipsisIcon, PlusIcon, TriangleAlertIcon } from "@/lib/kit/icons"
import {
  SETTINGS_CARD_CLASS_NAME,
  SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME,
  SETTINGS_CONTROL_BORDER_CLASS_NAME,
  SETTINGS_CARD_ROW_TITLE_CLASS_NAME,
  SETTINGS_PANEL_SECTION_CLASS_NAME,
  SETTINGS_SECTION_LABEL_CLASS_NAME,
  SETTINGS_STACKED_ROWS_DIVIDER_CLASS_NAME,
} from "@/lib/kit/settingsPanelStyles"
import { SIDEBAR_ROW_HOVER_CLASS_NAME } from "@/lib/kit/sidebarRowStyles"
import { useNow } from "@/lib/hooks"
import { PROVIDER_NAMES, bindingLimit, limitLabel } from "@/lib/providerUsage"
import { cn } from "@/lib/utils"
import type { AccountSummary, ProviderKind, ProviderStatus } from "@/protocol"
import { makeDefaultAccount, openUsageForAccount, refreshAccounts, updateProviderSettings, useAccountFlash, useAccounts, useAccountsLegacy, useAccountsLoaded } from "@/state/accounts"
import { activeEnvironment } from "@/state/environments"
import { errorText, rpc } from "@/state/rpc"
import { useStore } from "@/state/store"
import { loadAccountLimits, useAccountLimitEntries, useProviderLimits } from "@/state/usageLimits"

/** What to run in a terminal to sign the CLI account in again; Kybern picks the sign-in up on its own. */
const CLI_SIGN_IN_COMMAND: Record<ProviderKind, string> = {
  "claude-code": "claude auth login",
  codex: "codex login",
  cursor: "cursor-agent login",
  omp: "omp login",
  opencode: "opencode auth login",
  pi: "pi",
}

/** Agents whose identity the daemon can read; others keep an unknown status without a loading placeholder. */
const IDENTITY_KINDS: ProviderKind[] = ["claude-code", "codex", "cursor", "omp"]

function agentLabel(kind: ProviderKind, providers: ProviderStatus[]): string {
  return providers.find((p) => p.kind === kind)?.display_name ?? PROVIDER_NAMES[kind] ?? kind
}

// ── Page ─────────────────────────────────────────────────────────────────────

/** The heading's end-aligned action. Hidden for older daemons, which cannot add accounts from the browser. */
export function AccountsHeaderAction() {
  const legacy = useAccountsLegacy()
  if (legacy) return null
  return <Button variant="chrome-outline" size="sm" onClick={() => openAddAccount()}><PlusIcon />Add account</Button>
}

export function AccountsSettings() {
  const providers = useStore((s) => s.providers)
  const settings = useStore((s) => s.settings)
  const projects = useStore((s) => s.projects)
  const accounts = useAccounts()
  const legacy = useAccountsLegacy()
  const loaded = useAccountsLoaded()
  const [removing, setRemoving] = useState<AccountSummary | null>(null)
  const [assigning, setAssigning] = useState<AccountSummary | null>(null)
  const host = activeEnvironment()?.name ?? "this machine"

  // Read accounts and their usage while this tab is open: on open and whenever the window regains focus.
  useEffect(() => {
    const load = () => {
      void refreshAccounts()
      loadAccountLimits({ allAccounts: true })
    }
    load()
    window.addEventListener("focus", load)
    return () => window.removeEventListener("focus", load)
  }, [])

  const installed = providers.filter((p) => p.available && accounts.some((a) => a.provider.kind === p.kind))
  const missing = providers.filter((p) => !p.available)

  return (
    <>
      {legacy && <p className="settings-note" role="status">Update Kybern on {host} to sign in from the browser.</p>}
      {installed.map((provider) => (
        <AgentSection
          key={provider.kind}
          provider={provider}
          accounts={accounts.filter((a) => a.provider.kind === provider.kind)}
          readOnly={legacy}
          onRemove={setRemoving}
          onAssign={setAssigning}
        />
      ))}
      {!loaded && installed.length === 0 && <div role="status" className="grid gap-3"><Skeleton className="h-14 w-full rounded-xl" /><Skeleton className="h-14 w-full rounded-xl" /></div>}
      {missing.length > 0 && <p className="settings-note">{listAgents(missing)} {missing.length === 1 ? "isn't" : "aren't"} installed. Set them up in <button type="button" className="cursor-pointer underline underline-offset-2 hover:text-foreground" onClick={() => useStore.getState().set({ settingsTab: "agents" })}>Agent providers</button>.</p>}
      <RemoveDialog account={removing} onClose={() => setRemoving(null)} />
      <ProjectsDialog account={assigning} accounts={accounts} projects={Object.values(projects)} projectAccounts={assigning ? settings?.providers[assigning.provider.kind]?.project_accounts : undefined} onClose={() => setAssigning(null)} />
    </>
  )
}

function listAgents(missing: ProviderStatus[]): string {
  const names = missing.map((p) => p.display_name)
  return typeof Intl !== "undefined" && "ListFormat" in Intl ? new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(names) : names.join(", ")
}

function AgentSection({ provider, accounts, readOnly, onRemove, onAssign }: {
  provider: ProviderStatus
  accounts: AccountSummary[]
  readOnly: boolean
  onRemove: (account: AccountSummary) => void
  onAssign: (account: AccountSummary) => void
}) {
  return (
    <section className={cn(SETTINGS_PANEL_SECTION_CLASS_NAME, "settings-group")} aria-label={provider.display_name}>
      <h2 className={cn(SETTINGS_SECTION_LABEL_CLASS_NAME, "settings-group-title flex items-center gap-1.5")}><ProviderMark kind={provider.kind} size={14} />{provider.display_name}</h2>
      <div className={cn(SETTINGS_CARD_CLASS_NAME, SETTINGS_STACKED_ROWS_DIVIDER_CLASS_NAME, "@container")}>
        {accounts.map((account) => <AccountRow key={account.provider.instance} account={account} readOnly={readOnly} onRemove={onRemove} onAssign={onAssign} />)}
        {!readOnly && (
          <button type="button" onClick={() => openAddAccount({ kind: provider.kind })}
            className={cn("settings-row flex min-h-11 w-full cursor-pointer items-center gap-2 py-2.5 text-start text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", SIDEBAR_ROW_HOVER_CLASS_NAME)}>
            <PlusIcon className="size-4 shrink-0" /><span className="text-[length:var(--app-font-size-ui,12px)]">Add {provider.display_name} account</span>
          </button>
        )}
      </div>
    </section>
  )
}

// ── Row ──────────────────────────────────────────────────────────────────────

function AccountRow({ account, readOnly, onRemove, onAssign }: {
  account: AccountSummary
  readOnly: boolean
  onRemove: (account: AccountSummary) => void
  onAssign: (account: AccountSummary) => void
}) {
  const { kind, instance } = account.provider
  const cli = isCliInstance(instance)
  const flash = useAccountFlash(kind, instance)
  const [renaming, setRenaming] = useState(false)
  const email = account.identity?.email
  const plan = account.identity?.plan
  const projectCount = account.projects.length
  const detail = [email ?? "Email unavailable", plan, projectCount > 0 ? (projectCount === 1 ? "1 project" : `${projectCount} projects`) : null, cli ? "Same as your terminal" : null].filter(Boolean).join(" · ")
  return (
    <div
      data-account={`${kind}:${instance}`}
      className={cn("settings-row grid min-h-14 grid-cols-[auto_minmax(0,1fr)_auto_auto_auto] items-center gap-x-3 gap-y-1 py-3", "@max-[34rem]:grid-cols-[auto_minmax(0,1fr)_auto]", flash && "account-row-flash")}
    >
      <AccountAvatar kind={kind} color={account.color} instance={instance} size={32} className="@max-[34rem]:row-start-1" />
      <div className={"min-w-0 @max-[34rem]:col-start-2 @max-[34rem]:row-start-1"}>
        <div className="flex min-w-0 items-center gap-2">
          {renaming
            ? <RenameField account={account} onDone={() => setRenaming(false)} />
            : <h3 className={cn(SETTINGS_CARD_ROW_TITLE_CLASS_NAME, "min-w-0 truncate")}><bdi>{account.name}</bdi></h3>}
          {account.is_default && !renaming && <Badge size="sm" variant="secondary">Default</Badge>}
        </div>
        <p className={cn(SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME, "truncate")} title={detail}><bdi>{detail}</bdi></p>
      </div>
      <UsageCell account={account} />
      <StatusCell account={account} cli={cli} />
      {!readOnly && <AccountMenu account={account} onRename={() => setRenaming(true)} onRemove={onRemove} onAssign={onAssign} />}
    </div>
  )
}

function RenameField({ account, onDone }: { account: AccountSummary; onDone: () => void }) {
  const [draft, setDraft] = useState(account.name)
  const [error, setError] = useState(false)
  const canceled = useRef(false)
  const saving = useRef(false)
  const save = async () => {
    if (canceled.current || saving.current) return
    const name = draft.trim()
    if (name === account.name) return onDone()
    if (!isNameValid(name)) {
      setError(true)
      return
    }
    saving.current = true
    try {
      await rpc().call("providers.accounts.update", { kind: account.provider.kind, instance: account.provider.instance, name })
      await refreshAccounts()
      toast.success(`Renamed to ${name}`)
      onDone()
    } catch (problem) {
      saving.current = false
      toast.error("Unable to rename the account", { description: `${errorText(problem)} Check the name, then try again.` })
    }
  }
  return (
    <div className="min-w-0 flex-1">
      <InputGroup className={cn("h-7", SETTINGS_CONTROL_BORDER_CLASS_NAME)}>
        <InputGroupInput
          aria-label={`${account.name} name`}
          aria-invalid={error || undefined}
          autoFocus
          maxLength={120}
          value={draft}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => { setDraft(event.target.value); setError(false) }}
          onBlur={() => void save()}
          onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); void save() }
            if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); canceled.current = true; onDone() }
          }}
        />
      </InputGroup>
      {error && <p role="alert" className="mt-1 text-[length:var(--app-font-size-ui-sm,11px)] text-destructive">Enter a name up to 120 characters.</p>}
    </div>
  )
}

function UsageCell({ account }: { account: AccountSummary }) {
  const { kind, instance } = account.provider
  const entries = useAccountLimitEntries()
  const global = useProviderLimits(kind)
  const now = useNow(60_000)
  // The default account's limits are the global entry, which is labeled only once the agent has named accounts.
  const entry = entries.find((e) => e.provider === kind && e.instance === instance) ?? (account.is_default ? global : undefined)
  const binding = entry ? bindingLimit(entry.limits, now) : null
  if (!binding) return <span className="@max-[34rem]:hidden" aria-hidden />
  const left = Math.max(0, Math.min(100, Math.round(100 - binding.used)))
  const window = limitLabel(binding.limit).toLowerCase()
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button type="button" onClick={() => openUsageForAccount(kind, instance)}
            className={cn("press inline-flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-muted-foreground outline-none hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60", "@max-[34rem]:col-start-2 @max-[34rem]:row-start-2 @max-[34rem]:-ms-1.5 @max-[34rem]:justify-self-start")}
          />
        }
      >
        <AccountUsageRing left={left} />
        <span className="text-[length:var(--app-font-size-ui-sm,11px)] tabular-nums">{left}%<span className="sr-only"> left</span></span>
      </TooltipTrigger>
      <TooltipPopup>{left}% of the {window} limit left · Open usage</TooltipPopup>
    </Tooltip>
  )
}

function StatusCell({ account, cli }: { account: AccountSummary; cli: boolean }) {
  const { kind, instance } = account.provider
  const legacy = useAccountsLegacy()
  const muted = "text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground"
  const wrap = (children: ReactNode) => <div className={cn("flex min-w-[6.5rem] items-center justify-end gap-2 text-end", "@max-[34rem]:col-span-2 @max-[34rem]:col-start-2 @max-[34rem]:row-start-3 @max-[34rem]:min-w-0 @max-[34rem]:justify-start @max-[34rem]:text-start")}>{children}</div>
  const signIn = cli
    ? <HowToSignIn kind={kind} />
    : <Button size="sm" variant="chrome-outline" onClick={() => openAddAccount({ kind, instance })}>Sign in</Button>
  switch (account.status) {
    case "signed_in":
      return wrap(<span className={muted}>Signed in</span>)
    case "needs_sign_in":
      return wrap(<><span className="inline-flex items-center gap-1 text-[length:var(--app-font-size-ui-sm,11px)] text-warning"><TriangleAlertIcon className="size-3" aria-hidden />Needs sign-in</span>{signIn}</>)
    case "signed_out":
      return wrap(<><span className={muted}>Signed out</span>{signIn}</>)
    default:
      if (legacy) return wrap(cli ? null : signIn)
      if (account.identity) return wrap(<span className={muted}>Signed in</span>)
      return IDENTITY_KINDS.includes(kind) ? wrap(<Skeleton className="h-2.5 w-14" aria-label="Checking the sign-in" role="status" />) : wrap(null)
  }
}

function HowToSignIn({ kind }: { kind: ProviderKind }) {
  const command = CLI_SIGN_IN_COMMAND[kind]
  return (
    <Popover>
      <PopoverTrigger render={<Button size="sm" variant="chrome-outline" />}>How to sign in</PopoverTrigger>
      <PopoverPopup side="bottom" align="end" className="w-72">
        <div className="grid gap-2">
          <PopoverTitle className="text-[length:var(--app-font-size-ui,12px)] font-medium">How to sign in</PopoverTitle>
          <PopoverDescription className="text-pretty">Run <code className="rounded bg-[var(--color-background-button-secondary)] px-1 py-0.5 font-mono text-[0.92em] text-foreground">{command}</code> in your terminal. Kybern picks it up automatically.</PopoverDescription>
          <div className="flex items-center justify-between gap-2 rounded-lg border border-[color:var(--color-border)] py-1 ps-2.5 pe-1">
            <code className="min-w-0 truncate font-mono text-[length:var(--app-font-size-ui-sm,11px)]">{command}</code>
            <CopyButton text={command} label="Copy command" />
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  )
}

// ── Menu ─────────────────────────────────────────────────────────────────────

function AccountMenu({ account, onRename, onRemove, onAssign }: {
  account: AccountSummary
  onRename: () => void
  onRemove: (account: AccountSummary) => void
  onAssign: (account: AccountSummary) => void
}) {
  const { kind, instance } = account.provider
  const cli = isCliInstance(instance)
  const signOut = async () => {
    try {
      await rpc().call("providers.accounts.sign_out", account.provider)
      await refreshAccounts()
      toast.success(`${account.name} signed out`)
    } catch (error) {
      toast.error(`Unable to sign ${account.name} out`, { description: `${errorText(error)} Check your connection, then try again.` })
    }
  }
  const setColor = async (color: string) => {
    try {
      await rpc().call("providers.accounts.update", { kind, instance, color })
      await refreshAccounts()
    } catch (error) {
      toast.error("Unable to change the color", { description: `${errorText(error)} Check your connection, then try again.` })
    }
  }
  return (
    <Menu>
      <MenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`${account.name} options`} className="@max-[34rem]:col-start-3 @max-[34rem]:row-start-1" />}><EllipsisIcon /></MenuTrigger>
      <ComposerPickerMenuPopup align="end" className="min-w-48">
        {!cli && <MenuItem onClick={onRename}>Rename…</MenuItem>}
        {!cli && <MenuItem onClick={() => openAddAccount({ kind, instance })}>Sign in again</MenuItem>}
        {!cli && account.can_sign_out && account.status === "signed_in" && <MenuItem onClick={() => void signOut()}>Sign out</MenuItem>}
        {!cli && <MenuSeparator />}
        {!account.is_default && <MenuItem onClick={() => void makeDefaultAccount(account)}>Make default</MenuItem>}
        <MenuItem onClick={() => onAssign(account)}>Use for projects…</MenuItem>
        {!cli && (
          <MenuSub>
            <MenuSubTrigger>Color</MenuSubTrigger>
            <MenuSubPopup surface="composer">
              <MenuRadioGroup value={isAccountColor(account.color) ? account.color : ""} onValueChange={(value) => void setColor(value)}>
                {ACCOUNT_COLORS.map((color) => (
                  <MenuRadioItem key={color} value={color}>
                    <span className="flex items-center gap-2"><AccountDot color={color} />{ACCOUNT_COLOR_LABELS[color]}</span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuSubPopup>
          </MenuSub>
        )}
        {!cli && <MenuSeparator />}
        {!cli && <MenuItem variant="destructive" onClick={() => onRemove(account)}>Remove…</MenuItem>}
      </ComposerPickerMenuPopup>
    </Menu>
  )
}

// ── Dialogs ──────────────────────────────────────────────────────────────────

function RemoveDialog({ account, onClose }: { account: AccountSummary | null; onClose: () => void }) {
  // Keep the last account while the dialog fades out.
  const [kept, setKept] = useState(account)
  if (account && account !== kept) setKept(account)
  const shown = account ?? kept
  const providers = useStore((s) => s.providers)
  const [busy, setBusy] = useState(false)
  if (!shown) return null
  const agent = agentLabel(shown.provider.kind, providers)
  const remove = async () => {
    setBusy(true)
    try {
      await rpc().call("providers.accounts.remove", shown.provider)
      await refreshAccounts()
      toast.success(`${shown.name} removed`)
      onClose()
    } catch (error) {
      // The daemon says when a turn is still running ("Work is running in 2 threads. Stop them, then remove it.").
      toast.error(`Unable to remove ${shown.name}`, { description: errorText(error) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <AlertDialog open={!!account} onOpenChange={(open) => { if (!open && !busy) onClose() }}>
      <AlertDialogPopup className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle><bdi>Remove {shown.name}?</bdi></AlertDialogTitle>
          <AlertDialogDescription className="text-pretty">
            {shown.managed
              ? `Kybern signs ${shown.name} out and deletes its folder. Threads that used ${shown.name} switch to ${agent}'s default account on their next message.`
              : `Kybern stops using ${shown.name}. The folder and its sign-in stay at ${shown.directory ?? "its folder"}.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
          <Button variant="destructive" disabled={busy} onClick={() => void remove()}>Remove account</Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  )
}

function ProjectsDialog({ account, accounts, projects, projectAccounts, onClose }: {
  account: AccountSummary | null
  accounts: AccountSummary[]
  projects: { id: string; name: string; path: string }[]
  projectAccounts: Record<string, string> | undefined
  onClose: () => void
}) {
  const [kept, setKept] = useState(account)
  if (account && account !== kept) setKept(account)
  const shown = account ?? kept
  return (
    <Dialog open={!!account} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogPopup className="max-w-md" bottomStickOnMobile={false}>
        {shown && account && <ProjectsForm key={account.provider.instance} account={shown} accounts={accounts} projects={projects} projectAccounts={projectAccounts} onClose={onClose} />}
      </DialogPopup>
    </Dialog>
  )
}

function ProjectsForm({ account, accounts, projects, projectAccounts, onClose }: {
  account: AccountSummary
  accounts: AccountSummary[]
  projects: { id: string; name: string; path: string }[]
  projectAccounts: Record<string, string> | undefined
  onClose: () => void
}) {
  const { kind, instance } = account.provider
  const stored = projectAccounts ?? {}
  const [checked, setChecked] = useState(() => new Set(projects.filter((p) => stored[p.path] === instance).map((p) => p.path)))
  const [saving, setSaving] = useState(false)
  const otherName = (path: string) => {
    const other = stored[path]
    if (!other || other === instance) return null
    return accounts.find((a) => a.provider.kind === kind && a.provider.instance === other)?.name ?? null
  }
  const sorted = useMemo(() => [...projects].sort((a, b) => a.name.localeCompare(b.name)), [projects])
  const save = async () => {
    setSaving(true)
    try {
      await updateProviderSettings(kind, (current) => {
        const next = { ...current.project_accounts }
        for (const project of projects) {
          if (checked.has(project.path)) next[project.path] = instance
          else if (next[project.path] === instance) delete next[project.path]
        }
        return { ...current, project_accounts: next }
      })
      onClose()
    } catch (error) {
      toast.error("Unable to save the projects", { description: `${errorText(error)} Check your connection, then try again.` })
    } finally {
      setSaving(false)
    }
  }
  return (
    <>
      <DialogHeader>
        <DialogTitle><bdi>Use {account.name} for projects</bdi></DialogTitle>
        <DialogDescription className="text-pretty">These projects use <bdi>{account.name}</bdi> instead of the default. Their worktrees do too.</DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <ul className="grid max-h-72 gap-0.5 overflow-auto" aria-label="Projects">
          {sorted.map((project) => {
            const other = otherName(project.path)
            const id = `project-account-${project.id}`
            return (
              <li key={project.id}>
                <label htmlFor={id} className={cn("flex min-h-9 cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5", SIDEBAR_ROW_HOVER_CLASS_NAME)}>
                  <Checkbox id={id} checked={checked.has(project.path)} onCheckedChange={(value) => setChecked((prev) => { const next = new Set(prev); if (value) next.add(project.path); else next.delete(project.path); return next })} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[length:var(--app-font-size-ui,12px)]"><bdi>{project.name}</bdi></span>
                    <span className="block truncate text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground" title={project.path}>{project.path}</span>
                  </span>
                  {other && <span className="shrink-0 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground"><bdi>Uses {other}</bdi></span>}
                </label>
              </li>
            )
          })}
          {sorted.length === 0 && <li className="px-2 py-3 text-[length:var(--app-font-size-ui,12px)] text-muted-foreground">No projects yet. Add a project from the sidebar.</li>}
        </ul>
      </DialogPanel>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button disabled={saving} onClick={() => void save()}>Save</Button>
      </DialogFooter>
    </>
  )
}
