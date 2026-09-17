import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { UsagePage } from "../src/views/UsagePage"
import { useStore } from "../src/state/store"
import { pending } from "./usage-rpc"
import "../src/index.css"
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const report = (value: unknown) => (window as unknown as { webkit: { messageHandlers: { bench: { postMessage: (text: string) => void } } } }).webkit.messageHandlers.bench.postMessage(JSON.stringify(value))
const check = (value: unknown, message: string) => { if (!value) throw new Error(message) }
const limits = (name: string) => ({ providers: [{ provider: "codex" as const, limits: [{ name, used_percent: 42, window_minutes: null, resets_at: null }] }] })
async function run() {
  useStore.getState().set({ environmentId: "first", connection: { state: "open" } })
  flushSync(() => createRoot(document.getElementById("root")!).render(<UsagePage />))
  await sleep(50)
  pending.shift()!.resolve(limits("First account"))
  await sleep(50)
  check(document.body.innerText.includes("First account"), "Initial limits render")
  flushSync(() => useStore.getState().set({ environmentId: "second" }))
  check(!document.body.innerText.includes("First account"), "Previous environment limits disappear immediately")
  await sleep(50)
  pending.shift()!.reject(new Error("Method not found"))
  await sleep(50)
  check(!document.body.innerText.includes("First account"), "Older daemon cannot expose previous account")
  flushSync(() => useStore.getState().set({ environmentId: "third" }))
  await sleep(50)
  const stale = pending.shift()!
  flushSync(() => useStore.getState().set({ environmentId: "fourth" }))
  await sleep(50)
  pending.shift()!.resolve(limits("Current account"))
  stale.resolve(limits("Stale account"))
  await sleep(50)
  check(document.body.innerText.includes("Current account") && !document.body.innerText.includes("Stale account"), "Late response cannot replace current account")
  report({ pass: true, environmentIsolation: true, olderDaemon: true, staleResponse: true })
}
run().catch(error => report({ pass: false, error: String(error) }))
