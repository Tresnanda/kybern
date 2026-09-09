import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { Composer } from "../src/views/Composer"
import { QueuedPanel } from "../src/views/Thread"
import { ThreadNotes } from "../src/views/ThreadNotes"
import { ThemeProviderContext } from "../src/components/theme-context"
import { buildThemeCssVariables, DEFAULT_THEME_STATE } from "../src/lib/kit/theme/theme.logic"
import { useStore } from "../src/state/store"
import { emptyThreadState } from "../src/state/transcript"
import { transport } from "./prompts-rpc"
import type { UserMessage } from "../src/protocol"
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
          <Composer running provider={{ kind: "codex", instance: "default" }} providers={[]} mode="supervised" onModeChange={() => {}}
            onSend={message => { sent.push({ mode: "queue", message }) }}
            onSteer={message => { if (failSteer) throw new Error("Try steering again."); sent.push({ mode: "steer", message }) }} />
          <QueuedPanel threadId="fixture" />
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
    check(!!document.querySelector('[aria-label="Stop generation"]'), "Stop remains independently available")
  }
  await sleep(700)
  const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="queued-follow-up-row"]')]
  check(rows.every(row => Number(getComputedStyle(row).opacity) === 1 && getComputedStyle(row).filter === "none"), "Queued rows finish entering")
  report({ pass: true, themes: ["light", "dark"], notesConflict: true, failedSaveRetention: true, queueEditAttachments: true, steeringAndQueue: true })
}
function report(value: unknown) {
  (window as unknown as { webkit: { messageHandlers: { bench: { postMessage: (text: string) => void } } } }).webkit.messageHandlers.bench.postMessage(JSON.stringify(value))
}
run().catch(error => report({ pass: false, error: String(error) }))
