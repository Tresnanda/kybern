// Identical workload also runs against bee4fdc; compatibility branches use its original event path.
import type { ThreadEvent } from "../src/protocol"
import type { EnvironmentStore } from "../src/state/store"
import { activateEnvironmentStore } from "../src/state/store"
import { applyEvent, emptyThreadState } from "../src/state/transcript"
import { parseMarkdown } from "../src/lib/markdown"
import { highlightToHtml } from "../src/lib/highlight"
const w = window as unknown as { __memoryContinue: () => void; webkit: { messageHandlers: { bench: { postMessage: (message: string) => void } } } }
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function mark(stage: string, store: EnvironmentStore) {
  let characters = 0
  for (const state of Object.values(store.getState().transcripts)) for (const block of state.blocks) characters += ("text" in block ? block.text.length : 0) + ("thinking" in block ? block.thinking.length : 0)
  await delay(300)
  await new Promise<void>(resolve => { w.__memoryContinue = resolve; w.webkit.messageHandlers.bench.postMessage(JSON.stringify({ stage, memory: true, retainedCharacters: characters })) })
}
function text(seed: number, length: number) {
  // Materialize unique non-rope strings so retained character counts are meaningful.
  const values = new Uint8Array(length)
  for (let i = 0; i < length; i++) values[i] = 33 + ((i * 31 + seed * 17) % 90)
  return new TextDecoder().decode(values)
}
async function run() {
  const store = activateEnvironmentStore("memory-a")
  store.getState().set({ selected: { kind: "thread", id: "visible" } })
  await mark("startup", store)
  for (let t = 0; t < 24; t++) {
    const id = `background-${t}`
    for (let n = 0; n < 64; n++) {
      const event = { seq: t * 64 + n + 1, thread_id: id, turn_id: "turn", at: "2026-09-07T00:00:00Z", kind: "assistant_text_delta", message_id: id, delta: text(t * 64 + n, 16384), origin: { kind: "root" } } as ThreadEvent
      const current = store.getState()
      if (current.receiveEvent) current.receiveEvent(event)
      else current.updateTranscript(id, (previous) => applyEvent(previous, event))
    }
  }
  await mark("background", store)
  for (let t = 0; t < 16; t++) {
    const id = `history-${t}`
    store.getState().set({ selected: { kind: "thread", id } })
    store.getState().updateTranscript(id, () => ({ ...emptyThreadState(), loaded: true, blocks: [{ kind: "assistant", id, messageId: id, turnId: "turn", text: text(t, 2 * 1024 * 1024), thinking: "", complete: true, segment: 0, origin: { kind: "root" } }] }))
  }
  await mark("histories", store)
  activateEnvironmentStore("memory-b")
  await mark("environment-released", store)
  for (const lang of ["typescript", "rust", "python", "json", "css", "bash"]) {
    const html = await highlightToHtml("const answer = 42;\n".repeat(100), lang, true)
    if (!html) throw new Error(`Highlight failed: ${lang}`)
  }
  const signal = new AbortController().signal
  const first = await parseMarkdown({ consumer: 100, source: "# Before idle\n\n**Works**", baseRevision: 0 }, signal)
  if (!first?.blocks.length) throw new Error("Parse failed")
  await mark("workers-warm", store)
  await delay(35000)
  await mark("workers-idle", store)
  const next = await parseMarkdown({ consumer: 100, source: "# After idle\n\n**Still works**", baseRevision: first.revision }, signal)
  const html = await highlightToHtml("const afterIdle = 43;", "typescript", true)
  if (!next?.blocks.length || !html?.includes("afterIdle")) throw new Error("Worker restart failed")
  w.webkit.messageHandlers.bench.postMessage(JSON.stringify({ pass: true, fixture: "memory", markdownPrefix: next.prefix }))
}
run().catch(error => w.webkit.messageHandlers.bench.postMessage(JSON.stringify({ pass: false, error: String(error) })))
