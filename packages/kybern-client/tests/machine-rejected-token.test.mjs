// A native socket refused at the upgrade (HTTP 401) closes with 1002 "Expected 101 status code" and
// never reports the status. The client must still learn that the credential was refused, so the
// machine set can mint a new one (found in the test network: stale tokens left machines offline).
import test from "node:test";
import assert from "node:assert/strict";
import { KybernClient } from "../src/client.ts";
import { MachineSet, kybernClientFactory, probeAuth } from "../src/machines.ts";
import { fakeWorld, manualClock, memoryCacheStorage, memoryCredentials, memoryStore, verifyProof } from "./machine-fakes.mjs";
import { MachineCache } from "../src/machineCache.ts";

/** What Bun does for a 401 at the upgrade: close 1002, no open, no status. */
function refusedSocket() {
  const socket = { close() {}, send() {} };
  queueMicrotask(() => socket.onclose?.({ code: 1002, reason: "Expected 101 status code" }));
  return socket;
}

function withFetch(handler, run) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return Promise.resolve(run(calls)).finally(() => {
    globalThis.fetch = real;
  });
}

const wait = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

test("a socket refused at the upgrade fails with an auth failure once the machine confirms the 401", async () => {
  await withFetch(
    () => new Response("invalid token", { status: 401 }),
    async (calls) => {
      const client = new KybernClient(
        { url: "http://100.64.0.2:4173", token: "old" },
        { createSocket: refusedSocket, probeAuth: () => probeAuth("http://100.64.0.2:4173", "old", undefined, false) },
      );
      const seen = [];
      client.onStatus((status, detail) => seen.push([status, detail]));
      client.connect();
      await wait();
      assert.equal(client.status, "failed");
      assert.equal(client.failure, "auth");
      assert.equal(calls[0].url, "http://100.64.0.2:4173/session");
      assert.equal(calls[0].init.method, "POST");
      assert.equal(calls[0].init.headers.authorization, "Bearer old");
      assert.ok(!seen.some(([status]) => status === "reconnecting"), "no retry loop for a refused credential");
    },
  );
});

test("a refused socket on a machine that is just down keeps retrying", async () => {
  await withFetch(
    () => {
      throw new TypeError("fetch failed");
    },
    async () => {
      const client = new KybernClient(
        { url: "http://100.64.0.2:4173", token: "tok" },
        { createSocket: refusedSocket, probeAuth: () => probeAuth("http://100.64.0.2:4173", "tok", undefined, false) },
      );
      client.connect();
      await wait();
      assert.equal(client.status, "reconnecting");
      assert.equal(client.failure, undefined);
      client.close();
    },
  );
});

test("a relay route sends the relay header, and a refusal naming the relay is not the target's token", async () => {
  const headers = { "X-Kybern-Relay-Auth": "Bearer tok-a" };
  await withFetch(
    () => new Response("the relay needs a device token for this machine in X-Kybern-Relay-Auth", { status: 401 }),
    async (calls) => {
      assert.equal(await probeAuth("http://100.64.0.1:4173/relay/b", "tok-b", headers, true), "unknown");
      assert.equal(calls[0].url, "http://100.64.0.1:4173/relay/b/session");
      assert.equal(calls[0].init.headers["X-Kybern-Relay-Auth"], "Bearer tok-a");
    },
  );
  await withFetch(
    () => new Response("invalid token", { status: 401 }),
    async () => assert.equal(await probeAuth("http://100.64.0.1:4173/relay/b", "tok-b", headers, true), "rejected"),
  );
});

test("the machine set mints a new token after the real client reports a refused upgrade", async () => {
  const clock = manualClock();
  const world = fakeWorld(clock);
  const creds = memoryCredentials({ a: "tok-a", b: "old" });
  const T = "http://100.64.0.2:4173";
  const tailnet = (url) => ({ kind: "direct_tailnet", url });
  const rec = (machineId, routes, extra = {}) => ({ machineId, name: machineId, routes, member: true, ...extra });
  const store = memoryStore([rec("a", [tailnet("http://100.64.0.1:4173")], { signingKey: "key-a" }), rec("b", [tailnet(T)], { signingKey: "key-b" })]);
  world.host("http://100.64.0.1:4173", "a");
  world.host(T, "b");
  world.lists("a", [], []);
  world.lists("b", [], []);
  world.on("a", "network.client_grant", () => ({ token: "new", scopes: [], routes: [] }));
  const sockets = [];
  const real = kybernClientFactory((url, token) => {
    sockets.push(token);
    return refusedSocket();
  });
  // Machine "a" is served by the fake world; "b" gets the real client whose socket is refused for "old".
  const set = new MachineSet({
    store,
    credentials: creds,
    deviceId: "phone-1",
    verifyProof,
    clock,
    cache: new MachineCache(memoryCacheStorage()),
    localMachineId: "a",
    transport: {
      ...world.transport,
      createClient: (args) => (args.record.machineId === "b" && args.token === "old" ? real(args) : world.transport.createClient(args)),
    },
  });
  await withFetch(
    (url, init) =>
      init.headers.authorization === "Bearer old" ? new Response("invalid token", { status: 401 }) : new Response("{}", { status: 200 }),
    async () => {
      const done = set.ensureAll();
      for (let i = 0; i < 10; i++) {
        await clock.advance(1000);
        await wait(5);
      }
      await done;
    },
  );
  assert.deepEqual(sockets, ["old"]);
  assert.equal(creds.tokens.get("b"), "new");
  assert.equal(set.connection("b").status, "online");
  set.dispose();
});
