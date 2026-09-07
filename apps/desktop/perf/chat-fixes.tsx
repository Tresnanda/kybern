import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { Composer } from "../src/views/Composer"
import { Transcript } from "../src/views/Transcript"
import { EnvironmentSwitcher } from "../src/views/EnvironmentSwitcher"
import { useStore } from "../src/state/store"
import { useEnvironments } from "../src/state/environments"
import { applyEvent, emptyThreadState } from "../src/state/transcript"
import { ThemeProviderContext } from "../src/components/theme-context"
import { buildThemeCssVariables, DEFAULT_THEME_STATE } from "../src/lib/kit/theme/theme.logic"
import type { ThreadEvent } from "../src/protocol"
import "../src/index.css"

const view = createRoot(document.getElementById("root")!)
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII="
const source = `data:image/png;base64,${png}`
function theme(variant: "light" | "dark") {
  document.documentElement.classList.toggle("dark", variant === "dark")
  document.documentElement.setAttribute("data-theme-variant", variant)
  const built = buildThemeCssVariables({ codeThemeId: DEFAULT_THEME_STATE.codeThemeIds[variant], theme: DEFAULT_THEME_STATE.chromeThemes[variant] }, variant, { electron: true, isMac: true, systemUiFont: true })
  for (const [key, value] of Object.entries(built.variables)) document.documentElement.style.setProperty(key, value)
}
async function openPreview(button: HTMLButtonElement, expected: string) {
  button.click()
  await sleep(250)
  const dialog = document.querySelector('[role="dialog"]')
  const image = dialog?.querySelector("img")
  check(image?.src === expected, "Preview lost the original image")
  await image.decode()
  check(image.naturalWidth > 0, "Preview did not decode")
  const close = dialog!.querySelector<HTMLButtonElement>('button[aria-label="Close"]')
  check(close, "Preview has no close button")
  close.click()
  await sleep(250)
  check(!document.querySelector('[role="dialog"]'), "Preview did not close")
  check(document.activeElement === button, "Preview did not restore focus")
}
async function run() {
  for (const variant of ["light", "dark"] as const) {
    theme(variant)
    let state = { ...emptyThreadState(), loaded: true }
    let seq = 0
    const publish = (payload: object) => {
      state = applyEvent(state, { ...payload, seq: ++seq, thread_id: "fixture", turn_id: "turn", at: "2026-09-07T00:00:00Z" } as ThreadEvent)
      flushSync(() => useStore.getState().set({ transcripts: { fixture: state } }))
    }
    useStore.getState().set({ connection: { state: "closed" }, expandedWork: {} })
    publish({ kind: "turn_started", message_id: "user", message: { parts: [{ type: "text", text: "First line\nSecond line" }, { type: "image", media_type: "image/png", data: png }] } })
    publish({ kind: "assistant_message_completed", message_id: "narration", origin: { kind: "root" }, text: "Inspecting the image.", thinking: null })
    publish({ kind: "image_received", id: "native-image", origin: { kind: "root" }, source })
    publish({ kind: "tool_call_started", call: { id: "view", name: "view_image", input: { path: "preview.png" }, parent_id: null }, origin: { kind: "root" } })
    publish({ kind: "tool_call_completed", tool_call_id: "view", output: { content: [{ type: "image", mimeType: "image/png", data: png }] }, is_error: false })
    flushSync(() => view.render(<ThemeProviderContext value={{ theme: variant, translucent: false, setTheme: () => {}, setTranslucent: () => {} }}><div className="flex h-screen flex-col"><Transcript threadId="fixture" bottomInset={0} /></div></ThemeProviderContext>))
    await sleep(300)
    const user = document.querySelector('[data-message-role="user"]')!
    const paragraph = user.querySelector("p")!
    const text = paragraph.firstChild!
    const first = document.createRange(); first.setStart(text, 0); first.setEnd(text, 5)
    const second = document.createRange(); second.setStart(text, 11); second.setEnd(text, 17)
    check(second.getBoundingClientRect().top > first.getBoundingClientRect().top, "Sent message collapsed the composer newline")
    await openPreview(user.querySelector<HTMLButtonElement>('[aria-label="Preview Attached image 1"]')!, source)
    check(document.querySelector('[data-timeline-row-kind="work"] .response-image-preview'), "Native image left its chronological work position")
    const generatedCanvas = document.createElement("canvas")
    generatedCanvas.width = 2; generatedCanvas.height = 1
    const generatedSource = generatedCanvas.toDataURL("image/png")
    publish({ kind: "tool_call_started", call: { id: "generate", name: "imageGeneration", input: {}, parent_id: null }, origin: { kind: "root" } })
    publish({ kind: "tool_call_completed", tool_call_id: "generate", output: { type: "imageGeneration", result: generatedSource.split(",")[1], outputFormat: "png" }, is_error: false })
    check(!document.querySelector('[data-response-images]'), "Generated image became a final response during the loop")
    publish({ kind: "assistant_message_completed", message_id: "final", origin: { kind: "root" }, text: "The final answer.", thinking: null })
    publish({ kind: "turn_completed", stop_reason: "completed", usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0 }, duration_ms: 1000, cost_usd: null, terminal_message_id: "final" })
    await sleep(300)
    check(document.querySelectorAll('.response-image-preview').length === 3, "Tool images were promoted into the final answer")
    check(document.querySelectorAll('[data-response-images] img').length === 2, "Generated image deliverable was hidden with tool screenshots")
    const worked = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Worked for"))!
    worked.click(); await sleep(250)
    check(document.querySelector('[data-response-images] .response-image-preview'), "Explicit assistant image was lost after completion")
    const toolGroup = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Used 2 tools")
    if (toolGroup?.getAttribute("aria-expanded") !== "true") { toolGroup?.click(); await sleep(250) }
    const tool = [...document.querySelectorAll("button")].find((button) => button.querySelector('[data-work-entry-display-text]')?.textContent?.includes("preview.png"))
    check(tool, "Image tool disappeared")
    tool.click(); await sleep(250)
    const toolImage = tool.parentElement?.querySelector<HTMLButtonElement>('.response-image-preview')
    check(toolImage && toolImage.getBoundingClientRect().height > 0, "Tool image is not available inside its result")
    await openPreview(toolImage, source)

    const blob = new Blob([Uint8Array.from(atob(png), (char) => char.charCodeAt(0))], { type: "image/png" })
    const url = URL.createObjectURL(blob)
    useStore.getState().set({ connection: { state: "open" }, composerDrafts: { image: { text: "Draft", attachments: [{ id: "upload", name: "Screenshot.png", media_type: "image/png", size: blob.size, preview: url }], mentions: [], skills: [] } } })
    flushSync(() => view.render(<div className="p-6"><Composer key={variant} draftKey="image" mode="full-access" onModeChange={() => {}} provider={null} providers={[]} onSend={() => {}} /></div>))
    await sleep(200)
    await openPreview(document.querySelector<HTMLButtonElement>('[aria-label="Preview Screenshot.png"]')!, url)
    document.querySelector<HTMLButtonElement>('[aria-label="Remove Screenshot.png"]')!.click()
    await sleep(100)
    check(!document.querySelector('[aria-label="Preview Screenshot.png"]'), "Preview interfered with removing an attachment")
    URL.revokeObjectURL(url)
  }

  // Show native-only menu actions without starting a production shell.
  const openedWindows: string[] = []
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {
    invoke: async (command: string, args: { id: string }) => {
      check(command === "environment_open_window", `Unexpected native operation: ${command}`)
      openedWindows.push(args.id)
    },
  }, configurable: true })
  useEnvironments.setState({ selectedId: "local", switching: false, profiles: [
    { id: "local", name: "This Mac", local: true, hostname: null, environment_id: "local", url: null },
    { id: "remote", name: "Os-kdi", local: false, hostname: "os-kdi", environment_id: "remote", url: "ws://example.test" },
  ] })
  for (const variant of ["light", "dark"] as const) {
    theme(variant)
    flushSync(() => view.render(<div style={{ width: 240, padding: 12 }}><EnvironmentSwitcher /></div>))
    await sleep(100)
    document.querySelector<HTMLButtonElement>('[aria-label="Switch environment"]')!.click()
    await sleep(250)
    const rows = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
    check(rows.length === 2 && rows[0].getAttribute("aria-checked") === "true", "Selected environment is not exposed")
    const labels = rows.map((row) => row.querySelector("bdi")!.getBoundingClientRect())
    check(Math.abs(labels[0].left - labels[1].left) < 1, "Environment names do not share an alignment edge")
    const iconSizes = rows.map((row) => row.querySelector("svg, [data-slot=central-icon]")!.getBoundingClientRect().width)
    check(Math.abs(iconSizes[0] - iconSizes[1]) < 1, "Local and remote icons have different sizes")
    const bounds = rows.map((row) => row.getBoundingClientRect())
    check(Math.abs(bounds[0].height - bounds[1].height) < 1, "Environment rows have uneven heights")
    for (const row of rows) check(row.scrollWidth <= row.clientWidth + 1, "Environment row clips its content")
    const windowAction = document.querySelector<HTMLElement>('[aria-label="Open Os-kdi in a new window"]')!
    check(windowAction && rows[1].parentElement === windowAction.parentElement, "New window action is not in its environment row")
    check(!document.querySelector('[data-slot="menu-sub-trigger"]'), "Separate new window submenu remains")
    check(!rows[1].contains(windowAction), "New window action is nested inside the switch action")
    windowAction.focus()
    check(document.activeElement === windowAction, "New window action cannot receive keyboard focus")
    windowAction.click(); await sleep(250)
    check(openedWindows.at(-1) === "remote", "New window action targeted the wrong environment")
    check(useEnvironments.getState().selectedId === "local", "New window action switched the current window")
    document.querySelector<HTMLButtonElement>('[aria-label="Switch environment"]')!.click()
    await sleep(250)
    const saved = useEnvironments.getState().profiles
    useEnvironments.setState({ profiles: saved.map((profile) => ({ ...profile, name: profile.name + " long-environment-name".repeat(3) })) })
    document.documentElement.style.zoom = "1.5"
    document.documentElement.dir = "rtl"
    await sleep(200)
    for (const row of document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')) {
      check(row.scrollWidth <= row.clientWidth + 1, "Long environment name clips at 150% zoom in RTL")
    }
    document.documentElement.style.zoom = ""
    document.documentElement.dir = "ltr"
    useEnvironments.setState({ profiles: saved })
    await sleep(200)
    if (variant === "light") {
      document.querySelector<HTMLElement>('[role="menuitemradio"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
      await sleep(250)
    }
  }
  return { pass: true, imagePreviews: 6, newlines: true, chronologicalImages: true, themes: 2, environmentAlignment: true }
}
const report = (result: unknown) => (window as unknown as { webkit: { messageHandlers: { bench: { postMessage: (value: string) => void } } } }).webkit.messageHandlers.bench.postMessage(JSON.stringify(result))
run().then(report).catch((error) => report({ pass: false, error: String(error), stack: error.stack }))
