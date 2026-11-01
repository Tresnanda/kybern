import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
registerHooks({ resolve(specifier, context, next) {
  const url = specifier.startsWith(".") && context.parentURL ? new URL(specifier, context.parentURL) : null;
  if (url?.protocol === "file:" && !/\.[a-z]+$/i.test(url.pathname) && existsSync(fileURLToPath(url) + ".ts")) return { shortCircuit: true, url: url.href + ".ts" };
  return next(specifier, context);
} });
const { createMachineClient } = await import("../src/machines/hub.ts");

const record = { machineId: "b", name: "satyamas", routes: [], member: false };
const relay = { kind: "relay", url: "https://m.example/relay/b", via: "m" };
const direct = { kind: "direct_advertised", url: "https://b.example" };

test("a relay route sends the relay member's header on the socket and on requests", () => {
  const sockets = [];
  const socket = (url, token, headers) => { sockets.push({ url, token, headers }); throw new Error("stop"); };
  const client = createMachineClient({ record, route: relay, token: "b-token", relayToken: "m-token" }, { socket });
  assert.deepEqual(client.request("/assets/a1"), {
    url: "https://m.example/relay/b/http/assets/a1",
    headers: { "X-Kybern-Relay-Auth": "Bearer m-token", authorization: "Bearer b-token" },
  });
  try { client.connect(); } catch { /* the stand-in socket refuses on purpose */ }
  assert.equal(sockets[0]?.url, "wss://m.example/relay/b/ws");
  assert.equal(sockets[0].token, "b-token");
  assert.deepEqual(sockets[0].headers, { "X-Kybern-Relay-Auth": "Bearer m-token" });
  client.close();
});

test("a relay route without the member's token or a native socket is refused", () => {
  assert.throws(() => createMachineClient({ record, route: relay, token: "t" }, { socket: () => {} }), /relay member's token/);
  assert.throws(() => createMachineClient({ record, route: relay, token: "t", relayToken: "m" }), /native socket/);
});

test("a direct route needs no headers and opens its own pages", async () => {
  const client = createMachineClient({ record, route: direct, token: "b-token" }, { socket: () => {} });
  assert.deepEqual(client.request("/assets/a1"), { url: "https://b.example/assets/a1", headers: { authorization: "Bearer b-token" } });
  const page = await client.openPage("/preview-proxy/t1/");
  assert.equal(page.url, "https://b.example/preview-proxy/t1/");
  assert.equal(page.scope, undefined);
});

function relayed(host) {
  return createMachineClient({ record, route: relay, token: "b-token", relayToken: "m-token" }, { socket: () => {}, relayPages: (id) => (id === "m" ? host : undefined) });
}

test("a relayed page is a ticket on the relay member, closed with the page", async () => {
  const calls = [];
  const host = {
    name: "Studio", hasRelayPages: true,
    client: () => ({ call: async (method, params) => {
      calls.push([method, params]);
      return method === "network.relay_page.open"
        ? { ticket: "rt1", path: `/relay/b/page/rt1${params.path}`, scope: "/relay/b/page/rt1/" }
        : {};
    } }),
  };
  const page = await relayed(host).openPage("/preview-proxy/t1/");
  assert.deepEqual(calls[0], ["network.relay_page.open", { machine_id: "b", path: "/preview-proxy/t1/" }]);
  assert.equal(page.url, "https://m.example/relay/b/page/rt1/preview-proxy/t1/");
  assert.equal(page.scope, "https://m.example/relay/b/page/rt1/");
  page.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls[1], ["network.relay_page.close", { ticket: "rt1" }]);
});

test("a relay member without relay pages says what to update; a missing member says to reconnect", async () => {
  const old = { name: "Studio", hasRelayPages: false, client: () => assert.fail("not asked") };
  await assert.rejects(relayed(old).openPage("/visual-frame/v1"), /Update Kybern on Studio to open pages from satyamas through it\./);
  await assert.rejects(relayed(undefined).openPage("/visual-frame/v1"), /Reconnect satyamas/);
});
