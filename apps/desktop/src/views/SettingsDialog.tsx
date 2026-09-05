import { canSelfUpdate, checkForAppUpdate, installAppUpdate, useAppUpdate } from "@/lib/appUpdate"
import { notificationPermission, notify, type NotificationPermissionState } from "@/lib/tauri"
// Settings, in a dialog: a 16rem nav column of sidebar rows and a
// content column of SettingsSection / SettingsCard / SettingsRow blocks.

import { useEffect, useId, useState } from "react"
import { toast } from "sonner"

import { ProviderMark } from "@/components/kybern/bits"
import { useTheme } from "@/components/theme-context"
import { Button } from "@/components/kit/button"
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from "@/components/kit/dialog"
import { ComposerPickerMenuPopup } from "@/components/kit/chat/ComposerPickerMenuPopup"
import { Menu, MenuGroup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "@/components/kit/menu"
import { ChevronDownIcon, SettingsIcon, TerminalIcon, SunIcon as AppearanceIcon, ClockIcon, InfoIcon } from "@/lib/kit/icons"
import { Switch } from "@/components/kit/switch"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/kit/input-group"
import { MatrixLoader, TextSwap } from "@/components/kybern/motion"
import { PERMISSION_HINT, PERMISSION_LABEL, tokens, usd } from "@/lib/format"
import { DeviceLaptopIcon, MoonIcon, SunIcon } from "@/lib/kit/icons"
import {
  SETTINGS_CARD_CLASS_NAME,
  SETTINGS_CARD_ROW_CLASS_NAME,
  SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME,
  SETTINGS_CARD_ROW_TITLE_CLASS_NAME,
  SETTINGS_CONTROL_RADIUS_CLASS_NAME,
  SETTINGS_PANEL_SECTION_CLASS_NAME,
  SETTINGS_SECTION_LABEL_CLASS_NAME,
  SETTINGS_STACKED_ROWS_DIVIDER_CLASS_NAME,
} from "@/lib/kit/settingsPanelStyles"
import { SIDEBAR_HEADER_ROW_CLASS_NAME, SIDEBAR_ROW_HOVER_CLASS_NAME, SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME } from "@/lib/kit/sidebarRowStyles"
import { cn } from "@/lib/utils"
import { useSlidingPill } from "@/lib/kit/slidingPill"
import type { BackgroundSettings, DaemonActivity, PermissionMode, ProviderKind, Settings, UsageSummaryResult, HarnessUpdate } from "@/protocol"
import { errorText, rpc } from "@/state/rpc"
import { useStore } from "@/state/store"

type Tab = "general" | "agents" | "appearance" | "usage" | "about"

const TABS: [Tab, string, string][] = [
  ["general", "General", "Defaults for new threads and notifications."],
  ["agents", "Agents", "Availability on the connected machine."],
  ["appearance", "Appearance", "Theme and window material."],
  ["usage", "Usage", "Tokens and cost by agent, model or day."],
  ["about", "About", "Daemon, protocol and data folder."],
]

export function SettingsDialog() {
  const open = useStore((s) => s.settingsOpen)
  const set = useStore((s) => s.set)
  const tab = useStore((s) => s.settingsTab)
  const current = TABS.find((t) => t[0] === tab) ?? TABS[0]!
  const [navRef, pillStyle, pillReady] = useSlidingPill<HTMLUListElement>(tab)
  return (
    <Dialog open={open} onOpenChange={(o) => set({ settingsOpen: o })}>
      <DialogPopup className="app-settings-surface h-[min(680px,90dvh)] max-w-[920px] flex-col sm:flex-row overflow-hidden p-0" bottomStickOnMobile={false}>
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">Configure kybern</DialogDescription>
        <nav className="flex shrink-0 flex-col border-b border-[color:var(--color-border-light)] bg-[var(--color-background-button-secondary)] p-3 sm:w-44 sm:border-r sm:border-b-0 sm:py-5 font-system-ui">
          <h2 className="px-2 py-1 text-[length:var(--app-font-size-ui,12px)] font-normal text-muted-foreground">Settings</h2>
          <ul ref={navRef} className="t-tabs mt-3 flex gap-1 overflow-x-auto sm:flex-col">
            <li aria-hidden className="t-tabs-pill z-0 rounded-md bg-[var(--sidebar-accent-active)]" style={pillStyle} data-ready={pillReady} />
            {TABS.map(([v, label]) => (
              <li key={v} className="relative z-[1]">
                <button
                  type="button"
                  aria-current={tab === v ? "page" : undefined}
                  data-tab-active={tab === v}
                  onClick={() => set({ settingsTab: v })}
                  className={cn("w-full", SIDEBAR_HEADER_ROW_CLASS_NAME, tab === v ? "text-[var(--sidebar-accent-foreground)]" : cn(SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME, SIDEBAR_ROW_HOVER_CLASS_NAME))}
                >
                  {(() => { const Icon = { general: SettingsIcon, agents: TerminalIcon, appearance: AppearanceIcon, usage: ClockIcon, about: InfoIcon }[v]; return <Icon className="size-4 shrink-0" /> })()}
                  <span className="truncate">{label}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <div key={tab} className="t-section-enter mx-auto w-full max-w-2xl px-5 py-6 sm:px-8 sm:py-8">
            <div className="mb-7 flex items-start justify-between gap-4">
              <div>
                <h1 className="text-lg font-semibold tracking-tight text-foreground">{current[1]}</h1>
                <p className="mt-1 text-[length:var(--app-font-size-ui)] leading-relaxed text-muted-foreground">{current[2]}</p>
              </div>
            </div>
            <div className="space-y-6">
              {tab === "general" && <General />}
              {tab === "agents" && <Agents />}
              {tab === "appearance" && <Appearance />}
              {tab === "usage" && <Usage />}
              {tab === "about" && <About />}
            </div>
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  )
}

function useSettings() {
  const settings = useStore((s) => s.settings)
  const set = useStore((s) => s.set)
  const update = async (patch: Partial<Settings>) => {
    if (!settings) return
    const next = { ...settings, ...patch }
    set({ settings: next })
    try {
      const saved = await rpc().call("settings.update", { settings: next })
      set({ settings: saved })
    } catch (e) {
      set({ settings })
      toast.error("Unable to save settings", { description: errorText(e) })
    }
  }
  return { settings, update }
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className={SETTINGS_PANEL_SECTION_CLASS_NAME}>
      <h2 className={SETTINGS_SECTION_LABEL_CLASS_NAME}>{title}</h2>
      <div className={cn(SETTINGS_CARD_CLASS_NAME, SETTINGS_STACKED_ROWS_DIVIDER_CLASS_NAME)}>{children}</div>
    </section>
  )
}

function Row({ title, description, status, children }: { title: string; description?: React.ReactNode; status?: string; children?: React.ReactNode }) {
  const labelId = useId()
  return (
    <div className={cn(SETTINGS_CARD_ROW_CLASS_NAME, "scroll-mt-24 py-4!")}>
      <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-3">
        <div className="min-w-0 basis-52 flex-1 space-y-1">
          {title && <div className="flex min-h-5 items-center gap-1.5">
            <h3 id={labelId} className={SETTINGS_CARD_ROW_TITLE_CLASS_NAME}>{title}</h3>
          </div>}
          {description && <p className={cn(SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME, "leading-relaxed break-words")}>{description}</p>}
          {status && <p className="pt-1 text-[11px] text-muted-foreground">{status}</p>}
        </div>
        {children && <div role="group" aria-labelledby={labelId} className="flex max-w-full shrink-0 items-center gap-2">{children}</div>}
      </div>
    </div>
  )
}

function SettingsPicker<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: React.ReactNode; disabled?: boolean }[] }) {
  return (
    <Menu>
      <MenuTrigger render={<Button variant="chrome-outline" size="sm" className="min-w-36 max-w-full justify-between" />}>
        <span className="flex min-w-0 items-center gap-2 truncate">{options.find((o) => o.value === value)?.label ?? value}</span>
        <ChevronDownIcon className="size-3.5 shrink-0" />
      </MenuTrigger>
      <ComposerPickerMenuPopup align="end" className="min-w-44">
        <MenuGroup>
          <MenuRadioGroup value={value} onValueChange={(next) => onChange(next as T)}>
            {options.map((o) => <MenuRadioItem key={o.value} value={o.value} disabled={o.disabled}>{o.label}</MenuRadioItem>)}
          </MenuRadioGroup>
        </MenuGroup>
      </ComposerPickerMenuPopup>
    </Menu>
  )
}

function General() {
  const { settings, update } = useSettings()
  const providers = useStore((s) => s.providers)
  if (!settings) return null
  return (
    <>
      <Section title="New threads">
        <Row title="Default agent" description="Used when you start a thread from a project.">
          <SettingsPicker
            value={settings.default_provider}
            onChange={(v) => update({ default_provider: v as ProviderKind })}
            options={providers.map((p) => ({
              value: p.kind,
              disabled: !p.available,
              label: (
                <>
                  <ProviderMark kind={p.kind} size={12} className="size-3" /> {p.display_name}
                </>
              ),
            }))}
          />
        </Row>
        <Row title="Default permissions" description={PERMISSION_HINT[settings.default_permission_mode]}>
          <SettingsPicker
            value={settings.default_permission_mode}
            onChange={(v) => update({ default_permission_mode: v as PermissionMode })}
            options={(Object.keys(PERMISSION_LABEL) as PermissionMode[]).map((m) => ({ value: m, label: PERMISSION_LABEL[m] }))}
          />
        </Row>
        <Row title="Use a worktree for new threads" description="Each thread gets its own branch and folder. Projects can override this.">
          <Switch aria-label="Use a worktree for new threads" checked={settings.worktrees_default} onCheckedChange={(v) => update({ worktrees_default: v })} />
        </Row>
      </Section>
      <Section title="Threads">
        <Row title="Generate thread titles" description="Names the thread from its first message using the agent.">
          <Switch aria-label="Generate thread titles" checked={settings.generate_titles} onCheckedChange={(v) => update({ generate_titles: v })} />
        </Row>
        <Row title="Show agent notifications" description="When work finishes, fails, or needs your input.">
          <Switch aria-label="Show agent notifications" checked={settings.notifications} onCheckedChange={(v) => update({ notifications: v })} />
        </Row>
      </Section>
      <BackgroundSettingsSection background={settings.background} onChange={(background) => update({ background })} />
      <NotificationSettings />
    </>
  )
}

const BACKGROUND_FIELDS: { key: keyof BackgroundSettings; title: string; description: string; unit: string }[] = [
  {
    key: "session_idle_minutes",
    title: "Release idle agents after",
    description: "A quiet thread's process is closed. The next message resumes it.",
    unit: "min",
  },
  {
    key: "max_idle_sessions",
    title: "Idle agents kept warm",
    description: "Above this, the least recently used process goes first.",
    unit: "agents",
  },
  {
    key: "terminal_idle_minutes",
    title: "Close unattended shells after",
    description: "Only shells with no tab open and nothing running.",
    unit: "min",
  },
  {
    key: "daemon_idle_exit_minutes",
    title: "Exit the daemon after",
    description: "Once nothing needs it. The app relaunches it on demand, so keep this off for CLI or remote use.",
    unit: "min",
  },
]

function BackgroundSettingsSection({ background, onChange }: { background: BackgroundSettings; onChange: (next: BackgroundSettings) => void }) {
  return (
    <Section title="Background">
      <Row title="Activity" description="What the daemon is keeping alive. Running and approval-bound threads are never released.">
        <ActivityReadout />
      </Row>
      {BACKGROUND_FIELDS.map((field) => (
        <Row key={field.key} title={field.title} description={field.description}>
          <LimitField label={field.title} unit={field.unit} value={background[field.key]} onCommit={(value) => onChange({ ...background, [field.key]: value })} />
        </Row>
      ))}
    </Section>
  )
}

/** Live counts, refreshed every 5s. Numbers swap in place so a change is visible without a flash. */
function ActivityReadout() {
  const { activity, failed } = useDaemonActivity()
  if (failed) return <span className={cn(SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME, "text-right")}>Restart the daemon to see activity</span>
  if (!activity) return <MatrixLoader variant="pulse" className="text-muted-foreground" label="Reading daemon activity" />
  const stats: [number, string, string][] = [
    [activity.live_sessions, "agent", "agents"],
    [activity.idle_sessions, "idle", "idle"],
    [activity.terminals, "shell", "shells"],
    [activity.connections, "client", "clients"],
  ]
  if (activity.queued_messages > 0) stats.push([activity.queued_messages, "queued", "queued"])
  return (
    <dl className={cn(SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME, "flex items-baseline gap-x-3 tabular-nums")}>
      {stats.map(([count, one, many]) => (
        <div key={many} className="flex items-baseline gap-1">
          <TextSwap as="span" text={String(count)} className="font-medium text-foreground" />
          <dt className="sr-only">{many}</dt>
          <dd>{count === 1 ? one : many}</dd>
        </div>
      ))}
    </dl>
  )
}

function useDaemonActivity(): { activity: DaemonActivity | null; failed: boolean } {
  const [state, setState] = useState<{ activity: DaemonActivity | null; failed: boolean }>({ activity: null, failed: false })
  useEffect(() => {
    let canceled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const activity = await rpc().call("daemon.activity", {})
        if (!canceled) setState({ activity, failed: false })
      } catch {
        // An older daemon has no daemon.activity; keep the last reading if there is one.
        if (!canceled) setState((previous) => (previous.activity ? previous : { activity: null, failed: true }))
      } finally { if (!canceled) timer = setTimeout(() => void poll(), 5000) }
    }
    void poll()
    return () => { canceled = true; clearTimeout(timer) }
  }, [])
  return state
}

/** Whole-number limit with its unit inside the field. Saves on blur or Enter; an empty field means off. */
function LimitField({ label, unit, value, onCommit }: { label: string; unit: string; value: number; onCommit: (value: number) => void }) {
  const show = (v: number) => (v === 0 ? "" : String(v))
  const [draft, setDraft] = useState(show(value))
  // Adopt a value saved elsewhere (another client, a reverted save) without an effect.
  const [adopted, setAdopted] = useState(value)
  if (adopted !== value) {
    setAdopted(value)
    setDraft(show(value))
  }
  const commit = () => {
    const parsed = draft === "" ? 0 : Number.parseInt(draft, 10)
    const next = Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed, 100_000) : value
    setDraft(show(next))
    if (next !== value) onCommit(next)
  }
  return (
    <InputGroup className={cn("w-28", SETTINGS_CONTROL_RADIUS_CLASS_NAME)}>
      <InputGroupInput
        aria-label={label}
        className="text-right tabular-nums"
        inputMode="numeric"
        pattern="[0-9]*"
        placeholder="Off"
        value={draft}
        onChange={(e) => setDraft(e.target.value.replace(/\D/g, "").slice(0, 6))}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur() } }}
      />
      <InputGroupAddon align="inline-end">
        <InputGroupText className="w-9 text-[length:var(--app-font-size-ui-sm,11px)]">{unit}</InputGroupText>
      </InputGroupAddon>
    </InputGroup>
  )
}

function NotificationSettings() {
  const [permission, setPermission] = useState<NotificationPermissionState>("default")
  const [busy, setBusy] = useState(false)
  useEffect(() => { void notificationPermission().then(setPermission).catch(() => setPermission("unavailable")) }, [])
  const test = async () => {
    setBusy(true)
    try {
      const state = await notificationPermission(true)
      setPermission(state)
      if (state === "granted") {
        if (!await notify("Kybern", "Notifications are ready. You'll hear when an agent needs you.")) throw new Error("Check notification access in system settings and try again.")
      }
    } catch (e) { toast.error("Unable to send notification", { description: errorText(e) }) }
    finally { setBusy(false) }
  }
  return <Section title="System notifications"><Row title="Notification access" description={permission === "granted" ? "System alerts appear when Kybern is in the background." : permission === "denied" ? "Allow Kybern notifications in system settings, then try again." : permission === "unavailable" ? "System notifications aren't available in this environment. In-app alerts still work." : "Enable access to receive alerts outside Kybern."}><Button size="sm" variant="chrome-outline" disabled={busy || permission === "unavailable"} onClick={() => void test()}>{permission === "granted" ? "Send test notification" : "Enable notifications"}</Button></Row></Section>
}

function Agents() {
  const environmentId = useStore((s) => s.environmentId)
  return <AgentSettings key={environmentId} />
}

function AgentSettings() {
  const providers = useStore((s) => s.providers)
  const set = useStore((s) => s.set)
  const { settings, update } = useSettings()
  const [updates, setUpdates] = useState<HarnessUpdate[]>([])
  const [loadError, setLoadError] = useState("")
  useEffect(() => {
    const client = rpc()
    let canceled = false
    let timer: ReturnType<typeof setTimeout>
    let lastResult = ""
    const poll = async () => {
      try {
        const result = await client.call("harness_updates.list", {})
        if (canceled) return
        setUpdates(result.updates)
        setLoadError("")
        const changed = result.updates.filter((item) => item.status === "updated").map((item) => item.checked_at).join(",")
        if (changed && changed !== lastResult) {
          lastResult = changed
          const catalog = await client.call("providers.list", { force_refresh: true })
          if (!canceled) set({ providers: catalog.providers })
        }
      } catch (error) { if (!canceled) setLoadError(errorText(error)) }
      finally { if (!canceled) timer = setTimeout(() => void poll(), 3000) }
    }
    void poll()
    return () => { canceled = true; clearTimeout(timer) }
  }, [set])
  const run = async (kind: ProviderKind) => {
    try {
      const record = await rpc().call("harness_updates.run", { kind })
      setUpdates((previous) => [...previous.filter((item) => item.kind !== kind), record])
    } catch (error) { toast.error("Unable to start update", { description: errorText(error) }) }
  }
  return <>
    <Section title="Updates">
      <Row title="Update harnesses automatically" description="Check daily on this machine. Install when the agent's turns and background work are finished.">
        <Switch aria-label="Update harnesses automatically" checked={settings?.auto_update_harnesses ?? false} onCheckedChange={(checked) => void update({ auto_update_harnesses: checked })} />
      </Row>
      <Row title="" description="Uses each CLI's updater or its existing Homebrew package. Custom binaries and version-managed installations stay under your control." />
    </Section>
    <Section title="Installed agents">
      {providers.map((provider) => {
        const result = updates.find((item) => item.kind === provider.kind)
        const busy = result?.status === "waiting" || result?.status === "updating"
        const custom = !!settings?.providers[provider.kind]?.binary
        return <Row key={provider.kind} title={provider.display_name} description={provider.available ? <span title={provider.binary_path ?? undefined} className="block truncate">{provider.binary_path}</span> : provider.unavailable_reason ?? "Not found on PATH"}>
          <div className="flex min-w-0 flex-col items-end gap-2">
            <div className="flex items-center gap-3">
              <span className="text-[length:var(--app-font-size-ui,12px)] text-muted-foreground tabular-nums">{provider.version ?? (provider.available ? "Installed" : "Not installed")}</span>
              {provider.available && !custom && <Button size="sm" variant="chrome-outline" disabled={busy} onClick={() => void run(provider.kind)}>{result?.status === "updating" ? "Updating…" : result?.status === "waiting" ? "Waiting for idle…" : "Update now"}</Button>}
            </div>
            {custom ? <p className="max-w-80 text-right text-xs text-muted-foreground">Custom executable · Update manually</p> : result && result.status !== "not_checked" && <p role="status" className={cn("max-w-80 text-right text-xs leading-relaxed break-words", result.status === "failed" ? "text-destructive" : "text-muted-foreground")}>{result.message}{result.checked_at && <span className="mt-1 block">Last checked {new Date(result.checked_at).toLocaleString()}</span>}</p>}
          </div>
        </Row>
      })}
      {loadError && <Row title="Unable to load update status" description={loadError} />}
    </Section>
  </>
}

function Appearance() {
  const { theme, setTheme } = useTheme()
  return (
    <Section title="Theme">
      <Row title="Appearance" description="Follows the system by default.">
        <SettingsPicker
          value={theme}
          onChange={(v) => setTheme(v)}
          options={[
            {
              value: "system",
              label: (
                <>
                  <DeviceLaptopIcon className="size-3.5" /> System
                </>
              ),
            },
            {
              value: "light",
              label: (
                <>
                  <SunIcon className="size-3.5" /> Light
                </>
              ),
            },
            {
              value: "dark",
              label: (
                <>
                  <MoonIcon className="size-3.5" /> Dark
                </>
              ),
            },
          ]}
        />
      </Row>
    </Section>
  )
}

function Usage() {
  const [data, setData] = useState<UsageSummaryResult | null>(null)
  const [group, setGroup] = useState<"provider" | "model" | "day">("provider")
  useEffect(() => {
    rpc()
      .call("usage.summary", { group_by: group })
      .then(setData)
      .catch(() => setData(null))
  }, [group])
  const max = Math.max(1, ...(data?.rows.map((r) => r.usage.input_tokens + r.usage.output_tokens) ?? [1]))
  return (
    <>
      <Section title="Usage">
        <Row title="Group by">
          <SettingsPicker
            value={group}
            onChange={setGroup}
            options={[
              { value: "provider", label: "Agent" },
              { value: "model", label: "Model" },
              { value: "day", label: "Day" },
            ]}
          />
        </Row>
        {data && (
          <Row title="Total" description={`${tokens(data.total.usage.input_tokens + data.total.usage.output_tokens)} tokens`}>
            <span className="text-[length:var(--app-font-size-ui,12px)] tabular-nums">{usd(data.total.cost_usd)}</span>
          </Row>
        )}
      </Section>
      {data && (
        <Section title="Breakdown">
          {data.rows.length === 0 && <Row title="No usage recorded yet" />}
          {data.rows.map((r, i) => {
            const n = r.usage.input_tokens + r.usage.output_tokens
            return (
              <div key={r.key} className={SETTINGS_CARD_ROW_CLASS_NAME}>
                <div className="flex items-baseline justify-between text-[length:var(--app-font-size-ui,12px)]">
                  <span className="truncate">{r.key}</span>
                  <span className="text-muted-foreground tabular-nums">
                    {tokens(n)} · {usd(r.cost_usd)}
                  </span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--color-background-button-secondary-hover)]">
                  <div className="t-bar h-full rounded-full bg-foreground/70" style={{ width: `${(n / max) * 100}%`, "--i": Math.min(i, 8) } as React.CSSProperties} />
                </div>
              </div>
            )
          })}
        </Section>
      )}
    </>
  )
}

function AppUpdateRow() {
  const update = useAppUpdate()
  const busy = update.phase === "checking" || update.phase === "installing"
  const label =
    update.phase === "checking" ? "Checking…"
    : update.phase === "installing" ? (update.progress === null ? "Installing…" : `Installing… ${Math.round(update.progress * 100)}%`)
    : update.phase === "available" ? `Update to ${update.version}`
    : "Check for updates"
  const status =
    update.phase === "available" ? `${update.version} is ready. Installing restarts the app and the agents running on this machine.`
    : update.phase === "error" ? update.error
    : update.phase === "current" && update.checkedAt ? `Up to date · checked ${new Date(update.checkedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
    : null
  return (
    <Row title="Kybern" description={<>
      <span className="block">{update.appVersion ?? "…"}</span>
      {status && <span role="status" className={cn("mt-1 block", update.phase === "error" ? "text-destructive" : "text-muted-foreground")}>{status}</span>}
    </>}>
      {canSelfUpdate() && <Button size="sm" variant="chrome-outline" disabled={busy} onClick={() => void (update.phase === "available" ? installAppUpdate() : checkForAppUpdate({ manual: true }))}>{label}</Button>}
    </Row>
  )
}

function About() {
  const info = useStore((s) => s.info)
  return (
    <Section title="About">
      <AppUpdateRow />
      <Row title="Daemon" description={info?.version ?? "…"} />
      <Row title="Protocol" description={info ? String(info.protocol_version) : "…"} />
      <Row title="Host" description={info ? `${info.hostname} · ${info.os} ${info.arch}` : "…"} />
      <Row title="Data" description={info?.data_dir ?? "…"} />
    </Section>
  )
}
