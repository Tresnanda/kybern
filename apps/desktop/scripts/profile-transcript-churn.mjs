// Bounded allocation/time probe for the real transcript grouper. Run with:
// node --expose-gc --experimental-strip-types scripts/profile-transcript-churn.mjs
import assert from "node:assert/strict"
import { registerHooks } from "node:module"
import { performance } from "node:perf_hooks"

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/hot") return { shortCircuit: true, url: new URL("../src/lib/hot.ts", import.meta.url).href }
    return nextResolve(specifier, context)
  },
})

const { createTurnGrouper, groupTurns } = await import("../src/state/transcript.ts")
const ROOT = { kind: "root" }
const AT = "2026-09-14T00:00:00Z"
const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }
const iterations = Number(process.env.KYBERN_CHURN_ITERATIONS ?? 2_000)

function user(turnId, seq) {
  return { kind: "user", id: `user:${turnId}`, turnId, at: AT, seq, message: { parts: [{ type: "text", text: `Inspect ${turnId}` }] } }
}

function assistant(turnId, seq) {
  return { kind: "assistant", id: `answer:${turnId}#0`, messageId: `answer:${turnId}`, turnId, at: AT, seq, origin: ROOT, segment: 0, text: "Done", thinking: "", complete: true }
}

function end(turnId, seq) {
  return { kind: "turn_end", id: `end:${turnId}`, turnId, at: AT, seq, stopReason: "completed", usage: USAGE, costUsd: null, durationMs: 1, terminalMessageId: `answer:${turnId}`, error: null }
}

function settledHistory(turns) {
  return Array.from({ length: turns }, (_, index) => {
    const turnId = `history:${index}`
    return [user(turnId, index * 3 + 1), assistant(turnId, index * 3 + 2), end(turnId, index * 3 + 3)]
  }).flat()
}

function activeWork(tools) {
  const turnId = "work"
  return [
    user(turnId, 1),
    ...Array.from({ length: tools }, (_, index) => ({
      kind: "tool",
      id: `tool:${index}`,
      turnId,
      at: AT,
      seq: index + 2,
      origin: ROOT,
      call: { id: `tool:${index}`, name: "Read", parent_id: null, input: { file_path: `/project/file-${index}.ts` } },
      stream: "",
      output: "received output\n".repeat(80),
      isError: false,
      complete: true,
    })),
    { kind: "assistant", id: "live#0", messageId: "live", turnId, at: AT, seq: tools + 2, origin: ROOT, segment: 0, text: "New output.", thinking: "", complete: false },
  ]
}

function forceGc() {
  globalThis.gc?.()
  globalThis.gc?.()
}

function measure(name, makeBlocks) {
  const samples = []
  for (let run = 0; run < 5; run++) {
    forceGc()
    let blocks = makeBlocks()
    const group = createTurnGrouper()
    let groups = group(blocks)
    const settled = groups[0]
    const startHeap = process.memoryUsage().heapUsed
    let peakHeap = startHeap
    const started = performance.now()
    for (let index = 0; index < iterations; index++) {
      const tail = blocks.at(-1)
      blocks = [...blocks.slice(0, -1), { ...tail, text: `${tail.text}x` }]
      groups = group(blocks)
      peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed)
    }
    const elapsedMs = performance.now() - started
    assert.deepEqual(groups, groupTurns(blocks))
    if (settled && groups.length > 1) assert.equal(groups[0], settled)
    forceGc()
    samples.push({
      elapsedMs,
      peakHeapMiB: (peakHeap - startHeap) / 1024 / 1024,
      retainedMiB: (process.memoryUsage().heapUsed - startHeap) / 1024 / 1024,
    })
  }
  samples.sort((a, b) => a.elapsedMs - b.elapsedMs)
  return { name, iterations, median: samples[2], samples }
}

console.log(JSON.stringify({
  runtime: process.version,
  workloads: [
    measure("group-800-settled-turns", () => [...settledHistory(800), ...activeWork(0)]),
    measure("group-800-active-tools", () => activeWork(800)),
  ],
}, null, 2))
