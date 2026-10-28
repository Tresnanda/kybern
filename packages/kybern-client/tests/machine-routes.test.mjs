import test from "node:test";
import assert from "node:assert/strict";
import {
  checkWellKnown,
  classifyHost,
  orderRoutes,
  probeTimeoutMs,
  relayRoute,
  routeId,
  routeRefusal,
  wellKnownProofMessage,
  wellKnownUrl,
} from "../src/machineRoutes.ts";
import { fakeWorld, manualClock, verifyProof } from "./machine-fakes.mjs";

test("routes are ordered tailnet, advertised, ssh, relay, and keep the given order within a kind", () => {
  const routes = orderRoutes(
    [
      { kind: "relay", url: "http://m:4173/relay/b", via: "m" },
      { kind: "ssh", url: "http://127.0.0.1:5000" },
      { kind: "direct_advertised", url: "https://b.example.com" },
      { kind: "direct_tailnet", url: "http://100.64.0.2:4173" },
    ],
    [
      { kind: "direct_tailnet", url: "http://100.64.0.3:4173" },
      // A repeat of one already listed, spelled differently, is dropped.
      { kind: "direct_tailnet", url: "ws://100.64.0.2:4173/ws" },
    ],
  );
  assert.deepEqual(routes.map((r) => r.url), [
    "http://100.64.0.2:4173",
    "http://100.64.0.3:4173",
    "https://b.example.com",
    "http://127.0.0.1:5000",
    "http://m:4173/relay/b",
  ]);
});

test("a route has a stable id however its address is spelled", () => {
  assert.equal(
    routeId({ kind: "direct_tailnet", url: "http://100.64.0.2:4173" }),
    routeId({ kind: "direct_tailnet", url: "ws://100.64.0.2:4173/ws" }),
  );
  assert.notEqual(
    routeId({ kind: "direct_tailnet", url: "http://100.64.0.2:4173" }),
    routeId({ kind: "relay", url: "http://100.64.0.2:4173", via: "m" }),
  );
});

test("hosts are classified as loopback, tailnet, private or public", () => {
  const cases = {
    "127.0.0.1": "loopback",
    localhost: "loopback",
    "[::1]": "loopback",
    "100.64.0.1": "tailnet",
    "100.127.255.254": "tailnet",
    "100.128.0.1": "public",
    "satyamas.tail-abc.ts.net": "tailnet",
    "fd7a:115c:a1e0::1": "tailnet",
    "10.0.0.5": "private",
    "172.16.0.1": "private",
    "172.32.0.1": "public",
    "192.168.1.10": "private",
    satyamas: "private",
    "box.local": "private",
    "example.com": "public",
    "8.8.8.8": "public",
  };
  for (const [host, expected] of Object.entries(cases)) assert.equal(classifyHost(host), expected, host);
});

test("plain HTTP is for loopback, tailnet and private addresses; public addresses need HTTPS", () => {
  const refused = (url, kind = "direct_advertised") => routeRefusal({ kind, url });
  assert.equal(refused("http://100.64.0.2:4173", "direct_tailnet"), undefined);
  assert.equal(refused("ws://192.168.1.4:4173"), undefined);
  assert.equal(refused("http://localhost:4173"), undefined);
  assert.equal(refused("https://example.com"), undefined);
  assert.match(refused("http://example.com"), /HTTPS/);
  assert.match(refused("ws://203.0.113.9:4173"), /HTTPS/);
  assert.ok(refused("ftp://100.64.0.2"));
  assert.ok(refused("http://user:pw@100.64.0.2:4173"));
  assert.match(refused("http://100.64.0.2:4173", "ssh"), /local end/);
  assert.equal(refused("http://127.0.0.1:5000", "ssh"), undefined);
  assert.equal(refused("http://100.64.0.1:4173/relay/b", "relay"), undefined);
});

test("probes wait 3 seconds on this computer and 10 elsewhere", () => {
  assert.equal(probeTimeoutMs({ kind: "ssh", url: "http://127.0.0.1:5000" }), 3000);
  assert.equal(probeTimeoutMs({ kind: "direct_tailnet", url: "http://100.64.0.2:4173" }), 10000);
});

test("a relay route and the identity document it serves", () => {
  const relay = relayRoute("ws://100.64.0.1:4173/ws", "member", "target");
  assert.deepEqual(relay, { kind: "relay", url: "http://100.64.0.1:4173/relay/target", via: "member" });
  assert.equal(wellKnownUrl(relay, "n1"), "http://100.64.0.1:4173/relay/target/http/.well-known/kybern/machine?nonce=n1");
  assert.equal(
    wellKnownUrl({ kind: "direct_tailnet", url: "http://100.64.0.2:4173" }, "n1"),
    "http://100.64.0.2:4173/.well-known/kybern/machine?nonce=n1",
  );
});

function signedAnswer(clock, overrides = {}, nonce = "n1", host = "100.64.0.2:4173") {
  const answer = {
    machine_id: "b",
    name: "b",
    os: "linux",
    signing_key: "key-b",
    at: new Date(clock.now()).toISOString(),
    ...overrides,
  };
  const message = new TextDecoder().decode(wellKnownProofMessage({ nonce, machineId: answer.machine_id, at: answer.at, host }));
  answer.proof = overrides.proof ?? `sig|${answer.signing_key}|${message}`;
  return answer;
}

const context = (clock, expected = { machineId: "b", signingKey: "key-b" }) => ({
  nonce: "n1",
  host: "100.64.0.2:4173",
  now: clock.now(),
  expected,
  verifyProof,
});

test("the well-known check passes only for the expected machine, key, time and proof", async () => {
  const clock = manualClock();
  const ok = await checkWellKnown(signedAnswer(clock), context(clock));
  assert.equal(ok.ok, true);
  assert.equal(ok.signingKey, "key-b");

  // Another machine answers at this address.
  const other = await checkWellKnown(signedAnswer(clock, { machine_id: "c" }), context(clock));
  assert.deepEqual([other.ok, other.reason, other.fatal], [false, "different_machine", true]);

  // The right machine id with another key.
  const swapped = await checkWellKnown(signedAnswer(clock, { signing_key: "key-evil" }), context(clock));
  assert.deepEqual([swapped.ok, swapped.reason, swapped.fatal], [false, "different_machine", true]);

  // The right key, but a proof made for another nonce (a replay).
  const replay = await checkWellKnown(signedAnswer(clock, {}, "old-nonce"), context(clock));
  assert.deepEqual([replay.ok, replay.reason, replay.fatal], [false, "bad_proof", true]);

  // A proof made for another host.
  const elsewhere = await checkWellKnown(signedAnswer(clock, {}, "n1", "other:1"), context(clock));
  assert.equal(elsewhere.reason, "bad_proof");

  // An old answer is not an identity failure.
  const stale = await checkWellKnown(signedAnswer(clock, { at: new Date(clock.now() - 61_000).toISOString() }), context(clock));
  assert.deepEqual([stale.ok, stale.reason, stale.fatal], [false, "stale", false]);
  const fresh = await checkWellKnown(signedAnswer(clock, { at: new Date(clock.now() - 59_000).toISOString() }), context(clock));
  assert.equal(fresh.ok, true);

  for (const junk of [null, {}, "x", { machine_id: "b" }]) {
    const result = await checkWellKnown(junk, context(clock));
    assert.equal(result.ok, false);
    assert.equal(result.fatal, true);
  }
});

test("with no pinned key the machine's own key is accepted and handed back to pin", async () => {
  const clock = manualClock();
  const result = await checkWellKnown(signedAnswer(clock), context(clock, { machineId: "b" }));
  assert.equal(result.ok, true);
  assert.equal(result.signingKey, "key-b");
  // Still the wrong machine without a pinned key.
  const wrong = await checkWellKnown(signedAnswer(clock, { machine_id: "c" }), context(clock, { machineId: "b" }));
  assert.equal(wrong.ok, false);
});

test("a throwing verifier is a failed proof, not a crash", async () => {
  const clock = manualClock();
  const result = await checkWellKnown(signedAnswer(clock), { ...context(clock), verifyProof: () => { throw new Error("boom"); } });
  assert.deepEqual([result.ok, result.reason], [false, "bad_proof"]);
});

test("the fake world signs what the check expects", async () => {
  // Guards the fakes the machine set tests rely on.
  const clock = manualClock();
  const world = fakeWorld(clock);
  world.host("http://100.64.0.2:4173", "b");
  const answer = await world.transport.probe(wellKnownUrl({ kind: "direct_tailnet", url: "http://100.64.0.2:4173" }, "nn"));
  const result = await checkWellKnown(answer, { nonce: "nn", host: "100.64.0.2:4173", now: clock.now(), expected: { machineId: "b" }, verifyProof });
  assert.equal(result.ok, true);
});
