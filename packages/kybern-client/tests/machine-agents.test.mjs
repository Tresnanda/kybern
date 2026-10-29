import assert from "node:assert/strict";
import test from "node:test";
import { agentLine, defaultAgent, machineAgents, machineChoiceDetail, noAgentWarning, signedInOf, targetModel } from "../src/machineAgents.ts";

const account = (kind, status) => ({ provider: { kind, instance: "default" }, name: "default", status, is_default: true, projects: [], managed: false, can_sign_out: false });
const harness = (kind, available = true) => ({ kind, available });

test("only Claude, Codex and Cursor can be signed out", () => {
  assert.equal(signedInOf("claude-code", [account("claude-code", "signed_out")]), false);
  assert.equal(signedInOf("codex", [account("codex", "signed_in")]), true);
  assert.equal(signedInOf("omp", [account("omp", "signed_out")]), null);
  assert.equal(signedInOf("opencode", []), null);
  assert.equal(signedInOf("claude-code", undefined), null);
});

test("the default agent is the preferred one when it is signed in, else one that is", () => {
  const accounts = [account("claude-code", "signed_out"), account("codex", "signed_in")];
  const agents = machineAgents([harness("claude-code"), harness("codex"), harness("omp"), harness("pi", false)], accounts);
  assert.equal(defaultAgent(agents, "claude-code"), "codex");
  assert.equal(defaultAgent(agents, "omp"), "omp");
  assert.equal(defaultAgent(agents), "codex");
  assert.deepEqual(agents.map((agent) => agent.kind), ["claude-code", "codex", "omp", "pi"]);
  assert.equal(agentLine(agents[0], "instabox"), "Claude Code · signed out on instabox");
  assert.equal(agentLine(agents[3], "instabox"), "pi · not installed on instabox");
  assert.equal(noAgentWarning(agents, "instabox"), null);
});

test("a machine where nothing can run says so", () => {
  const agents = machineAgents([harness("claude-code"), harness("codex")], [account("claude-code", "signed_out"), account("codex", "needs_sign_in")]);
  assert.equal(defaultAgent(agents, "claude-code"), null);
  assert.match(noAgentWarning(agents, "VM") ?? "", /No agent is signed in on VM/);
  assert.match(noAgentWarning(machineAgents([harness("claude-code", false)], []), "VM") ?? "", /installed/);
});

test("a delegation to another machine parses before that machine acknowledged it, and names the machine", async () => {
  const { parseDelegateResult } = await import("../src/orchestrationTools.ts");
  const pending = parseDelegateResult({ task_id: "t1", thread_id: null, title: "Check", status: "running", machine: { id: "m1", name: "os-kdi" }, remote_state: "pending" });
  assert.deepEqual(pending?.machine, { id: "m1", name: "os-kdi" });
  assert.equal(pending?.threadId, "");
  assert.equal(parseDelegateResult({ task_id: "t1", thread_id: null, title: "Check" }), null);
  assert.equal(parseDelegateResult({ task_id: "t1", thread_id: "c1", title: "Check", status: "completed" })?.machine, null);
});

test("a machine choice names the agents installed there", () => {
  const agents = machineAgents([harness("claude-code"), harness("codex"), harness("pi", false)], [account("claude-code", "signed_out")]);
  assert.equal(machineChoiceDetail(true, agents), "Claude Code, Codex");
  assert.equal(machineChoiceDetail(false, agents), "Offline · waits until it’s back");
  assert.equal(machineChoiceDetail(true, undefined), "Online");
  assert.equal(machineChoiceDetail(true, machineAgents([harness("pi", false)], [])), "No agents installed");
});

const catalog = [
  { id: "opus", display_name: "Opus 5.5", efforts: ["low", "medium", "high"], default_effort: "medium" },
  { id: "sonnet", display_name: "Sonnet 5.5", efforts: ["low", "medium", "high"], default_effort: "high", is_default: true },
  { id: "haiku", display_name: "Haiku 5.5" },
];

test("a fork keeps the source thread's model and effort when the target has that model", () => {
  const source = { kind: "claude-code", model: "opus", effort: "low" };
  assert.deepEqual(targetModel(catalog, "claude-code", source), { model: "opus", effort: "low" });
  // An effort the model does not offer falls back to the model's default.
  assert.deepEqual(targetModel(catalog, "claude-code", { ...source, effort: "max" }), { model: "opus", effort: "medium" });
});

test("a fork falls back to the target's default model when the source's is missing or belongs to another agent", () => {
  assert.deepEqual(targetModel(catalog, "claude-code", { kind: "claude-code", model: "opus-4", effort: "low" }), { model: "sonnet", effort: "high" });
  assert.deepEqual(targetModel(catalog, "claude-code", { kind: "codex", model: "opus", effort: "low" }), { model: "sonnet", effort: "high" });
  assert.deepEqual(targetModel([catalog[2]], "claude-code", null), { model: "haiku", effort: null });
});

test("the user's pick wins while it is valid for the chosen agent and machine", () => {
  const source = { kind: "claude-code", model: "opus", effort: "low" };
  assert.deepEqual(targetModel(catalog, "claude-code", source, { kind: "claude-code", model: "haiku", effort: null }), { model: "haiku", effort: null });
  // A pick for another agent, or a model this machine lacks, is set aside.
  assert.deepEqual(targetModel(catalog, "claude-code", source, { kind: "codex", model: "gpt", effort: "high" }), { model: "opus", effort: "low" });
  assert.deepEqual(targetModel(catalog, "claude-code", source, { kind: "claude-code", model: "gone", effort: "high" }), { model: "opus", effort: "low" });
});

test("without a catalog the target machine chooses", () => {
  assert.deepEqual(targetModel([], "claude-code", { kind: "claude-code", model: "opus", effort: "low" }), { model: null, effort: null });
  assert.deepEqual(targetModel(catalog, null, null), { model: null, effort: null });
});
