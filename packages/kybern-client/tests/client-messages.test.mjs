// #235: what a connection says when it cannot be used. "environment" is a developer's word; the person has computers.
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ConnectionClosedError, KybernClient } from "../src/client.ts";
import { PROTOCOL_VERSION } from "../src/types.ts";
import { INVALID_ADDRESS, normalizeDaemonUrl } from "../src/address.ts";
import { connectFailureMessage } from "../src/machines.ts";
import { describeProblem } from "../src/problems.ts";
import { trackClients } from "./clients.mjs";

const track = trackClients();

const wait = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));
const INFO = { version: "0.19.0", protocol_version: PROTOCOL_VERSION, environment_id: "env-a", hostname: "box", os: "linux", arch: "x64", data_dir: "/d", scopes: [], started_at: "" };

/** A socket that opens and answers each request with `reply(method, params)`: a result, or `{ error }`. */
function socketWith(reply) {
  const socket = {
    readyState: 1,
    close() {},
    send(frame) {
      const { id, method, params } = JSON.parse(frame);
      const answer = reply(method, params);
      if (answer === undefined) return; // never answers
      const message = answer && answer.error ? { jsonrpc: "2.0", id, error: answer.error } : { jsonrpc: "2.0", id, result: answer };
      queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify(message) }));
    },
  };
  queueMicrotask(() => socket.onopen?.());
  return socket;
}

/** A client over `createSocket`, collecting each status with its detail. */
function connect(reply, options = {}, endpoint = {}) {
  const socket = socketWith(reply);
  const client = track(new KybernClient({ url: "ws://10.0.0.5:4173/ws", token: "tok", ...endpoint }, { createSocket: () => socket, ...options }));
  const seen = [];
  client.onStatus((status, detail) => seen.push([status, detail]));
  client.connect();
  return { client, socket, seen };
}
const detailOf = (seen, status) => seen.find(([s]) => s === status)?.[1];

test("a call on a closed connection says to reconnect to this computer", async () => {
  const client = track(new KybernClient({ url: "ws://10.0.0.5:4173/ws", token: "tok" }));
  await assert.rejects(client.callRaw("threads.list", {}), (error) => {
    assert.ok(error instanceof ConnectionClosedError);
    assert.equal(error.message, "Reconnect to this computer before trying again");
    return true;
  });
});

test("a request nobody answers says the computer did not answer", async () => {
  const { client } = connect((method) => (method === "daemon.info" ? INFO : undefined), { requestTimeoutMs: 20 });
  await wait();
  await assert.rejects(client.callRaw("threads.list", {}), (error) => {
    assert.equal(error.message, "This computer did not answer this request. Reconnect and check its state before retrying");
    return true;
  });
  client.close();
});

test("a ticket that is not a ticket asks to update Kybern on the computer", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ ticket: 12 });
  try {
    const client = track(new KybernClient({ url: "ws://10.0.0.5:4173/ws", token: "tok" }));
    const seen = [];
    client.onStatus((status, detail) => seen.push([status, detail]));
    client.connect();
    await wait();
    assert.equal(detailOf(seen, "reconnecting"), "This computer sent an unexpected reply. Update Kybern on it, then reconnect");
    client.close();
  } finally {
    globalThis.fetch = real;
  }
});

test("a refused credential at the ticket request asks to pair the computer again", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response("no", { status: 401 });
  try {
    const client = track(new KybernClient({ url: "ws://10.0.0.5:4173/ws", token: "old" }));
    const seen = [];
    client.onStatus((status, detail) => seen.push([status, detail]));
    client.connect();
    await wait();
    assert.equal(client.failure, "auth");
    assert.equal(detailOf(seen, "failed"), "Access to this computer was revoked or is no longer valid. Pair it again");
  } finally {
    globalThis.fetch = real;
  }
});

test("a refusal found by the probe says the same", async () => {
  const socket = { readyState: 3, close() {}, send() {} };
  const client = track(new KybernClient({ url: "ws://10.0.0.5:4173/ws", token: "old" }, { createSocket: () => socket, probeAuth: async () => "rejected" }));
  const seen = [];
  client.onStatus((status, detail) => seen.push([status, detail]));
  client.connect();
  await wait();
  socket.onclose({ code: 1002 });
  await wait();
  assert.equal(detailOf(seen, "failed"), "Access to this computer was revoked or is no longer valid. Pair it again");
});

test("revoked access (close code 4401) says to pair the computer again", async () => {
  const { client, socket, seen } = connect((method) => (method === "daemon.info" ? INFO : []));
  await wait();
  socket.onclose({ code: 4401 });
  assert.equal(client.failure, "auth");
  assert.equal(detailOf(seen, "failed"), "Access to this computer was revoked. Pair it again");
});

test("a dropped connection says it is reconnecting to this computer", async () => {
  const { client, socket, seen } = connect((method) => (method === "daemon.info" ? INFO : []));
  await wait();
  socket.onclose({ code: 1006 });
  assert.equal(detailOf(seen, "reconnecting"), "Connection interrupted; reconnecting to this computer");
  client.close();
});

test("a computer on another protocol says to update Kybern on both", async () => {
  const { seen } = connect((method) => (method === "daemon.info" ? { ...INFO, protocol_version: PROTOCOL_VERSION + 1 } : []));
  await wait();
  assert.equal(detailOf(seen, "failed"), "This computer runs a different version of Kybern. Update Kybern on both, then reconnect");
});

test("an address that now belongs to another computer says to add it as a new one", async () => {
  const { seen } = connect((method) => (method === "daemon.info" ? INFO : []), { expectedEnvironmentId: "env-other" });
  await wait();
  assert.equal(detailOf(seen, "failed"), "This address now belongs to a different computer. Add it as a new computer");
});

test("a computer that cannot be verified says so", async () => {
  const { client, seen } = connect((method) => (method === "daemon.info" ? { error: { code: -32603, message: "boom" } } : []));
  await wait();
  assert.equal(detailOf(seen, "reconnecting"), "Unable to verify this computer; reconnecting");
  client.close();
});

test("a subscription the computer rejects says to update Kybern; any other failure retries", async () => {
  const rejected = connect((method) => (method === "daemon.info" ? INFO : { error: { code: -32602, message: "invalid params: after_seq" } }));
  rejected.client.subscribeEvents({}, () => {});
  await wait();
  assert.equal(detailOf(rejected.seen, "failed"), "Unable to stay in sync with this computer. Update Kybern and reconnect");

  const flaky = connect((method) => (method === "daemon.info" ? INFO : { error: { code: -32603, message: "boom" } }));
  flaky.client.subscribeEvents({}, () => {});
  await wait();
  assert.equal(detailOf(flaky.seen, "reconnecting"), "Unable to sync with this computer; retrying");
  flaky.client.close();
});

test("a connection that never opens times out asking whether the computer is on and online", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const socket = { readyState: 0, close() {}, send() {} };
    const client = track(new KybernClient({ url: "ws://10.0.0.5:4173/ws", token: "tok" }, { createSocket: () => socket }));
    const seen = [];
    client.onStatus((status, detail) => seen.push([status, detail]));
    client.connect();
    mock.timers.tick(15_000);
    assert.equal(detailOf(seen, "reconnecting"), "Connection timed out; check that the computer is on and online");
    client.close();
  } finally {
    mock.timers.reset();
  }
});

test("no message in the client says environment", () => {
  const source = readFileSync(new URL("../src/client.ts", import.meta.url), "utf8");
  const literals = source.split(String.fromCharCode(10)).flatMap((line) => line.match(/"[^"]*"/g) ?? []);
  // A quoted sentence (it has a space) that names the environment; field names such as "environment_id" have none.
  assert.deepEqual(literals.filter((text) => /(^|[^A-Za-z_])environment($|[^A-Za-z_])/i.test(text) && text.includes(" ")), []);
});

test("an address that is not an address says what to fix, not 'Invalid URL'", () => {
  for (const input of ["http://", "ws://[::1", "https://exa mple.com", "://nothing"]) {
    assert.throws(() => normalizeDaemonUrl(input), (error) => {
      assert.equal(error.message, INVALID_ADDRESS);
      assert.doesNotMatch(error.message, /invalid url/i);
      return true;
    });
  }
  assert.equal(INVALID_ADDRESS, "That isn't a valid address. Enter the computer's name or IP address, like 192.168.1.20");
});

test("an empty address and an address with a password say what to type", () => {
  assert.throws(() => normalizeDaemonUrl("  "), { message: "Enter the computer's address, like 192.168.1.20 or my-pc.tailnet.ts.net" });
  assert.throws(() => normalizeDaemonUrl("ws://me:secret@10.0.0.5:4173"), { message: "Use just the computer's address, without a user name, password or query, like 192.168.1.20" });
  assert.equal(normalizeDaemonUrl("10.0.0.5"), "ws://10.0.0.5:4173/ws");
});

test("a machine that could not be reached says it is offline, not 'Network request failed'", () => {
  for (const detail of ["Network request failed", "fetch failed", "Failed to fetch", "connect ECONNREFUSED 10.0.0.5:4173", "The operation timed out"])
    assert.equal(connectFailureMessage("SatyaMas", detail), "SatyaMas is offline. Make sure it is awake and online; Kybern keeps trying");
  // Any other reason is still shown, so a broken attempt is never a silent "Offline".
  assert.equal(connectFailureMessage("SatyaMas", "This runtime has no secure random source"), "Unable to connect to SatyaMas: This runtime has no secure random source");
  // The words are read as an offline machine by name.
  const view = describeProblem(new Error(connectFailureMessage("SatyaMas", "Network request failed")), { action: "open the thread" });
  assert.equal(view.kind, "offline");
  assert.equal(view.title, "SatyaMas is offline");
});
