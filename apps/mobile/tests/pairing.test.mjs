import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createNativeSocket } from "../src/state/nativeSocket.ts";

const saved = new Map();
globalThis.__pairingTestStore = saved;
registerHooks({
  resolve(specifier, context, next) {
    const source =
      specifier === "react-native"
        ? 'export const Platform = { OS: "android" }; export const AppState = { addEventListener() {} };'
        : specifier === "expo-secure-store"
          ? 'export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = "device-only"; export async function setItemAsync(key, value) { globalThis.__pairingTestStore.set(key, value); } export async function getItemAsync(key) { return globalThis.__pairingTestStore.get(key); }'
          : null;
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
    /Pairing was saved.*Settings → Computers/,
  );
  await new Promise(setImmediate);
  const stored = JSON.parse([...saved.values()][0]);
  assert.equal(stored.environments[0].token, "paired-token");
  assert.equal(stored.environments[0].environmentId, "paired-mac");
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
