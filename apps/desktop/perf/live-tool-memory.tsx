import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { Transcript } from "../src/views/Transcript"
import { useStore, activateEnvironmentStore } from "../src/state/store"
import { createEnvironmentRuntime, setEnvironmentRuntime } from "../src/state/rpc"
import { ThemeProviderContext } from "../src/components/theme-context"
import { retainedSize } from "../src/lib/retainedSize"
import "../src/index.css"

declare const __TOOL_LEASE_ENDPOINT__: { url: string; token: string; http_base: string; environmentId: string }
const threadId = "20000000-0000-4000-8000-000000000001"
const baseline = import.meta.env.VITE_LIVE_TOOLS_BASELINE === "1"
const w = window as unknown as { __memoryContinue: () => void; webkit: { messageHandlers: { bench: { postMessage(value: string): void } } } }
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
async function until(test: () => boolean, message: string) {
  for (let i = 0; i < 1200; i++) { if (test()) return; await sleep(25) }
  throw new Error(message)
}
const expected = (i: number) => `Result ${String(i).padStart(3, "0")}: é😀\n` + `${String(i).padStart(3, "0")} exact payload\n`.repeat(65536)
const tools = () => useStore.getState().transcripts[threadId]?.blocks.filter(b => b.kind === "tool") ?? []
async function mark(stage: string) {
  await sleep(500)
  await new Promise<void>(resolve => { w.__memoryContinue = resolve; w.webkit.messageHandlers.bench.postMessage(JSON.stringify({ stage, memory: true })) })
}
async function run() {
  document.documentElement.classList.add("dark")
  activateEnvironmentStore(__TOOL_LEASE_ENDPOINT__.environmentId)
  const runtime = createEnvironmentRuntime(useStore)
  setEnvironmentRuntime(runtime)
  useStore.getState().set({ selected: { kind: "thread", id: threadId } })
  runtime.connect(__TOOL_LEASE_ENDPOINT__)
  const root = createRoot(document.getElementById("root")!)
  let calls = 0
  try {
    await until(() => useStore.getState().connection.state === "open", "Scratch connection did not open")
    await runtime.loadThread(threadId)
    const client = runtime.rpc(), call = client.call.bind(client)
    client.call = ((method, params) => {
      if (method === "threads.tool_output") calls++
      return call(method, params)
    }) as typeof client.call
    const render = (panes: number) => flushSync(() => root.render(
      <ThemeProviderContext value={{ theme: "dark", translucent: false, setTheme: () => {}, setTranslucent: () => {} }}>
        <div className="flex h-screen">{Array.from({ length: panes }, (_, pane) => <div key={pane} data-pane={pane} className="flex min-w-0 flex-1 flex-col"><Transcript threadId={threadId} bottomInset={0} /></div>)}</div>
      </ThemeProviderContext>,
    ))
    render(1)
    await mark("live-startup")
    await client.call("threads.send", { thread_id: threadId, message: { parts: [{ type: "text", text: "PROFILE_LIVE_TOOLS" }] } })
    await until(() => tools().length === 64 && tools().every(b => b.complete) && useStore.getState().threads[threadId]?.status === "idle", "Live turn did not complete")
    const bytes = tools().reduce((total, block) => total + retainedSize(block.output), 0)
    check(calls === 0, "Closed live output was unnecessarily fetched")
    if (!baseline) check(bytes <= 8 * 1024 * 1024, `Closed live payloads exceed budget: ${bytes}`)
    await mark("live-results-closed")
    // Directly mount two independent consumers of the same omitted early row;
    // the existing Transcript view owns its real leases and hydration effects.
    const first = tools()[0]!
    useStore.getState().set({ expandedWork: { [first.turnId]: true } })
    render(2)
    await sleep(500)
    for (const viewport of document.querySelectorAll<HTMLElement>("[data-chat-scroll-container]")) {
      viewport.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -100 }))
      viewport.scrollTop = 0
    }
    await sleep(500)
    await until(() => document.querySelectorAll('button[aria-expanded="false"]').length > 1, "No live work disclosures")
    const openFirst = () => [...document.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')].filter(b => b.textContent?.includes("live-000.txt"))
    await until(() => openFirst().length === 2, "Early live result not reachable in both panes")
    for (const button of openFirst()) button.click()
    await until(() => document.querySelectorAll("pre").length === 2, "Shared live result did not hydrate").catch(error => { throw new Error(`${error}; ${JSON.stringify({ calls, pre: document.querySelectorAll("pre").length, first: tools()[0] && { omitted: tools()[0]!.outputOmitted, stream: tools()[0]!.stream.slice(0, 80), output: String(tools()[0]!.output).slice(0, 80) }, buttons: openFirst().map(b => ({ text: b.textContent, open: b.getAttribute("aria-expanded") })), text: document.body.innerText.slice(0, 1500) })}`) })
    for (const pre of document.querySelectorAll("pre")) check(pre.textContent === expected(0), "Exact Unicode live output changed on reload")
    check(calls === (baseline ? 0 : 1), `Shared live result fetched ${calls} times`)
    await mark("live-result-open-shared")
    render(1)
    await sleep(400)
    check(document.querySelector("pre")?.textContent === expected(0), "Closing one pane discarded the other's result")
    for (const button of openFirst()) if (button.getAttribute("aria-expanded") === "true") button.click()
    await until(() => !document.querySelector("pre"), "Closed live result stayed mounted")
    await sleep(3000)
    await mark("live-post-workload-idle")
    w.webkit.messageHandlers.bench.postMessage(JSON.stringify({ pass: true, baseline, closedRetainedBytes: bytes, liveResults: 64, hydrationCalls: calls, exactSharedOutput: true }))
  } finally {
    flushSync(() => root.unmount())
    runtime.disconnect(); setEnvironmentRuntime(null)
  }
}
run().catch(error => w.webkit.messageHandlers.bench.postMessage(JSON.stringify({ pass: false, error: String(error) })))
