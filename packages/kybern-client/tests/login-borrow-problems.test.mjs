import assert from "node:assert/strict";
import test from "node:test";
import { RpcCallError } from "../src/client.ts";
import { describeProblem, describeTurnFailure, LOGIN_BORROW_SUBJECT, SIGN_IN_HERE_ACTION } from "../src/problems.ts";

const rpc = (code, message, data) => new RpcCallError({ code, message, ...(data ? { data } : {}) });

// What a 0.27.2 daemon sends when kdi-vps has Logins off and MacBook tries to borrow its Claude sign-in.
const refusedSentence =
  "kdi-vps doesn't let other machines use its sign-ins. Choose Share this machine’s sign-ins for kdi-vps in Settings → Accounts, or sign in on MacBook instead.";
const refused = rpc(-32002, refusedSentence, {
  problem: {
    kind: "permission",
    subject: "login_borrow",
    title: "Couldn't use kdi-vps's sign-in",
    hint: refusedSentence,
    action: { id: "sign_in_here", label: "Sign in on MacBook instead", params: { machine_id: "m-mac", provider: "claude-code", instance: "a1" } },
    detail: refusedSentence,
    retryable: true,
  },
});

test("a refused borrow shows the daemon's sentence and offers signing in on the machine instead", () => {
  assert.equal(LOGIN_BORROW_SUBJECT, "login_borrow");
  assert.equal(SIGN_IN_HERE_ACTION, "sign_in_here");
  const view = describeProblem(refused, { action: "use kdi-vps's sign-in" });
  assert.equal(view.title, "Couldn't use kdi-vps's sign-in");
  assert.equal(view.body, refusedSentence);
  assert.deepEqual(view.action, { id: "sign_in_here", label: "Sign in on MacBook instead", params: { machine_id: "m-mac", provider: "claude-code", instance: "a1" } });
  assert.equal(view.secondary?.id, "copy_detail");
  assert.doesNotMatch(`${view.title} ${view.body}`, /broker|refused access|Check the permissions/i);
});

test("a legacy lender's reason reads as it is, and an offline lender offers a retry", () => {
  const reason = "MacBook shared its sign-ins before Kybern 0.27.2, and it isn't always on, so new machines sign in themselves. Choose a machine that stays on to share sign-ins.";
  const legacy = rpc(-32002, reason, {
    problem: { kind: "permission", subject: "login_borrow", hint: reason, action: { id: "sign_in_here", label: "Sign in on fedora instead", params: { machine_id: "m-fedora" } }, retryable: true },
  });
  const view = describeProblem(legacy, { action: "use MacBook's sign-in" });
  assert.equal(view.title, "Couldn't use MacBook's sign-in");
  assert.equal(view.body, reason);
  assert.equal(view.action?.params?.machine_id, "m-fedora");
  const offline = rpc(-32013, "Claude Code signs in through kdi-vps, which is offline · Sign in here instead", {
    problem: { kind: "offline", subject: "login_borrow", title: "Couldn't use kdi-vps's sign-in", hint: "Claude Code signs in through kdi-vps, which is offline · Sign in here instead", action: { id: "sign_in_here", label: "Sign in on MacBook instead", params: { machine_id: "m-mac" } }, secondary: { id: "retry", label: "Try again" }, retryable: true },
  });
  const off = describeProblem(offline, { action: "use kdi-vps's sign-in" });
  assert.equal(off.action?.id, "sign_in_here");
  assert.equal(off.secondary?.id, "retry");
});

test("an older daemon's bare refusal becomes a sentence naming both machines when the call was a borrow", () => {
  const borrow = { machineId: "m-new", machine: "fedora", lender: "Treshnandas-Macbook.local", provider: "claude-code" };
  // The 0.27.1 failure: login.broker.bind needed access:write, which a device grant to another machine never carries.
  const scope = describeProblem(rpc(-32002, "missing scope: access:write", { problem: { kind: "permission", detail: "missing scope: access:write", retryable: true } }), {
    action: "use Treshnandas-Macbook.local's sign-in",
    borrow,
  });
  assert.equal(scope.title, "Couldn't use Treshnandas-Macbook.local's sign-in");
  assert.match(scope.body, /^fedora needs a newer Kybern to use another machine's sign-ins\. Update Kybern on fedora/);
  assert.deepEqual(scope.action, { id: "sign_in_here", label: "Sign in on fedora instead", params: { machine_id: "m-new", provider: "claude-code" } });
  assert.doesNotMatch(scope.body, /refused access|Check the permissions/);
  const logins = describeProblem(rpc(-32002, "missing scope: machine:logins"), { action: "use Treshnandas-Macbook.local's sign-in", borrow });
  assert.match(logins.body, /^Treshnandas-Macbook\.local doesn't let other machines use its sign-ins\. Choose Share this machine’s sign-ins for Treshnandas-Macbook\.local in Settings → Accounts, or sign in on fedora instead\.$/);
  // Settings → Machines has no Logins control: the fix is on the Accounts page.
  assert.doesNotMatch(logins.body, /Turn on Logins|Settings → Machines/);
  assert.equal(logins.action?.id, "sign_in_here");
  // Without the borrow context nothing changes.
  const plain = describeProblem(rpc(-32002, "missing scope: access:write"), { action: "rename the thread" });
  assert.notEqual(plain.action?.id, "sign_in_here");
});

test("a turn that couldn't borrow carries the same fix", () => {
  const view = describeTurnFailure(
    { error: refusedSentence, problem: refused.data?.problem ?? { kind: "permission", subject: "login_borrow", hint: refusedSentence, action: { id: "sign_in_here", label: "Sign in on MacBook instead", params: { machine_id: "m-mac" } } } },
    { provider: "claude-code", instance: "a1" },
  );
  assert.equal(view?.body, refusedSentence);
  assert.equal(view?.action?.id, "sign_in_here");
  const phone = describeTurnFailure({ error: refusedSentence, problem: { kind: "permission", subject: "login_borrow", hint: refusedSentence } }, { provider: "claude-code", phone: true });
  assert.equal(phone?.action, undefined);
});
