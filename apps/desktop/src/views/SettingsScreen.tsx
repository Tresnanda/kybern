import { TerminalInstance } from "./Terminal"
import type { TerminalInfo } from "@/protocol"
import { Integrations } from "./Integrations"
import { canSelfUpdate, checkForAppUpdate, installAppUpdate, useAppUpdate } from "@/lib/appUpdate"
import { cliInstall, cliRemoveOther, cliStatus, cliUninstall, isTauri, notificationPermission, notify, openExternal, type CliStatus, type NotificationPermissionState } from "@/lib/tauri"
// Dedicated settings screen. The workspace remains mounted behind it for a lossless return.

import { Fragment, useEffect, useEffectEvent, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import { toast } from "sonner"

import { ProviderMark } from "@/components/kybern/bits"
import { useTheme } from "@/components/theme-context"
import { Button } from "@/components/kit/button"
import { ArrowLeftIcon, SearchIcon, PluginIcon, BellIcon, BackgroundTrayIcon } from "@/lib/kit/icons"
import { ComposerPickerMenuPopup } from "@/components/kit/chat/ComposerPickerMenuPopup"
import { Menu, MenuGroup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "@/components/kit/menu"
import { ArrowUpRightIcon, CheckIcon, ChevronDownIcon, XIcon, SettingsIcon, TerminalIcon, SunIcon as AppearanceIcon, InfoIcon } from "@/lib/kit/icons"
import { Switch } from "@/components/kit/switch"
import { Textarea } from "@/components/kit/textarea"
import { InputGroup, InputGroupInput } from "@/components/kit/input-group"
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@/components/kit/collapsible"
import { MatrixLoader, TextSwap } from "@/components/kybern/motion"
import { PERMISSION_HINT, PERMISSION_LABEL } from "@/lib/format"
import { DeviceLaptopIcon, MoonIcon, SunIcon } from "@/lib/kit/icons"
import { ResizeHandle } from "@/components/kybern/ResizeHandle"
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
import {
  SETTINGS_SIDEBAR_ICON_CLASS_NAME,
  SETTINGS_SIDEBAR_ICON_SLOT_CLASS_NAME,
  SETTINGS_SIDEBAR_ITEM_CLASS_NAME,
  SETTINGS_SIDEBAR_ITEM_LABEL_CLASS_NAME,
  SETTINGS_SIDEBAR_LIST_GAP_CLASS_NAME,
  SETTINGS_SIDEBAR_SECTION_LABEL_CLASS_NAME,
} from "@/lib/kit/settingsSidebarNavStyles"
import { SIDEBAR_ROW_HOVER_CLASS_NAME, SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME } from "@/lib/kit/sidebarRowStyles"
import { cn } from "@/lib/utils"
import { useSlidingPill } from "@/lib/kit/slidingPill"
import type { BackgroundSettings, OrchestrationSettings, ComputerForeground, ComputerNote, ComputerPermission, ComputerStatus, CursorSetupAction, CursorSetupStatus, DaemonActivity, DaemonUpdate, PermissionMode, ProviderKind, ProviderStatus, Settings, HarnessUpdate } from "@/protocol"
import { setGlobalNotesHome, useGlobalNotesHome } from "@/lib/notesPrefs"
import { setAskBeforeClose, useAskBeforeClose } from "@/state/closeGuard"
import { errorText, refreshProviders, rpc } from "@/state/rpc"
import { activeEnvironment } from "@/state/environments"
import { useStore } from "@/state/store"

type Tab = "general" | "agents" | "integrations" | "computer" | "appearance" | "notifications" | "background" | "about"

const TABS: [Tab, string, string][] = [
  ["general", "General", "Defaults for new threads and workspace behavior."],
  ["agents", "Agent providers", "Manage the coding agents on your connected machine."],
  ["integrations", "Integrations", "Plugins and connectors for your agents."],
  ["computer", "Computer use", "Let agents read and use apps on this Mac."],
  ["appearance", "Appearance", "Make Kybern feel at home on your desktop."],
  ["notifications", "Notifications", "Choose when Kybern gets your attention."],
  ["background", "Background activity", "Manage idle agents, terminals, and power use."],
  ["about", "About", "App version, updates, and connected machine."],
]

const NAV_GROUPS: { label: string; tabs: Tab[] }[] = [
  { label: "Personal", tabs: ["general", "appearance", "notifications"] },
  { label: "Coding", tabs: ["agents", "integrations", "computer"] },
  { label: "System", tabs: ["background", "about"] },
]

const SEARCH_TERMS: Record<Tab, string> = {
  general: "default agent permissions worktree thread titles close workspace notes global shared separate",
  notifications: "alerts sound permission work finishes fails input",
  background: "idle memory warm shells daemon battery power activity",
  agents: "provider harness install updates claude codex cursor opencode pi omp profiles sign in sdk",
  integrations: "plugins connectors tools mcp skills sign in authentication",
  computer: "computer use cuadriver screen apps click type accessibility screen recording permissions cursor",
  appearance: "theme light dark system translucent glass window",
  about: "version update protocol host data folder machine command line terminal cli path",
}

export function SettingsScreen({
  sidebarResize,
}: {
  sidebarResize?: { onPointerDown: (e: ReactPointerEvent) => void; dragging: boolean }
} = {}) {
  const set = useStore((s) => s.set)
  const tab = useStore((s) => s.settingsTab)
  const environmentId = useStore((s) => s.environmentId)
  const [query, setQuery] = useState("")
  const [keyboard, setKeyboard] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const current = TABS.find((t) => t[0] === tab) ?? TABS[0]!
  const [navRef, pillStyle, pillReady] = useSlidingPill<HTMLUListElement>(`${tab}:${query}`)
  const matches = TABS.filter(([id, title, description]) => `${title} ${description} ${SEARCH_TERMS[id]}`.toLowerCase().includes(query.trim().toLowerCase()))
  const close = () => set({ settingsOpen: false })
  useEffect(() => {
    heading.current?.focus({ preventScroll: true })
  }, [])
  useEffect(() => { scroll.current?.scrollTo({ top: 0 }) }, [tab])
  const select = (next: Tab, fromKeyboard = false) => {
    setKeyboard(fromKeyboard)
    set({ settingsTab: next })
    setQuery("")
  }
  return (
    <section className="settings-screen" aria-label="Settings" data-keyboard={keyboard || undefined}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented || (event.target as HTMLElement).closest('[role="dialog"], [role="menu"], [data-slot="menu-popup"]')) return
        event.stopPropagation()
        if (query) setQuery("")
        else close()
      }}>
      {/* Same frame as the workspace: a title bar, then one rounded card. */}
      <div data-tauri-drag-region aria-hidden="true" className="settings-titlebar-strip drag-region" />
      {/* The breadcrumb sits in the title bar over the page, like a route header. */}
      <div data-tauri-drag-region className="drag-region settings-titlebar">
        <span>Settings<span className="mx-2 text-muted-foreground/40">/</span>{current[1]}</span>
      </div>
      <aside className="settings-navigation app-sidebar-panel">
        <div className="settings-navigation-inner">
          <button
            type="button"
            className={cn(SETTINGS_SIDEBAR_ITEM_CLASS_NAME, SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME, SIDEBAR_ROW_HOVER_CLASS_NAME, "settings-back")}
            onClick={close}
          >
            <span className={SETTINGS_SIDEBAR_ICON_SLOT_CLASS_NAME}><ArrowLeftIcon className={cn(SETTINGS_SIDEBAR_ICON_CLASS_NAME, "shrink-0")} /></span>
            <span className={SETTINGS_SIDEBAR_ITEM_LABEL_CLASS_NAME}>Back to workspace</span>
          </button>
          <InputGroup className="settings-search">
            <SearchIcon className="ms-3 size-3.5 shrink-0 text-muted-foreground" />
            <InputGroupInput aria-label="Search settings" placeholder="Search settings…" value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && matches[0]) { select(matches[0][0], true); heading.current?.focus() } }} />
          </InputGroup>
          <nav aria-label="Settings sections">
            <ul ref={navRef} className={cn("t-tabs settings-nav-list", SETTINGS_SIDEBAR_LIST_GAP_CLASS_NAME)}>
              {!query && <li aria-hidden className="t-tabs-pill sidebar-row-surface z-0 rounded-md bg-[var(--sidebar-accent-active)]" style={pillStyle} data-ready={pillReady} />}
              {NAV_GROUPS.map((group) => {
                const items = group.tabs.flatMap((id) => matches.filter((item) => item[0] === id))
                if (!items.length) return null
                return <Fragment key={group.label}>
                  <li className="settings-nav-category"><h2 className={cn(SETTINGS_SIDEBAR_SECTION_LABEL_CLASS_NAME, "m-0")}>{group.label}</h2></li>
                  {items.map(([id, label]) => {
                    const Icon = { general: SettingsIcon, agents: TerminalIcon, integrations: PluginIcon, computer: DeviceLaptopIcon, appearance: AppearanceIcon, notifications: BellIcon, background: BackgroundTrayIcon, about: InfoIcon }[id]
                    return <li key={id} className="relative z-[1]">
                      <button type="button" aria-current={tab === id ? "page" : undefined} data-tab-active={tab === id}
                        onClick={(event) => select(id, event.detail === 0)}
                        className={cn(SETTINGS_SIDEBAR_ITEM_CLASS_NAME, "settings-nav-item", tab === id ? "text-foreground" : cn(SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME, SIDEBAR_ROW_HOVER_CLASS_NAME))}>
                        <span className={SETTINGS_SIDEBAR_ICON_SLOT_CLASS_NAME}><Icon className={cn(SETTINGS_SIDEBAR_ICON_CLASS_NAME, "shrink-0")} /></span>
                        <span className={SETTINGS_SIDEBAR_ITEM_LABEL_CLASS_NAME}>{label}</span>
                      </button>
                    </li>
                  })}
                </Fragment>
              })}
            </ul>
            {matches.length === 0 && <div className="settings-search-empty"><p>No settings match “{query}”.</p><Button variant="ghost" size="sm" onClick={() => setQuery("")}>Clear search</Button></div>}
          </nav>
          <div className="settings-nav-footer"><span className="size-1.5 rounded-full bg-muted-foreground/50" />{activeEnvironment()?.name ?? "This machine"}</div>
        </div>
      </aside>
      <main className="settings-content app-settings-surface chat-content-card workspace-card relative z-[15] overflow-hidden">
        {sidebarResize && (
          <ResizeHandle
            edge="left"
            label="Resize sidebar"
            onPointerDown={sidebarResize.onPointerDown}
            dragging={sidebarResize.dragging}
            className="z-[25] max-[580px]:hidden"
          />
        )}
        <div ref={scroll} className="settings-scroll">
          <div className="settings-page">
            <header className="settings-page-heading">
              <h1 ref={heading} tabIndex={-1}>{current[1]}</h1>
              <p>{current[2]}</p>
            </header>
            <div key={`${environmentId}:${tab}`} className="settings-section-content">
              {tab === "general" && <General />}
              {tab === "agents" && <Agents />}
              {tab === "integrations" && <Integrations />}
              {tab === "computer" && <ComputerUse />}
              {tab === "appearance" && <Appearance />}
              {tab === "notifications" && <Notifications />}
              {tab === "background" && <Background />}
              {tab === "about" && <About />}
            </div>
          </div>
        </div>
      </main>
    </section>
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
    <section className={cn(SETTINGS_PANEL_SECTION_CLASS_NAME, "settings-group")}>
      <h2 className={cn(SETTINGS_SECTION_LABEL_CLASS_NAME, "settings-group-title")}>{title}</h2>
      <div className={cn(SETTINGS_CARD_CLASS_NAME, SETTINGS_STACKED_ROWS_DIVIDER_CLASS_NAME)}>{children}</div>
    </section>
  )
}

function Row({ title, description, status, anchor, children }: { title: string; description?: React.ReactNode; status?: string; anchor?: string; children?: React.ReactNode }) {
  const labelId = useId()
  return (
    <div data-settings-anchor={anchor} className={cn(SETTINGS_CARD_ROW_CLASS_NAME, "settings-row scroll-mt-24 py-4!")}>
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

function SettingsPicker<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: React.ReactNode; disabled?: boolean }[]; label?: string }) {
  return (
    <Menu>
      <MenuTrigger aria-label={label} render={<Button variant="chrome-outline" size="sm" className="min-w-36 max-w-full justify-between" />}>
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
        <Row title="Tell agents about Kybern" description="Adds a short guide to new agent sessions: how to show images, link notes and tasks, and reach other threads.">
          <Switch aria-label="Tell agents about Kybern" checked={settings.tell_agents_about_kybern ?? true} onCheckedChange={(v) => update({ tell_agents_about_kybern: v })} />
        </Row>
        <AskBeforeCloseRow />
      </Section>
      <Section title="Notes">
        <GlobalNotesRow />
      </Section>
    </>
  )
}

function GlobalNotesRow() {
  const home = useGlobalNotesHome()
  return (
    <Row title="Global notes" description="Notes that belong to no project. Shared keeps one set on this Mac for every environment window. Switching never moves or deletes a note.">
      <SettingsPicker
        label="Global notes"
        value={home}
        onChange={setGlobalNotesHome}
        options={[
          { value: "shared", label: "Shared across environments" },
          { value: "separate", label: "Separate per environment" },
        ]}
      />
    </Row>
  )
}

function ComputerUse() {
  const environmentId = useStore((s) => s.environmentId)
  return <ComputerUseSettings key={environmentId} />
}

function ComputerUseSettings() {
  const { settings, update } = useSettings()
  const [status, setStatus] = useState<ComputerStatus | null>(null)
  const [loadError, setLoadError] = useState("")
  const [busy, setBusy] = useState<"install" | "grant" | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const computer = settings?.computer_use
  const enabled = computer?.enabled ?? false
  // "Always allow" on an approval card changes settings in the daemon; read
  // them fresh so the allowed apps list is current.
  const setStore = useStore((s) => s.set)
  useEffect(() => {
    let live = true
    rpc()
      .call("settings.get", {})
      .then((fresh) => live && setStore({ settings: fresh }))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [setStore])
  const allowed = computer?.always_allowed_apps ?? []
  useEffect(() => {
    const client = rpc()
    let canceled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const next = await client.call("computer.status", {})
        if (canceled) return
        setStatus(next)
        setLoadError("")
        // Keep checking while the user works through setup in System Settings.
        if (next.enabled && next.installed && !next.ready) timer = setTimeout(() => void poll(), 4000)
      } catch (error) {
        if (!canceled) setLoadError(errorText(error))
      }
    }
    void poll()
    return () => { canceled = true; clearTimeout(timer) }
  }, [enabled, refreshKey])
  const run = async (action: "install" | "grant_permissions") => {
    setBusy(action === "install" ? "install" : "grant")
    try {
      setStatus(await rpc().call("computer.setup", { action }))
      if (action === "grant_permissions") toast("Follow CuaDriver’s prompts", { description: "Allow Accessibility and Screen Recording for CuaDriver in System Settings. This page updates when they are on." })
      setRefreshKey((key) => key + 1)
    } catch (error) {
      toast.error(action === "install" ? "Unable to install CuaDriver" : "Unable to open permission setup", { description: errorText(error) })
    } finally {
      setBusy(null)
    }
  }
  if (!settings) return null
  if (loadError && !status) {
    return <Section title="Computer use"><Row title="Unavailable on this machine" description={`${loadError}. Update Kybern on the connected machine to use computer use.`} /></Section>
  }
  if (status && !status.supported) {
    return <Section title="Computer use"><Row title="Needs a Mac" description="Computer use is available when Kybern runs on macOS." /></Section>
  }
  const needsInstall = !!status && (!status.installed || status.checks.some((check) => (check.name === "version" || check.name === "signature") && !check.ok))
  const permissions = status && status.enabled && status.installed && !needsInstall
  const missingPermission = !!permissions && (status.accessibility !== "granted" || status.screen_recording !== "granted")
  const problems = status?.checks.filter((check) => !check.ok && !["installed", "enabled", "version", "signature", "accessibility", "screen_recording"].includes(check.name)) ?? []
  const readiness = !enabled ? undefined : status?.ready ? "Ready. Ask any agent except Codex to use an app, like “Add milk to my shopping list in Notes.”" : status ? "Finish setup below to start." : undefined
  return <>
    <Section title="Access">
      <Row title="Let agents use apps on this Mac" description="Agents can read an app’s window and click and type in it. You approve each app the first time a conversation uses it." status={readiness}>
        <Switch aria-label="Let agents use apps on this Mac" checked={enabled} onCheckedChange={(checked) => void update({ computer_use: { foreground: "ask", ...computer, enabled: checked } })} />
      </Row>
      <Row title="Your cursor and keyboard" description="Agents work in the background and leave your cursor alone. When a step needs the real cursor, or you ask to watch, they can ask to take over for that app.">
        <SettingsPicker
          label="Your cursor and keyboard"
          value={computer?.foreground ?? "ask"}
          onChange={(foreground) => void update({ computer_use: { enabled, ...computer, foreground: foreground as ComputerForeground } })}
          options={[{ value: "ask", label: "Ask first" }, { value: "never", label: "Never" }]}
        />
      </Row>
      <Row title="Show the agent’s cursor" description="Draws a second cursor on screen where agents click. CuaDriver can use over a gigabyte of memory while it’s on. The preview in each chat shows every step either way.">
        <Switch aria-label="Show the agent’s cursor" checked={computer?.show_cursor ?? false} onCheckedChange={(checked) => void update({ computer_use: { enabled, foreground: "ask", ...computer, show_cursor: checked } })} />
      </Row>
      <Row
        title="When agents ask first"
        description="This follows each chat’s permission mode. Full access never asks. Approve for me asks only before using your cursor. Other modes ask once per app, unless you allow it below."
      />
      <Row
        title="Apps allowed without asking"
        description={allowed.length ? "Agents use these in the background without asking. They still ask before taking over your cursor." : "None yet. Choose “Always allow” when an agent asks to use an app."}
      >
        {allowed.length > 0 && (
          <ul className="flex max-w-80 flex-wrap justify-end gap-1.5">
            {allowed.map((app) => (
              <li key={app} className="flex h-7 items-center gap-1 rounded-md bg-[var(--color-background-elevated-secondary)] ps-2.5 pe-1 text-xs text-foreground/85">
                {app}
                <Button type="button" variant="ghost" size="icon-xs" aria-label={`Stop allowing ${app}`} onClick={() => void update({ computer_use: { enabled, foreground: "ask", ...computer, always_allowed_apps: allowed.filter((item) => item !== app) } })}>
                  <XIcon />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Row>
      <Row title="" description="Codex uses its own computer use. Password managers, Keychain Access, and System Settings are never available to agents. Changes apply to new conversations." />
    </Section>
    <Section title="Setup">
      <Row
        title="CuaDriver"
        description={!status ? "Checking…" : status.installed
          ? <>
              <span className="block">{`Version ${status.version ?? "unknown"}`}{status.signed && " · Signed by Cua AI"}</span>
              {status.app_path && <span title={status.app_path} className="block truncate">{status.app_path}</span>}
            </>
          : "The free, open-source app Kybern uses to see and control other apps. It installs into Applications."}
        status={needsInstall ? status?.checks.find((check) => !check.ok && ["installed", "version", "signature"].includes(check.name))?.message : undefined}
      >
        {needsInstall
          ? <Button size="sm" disabled={busy !== null} onClick={() => void run("install")}>
              {busy === "install" ? <><MatrixLoader className="size-3" /> Installing…</> : status?.installed ? "Update CuaDriver" : "Install CuaDriver"}
            </Button>
          : status?.installed && <PermissionState state="granted" granted="Installed" />}
      </Row>
      {permissions && <>
        <Row title="Accessibility" description="Lets CuaDriver read app windows and click and type in them.">
          <PermissionState state={status.accessibility} />
        </Row>
        <Row title="Screen Recording" description="Lets CuaDriver take screenshots of app windows.">
          <PermissionState state={status.screen_recording} />
        </Row>
        {missingPermission && <Row title="" description="CuaDriver asks macOS for both permissions. This page updates when they’re on.">
          <Button size="sm" variant="chrome-outline" disabled={busy !== null} onClick={() => void run("grant_permissions")}>Grant access</Button>
        </Row>}
      </>}
      {!enabled && status?.installed && !needsInstall && <Row title="" description="Turn on computer use to check CuaDriver’s permissions." />}
      {problems.map((check) => <Row key={check.name} title="" description={check.message} status={check.fix ?? undefined} />)}
    </Section>
    <AppNotes />
  </>
}

/** Mirrors the daemon's per-app limit (`computer/notes.rs`). */
const APP_NOTE_MAX_CHARS = 1500

function AppNotes() {
  const [notes, setNotes] = useState<ComputerNote[] | null>(null)
  const [editing, setEditing] = useState<{ bundleId: string; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    rpc().call("computer.notes.list", {}).then((result) => live && setNotes(result.notes)).catch(() => live && setNotes([]))
    return () => { live = false }
  }, [])
  const save = async (note: ComputerNote, text: string) => {
    setBusy(true)
    try {
      setNotes((await rpc().call("computer.notes.set", { bundle_id: note.bundle_id, text, app: note.app })).notes)
      setEditing(null)
      if (!text.trim()) {
        toast(`Deleted the notes on ${note.app}`, { action: { label: "Undo", onClick: () => void save(note, note.text) } })
      }
    } catch (error) {
      toast.error(`Unable to save the notes on ${note.app}`, { description: errorText(error) })
    } finally {
      setBusy(false)
    }
  }
  if (notes === null) return null
  return (
    <Section title="App notes">
      <Row title="" description="When an app needs a non-obvious approach, agents note what worked. A later conversation sees an app’s notes the first time it uses that app." />
      {notes.length === 0 && <Row title="" description="No notes yet." />}
      {notes.map((note) => editing?.bundleId === note.bundle_id
        ? <div key={note.bundle_id} className={cn(SETTINGS_CARD_ROW_CLASS_NAME, "settings-row space-y-2 py-4!")}>
            <h3 className={SETTINGS_CARD_ROW_TITLE_CLASS_NAME}>{note.app}</h3>
            <Textarea
              aria-label={`Notes on ${note.app}`}
              size="sm"
              value={editing.text}
              disabled={busy}
              className="[&_textarea]:min-h-28 [&_textarea]:max-h-64 [&_textarea]:overflow-y-auto"
              onChange={(event) => setEditing({ bundleId: note.bundle_id, text: event.target.value })}
            />
            <div className="flex items-center justify-between gap-2">
              <span className={cn("text-xs tabular-nums", editing.text.length > APP_NOTE_MAX_CHARS ? "text-destructive" : "text-muted-foreground")}>
                {`${editing.text.length} of ${APP_NOTE_MAX_CHARS} characters`}
              </span>
              <div className="flex items-center gap-2">
                <Button size="chip" variant="ghost" disabled={busy} onClick={() => setEditing(null)}>Cancel</Button>
                <Button
                  size="chip"
                  variant="subtle"
                  disabled={busy || editing.text === note.text || editing.text.length > APP_NOTE_MAX_CHARS}
                  onClick={() => void save(note, editing.text)}
                >
                  Save notes
                </Button>
              </div>
            </div>
          </div>
        : <Row key={note.bundle_id} title={note.app} description={<span className="line-clamp-4 whitespace-pre-line">{note.text}</span>}>
            <Button size="sm" variant="chrome-outline" disabled={busy} onClick={() => setEditing({ bundleId: note.bundle_id, text: note.text })}>Edit</Button>
            <Button type="button" variant="ghost" size="icon-xs" aria-label={`Delete the notes on ${note.app}`} disabled={busy} onClick={() => void save(note, "")}>
              <XIcon />
            </Button>
          </Row>)}
    </Section>
  )
}

function PermissionState({ state, granted = "Allowed" }: { state: ComputerPermission; granted?: string }) {
  const text = state === "granted" ? granted : state === "missing" ? "Not allowed" : "Checking…"
  return (
    <span role="status" className={cn("flex items-center gap-1.5 text-xs whitespace-nowrap", state === "missing" ? "text-foreground" : "text-muted-foreground")}>
      {state === "granted" && <CheckIcon aria-hidden className="size-3.5 text-success" />}
      <TextSwap text={text} />
    </span>
  )
}

function Notifications() {
  const { settings, update } = useSettings()
  if (!settings) return null
  return <>
    <Section title="Agent activity">
        <Row title="Show agent notifications" description="When work finishes, fails, or needs your input.">
          <Switch aria-label="Show agent notifications" checked={settings.notifications} onCheckedChange={(v) => update({ notifications: v })} />
        </Row>
    </Section>
    <NotificationSettings />
  </>
}

function Background() {
  const { settings, update } = useSettings()
  if (!settings) return null
  return <BackgroundSettingsSection background={settings.background} onChange={(background) => update({ background })} />
}

type BackgroundLimitKey = { [K in keyof BackgroundSettings]: BackgroundSettings[K] extends number ? K : never }[keyof BackgroundSettings]

const BACKGROUND_FIELDS: { key: BackgroundLimitKey; title: string; description: string; unit: string; step: number }[] = [
  {
    key: "session_idle_minutes",
    title: "Release idle agents after",
    description: "Closes a quiet thread's agent. The next message starts it again.",
    unit: "min",
    step: 5,
  },
  {
    key: "max_idle_sessions",
    title: "Keep idle agents warm",
    description: "Past this many, the least recently used one is released first.",
    unit: "agents",
    step: 1,
  },
  {
    key: "terminal_idle_minutes",
    title: "Close unattended shells after",
    description: "Only shells with no tab open and nothing running.",
    unit: "min",
    step: 5,
  },
  {
    key: "daemon_idle_exit_minutes",
    title: "Exit the daemon after",
    description: "Once nothing needs it. Keep this off if you use the CLI or remote access.",
    unit: "min",
    step: 5,
  },
]

/** Local to this window: the daemon keeps working either way. */
function AskBeforeCloseRow() {
  const ask = useAskBeforeClose()
  return (
    <Row title="Ask before closing while threads work" description="Agents keep going after the window closes. The prompt lists them and offers to stop them.">
      <Switch aria-label="Ask before closing while threads work" checked={ask} onCheckedChange={setAskBeforeClose} />
    </Row>
  )
}

function BackgroundSettingsSection({ background, onChange }: { background: BackgroundSettings; onChange: (next: BackgroundSettings) => void }) {
  return (
    <Section title="Background">
      <ActivityStrip />
      {BACKGROUND_FIELDS.map((field) => (
        <Row key={field.key} title={field.title} description={field.description}>
          <LimitField label={field.title} unit={field.unit} step={field.step} value={background[field.key]} onCommit={(value) => onChange({ ...background, [field.key]: value })} />
        </Row>
      ))}
      <Row title="Save power on battery" description="Releases idle agents after a minute and holds harness updates until you plug in.">
        <Switch aria-label="Save power on battery" checked={background.save_power_on_battery ?? false} onCheckedChange={(v) => onChange({ ...background, save_power_on_battery: v })} />
      </Row>
    </Section>
  )
}

/**
 * Live readout of what the daemon is holding open, refreshed every 5s. Four
 * numerals over quiet labels, so the eye reads the counts first; a number that
 * changes swaps in place instead of flashing.
 */
function ActivityStrip() {
  const { activity, failed } = useDaemonActivity()
  const cells: { key: string; label: string; count: number | null }[] = [
    { key: "agents", label: "Agents running", count: activity?.live_sessions ?? null },
    { key: "idle", label: "Idle, kept warm", count: activity?.idle_sessions ?? null },
    { key: "shells", label: "Shells open", count: activity?.terminals ?? null },
    { key: "clients", label: "Clients connected", count: activity?.connections ?? null },
  ]
  if (activity && activity.queued_messages > 0) cells.push({ key: "queued", label: "Messages queued", count: activity.queued_messages })
  return (
    <div className={cn(SETTINGS_CARD_ROW_CLASS_NAME, "py-4!")}>
      <div className="flex min-h-5 items-center justify-between gap-3">
        <h3 className={SETTINGS_CARD_ROW_TITLE_CLASS_NAME}>Right now</h3>
        {activity?.on_battery && (
          <span className="t-pop inline-flex h-5 items-center rounded-full bg-[var(--color-background-elevated-secondary)] px-2 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
            On battery
          </span>
        )}
      </div>
      {failed ? (
        <p className={cn(SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME, "mt-1 leading-relaxed")}>Restart the daemon to see what it is keeping alive.</p>
      ) : (
        <dl className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(6.5rem,1fr))] gap-y-3 divide-x divide-[color:var(--color-border)]">
          {cells.map((cell) => (
            <div key={cell.key} className="flex min-w-0 flex-col px-4 first:pl-0">
              <dt className={cn(SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME, "order-2 mt-1 truncate text-[length:var(--app-font-size-ui-sm,11px)]")}>{cell.label}</dt>
              <dd className="order-1 flex h-6 items-center text-[20px] font-semibold leading-none tracking-[-0.01em] text-foreground tabular-nums">
                {cell.count === null ? <MatrixLoader variant="pulse" className="text-muted-foreground" label="Reading daemon activity" /> : <TextSwap as="span" text={String(cell.count)} />}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <p className={cn(SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME, "mt-3 leading-relaxed text-pretty")}>Running and approval-bound threads are never released.</p>
    </div>
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

/**
 * Whole-number limit. The unit sits beside a fixed-width field so every row's
 * numerals line up and long units never clip. Saves on blur or Enter; an empty
 * field means off. Arrow keys step the value (Shift steps by ten).
 */
function LimitField({ label, unit, step, value, onCommit, min = 0, max = 100_000 }: { label: string; unit: string; step: number; value: number; onCommit: (value: number) => void; min?: number; max?: number }) {
  // A field with a floor above zero has no "Off": an empty draft falls back to the current value.
  const show = (v: number) => (v === 0 && min === 0 ? "" : String(v))
  const [draft, setDraft] = useState(show(value))
  // Adopt a value saved elsewhere (another client, a reverted save) without an effect.
  const [adopted, setAdopted] = useState(value)
  if (adopted !== value) {
    setAdopted(value)
    setDraft(show(value))
  }
  const clamp = (n: number) => (Number.isFinite(n) && n >= 0 ? Math.max(min, Math.min(n, max)) : value)
  const commit = () => {
    const next = clamp(draft === "" ? (min === 0 ? 0 : value) : Number.parseInt(draft, 10))
    setDraft(show(next))
    if (next !== value) onCommit(next)
  }
  const nudge = (direction: 1 | -1, big: boolean) => {
    const current = draft === "" ? 0 : Number.parseInt(draft, 10) || 0
    const next = clamp(Math.max(min, current + direction * (big ? step * 10 : step)))
    setDraft(show(next))
    if (next !== value) onCommit(next)
  }
  const off = draft === "" && min === 0
  return (
    <div className="flex items-center gap-2">
      <InputGroup className={cn("w-[4.5rem]", SETTINGS_CONTROL_RADIUS_CLASS_NAME)}>
        <InputGroupInput
          aria-label={label}
          className="text-right tabular-nums placeholder:text-muted-foreground/70"
          inputMode="numeric"
          pattern="[0-9]*"
          placeholder={min === 0 ? "Off" : undefined}
          value={draft}
          onChange={(e) => setDraft(e.target.value.replace(/\D/g, "").slice(0, 6))}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur() }
            else if (e.key === "ArrowUp") { e.preventDefault(); nudge(1, e.shiftKey) }
            else if (e.key === "ArrowDown") { e.preventDefault(); nudge(-1, e.shiftKey) }
          }}
        />
      </InputGroup>
      <span className={cn("w-11 shrink-0 whitespace-nowrap text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground transition-opacity duration-[var(--duration-quick)]", off && "opacity-40")}>{unit}</span>
    </div>
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
  useSettingsFocus()
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
      <DaemonUpdateRows autoUpdate={settings?.auto_update_daemon ?? false} onAutoUpdate={(checked) => void update({ auto_update_daemon: checked })} />
    </Section>
    {settings && <AccountSettings settings={settings} update={update} />}
    {settings && <OmpProfiles settings={settings} update={update} />}
    {settings && <DelegationSection orchestration={settings.orchestration} onChange={(orchestration) => void update({ orchestration })} />}
    <Section title="Installed agents">
      {providers.map((provider) => {
        const result = updates.find((item) => item.kind === provider.kind)
        const custom = !!settings?.providers[provider.kind]?.binary
        const row = <ProviderRow key={provider.kind} provider={provider} result={result} custom={custom} onUpdate={() => void run(provider.kind)} />
        return provider.kind === "cursor" ? <CursorProviderRow key={provider.kind} provider={provider} fallback={row} /> : row
      })}
      {loadError && <Row title="Unable to load update status" description={loadError} />}
    </Section>
  </>
}


/** How far one thread may fan out when an agent delegates work to other agents. */
function DelegationSection({ orchestration, onChange }: { orchestration: OrchestrationSettings | undefined; onChange: (next: OrchestrationSettings) => void }) {
  const current: OrchestrationSettings = { max_active_children: 4, max_depth: 2, ...orchestration }
  return (
    <Section title="Delegation">
      <Row title="Active agents per thread" description="How many delegated agents one thread can have working at once. At the limit, the thread waits for one to finish before delegating again.">
        <LimitField label="Active agents per thread" unit="agents" step={1} min={1} max={16} value={current.max_active_children} onCommit={(value) => onChange({ ...current, max_active_children: value })} />
      </Row>
      <Row title="Delegation depth" description="1 lets only top-level threads delegate. 2 also lets their agents delegate again.">
        <LimitField label="Delegation depth" unit="levels" step={1} min={1} max={4} value={current.max_depth} onCommit={(value) => onChange({ ...current, max_depth: value })} />
      </Row>
    </Section>
  )
}

/** Bring the row named by `settingsFocus` into view and onto its first
 * control, e.g. when the composer's picker sends someone to set up an agent.
 * Runs after the screen's own focus and scroll reset. */
function useSettingsFocus() {
  const focus = useStore((s) => s.settingsFocus)
  const set = useStore((s) => s.set)
  const providers = useStore((s) => s.providers)
  useEffect(() => {
    if (!focus) return
    const frame = requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>(`[data-settings-anchor="${CSS.escape(focus)}"]`)
      if (!row) return
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      row.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" })
      row.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true })
      set({ settingsFocus: null })
    })
    return () => cancelAnimationFrame(frame)
  }, [focus, providers, set])
}

const VERSION_TEXT_CLASS_NAME = "text-[length:var(--app-font-size-ui,12px)] text-muted-foreground tabular-nums whitespace-nowrap"
const ROW_NOTE_CLASS_NAME = "max-w-80 text-right text-xs leading-relaxed break-words text-pretty"

function ProviderRow({ provider, result, custom, onUpdate }: { provider: ProviderStatus; result?: HarnessUpdate; custom: boolean; onUpdate: () => void }) {
  const busy = result?.status === "waiting" || result?.status === "updating"
  // Cursor's SDK is pinned to this Kybern release and updates with it.
  const updatable = provider.available && !custom && provider.kind !== "cursor"
  return <Row anchor={`provider:${provider.kind}`} title={provider.display_name} description={provider.unavailable_reason ?? (provider.available ? <span title={provider.binary_path ?? undefined} className="block truncate">{provider.binary_path}</span> : "Not found on PATH")}>
    <div className="flex min-w-0 flex-col items-end gap-2">
      <div className="flex items-center gap-3">
        <span className={VERSION_TEXT_CLASS_NAME}>{provider.version ?? (provider.available ? "Installed" : "Not installed")}</span>
        {updatable && <Button size="sm" variant="chrome-outline" disabled={busy} onClick={onUpdate}>{result?.status === "updating" ? "Updating…" : result?.status === "waiting" ? "Waiting for idle…" : "Update now"}</Button>}
      </div>
      {custom ? <p className={cn(ROW_NOTE_CLASS_NAME, "text-muted-foreground")}>Custom executable · Update manually</p> : result && result.status !== "not_checked" && <p role="status" className={cn(ROW_NOTE_CLASS_NAME, result.status === "failed" ? "text-destructive" : "text-muted-foreground")}>{result.message}{result.checked_at && <span className="mt-1 block">Last checked {new Date(result.checked_at).toLocaleString()}</span>}</p>}
    </div>
  </Row>
}

/** Cursor runs through Cursor's SDK, which installs and signs in apart from
 * the Cursor app. The daemon does both, so this works for remote machines
 * too: the sign-in page opens here, on the computer you're using. */
function CursorProviderRow({ provider, fallback }: { provider: ProviderStatus; fallback: React.ReactElement }) {
  const [status, setStatus] = useState<CursorSetupStatus | null>(null)
  const [unsupported, setUnsupported] = useState(false)
  const [pending, setPending] = useState<CursorSetupAction | "check" | null>(null)
  const [checking, setChecking] = useState(false)
  const previous = useRef<CursorSetupStatus | null>(null)
  const opened = useRef<string | null>(null)

  const apply = (next: CursorSetupStatus) => {
    const before = previous.current
    previous.current = next
    setStatus(next)
    if (next.signing_in && next.login_url && opened.current !== next.login_url) {
      opened.current = next.login_url
      void openExternal(next.login_url)
    }
    const installed = !!before?.installing && !next.installing && next.installed
    const signedIn = !!before?.signing_in && !next.signing_in && next.account === "signed_in"
    if (installed || signedIn || (before && before.account !== next.account)) {
      setChecking(true)
      void refreshProviders().catch(() => {}).finally(() => setChecking(false))
    }
    if (signedIn) toast.success("Signed in to Cursor", next.email ? { description: next.email } : undefined)
  }

  const load = async () => {
    try { apply(await rpc().call("cursor.status", {})) }
    catch { if (!previous.current) setUnsupported(true) }
  }
  const onLoad = useEffectEvent(load)
  // Read once, then keep reading while an install or sign-in runs.
  const waiting = !!status && (status.installing || status.signing_in)
  useEffect(() => {
    let canceled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      await onLoad()
      if (!canceled && waiting) timer = setTimeout(() => void poll(), 1500)
    }
    void poll()
    return () => { canceled = true; clearTimeout(timer) }
  }, [waiting])

  const act = async (action: CursorSetupAction) => {
    setPending(action)
    try { apply(await rpc().call("cursor.setup", { action })) }
    catch (error) {
      const title = { install: "Unable to install Cursor’s SDK", sign_in: "Unable to start Cursor sign-in", cancel_sign_in: "Unable to cancel sign-in", sign_out: "Unable to sign out of Cursor" }[action]
      toast.error(title, { description: errorText(error) })
    }
    finally { setPending(null) }
  }
  const check = async () => {
    setPending("check")
    await load()
    setChecking(true)
    await refreshProviders().catch(() => {})
    setChecking(false)
    setPending(null)
  }

  if (unsupported) return fallback
  const anchor = `provider:${provider.kind}`
  if (!status) return <Row anchor={anchor} title={provider.display_name} description="Checking…"><span className={VERSION_TEXT_CLASS_NAME}>{provider.version ?? ""}</span></Row>

  let description: React.ReactNode
  let actions: React.ReactNode = null
  const version = status.installed ? `SDK ${status.sdk_version}` : "Not installed"
  if (status.installing || pending === "install") {
    description = "Installing Cursor’s SDK. This usually takes under a minute."
    actions = <Button size="sm" disabled><MatrixLoader className="size-3" /> Installing…</Button>
  } else if (!status.installed) {
    description = status.problem ?? "Kybern runs Cursor through Cursor’s SDK, which installs separately from the Cursor app."
    actions = status.problem
      ? <Button size="sm" variant="chrome-outline" disabled={pending !== null} onClick={() => void check()}>Check again</Button>
      : <Button size="sm" onClick={() => void act("install")}>Install SDK</Button>
  } else if (status.signing_in || pending === "sign_in") {
    const url = status.login_url
    description = url
      ? <>
          <span className="block text-pretty">Finish signing in on the Cursor page in your browser. This page updates when you’re done.</span>
          <Button variant="link" className="mt-1 h-auto min-h-0 gap-1 border-0 p-0 text-[length:inherit] text-foreground" onClick={() => void openExternal(url)}>
            Open the sign-in page again <ArrowUpRightIcon aria-hidden className="size-3" />
          </Button>
        </>
      : "Opening Cursor’s sign-in page…"
    actions = <Button size="sm" variant="chrome-outline" disabled={pending === "cancel_sign_in" || !status.signing_in} onClick={() => void act("cancel_sign_in")}>Cancel</Button>
  } else if (status.account === "signed_out" || status.account === "unknown") {
    description = "Sign in to use Cursor in Kybern. Your Cursor app sign-in doesn’t carry over."
    actions = <Button size="sm" onClick={() => void act("sign_in")}>Sign in…</Button>
  } else if (checking) {
    description = "Checking Cursor…"
  } else if (!provider.available) {
    description = provider.unavailable_reason ?? "Cursor didn’t respond. Check your connection, then try again."
    actions = <Button size="sm" variant="chrome-outline" disabled={pending !== null} onClick={() => void check()}>Try again</Button>
  } else {
    description = status.account === "api_key"
      ? "Signed in with CURSOR_API_KEY from this agent’s environment."
      : status.email ? <span className="block truncate" title={status.email}>Signed in as <bdi>{status.email}</bdi></span> : "Signed in"
    if (status.account === "signed_in") {
      actions = <Button size="sm" variant="chrome-outline" disabled={pending === "sign_out"} onClick={() => void act("sign_out")}>Sign out</Button>
    }
  }
  const waitingIndicator = status.signing_in && !!status.login_url
  return <Row anchor={anchor} title={provider.display_name} description={description}>
    <div className="flex min-w-0 flex-col items-end gap-2">
      <div className="flex items-center gap-3">
        {waitingIndicator
          ? <span role="status" className={cn(VERSION_TEXT_CLASS_NAME, "flex items-center gap-1.5")}><MatrixLoader className="size-3" />Waiting for sign-in</span>
          : <span className={VERSION_TEXT_CLASS_NAME}>{version}</span>}
        {actions}
      </div>
      {status.error && !status.installing && !status.signing_in && <p role="status" className={cn(ROW_NOTE_CLASS_NAME, "text-destructive")}>{status.error}</p>}
    </div>
  </Row>
}

function AccountSettings({ settings, update }: { settings: Settings; update: (patch: Partial<Settings>) => Promise<void> }) {
  const providers = useStore((s) => s.providers)
  const projects = useStore((s) => s.projects)
  const [kind, setKind] = useState<ProviderKind>(settings.default_provider)
  const [name, setName] = useState("")
  const [directory, setDirectory] = useState("")
  const [projectPath, setProjectPath] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [terminal, setTerminal] = useState<TerminalInfo | null>(null)
  const provider = settings.providers[kind] ?? { env: {} }
  const options = [{ value: "default", label: "Default account" }, ...Object.entries(provider.accounts ?? {}).map(([value, account]) => ({ value, label: account.name }))]
  const project = Object.values(projects).find((p) => p.path === projectPath)
  const save = async (account: string, path?: string) => {
    const next = { ...provider }
    if (path) {
      next.project_accounts = { ...next.project_accounts }
      if (account === "inherit") delete next.project_accounts[path]
      else next.project_accounts[path] = account
    } else next.default_account = account
    await update({ providers: { ...settings.providers, [kind]: next } })
  }
  const refresh = async () => {
    const next = await rpc().call("settings.get", {})
    useStore.getState().set({ settings: next })
    await refreshProviders()
  }
  const create = async () => {
    setBusy(true); setError("")
    try {
      await rpc().call("providers.accounts.create", { kind, name, ...(directory.trim() ? { directory: directory.trim() } : {}) })
      await refresh(); setName(""); setDirectory("")
    } catch (problem) { setError(errorText(problem)) }
    finally { setBusy(false) }
  }
  const signIn = async (instance: string) => {
    setBusy(true); setError("")
    try { setTerminal(await rpc().call("providers.accounts.sign_in", { kind, instance })) }
    catch (problem) { setError(errorText(problem)) }
    finally { setBusy(false) }
  }
  return <Section title="Accounts">
    <Row title="Agent" description="Named accounts use separate native sign-in and session storage. Default keeps your regular CLI account.">
      <SettingsPicker value={kind} label="Account agent" onChange={(value) => setKind(value as ProviderKind)} options={providers.map((item) => ({ value: item.kind, label: item.display_name }))} />
    </Row>
    <Row title="Global account" description="Threads following defaults use this account on their next message. Running turns keep their current account.">
      <SettingsPicker value={provider.default_account ?? "default"} label="Global account" options={options} onChange={(value) => void save(value).catch((problem) => setError(errorText(problem)))} />
    </Row>
    {Object.entries(provider.accounts ?? {}).map(([id, account]) => <Row key={id} title={account.name} description={<span className="block break-all" title={account.directory}>{account.directory}</span>}>
      <Button size="sm" variant="chrome-outline" disabled={busy || terminal !== null} onClick={() => void signIn(id)}>Sign in</Button>
    </Row>)}
    <Row title="Add an account" description="Leave the directory empty to create isolated storage, or reference an existing native account directory.">
      <div className="grid w-64 max-w-full min-w-0 gap-2">
        <InputGroup><InputGroupInput aria-label="Account name" value={name} maxLength={120} placeholder="Work" onChange={(event) => setName(event.target.value)} /></InputGroup>
        <InputGroup><InputGroupInput aria-label="Existing account directory" value={directory} placeholder="Existing directory (optional)" autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(event) => setDirectory(event.target.value)} /></InputGroup>
        <Button size="sm" variant="chrome-outline" disabled={busy || !name.trim()} onClick={() => void create()}>Add account</Button>
      </div>
    </Row>
    {Object.values(projects).length > 0 && <>
      <Row title="Project override" description="Choose a project to override the global account for this agent.">
        <SettingsPicker value={projectPath} label="Choose account project" options={[{ value: "", label: "Choose project" }, ...Object.values(projects).map((p) => ({ value: p.path, label: p.name }))]} onChange={setProjectPath} />
      </Row>
      {project && <Row title={`${project.name} account`}>
        <SettingsPicker value={provider.project_accounts?.[project.path] ?? "inherit"} label="Project account" options={[{ value: "inherit", label: "Follow global account" }, ...options]} onChange={(value) => void save(value, project.path).catch((problem) => setError(errorText(problem)))} />
      </Row>}
    </>}
    {error && <Row title="Unable to update account" description={<span role="status">{error}</span>} />}
    {terminal && <div className="grid min-w-0 gap-2 p-3">
      <div className="flex items-center justify-between gap-2"><span className={SETTINGS_CARD_ROW_TITLE_CLASS_NAME}>Finish native sign-in</span><Button size="sm" variant="ghost" onClick={() => void rpc().call("terminals.close", { terminal_id: terminal.id }).then(() => setTerminal(null)).catch((problem) => setError(errorText(problem)))}>Cancel sign-in</Button></div>
      <div className="relative h-72 min-w-0 overflow-hidden rounded-[var(--radius-surface)]"><TerminalInstance key={terminal.id} threadId="" tab={{ key: terminal.id, title: "Sign in", kind: "shell", terminalId: terminal.id, connectorLogin: true }} active externalTerminal onExit={() => { setTerminal(null); void refresh().catch((problem) => setError(errorText(problem))) }} onTitle={() => {}} /></div>
    </div>}
  </Section>
}

export function OmpProfiles({ settings, update }: { settings: Settings; update: (patch: Partial<Settings>) => Promise<void> }) {
  const projects = useStore((s) => s.projects)
  const [selected, select] = useState("")
  const [expanded, setExpanded] = useState(false)
  const defaultId = useId()
  const projectId = useId()
  const paths = Object.values(projects)
  const path = paths.find((p) => p.path === selected)?.path ?? paths[0]?.path
  const provider: NonNullable<Settings["providers"]["omp"]> = settings.providers.omp ?? { env: {} }
  const overrides = paths.filter(p => provider.project_profiles?.[p.path] !== undefined).length
  const save = (value: string, project?: string) => {
    const next = { ...provider }
    if (project) {
      next.project_profiles = { ...provider.project_profiles }
      if (value) next.project_profiles[project] = value
      else delete next.project_profiles[project]
    } else {
      next.env = { ...provider.env }
      if (value) next.env.OMP_PROFILE = value
      else delete next.env.OMP_PROFILE
    }
    return update({ providers: { ...settings.providers, omp: next } })
  }
  return <section className={SETTINGS_PANEL_SECTION_CLASS_NAME} data-omp-profiles>
    <h2 className={SETTINGS_SECTION_LABEL_CLASS_NAME}>OMP profiles</h2>
    <div className={cn(SETTINGS_CARD_CLASS_NAME, "@container")}>
      <div className="grid items-start gap-3 p-3 @min-[26rem]:grid-cols-[minmax(0,1fr)_12rem]">
        <div className="space-y-1 py-1">
          <h3 id={defaultId} className={SETTINGS_CARD_ROW_TITLE_CLASS_NAME}>Default profile</h3>
          <p className={cn(SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME, "text-pretty leading-normal")}>For new chats.</p>
        </div>
        <ProfileChoice key={`global:${provider.env?.OMP_PROFILE}`} value={provider.env?.OMP_PROFILE} label="Default OMP profile" labelledBy={defaultId} inherit="Use environment" onSave={(value) => save(value)} />
      </div>
      {path && <Collapsible open={expanded} onOpenChange={setExpanded} className="border-t border-[color:var(--color-border)]">
        <CollapsibleTrigger className="group flex w-full items-center gap-3 px-3 py-3 text-start outline-none hover:bg-[var(--color-background-button-secondary-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
          <span className={cn(SETTINGS_CARD_ROW_TITLE_CLASS_NAME, "flex-1")}>Project overrides</span>
          {overrides > 0 && <span className={cn(SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME, "tabular-nums")}><bdi>{overrides === 1 ? "1 project" : `${overrides} projects`}</bdi></span>}
          <ChevronDownIcon className="size-3.5 text-muted-foreground transition-transform duration-[var(--duration-fast)] ease-[var(--ease-smooth-out)] group-data-panel-open:rotate-180 motion-reduce:transition-none" />
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="grid items-start gap-4 px-3 pt-1 pb-4 @min-[26rem]:grid-cols-[minmax(0,1fr)_12rem]">
            <div className="grid min-w-0 gap-2 [&_[data-slot=menu-trigger]]:w-full [&_[data-slot=menu-trigger]]:min-w-0">
              <span className={SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME}>Project</span>
              <SettingsPicker value={path} label="Choose project" onChange={select} options={paths.map((p) => ({ value: p.path, label: <bdi title={`${p.name}\n${p.path}`}>{p.name}</bdi> }))} />
            </div>
            <div className="grid min-w-0 gap-2">
              <span id={projectId} className={SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME}>Profile</span>
              <ProfileChoice key={`${path}:${provider.project_profiles?.[path]}`} value={provider.project_profiles?.[path]} label="Project OMP profile" labelledBy={projectId} inherit="Use default above" onSave={(value) => save(value, path)} />
            </div>
            <p className={cn(SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME, "text-pretty leading-normal @min-[26rem]:col-span-2")}>Also applies to this project’s worktrees.</p>
          </div>
        </CollapsiblePanel>
      </Collapsible>}
    </div>
    <p className={cn(SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME, "px-3 pt-1 text-pretty leading-normal")}>Existing chats keep their profile.</p>
  </section>
}

function ProfileChoice({ value, label, labelledBy, inherit, onSave }: { value?: string; label: string; labelledBy: string; inherit: string; onSave: (value: string) => Promise<void> }) {
  const [naming, setNaming] = useState(false)
  const controls = useRef<HTMLDivElement>(null)
  const mode = naming || (value !== undefined && value !== "" && value !== "default") ? "named" : value === undefined ? "inherit" : "default"
  const choices = [{ value: "inherit", label: inherit }, { value: "default", label: "OMP default" }, { value: "named", label: "Named profile" }]
  return <div ref={controls} role="group" aria-labelledby={labelledBy} className="grid min-w-0 gap-2 [&_[data-slot=menu-trigger]]:w-full [&_[data-slot=menu-trigger]]:min-w-0">
    <SettingsPicker value={mode} label={`${label} source`} options={choices} onChange={(next) => {
      setNaming(next === "named")
      if (next !== "named") void onSave(next === "inherit" ? "" : "default")
    }} />
    {mode === "named" && <ProfileInput value={value === "default" ? "" : value ?? ""} label={label} focus={naming} onSave={onSave} onCancel={() => { setNaming(false); controls.current?.querySelector<HTMLButtonElement>("[data-slot=menu-trigger]")?.focus() }} />}
  </div>
}

function ProfileInput({ value, label, focus, onSave, onCancel }: { value: string; label: string; focus: boolean; onSave: (value: string) => Promise<void>; onCancel: () => void }) {
  const [draft, setDraft] = useState(value)
  const canceled = useRef(false)
  return <InputGroup className={cn("w-full", SETTINGS_CONTROL_RADIUS_CLASS_NAME)}>
    <InputGroupInput aria-label={label} placeholder="work" value={draft} maxLength={64} autoFocus={focus} autoCapitalize="none" autoCorrect="off" spellCheck={false}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => { if (canceled.current) { canceled.current = false; return }; if (draft.trim() !== value) void onSave(draft.trim()) }}
      onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); canceled.current = true; setDraft(value); onCancel() } }} />
  </InputGroup>
}

const DAEMON_UPDATE_LABEL: Record<DaemonUpdate["status"], string> = {
  not_checked: "Check for updates",
  checking: "Checking…",
  current: "Check for updates",
  available: "Update now",
  waiting: "Waiting for idle…",
  updating: "Installing…",
  restarting: "Restarting…",
  unsupported: "Check for updates",
  failed: "Check for updates",
}

/** The daemon's own updater: the automatic switch plus its live state. Hidden
 * for the local environment, whose daemon ships inside the app. */
function DaemonUpdateRows({ autoUpdate, onAutoUpdate }: { autoUpdate: boolean; onAutoUpdate: (checked: boolean) => void }) {
  const info = useStore((s) => s.info)
  const connection = useStore((s) => s.connection)
  const local = activeEnvironment()?.local ?? true
  const [record, setRecord] = useState<DaemonUpdate | null>(null)
  const [pending, setPending] = useState(false)
  useEffect(() => {
    if (local) return
    const client = rpc()
    let canceled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const next = await client.call("daemon_update.status", {})
        if (!canceled) setRecord(next)
      } catch { /* offline while the daemon restarts; the next poll catches up */ }
      finally { if (!canceled) timer = setTimeout(() => void poll(), 3000) }
    }
    void poll()
    return () => { canceled = true; clearTimeout(timer) }
  }, [local, connection.state])
  if (local) {
    return <Row title="kybernd" description="Bundled with the app and updated with it.">
      <span className="text-[length:var(--app-font-size-ui,12px)] text-muted-foreground tabular-nums">{info?.version ?? "…"}</span>
    </Row>
  }
  const status = record?.status ?? "not_checked"
  const busy = pending || status === "checking" || status === "waiting" || status === "updating" || status === "restarting"
  const act = async () => {
    setPending(true)
    try {
      const next = await rpc().call(status === "available" ? "daemon_update.run" : "daemon_update.check", {})
      setRecord(next)
    } catch (error) { toast.error("Unable to update the daemon", { description: errorText(error) }) }
    finally { setPending(false) }
  }
  const detail = record && status !== "not_checked" ? record.message : null
  return <>
    <Row title="Update the daemon automatically" description="Check the release feed daily on this machine. Install and restart when nothing is running.">
      <Switch aria-label="Update the daemon automatically" checked={autoUpdate} onCheckedChange={onAutoUpdate} />
    </Row>
    <Row title="kybernd" description={<span className="block truncate">{info ? `${info.hostname} · ${info.os} ${info.arch}` : "…"}</span>}>
      <div className="flex min-w-0 flex-col items-end gap-2">
        <div className="flex items-center gap-3">
          <span className="text-[length:var(--app-font-size-ui,12px)] text-muted-foreground tabular-nums">{record?.current_version ?? info?.version ?? "…"}</span>
          {status !== "unsupported" && <Button size="sm" variant="chrome-outline" disabled={busy} onClick={() => void act()}>{status === "available" && record?.latest_version ? `Update to ${record.latest_version}` : DAEMON_UPDATE_LABEL[status]}</Button>}
        </div>
        {detail && <p role="status" className={cn("max-w-80 text-right text-xs leading-relaxed break-words", status === "failed" ? "text-destructive" : "text-muted-foreground")}>{detail}{record?.checked_at && status !== "restarting" && <span className="mt-1 block">Last checked {new Date(record.checked_at).toLocaleString()}</span>}</p>}
      </div>
    </Row>
  </>
}

function Appearance() {
  const { theme, setTheme, translucent, setTranslucent } = useTheme()
  return <>
    <section className="settings-group">
      <h2 className="settings-group-title">Theme</h2>
      <div className="settings-theme-options" role="group" aria-label="Theme">
        {(["light", "dark", "system"] as const).map((value) => {
          const Icon = { light: SunIcon, dark: MoonIcon, system: DeviceLaptopIcon }[value]
          return <button key={value} type="button" className="settings-theme-choice" aria-pressed={theme === value} onClick={() => setTheme(value)}>
            <div className="settings-theme-preview" data-theme-preview={value} aria-hidden="true">
              <div className="settings-preview-sidebar"><i /><i /><i /></div>
              <div className="settings-preview-content"><i /><i /><div /><i /></div>
            </div>
            <span className="settings-theme-label"><Icon className="size-4" />{value === "system" ? "System" : value === "light" ? "Light" : "Dark"}</span>
          </button>
        })}
      </div>
      <p className="settings-note">System follows your device’s light and dark appearance.</p>
    </section>
    <Section title="Window material">
      <Row title="Use translucent surfaces" description="Let your desktop show softly through the sidebar and floating controls. Follows your system’s reduced transparency preference.">
        <Switch aria-label="Use translucent surfaces" checked={translucent} onCheckedChange={setTranslucent} />
      </Row>
    </Section>
  </>
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
  return <>
    <Section title="About">
      <AppUpdateRow />
      <Row title="Daemon" description={info?.version ?? "…"} />
      <Row title="Protocol" description={info ? String(info.protocol_version) : "…"} />
      <Row title="Host" description={info ? `${info.hostname} · ${info.os} ${info.arch}` : "…"} />
      <Row title="Data" description={info?.data_dir ?? "…"} />
    </Section>
    {isTauri() && <Section title="Command line"><CommandLineRow /></Section>}
  </>
}

const MONO_CLASS_NAME = "font-mono text-[0.95em]"

/** The `kybern` command shipped inside the app, put on PATH the way this
 * platform expects. It always matches the app because it lives inside it. */
function CommandLineRow() {
  const [status, setStatus] = useState<CliStatus | null>(null)
  const [busy, setBusy] = useState<"install" | "uninstall" | "remove" | null>(null)
  const [justInstalled, setJustInstalled] = useState(false)
  useEffect(() => {
    let canceled = false
    void cliStatus().then((next) => { if (!canceled) setStatus(next) }).catch(() => {})
    return () => { canceled = true }
  }, [])
  const run = async (action: "install" | "uninstall" | "remove") => {
    setBusy(action)
    try {
      const next = action === "install" ? await cliInstall() : action === "uninstall" ? await cliUninstall() : await cliRemoveOther(status?.resolved ?? "")
      setStatus(next)
      setJustInstalled(action !== "uninstall" && next.installed)
    } catch (error) {
      const text = errorText(error)
      if (text !== "canceled") {
        toast.error({ install: "Unable to install the command", uninstall: "Unable to uninstall the command", remove: "Unable to remove the older command" }[action], { description: text })
      }
    } finally { setBusy(null) }
  }
  const command = <code className={MONO_CLASS_NAME}>kybern</code>
  if (!status) return <Row title="Terminal command" description="Checking…" />
  if (status.method === "unavailable") return <Row title="Terminal command" description={status.problem ?? "Not available in this build."} />

  // Shorter, familiar paths in a terminal context: ~/.local/bin/kybern.
  const tidy = (path: string) => status.method !== "path" && status.home && path.startsWith(`${status.home}/`) ? `~${path.slice(status.home.length)}` : path
  const where = status.target && <bdi className={MONO_CLASS_NAME}>{tidy(status.target)}</bdi>
  let description: React.ReactNode
  if (status.method === "package") {
    description = <>Installed with Kybern’s package at {where}. It updates with the app.</>
  } else if (status.installed) {
    description = status.method === "path"
      ? <>Kybern’s folder is on your Path, so terminals can run {command}. It updates with the app.</>
      : <>Installed at {where}. It updates with the app.</>
  } else {
    description = status.method === "path"
      ? <>Adds Kybern’s folder to your Path so terminals can run {command}. It updates with the app.</>
      : <>Run Kybern from a terminal with {command}. It stays in step with the app.</>
  }
  // What a terminal runs today matters most when it isn't Kybern's copy.
  const other = status.resolved && (status.shadowed || !status.installed) ? status.resolved : null
  const otherVersion = status.resolved_version ? `kybern ${status.resolved_version}` : "another kybern"
  const notes: { text: React.ReactNode; tone?: "warning" }[] = []
  if (status.problem) notes.push({ text: status.problem, tone: "warning" })
  if (status.installed && status.shadowed && other) {
    notes.push({ text: <>Terminals still run {otherVersion} at <bdi className={MONO_CLASS_NAME}>{tidy(other)}</bdi>, which comes first on your PATH.</>, tone: "warning" })
  } else if (!status.installed && other) {
    notes.push({ text: <>Terminals currently run {otherVersion} at <bdi className={MONO_CLASS_NAME}>{tidy(other)}</bdi>.</> })
  }
  if (status.installed && !status.target_on_path && status.method !== "path" && status.method !== "package") {
    notes.push({ text: <>Add <bdi className={MONO_CLASS_NAME}>{tidy(status.target ?? "").replace(/[\\/][^\\/]+$/, "")}</bdi> to your PATH to use it.</>, tone: "warning" })
  } else if (justInstalled && !status.shadowed) {
    notes.push({ text: "Open a new terminal window to use it." })
  }
  const canInstall = !status.installed && !status.problem
  return <Row title="Terminal command" description={<>
    <span className="block text-pretty">{description}</span>
    {notes.map((note, index) => <span key={index} role="status" className={cn("mt-1 block text-pretty break-words", note.tone === "warning" ? "text-foreground" : "text-muted-foreground")}>{note.text}</span>)}
  </>}>
    {status.installed && status.shadowed && other && (
      <Button size="sm" variant="chrome-outline" disabled={busy !== null} onClick={() => void run("remove")}>{busy === "remove" ? "Removing…" : "Remove older copy"}</Button>
    )}
    {canInstall && (
      <Button size="sm" disabled={busy !== null} onClick={() => void run("install")}>
        {busy === "install" ? <><MatrixLoader className="size-3" /> Installing…</> : status.needs_admin ? "Install…" : "Install"}
      </Button>
    )}
    {status.installed && status.method !== "package" && (
      <Button size="sm" variant="chrome-outline" disabled={busy !== null} onClick={() => void run("uninstall")}>{busy === "uninstall" ? "Uninstalling…" : "Uninstall"}</Button>
    )}
  </Row>
}
