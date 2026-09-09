import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { ActivityPane } from "../src/views/Activity"
import { mergeRuntimeTasks, useStore } from "../src/state/store"
import type { RuntimeTask } from "../src/protocol"
import "../src/index.css"

const at = "2026-09-01T12:00:00Z"
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const frame = () => new Promise<number>(resolve => requestAnimationFrame(resolve))
const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length * .95)] ?? 0
const report = (value: unknown) => (window as unknown as { webkit: { messageHandlers: { bench: { postMessage: (text: string) => void } } } }).webkit.messageHandlers.bench.postMessage(JSON.stringify(value))
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
function tasks(count: number): RuntimeTask[] {
  return Array.from({length: count}, (_, i) => ({
    id: `task-${i}`, thread_id: "fixture", origin_turn_id: "heavy", parent_id: null,
    tool_call_id: null, kind: "process", title: `Background command ${i}`,
    detail: "Command completed with output", status: i === 0 ? "running" : "completed",
    started_at: at, updated_at: at, completed_at: i === 0 ? null : at,
    started_seq: i + 1, updated_seq: i + 1, backgrounded: true,
    capabilities: {stop: true, background: false}, stats: {}, usage: null,
    provider_thread_id: null, provider_type: null, model: null, effort: null, last_tool_name: null,
  }))
}
async function run() {
  document.documentElement.classList.add("dark")
  const root = createRoot(document.getElementById("root")!)
  const measurements = []
  for (const count of [20, 800, 4000]) {
    const items = tasks(count)
    const times = []
    for (let i = 0; i < 25; i++) {
      const started = performance.now()
      mergeRuntimeTasks(items, [{...items[0]!, updated_seq: count + i + 1}])
      times.push(performance.now() - started)
    }
    useStore.getState().set({runtimeTasks: {fixture: items}})
    const started = performance.now()
    flushSync(() => root.render(<div className="h-screen w-80"><ActivityPane key={count} threadId="fixture" /></div>))
    const mountMs = performance.now() - started
    await sleep(150)
    const mountedRows = document.querySelectorAll("article").length
    check(mountedRows > 0 && mountedRows < 40, "Activity rows must stay bounded")
    const updateTimes = []
    for (let i = 0; i < 25; i++) {
      const started = performance.now()
      flushSync(() => useStore.getState().set({runtimeTasks: {fixture: mergeRuntimeTasks(items, [{...items[0]!, updated_seq: count+i+1}])}}))
      updateTimes.push(performance.now() - started)
      await frame()
    }
    measurements.push({tasks: count, mountedRows, mountMs, mergeP95: p95(times), updateCommitP95: p95(updateTimes)})
    const viewport = document.querySelector<HTMLElement>("[data-activity-scroll]")!
    viewport.scrollTop = viewport.scrollHeight
    await sleep(150)
    check(viewport.querySelector('[title="Background command 1"]'), "The oldest retained task must remain reachable")
    viewport.scrollTop = 0
    await sleep(150)
    check(viewport.querySelector('[title="Background command 0"]'), "Active work must remain reachable")
  }
  let intervals = 0
  const originalInterval = window.setInterval
  window.setInterval = ((...args: Parameters<typeof window.setInterval>) => { intervals++; return originalInterval(...args) }) as typeof window.setInterval
  flushSync(() => root.render(<div className="h-screen w-80"><ActivityPane key="hidden" threadId="fixture" visible={false} /></div>))
  await sleep(50)
  window.setInterval = originalInterval
  check(intervals === 0, "A hidden Activity pane must not start a timer")
  report({pass: measurements.every(m => m.mergeP95 < 16), measurements, hiddenTimers: intervals})
}
run().catch(error => report({pass:false,error:String(error)}))
