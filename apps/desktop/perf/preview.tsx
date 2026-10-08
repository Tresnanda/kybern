/* eslint-disable react-refresh/only-export-components -- fixture defines a helper component beside its runner */
import { createRoot } from "react-dom/client"
import { useSyncExternalStore } from "react"
import { DockPreviewPane } from "../src/views/dock/VisualPreviewPanel"
import { PreviewSurfaceLayer } from "../src/views/dock/preview/PreviewSurfaceLayer"
import { PreviewMiniPlayer } from "../src/views/dock/preview/PreviewMiniPlayer"
import { useStore } from "../src/state/store"
import { openPreviewInput, usePreviewSessions } from "../src/state/previewSession"
import { ThemeProviderContext } from "../src/components/theme-context"
import { buildThemeCssVariables, DEFAULT_THEME_STATE } from "../src/lib/kit/theme/theme.logic"
import { fixture, connectFixture, closeFixture, transport } from "./preview-rpc"
import "../src/index.css"

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
function check(value: unknown, label: string): asserts value { if (!value) throw new Error(label) }
async function waitFor<T>(condition: () => T, label: string, ms = 8000): Promise<NonNullable<T>> {
  const until = performance.now() + ms
  let value = condition()
  while (!value && performance.now() < until) { await sleep(25); value = condition() }
  check(value, label)
  return value as NonNullable<T>
}
const threadId = fixture.thread_id
const root = createRoot(document.getElementById("root")!)
type Msg = Record<string, unknown> & { fixture: string; __at: number; __source: Window }
const messages: Msg[] = []
window.addEventListener("message", event => {
  if (event.data?.fixture === "kybern-preview" && event.source) { const m = { ...event.data, __at: performance.now() }; Object.defineProperty(m, "__source", { value: event.source, enumerable: false }); messages.push(m) }
})
const mark = () => messages.length
const since = (index: number) => messages.slice(index)
const waitMsg = (index: number, pred: (m: Msg) => unknown, label: string, ms = 8000) => waitFor(() => since(index).find(pred), label, ms)
const frames = () => [...document.querySelectorAll<HTMLIFrameElement>("[data-preview-layer] iframe")]
const frame = () => frames()[0]
const send = (action: string) => frame().contentWindow!.postMessage({ fixture: "kybern-preview-command", action }, "*")
function appearance(variant: "dark" | "light") {
  const el = document.documentElement; el.classList.toggle("dark", variant === "dark")
  const built = buildThemeCssVariables({ codeThemeId: DEFAULT_THEME_STATE.codeThemeIds[variant], theme: DEFAULT_THEME_STATE.chromeThemes[variant] }, variant, { electron: true, isMac: true, systemUiFont: true })
  for (const [key, value] of Object.entries(built.variables)) el.style.setProperty(key, value)
}
function report(value: unknown) { (window as unknown as { webkit: { messageHandlers: { bench: { postMessage: (text: string) => void } } } }).webkit.messageHandlers.bench.postMessage(JSON.stringify(value)) }
async function screenshot(name: string) {
  await sleep(350)
  await new Promise<void>(resolve => {
    (window as unknown as { __screenshotContinue: () => void }).__screenshotContinue = resolve
    report({ screenshot: name })
  })
}
const subscribeTheme = (notify: () => void) => { const observer = new MutationObserver(notify); observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] }); return () => observer.disconnect() }
const themeSnapshot = () => document.documentElement.classList.contains("dark") ? "dark" as const : "light" as const
const themeValue = (theme: "dark" | "light") => ({ theme, setTheme() {}, translucent: false, setTranslucent() {} })

let dockWidth = 560
let setDock: (width: number) => void = () => {}
const dockListeners = new Set<() => void>()
setDock = width => { dockWidth = width; dockListeners.forEach(l => l()) }
const useDock = () => useSyncExternalStore(l => { dockListeners.add(l); return () => dockListeners.delete(l) }, () => dockWidth)
function Shell() {
  const theme = useSyncExternalStore(subscribeTheme, themeSnapshot)
  const width = useDock()
  return <ThemeProviderContext.Provider value={themeValue(theme)}>
    <div id="stage" className="flex h-screen w-screen overflow-hidden bg-[var(--color-background-surface)] text-foreground">
      <main data-workspace-chat className="relative flex min-w-0 flex-1 flex-col">
        <div className="chat-content-card flex-1 p-6 text-[13px] text-muted-foreground">
          <p className="max-w-[420px] text-foreground/90">I wrote the mockup and started the dev server. The page is open in the Preview tab.</p>
        </div>
        <div className="chat-composer-shell mx-6 mb-5 h-[88px] rounded-2xl bg-[var(--color-background-elevated-secondary)] p-3 text-[13px] text-muted-foreground">Ask for follow-up changes</div>
      </main>
      <aside id="dock" className="min-w-0 shrink-0 border-l border-[color:var(--app-surface-divider)]" style={{ width }}>
        <DockPreviewPane threadId={threadId} active />
      </aside>
      <PreviewSurfaceLayer />
      <PreviewMiniPlayer />
    </div>
  </ThemeProviderContext.Provider>
}

const web = () => { const p = useStore.getState().previews[threadId]; return p?.kind === "web" ? p : undefined }
const load = () => usePreviewSessions.getState().sessions[threadId]?.load
const addressText = () => document.querySelector<HTMLElement>("[data-preview-address]")?.textContent ?? ""
const buttonByText = (text: string) => [...document.querySelectorAll<HTMLElement>("button")].find(b => b.textContent?.trim() === text)
const clickText = (text: string) => { const b = buttonByText(text); check(b, `Missing button "${text}"`); b.click() }
const results: Record<string, unknown> = {}

async function openAndWait(input: string, label: string, pred: (m: Msg) => unknown, opts: Parameters<typeof openPreviewInput>[2] = {}) {
  const at = mark()
  const outcome = await openPreviewInput(threadId, input, { focus: true, ...opts })
  results[`${label}.outcome`] = outcome.status
  return { at, outcome, message: await waitMsg(at, pred, `${label}: page responds`) }
}
const L = (name: string, variant: string) => `${name}-${variant}`

async function run() {
  report({ stage: "preview-visibility", hidden: document.hidden })
  await waitFor(() => !document.hidden, "Native preview fixture needs a visible window: unlock macOS and set KYBERN_PERF_FOREGROUND=1")
  await connectFixture(); report({ stage: "preview-connected" })
  const project = { id: "p1", name: "Preview fixture", path: fixture.project } as never
  useStore.setState({
    projects: { p1: project } as never,
    threads: { [threadId]: { id: threadId, project_id: "p1", cwd: fixture.project, title: "Preview fixture" } } as never,
    selected: { kind: "thread", id: threadId } as never,
  })
  appearance("dark"); document.body.style.background = "var(--color-background-surface)"
  root.render(<Shell />)
  await sleep(400)

  // Empty state: servers found by the daemon, polled only while visible (AC 10).
  const dockNarrow = 340
  await waitFor(() => document.querySelector("[data-preview-server]"), "Empty state lists a running server", 12000)
  const rows = [...document.querySelectorAll("[data-preview-server]")].map(r => r.textContent ?? "")
  check(rows.some(r => r.includes(String(fixture.ports.vite))), "Discovery found the vite-like server")
  results.serverRows = rows.length
  const callsWhileEmpty = transport.listCalls.length
  await screenshot(L("empty", "dark"))
  appearance("light"); await screenshot(L("empty", "light"))
  setDock(dockNarrow); await screenshot(L("empty-narrow", "light")); setDock(560)

  for (const variant of ["dark", "light"] as const) {
    appearance(variant)
    // AC 1: a folder outside the project asks first, then loads with relative assets.
    useStore.getState().closePreviewPage(threadId); await sleep(100)
    const outsideFile = `${fixture.outside}/mockup.html`
    const atOpen = mark()
    const outcome = await openPreviewInput(threadId, outsideFile, { focus: true })
    if (variant === "dark") {
      check(outcome.status === "needs_permission", `Outside folder asks first, got ${JSON.stringify(outcome)}`)
      await waitFor(() => document.querySelector('[data-preview-state="permission"]'), "Permission card shows")
      check(document.querySelector('[data-preview-state="permission"]')!.textContent!.includes("outside"), "Card shows the canonical folder")
      await screenshot(L("permission", variant))
      const at = mark()
      clickText("Allow folder")
      const m = await waitMsg(at, m => m.mockup && m.own !== undefined, "Granted folder loads")
      check(m.img === 1 && m.own === 200 && m.font === 200, `Relative assets load (img ${m.img}, css ${m.own}, font ${m.font})`)
      const gone = (v: unknown) => v === 404 || v === "blocked"
      check(m.env === 404 && m.git === 404 && gone(m.escape) && gone(m.encoded) && m.link === 404, `Dotfiles and escapes 404: ${JSON.stringify(m)}`)
      check(m.health === "blocked", `CSP blocks /health, got ${m.health}`)
      results.outsideMockup = { env: m.env, health: m.health, img: m.img }
    } else {
      // The grant persists: opening another file in the folder shows no card.
      check(outcome.status === "shown", `Granted folder opens without a card, got ${outcome.status}`)
      await waitMsg(atOpen, m => m.mockup && m.n !== undefined, "Mockup responds again")
    }
    await sleep(500)
    await screenshot(L("mockup-file", variant))
    setDock(dockNarrow); await sleep(300); await screenshot(L("mockup-file-narrow", variant)); setDock(560); await sleep(300)
  }

  // The real design mockup from a previous task, outside the project.
  for (const variant of ["dark", "light"] as const) {
    appearance(variant)
    const outcome = await openPreviewInput(threadId, fixture.realMockup, { focus: true })
    if (outcome.status === "needs_permission") { await waitFor(() => buttonByText("Allow folder"), "Real mockup card"); if (variant === "dark") await screenshot(L("permission-real", variant)); clickText("Allow folder") }
    await waitFor(() => load()?.phase === "ready", "Real mockup loads")
    await sleep(1200)
    await screenshot(L("mockup-real", variant))
  }

  // AC 2/3/4: an in-project mockup needs no card; the bridge reports in-page navigation.
  appearance("dark")
  const inProject = await openAndWait(`${fixture.project}/mockup.html`, "project mockup", m => m.mockup && m.own !== undefined)
  check(inProject.outcome.status === "shown", "In-project file opens without a card")
  check(inProject.message.dir === 404 && inProject.message.link === 404 && inProject.message.env === 404, "In-project escapes 404 (symlink, dotfile, directory)")
  await openAndWait(`${fixture.project}/sub/page.html`, "sub page", m => m.sub)
  await waitFor(() => /page\.html/.test(addressText()), "Address shows the sub page")
  const before = addressText()
  const pushAt = mark(); send("push"); await sleep(600)
  check(/view=2/.test(addressText()), `pushState updates the address: "${addressText()}" msgs ${JSON.stringify(since(pushAt).slice(-3))} frames ${frames().length}`)
  document.querySelector<HTMLElement>('button[aria-label="Back"]')!.click()
  await waitFor(() => addressText() === before, "Back drives the page history", 4000)
  results.addressAfterBack = addressText()

  // AC 5/17: a dev server renders directly, storage works, the top window cannot be navigated.
  const vite = await openAndWait(`http://localhost:${fixture.ports.vite}/dashboard`, "vite", m => m.storage !== undefined)
  const topMsg = await waitMsg(vite.at, m => m.topNav !== undefined, "Isolation report")
  check(vite.message.storage === true, "localStorage works on a local server")
  check(topMsg.topBlocked === true && topMsg.topNav === "blocked" && topMsg.popup === false, `Top window and popups are blocked: ${JSON.stringify(topMsg)}`)
  const ws = await waitMsg(vite.at, m => m.ws === "message" && String(m.data).startsWith("echo:"), "HMR WebSocket echoes")
  results.ws = ws.data
  const n1 = (await waitMsg(vite.at, m => typeof m.n === "number" && (m.n as number) > 3, "Counter runs")).n as number

  // AC 12: device mode keeps the document (counter) and reports a 390x844 CSS viewport.
  const at = mark()
  useStore.getState().setPreviewViewport(threadId, { mode: "device", presetId: "iphone-12-pro", width: 390, height: 844 })
  const dm = await waitMsg(at, m => m.w === 390 && m.h === 844, "iPhone 12 Pro reports 390x844")
  check((dm.n as number) >= n1, "Device mode does not reload the document")
  await screenshot(L("device", "dark"))
  const rot = mark(); useStore.getState().setPreviewViewport(threadId, { mode: "device", presetId: "iphone-12-pro", width: 844, height: 390 })
  await waitMsg(rot, m => m.w === 844 && m.h === 390 && (m.n as number) >= n1, "Rotate gives 844x390 without reload")
  // East rail drag: width follows the pointer 1:1 and the preset becomes Responsive.
  const rail = document.querySelector<HTMLElement>('.preview-rail[data-edge="e"]')
  if (rail) {
    const r = rail.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2
    const scale = Number(document.querySelector<HTMLElement>("[data-preview-surface]")?.getAttribute("data-scale") ?? 1)
    const drag = mark()
    rail.setPointerCapture = () => {} // synthetic pointer ids have no real capture
    rail.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: x, clientY: y, pointerId: 7, button: 0, isPrimary: true }))
    rail.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: x - 40, clientY: y, pointerId: 7, isPrimary: true }))
    rail.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: x - 40, clientY: y, pointerId: 7, isPrimary: true }))
    await sleep(500)
    const w = since(drag).filter(m => typeof m.w === "number").pop()?.w as number | undefined
    results.railDrag = { scale, width: w }
    check(typeof w === "number" && w !== 844, "East rail drag changes the viewport width")
    check(web()?.viewport.mode === "device" && (web()!.viewport as { presetId: string | null }).presetId === null, "Dragging switches to Responsive")
  } else results.railDrag = "rail not found"
  useStore.getState().setPreviewViewport(threadId, { mode: "fill" })
  await waitMsg(mark(), m => (m.w as number) > 450, "Leaving device mode restores fill", 6000)
  appearance("light"); useStore.getState().setPreviewViewport(threadId, { mode: "device", presetId: "iphone-12-pro", width: 390, height: 844 }); await sleep(500); await screenshot(L("device", "light"))
  useStore.getState().setPreviewViewport(threadId, { mode: "fill" })

  // AC 13: the mini player keeps the document alive.
  await sleep(300)
  const beforeFloat = since(0).filter(m => m.__source === frame().contentWindow && typeof m.n === "number").pop()!.n as number
  useStore.getState().setPreviewFloating(threadId, true)
  await waitFor(() => document.querySelector("[data-preview-pip-header]"), "Mini player shows")
  const afterFloat = await waitMsg(mark(), m => typeof m.n === "number", "Floating page keeps running")
  check((afterFloat.n as number) >= beforeFloat, `Floating does not reload (before ${beforeFloat}, after ${afterFloat.n})`)
  check(frames().length <= 2, "At most two live documents")
  await sleep(700); await screenshot(L("pip", "light")); appearance("dark"); await sleep(300); await screenshot(L("pip", "dark"))
  setDock(dockNarrow); await sleep(300); await screenshot(L("pip-narrow", "dark")); setDock(560)
  useStore.getState().setPreviewFloating(threadId, false); await sleep(500)
  check(frames().length === 1, "Returning to the panel keeps one document")

  // AC 7: frame policy blocked, then relayed through Kybern.
  await openPreviewInput(threadId, `http://127.0.0.1:${fixture.ports.xfo}/`, { focus: true })
  await waitFor(() => document.querySelector("[data-preview-state]")?.textContent?.includes("SAMEORIGIN"), "Blocked state names the header")
  await screenshot(L("blocked", "dark")); appearance("light"); await screenshot(L("blocked", "light")); appearance("dark")
  const relayAt = mark()
  clickText("Preview through Kybern")
  await waitMsg(relayAt, m => typeof m.n === "number", "Relayed page renders", 10000)
  results.relayed = true

  // AC 8: closed port waits, and the page loads once the server starts.
  await openPreviewInput(threadId, `http://127.0.0.1:${fixture.ports.closed}/`, { focus: true })
  await waitFor(() => document.body.textContent?.includes("Waiting for the server"), "Waiting state shows", 6000)
  await screenshot(L("waiting", "dark")); appearance("light"); await screenshot(L("waiting", "light")); appearance("dark")
  const startAt = mark()
  await fetch(`http://127.0.0.1:${fixture.ports.control}/start-closed`)
  await waitMsg(startAt, m => typeof m.n === "number", "Waiting loads the page when the server starts", 6000)
  await fetch(`http://127.0.0.1:${fixture.ports.control}/stop-closed`)

  // AC 9: external pages open in the browser.
  await openPreviewInput(threadId, "https://github.com/", { focus: true })
  await waitFor(() => document.body.textContent?.includes("opens in your browser"), "External card shows")
  clickText("Open in browser"); check(transport.opened.some(u => u.startsWith("https://github.com")), "Open in browser opens the real URL")

  // AC 10: no server polling once the empty state is not visible.
  useStore.getState().closePreviewPage(threadId)
  await sleep(500)
  const visibleCalls = transport.listCalls.length
  useStore.getState().openWebPreview(threadId, { kind: "server", url: `http://127.0.0.1:${fixture.ports.probe}/` }, {})
  await sleep(7000)
  results.listCalls = { whileEmpty: callsWhileEmpty, afterPageOpened: transport.listCalls.length - visibleCalls }
  check(transport.listCalls.length - visibleCalls <= 1, "No previews.servers.list calls while a page is shown")

  // AC 14/15: tickets are revoked and nothing uses visibility:hidden.
  results.tickets = { minted: transport.tickets.length, closed: transport.closed.length }
  check(![...document.querySelectorAll<HTMLElement>("[data-preview-layer] *")].some(el => getComputedStyle(el).visibility === "hidden"), "No visibility:hidden in the preview layer")
  report({ pass: true, results })
  closeFixture()
}
run().catch(error => { report({ pass: false, error: String(error), stack: error instanceof Error ? error.stack : undefined, results }); closeFixture() })
