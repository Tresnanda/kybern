import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { Markdown } from "../src/components/kybern/Markdown"
import { ThemeProviderContext } from "../src/components/theme-context"
import { buildThemeCssVariables, DEFAULT_THEME_STATE } from "../src/lib/kit/theme/theme.logic"
import "../src/index.css"

const root = createRoot(document.getElementById("root")!)
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const failures: string[] = []
window.addEventListener("error", event => failures.push(event.message))
window.addEventListener("securitypolicyviolation", event => failures.push(`CSP: ${event.violatedDirective} ${event.blockedURI}`))
let copied = ""
Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text: string) => { copied = text } } })
const blobs = new Map<string, Blob>()
const createURL = URL.createObjectURL.bind(URL), revokeURL = URL.revokeObjectURL.bind(URL)
URL.createObjectURL = (blob) => { const url = createURL(blob); if (blob instanceof Blob) blobs.set(url, blob); return url }
URL.revokeObjectURL = (url) => { blobs.delete(url); revokeURL(url) }
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
async function until(predicate: () => unknown, message: string, timeout = 12_000) {
  const deadline = performance.now() + timeout
  while (!predicate()) { check(performance.now() < deadline, message); await sleep(20) }
}
const native = () => (window as unknown as { webkit: { messageHandlers: { bench: { postMessage: (text: string) => void } } } }).webkit.messageHandlers.bench
const examples = [
  "flowchart TD\nA[Start] --> B{Ready?}\nB -->|Yes| C[Finish]\nB -->|No| A",
  "sequenceDiagram\nAlice->>Bob: Hello\nBob-->>Alice: Welcome",
  "classDiagram\nAnimal <|-- Duck\nAnimal : +int age\nDuck : +swim()",
  "erDiagram\nCUSTOMER ||--o{ ORDER : places",
  "stateDiagram-v2\n[*] --> Working\nWorking --> Done\nDone --> [*]",
  "mindmap\n  root((Plan))\n    Build\n    Verify",
]
function render(code: string, variant: "dark" | "light", live = false, tail = "") {
  document.documentElement.classList.toggle("dark", variant === "dark")
  document.documentElement.style.colorScheme = variant
  document.documentElement.dir = import.meta.env.VITE_PERF_RTL ? "rtl" : "ltr"
  document.documentElement.dataset.windowMaterial = "opaque"
  const built = buildThemeCssVariables({ codeThemeId: DEFAULT_THEME_STATE.codeThemeIds[variant], theme: DEFAULT_THEME_STATE.chromeThemes[variant] }, variant, { electron: true, isMac: true })
  for (const [key, value] of Object.entries(built.variables)) document.documentElement.style.setProperty(key, value)
  flushSync(() => root.render(<ThemeProviderContext value={{ theme: variant, translucent: false, setTheme: () => {}, setTranslucent: () => {} }}><main className="mx-auto max-w-3xl p-6"><Markdown text={`## Diagram\n\n\`\`\`mermaid\n${code}${live ? "" : "\n```"}`} live={live} /><p>{tail}</p></main></ThemeProviderContext>))
}
async function diagram() {
  await until(() => document.querySelector('[data-mermaid-state="ready"] img'), "Mermaid did not render")
  const img = document.querySelector<HTMLImageElement>('[data-mermaid-state="ready"] img')!
  await img.decode()
  check(img.naturalWidth > 0 && img.naturalHeight > 0, "Diagram image did not decode")
  const svg = await blobs.get(img.src)!.text()
  check(svg.includes("<svg") && svg.includes("<text"), "Diagram lost formatted SVG labels")
  check(!/<script|onerror=|onclick=/i.test(svg), "Executable SVG returned")
  return { img, svg }
}
async function run() {
  check(!document.querySelector('iframe'), "Renderer loaded before any diagrams")
  for (const variant of ["light", "dark"] as const) {
    for (const code of examples) { render(code, variant); await diagram() }
    render(examples[0]!, variant)
    const { img, svg } = await diagram()
    check(svg.includes("Start") && svg.includes("Finish"), "Flowchart labels missing")
    copied = ""
    document.querySelector<HTMLButtonElement>('[aria-label="Copy code"], [aria-label="Copied"]')!.click()
    await until(() => copied === examples[0], "Diagram copy lost exact source")
    render(examples[0]!, variant, false, "Unrelated streamed text")
    await sleep(60)
    check(document.querySelector('[data-mermaid-state="ready"] img') === img, "Settled diagram remounted on unrelated update")
    document.querySelector<HTMLButtonElement>('[aria-label="Show diagram source"]')!.click()
    await until(() => document.querySelector('[data-mermaid-state] pre code')?.textContent === examples[0], "Source toggle lost exact code")
    document.querySelector<HTMLButtonElement>('[aria-label="Show diagram"]')!.click()
    await diagram()
    const expand = document.querySelector<HTMLButtonElement>('[aria-label="Expand diagram"]')!
    expand.focus()
    expand.click()
    await until(() => document.querySelector('[role="dialog"] img'), "Expanded diagram did not open")
    const expanded = document.querySelector<HTMLImageElement>('[role="dialog"] img')!
    await expanded.decode()
    check(expanded.src === document.querySelector<HTMLImageElement>('.chat-diagram-canvas img')!.src, "Expansion rerendered or replaced the image resource")
    const box = document.querySelector('[role="dialog"]')!.getBoundingClientRect()
    check(box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight, "Expanded diagram clips its controls")
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    await until(() => !document.querySelector('[role="dialog"]'), "Escape did not close the expanded diagram")
    check(document.activeElement === expand, "Closing the diagram lost keyboard focus")
    render("flowchart TD\nA[", variant, true)
    await sleep(80)
    check(document.querySelector('[data-mermaid-state="streaming"] pre code')?.textContent === "flowchart TD\nA[", "Incomplete streaming source lost")
    check(!document.querySelector('[data-mermaid-state] img'), "Incomplete stream rendered a diagram")
    render("flowchart TD\nA[", variant)
    await until(() => document.querySelector('[data-mermaid-state="source"]'), "Invalid diagram did not fall back")
    render(examples[0]!, variant)
    await diagram()
  }
  check(blobs.size === 1, `Unused image URLs retained: ${blobs.size}`)
  await until(() => !document.querySelector('iframe[title="Diagram renderer"]'), "Idle renderer was retained", 35_000)
  check(document.querySelector('[data-mermaid-state="ready"] img'), "Idle cleanup removed the finished diagram")
  render(examples[1]!, import.meta.env.VITE_PERF_THEME === "light" ? "light" : "dark")
  await diagram()
  check(blobs.size === 1, "Idle restart leaked object URLs")
  await sleep(300)
  const group = document.querySelector<HTMLElement>('.chat-diagram-view')!
  const pill = group.querySelector<HTMLElement>('.t-tabs-pill')!
  const slow = document.createElement("style")
  slow.textContent = ".chat-diagram-view__pill { transition-duration: 2.5s !important }"
  document.head.append(slow)
  const first = pill.getBoundingClientRect()
  document.querySelector<HTMLButtonElement>('[aria-label="Show diagram source"]')!.click()
  await sleep(200)
  const middle = pill.getBoundingClientRect()
  const target = document.querySelector<HTMLElement>('[aria-label="Show diagram source"]')!.getBoundingClientRect().x
  check((middle.x - first.x) * (target - first.x) > 0 && Math.abs(middle.x - first.x) < Math.abs(target - first.x) - 1, "View switch did not interpolate toward the selected option")
  document.querySelector<HTMLButtonElement>('[aria-label="Show diagram"]')!.click()
  await sleep(2600)
  slow.remove()
  check(Math.abs(pill.getBoundingClientRect().x - first.x) < 1, "Reversing the view switch failed to settle")
  const reduced: { rule: CSSMediaRule; media: string }[] = []
  const collect = (rules: CSSRuleList) => { for (const rule of rules) {
    if (rule instanceof CSSMediaRule && rule.conditionText.replaceAll(" ", "").includes("prefers-reduced-motion:reduce")) { reduced.push({ rule, media: rule.media.mediaText }); rule.media.mediaText = "all" }
    else if ("cssRules" in rule) collect((rule as CSSGroupingRule).cssRules)
  } }
  for (const sheet of document.styleSheets) collect(sheet.cssRules)
  check(reduced.length > 0 && getComputedStyle(pill).transitionDuration === "0s", "Reduced motion did not stop the sliding pill")
  for (const { rule, media } of reduced) rule.media.mediaText = media
  await sleep(300)
  native().postMessage(JSON.stringify({ pass: failures.length === 0, failures, diagrams: examples.length * 2, idleRendererReleased: true, stableImage: true, expandedView: true, keyboardFocus: true, slowMotionReversal: true, reducedMotion: true }))
}
run().catch(error => native().postMessage(JSON.stringify({ pass: false, error: String(error), failures })))
