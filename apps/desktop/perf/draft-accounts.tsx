// Real runtime notifications and draft controls, with a local fake transport.
// No provider processes, login credentials, or model requests.
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { ThemeProviderContext } from "../src/components/theme-context"
import { buildThemeCssVariables, DEFAULT_THEME_STATE } from "../src/lib/kit/theme/theme.logic"
import { PROTOCOL_VERSION, type ProviderStatus, type Settings } from "../src/protocol"
import { refreshAccounts } from "../src/state/accounts"
import { createEnvironmentRuntime, setEnvironmentRuntime } from "../src/state/rpc"
import { useStore } from "../src/state/store"
import { Draft } from "../src/views/Draft"
import "../src/index.css"

const native = () => (window as unknown as { webkit: { messageHandlers: { bench: { postMessage: (text: string) => void } } } }).webkit.messageHandlers.bench
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
const at = new Date().toISOString()
const project = { id: "account-project", name: "Account switching", path: "/fixture/project", is_git: false, created_at: at, updated_at: at }
let settings = {
  default_provider: "claude-code", default_permission_mode: "full-access", worktrees_default: false,
  providers: { "claude-code": { env: {}, default_account: "second", accounts: { second: { name: "Second account", color: "green", directory: "/fixture/accounts/second" } } } },
  computer_use: { enabled: false },
} as unknown as Settings
const status: ProviderStatus = {
  kind: "claude-code", display_name: "Claude Code", available: true, instances: ["default", "second"],
  supported_permission_modes: ["supervised", "full-access"], supports_fork: true, supports_model_switch: true,
  supports_effort_switch: true, supported_efforts: ["medium", "high"],
  models: [{ id: "opus", display_name: "Claude Opus", is_default: true, default_effort: "medium", efforts: ["medium", "high"] }],
}
let holdCatalog = false
const held: { id: number; method: string; params: Record<string, unknown> }[] = []
class FixtureSocket {
  static current: FixtureSocket
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose = null
  onerror = null
  constructor() {
    FixtureSocket.current = this
    setTimeout(() => { this.readyState = 1; this.onopen?.() }, 0)
  }
  frame(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }) }
  reply(request: { id: number }, result: unknown) { this.frame({ jsonrpc: "2.0", id: request.id, result }) }
  send(text: string) {
    const request = JSON.parse(text)
    if (request.method === "providers.list" && holdCatalog) { held.push(request); return }
    queueMicrotask(() => this.reply(request, dispatch(request.method)))
  }
  close() { this.readyState = 3 }
}
function dispatch(method: string): unknown {
  if (method === "daemon.info") return { protocol_version: PROTOCOL_VERSION, environment_id: useStore.getState().environmentId }
  if (method === "events.subscribe") return { subscription_id: "fixture", head_seq: 0 }
  if (method === "providers.list") return { providers: [status] }
  if (method === "providers.accounts.catalog") return status
  if (method === "providers.accounts.list") return { accounts: [
    { provider: { kind: "claude-code", instance: "default" }, name: "CLI account", status: "signed_in", is_default: settings.providers["claude-code"]?.default_account == null, projects: [], managed: false, can_sign_out: false },
    { provider: { kind: "claude-code", instance: "second" }, name: "Second account", color: "green", status: "signed_in", is_default: settings.providers["claude-code"]?.default_account === "second", projects: [], managed: true, can_sign_out: true },
  ] }
  if (method === "projects.list") return { projects: [project] }
  if (method === "threads.list") return { threads: [] }
  if (method === "settings.get") return settings
  if (method === "queue.list") return { messages: [] }
  if (method === "skills.list") return { skills: [] }
  throw new Error(`Unexpected fixture RPC: ${method}`)
}
const trigger = () => document.querySelector<HTMLButtonElement>('button[aria-label^="Change model and reasoning"]')

async function run() {
  document.documentElement.classList.add("dark")
  document.documentElement.dataset.windowMaterial = "opaque"
  document.documentElement.dataset.platform = "macos"
  const tokens = buildThemeCssVariables({ codeThemeId: DEFAULT_THEME_STATE.codeThemeIds.dark, theme: DEFAULT_THEME_STATE.chromeThemes.dark }, "dark", { electron: true, isMac: true, systemUiFont: true })
  for (const [key, value] of Object.entries(tokens.variables)) document.documentElement.style.setProperty(key, value)
  window.fetch = async () => new Response(JSON.stringify({ ticket: "fixture" }))
  window.WebSocket = FixtureSocket as unknown as typeof WebSocket
  localStorage.setItem(`kybern.provider:${useStore.getState().environmentId}`, JSON.stringify({ kind: "claude-code", instance: "second" }))
  const runtime = createEnvironmentRuntime(useStore)
  setEnvironmentRuntime(runtime)
  runtime.connect({ url: "ws://fixture/ws", http_base: "http://fixture", token: "fixture" })
  await sleep(120)
  await refreshAccounts()
  check(useStore.getState().providers.length === 1, "Initial provider catalog did not hydrate")
  flushSync(() => createRoot(document.getElementById("root")!).render(
    <ThemeProviderContext value={{ theme: "dark", translucent: false, setTheme: () => {}, setTranslucent: () => {} }}>
      <main className="flex h-screen flex-col bg-background text-foreground"><Draft projectId={project.id} /></main>
    </ThemeProviderContext>,
  ))
  await sleep(200)
  check(trigger()?.textContent?.includes("Second account"), "Draft did not start on the second account")
  holdCatalog = true
  trigger()!.click()
  await sleep(180)
  const first = document.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Claude Code · CLI account"]')
  check(first, "The first Claude account tab is missing")
  first.click()
  await sleep(100)
  check(!trigger()?.textContent?.includes("Second account"), "Switching to the first account did not apply")
  // Account/default/identity changes are broadcast while catalog reads are still in flight.
  const claude = settings.providers["claude-code"]!
  settings = { ...settings, providers: { ...settings.providers, "claude-code": { ...claude, accounts: { ...claude.accounts, second: { ...claude.accounts!.second!, plan: "Max" } } } } }
  FixtureSocket.current.frame({ jsonrpc: "2.0", method: "settings.changed", params: { settings } })
  await sleep(100)
  check(useStore.getState().providersLoading, "Did not exercise a pending provider refresh")
  const retained = !!trigger() && trigger()!.getBoundingClientRect().width > 30
  native().postMessage(JSON.stringify({ stage: "switch-first-account-during-refresh", modelControlVisible: retained, providers: useStore.getState().providers.length }))
  check(retained, "The model/account control disappeared while switching back to the first Claude account")
  const second = document.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Claude Code · Second account"]')
  check(second, "The second account tab disappeared during refresh")
  second.click()
  await sleep(100)
  check(trigger()?.textContent?.includes("Second account"), "The second account cannot be selected during refresh")
  document.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Claude Code · CLI account"]')!.click()
  await sleep(100)
  check(trigger() && !trigger()!.textContent?.includes("Second account"), "The first account cannot be selected during refresh")
  // A failed background refresh must leave the last usable controls in place too.
  check(held.length > 0, "The fixture did not hold a catalog request")
  for (const request of held.splice(0)) FixtureSocket.current.frame({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "Fixture catalog temporarily unavailable" } })
  holdCatalog = false
  await sleep(120)
  check(trigger() && !useStore.getState().providersLoading, "A failed refresh left the account controls blank or loading")
  FixtureSocket.current.frame({ jsonrpc: "2.0", method: "settings.changed", params: { settings } })
  await sleep(120)
  check(trigger() && !trigger()!.textContent?.includes("Second account"), "Catalog completion replaced the selected first account")
  check(useStore.getState().providers.length === 1 && useStore.getState().providers[0]!.available, "The replacement catalog did not apply")
  // Close the panel for the final screenshot; retain the first account's trigger.
  if (trigger()!.getAttribute("aria-expanded") === "true") trigger()!.click()
  await sleep(220)
  runtime.disconnect()
  native().postMessage(JSON.stringify({ pass: true, firstAccountSelectable: true, bothAccountsSelectableDuringRefresh: true, modelControlRetainedAfterFailure: true }))
}
void run().catch((error) => native().postMessage(JSON.stringify({ pass: false, error: String(error), stack: error.stack })))
