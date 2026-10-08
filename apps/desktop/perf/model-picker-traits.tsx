// The model picker over a synthetic Cursor catalog: one row per model with
// context and fast traits. No daemon or provider. `?theme=dark|light`, `?model=<index>` (5 is GPT-5.5, which lacks 1M with Fast), `?variant=<n>` for that model's n-th combination.
import { useState } from "react"
import { createRoot } from "react-dom/client"
import { ModelPicker } from "../src/components/kybern/ModelPicker"
import { ProviderMark } from "../src/components/kybern/bits"
import { buildThemeCssVariables, DEFAULT_THEME_STATE } from "../src/lib/kit/theme/theme.logic"
import type { ProviderModel, ProviderStatus } from "../src/protocol"
import { findModel, selectedVariant, traitSummary } from "../../../packages/kybern-client/src/models"
import "../src/index.css"

/* eslint-disable react-refresh/only-export-components -- standalone fixture entry, never hot-swapped */

const params = new URLSearchParams(location.search)
const variant: "dark" | "light" = params.get("theme") === "light" ? "light" : "dark"
const root = document.documentElement
root.classList.toggle("dark", variant === "dark")
root.dataset.windowMaterial = "opaque"
root.dataset.runtime = "electron"
root.dataset.platform = "macos"
const built = buildThemeCssVariables({ codeThemeId: DEFAULT_THEME_STATE.codeThemeIds[variant], theme: DEFAULT_THEME_STATE.chromeThemes[variant] }, variant, { electron: true, isMac: true, systemUiFont: true })
for (const [key, value] of Object.entries(built.variables)) root.style.setProperty(key, value)
root.style.setProperty("--app-font-size-ui", "12px")
root.style.setProperty("--app-font-size-ui-sm", "11px")

const selector = (id: string, context: string, fast: string, efforts: string[], effortParam = "effort") =>
  `cursor-model:${btoa(JSON.stringify({ id, params: [{ id: "context", value: context }, { id: "fast", value: fast }], effortParam, effortValues: efforts, defaultEffort: "medium" })).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`
const ALL_COMBOS: readonly (readonly [string, string])[] = [["300000", "false"], ["300000", "true"], ["1000000", "false"], ["1000000", "true"]]
function traited(id: string, name: string, efforts: string[], description?: string, combos = ALL_COMBOS, effortParam = "effort"): ProviderModel {
  const variants = combos.map(([context, fast]) => ({ id: selector(id, context, fast, efforts, effortParam), params: { context, fast }, efforts, default_effort: "medium" }))
  return {
    id: variants[0]!.id, display_name: name, resolved_id: id, description, efforts, default_effort: "medium", provider: null,
    parameters: [
      { id: "context", label: "Context", default: "300000", values: [{ value: "300000", label: "300K" }, { value: "1000000", label: "1M" }] },
      { id: "fast", label: "Fast", default: "false", values: [{ value: "false", label: "Off" }, { value: "true", label: "On" }] },
    ],
    variants,
  }
}
const models: ProviderModel[] = [
  { id: "default", display_name: "Default", description: "Cursor’s default model", is_default: true },
  traited("claude-opus-5-5", "Claude Opus 5.5", ["low", "medium", "high", "max"]),
  traited("claude-sonnet-5", "Claude Sonnet 5", ["low", "medium", "high"]),
  { id: "grok-4.7", display_name: "Grok 4.7", efforts: ["low", "medium", "high"], default_effort: "medium" },
  { id: "composer-2", display_name: "Composer 2" },
  // GPT-like: effort travels as `reasoning`, and Cursor offers no 1M context with Fast.
  traited("gpt-5.5", "GPT-5.5", ["low", "medium", "high", "xhigh"], undefined, [["300000", "false"], ["300000", "true"], ["1000000", "false"]], "reasoning"),
  { id: "gpt-5.6-sol", display_name: "GPT-5.6 Sol", efforts: ["low", "medium", "high"], default_effort: "medium" },
]
const status: ProviderStatus = {
  kind: "cursor", display_name: "Cursor", available: true, supported_permission_modes: ["auto", "full-access"],
  supports_fork: false, supports_model_switch: true, supports_effort_switch: true, models, instances: ["default"],
} as ProviderStatus

function Fixture() {
  const start = models[Number(params.get("model") ?? 1)]!
  const [model, setModel] = useState<string | null>(start.variants?.[Number(params.get("variant") ?? 0)]?.id ?? start.id)
  const [effort, setEffort] = useState<string | null>("medium")
  const current = model ? findModel(models, model) : undefined
  const traits = traitSummary(current, model)
  const shownEffort = effort ?? selectedVariant(current, model)?.default_effort
  return (
    <div className="flex h-screen items-end justify-end bg-[var(--color-background-surface)] p-6 text-foreground">
      <ModelPicker
        provider={{ kind: "cursor", instance: "default" }}
        providers={[status]}
        model={model}
        effort={effort}
        canPickModel
        canPickProvider={false}
        canReload={false}
        loading={false}
        busy={false}
        onModelChange={async (next, nextEffort) => { setModel(next); setEffort(nextEffort ?? null); return true }}
        onEffortChange={async (next) => { setEffort(next); return true }}
        onProviderChange={async () => true}
        onReload={() => {}}
        trigger={
          <button type="button" id="trigger" className="inline-flex h-7 items-center gap-1.5 rounded-full px-2 text-[11px] text-[var(--color-text-foreground-secondary)] hover:bg-[var(--color-background-button-secondary-hover)]">
            <ProviderMark kind="cursor" size={14} className="size-3.5" />
            <span>{current?.display_name}{traits ? ` · ${traits}` : ""}</span>
            {shownEffort && <span className="opacity-60">{shownEffort[0]!.toUpperCase() + shownEffort.slice(1)}</span>}
          </button>
        }
      />
    </div>
  )
}
createRoot(document.getElementById("root")!).render(<Fixture />)
