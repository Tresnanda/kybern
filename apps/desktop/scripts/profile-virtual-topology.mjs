import { createRequire } from "node:module"
import { performance } from "node:perf_hooks"
import { Virtualizer } from "@tanstack/react-virtual"
import { reconcileVirtualTopology } from "../src/lib/virtualTopology.ts"

// Run from apps/desktop:
// node --experimental-strip-types scripts/profile-virtual-topology.mjs
// Optional: --rows 1600 --updates 4000 --rounds 5

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0) return fallback
  const value = Number(process.argv[index + 1])
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`--${name} must be a positive integer`)
  return value
}

const rows = option("rows", 1_600)
const updates = option("updates", 4_000)
const rounds = option("rounds", 5)
const require = createRequire(import.meta.url)
const reactVirtualPath = require.resolve("@tanstack/react-virtual")
const dependencyRequire = createRequire(reactVirtualPath)
const reactVirtualVersion = require("@tanstack/react-virtual/package.json").version
const virtualCoreVersion = dependencyRequire("@tanstack/virtual-core/package.json").version

const common = {
  count: rows,
  getScrollElement: () => null,
  scrollToFn: () => {},
  observeElementRect: () => {},
  observeElementOffset: () => {},
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function run(mode, iterations, instrument = false) {
  let items = Array.from({ length: rows }, (_, index) => ({ id: `row-${index}`, estimate: 32, content: 0 }))
  let topologyKeyCalls = 0
  let topologyEstimateCalls = 0
  const topologyKey = instrument ? item => { topologyKeyCalls++; return item.id } : item => item.id
  const topologyEstimate = instrument ? item => { topologyEstimateCalls++; return item.estimate } : item => item.estimate
  let topology = reconcileVirtualTopology(null, items, topologyKey, topologyEstimate)
  let coreKeyCalls = 0
  let getItemKey = instrument ? index => { coreKeyCalls++; return topology.keys[index] } : index => topology.keys[index]
  let estimateSize = index => topology.estimates[index]
  const virtualizer = new Virtualizer({ ...common, getItemKey, estimateSize })
  virtualizer.getVirtualItems()
  coreKeyCalls = 0
  topologyKeyCalls = 0
  topologyEstimateCalls = 0

  const started = performance.now()
  for (let update = 0; update < iterations; update++) {
    const next = items.slice()
    next[rows - 1] = { ...next[rows - 1], content: update + 1 }
    items = next

    if (mode === "stable-topology") {
      const nextTopology = reconcileVirtualTopology(topology, items, topologyKey, topologyEstimate)
      if (nextTopology !== topology) {
        topology = nextTopology
        getItemKey = instrument ? index => { coreKeyCalls++; return topology.keys[index] } : index => topology.keys[index]
        estimateSize = index => topology.estimates[index]
      }
    } else {
      getItemKey = instrument ? index => { coreKeyCalls++; return items[index].id } : index => items[index].id
      estimateSize = index => items[index].estimate
    }

    virtualizer.setOptions({ ...common, getItemKey, estimateSize })
    virtualizer.getVirtualItems()
  }
  const milliseconds = performance.now() - started

  if (virtualizer.getTotalSize() !== rows * 32) throw new Error(`${mode} produced incorrect total size`)
  if (items.at(-1).content !== iterations) throw new Error(`${mode} did not execute every update`)
  return { milliseconds, coreKeyCalls, topologyKeyCalls, topologyEstimateCalls }
}

// Warm both paths before collecting alternating rounds. Timing includes every
// immutable item-array copy, topology comparison, setOptions, and range read.
run("replaced-callback", Math.min(250, updates))
run("stable-topology", Math.min(250, updates))

const samples = { "replaced-callback": [], "stable-topology": [] }
for (let round = 0; round < rounds; round++) {
  const order = round % 2 ? ["stable-topology", "replaced-callback"] : ["replaced-callback", "stable-topology"]
  for (const mode of order) samples[mode].push(run(mode, updates))
}
const calls = {
  // Instrumentation changes hot-loop cost, so collect call counts outside the
  // timing rounds rather than inflating one path's measured wall time.
  "replaced-callback": run("replaced-callback", updates, true),
  "stable-topology": run("stable-topology", updates, true),
}

const summarize = mode => ({
  medianMs: Number(median(samples[mode].map(sample => sample.milliseconds)).toFixed(1)),
  timesMs: samples[mode].map(sample => Number(sample.milliseconds.toFixed(1))),
  coreKeyCalls: calls[mode].coreKeyCalls,
  topologyKeyCalls: calls[mode].topologyKeyCalls,
  topologyEstimateCalls: calls[mode].topologyEstimateCalls,
})
const replaced = summarize("replaced-callback")
const stable = summarize("stable-topology")

console.log(JSON.stringify({
  runtime: process.version,
  reactVirtualVersion,
  virtualCoreVersion,
  workload: {
    rows,
    updates,
    rounds,
    mutation: "immutable final-item content replacement; stable keys and estimates",
    timingIncludes: "item-array copies, topology comparison, setOptions, and getVirtualItems; call counters run separately",
  },
  replacedCallback: replaced,
  stableTopology: stable,
  speedup: Number((replaced.medianMs / stable.medianMs).toFixed(2)),
  limitation: "Synthetic Node wall time and call counts only; this is not native frame time or a physical-memory measurement.",
}, null, 2))
