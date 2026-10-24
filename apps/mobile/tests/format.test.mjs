import assert from "node:assert/strict";
import test from "node:test";
import { formatUsd, nameList, turnFooterText } from "../src/state/format.ts";
import { workDuration } from "../src/state/turnRows.ts";

const clock = (date) => `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
const turn = { at: "2026-10-24T00:37:00Z", stopReason: "completed", durationMs: 4_213_000, costUsd: 70.0823 };

test("costs show two decimals, grouped, and nothing for zero or missing", () => {
  assert.equal(formatUsd(70.0823), "$70.08");
  assert.equal(formatUsd(3.185), "$3.19");
  assert.equal(formatUsd(1234.5), "$1,234.50");
  assert.equal(formatUsd(0.004), "<$0.01");
  assert.equal(formatUsd(0), null);
  assert.equal(formatUsd(null), null);
  assert.equal(formatUsd(Number.NaN), null);
});

test("a finished turn reads time · duration · cost", () => {
  assert.equal(turnFooterText(turn, clock, workDuration), "00:37 · 1h 10m · $70.08");
  assert.equal(turnFooterText({ ...turn, durationMs: 223_000, costUsd: 3.52 }, clock, workDuration), "00:37 · 3m 43s · $3.52");
});

test("a turn that did not complete says how it ended first", () => {
  assert.equal(turnFooterText({ ...turn, stopReason: "interrupted", costUsd: null }, clock, workDuration), "Stopped · 00:37 · 1h 10m");
  assert.equal(turnFooterText({ ...turn, stopReason: "error", durationMs: 0, costUsd: 0 }, clock, workDuration), "Failed · 00:37");
  assert.equal(turnFooterText({ ...turn, stopReason: "max_turns", costUsd: null, durationMs: null }, clock, workDuration), "Turn limit reached · 00:37");
});

test("a bad timestamp drops the time instead of printing Invalid Date", () => {
  assert.equal(turnFooterText({ ...turn, at: "nope" }, clock, workDuration), "1h 10m · $70.08");
});

test("name lists stay short and whole", () => {
  assert.equal(nameList([]), "");
  assert.equal(nameList(["Ann"]), "Ann");
  assert.equal(nameList(["Ann", "Bo"]), "Ann and Bo");
  assert.equal(nameList(["Ann", "Bo", "Ann", "Cy"]), "Ann, Bo and Cy");
  assert.equal(nameList(["Ann", "Bo", "Cy", "Di"]), "Ann, Bo and 2 others");
});
