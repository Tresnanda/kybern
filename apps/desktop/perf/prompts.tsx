import { createRoot } from "react-dom/client"
import { useState } from "react"
import { flushSync } from "react-dom"
import { Composer } from "../src/views/Composer"
import { QueuedPanel } from "../src/views/Thread"
import { ThreadNotes } from "../src/views/ThreadNotes"
import { ThemeProviderContext } from "../src/components/theme-context"
import { buildThemeCssVariables, DEFAULT_THEME_STATE } from "../src/lib/kit/theme/theme.logic"
import { useStore } from "../src/state/store"
import { emptyThreadState } from "../src/state/transcript"
import { transport } from "./prompts-rpc"
import type { ProviderStatus, UserMessage } from "../src/protocol"
import "../src/index.css"

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
function check(value: unknown, label: string): asserts value { if (!value) throw new Error(label) }
async function waitFor(condition: () => unknown, label: string) {
  const deadline = performance.now() + 3000
  while (!condition() && performance.now() < deadline) await sleep(20)
  check(condition(), label)
}
function button(text: string) { return [...document.querySelectorAll<HTMLButtonElement>("button")].find(el => el.textContent?.trim() === text)! }
function input(label: string) { return document.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`)! }
function write(element: HTMLTextAreaElement, text: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(element, text)
  element.dispatchEvent(new Event("input", { bubbles: true }))
}
function theme(variant: "light" | "dark") {
  document.documentElement.classList.toggle("dark", variant === "dark")
  const built = buildThemeCssVariables({ codeThemeId: DEFAULT_THEME_STATE.codeThemeIds[variant], theme: DEFAULT_THEME_STATE.chromeThemes[variant] }, variant, { electron: true, isMac: true, systemUiFont: true })
  for (const [key, value] of Object.entries(built.variables)) document.documentElement.style.setProperty(key, value)
}
const sent: { mode: string; message: UserMessage }[] = []
let failSteer = false
const modelChanges: { model: string | undefined; effort: string | undefined }[] = []
let failModel = false
const claude: ProviderStatus = { kind: "claude-code", display_name: "Claude Code", available: true, instances: ["default"], supported_permission_modes: ["supervised"], supports_fork: true, supports_model_switch: true, supports_effort_switch: false, models: [{ id: "opus", display_name: "Claude Opus", default_effort: "medium" }] }
export function ModelComposer({ emptyCatalog = false }: { emptyCatalog?: boolean }) {
  const [model, setModel] = useState("opus")
  return <div data-model-composer><Composer provider={{ kind: "claude-code", instance: "default" }} providers={[emptyCatalog ? { ...claude, models: [] } : claude]}
    model={model} mode="supervised" onModeChange={() => {}} onSend={() => {}}
    onModelChange={async (model, effort) => {
      if (failModel) throw new Error("Model was rejected. Try another ID.")
      modelChanges.push({ model, effort })
      setModel(model ?? "")
    }} /></div>
}
async function openCustomModel() {
  document.querySelector<HTMLButtonElement>('[data-model-composer] [aria-label="Change model and reasoning"]')!.click()
  await waitFor(() => !!document.querySelector('[role="menuitem"][aria-haspopup="menu"]'), "Model submenu is available")
  document.querySelector<HTMLElement>('[role="menuitem"][aria-haspopup="menu"]')!.click()
  await waitFor(() => !![...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(el => el.textContent?.includes("Use custom model")), "Custom model action is available")
  ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(el => el.textContent?.includes("Use custom model"))!.click()
  await waitFor(() => !!document.querySelector('[role="dialog"] input'), "Custom model dialog opens")
  return document.querySelector<HTMLInputElement>('[role="dialog"] input')!
}
function writeModel(element: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value)
  element.dispatchEvent(new Event("input", { bubbles: true }))
}
const root = createRoot(document.getElementById("root")!)
const attachment = { type: "attachment" as const, asset_id: "image", name: "mock.png", media_type: "image/png", size: 20 }
async function run() {
  for (const variant of ["light", "dark"] as const) {
    theme(variant)
    localStorage.clear()
    useStore.getState().set({ connection: { state: "open" }, transcripts: { fixture: { ...emptyThreadState(), loaded: true, notes: { text: "Saved note", revision: 1 } } }, queued: { fixture: [{ id: "first", message: { parts: [{ type: "text", text: "Initial follow-up" }, attachment] } }, { id: "second", message: { parts: [{ type: "text", text: "Second follow-up" }] } }] } })
    flushSync(() => root.render(<ThemeProviderContext value={{ theme: variant, translucent: false, setTheme: () => {}, setTranslucent: () => {} }}>
      <div key={variant} className="flex h-screen items-start gap-8 bg-background p-8 text-foreground">
        <div className="flex w-80 flex-col gap-3"><h2>Notes</h2><ThreadNotes threadId="fixture" /></div>
        <div className="flex min-w-0 flex-1 flex-col gap-4 pt-6">
          <Composer running provider={{ kind: variant === "dark" ? "pi" : "codex", instance: "default" }} providers={[]} mode="supervised" onModeChange={() => {}}
            onSend={message => { sent.push({ mode: "queue", message }) }}
            onSteer={message => { if (failSteer) throw new Error("Try steering again."); sent.push({ mode: "steer", message }) }} />
          <QueuedPanel threadId="fixture" />
          <ModelComposer emptyCatalog={variant === "dark"} />
        </div>
      </div>
    </ThemeProviderContext>))
    await sleep(100)
    check(input("Thread notes").value === "Saved note", "Notes hydrate")
    write(input("Thread notes"), "A note from this device\n☑ Verify mobile")
    await sleep(30)
    transport.fail = true
    button("Save notes").click()
    await waitFor(() => !!document.querySelector('[role="alert"]'), "Failed save is visible")
    check(input("Thread notes").value.includes("Verify mobile"), "Failed save retains draft")
    transport.fail = false
    button("Save notes").click()
    await waitFor(() => useStore.getState().transcripts.fixture?.notes?.revision === 2, "Notes save succeeds")
    write(input("Thread notes"), "Local conflict")
    await sleep(30)
    flushSync(() => useStore.getState().updateTranscript("fixture", state => ({ ...state, notes: { text: "Remote edit", revision: 3 } })))
    check(input("Thread notes").value === "Local conflict", "Remote edit retains local draft")
    check(button("Save notes").disabled, "Conflicting save cannot overwrite the remote edit")
    button("Reload saved notes").click()
    await waitFor(() => input("Thread notes").value === "Remote edit", "Reload uses remote notes")
    button("Edit").click()
    await sleep(30)
    write(input("Edit queued prompt"), "Updated follow-up")
    await sleep(30)
    button("Save").click()
    await waitFor(() => useStore.getState().queued.fixture?.[0]?.message.parts[0]?.type === "text" && useStore.getState().queued.fixture[0]!.message.parts[0].text === "Updated follow-up", "Queue edit is saved")
    const queue = useStore.getState().queued.fixture!
    check(queue[0]?.id === "first" && queue[1]?.id === "second", "Queue edit retains order")
    check(queue[0]?.message.parts.includes(attachment), "Queue edit retains attachment")
    const composer = document.querySelector<HTMLTextAreaElement>('textarea:not([aria-label="Thread notes"]):not([aria-label="Edit queued prompt"])')!
    write(composer, "After this turn")
    await sleep(30)
    button("Queue").click()
    await waitFor(() => sent.at(-1)?.mode === "queue" && composer.value === "", "Queue submits and clears")
    document.querySelector<HTMLButtonElement>('[aria-label="Choose prompt delivery"]')!.click()
    await waitFor(() => !!document.querySelector('[role="menuitem"]'), "Prompt menu opens")
    const steer = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(el => el.textContent?.includes("Guide the current turn"))!
    steer.click()
    await sleep(80)
    write(composer, "Guide the current turn")
    await sleep(30)
    failSteer = true
    button("Steer now").click()
    await sleep(60)
    check(composer.value === "Guide the current turn", "Rejected steering retains the prompt")
    failSteer = false
    button("Steer now").click()
    await waitFor(() => sent.at(-1)?.mode === "steer" && composer.value === "", "Steering submits separately from queue")
    write(composer, "Queue with Enter even when the button says steer")
    await sleep(30)
    composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    await waitFor(() => sent.at(-1)?.mode === "queue" && composer.value === "", "Enter always queues during work")
    write(composer, "Steer using the platform shortcut")
    await sleep(30)
    composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, ...(/Mac/.test(navigator.userAgent) ? { metaKey: true } : { ctrlKey: true }) }))
    await waitFor(() => sent.at(-1)?.mode === "steer" && composer.value === "", "Platform modifier steers during work")
    write(composer, "Keep composing")
    await sleep(30)
    const count = sent.length
    composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, shiftKey: true }))
    composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true }))
    await sleep(30)
    check(sent.length === count && composer.value === "Keep composing", "Newlines and IME confirmation do not send")
    check(!!document.querySelector('[aria-label="Stop generation"]'), "Stop remains independently available")
    const modelInput = await openCustomModel()
    const modelDialog = modelInput.closest<HTMLElement>('[data-slot="dialog-popup"]')!
    for (const width of [384, 320]) {
      modelDialog.style.maxWidth = `${width}px`
      await sleep(200)
      const surface = modelDialog.getBoundingClientRect()
      for (const control of [modelInput, button("Cancel"), button("Use model")]) {
        const rect = control.getBoundingClientRect()
        check(rect.top >= surface.top && rect.bottom <= surface.bottom && rect.left >= surface.left && rect.right <= surface.right, `Custom model controls stay inside the dialog at ${width}px`)
      }
    }
    modelDialog.style.removeProperty("max-width")
    writeModel(modelInput, "   ")
    await sleep(30)
    check(button("Use model").disabled, "Blank custom IDs cannot be submitted")
    writeModel(modelInput, "claude opus")
    await sleep(30)
    check(button("Use model").disabled, "Whitespace inside a model ID is rejected")
    writeModel(modelInput, "  claude-opus-4-8  ")
    await sleep(30)
    failModel = true
    button("Use model").click()
    await sleep(60)
    check(modelInput.value === "  claude-opus-4-8  " && !!document.querySelector('[role="dialog"]'), "Rejected model changes retain the custom ID")
    failModel = false
    button("Use model").click()
    await waitFor(() => modelChanges.at(-1)?.model === "claude-opus-4-8" && !document.querySelector('[role="dialog"]'), "Custom model applies without catalog membership")
    check(modelChanges.at(-1)?.effort === undefined, "Custom model does not change live effort")
    check(document.querySelector('[data-model-composer] [aria-label="Change model and reasoning"]')!.textContent!.includes("claude-opus-4-8"), "The exact custom ID remains visible")
    const reopened = await openCustomModel()
    check(reopened.value === "claude-opus-4-8", "Reopening preserves the custom selection")
    button("Cancel").click()
    await waitFor(() => !document.querySelector('[role="dialog"]'), "Cancel closes without another change")
  }
  await sleep(700)
  const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="queued-follow-up-row"]')]
  check(rows.every(row => Number(getComputedStyle(row).opacity) === 1 && getComputedStyle(row).filter === "none"), "Queued rows finish entering")
  await openCustomModel()
  await sleep(250)
  button("Cancel").click()
  await waitFor(() => !document.querySelector('[role="dialog"]'), "Custom dialog closes before Pi checks")
  const pi: ProviderStatus = { ...claude, kind: "pi", display_name: "Pi", supports_effort_switch: true, supported_efforts: ["off", "low", "high", "xhigh"], models: [
    { id: "custom/plain", display_name: "Plain model", efforts: [] },
    { id: "custom/reasoner", display_name: "Reasoner", efforts: ["low", "high"], default_effort: "high" },
  ] }
  for (const model of pi.models!) {
    flushSync(() => root.render(<ThemeProviderContext value={{ theme: "dark", translucent: false, setTheme: () => {}, setTranslucent: () => {} }}>
      <div className="h-screen bg-background p-8 text-foreground"><Composer key={model.id} provider={{ kind: "pi", instance: "default" }} providers={[pi]} model={model.id}
        mode="supervised" onModeChange={() => {}} onSend={() => {}} onModelChange={(model, effort) => { modelChanges.push({ model, effort }) }} /></div>
    </ThemeProviderContext>))
    document.querySelector<HTMLButtonElement>('[aria-label="Change model and reasoning"]')!.click()
    await waitFor(() => !!document.querySelector('[role="menu"]'), "Pi model controls open")
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!
    check(menu.textContent!.includes("Effort") === !!model.efforts?.length, "Pi only exposes thinking controls for reasoning models")
    if (model.efforts?.length) {
      check(!menu.textContent!.includes("Xhigh"), "Pi does not inherit unsupported global thinking levels")
      const low = [...menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(el => el.textContent?.trim().toLowerCase() === "low")!
      check(low, "Pi's supported low effort is available")
      low.click()
      await waitFor(() => modelChanges.at(-1)?.model === model.id && modelChanges.at(-1)?.effort === "low", "Pi thinking change reaches the model handler")
    } else {
      menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    }
    await sleep(250)
  }
  report({ pass: true, themes: ["light", "dark"], notesConflict: true, failedSaveRetention: true, queueEditAttachments: true, steeringAndQueue: ["codex", "pi"], keyboardDelivery: true, customModels: true, emptyModelCatalog: true, piThinkingCapabilities: true })
}
function report(value: unknown) {
  (window as unknown as { webkit: { messageHandlers: { bench: { postMessage: (text: string) => void } } } }).webkit.messageHandlers.bench.postMessage(JSON.stringify(value))
}
run().catch(error => report({ pass: false, error: String(error) }))
