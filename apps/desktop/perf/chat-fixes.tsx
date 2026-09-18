import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { Composer } from "../src/views/Composer"
import { Transcript } from "../src/views/Transcript"
import { EnvironmentSwitcher } from "../src/views/EnvironmentSwitcher"
import { ResponseImage } from "../src/components/kybern/ResponseImage"
import { SidebarProvider } from "../src/components/kit/sidebar"
import { SidebarLeadingControls } from "../src/views/chrome"
import { assets } from "./chat-fixes-assets"
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
async function waitFor(condition: () => unknown, message: string) {
  const deadline = performance.now() + 5000
  while (!condition()) {
    check(performance.now() < deadline, message)
    await sleep(20)
  }
}
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII="
const source = `data:image/png;base64,${png}`
const gif = "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="
const gifSource = `data:image/gif;base64,${gif}`
const native = () => (window as unknown as { webkit: { messageHandlers: { bench: { postMessage: (text: string) => void } } } }).webkit.messageHandlers.bench
const nativeImage = new URLSearchParams(location.search).has("native-image")
function theme(variant: "light" | "dark") {
  document.documentElement.classList.toggle("dark", variant === "dark")
  document.documentElement.setAttribute("data-theme-variant", variant)
  const built = buildThemeCssVariables({ codeThemeId: DEFAULT_THEME_STATE.codeThemeIds[variant], theme: DEFAULT_THEME_STATE.chromeThemes[variant] }, variant, { electron: true, isMac: true, systemUiFont: true })
  for (const [key, value] of Object.entries(built.variables)) document.documentElement.style.setProperty(key, value)
}
async function openPreview(button: HTMLButtonElement, expected: string) {
  button.click()
  await waitFor(() => document.querySelector<HTMLImageElement>('[role="dialog"] img')?.src === expected, "Preview lost the original image")
  const dialog = document.querySelector('[role="dialog"]')
  const image = dialog?.querySelector("img")
  check(image?.src === expected, "Preview lost the original image")
  check(dialog?.querySelector('button[aria-label="Copy image"]'), "Preview has no copy image control")
  check(dialog?.querySelector('button[aria-label="Download image"]'), "Preview has no download image control")
  await image.decode()
  check(image.naturalWidth > 0, "Preview did not decode")
  const close = dialog!.querySelector<HTMLButtonElement>('button[aria-label="Close"]')
  check(close, "Preview has no close button")
  close.click()
  await waitFor(() => !document.querySelector('[role="dialog"]') && document.activeElement === button, "Preview did not close and restore focus")
  check(!document.querySelector('[role="dialog"]'), "Preview did not close")
  check(document.activeElement === button, "Preview did not restore focus")
}
async function nativeImageCopy(source: string, label: string) {
  flushSync(() => view.render(<ThemeProviderContext value={{ theme: "dark", translucent: false, setTheme: () => {}, setTranslucent: () => {} }}><div className="p-8"><ResponseImage key={label} source={source} label={label} /></div></ThemeProviderContext>))
  await waitFor(() => document.querySelector<HTMLButtonElement>(`[aria-label="Preview ${label}"]`), `Missing ${label} preview`)
  const preview = document.querySelector<HTMLButtonElement>(`[aria-label="Preview ${label}"]`)!
  preview.click()
  await waitFor(() => document.querySelector('[role="dialog"] button[aria-label="Copy image"]'), `${label} dialog did not open`)
  const copy = document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="Copy image"]')!
  const bridge = window as unknown as { __nativeImageContinue: (passed: boolean) => void }
  const completed = new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error(`${label} did not reach the native clipboard bridge`)), 5000)
    bridge.__nativeImageContinue = (passed) => {
      window.clearTimeout(timeout)
      if (passed) resolve()
      else reject(new Error(`${label} was not written as PNG`))
    }
  })
  copy.click()
  await completed
  document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="Close"]')!.click()
  await waitFor(() => !document.querySelector('[role="dialog"]'), `${label} dialog did not close`)
}
async function runNativeImages() {
  // Exercise the production Tauri fallback while keeping this fixture in a
  // standalone WKWebView: the mocked IPC forwards the converted bytes to the
  // native harness, which verifies the real macOS pasteboard.
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {
    invoke: async (command: string, args: Uint8Array) => {
      check(command === "write_image_clipboard", `Unexpected native operation: ${command}`)
      check(args instanceof Uint8Array, "Native image IPC was not binary")
      native().postMessage(JSON.stringify({ stage: "native-image-bytes", nativeClipboardBytes: true, data: [...args] }))
    },
  }, configurable: true })
  Object.defineProperty(navigator, "clipboard", { value: { write: async () => { throw new DOMException("User activation unavailable", "NotAllowedError") } }, configurable: true })
  await nativeImageCopy(source, "PNG image")
  await nativeImageCopy(gifSource, "GIF image")
  return { pass: true, nativeClipboard: ["png", "gif-converted-to-png"] }
}
async function run() {
  if (nativeImage) return runNativeImages()
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
    // Older WebKit includes a zero-width rectangle on the preceding line
    // when a range starts immediately after a preserved newline.
    const firstLine = [...first.getClientRects()].filter((rect) => rect.width > 0).at(-1)
    const secondLine = [...second.getClientRects()].filter((rect) => rect.width > 0).at(-1)
    check(firstLine && secondLine && secondLine.top > firstLine.top, `Sent message collapsed the composer newline: ${JSON.stringify({ variant, text: text.textContent, whiteSpace: getComputedStyle(paragraph).whiteSpace, first: firstLine?.toJSON(), second: secondLine?.toJSON() })}`)
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
    // Switching threads destroys local blob URLs; the durable asset ID restores
    // the thumbnail without retaining an image payload in every saved draft.
    check(!useStore.getState().composerDrafts.image!.attachments[0]!.preview, "Draft retained a transient blob URL")
    flushSync(() => view.render(<Composer key={`${variant}-other`} draftKey="other" mode="full-access" onModeChange={() => {}} provider={null} providers={[]} onSend={() => {}} />))
    URL.revokeObjectURL(url)
    const reads = assets.reads
    flushSync(() => view.render(<Composer key={`${variant}-restored`} draftKey="image" mode="full-access" onModeChange={() => {}} provider={null} providers={[]} onSend={() => {}} />))
    await waitFor(() => document.querySelector<HTMLImageElement>('[aria-label="Preview Screenshot.png"] img')?.complete, "Returning to the draft lost its image thumbnail")
    check(assets.reads === reads + 1, "Draft preview fetched repeatedly")
    const restored = document.querySelector<HTMLImageElement>('[aria-label="Preview Screenshot.png"] img')!.src
    check(restored !== url, "Draft reused a revoked preview URL")
    await openPreview(document.querySelector<HTMLButtonElement>('[aria-label="Preview Screenshot.png"]')!, restored)
    document.querySelector<HTMLButtonElement>('[aria-label="Remove Screenshot.png"]')!.click()
    await sleep(100)
    check(!document.querySelector('[aria-label="Preview Screenshot.png"]'), "Preview interfered with removing an attachment")
    let released = false
    try { await fetch(restored) } catch { released = true }
    check(released, "Removing the restored attachment retained its blob")
  }

  const savedAttachment = { id: "upload", name: "Restored.png", media_type: "image/png", size: 68 }
  useStore.getState().set(state => ({ composerDrafts: { ...state.composerDrafts, recovery: { text: "", attachments: [savedAttachment], mentions: [], skills: [] } } }))
  assets.fail = true
  flushSync(() => view.render(<Composer key="retry-asset" draftKey="recovery" mode="full-access" onModeChange={() => {}} provider={null} providers={[]} onSend={() => {}} />))
  await waitFor(() => document.querySelector('[aria-label="Retry preview Restored.png"]'), "Failed preview cannot be retried")
  assets.fail = false
  document.querySelector<HTMLButtonElement>('[aria-label="Retry preview Restored.png"]')!.click()
  await waitFor(() => document.querySelector<HTMLImageElement>('[aria-label="Preview Restored.png"] img')?.complete, "Retry did not restore the image")
  assets.delay = 120
  const pendingReads = assets.reads
  const abortedReads = assets.aborted
  flushSync(() => view.render(<Composer key="pending-asset" draftKey="recovery" mode="full-access" onModeChange={() => {}} provider={null} providers={[]} onSend={() => {}} />))
  await waitFor(() => assets.reads > pendingReads, "Preview did not start loading")
  flushSync(() => view.render(<Composer key="away-asset" draftKey="other" mode="full-access" onModeChange={() => {}} provider={null} providers={[]} onSend={() => {}} />))
  await waitFor(() => assets.aborted === abortedReads + 1, "Leaving a draft did not cancel the pending preview")
  check(!document.querySelector('[aria-label="Preview Restored.png"]'), "A late preview leaked into another thread")
  assets.delay = 0

  // Show native-only menu actions without starting a production shell.
  const openedWindows: string[] = []
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {
    invoke: async (command: string, args: { id: string }) => {
      check(command === "environment_open_window", `Unexpected native operation: ${command}`)
      openedWindows.push(args.id)
    },
  }, configurable: true })
  flushSync(() => view.render(<SidebarProvider defaultOpen><SidebarLeadingControls /></SidebarProvider>))
  const headerToggle = document.querySelector<HTMLButtonElement>('[aria-label="Toggle thread sidebar"]')!
  const historyButton = document.querySelector<HTMLButtonElement>('[aria-label="Back"]')!
  check(headerToggle && historyButton, "Expanded header has no history controls")
  const header = headerToggle.closest<HTMLElement>('[data-tauri-drag-region="false"]')!
  const headerWidth = header.getBoundingClientRect().width
  historyButton.focus()
  headerToggle.click()
  await sleep(30)
  check(!document.contains(historyButton) || !!historyButton.closest("[inert]"), "Hidden history action remains interactive")
  await sleep(350)
  const newThread = document.querySelector<HTMLButtonElement>('[aria-label="New thread"]')!
  check(newThread && !newThread.closest('[inert], [aria-hidden="true"]') && newThread.tabIndex === 0, "Collapsed header has no accessible new-thread action")
  newThread.focus()
  check(document.activeElement === newThread, "New-thread action cannot receive keyboard focus")
  const selected = useStore.getState().selected
  const projects = useStore.getState().projects
  useStore.getState().set({ selected: { kind: "none" }, projects: { header: { id: "header", name: "Header fixture", path: "/fixture", is_git: false, created_at: "2026-09-18T00:00:00Z", updated_at: "2026-09-18T00:00:00Z" } } })
  newThread.click()
  check(useStore.getState().selected.kind === "draft", "New-thread action did not open a draft")
  useStore.getState().set({ selected, projects })
  check(Math.abs(header.getBoundingClientRect().width - headerWidth) < 1, "Header controls shifted during the crossfade")
  headerToggle.click()
  await sleep(350)
  check(document.querySelector<HTMLButtonElement>('[aria-label="Back"]')?.tabIndex === 0 && !document.querySelector('[aria-label="New thread"]'), "History controls did not return after expansion")
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
    const actionBounds = windowAction.getBoundingClientRect()
    const rowBounds = rows[1].getBoundingClientRect()
    check(actionBounds.left >= rowBounds.right, "New window and switch hit areas overlap")
    check(Math.abs(actionBounds.top + actionBounds.height / 2 - rowBounds.top - rowBounds.height / 2) < 1, "New window action is not vertically centered")
    const localAction = document.querySelector<HTMLElement>('[aria-label="Open This Mac in a new window"]')!
    check(Math.abs(localAction.getBoundingClientRect().left - actionBounds.left) < 1, "New window actions do not share an alignment edge")
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
  if (import.meta.env.VITE_CHAT_PREVIEW === "image") {
    theme("dark")
    const image = URL.createObjectURL(await (await fetch("/release-background.png")).blob())
    flushSync(() => view.render(<div className="p-6"><ResponseImage source={image} label="Image.png" thumbnail /></div>))
    await sleep(200)
    document.querySelector<HTMLButtonElement>('[aria-label="Preview Image.png"]')!.click()
    await sleep(350)
  }
  return { pass: true, imagePreviews: 6, restoredDraftThumbnails: true, previewRetry: true, previewCleanup: true, newlines: true, chronologicalImages: true, themes: 2, environmentAlignment: true, collapsedHeader: true }
}
const report = (result: unknown) => (window as unknown as { webkit: { messageHandlers: { bench: { postMessage: (value: string) => void } } } }).webkit.messageHandlers.bench.postMessage(JSON.stringify(result))
run().then(report).catch((error) => report({ pass: false, error: String(error), stack: error.stack }))
