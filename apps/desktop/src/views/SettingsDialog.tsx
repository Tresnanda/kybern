// Settings, in a Synara dialog: a 16rem nav column of sidebar rows and a
// content column of SettingsSection / SettingsCard / SettingsRow blocks.

import { useEffect, useState } from "react"
import { toast } from "sonner"

import { ProviderMark } from "@/components/kybern/bits"
import { useTheme } from "@/components/theme-context"
import { Button } from "@/components/synara/button"
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from "@/components/synara/dialog"
import { Switch } from "@/components/synara/switch"
import { PERMISSION_HINT, PERMISSION_LABEL, tokens, usd } from "@/lib/format"
import { CheckIcon, DeviceLaptopIcon, MoonIcon, SunIcon } from "@/lib/synara/icons"
import {
  SETTINGS_CARD_CLASS_NAME,
  SETTINGS_CARD_ROW_CLASS_NAME,
  SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME,
  SETTINGS_CARD_ROW_TITLE_CLASS_NAME,
  SETTINGS_PANEL_SECTION_CLASS_NAME,
  SETTINGS_SECTION_LABEL_CLASS_NAME,
  SETTINGS_STACKED_ROWS_DIVIDER_CLASS_NAME,
} from "@/lib/synara/settingsPanelStyles"
import { SIDEBAR_HEADER_ROW_CLASS_NAME, SIDEBAR_ROW_ACTIVE_CLASS_NAME, SIDEBAR_ROW_HOVER_CLASS_NAME, SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME } from "@/lib/synara/sidebarRowStyles"
import { cn } from "@/lib/utils"
import type { PermissionMode, ProviderKind, Settings, UsageSummaryResult } from "@/protocol"
import { errorText, rpc } from "@/state/rpc"
import { useStore } from "@/state/store"

type Tab = "general" | "agents" | "appearance" | "usage" | "about"

const TABS: [Tab, string, string][] = [
  ["general", "General", "Defaults for new threads and notifications."],
  ["agents", "Agents", "Coding agents installed on this Mac."],
  ["appearance", "Appearance", "Theme and window material."],
  ["usage", "Usage", "Tokens and cost by agent, model or day."],
  ["about", "About", "Daemon, protocol and data folder."],
]

export function SettingsDialog() {
  const open = useStore((s) => s.settingsOpen)
  const set = useStore((s) => s.set)
  const tab = useStore((s) => s.settingsTab)
  const current = TABS.find((t) => t[0] === tab) ?? TABS[0]!
  return (
    <Dialog open={open} onOpenChange={(o) => set({ settingsOpen: o })}>
      <DialogPopup className="app-settings-surface h-[560px] max-w-[860px] flex-row overflow-hidden p-0" bottomStickOnMobile={false}>
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">Configure kybern</DialogDescription>
        <nav className="flex w-52 shrink-0 flex-col border-r border-[color:var(--color-border-light)] px-1.5 py-1.5 pt-4 font-system-ui">
          <h2 className="px-2 py-1 text-[length:var(--app-font-size-ui,12px)] font-normal text-muted-foreground/58">Settings</h2>
          <ul className="flex flex-col gap-0.5">
            {TABS.map(([v, label]) => (
              <li key={v}>
                <button
                  type="button"
                  onClick={() => set({ settingsTab: v })}
                  className={cn("w-full", SIDEBAR_HEADER_ROW_CLASS_NAME, tab === v ? SIDEBAR_ROW_ACTIVE_CLASS_NAME : cn(SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME, SIDEBAR_ROW_HOVER_CLASS_NAME))}
                >
                  <span className="truncate">{label}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-2xl px-6 py-8">
            <div className="mb-8 flex items-start justify-between gap-4">
              <div>
                <h1 className="text-xl font-medium tracking-tight text-foreground">{current[1]}</h1>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{current[2]}</p>
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

function Row({ title, description, status, children }: { title: string; description?: string; status?: string; children?: React.ReactNode }) {
  return (
    <div className={cn(SETTINGS_CARD_ROW_CLASS_NAME, "scroll-mt-24")}>
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-[14rem] flex-1 space-y-0.5">
          <div className="flex min-h-5 items-center gap-1.5">
            <h3 className={SETTINGS_CARD_ROW_TITLE_CLASS_NAME}>{title}</h3>
          </div>
          {description && <p className={SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME}>{description}</p>}
          {status && <p className="pt-1 text-[11px] text-muted-foreground">{status}</p>}
        </div>
        {children && <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">{children}</div>}
      </div>
    </div>
  )
}

function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: React.ReactNode; disabled?: boolean }[] }) {
  return (
    <div role="radiogroup" className="inline-flex w-full flex-wrap items-center gap-1 sm:w-auto sm:justify-end">
      {options.map((o) => (
        <Button
          key={o.value}
          size="sm"
          role="radio"
          aria-checked={value === o.value}
          disabled={o.disabled}
          variant={value === o.value ? "secondary" : "ghost"}
          className={cn("rounded-lg! flex-1 sm:flex-none", value !== o.value && "text-muted-foreground")}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </Button>
      ))}
    </div>
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
          <Segmented
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
          <Segmented
            value={settings.default_permission_mode}
            onChange={(v) => update({ default_permission_mode: v as PermissionMode })}
            options={(Object.keys(PERMISSION_LABEL) as PermissionMode[]).map((m) => ({ value: m, label: PERMISSION_LABEL[m] }))}
          />
        </Row>
        <Row title="Use a worktree for new threads" description="Each thread gets its own branch and folder. Projects can override this.">
          <Switch checked={settings.worktrees_default} onCheckedChange={(v) => update({ worktrees_default: v })} />
        </Row>
      </Section>
      <Section title="Threads">
        <Row title="Generate thread titles" description="Names the thread from its first message using the agent.">
          <Switch checked={settings.generate_titles} onCheckedChange={(v) => update({ generate_titles: v })} />
        </Row>
        <Row title="Show notifications" description="When a turn ends or an agent needs approval while kybern is in the background.">
          <Switch checked={settings.notifications} onCheckedChange={(v) => update({ notifications: v })} />
        </Row>
      </Section>
    </>
  )
}

function Agents() {
  const providers = useStore((s) => s.providers)
  return (
    <Section title="Agents on this Mac">
      {providers.map((p) => (
        <Row key={p.kind} title={p.display_name} description={p.available ? p.binary_path : (p.unavailable_reason ?? "Not found on PATH")}>
          {p.available ? (
            <span className="flex items-center gap-1.5 text-[length:var(--app-font-size-ui,12px)] text-muted-foreground tabular-nums">
              <CheckIcon className="size-3.5 text-success" /> {p.version ?? "Installed"}
            </span>
          ) : (
            <span className="text-[length:var(--app-font-size-ui,12px)] text-muted-foreground">Not found</span>
          )}
        </Row>
      ))}
      <Row title="" description="kybern looks for each agent's CLI on your PATH. Install one and reopen this window to use it." />
    </Section>
  )
}

function Appearance() {
  const { theme, setTheme } = useTheme()
  return (
    <Section title="Theme">
      <Row title="Appearance" description="Follows the system by default.">
        <Segmented
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
          <Segmented
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
          {data.rows.map((r) => {
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
                  <div className="h-full rounded-full bg-foreground/70 transition-[width] duration-500 ease-out" style={{ width: `${(n / max) * 100}%` }} />
                </div>
              </div>
            )
          })}
        </Section>
      )}
    </>
  )
}

function About() {
  const info = useStore((s) => s.info)
  return (
    <Section title="About">
      <Row title="Daemon" description={info?.version ?? "…"} />
      <Row title="Protocol" description={info?.protocol_version ?? "…"} />
      <Row title="Host" description={info ? `${info.hostname} · ${info.os} ${info.arch}` : "…"} />
      <Row title="Data" description={info?.data_dir ?? "…"} />
    </Section>
  )
}
