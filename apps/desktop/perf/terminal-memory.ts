import { Terminal } from "@xterm/xterm"
import { createTerminalRenderer } from "../src/lib/terminalRenderer"
import "@xterm/xterm/css/xterm.css"
declare const __TERMINAL_RETAIN__: boolean
const w = window as unknown as { __memoryContinue: () => void; webkit: { messageHandlers: { bench: { postMessage: (value: string) => void } } } }
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
async function waitForCanvas(host: HTMLElement) {
  const end = performance.now() + 5000
  while (!host.querySelector("canvas") && performance.now() < end) await sleep(20)
  check(host.querySelector("canvas"), "Real WebGL renderer must load")
}
async function mark(stage: string) {
  await sleep(300)
  await new Promise<void>(resolve => { w.__memoryContinue = resolve; w.webkit.messageHandlers.bench.postMessage(JSON.stringify({ stage, memory: true })) })
}
async function run() {
  await mark("terminal-startup")
  const tabs: { terminal: Terminal; renderer: ReturnType<typeof createTerminalRenderer>; host: HTMLDivElement }[] = []
  for (let i = 0; i < 6; i++) {
    const host = document.createElement("div")
    host.style.cssText = "position:absolute;inset:0;width:900px;height:500px"
    document.body.append(host)
    const terminal = new Terminal({ allowProposedApi: true, cols: 90, rows: 24, scrollback: 5000 })
    terminal.open(host)
    const renderer = createTerminalRenderer(terminal)
    tabs.push({ terminal, renderer, host })
    await new Promise<void>(resolve => terminal.write(Array.from({ length: 1500 }, (_, n) => `Tab ${i} line ${n}: terminal output\r\n`).join(""), resolve))
    renderer.setActive(true)
    await sleep(250)
    await waitForCanvas(host)
    if (!__TERMINAL_RETAIN__) renderer.setActive(false)
    host.style.opacity = "0"
    host.style.pointerEvents = "none"
  }
  const contexts = tabs.filter(tab => tab.host.querySelector("canvas")).length
  check(contexts === (__TERMINAL_RETAIN__ ? 6 : 0), `Inactive tab graphics count ${contexts} matches the selected policy ${__TERMINAL_RETAIN__}`)
  await mark(__TERMINAL_RETAIN__ ? "six-tabs-retained" : "six-tabs-inactive")
  for (const tab of tabs) { tab.renderer.dispose(); tab.terminal.dispose(); tab.host.remove() }
  tabs.length = 0
  const host = document.getElementById("root")!
  host.style.cssText = "width:900px;height:500px"
  const terminal = new Terminal({ allowProposedApi: true, cols: 90, rows: 24, scrollback: 5000 })
  terminal.open(host)
  const renderer = createTerminalRenderer(terminal)
  const write = (text: string) => new Promise<void>(resolve => terminal.write(text, resolve))
  await write(Array.from({ length: 1500 }, (_, i) => `Line ${i}: exact terminal text\r\n`).join(""))
  renderer.setActive(true)
  await sleep(800)
  await waitForCanvas(host)
  terminal.scrollLines(-100)
  terminal.select(0, 1400, 30)
  const selection = terminal.getSelection()
  const viewport = terminal.buffer.active.viewportY
  const text = terminal.buffer.active.getLine(1400)!.translateToString()
  await mark("terminal-active")
  for (let i = 0; i < 5; i++) {
    renderer.setActive(false)
    await sleep(100)
    check(!host.querySelector("canvas"), "Inactive terminal releases its graphics canvas")
    check(terminal.getSelection() === selection, "Selection survives renderer release")
    check(terminal.buffer.active.viewportY === viewport, "Reading position survives renderer release")
    await write(`Background ${i}\r\n`)
    renderer.setActive(true)
    await sleep(200)
    await waitForCanvas(host)
    check(terminal.getSelection() === selection, "Selection survives renderer recreation")
    check(terminal.buffer.active.viewportY === viewport, "Background output preserves reading position")
    check(terminal.buffer.active.getLine(1400)!.translateToString() === text, "Scrollback retains exact content")
  }
  renderer.setActive(false)
  await mark("terminal-inactive")
  renderer.dispose()
  terminal.dispose()
  await mark("terminal-released")
  w.webkit.messageHandlers.bench.postMessage(JSON.stringify({ pass: true, switches: 5, selection: true, scrollback: true, readingPosition: true, released: true }))
}
run().catch(error => w.webkit.messageHandlers.bench.postMessage(JSON.stringify({ pass: false, error: String(error) })))
