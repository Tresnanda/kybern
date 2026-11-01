import test from "node:test";
import assert from "node:assert/strict";
import { doctorRows, doctorSummary, outboxRows, updateResultRows, updateSummary } from "../src/networkSettings.ts";

const names = new Map([["a", "Mac"], ["b", "satyamas"]]);
const item = (id, state, extra = {}) => ({ id, operation_id: id, target: "b", kind: "thread_create", payload: null, state, attempts: 0, created_at: "2026-11-01T00:00:00Z", expires_at: "2026-11-02T00:00:00Z", updated_at: "2026-11-01T00:00:00Z", ...extra });

test("update summary: none, some, and skipped", () => {
  assert.equal(updateSummary({ started: [], skipped: [] }), "No other machines to update.");
  assert.equal(updateSummary({ started: [], skipped: [{ machine_id: "a", reason: "busy" }] }), "Nothing was updated.");
  assert.equal(updateSummary({ started: ["a"], skipped: [] }), "Started 1 update.");
  assert.equal(updateSummary({ started: ["a", "b"], skipped: [{ machine_id: "c", reason: "x" }] }), "Started 2 updates, 1 skipped.");
  assert.deepEqual(updateResultRows({ started: ["a"], skipped: [{ machine_id: "z", reason: "Offline" }] }, names).map((row) => [row.name, row.started, row.text]), [["Mac", true, "Update started"], ["A machine", false, "Offline"]]);
});

test("outbox rows hide history and allow retry only for stuck items", () => {
  const rows = outboxRows([item("1", "queued", { attempts: 2 }), item("2", "delivered"), item("3", "expired"), item("4", "sending")], names);
  assert.deepEqual(rows.map((row) => [row.id, row.detail, row.canRetry, row.canCancel]), [
    ["1", "Waiting for satyamas · tried 2 times", false, true],
    ["3", "Not delivered to satyamas in time", true, true],
    ["4", "Sending to satyamas", false, false],
  ]);
});

test("network check lists failures first and names the machine", () => {
  const report = { generated_at: "x", checks: [{ id: "ok", status: "pass", title: "Tailscale is running" }, { id: "peer", status: "fail", title: "Cannot reach", machine_id: "b", next_step: "Open Kybern on satyamas." }, { id: "w", status: "warn", title: "Old version" }] };
  const rows = doctorRows(report, names);
  assert.deepEqual(rows.map((row) => [row.tone, row.title, row.next]), [["bad", "satyamas: Cannot reach", "Open Kybern on satyamas."], ["warn", "Old version", ""], ["good", "Tailscale is running", ""]]);
  assert.equal(doctorSummary(report), "2 of 3 checks need a look");
});
