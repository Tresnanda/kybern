import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { SessionPicker } from "../src/views/SessionsDialog"
import { Dialog, DialogPopup } from "../src/components/kit/dialog"
import { ThemeProviderContext } from "../src/components/theme-context"
import type { ProviderKind, SavedSession } from "../src/protocol"
import "../src/index.css"

const root = createRoot(document.getElementById("root")!)
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
const kinds: ProviderKind[] = ["claude-code", "codex", "opencode", "pi", "omp", "cursor"]
const sessions: SavedSession[] = Array.from({ length: 145 }, (_, i) => ({
  provider: kinds[i % 6]!, id: `native-${i}`, title: i === 0 ? "Fix the streaming transcript and preserve the final answer across background wake-ups" : `Review saved conversation ${i}`,
  cwd: "/Users/example/projects/kybern", updated_at: new Date(Date.now() - i * 60_000).toISOString(), model: null, thread_id: i === 0 ? "existing" : null,
}))
let calls = 0
async function fetchPage(provider: ProviderKind, _project: string | null, query: string) {
  await sleep(query === "old" ? 300 : 10)
  if (query === "failure") throw new Error("Reconnect the harness and retry.")
  return { sessions: sessions.filter((s) => s.provider === provider && s.title.toLowerCase().includes(query.toLowerCase())), next_cursor: null }
}
function button(text: string) { return [...document.querySelectorAll("button")].find((b) => b.textContent === text) }
function search(value: string) {
  const input = document.querySelector<HTMLInputElement>('input[role="combobox"]')!
  check(input, "Search input missing")
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value)
  input.dispatchEvent(new Event("input", { bubbles: true }))
}
async function run() {
  for (const theme of ["light", "dark"] as const) {
    document.documentElement.classList.toggle("dark", theme === "dark")
    flushSync(() => root.render(<ThemeProviderContext value={{ theme, translucent: false, setTheme: () => {}, setTranslucent: () => {} }}>
      <Dialog open><DialogPopup instant bottomStickOnMobile={false} className="max-h-[min(42rem,calc(100dvh-2rem))] max-w-2xl overflow-hidden"><SessionPicker key={theme} project={{ id: "project", name: "Kybern" }} available={kinds} fetchPage={fetchPage} onResume={async () => { calls++; await sleep(30); throw new Error("This session is open elsewhere. Close it there and retry.") }} /></DialogPopup></Dialog>
    </ThemeProviderContext>))
    await sleep(350)
    check(document.querySelectorAll('[role="option"]').length === 100, "Session options must be bounded to 100")
    button("Next sessions")!.click(); await sleep(80)
    check(document.querySelectorAll('[role="option"]').length === 45, "Next page is incomplete")
    button("Previous sessions")!.click(); await sleep(80)
    const resume = button("Open thread") ?? button("Resume session")!
    const input = document.querySelector<HTMLInputElement>('input[role="combobox"]')!
    input.focus()
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
    await sleep(50)
    check(input.getAttribute("aria-activedescendant"), "Keyboard navigation did not select an option")
    const keyboardBefore = calls
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    await sleep(100)
    check(calls === keyboardBefore + 1, "Enter did not resume the highlighted session")
    const before = calls
    resume.click(); resume.click(); await sleep(100)
    check(calls === before + 1, "Double click imported twice")
    check(document.querySelector('[role="alert"]')?.textContent?.includes("Close it there"), "Resume failure is missing")
    search("no such conversation"); await sleep(300)
    check(document.body.textContent?.includes("No sessions match"), "Empty search state missing")
    search("old"); await sleep(200); search("conversation 14"); await sleep(400)
    check(document.querySelectorAll('[role="option"]').length === 6, "Stale search replaced current results")
    search("failure"); await sleep(300)
    check(document.body.textContent?.includes("6 harnesses couldn’t be loaded"), "Provider errors missing")
    search(""); await sleep(350)
    const dialog = document.querySelector('[role="dialog"]')!.getBoundingClientRect()
    check(dialog.left >= 0 && dialog.right <= innerWidth && dialog.top >= 0 && dialog.bottom <= innerHeight, "Dialog overflows viewport")
  }
  return { pass: true, themes: 2, boundedOptions: 100, pagination: true, staleSearch: true, importSingleFlight: true, keyboardResume: true, errorStates: true }
}
const report = (value: unknown) => (window as unknown as { webkit: { messageHandlers: { bench: { postMessage: (value: string) => void } } } }).webkit.messageHandlers.bench.postMessage(JSON.stringify(value))
run().then(report).catch((error) => report({ pass: false, error: String(error), stack: error.stack }))
