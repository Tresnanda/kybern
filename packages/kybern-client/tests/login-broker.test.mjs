import assert from "node:assert/strict";
import test from "node:test";
import { brokerBlocker, brokerLine, driveLogin, lendableLabel, planSignInAll, runSignInAll, signInAllSummary, throughBroker } from "../src/loginBroker.ts";

const status = (state, extra = {}) => ({ provider: "claude-code", state, lendable: [], sessions: 0, ...extra });

test("each state of a harness reads as a sentence with at most one action", () => {
  assert.deepEqual(brokerLine(status("borrowing"), "VPS", "Claude Code"), { text: "Signs in through VPS", tone: "ok" });
  const offline = brokerLine(status("broker_offline"), "VPS", "Claude Code");
  assert.equal(offline.text, "VPS is offline · Sign in here instead");
  assert.equal(offline.action, "sign_in_here");
  const daemonWords = brokerLine(status("broker_offline", { message: "Claude Code signs in through vps, which is offline · Sign in here instead" }), "VPS", "Claude Code");
  assert.equal(daemonWords.text, "Claude Code signs in through vps, which is offline · Sign in here instead", "the daemon's own sentence wins");
  const empty = brokerLine(status("broker_not_signed_in"), "VPS", "Claude Code");
  assert.equal(empty.action, "sign_in_on_broker");
  assert.match(empty.actionLabel, /Sign in on VPS/);
  const offered = brokerLine(status("not_used", { lendable: [{ provider: "claude-code", account: "a", name: "Shared" }] }), "VPS", "Claude Code");
  assert.equal(offered.action, "use_broker");
  assert.equal(brokerLine(status("not_used"), undefined, "Claude Code").action, undefined);
  assert.equal(brokerLine(status("lending"), "Mac", "Claude Code").tone, "ok");
});

test("lendable accounts and the states that mean a broker sign-in", () => {
  assert.equal(lendableLabel({ provider: "claude-code", account: "a", name: "Shared", email: "me@example.com", plan: "Max" }), "Shared · Max · me@example.com");
  assert.equal(lendableLabel({ provider: "codex", account: "default", name: "CLI account" }), "CLI account");
  assert.equal(throughBroker("borrowing"), true);
  assert.equal(throughBroker("not_used"), false);
  assert.equal(throughBroker(undefined), false);
});

test("a broker candidate must be online and know the feature", () => {
  assert.equal(brokerBlocker({ machineId: "a", name: "VPS", online: true, features: ["login.broker.v1"] }), null);
  assert.equal(brokerBlocker({ machineId: "a", name: "VPS", online: false, features: [] }), "VPS is offline");
  assert.equal(brokerBlocker({ machineId: "a", name: "VPS", online: true, features: ["network.v1"] }), "VPS needs a newer Kybern");
  assert.equal(brokerBlocker({ machineId: "a", name: "VPS", online: true, features: [] }), null, "a machine that listed no features yet is not blocked");
});

test("the plan settles signed-in and offline machines before anything runs", () => {
  const rows = planSignInAll([
    { machineId: "m1", name: "Mac", online: true, signedIn: true },
    { machineId: "m2", name: "pc", online: true, signedIn: false },
    { machineId: "m3", name: "vps", online: false, signedIn: undefined },
    { machineId: "m4", name: "cachy", online: true, signedIn: undefined },
  ]);
  assert.deepEqual(rows.map((row) => row.state), ["already", "waiting", "skipped", "waiting"]);
  assert.match(rows[2].detail, /offline/);
});

test("sign in on all machines runs one machine at a time and a failure does not stop the rest", async () => {
  const order = [];
  let running = 0;
  let overlap = false;
  const changes = [];
  const rows = await runSignInAll(
    planSignInAll([
      { machineId: "m1", name: "Mac", online: true, signedIn: false },
      { machineId: "m2", name: "pc", online: true, signedIn: false },
      { machineId: "m3", name: "cachy", online: true, signedIn: false },
    ]),
    async (row, update) => {
      running += 1;
      overlap ||= running > 1;
      order.push(row.name);
      update({ id: `login-${row.machineId}`, kind: "claude-code", mode: "paste", phase: "waiting", url: "https://example.test/auth", expires_at: "2026-10-29T00:00:00Z" });
      await new Promise((resolve) => setTimeout(resolve, 2));
      running -= 1;
      if (row.name === "pc") throw new Error("The paste code was refused");
      return { ok: true };
    },
    { onChange: (snapshot) => changes.push(snapshot.map((row) => row.state).join(",")) },
  );
  assert.deepEqual(order, ["Mac", "pc", "cachy"]);
  assert.equal(overlap, false, "one machine at a time");
  assert.deepEqual(rows.map((row) => row.state), ["signed_in", "failed", "signed_in"]);
  assert.equal(rows[1].detail, "The paste code was refused");
  assert.equal(rows[0].login, undefined, "the link is dropped when the machine is done");
  assert.ok(changes.some((line) => line.startsWith("signing_in,waiting")), "progress is reported per machine");
  assert.equal(signInAllSummary(rows), "Signed in on 2 of 3 machines · pc needs another try");
});

test("cancelling marks the rest canceled and keeps what finished", async () => {
  const controller = new AbortController();
  const rows = await runSignInAll(
    planSignInAll([
      { machineId: "m1", name: "Mac", online: true, signedIn: false },
      { machineId: "m2", name: "pc", online: true, signedIn: false },
    ]),
    async () => {
      controller.abort();
      return { ok: true };
    },
    { signal: controller.signal },
  );
  assert.deepEqual(rows.map((row) => row.state), ["signed_in", "canceled"]);
});

test("the summary names offline machines", () => {
  const rows = planSignInAll([
    { machineId: "m1", name: "Mac", online: true, signedIn: true },
    { machineId: "m2", name: "vps", online: false, signedIn: undefined },
    { machineId: "m3", name: "pc", online: false, signedIn: undefined },
  ]);
  assert.equal(signInAllSummary(rows), "Signed in on 1 of 3 machines · vps and pc were offline");
});

const login = (phase, extra = {}) => ({ id: "l1", kind: "claude-code", mode: "paste", phase, expires_at: "2026-10-29T00:00:00Z", ...extra });

function fakeClient(phases) {
  const calls = [];
  let read = 0;
  return {
    calls,
    async call(method, params) {
      calls.push([method, params]);
      if (method === "providers.accounts.login.start") return phases[0];
      if (method === "providers.accounts.login.get") return phases[Math.min(++read, phases.length - 1)];
      if (method === "providers.accounts.login.finish") return { kind: "claude-code", instance: "new" };
      return phases[phases.length - 1];
    },
  };
}

test("driving a machine's sign-in reports its link, waits, and finishes the account", async () => {
  const client = fakeClient([login("waiting", { url: "https://example.test/a" }), login("verifying"), login("signed_in")]);
  const seen = [];
  const outcome = await driveLogin(client, { kind: "claude-code", mode: "paste", accountName: "Claude (cachy)", sleep: async () => {} }, (l) => seen.push(l.phase));
  assert.deepEqual(outcome, { ok: true });
  assert.deepEqual(seen, ["waiting", "verifying", "signed_in"]);
  const finish = client.calls.find(([method]) => method === "providers.accounts.login.finish");
  assert.deepEqual(finish[1], { id: "l1", name: "Claude (cachy)", make_default: true });
});

test("a failed or canceled sign-in is reported with the daemon's words and is not finished", async () => {
  const client = fakeClient([login("waiting"), login("failed", { error: "The code was wrong." })]);
  const outcome = await driveLogin(client, { kind: "claude-code", mode: "paste", accountName: "x", sleep: async () => {} }, () => {});
  assert.deepEqual(outcome, { ok: false, detail: "The code was wrong." });
  assert.equal(client.calls.some(([method]) => method === "providers.accounts.login.finish"), false);
});

test("aborting cancels the sign-in on the machine", async () => {
  const controller = new AbortController();
  const client = fakeClient([login("waiting")]);
  const outcome = await driveLogin(client, { kind: "claude-code", mode: "paste", accountName: "x", signal: controller.signal, sleep: async () => controller.abort() }, () => {});
  assert.deepEqual(outcome, { ok: false, detail: "Canceled" });
  assert.ok(client.calls.some(([method]) => method === "providers.accounts.login.cancel"));
});
