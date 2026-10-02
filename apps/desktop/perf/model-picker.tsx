/* eslint-disable react-refresh/only-export-components */
// The composer's agent/model/effort panel against catalog shapes the harnesses
// really report: a described 7-model list (Claude), a large single-backend list
// with effort encoded in ids (Cursor), and a multi-backend list where one
// model name repeats under two backends (OMP with Cursor + OpenRouter).
// Synthetic catalogs only: no daemon or provider invocation.
// URL params: ?agent=omp|cursor|claude-code|codex|opencode &theme=dark|light &open=1 &q=<search>
import { Component, useState, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { Composer } from "../src/views/Composer"
import { ThemeProviderContext } from "../src/components/theme-context"
import { buildThemeCssVariables, DEFAULT_THEME_STATE } from "../src/lib/kit/theme/theme.logic"
import type { ProviderInstance, ProviderKind, ProviderModel, ProviderStatus } from "../src/protocol"
import "../src/index.css"

const params = new URLSearchParams(location.search)
const variant = params.get("theme") === "light" ? "light" : "dark"
const efforts = ["low", "medium", "high", "xhigh", "max"]

const claude: ProviderModel[] = [
  ["opus", "Claude Opus 5.5", "For complex work and everyday tasks"],
  ["fable", "Claude Fable 5.1", "For your toughest challenges"],
  ["sonnet", "Claude Sonnet 5.5", "Most efficient for simpler tasks"],
  ["haiku", "Claude Haiku 4.5", "Fastest for quick answers"],
  ["claude-sonnet-5", "Claude Sonnet 5", "Efficient for routine tasks"],
  ["claude-opus-5", "Claude Opus 5", "Best for everyday, complex tasks"],
  ["claude-fable-5", "Claude Fable 5", "Most capable for your hardest and longest work"],
].map(([id, display_name, description], i) => ({ id: id!, display_name: display_name!, description, efforts, default_effort: "medium", is_default: i === 0 }))

const codex: ProviderModel[] = ["GPT-6.1-Sol", "GPT-6-Astra", "GPT-6-Sol", "GPT-6-Luna", "GPT-5.6-Sol"].map((name, i) => ({ id: name.toLowerCase(), display_name: name, efforts: [...efforts, "ultra"], default_effort: "medium", is_default: i === 0 }))

const opencode: ProviderModel[] = ["big-pickle", "fledge-alpha-free", "ling-3.0-flash-fin-free", "grok-code", "qwen3-coder", "kimi-k2"].map((name) => ({ id: `opencode/${name}`, display_name: name, provider: "opencode" }))

const variants = ["Low", "Low Fast", "", "Fast", "High", "High Fast", "Extra High", "Extra High Fast"]
const cursorBases = ["Claude Opus 5.5 1M", "Claude Opus 5 1M", "Claude Opus 4.8 1M", "Claude Sonnet 5 1M", "Claude Fable 5 1M", "GPT-5.6 Sol 1M", "GPT-5.6 Luna 1M", "GPT-5.5", "GPT-5.4", "Grok 4.7", "Grok 4.6", "Gemini 3.7 Flash", "Gemini 3 Pro", "Codex 5.3", "Kimi K3", "Composer 2.5", "GLM 5"]
const cursor: ProviderModel[] = [
  { id: "auto", display_name: "Auto", is_default: true },
  ...cursorBases.flatMap((base) => variants.map((v) => ({ id: `${base} ${v}`.trim().toLowerCase().replace(/\s+/g, "-"), display_name: `${base} ${v}`.trim() }))),
]

const cursorBackend = ["Auto", "Claude Fable 5", "Claude Opus 5.5", "Claude Sonnet 5.5", "GPT-5.6 Sol", "Grok 4.7", "Grok 4.7 Fast", "Grok 4.6 Fast", "Gemini 3.7 Flash", "Kimi K3", "Composer 2.5"]
  .map((name) => ({ id: `cursor/${name === "Auto" ? "default" : name.toLowerCase().replace(/\s+/g, "-")}`, display_name: name, provider: "cursor", efforts: name === "Auto" ? undefined : efforts, is_default: name === "Auto" }))
const vendors: Record<string, string[]> = {
  "x-ai": ["Grok 4.7", "Grok 4.6", "Grok 4.5", "Grok 4.3", "Grok 4", "Grok Code Fast 1"],
  anthropic: ["Claude Opus 5.5", "Claude Fable 5.1", "Claude Sonnet 5.5", "Claude Haiku 4.5"],
  openai: ["GPT-6.1 Sol", "GPT-6 Astra", "GPT-5.6", "o5 mini"],
  google: ["Gemini 3.7 Pro", "Gemini 3.7 Flash", "Gemma 4 27B"],
  "meta-llama": ["Llama 5 405B", "Llama 5 70B"],
  mistralai: ["Mistral Large 3", "Codestral 3"],
  qwen: ["Qwen3 Coder", "Qwen3 Max"],
  deepseek: ["DeepSeek V4", "DeepSeek R2"],
}
const openrouter: ProviderModel[] = Object.entries(vendors).flatMap(([vendor, names]) => names.map((name) => ({ id: `openrouter/${vendor}/${name.toLowerCase().replace(/\s+/g, "-")}`, display_name: name, provider: "openrouter", efforts })))
// Pad to a realistic size so collapsing and the search cap are exercised.
for (let i = 0; openrouter.length < 560; i++) openrouter.push({ id: `openrouter/vendor-${i % 40}/model-${i}`, display_name: `Community Model ${i}`, provider: "openrouter" })
const omp = [{ id: "apple/on-device", display_name: "Apple AFM 3 Core", provider: "apple" }, ...cursorBackend, ...openrouter].sort((a, b) => (a.provider ?? "").localeCompare(b.provider ?? ""))

const status = (kind: ProviderKind, display_name: string, models: ProviderModel[], available = true): ProviderStatus => ({
  kind, display_name, available, models, supports_model_switch: true, supported_permission_modes: ["supervised", "auto", "full-access"],
  supported_efforts: [...new Set(models.flatMap((m) => m.efforts ?? []))],
} as unknown as ProviderStatus)
const providers: ProviderStatus[] = [
  status("claude-code", "Claude Code", claude),
  status("codex", "Codex", codex),
  status("opencode", "OpenCode", opencode),
  status("pi", "pi", [], false),
  status("omp", "Oh My Pi", omp),
  status("cursor", "Cursor", cursor),
]

const root = document.documentElement
root.classList.toggle("dark", variant === "dark")
root.dataset.windowMaterial = "opaque"
root.dataset.platform = "macos"
const built = buildThemeCssVariables({ codeThemeId: DEFAULT_THEME_STATE.codeThemeIds[variant], theme: DEFAULT_THEME_STATE.chromeThemes[variant] }, variant, { electron: true, isMac: true, systemUiFont: true })
for (const [key, value] of Object.entries(built.variables)) root.style.setProperty(key, value)
root.style.setProperty("--app-font-size-ui", "12px")
root.style.setProperty("--app-font-size-ui-lg", "13px")
root.style.setProperty("--app-font-size-ui-sm", "11px")
document.body.style.background = "var(--background)"

function App() {
  const [provider, setProvider] = useState<ProviderInstance>({ kind: (params.get("agent") ?? "omp") as ProviderKind, instance: "default" })
  const [choice, setChoice] = useState<Record<string, { model?: string; effort?: string }>>({ omp: { model: "openrouter/x-ai/grok-4.7", effort: "xhigh" }, "claude-code": { model: "opus", effort: "high" } })
  const current = choice[provider.kind]
  return (
    <ThemeProviderContext value={{ theme: variant, translucent: false, setTheme: () => {}, setTranslucent: () => {} }}>
      <div style={{ width: 720, maxWidth: "100vw", padding: "560px 16px 24px" }}>
        <Composer
          projectId="project"
          provider={provider}
          providers={providers}
          onProviderChange={(next, picked) => {
            setProvider(next)
            if (picked) setChoice((value) => ({ ...value, [next.kind]: picked }))
          }}
          model={current?.model}
          effort={current?.effort}
          onModelChange={(model, effort) => setChoice((value) => ({ ...value, [provider.kind]: { model, effort } }))}
          mode="full-access"
          onModeChange={() => {}}
          onSend={async () => {}}
        />
      </div>
    </ThemeProviderContext>
  )
}

class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  render() { return this.state.error ? <pre style={{ color: "tomato", whiteSpace: "pre-wrap" }}>{this.state.error.stack}</pre> : this.props.children }
}

createRoot(document.getElementById("root")!).render(<Boundary><App /></Boundary>)

if (params.get("open")) {
  setTimeout(() => {
    document.querySelector<HTMLElement>('[aria-label="Change model and reasoning"]')?.click()
    const q = params.get("q")
    if (q) setTimeout(() => {
      const input = document.querySelector<HTMLInputElement>('[role="combobox"]')
      if (!input) return
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
      setter.call(input, q)
      input.dispatchEvent(new Event("input", { bubbles: true }))
    }, 300)
  }, 500)
}
