// #299: a connection never has more calls in flight than the daemon allows, control calls never wait behind reads,
// and only a refusal that says "this did not start" is repeated.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { KybernClient, RpcCallError } from "../src/client.ts";
import { CONTROL_METHODS, FEDERATED_LISTS, SLOW_METHODS, SLOW_PREFIXES, busyDelay, laneFor } from "../src/callLanes.ts";
import { PROTOCOL_VERSION, codes } from "../src/types.ts";
import { describeProblem } from "../src/problems.ts";

const wait = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));
const INFO = { version: "0.24.0", protocol_version: PROTOCOL_VERSION, environment_id: "env-a", hostname: "box", os: "linux", arch: "x64", data_dir: "/d", scopes: [], started_at: "" };
const BUSY = { code: codes.CAPACITY_EXCEEDED, message: "Too many calls in flight on this connection; try again in a moment", data: { retry_after_ms: 2, problem: { kind: "conflict", subject: "busy", retryable: true, detail: "x" } } };

/** A connected client whose socket records every request and answers only when told to (or by `auto`). */
async function connected(options = {}, auto = () => undefined) {
  const sent = [];
  const socket = {
    readyState: 1,
    close() {},
    send(frame) {
      const message = JSON.parse(frame);
      sent.push(message);
      const answer = message.method === "daemon.info" ? { result: INFO } : auto(message, sent);
      if (answer) queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id: message.id, ...answer }) }));
    },
  };
  queueMicrotask(() => socket.onopen?.());
  const client = new KybernClient({ url: "ws://10.0.0.5:4173/ws", token: "tok" }, { createSocket: () => socket, ...options });
  client.connect();
  await wait();
  sent.length = 0;
  const answer = (method, body) => {
    const request = sent.find((message) => message.method === method && !message.answered);
    assert.ok(request, `no pending ${method}`);
    request.answered = true;
    socket.onmessage({ data: JSON.stringify({ jsonrpc: "2.0", id: request.id, ...body }) });
  };
  return { client, socket, sent, answer };
}
const methods = (sent) => sent.map((message) => message.method);

test("cheap reads queue behind a budget below the daemon's cap and go out as answers arrive", async () => {
  const { client, sent, answer } = await connected({ callBudget: { standard: 3, slow: 2 } });
  const calls = Array.from({ length: 5 }, (_, i) => client.call("threads.get", { thread_id: `t${i}` }));
  await wait();
  assert.equal(sent.length, 3, "only the budget is in flight");
  answer("threads.get", { result: { n: 1 } });
  await wait();
  assert.equal(sent.length, 4, "an answer frees a slot for the next call, in order");
  assert.deepEqual(sent.map((m) => m.params.thread_id), ["t0", "t1", "t2", "t3"]);
  let done = false;
  void Promise.all(calls).then(() => (done = true));
  for (let turn = 0; !done && turn < 200; turn++) {
    if (sent.some((m) => !m.answered)) answer("threads.get", { result: { n: 1 } });
    await wait(2);
  }
  await Promise.all(calls);
  assert.equal(sent.length, 5);
  client.close();
});

test("slow calls cannot take the budget of cheap reads", async () => {
  const { client, sent } = await connected({ callBudget: { standard: 3, slow: 2 } });
  for (let i = 0; i < 6; i++) void client.call("git.status", { thread_id: `t${i}` }).catch(() => {});
  void client.call("tasks.items.list", {}).catch(() => {});
  void client.call("settings.get", {}).catch(() => {});
  await wait();
  assert.deepEqual(methods(sent).filter((m) => m === "git.status").length, 2);
  assert.ok(methods(sent).includes("tasks.items.list") && methods(sent).includes("settings.get"), "cheap reads are not starved");
  client.close();
});

test("control calls go out at once, even with every other lane full", async () => {
  const { client, sent } = await connected({ callBudget: { standard: 1, slow: 1 } });
  void client.call("threads.get", { thread_id: "a" }).catch(() => {});
  void client.call("threads.get", { thread_id: "b" }).catch(() => {});
  void client.call("git.status", {}).catch(() => {});
  void client.call("threads.interrupt", { thread_id: "a" }).catch(() => {});
  void client.call("approvals.respond", {}).catch(() => {});
  void client.call("threads.send", {}).catch(() => {});
  void client.call("events.unsubscribe", {}).catch(() => {});
  await wait();
  assert.deepEqual(methods(sent), ["threads.get", "git.status", "threads.interrupt", "approvals.respond", "threads.send", "events.unsubscribe"]);
  client.close();
});

test("a busy refusal is retried, and the call resolves once the daemon has room", async () => {
  let refusals = 2;
  const { client, sent } = await connected({}, (message) => (message.method === "tasks.items.list" ? (refusals-- > 0 ? { error: BUSY } : { result: { tasks: [] } }) : undefined));
  assert.deepEqual(await client.call("tasks.items.list", {}), { tasks: [] });
  assert.equal(sent.filter((m) => m.method === "tasks.items.list").length, 3);
  client.close();
});

test("the old daemon's internal 'Too many concurrent requests' is retried too", async () => {
  let refusals = 1;
  const old = { code: codes.INTERNAL_ERROR, message: "Too many concurrent requests; retry after pending requests finish" };
  const { client } = await connected({}, (message) => (message.method === "threads.list" ? (refusals-- > 0 ? { error: { ...old, data: { problem: undefined } } } : { result: { threads: [] } }) : undefined));
  assert.deepEqual(await client.call("threads.list", {}), { threads: [] });
  client.close();
});

test("a mutation is never repeated after any other failure", async () => {
  for (const failure of [{ error: { code: codes.INTERNAL_ERROR, message: "boom" } }, { error: { code: codes.PROVIDER_ERROR, message: "nope" } }]) {
    const { client, sent } = await connected({}, (message) => (message.method === "tasks.items.create" ? failure : undefined));
    await assert.rejects(client.call("tasks.items.create", { title: "x" }), RpcCallError);
    assert.equal(sent.filter((m) => m.method === "tasks.items.create").length, 1);
    client.close();
  }
});

test("a call nobody answers is not repeated", async () => {
  const { client, sent } = await connected({ requestTimeoutMs: 30 });
  await assert.rejects(client.call("tasks.items.create", { title: "x" }), /did not answer/);
  await wait(60);
  assert.equal(sent.length, 1);
  client.close();
});

test("a refusal that keeps coming ends as the busy error, after bounded attempts", async () => {
  const { client, sent } = await connected({ busyRetry: { attempts: 3 } }, (message) => (message.method === "tasks.items.list" ? { error: BUSY } : undefined));
  await assert.rejects(client.call("tasks.items.list", {}), (error) => {
    assert.ok(error instanceof RpcCallError);
    assert.equal(error.code, codes.CAPACITY_EXCEEDED);
    const view = describeProblem(error, { action: "load the tasks" });
    assert.equal(view.title, "Couldn't load the tasks");
    assert.equal(view.body, "Kybern is busy with other work. Try again in a moment.");
    assert.equal(view.action?.label, "Try again");
    assert.doesNotMatch(`${view.title} ${view.body}`, /concurrent|requests|RPC/i);
    return true;
  });
  assert.equal(sent.filter((m) => m.method === "tasks.items.list").length, 3);
  client.close();
});

test("retries stay inside the call's own deadline", async () => {
  const { client } = await connected({ requestTimeoutMs: 40, busyRetry: { attempts: 50 } }, (message) => (message.method === "tasks.items.list" ? { error: { ...BUSY, data: { ...BUSY.data, retry_after_ms: 30 } } } : undefined));
  const started = Date.now();
  await assert.rejects(client.call("tasks.items.list", {}));
  assert.ok(Date.now() - started < 400);
  client.close();
});

test("a call that waits in the queue past its deadline fails without being sent", async () => {
  const { client, sent } = await connected({ callBudget: { standard: 1, slow: 1 }, requestTimeoutMs: 40 });
  const first = client.call("threads.get", { thread_id: "a" }).catch((e) => e);
  const second = client.call("threads.get", { thread_id: "b" }).catch((e) => e);
  await wait(80);
  assert.match((await second).message, /did not answer/);
  assert.match((await first).message, /did not answer/);
  assert.equal(sent.filter((m) => m.method === "threads.get").length, 1);
  client.close();
});

test("queued calls fail with the connection when it closes", async () => {
  const { client, sent } = await connected({ callBudget: { standard: 1, slow: 1 } });
  const first = client.call("threads.get", { thread_id: "a" }).catch((e) => e);
  const queued = client.call("threads.get", { thread_id: "b" }).catch((e) => e);
  await wait();
  client.close("gone");
  assert.equal((await first).message, "gone");
  assert.equal((await queued).message, "gone");
  assert.equal(sent.length, 1);
});

test("busy delay doubles from the daemon's hint, is capped and jittered", () => {
  const mid = () => 0.5;
  assert.equal(busyDelay(0, 400, mid), 400);
  assert.equal(busyDelay(1, 400, mid), 800);
  assert.equal(busyDelay(10, 400, mid), 4000);
  assert.equal(busyDelay(0, undefined, mid), 400);
  assert.ok(busyDelay(0, 400, () => 0) >= 300 && busyDelay(0, 400, () => 1) <= 500);
});

test("lanes match the daemon's lists", () => {
  const rust = readFileSync(new URL("../../../crates/kybern-daemon/src/ws_lanes.rs", import.meta.url), "utf8");
  const list = (name) => {
    const body = new RegExp(`const ${name}: &\\[&str\\] =\\s*&?\\[([\\s\\S]*?)\\];`).exec(rust)?.[1];
    assert.ok(body, `${name} not found in ws_lanes.rs`);
    return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  };
  assert.deepEqual([...CONTROL_METHODS], list("CONTROL"));
  assert.deepEqual([...SLOW_METHODS], list("SLOW"));
  assert.deepEqual([...SLOW_PREFIXES], list("SLOW_PREFIXES"));
  assert.deepEqual([...FEDERATED_LISTS], list("FEDERATED_LISTS"));
});

test("the lane of a call follows its method and the parameters that make it slow", () => {
  assert.equal(laneFor("tasks.items.list", {}), "standard");
  assert.equal(laneFor("tasks.items.list", { machine: "all" }), "slow");
  assert.equal(laneFor("usage.limits", {}), "slow");
  assert.equal(laneFor("usage.limits", { cached: true }), "standard");
  assert.equal(laneFor("github.pr.list", {}), "slow");
  assert.equal(laneFor("providers.accounts.login.cancel", {}), "control");
  assert.equal(laneFor("threads.list", undefined), "standard");
});
