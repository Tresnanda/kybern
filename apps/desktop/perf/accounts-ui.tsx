/* eslint-disable react-refresh/only-export-components */
// Visual fixture for Settings › Accounts and the Add account sheet: a mocked daemon,
// no processes, no credentials. Query: ?theme=light|dark &scene=<name> &remote=1
// Scenes: settings, pick, waiting, paste, paste-wrong, device, success, duplicate, error.
import { createRoot } from "react-dom/client"
import { useEffect } from "react"
import { Toaster } from "../src/components/ui/sonner"
import { ThemeProviderContext } from "../src/components/theme-context"
import { SettingsScreen } from "../src/views/SettingsScreen"
import { AddAccountSheet, openAddAccount } from "../src/components/kybern/accounts/AddAccountSheet"
import { setEnvironmentRuntime } from "../src/state/rpc"
import { useEnvironments } from "../src/state/environments"
import { useStore } from "../src/state/store"
import { attachUsageFeed } from "../src/state/usageLimits"
import { refreshAccounts } from "../src/state/accounts"
import { buildThemeCssVariables, DEFAULT_THEME_STATE } from "../src/lib/kit/theme/theme.logic"
import { RpcCallError } from "../src/protocol"
import type { AccountLogin, AccountSummary, ProviderStatus, Settings } from "../src/protocol"
import "../src/index.css"

const query = new URLSearchParams(location.search)
const theme = query.get("theme") === "light" ? "light" : "dark"
const scene = query.get("scene") ?? "settings"
const remote = query.get("remote") === "1"
const legacy = query.get("legacy") === "1"

const account = (kind: AccountSummary["provider"]["kind"], instance: string, name: string, patch: Partial<AccountSummary> = {}): AccountSummary => ({
  provider: { kind, instance }, name, status: "signed_in", is_default: false, projects: [], managed: instance !== "default", can_sign_out: instance !== "default", ...patch,
})
const accounts: AccountSummary[] = [
  account("claude-code", "default", "CLI account", { identity: { email: "tresh@kembardigital.id", plan: "Max" }, is_default: true, can_sign_out: false, managed: false }),
  account("claude-code", "work", "Arunika", { color: "green", identity: { email: "dev@arunika.co", plan: "Pro", organization: "Arunika Studio" }, projects: ["/p/kybern", "/p/site"], directory: "/Users/me/.kybern/accounts/claude-code/work" }),
  account("claude-code", "personal", "Personal", { color: "purple", status: "needs_sign_in", identity: { email: "tresh.pro@gmail.com", plan: "Pro" }, managed: false, directory: "/Users/me/.claude-personal" }),
  account("codex", "default", "CLI account", { identity: { email: "tresh@kembardigital.id", plan: "Plus" }, is_default: true, status: "signed_in", can_sign_out: false, managed: false }),
  account("cursor", "default", "CLI account", { status: "unknown", is_default: true, managed: false, can_sign_out: false }),
]
const providers: ProviderStatus[] = (["claude-code", "codex", "cursor", "omp", "opencode"] as const).map((kind) => ({
  kind, display_name: { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor", omp: "Oh My Pi", opencode: "OpenCode" }[kind], available: kind !== "opencode", supported_permission_modes: ["supervised"], supports_fork: true, supports_model_switch: true, instances: ["default"], models: [],
}))
const settings = { default_provider: "claude-code", default_permission_mode: "supervised", worktrees_default: true, generate_titles: true, notifications: true, auto_update_harnesses: false, auto_update_daemon: false, tell_agents_about_kybern: true, background: { session_idle_minutes: 15, max_idle_sessions: 3, terminal_idle_minutes: 30, daemon_idle_exit_minutes: 0, save_power_on_battery: true }, access: { tailscale: false }, computer_use: { enabled: false, foreground: "ask" }, orchestration: { max_active_children: 4, max_depth: 2 }, providers: { "claude-code": { env: {}, project_accounts: { "/p/kybern": "work", "/p/ui": "personal" }, accounts: { work: { name: "Arunika", directory: "/x" }, personal: { name: "Personal", directory: "/y" } } } } } as unknown as Settings

const base = (patch: Partial<AccountLogin>): AccountLogin => ({ id: "login-1", kind: query.get("kind") === "codex" ? "codex" : "claude-code", mode: "browser", phase: "waiting", url: "https://claude.com/cai/oauth/authorize?code=true", expires_at: new Date(Date.now() + 900_000).toISOString(), ...patch })
const signedIn = base({ phase: "signed_in", identity: { email: "dev@arunika.co", plan: "Pro", organization: "Arunika Studio" }, suggested_name: "Arunika Studio", suggested_color: "teal" })
let login: AccountLogin = base({})
const script: Record<string, () => AccountLogin> = {
  pick: () => base({}),
  waiting: () => base({}),
  paste: () => base({ mode: "paste", url: "https://platform.claude.com/oauth/code/callback" }),
  "paste-wrong": () => base({ mode: "paste", url: "https://platform.claude.com/oauth/code/callback" }),
  device: () => base({ kind: "codex", mode: "device_code", url: "https://auth.openai.com/codex/device", user_code: "ABCD-12345" }),
  success: () => signedIn,
  duplicate: () => ({ ...signedIn, duplicate_of: "work", suggested_name: undefined }),
  error: () => base({ phase: "failed", error: "Claude Code didn't open a sign-in page. Show the terminal to finish there." }),
}
const client = {
  async call(method: string, params: never) {
    const p = params as Record<string, unknown>
    if (method === "providers.accounts.list") {
      if (legacy) throw new RpcCallError({ code: -32601, message: "method not found: providers.accounts.list" })
      return { accounts }
    }
    if (method === "providers.accounts.login.start") { login = (script[scene] ?? script.waiting)(); if ((p.mode as string) === "paste") login = { ...login, mode: "paste" }; return login }
    if (method === "providers.accounts.login.get") return login
    if (method === "providers.accounts.login.input") { if (scene === "paste-wrong") { login = { ...login, error: "bad code" }; return login } return { ...login, phase: "verifying" } }
    if (method === "providers.accounts.login.cancel") return { ...login, phase: "canceled" }
    if (method === "providers.accounts.login.finish") return { kind: "claude-code", instance: "new" }
    if (method === "usage.limits") return { providers: [], accounts: [
      { provider: "claude-code", instance: "default", limits: [{ name: "five_hour", window_minutes: 300, used_percent: 38, resets_at: Math.floor(Date.now() / 1000) + 5000 }] },
      { provider: "claude-code", instance: "work", limits: [{ name: "five_hour", window_minutes: 300, used_percent: 84, resets_at: Math.floor(Date.now() / 1000) + 5000 }] },
      { provider: "codex", instance: "default", limits: [{ name: "five_hour", window_minutes: 300, used_percent: 12, resets_at: Math.floor(Date.now() / 1000) + 5000 }] },
    ] }
    return {}
  },
  onNotification() { return () => {} },
}

function Harness() {
  useEffect(() => {
    if (scene === "settings") return
    void refreshAccounts().then(() => openAddAccount({ kind: query.get("kind") === "codex" ? "codex" : "claude-code" }))
  }, [])
  return (
    <ThemeProviderContext value={{ theme, translucent: false, setTheme: () => {}, setTranslucent: () => {} }}>
      <div style={{ position: "fixed", inset: 0 }} className="app-settings-surface text-foreground">
        <SettingsScreen />
      </div>
      <AddAccountSheet />
      <Toaster theme={theme} />
    </ThemeProviderContext>
  )
}

async function run() {
  // The sheet opens the sign-in page in a browser; the fixture must never leave itself.
  window.open = () => null
  document.documentElement.classList.toggle("dark", theme === "dark")
  document.documentElement.dataset.runtime = "electron"
  document.documentElement.dataset.platform = "macos"
  document.documentElement.dataset.windowMaterial = "opaque"
  const tokens = buildThemeCssVariables({ codeThemeId: DEFAULT_THEME_STATE.codeThemeIds[theme], theme: DEFAULT_THEME_STATE.chromeThemes[theme] }, theme, { electron: true, isMac: true, systemUiFont: true })
  for (const [key, value] of Object.entries(tokens.variables)) document.documentElement.style.setProperty(key, value)
  setEnvironmentRuntime({ rpc: () => client } as never)
  useEnvironments.setState({
    selectedId: remote ? "studio" : "local",
    profiles: [remote ? { id: "studio", name: "studio-mac", url: null, environment_id: "e2", hostname: "studio-mac", local: false, ssh: { host: "studio-mac" } as never } : { id: "local", name: "This Mac", url: null, environment_id: "e1", hostname: null, local: true }],
  })
  useStore.getState().set({ settings, providers, projects: { a: { id: "a", name: "kybern", path: "/p/kybern", is_git: true }, b: { id: "b", name: "marketing site", path: "/p/site", is_git: true }, c: { id: "c", name: "ade-ui-rework", path: "/p/ui", is_git: true } } as never, settingsOpen: true, settingsTab: "accounts", connection: { state: "open" } as never })
  attachUsageFeed(client as never, useStore.getState().environmentId)
  createRoot(document.getElementById("root")!).render(<Harness />)
}
void run()
