import assert from "node:assert/strict";
import test from "node:test";
import { createPendingStore, isComposerOutbox, isWaitingOutbox, outboxThreadId, queuedPhase, settledPending, waitingLabel, withPending } from "../src/pendingSends.ts";

const message = { parts: [{ type: "text", text: "Ship it" }] };
const send = (id, delivery = "send") => ({ id, threadId: "thread", message, at: "2026-10-21T10:00:00.000Z", delivery, state: "sending" });
const history = [
  { kind: "user", id: "m0", turnId: "t0", at: "2026-10-21T09:00:00.000Z", seq: 1, message },
  { kind: "turn_end", id: "e0", turnId: "t0", at: "2026-10-21T09:00:01.000Z", seq: 2, stopReason: "completed", usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }, costUsd: null, durationMs: 1, terminalMessageId: null, error: null },
];

test("a pending send is its own turn after the history, with the same array for the same inputs", () => {
  const store = createPendingStore();
  store.add(send("m1"));
  const pending = store.pendingFor("thread");
  const merged = withPending(history, pending);
  assert.deepEqual(merged.slice(0, 2), history);
  assert.equal(merged[2].kind, "user");
  assert.equal(merged[2].id, "m1");
  assert.equal(merged[2].turnId, "pending:m1");
  assert.deepEqual(merged[2].message, message);
  assert.equal(withPending(history, pending), merged);
  assert.equal(withPending(history, []), history);
});

test("a steer joins the running turn, as its message_steered block will", () => {
  const store = createPendingStore();
  store.add(send("m2", "steer"));
  const live = [...history, { kind: "user", id: "m1", turnId: "t1", at: "2026-10-21T10:00:00.000Z", seq: 3, message }];
  const last = withPending(live, store.pendingFor("thread")).at(-1);
  assert.equal(last.id, "m2");
  assert.equal(last.turnId, "t1");
});

test("the daemon's block with the same id replaces the pending one", () => {
  const store = createPendingStore();
  store.add(send("m1"));
  const real = [...history, { kind: "user", id: "m1", turnId: "t1", at: "2026-10-21T10:00:00.050Z", seq: 3, message }];
  assert.deepEqual(settledPending(real, store.pendingFor("thread")), ["m1"]);
  assert.equal(withPending(real, store.pendingFor("thread")), real);
});

test("state changes notify, and a failed send keeps its error", () => {
  const store = createPendingStore();
  let calls = 0;
  const stop = store.subscribe(() => calls++);
  store.add(send("m1"));
  store.update("thread", "m1", { state: "failed", error: "Thread not found." });
  const [failed] = store.pendingFor("thread");
  assert.equal(failed.state, "failed");
  assert.equal(failed.error, "Thread not found.");
  store.remove("thread", "m1");
  assert.deepEqual(store.pendingFor("thread"), []);
  assert.equal(calls, 3);
  stop();
  store.add(send("m2"));
  assert.equal(calls, 3);
});

test("adding the same id again replaces it, and an unknown update does nothing", () => {
  const store = createPendingStore();
  let calls = 0;
  store.subscribe(() => calls++);
  store.add(send("m1"));
  store.add({ ...send("m1"), state: "failed", error: "x" });
  assert.equal(store.pendingFor("thread").length, 1);
  store.update("thread", "missing", { state: "accepted" });
  store.remove("thread", "missing");
  assert.equal(calls, 2);
});

test("pendingFor is stable between changes and empty for no thread", () => {
  const store = createPendingStore();
  assert.equal(store.pendingFor(null), store.pendingFor(undefined));
  store.add(send("m1"));
  assert.equal(store.pendingFor("thread"), store.pendingFor("thread"));
});

test("clear forgets every thread and notifies once, only when something was pending", () => {
  const store = createPendingStore();
  let calls = 0;
  store.subscribe(() => calls++);
  store.clear();
  assert.equal(calls, 0);
  store.add(send("m1"));
  store.clear();
  assert.equal(calls, 2);
  assert.deepEqual(store.pendingFor("thread"), []);
});

test("a waiting send stays until its machine takes it: no timeout, and it can name the machine", async () => {
  const store = createPendingStore();
  store.add({ ...send("m1"), state: "sending" });
  store.update("thread", "m1", { state: "waiting", machineId: "sat" });
  const [waiting] = store.pendingFor("thread");
  assert.equal(waiting.state, "waiting");
  assert.equal(waiting.machineId, "sat");
});

test("outbox states map to what the person reads", () => {
  assert.equal(waitingLabel("satyamas"), "Waiting for satyamas");
  assert.deepEqual(queuedPhase({ state: "queued", attempts: 0 }, "satyamas"), { phase: "waiting", label: "Waiting for satyamas", attempts: 0 });
  assert.equal(queuedPhase({ state: "sending", attempts: 3 }, "satyamas").phase, "waiting");
  assert.equal(queuedPhase({ state: "delivered", attempts: 1 }, "satyamas").phase, "delivered");
  assert.match(queuedPhase({ state: "expired", attempts: 20 }, "satyamas").error, /satyamas did not come back in time\. Retry/);
  assert.match(queuedPhase({ state: "cancelled", attempts: 0 }, "satyamas").error, /cancelled/);
  assert.equal(queuedPhase({ state: "failed", attempts: 1, last_error: "No checkout here." }, "satyamas").error, "No checkout here.");
  assert.match(queuedPhase({ state: "failed", attempts: 1, last_error: " " }, "satyamas").error, /satyamas could not start the chat/);
  assert.equal(isWaitingOutbox("queued"), true);
  assert.equal(isWaitingOutbox("delivered"), false);
});

test("a composer send in the outbox names its thread", () => {
  assert.equal(outboxThreadId({ kind: "thread_create", payload: { thread_id: "t9" } }), "t9");
  assert.equal(outboxThreadId({ kind: "thread_send", payload: { thread_id: "t8" } }), "t8");
  assert.equal(outboxThreadId({ kind: "delegate", payload: { thread_id: "t7" } }), undefined);
  assert.equal(outboxThreadId({ kind: "thread_create", payload: null }), undefined);
  assert.equal(isComposerOutbox({ kind: "fork" }), false);
});
