import assert from "node:assert/strict";
import test from "node:test";
import { applyEvent, emptyThreadState, seedFromGet } from "../src/transcript.ts";
import { describeTurnFailure, providerTool } from "../src/problems.ts";

const T = "turn-1";
const AT = "2026-11-06T10:00:00Z";
const fold = (payload) => applyEvent(emptyThreadState(), { seq: 1, turn_id: T, at: AT, ...payload });
const seeded = (...transcript) => seedFromGet({ transcript, thread: { id: "t" }, last_seq: 1 }).blocks;
const endOf = (state) => state.blocks.find((block) => block.kind === "turn_end");

const KINDS = ["tool_missing", "signed_out", "permission", "offline", "conflict", "invalid_input", "not_found", "update_needed", "internal"];

test("a failed turn carries its problem into the turn end for every kind", () => {
  for (const kind of KINDS) {
    const problem = { kind, subject: "claude", detail: `${kind} detail`, retryable: true };
    const end = endOf(fold({ kind: "turn_failed", error: `${kind} detail`, problem }));
    assert.equal(end.error, `${kind} detail`);
    assert.deepEqual(end.problem, problem, kind);
  }
});

test("a failure from before problems existed projects without one", () => {
  const end = endOf(fold({ kind: "turn_failed", error: "Provider disconnected" }));
  assert.equal(end.error, "Provider disconnected");
  assert.equal("problem" in end, false);
  assert.equal(describeTurnFailure({ error: "Provider disconnected" }, { provider: "claude-code" }), null);
});

test("an error notice carries its problem, and the stored transcript rows do too", () => {
  const problem = { kind: "permission", subject: "rate_limit", detail: "429", retryable: true };
  const state = fold({ kind: "provider_notice", level: "error", text: "429", data: null, problem });
  assert.deepEqual(state.blocks.find((block) => block.kind === "notice").problem, problem);
  const [summary, noticeRow, plain] = seeded(
    { role: "turn_summary", turn_id: T, seq: 2, stop_reason: "error", usage: {}, duration_ms: 0, at: AT, error: "x", problem },
    { role: "notice", turn_id: T, seq: 3, level: "error", text: "x", at: AT, problem },
    { role: "notice", turn_id: T, seq: 4, level: "info", text: "x", at: AT },
  );
  assert.deepEqual(summary.problem, problem);
  assert.deepEqual(noticeRow.problem, problem);
  assert.equal("problem" in plain, false);
});

const failure = (problem) => ({ error: "raw text", problem: { detail: "raw text", retryable: true, ...problem } });

test("a signed-out agent says so and offers Sign in and another account without promising a resend", () => {
  const view = describeTurnFailure(failure({ kind: "signed_out", subject: "claude" }), { provider: "claude-code", instance: "work" });
  assert.equal(view.title, "Claude Code is signed out");
  assert.equal(view.body, "Sign in, then send your message again.");
  assert.deepEqual(view.action, { id: "sign_in", label: "Sign in", params: { provider: "claude", instance: "work" } });
  assert.deepEqual(view.secondary, { id: "use_another_account", label: "Use another account", params: { provider: "claude" } });
  assert.equal(view.detail, "raw text");
  assert.equal(describeTurnFailure(failure({ kind: "signed_out", subject: "codex" }), { provider: "codex", machine: "SatyaMas" }).title, "Codex is signed out on SatyaMas");
});

test("rate limits, a lost connection and an old agent name the agent and what to do", () => {
  const limit = describeTurnFailure(failure({ kind: "permission", subject: "rate_limit" }), { provider: "codex" });
  assert.equal(limit.title, "Codex reached its usage limit");
  assert.equal(limit.action.id, "use_another_account");
  const network = describeTurnFailure(failure({ kind: "offline", subject: "network" }), { provider: "cursor" });
  assert.equal(network.title, "Couldn't reach Cursor");
  assert.equal(network.action.id, "retry");
  const old = describeTurnFailure(failure({ kind: "update_needed", subject: "claude" }), { provider: "claude-code" });
  assert.equal(old.title, "Update Claude Code");
  assert.deepEqual(old.action, { id: "update_agent", label: "Update Claude Code", params: { provider: "claude" } });
});

test("a missing agent offers the installer and an unnamed failure still reads as words", () => {
  const missing = describeTurnFailure(failure({ kind: "tool_missing", subject: "codex" }), { provider: "codex" });
  assert.equal(missing.title, "Install Codex to send your message");
  assert.deepEqual(missing.action, { id: "install_tool", label: "Install Codex", params: { tool: "codex" } });
  const unnamed = describeTurnFailure(failure({ kind: "internal" }), { provider: "grok-build" });
  assert.equal(unnamed.title, "Grok Build stopped before it could answer");
  assert.equal(unnamed.detail, "raw text");
  for (const view of [missing, unnamed]) assert.doesNotMatch(`${view.title} ${view.body}`, /Error|RPC|invalid params|not found:/);
});

test("every harness has a tool name the daemon's subjects use", () => {
  assert.deepEqual(
    ["claude-code", "codex", "opencode", "pi", "omp", "cursor", "antigravity", "grok-build"].map(providerTool),
    ["claude", "codex", "opencode", "pi", "omp", "cursor", "antigravity", "grok"],
  );
});

test("a phone is told what to do on the computer and gets no buttons", () => {
  const view = describeTurnFailure(failure({ kind: "signed_out", subject: "claude" }), { provider: "claude-code", machine: "SatyaMas", phone: true });
  assert.equal(view.title, "Claude Code is signed out on SatyaMas");
  assert.equal(view.body, "Sign in on SatyaMas, then send your message again.");
  assert.equal(view.action, undefined);
  assert.equal(view.secondary, undefined);
  assert.equal(describeTurnFailure(failure({ kind: "permission", subject: "rate_limit" }), { provider: "codex", phone: true }).body, "Wait for the limit to reset, or switch accounts on your computer, then send your message again.");
  assert.equal(describeTurnFailure({ error: "x" }, { provider: "codex", phone: true }), null);
});
