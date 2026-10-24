import assert from "node:assert/strict";
import test from "node:test";
import { createTurnRows } from "../src/state/turnRows.ts";
import { createPendingStore, withPending, settledPending } from "../../../packages/kybern-client/src/pendingSends.ts";

const message = { parts: [{ type: "text", text: "Also check Android" }] };

test("a failed follow-up stays as its own turn until the real message replaces it", () => {
  const store = createPendingStore();
  store.add({ id: "m1", threadId: "t", message, at: "2026-10-24T00:00:00Z", delivery: "send", state: "failed", error: "Offline" });
  const blocks = [];
  const shown = withPending(blocks, store.pendingFor("t"));
  const rows = createTurnRows("t")(shown, new Set());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].block.id, "m1");
  assert.equal(rows[0].block.turnId, "pending:m1");
  // The daemon's own user block carries the same id once a retry goes through.
  const real = [{ kind: "user", id: "m1", turnId: "turn", at: "2026-10-24T00:00:01Z", seq: 4, message }];
  assert.deepEqual(settledPending(real, store.pendingFor("t")), ["m1"]);
  store.remove("t", "m1");
  assert.equal(withPending(real, store.pendingFor("t")), real);
});
