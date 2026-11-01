// HTTP to another machine (`/assets`, thread images) goes through its connection: the app holds a
// `MachineClientProxy` whose endpoint has no address and no token, so `fetch` is the only way in.
import test from "node:test";
import assert from "node:assert/strict";
import { KybernClient } from "../src/client.ts";
import { MachineClientProxy } from "../src/machineClient.ts";
import { MachineSet, OfflineError, kybernClientFactory } from "../src/machines.ts";
import { MachineCache } from "../src/machineCache.ts";
import { fakeWorld, manualClock, memoryCacheStorage, memoryCredentials, memoryStore, verifyProof } from "./machine-fakes.mjs";

const A = "http://100.64.0.1:4173"; // member a, also the relay
const T = "http://100.64.0.2:4173"; // b on the tailnet
const tailnet = (url) => ({ kind: "direct_tailnet", url });
const rec = (machineId, routes, extra = {}) => ({ machineId, name: machineId, routes, member: true, ...extra });
const socket = () => ({ close() {}, send() {} });

/** Replace the global `fetch` for one test; every request is recorded with its headers as a plain object. */
function captureFetch(t, respond = () => new Response(JSON.stringify({ id: "asset-1" }), { status: 200 })) {
  const requests = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const request = { url: String(url), method: init.method ?? "GET", headers: Object.fromEntries(new Headers(init.headers)), redirect: init.redirect, signal: init.signal };
    requests.push(request);
    return respond(request);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return requests;
}

/** A machine set whose connections are fakes, except `fetch`, which is the real client's for that route. */
function setup(records, credentials) {
  const clock = manualClock();
  const world = fakeWorld(clock);
  const real = kybernClientFactory(socket);
  const set = new MachineSet({
    store: memoryStore(records),
    credentials: memoryCredentials(credentials),
    deviceId: "desktop-1",
    verifyProof,
    clock,
    cache: new MachineCache(memoryCacheStorage()),
    localMachineId: "a",
    transport: {
      ...world.transport,
      createClient(args) {
        const fake = world.transport.createClient(args);
        const client = real(args);
        fake.fetch = (path, init) => client.fetch(path, init);
        return fake;
      },
    },
  });
  return { world, set };
}

test("a direct route's fetch goes to the route with the machine's token", async (t) => {
  const requests = captureFetch(t);
  const client = kybernClientFactory(socket)({ record: rec("b", []), route: tailnet(T), token: "tok-b" });
  const response = await client.fetch("/assets", { method: "POST", headers: { "content-type": "image/png", authorization: "Bearer stolen" }, body: new Uint8Array([1, 2, 3]) });
  assert.deepEqual(await response.json(), { id: "asset-1" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `${T}/assets`);
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].headers.authorization, "Bearer tok-b", "the caller cannot pick the credential");
  assert.equal(requests[0].headers["content-type"], "image/png");
  assert.equal(requests[0].headers["x-kybern-relay-auth"], undefined);
  assert.equal(requests[0].redirect, "error", "a redirect never carries the token elsewhere");
});

test("a relay route's fetch goes through the member under /http with both tokens", async (t) => {
  const requests = captureFetch(t);
  const route = { kind: "relay", url: `${A}/relay/b`, via: "a" };
  const client = kybernClientFactory(socket)({ record: rec("b", []), route, token: "tok-b", relayToken: "tok-a" });
  await client.fetch("/assets/asset-1");
  assert.equal(requests[0].url, `${A}/relay/b/http/assets/asset-1`);
  assert.equal(requests[0].headers.authorization, "Bearer tok-b", "Authorization is the target's token end to end");
  assert.equal(requests[0].headers["x-kybern-relay-auth"], "Bearer tok-a", "the member reads its caller's token from its own header");
});

test("fetch only takes a path on the daemon", async (t) => {
  const requests = captureFetch(t);
  const client = new KybernClient({ url: "ws://127.0.0.1:4173/ws", token: "tok" });
  for (const path of ["https://elsewhere.example/assets", "//elsewhere.example/assets", "assets"])
    await assert.rejects(client.fetch(path), /path that starts with \//);
  assert.equal(requests.length, 0);
  await client.fetch("/assets/x");
  assert.equal(requests[0].url, "http://127.0.0.1:4173/assets/x", "a client without a route keeps its own address");
});

test("another machine's client uploads and reads on its route without exposing the address or token", async (t) => {
  const requests = captureFetch(t);
  const { world, set } = setup([rec("a", [tailnet(A)], { signingKey: "key-a" }), rec("b", [tailnet(T)], { signingKey: "key-b" })], { a: "tok-a", b: "tok-b" });
  world.host(A, "a");
  world.host(T, "b");
  world.lists("a", [], []);
  world.lists("b", [], []);
  await set.ensureAll();
  const b = set.clientFor("b");
  assert.ok(b instanceof MachineClientProxy);
  assert.equal(b.endpoint.url, "", "the proxy carries no address");
  assert.equal(b.endpoint.token, "", "the proxy carries no token");

  await b.fetch("/assets", { method: "POST", headers: { "content-type": "image/png" }, body: new Uint8Array([1]) });
  assert.equal(requests[0].url, `${T}/assets`);
  assert.equal(requests[0].headers.authorization, "Bearer tok-b");
  set.dispose();
});

test("a machine reached through a relay uploads through the member", async (t) => {
  const requests = captureFetch(t);
  const { world, set } = setup([rec("a", [tailnet(A)], { signingKey: "key-a" }), rec("b", [], { signingKey: "key-b" })], { a: "tok-a", b: "tok-b" });
  world.host(A, "a");
  world.host(`${A}/relay/b`, "b");
  world.lists("a", [], []);
  world.lists("b", [], []);
  await set.ensureAll();
  assert.equal(set.connection("b").status, "relaying");
  await set.clientFor("b").fetch("/assets", { method: "POST", body: new Uint8Array([1]) });
  assert.equal(requests[0].url, `${A}/relay/b/http/assets`);
  assert.equal(requests[0].headers.authorization, "Bearer tok-b");
  assert.equal(requests[0].headers["x-kybern-relay-auth"], "Bearer tok-a");
  set.dispose();
});

test("an offline machine's fetch fails with its name", async (t) => {
  const requests = captureFetch(t);
  const { world, set } = setup([rec("a", [tailnet(A)], { signingKey: "key-a" }), rec("b", [tailnet(T)], { signingKey: "key-b", name: "instabox" })], { a: "tok-a", b: "tok-b" });
  world.host(A, "a");
  world.host(T, "b", { online: false });
  world.lists("a", [], []);
  await set.ensureAll();
  await assert.rejects(set.handleFor("b").fetch("/assets"), (error) => error instanceof OfflineError && error.message === "instabox is offline. Try again when it reconnects.");
  assert.equal(requests.length, 0);
  set.dispose();
});

test("a connection change during a request aborts it with a readable error", async () => {
  const proxy = new MachineClientProxy("b", () => false, () => "instabox");
  let seen;
  const inner = {
    onStatus: () => () => {},
    onNotification: () => () => {},
    status: "open",
    fetch: (_path, init) =>
      new Promise((_resolve, reject) => {
        seen = init.signal;
        init.signal.addEventListener("abort", () => reject(init.signal.reason));
      }),
  };
  proxy.attach(inner);
  const pending = proxy.fetch("/assets", { method: "POST" });
  proxy.attach(undefined);
  await assert.rejects(pending, (error) => error instanceof OfflineError && error.message === "instabox is offline. Try again when it reconnects.");
  assert.equal(seen.aborted, true, "the request on the old route is cancelled");

  // The caller's own abort stays the caller's.
  proxy.attach(inner);
  const caller = new AbortController();
  const mine = proxy.fetch("/assets", { signal: caller.signal });
  caller.abort(new Error("cancelled by the page"));
  await assert.rejects(mine, /cancelled by the page/);
});

test("request gives a native loader the route's URL and headers, relay member's token included", () => {
  const direct = kybernClientFactory(socket)({ record: rec("b", []), route: tailnet(T), token: "tok-b" });
  assert.deepEqual(direct.request("/assets/x"), { url: `${T}/assets/x`, headers: { authorization: "Bearer tok-b" } });
  const relayed = kybernClientFactory(socket)({
    record: rec("b", []),
    route: { kind: "relay", url: `${A}/relay/b`, via: "a" },
    token: "tok-b",
    relayToken: "tok-a",
  });
  assert.deepEqual(relayed.request("/threads/t/image?path=a.png"), {
    url: `${A}/relay/b/http/threads/t/image?path=a.png`,
    headers: { "X-Kybern-Relay-Auth": "Bearer tok-a", authorization: "Bearer tok-b" },
  });
  assert.throws(() => relayed.request("//evil/x"), /starts with \//);
});

test("a machine proxy's request follows its connection and is offline without one", () => {
  const proxy = new MachineClientProxy("b", () => true);
  assert.throws(() => proxy.request("/assets/x"), OfflineError);
});
