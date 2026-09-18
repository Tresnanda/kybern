import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { ThreadView } from "../src/views/Thread"
import { Transcript } from "../src/views/Transcript"
import { ThreadSidebar } from "../src/views/Sidebar"
import { Sidebar, SidebarInset, SidebarProvider } from "../src/components/kit/sidebar"
import { useStore, activateEnvironmentStore } from "../src/state/store"
import { createEnvironmentRuntime, setEnvironmentRuntime } from "../src/state/rpc"
import { ThemeProvider } from "../src/components/theme-provider"
import { ThemeProviderContext } from "../src/components/theme-context"
import { EVENT_NOTIFICATION, type EventNotification, type EventsSubscribeParams } from "../src/protocol"
import { retainedSize } from "../src/lib/retainedSize"
import "../src/index.css"

declare const __TOOL_LEASE_ENDPOINT__: { url: string; token: string; http_base: string; environmentId: string }
const threadId = "20000000-0000-4000-8000-000000000001"
const baseline = import.meta.env.VITE_LIVE_TOOLS_BASELINE === "1"
const fullEvents = baseline || import.meta.env.VITE_LIVE_TOOLS_FULL_EVENTS === "1"
const seededHistory = import.meta.env.VITE_LIVE_TOOLS_HISTORY === "1"
const fullThread = import.meta.env.VITE_LIVE_TOOLS_THREAD === "1"
const fullShell = import.meta.env.VITE_LIVE_TOOLS_SHELL === "1"
const emptySidebar = import.meta.env.VITE_LIVE_TOOLS_EMPTY_SIDEBAR === "1"
const w = window as unknown as { __memoryContinue: () => void; webkit: { messageHandlers: { bench: { postMessage(value: string): void } } } }
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
async function until(test: () => boolean, message: string) {
  for (let i = 0; i < 1200; i++) { if (test()) return; await sleep(25) }
  throw new Error(message)
}
const expected = (i: number) => `Result ${String(i).padStart(3, "0")}: é😀\n` + `${String(i).padStart(3, "0")} exact payload\n`.repeat(65536)
const tools = () => useStore.getState().transcripts[threadId]?.blocks.filter(b => b.kind === "tool") ?? []
const liveTools = () => tools().filter(block => block.call.id.startsWith("live-"))
async function mark(stage: string) {
  await sleep(500)
  await new Promise<void>(resolve => { w.__memoryContinue = resolve; w.webkit.messageHandlers.bench.postMessage(JSON.stringify({ stage, memory: true })) })
}
async function run() {
  document.documentElement.classList.add("dark")
  if (fullThread) {
    localStorage.setItem("theme", "dark")
    localStorage.setItem("kybern.translucent", "false")
  }
  activateEnvironmentStore(__TOOL_LEASE_ENDPOINT__.environmentId)
  const runtime = createEnvironmentRuntime(useStore)
  setEnvironmentRuntime(runtime)
  useStore.getState().set({ selected: { kind: "thread", id: threadId } })
  runtime.connect(__TOOL_LEASE_ENDPOINT__)
  // Install before the asynchronous socket handshake. Both modes use the same
  // production runtime and binary; only this fixture's subscription differs.
  const client = runtime.rpc(), call = client.call.bind(client)
  let calls = 0, deliveredOutputChars = 0, omittedCompletions = 0, unexpectedCompletion = false
  const completionSeqs = new Set<number>()
  const watchdog = setTimeout(() => w.webkit.messageHandlers.bench.postMessage(JSON.stringify({ stage: "live-diagnostic", tools: tools().length, complete: tools().filter(b => b.complete).length, status: useStore.getState().threads[threadId]?.status, deliveredOutputChars, omittedCompletions, uniqueCompletions: completionSeqs.size, unexpectedCompletion, visibility: document.visibilityState })), 20000)
  client.call = ((method, params) => {
    if (method === "threads.tool_output") calls++
    if (method === "events.subscribe" && fullEvents)
      return call(method, { ...(params as EventsSubscribeParams), include_tool_output: true })
    return call(method, params)
  }) as typeof client.call
  const unobserve = client.onNotification(EVENT_NOTIFICATION, (params) => {
    const { event } = params as EventNotification
    if (event.thread_id !== threadId || event.kind !== "tool_call_completed") return
    // Raw notification observers also see replayed frames after a reconnect or
    // lag recovery. The subscription reducer rejects their old sequence, so
    // count each durable completion once here too. Keep the probe bounded while
    // still failing if the workload produces a 65th distinct completion.
    if (completionSeqs.has(event.seq)) return
    if (completionSeqs.size >= 64) { unexpectedCompletion = true; return }
    completionSeqs.add(event.seq)
    const payload = event.output && typeof event.output === "object" && !Array.isArray(event.output) ? event.output.content : event.output
    if (typeof payload === "string") deliveredOutputChars += payload.length
    if (event.output_omitted) omittedCompletions++
  })
  let renderError: unknown
  const root = createRoot(document.getElementById("root")!, { onUncaughtError: error => { renderError = error } })
  try {
    await until(() => useStore.getState().connection.state === "open", "Scratch connection did not open")
    if (fullThread) {
      const [listed, projects] = await Promise.all([client.call("threads.list", {}), client.call("projects.list", {})])
      useStore.getState().set({
        projects: Object.fromEntries(projects.projects.map(project => [project.id, project])),
        threads: Object.fromEntries(listed.threads.map(thread => [thread.id, thread])),
      })
    }
    await runtime.loadThread(threadId)
    const render = (panes: number) => flushSync(() => root.render(
      <ThemeProviderContext value={{ theme: "dark", translucent: false, setTheme: () => {}, setTranslucent: () => {} }}>
        {fullThread ? <ThemeProvider defaultTheme="dark">
          <SidebarProvider open onOpenChange={() => {}} style={{ "--sidebar-width": "256px" } as React.CSSProperties}>
            {fullShell ? <>
              <Sidebar side="left" collapsible="offcanvas" transparentSurface innerClassName="app-sidebar-surface">
                {!emptySidebar && <ThreadSidebar />}
              </Sidebar>
              <div className="relative flex h-screen min-h-0 min-w-0 flex-1">
                <SidebarInset className="h-screen min-h-0 overscroll-y-none text-foreground" surfaceClassName="bg-transparent">
                  <div data-fixture-thread-surface className="chat-content-card relative z-[15] flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--color-background-surface)] text-inherit">
                    <main className="relative flex min-h-0 min-w-0 flex-1 flex-col"><ThreadView threadId={threadId} /></main>
                  </div>
                </SidebarInset>
              </div>
            </> : <div className="flex h-screen min-w-0 flex-1 bg-[var(--app-shell-background)]">
              <div data-fixture-sidebar-offset className="w-64 shrink-0" />
              <main data-fixture-thread-surface className="chat-content-card relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--color-background-surface)]">
                  <ThreadView threadId={threadId} />
              </main>
            </div>}
          </SidebarProvider>
        </ThemeProvider> : <div className="flex h-screen">{Array.from({ length: panes }, (_, pane) => <div key={pane} data-pane={pane} className="flex min-w-0 flex-1 flex-col"><Transcript threadId={threadId} bottomInset={0} /></div>)}</div>}
      </ThemeProviderContext>,
    ))
    render(1)
    if (fullThread) {
      await until(() => {
        if (renderError) throw renderError
        return document.querySelector("[data-chat-scroll-container]") !== null
      }, `Thread surface did not mount: ${document.body.innerHTML.slice(0, 800)}`)
      const viewport = document.querySelector<HTMLElement>("[data-chat-scroll-container]")!
      const bounds = viewport.getBoundingClientRect()
      check(bounds.width > 800 && bounds.height > 500, `Thread viewport is not representative: ${JSON.stringify({ width: bounds.width, height: bounds.height, fullShell, emptySidebar })}`)
    }
    if (seededHistory) {
      check(useStore.getState().transcripts[threadId]?.nextBeforeSeq != null, "Seeded history was not paged")
      if (!fullThread) {
        await until(() => document.querySelector("[data-earlier-history-status]") !== null, "Earlier-history status row did not mount")
        const earlier = document.querySelector<HTMLElement>("[data-earlier-history-status]")
        check(earlier?.classList.contains("chat-paint-host") === true || import.meta.env.VITE_EARLIER_STATUS_UNHOSTED === "1", "Earlier-history status row was not hosted")
      }
    }
    await mark("live-startup")
    await client.call("threads.send", { thread_id: threadId, message: { parts: [{ type: "text", text: "PROFILE_LIVE_TOOLS" }] } })
    await until(() => liveTools().length === 64 && liveTools().every(b => b.complete) && useStore.getState().threads[threadId]?.status === "idle", "Live turn did not complete")
    const bytes = liveTools().reduce((total, block) => total + retainedSize(block.output), 0)
    check(calls === 0, "Closed live output was unnecessarily fetched")
    if (!baseline) check(bytes <= 8 * 1024 * 1024, `Closed live payloads exceed budget: ${bytes}`)
    check(completionSeqs.size === 64 && !unexpectedCompletion, `Expected exactly 64 distinct completion events: ${JSON.stringify({ uniqueCompletions: completionSeqs.size, unexpectedCompletion })}`)
    if (fullEvents) check(omittedCompletions === 0 && deliveredOutputChars > 75_000_000, `Full-event control did not deliver all results: ${JSON.stringify({ omittedCompletions, deliveredOutputChars })}`)
    else check(omittedCompletions === 64 && deliveredOutputChars === 0, `Compact events still delivered closed payloads: ${JSON.stringify({ omittedCompletions, deliveredOutputChars })}`)
    await mark("live-results-closed")
    if (seededHistory) {
      const first = liveTools()[0]!
      const result = await client.call("threads.tool_output", {
        thread_id: threadId,
        tool_call_id: first.call.id,
        start_seq: first.seq,
        through_seq: useStore.getState().transcripts[threadId]?.lastSeq,
        include_tool_stream: false,
      })
      const content = result.output && typeof result.output === "object" && !Array.isArray(result.output) && "content" in result.output ? result.output.content : result.output
      check(content === expected(0), "Exact Unicode live output changed on direct reload")
      await sleep(3000)
      await mark("live-post-workload-idle")
      w.webkit.messageHandlers.bench.postMessage(JSON.stringify({ pass: true, baseline, fullEvents, seededHistory, deliveredOutputChars, omittedCompletions, closedRetainedBytes: bytes, liveResults: 64, hydrationCalls: calls, exactOutput: true }))
      return
    }
    // Directly mount two independent consumers of the same omitted early row;
    // the existing Transcript view owns its real leases and hydration effects.
    const first = liveTools()[0]!
    useStore.getState().set({ expandedWork: { [first.turnId]: true } })
    render(2)
    await sleep(500)
    for (const viewport of document.querySelectorAll<HTMLElement>("[data-chat-scroll-container]")) {
      viewport.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: seededHistory ? 100 : -100 }))
      viewport.scrollTop = seededHistory ? viewport.scrollHeight : 0
    }
    await sleep(500)
    await until(() => document.querySelectorAll('button[aria-expanded="false"]').length > 1, "No live work disclosures")
    const openFirst = () => [...document.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')].filter(b => b.textContent?.includes("live-000.txt"))
    await until(() => openFirst().length === 2, "Early live result not reachable in both panes")
    for (const button of openFirst()) button.click()
    await until(() => document.querySelectorAll("pre").length === 2, "Shared live result did not hydrate").catch(error => { throw new Error(`${error}; ${JSON.stringify({ calls, pre: document.querySelectorAll("pre").length, first: liveTools()[0] && { omitted: liveTools()[0]!.outputOmitted, stream: liveTools()[0]!.stream.slice(0, 80), output: String(liveTools()[0]!.output).slice(0, 80) }, buttons: openFirst().map(b => ({ text: b.textContent, open: b.getAttribute("aria-expanded") })), text: document.body.innerText.slice(0, 1500) })}`) })
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
    w.webkit.messageHandlers.bench.postMessage(JSON.stringify({ pass: true, baseline, fullEvents, deliveredOutputChars, omittedCompletions, closedRetainedBytes: bytes, liveResults: 64, hydrationCalls: calls, exactSharedOutput: true }))
  } finally {
    clearTimeout(watchdog)
    unobserve()
    flushSync(() => root.unmount())
    runtime.disconnect(); setEnvironmentRuntime(null)
  }
}
run().catch(error => w.webkit.messageHandlers.bench.postMessage(JSON.stringify({ pass: false, error: String(error) })))
