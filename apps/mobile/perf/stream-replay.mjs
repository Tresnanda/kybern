// Deterministic display-cadence comparison, not a frame-time/CPU benchmark.
// Run: node --experimental-strip-types perf/stream-replay.mjs
import {
  advanceReveal,
  revealBoundary,
  REVEAL_INTERVAL_MS,
} from "../src/lib/streamPacing.ts";
const payload =
  "Text with **formatting**, `inline code`, and a paragraph.\n\n".repeat(150);
let target = "",
  position = 0,
  visible = 0,
  lastCommit = 0,
  lastArrival = -250;
const before = [],
  after = [];
for (let now = 0; now <= 15_000; now += 1000 / 60) {
  if (now - lastArrival >= 249 && target.length < payload.length) {
    const previous = target.length;
    target = payload.slice(0, target.length + 120);
    before.push(target.length - previous);
    lastArrival = now;
    // A newly mounted message shows its first received chunk immediately.
    if (before.length === 1) {
      position = visible = target.length;
      after.push(visible);
      lastCommit = now;
    }
  }
  position = advanceReveal(position, target.length, 1000 / 60);
  const next = revealBoundary(target, position);
  if (
    next !== visible &&
    (next === target.length || now - lastCommit >= REVEAL_INTERVAL_MS)
  ) {
    after.push(next - visible);
    visible = next;
    lastCommit = now;
  }
}
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    updates: values.length,
    charactersPerUpdateP95: sorted[Math.floor(sorted.length * 0.95)],
    largestUpdate: Math.max(...values),
  };
}
console.log(
  JSON.stringify(
    {
      workload:
        "120 characters every 250 ms for 15 seconds; synthetic 60 Hz clock",
      runtime: process.version,
      baseline: stats(before),
      paced: stats(after),
      pendingCharactersBeforeCompletion: target.length - visible,
      finalCharactersOnCompletion: target.length,
    },
    null,
    2,
  ),
);
