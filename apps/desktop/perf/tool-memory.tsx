import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { Transcript } from "../src/views/Transcript"
import { useStore } from "../src/state/store"
import { emptyThreadState, type Block } from "../src/state/transcript"
import { ThemeProviderContext } from "../src/components/theme-context"
import "../src/index.css"

const w = window as unknown as { __memoryContinue: () => void; webkit: { messageHandlers: { bench: { postMessage: (value: string) => void } } } }
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const stringify = JSON.stringify
let serializations = 0
JSON.stringify = ((value: unknown, ...args: unknown[]) => {
  if (value && typeof value === "object" && "memoryFixture" in value) serializations++
  return Reflect.apply(stringify, JSON, [value, ...args])
}) as typeof JSON.stringify
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
async function mark(stage: string) {
  await sleep(300)
  await new Promise<void>(resolve => { w.__memoryContinue = resolve; w.webkit.messageHandlers.bench.postMessage(stringify({ stage, memory: true, serializations })) })
}
async function run() {
  document.documentElement.classList.add("dark")
  await mark("tool-startup")
  const blocks: Block[] = Array.from({ length: 20 }, (_, i) => ({
    kind: "tool", id: `tool-${i}`, turnId: "work", at: "2026-09-01T00:00:00Z", seq: i + 1,
    origin: { kind: "root" }, call: { id: `tool-${i}`, name: "Read", input: { file_path: `/project/result-${i}.json` }, parent_id: null },
    stream: "", complete: true, isError: true, // Keep individual result rows visible.
    output: { memoryFixture: i, rows: Array.from({ length: 6000 }, (_, n) => ({ line: n, value: `Result ${i}-${n}: ${"exact content ".repeat(12)}` })) },
  }))
  useStore.getState().set({ selected: { kind: "thread", id: "fixture" }, expandedWork: { work: true }, transcripts: { fixture: { ...emptyThreadState(), loaded: true, blocks } } })
  const root = createRoot(document.getElementById("root")!)
  flushSync(() => root.render(<ThemeProviderContext value={{ theme: "dark", translucent: false, setTheme: () => {}, setTranslucent: () => {} }}><div className="flex h-screen flex-col"><Transcript threadId="fixture" bottomInset={0} /></div></ThemeProviderContext>))
  await mark("tools-collapsed")
  check(serializations === 0, `Collapsed tools formatted ${serializations} full results`)
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('button[aria-expanded="false"]')].filter(button => button.textContent?.includes("result-"))
  check(buttons.length === 20, `Expected 20 result disclosures, saw ${buttons.length}: ${document.body.innerText}`)
  buttons[0]!.click()
  await sleep(350)
  const pre = document.querySelector("pre")!
  const output = (blocks[0] as Extract<Block, { kind: "tool" }>).output
  check(serializations === 1, "Only the opened result is formatted")
  const exact = stringify(output, null, 2)
  check(pre?.getAttribute("data-tool-result-chars") === String(exact.length), "Expanded result lost its source length")
  check(pre.hasAttribute("data-tool-result-virtual"), "Opened oversized result did not virtualize")
  check((pre.textContent?.length ?? 0) < exact.length, "Opened result still mounted the full string")
  check(!pre.classList.contains("chat-paint-host") && !pre.querySelector(".chat-paint-host"), "Result scroller promoted paint hosts")
  check(pre.textContent?.includes('"memoryFixture": 0'), "Opened result lost its prefix")
  const range = document.createRange()
  range.selectNodeContents(pre)
  document.getSelection()!.removeAllRanges()
  document.getSelection()!.addRange(range)
  const selected = document.getSelection()!.toString()
  check(selected.length > 0, "Mounted result remains selectable")
  const wholeClipboard = new DataTransfer()
  pre.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: wholeClipboard }))
  check(wholeClipboard.getData("text/plain") === exact, "Select-all copy truncated the result")
  document.getSelection()!.removeAllRanges()
  const firstText = pre.querySelector("[data-tool-result-row]")?.firstChild
  check(firstText instanceof Text, "The first visible row has selectable text")
  const partial = firstText.textContent?.slice(0, 12) ?? ""
  const partialRange = document.createRange()
  partialRange.setStart(firstText, 0)
  partialRange.setEnd(firstText, partial.length)
  document.getSelection()!.addRange(partialRange)
  const partialClipboard = new DataTransfer()
  pre.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: partialClipboard }))
  check(partialClipboard.getData("text/plain") === "", "Partial copy was replaced with the full result")
  check(document.getSelection()!.toString() === partial, "Partial selection changed")
  document.getSelection()!.removeAllRanges()
  for (let attempt = 0; attempt < 8; attempt++) {
    pre.scrollTop = pre.scrollHeight
    await sleep(50)
    if (pre.textContent?.includes("Result 0-5999") || pre.textContent?.includes('"line": 5999')) break
  }
  check(pre.textContent?.includes("Result 0-5999") || pre.textContent?.includes('"line": 5999'), "Last lines unreachable")
  await mark("tool-expanded")
  buttons[0]!.click()
  await sleep(400)
  check(!document.querySelector("pre"), "Closed output unmounts after exit")
  flushSync(() => root.unmount())
  useStore.getState().set({ transcripts: {} })
  await mark("tools-released")
  w.webkit.messageHandlers.bench.postMessage(stringify({ pass: true, serializations, exactOutput: true, selection: true, released: true }))
}
run().catch(error => w.webkit.messageHandlers.bench.postMessage(stringify({ pass: false, error: String(error) })))
