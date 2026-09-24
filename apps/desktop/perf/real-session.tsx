// Boots the shipped app (src/main.tsx) against the runner's scratch daemon and
// samples WebContent at each step. Two workloads:
// - visits (default): open the N most recently updated threads of a store copy.
// - replay:N: follow one thread while the replay provider streams a recorded
//   Claude session N times.
// Both assert that an idle thread view keeps no pane-sized drag preview or
// persistent sidebar layer. Footprints are diagnostic, not pass/fail.
import { retainedSize } from "../src/lib/retainedSize"

declare const __TOOL_LEASE_ENDPOINT__: { url: string; token: string; http_base: string }
declare const __SCROLL_SCENARIO__: string
declare const __SCROLL_EXTRA_CSS__: string
const w = window as unknown as { __memoryContinue: () => void; webkit: { messageHandlers: { bench: { postMessage(value: string): void } } } }
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const visits = Number(new URLSearchParams(location.search).get("history") ?? "12")
const post = (value: unknown) => w.webkit.messageHandlers.bench.postMessage(JSON.stringify(value))
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
type Store = typeof import("../src/state/store")
let store: Store

function stats() {
  const state = store.useStore.getState() as unknown as Record<string, unknown>
  const storeKiB: Record<string, number> = {}
  for (const [key, value] of Object.entries(state)) {
    if (typeof value === "function") continue
    const size = retainedSize(value)
    if (size > 64 * 1024) storeKiB[key] = Math.round(size / 1024)
  }
  const transcripts = state.transcripts as Record<string, { blocks: unknown[] }>
  return {
    dom: document.getElementsByTagName("*").length,
    transcripts: Object.keys(transcripts).length,
    blocks: Object.values(transcripts).reduce((n, t) => n + (t.blocks?.length ?? 0), 0),
    storeKiB,
    tables: Array.from(document.querySelectorAll("[data-chat-scroll-container] table")).map(table => {
      const box = table.getBoundingClientRect()
      const host = table.closest<HTMLElement>(".chat-paint-host")?.getBoundingClientRect()
      return `${Math.round(box.width)}x${Math.round(box.height)} cells=${table.querySelectorAll("td,th").length} nodes=${table.getElementsByTagName("*").length} host=${host ? `${Math.round(host.width)}x${Math.round(host.height)}` : "none"}`
    }),
  }
}
async function mark(stage: string, extra: Record<string, unknown> = {}) {
  await sleep(1500)
  await new Promise<void>(resolve => { w.__memoryContinue = resolve; post({ stage, memory: true, ...stats(), ...extra }) })
}
async function collect(stage: string) {
  // Diagnostic only: the runner calls WebKit's JavaScript GC SPI, then samples.
  await new Promise<void>(resolve => { w.__memoryContinue = resolve; post({ stage: "gc", gc: true }) })
  await sleep(3000)
  await mark(stage)
}
async function until(test: () => boolean, message: string, ms = 30000) {
  for (let t = 0; t < ms; t += 50) { if (test()) return; await sleep(50) }
  throw new Error(message)
}

/** Large idle layers that PR-level changes removed; a regression reintroduces them. */
function checkIdleLayers() {
  const pane = document.querySelector<HTMLElement>("[data-thread-drop-surface]")?.getBoundingClientRect()
  check(pane, "Thread drop surface did not mount")
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
    const box = el.getBoundingClientRect()
    if (box.width * box.height < pane.width * pane.height * 0.25) continue
    const style = getComputedStyle(el)
    check((style.backdropFilter ?? "none") === "none", `Idle ${box.width}x${box.height} ${el.className} keeps a backdrop filter`)
  }
  check(!document.querySelector(".thread-drop-overlay"), "Drag preview mounted without a drag")
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(".sidebar-surface-enter"))) {
    const style = getComputedStyle(el)
    check(style.willChange === "auto" && style.transform === "none", "Sidebar surface kept its entry layer after the animation")
  }
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(".t-marquee > span"))) {
    check(getComputedStyle(el).willChange === "auto", "An idle marquee label keeps its own layer")
  }
}

async function followReplay(passes: number) {
  const thread = Object.values(store.useStore.getState().threads).sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0]
  check(thread, "Replay thread is missing")
  const { rpc } = await import("../src/state/rpc")
  store.useStore.getState().selectThread(thread.id)
  await until(() => !!document.querySelector("[data-chat-scroll-container]"), "Replay thread did not mount")
  await mark("replay-start")
  checkIdleLayers()
  for (let pass = 1; pass <= passes; pass++) {
    await rpc().call("threads.send", { thread_id: thread.id, message: { parts: [{ type: "text", text: "PROFILE_REPLAY" }] } })
    await until(() => store.useStore.getState().threads[thread.id]?.status === "running", `Replay ${pass} did not start`)
    await until(() => store.useStore.getState().threads[thread.id]?.status === "idle", `Replay ${pass} did not finish`, 600000)
    await mark(`replay-pass-${pass}`)
  }
  await collect("replay-gc")
  post({ pass: true, replayed: passes })
}

async function visitRecent() {
  const chosen = /^threads:(.+)$/.exec(__SCROLL_SCENARIO__)?.[1]?.split(",")
  const threads = store.useStore.getState().threads
  const recent = chosen
    ? chosen.map(id => threads[id as keyof typeof threads]).filter(thread => thread !== undefined)
    : Object.values(threads)
      .filter(thread => !(thread as { archived_at?: string }).archived_at)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, visits)
  for (const [index, thread] of recent.entries()) {
    post({ stage: "event", name: `select-${index}`, t: Date.now() })
    store.useStore.getState().selectThread(thread.id)
    await until(() => !!store.useStore.getState().transcripts[thread.id] && !!document.querySelector("[data-chat-scroll-container]"), `Thread ${thread.id} did not load`)
    post({ stage: "event", name: `loaded-${index}`, t: Date.now() })
    if (chosen) await sleep(6000)
    await mark(`visit-${String(index).padStart(2, "0")}`, { lastSeq: thread.last_seq })
    if (index === 0) checkIdleLayers()
  }
  await collect("visits-gc")
  if (!chosen) {
    // Chosen threads stay selected so a held window can be inspected.
    store.useStore.getState().set({ selected: { kind: "none" } } as never)
    await sleep(5000)
    await mark("deselected-idle")
  }
  post({ pass: true, visited: recent.length })
}

async function run() {
  const query = new URLSearchParams({ url: __TOOL_LEASE_ENDPOINT__.url, token: __TOOL_LEASE_ENDPOINT__.token })
  history.replaceState(null, "", `${location.pathname}?${query}`)
  localStorage.setItem("kybern.theme", "dark")
  // Diagnostic A/B stylesheet (KYBERN_SCROLL_EXTRA_CSS); empty for normal runs.
  if (__SCROLL_EXTRA_CSS__) document.head.appendChild(Object.assign(document.createElement("style"), { textContent: __SCROLL_EXTRA_CSS__ }))
  await import("../src/main")
  store = await import("../src/state/store")
  await until(() => store.useStore.getState().connection.state === "open" && Object.keys(store.useStore.getState().threads).length > 0, "App did not connect")
  await mark("boot")
  await sleep(8000)
  await mark("home-idle")
  const replay = /^replay:(\d+)$/.exec(__SCROLL_SCENARIO__)
  await (replay ? followReplay(Number(replay[1])) : visitRecent())
}
run().catch(error => post({ pass: false, error: `${error?.message ?? error}\n${error?.stack ?? ""}` }))
