import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { Transcript } from "../src/views/Transcript"
import { useStore, activateEnvironmentStore } from "../src/state/store"
import { createEnvironmentRuntime, setEnvironmentRuntime } from "../src/state/rpc"
import { ThemeProviderContext } from "../src/components/theme-context"
import "../src/index.css"

declare const __TOOL_LEASE_ENDPOINT__: { url: string; token: string; http_base: string; environmentId: string }
const threadId = "20000000-0000-4000-8000-000000000001"
const turnId = "30000000-0000-4000-8000-000000000001"
const w = window as unknown as { webkit: { messageHandlers: { bench: { postMessage(value: string): void } } } }
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
async function until(test: () => boolean, message: string) {
  for (let i = 0; i < 200; i++) { if (test()) return; await sleep(25) }
  throw new Error(message)
}
const expected = (i: number) => `Exact result ${i}: é😀\n` + "readable content ".repeat(150)
const tools = () => useStore.getState().transcripts[threadId]?.blocks.filter(b => b.kind === "tool") ?? []
async function run() {
  document.documentElement.classList.add("dark")
  activateEnvironmentStore(__TOOL_LEASE_ENDPOINT__.environmentId)
  const runtime = createEnvironmentRuntime(useStore)
  setEnvironmentRuntime(runtime)
  useStore.getState().set({ selected: { kind: "thread", id: threadId }, expandedWork: { [turnId]: true } })
  runtime.connect(__TOOL_LEASE_ENDPOINT__)
  const root = createRoot(document.getElementById("root")!)
  let calls = 0
  const responses: unknown[] = []
  const errors: string[] = []
  let heldResponses = 0
  let responseGate: Promise<void> | undefined
  let releaseResponses: (() => void) | undefined
  try {
    await until(() => useStore.getState().connection.state === "open", "Scratch connection did not open")
    await runtime.loadThread(threadId)
    await until(() => tools().length === 16, "Missing saved tool rows")
    check(tools().every(b => b.kind === "tool" && b.outputOmitted), "Large outputs must initially be omitted")
    const client = runtime.rpc()
    const call = client.call.bind(client)
    client.call = ((method, params) => {
      if (method === "threads.tool_output") calls++
      return call(method, params).then(async result => {
        if (method === "threads.tool_output") {
          responses.push(params)
          if (responseGate) { heldResponses++; await responseGate }
        }
        return result
      }, error => { errors.push(String(error)); throw error })
    }) as typeof client.call
    const render = (panes: number) => flushSync(() => root.render(
      <ThemeProviderContext value={{ theme: "dark", translucent: false, setTheme: () => {}, setTranslucent: () => {} }}>
        <div className="flex h-screen">{Array.from({ length: panes }, (_, pane) => <div key={pane} data-pane={pane} className="flex min-w-0 flex-1 flex-col"><Transcript threadId={threadId} bottomInset={0} /></div>)}</div>
      </ThemeProviderContext>,
    ))
    render(2)
    await until(() => document.querySelectorAll('button[aria-expanded="false"]').length >= 32, "Missing result disclosures")
    const disclosures = () => [...document.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')].filter(b => b.textContent?.includes("lease-"))
    check(disclosures().length === 32, "Both panes must mount all 16 results")
    for (const button of disclosures()) button.click()
    await until(() => document.querySelectorAll("pre").length === 32 && tools().every(b => b.kind === "tool" && !b.outputOmitted), "Mounted results did not hydrate").catch(error => {
      throw new Error(`${error}; ${JSON.stringify({ calls, responses, errors, rendered: document.querySelectorAll("pre").length, connection: useStore.getState().connection, tools: tools().map(b => ({ id: b.call.id, seq: b.seq, omitted: b.outputOmitted })) })}`)
    })
    await sleep(500)
    check(calls === 16, `Shared panes fetched ${calls} times instead of 16`)
    for (const pane of document.querySelectorAll('[data-pane]')) {
      const outputs = [...pane.querySelectorAll("pre")]
      for (let i = 0; i < 16; i++) check(outputs[i]?.textContent === expected(i), `Exact output differs at ${i}`)
    }
    const pre = document.querySelector("pre")!
    const range = document.createRange(); range.selectNodeContents(pre)
    document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range)
    check(document.getSelection()!.toString() === expected(0), "Exact selected/copyable Unicode output differs")
    document.getSelection()!.removeAllRanges()
    render(1)
    await sleep(500)
    check(document.querySelectorAll("pre").length === 16 && calls === 16, "Closing one pane discarded shared results")
    for (const button of disclosures()) if (button.getAttribute("aria-expanded") === "true") button.click()
    await until(() => document.querySelectorAll("pre").length === 0, "Closed results did not unmount")
    await sleep(300)
    check(tools().filter(b => b.kind === "tool" && !b.outputOmitted).length === 12, "Inactive allowance changed")
    for (const button of disclosures()) button.click()
    await until(() => document.querySelectorAll("pre").length === 16 && tools().every(b => b.kind === "tool" && !b.outputOmitted), "Reopening results lost content")
    check(calls === 20, `Expected four reloads after closing all, got ${calls - 16}`)
    const lifecycleCalls = calls
    // Delay real responses at the runtime boundary, then close the actual socket.
    // The client's normal reconnect and replay path must recover mounted results
    // even while four callbacks from the obsolete connection remain pending.
    for (const button of disclosures()) button.click()
    await until(() => document.querySelectorAll("pre").length === 0, "Reconnect setup did not close results")
    responseGate = new Promise(resolve => { releaseResponses = resolve })
    for (const button of disclosures()) button.click()
    await until(() => heldResponses === 4, "Expected four in-flight real hydration responses")
    const socket = (client as unknown as { ws: WebSocket }).ws
    socket.close()
    await until(() => useStore.getState().connection.state !== "open", "Socket closure did not reach runtime")
    responseGate = undefined
    await until(() => useStore.getState().connection.state === "open" && tools().every(b => !b.outputOmitted) && document.querySelectorAll("pre").length === 16, "Reconnect did not recover mounted results")
    const settled = tools()
    releaseResponses!()
    await sleep(300)
    check(tools().every((block, index) => block === settled[index]), "Obsolete hydration replaced reconnected rows")
    for (const [index, output] of [...document.querySelectorAll("pre")].entries()) check(output.textContent === expected(index), "Reconnect lost exact output")
    w.webkit.messageHandlers.bench.postMessage(JSON.stringify({ pass: true, mountedResults: 32, uniqueResults: 16, lifecycleCalls, calls, sharedPanes: true, exactUnicodeSelection: true, closeReopen: true, reconnectDuringHydration: true, transport: "real scratch daemon" }))
  } finally {
    releaseResponses?.()
    flushSync(() => root.unmount())
    runtime.disconnect(); setEnvironmentRuntime(null)
  }
}
run().catch(error => w.webkit.messageHandlers.bench.postMessage(JSON.stringify({ pass: false, error: String(error) })))
