/* eslint-disable react-refresh/only-export-components */
import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { UsagePage } from "../src/views/UsagePage"
import { useUsageLimitsSync } from "../src/views/useUsageLimitsSync"
import { useStore } from "../src/state/store"
import { pending } from "./usage-rpc"
import "../src/index.css"
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const report = (value: unknown) => (window as unknown as { webkit: { messageHandlers: { bench: { postMessage: (text: string) => void } } } }).webkit.messageHandlers.bench.postMessage(JSON.stringify(value))
const check = (value: unknown, message: string) => { if (!value) throw new Error(message) }
const limits = (name: string) => ({ providers: [{ provider: "codex" as const, limits: [{ name, used_percent: 42, window_minutes: null, resets_at: null }] }] })
// The workspace follows the environment's limits feed; the page only renders them.
function Workspace() {
  useUsageLimitsSync()
  return <UsagePage />
}
// The Usage page asks for named accounts and the feed asks on attach, focus
// and visibility, so a step answers every ask it has made rather than the
// first one: only the feed's current generation may change what renders.
const take = () => pending.splice(0)
const answer = (asks: typeof pending, value: ReturnType<typeof limits>) => { for (const ask of asks) ask.resolve(value) }
async function run() {
  useStore.getState().set({ environmentId: "first", connection: { state: "open" } })
  flushSync(() => createRoot(document.getElementById("root")!).render(<Workspace />))
  await sleep(50)
  answer(take(), limits("First account"))
  await sleep(50)
  check(document.body.innerText.includes("First account"), "Initial limits render")
  flushSync(() => useStore.getState().set({ environmentId: "second" }))
  check(!document.body.innerText.includes("First account"), "Previous environment limits disappear immediately")
  await sleep(50)
  for (const ask of take()) ask.reject(new Error("Method not found"))
  await sleep(50)
  check(!document.body.innerText.includes("First account"), "Older daemon cannot expose previous account")
  flushSync(() => useStore.getState().set({ environmentId: "third" }))
  await sleep(50)
  const stale = take()
  check(stale.length > 0, "Third environment asks for its limits")
  flushSync(() => useStore.getState().set({ environmentId: "fourth" }))
  await sleep(50)
  const current = take()
  check(current.length > 0, "Fourth environment asks for its limits")
  answer(current, limits("Current account"))
  answer(stale, limits("Stale account"))
  await sleep(50)
  check(document.body.innerText.includes("Current account") && !document.body.innerText.includes("Stale account"), "Late response cannot replace current account")
  report({ pass: true, environmentIsolation: true, olderDaemon: true, staleResponse: true })
}
run().catch(error => report({ pass: false, error: String(error) }))
