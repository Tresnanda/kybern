import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { nativeModuleSource } from "./native-mocks.mjs";
import { createNativeSocket } from "../src/state/nativeSocket.ts";

const saved = globalThis.__secure;
globalThis.reconnectSubscribe = (_subscribe, getSnapshot) => getSnapshot();
registerHooks({
  resolve(specifier, context, next) {
    const source = nativeModuleSource(specifier);
    if (source)
      return {
        shortCircuit: true,
        url: `data:text/javascript,${encodeURIComponent(source)}`,
      };
    const url =
      specifier.startsWith(".") && context.parentURL
        ? new URL(specifier, context.parentURL)
        : null;
    if (
      url?.protocol === "file:" &&
      !/\.[a-z]+$/i.test(url.pathname) &&
      existsSync(fileURLToPath(url) + ".ts")
    ) {
      return { shortCircuit: true, url: url.href + ".ts" };
    }
    return next(specifier, context);
  },
});
const runtime = await import("../src/state/runtime.ts");
const endpoint = "ws://100.64.0.2:4173/ws";
const sockets = [];
class NativeSocket {
  readyState = 0;
  constructor(url, protocols, options) {
    this.url = url;
    this.options = options;
    sockets.push(this);
  }
  close() {
    this.readyState = 3;
  }
}

function mockNativeSocket(t) {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = NativeSocket;
  t.after(() => {
    globalThis.WebSocket = original;
  });
}

test("native sockets authenticate in headers with the trusted app origin, never the URL", (t) => {
  mockNativeSocket(t);
  const socket = createNativeSocket(endpoint, "test-device-token");
  assert.equal(socket.url, endpoint);
  assert.equal(socket.options.headers.origin, "tauri://localhost");
  assert.equal(
    socket.options.headers.Authorization,
    "Bearer test-device-token",
  );
  assert.ok(!socket.url.includes("test-device-token"));
});

test("redeemed pairing survives a failed socket handshake and reconnect reuses the native transport", async (t) => {
  saved.clear();
  sockets.length = 0;
  mockNativeSocket(t);
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(url, "http://100.64.0.2:4173/pair");
    return new Response(
      JSON.stringify({ token: "paired-token", environment_id: "paired-mac" }),
    );
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pairing = runtime.pairEnvironment(
    endpoint,
    "123456",
    "My Mac",
    "paired-mac",
  );
  const failed = assert.rejects(
    pairing,
    /Pairing was saved.*Settings → Machines/,
  );
  await new Promise(setImmediate);
  // The token is saved on its own, before any socket, and the record holds no credential.
  assert.equal(saved.get("kybern.ink.token.paired-mac"), "paired-token");
  const records = JSON.parse(saved.get("kybern.ink.machines")).records;
  assert.deepEqual(records.map((r) => [r.machineId, r.routes[0].url]), [["paired-mac", "http://100.64.0.2:4173"]]);
  assert.ok(!saved.get("kybern.ink.machines").includes("paired-token"));
  assert.equal(saved.get("kybern.ink.active"), "paired-mac");
  assert.equal(sockets[0].options.headers.origin, "tauri://localhost");
  t.mock.timers.tick(16001);
  await failed;
  runtime.connect("paired-mac");
  assert.equal(
    sockets.at(-1).options.headers.Authorization,
    "Bearer paired-token",
  );
  assert.equal(sockets.at(-1).options.headers.origin, "tauri://localhost");
  runtime.connect(null);
  runtime.resetMachineHub();
});

test("an invitation identity mismatch is rejected before saving credentials or opening a socket", async (t) => {
  saved.clear();
  sockets.length = 0;
  mockNativeSocket(t);
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        JSON.stringify({ token: "wrong-token", environment_id: "other-mac" }),
      ),
  );
  await assert.rejects(
    runtime.pairEnvironment(endpoint, "123456", "", "expected-mac"),
    /does not match/,
  );
  assert.equal(saved.size, 0);
  assert.equal(sockets.length, 0);
});

test("pairing a second computer adds a machine; the computer the phone is at stays where it is", async (t) => {
  saved.clear();
  sockets.length = 0;
  mockNativeSocket(t);
  t.after(() => { runtime.connect(null); runtime.resetMachineHub(); });
  // The phone is at the first computer, saved the way the app saves it.
  saved.set("kybern.ink.machines", JSON.stringify({ version: 1, records: [{ machineId: "first-mac", name: "First", routes: [{ kind: "direct_advertised", url: "http://100.64.0.2:4173" }], member: false }] }));
  saved.set("kybern.ink.token.first-mac", "first-token");
  saved.set("kybern.ink.active", "first-mac");
  await runtime.boot();
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ token: "second-token", environment_id: "second-mac" })));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const active = runtime.getState().activeId;
  assert.equal(active, "first-mac");
  const pairing = runtime.pairEnvironment("ws://100.64.0.3:4173/ws", "123456", "Second", "second-mac");
  const failed = assert.rejects(pairing, /Pairing was saved/);
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.equal(saved.get("kybern.ink.token.second-mac"), "second-token");
  assert.equal(saved.get("kybern.ink.active"), active ?? "first-mac", "the active computer did not change");
  assert.equal(runtime.getState().activeId, active);
  t.mock.timers.tick(16001);
  await failed;
  const dialled = sockets.filter((s) => s.url.includes("100.64.0.3"));
  assert.ok(dialled.some((s) => s.options.headers.Authorization === "Bearer second-token"), "the set connected the new machine with its token");
  assert.deepEqual(runtime.machineHub().connections().map((c) => c.record.machineId).sort(), ["first-mac", "second-mac"]);
});
