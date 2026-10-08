/* eslint-disable react-refresh/only-export-components */
// Visual fixture for the account surfaces outside Settings: the rail usage popover,
// the Usage page, the composer's model picker (account strip and follow line) and
// the merged status glyph. A mocked daemon: no processes, no credentials.
// Query: ?scene=rail|usage|picker|glyph|trigger &theme=light|dark &follow=0|1 &agent=claude-code|codex
//        &width=<px> &draft=1 (picker in a draft: no follow line)
import { createRoot } from "react-dom/client"
import { useState } from "react"
import { ThemeProviderContext } from "../src/components/theme-context"
import { Composer } from "../src/views/Composer"
import { RailUsage } from "../src/views/RailUsage"
import { UsagePage } from "../src/views/UsagePage"
import { setEnvironmentRuntime } from "../src/state/rpc"
import { useStore } from "../src/state/store"
import { refreshAccounts } from "../src/state/accounts"
import { useUsageLimits } from "../src/state/usageLimits"
import { buildThemeCssVariables, DEFAULT_THEME_STATE } from "../src/lib/kit/theme/theme.logic"
import type { AccountSummary, ProviderInstance, ProviderKind, ProviderLimits, ProviderModel, ProviderStatus } from "../src/protocol"
import "../src/index.css"

const query = new URLSearchParams(location.search)
const theme = query.get("theme") === "light" ? "light" : "dark"
const scene = query.get("scene") ?? "picker"
const width = Number(query.get("width") ?? 720)
const draft = query.get("draft") === "1"
const now = Math.floor(Date.now() / 1000)
const lastActivity = new Date(Date.now() - 60_000).toISOString()

const account = (kind: ProviderKind, instance: string, name: string, patch: Partial<AccountSummary> = {}): AccountSummary => ({
  provider: { kind, instance }, name, status: "signed_in", is_default: false, projects: [], managed: instance !== "default", can_sign_out: instance !== "default", ...patch,
})
const accounts: AccountSummary[] = [
  account("claude-code", "default", "CLI account", { identity: { email: "tresh@kembardigital.id", plan: "Max" }, can_sign_out: false, managed: false }),
  account("claude-code", "work", "Work", { color: "blue", is_default: true, identity: { email: "dev@arunika.co", plan: "Pro" } }),
  account("claude-code", "personal", "Personal", { color: "purple", identity: { email: "tresh.pro@gmail.com", plan: "Pro" } }),
  account("claude-code", "arunika", "Arunika", { color: "green", status: "needs_sign_in", identity: { email: "ops@arunika.co", plan: "Team" } }),
  account("codex", "default", "CLI account", { is_default: true, identity: { email: "tresh@kembardigital.id", plan: "Plus" }, can_sign_out: false, managed: false }),
  account("cursor", "default", "CLI account", { is_default: true, status: "unknown", can_sign_out: false, managed: false }),
]
const limit = (name: string, minutes: number, used: number) => ({ name, window_minutes: minutes, used_percent: used, resets_at: now + minutes * 60 * 0.4 })
const entry = (provider: ProviderKind, instance: string | undefined, plan: string, used5: number, usedWeek: number): ProviderLimits => ({
  provider, ...(instance ? { instance } : {}), plan, updated_at: new Date().toISOString(), source: "live" as never, limits: [limit("five_hour", 300, used5), limit("seven_day", 10080, usedWeek)],
})
const globalLimits = [entry("claude-code", undefined, "Pro", 38, 21), entry("codex", undefined, "Plus", 12, 8)]
const accountLimits = [entry("claude-code", "default", "Max", 62, 40), entry("claude-code", "work", "Pro", 38, 21), entry("claude-code", "personal", "Pro", 82, 55), entry("codex", "default", "Plus", 12, 8)]

const efforts = ["low", "medium", "high", "xhigh"]
const claude: ProviderModel[] = ["Claude Opus 5.5", "Claude Fable 5.1", "Claude Sonnet 5.5", "Claude Haiku 4.5"].map((display_name, i) => ({ id: display_name.toLowerCase().replace(/\s+/g, "-"), display_name, efforts, default_effort: "medium", is_default: i === 0 }))
// `?traits=1`: Opus carries Context and Fast traits and the trigger shows 1M with Fast on.
const traited = query.get("traits") === "1"
if (traited) {
  const params = [["300000", "false"], ["300000", "true"], ["1000000", "false"], ["1000000", "true"]] as const
  const variants = params.map(([context, fast]) => ({ id: `claude-opus-5.5-${context}-${fast}`, params: { context, fast }, efforts, default_effort: "medium" }))
  claude[0] = {
    ...claude[0]!, id: variants[0]!.id, variants,
    parameters: [
      { id: "context", label: "Context", default: "300000", values: [{ value: "300000", label: "300K" }, { value: "1000000", label: "1M" }] },
      { id: "fast", label: "Fast", default: "false", values: [{ value: "false", label: "Off" }, { value: "true", label: "On" }] },
    ],
  } as ProviderModel
}
const status = (kind: ProviderKind, display_name: string, models: ProviderModel[], available = true): ProviderStatus => ({
  kind, display_name, available, models, supports_model_switch: true, supported_permission_modes: ["supervised", "auto", "full-access"], supported_efforts: efforts, instances: ["default"],
} as unknown as ProviderStatus)
const providers = [status("claude-code", "Claude Code", claude), status("codex", "Codex", claude.slice(0, 2)), status("cursor", "Cursor", claude.slice(0, 1)), status("opencode", "OpenCode", [], false)]

const summaryRow = (key: string, turns: number, input: number) => ({ key, turns, usage: { input_tokens: input, output_tokens: input / 8, cache_read_tokens: input * 3, cache_write_tokens: input / 4 }, cost_usd: input / 40000 })
const client = {
  async call(method: string) {
    if (method === "providers.accounts.list") return { accounts }
    if (method === "usage.limits") return { providers: globalLimits, accounts: accountLimits }
    if (method === "usage.summary") return { scope: "all", rows: [summaryRow("claude-code", 120, 4_200_000), summaryRow("codex", 40, 900_000)], total: summaryRow("total", 160, 5_100_000) }
    return {}
  },
  onNotification() { return () => {} },
}

function Surface({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProviderContext value={{ theme, translucent: false, setTheme: () => {}, setTranslucent: () => {} }}>
      <div className="app-settings-surface text-foreground" style={{ minHeight: "100vh", width: "100%" }}>{children}</div>
    </ThemeProviderContext>
  )
}

function ComposerScene() {
  const kind = (query.get("agent") ?? "claude-code") as ProviderKind
  const [pick, setPick] = useState<{ instance: string; follows: boolean }>(query.get("follow") === "0" ? { instance: "personal", follows: false } : query.get("account") === "cli" ? { instance: "default", follows: false } : { instance: kind === "claude-code" ? "work" : "default", follows: true })
  const [provider, setProvider] = useState<ProviderInstance>({ kind, instance: draft ? "default" : pick.instance })
  const current = draft ? provider : { kind: provider.kind, instance: pick.instance }
  return (
    <div style={{ width, maxWidth: "100vw", padding: "520px 16px 24px" }}>
      <Composer
        projectId="project"
        provider={current}
        providers={providers}
        showProviderUsage={!draft}
        providerUsage={draft ? undefined : { context: { used_tokens: 84_000, window_tokens: 200_000 }, limits: [] } as never}
        promptCache={draft ? undefined : { window: { ttlMinutes: 5, providerLabel: "Claude Code" }, lastActivityAt: lastActivity }}
        accountFollowsDefaults={draft ? undefined : pick.follows}
        onAccountChange={draft ? undefined : (instance) => setPick(instance === null ? { instance: "work", follows: true } : { instance, follows: false })}
        onProviderChange={(next) => { setProvider(next); setPick({ instance: next.instance, follows: true }) }}
        model={traited ? "claude-opus-5.5-1000000-true" : "claude-opus-5.5"}
        effort="high"
        onModelChange={() => {}}
        mode="supervised"
        onModeChange={() => {}}
        onSend={async () => {}}
      />
    </div>
  )
}

function Rail() {
  return (
    <div style={{ width: 56, minHeight: "100vh", padding: "520px 0 24px", background: "var(--sidebar, var(--color-background-surface))" }}>
      <RailUsage />
    </div>
  )
}

function Scene() {
  if (scene === "rail") return <Rail />
  if (scene === "usage") return <div className="settings-page settings-page-wide" style={{ maxWidth: width, padding: 24 }}><UsagePage /></div>
  return <ComposerScene />
}

const click = (selector: string, delay = 200) => new Promise<void>((resolve) => setTimeout(() => { document.querySelector<HTMLElement>(selector)?.click(); resolve() }, delay))

async function run() {
  document.documentElement.classList.toggle("dark", theme === "dark")
  document.documentElement.dataset.runtime = "electron"
  document.documentElement.dataset.platform = "macos"
  document.documentElement.dataset.windowMaterial = "opaque"
  const tokens = buildThemeCssVariables({ codeThemeId: DEFAULT_THEME_STATE.codeThemeIds[theme], theme: DEFAULT_THEME_STATE.chromeThemes[theme] }, theme, { electron: true, isMac: true, systemUiFont: true })
  for (const [key, value] of Object.entries(tokens.variables)) document.documentElement.style.setProperty(key, value)
  document.documentElement.style.setProperty("--app-font-size-ui", "12px")
  document.documentElement.style.setProperty("--app-font-size-ui-sm", "11px")
  document.body.style.background = "var(--background)"
  setEnvironmentRuntime({ rpc: () => client } as never)
  useStore.getState().set({ providers, connection: { state: "open" } as never, settings: { providers: { "claude-code": { env: {}, default_account: "work", accounts: { work: { name: "Work", directory: "/w" }, personal: { name: "Personal", directory: "/p" }, arunika: { name: "Arunika", directory: "/a" } } } } } as never })
  useUsageLimits.setState({ ownerKey: useStore.getState().environmentId, providers: globalLimits, accounts: accountLimits, refreshing: [], loaded: true })
  await refreshAccounts()
  createRoot(document.getElementById("root")!).render(<Surface><Scene /></Surface>)
  if (scene === "rail") await click('[data-testid="rail-usage-claude-code"]', 400)
  if (scene === "picker") await click('[aria-label^="Change model and reasoning"]', 400)
  if (scene === "glyph") await click('.composer-status-glyph', 400)
}
void run()
