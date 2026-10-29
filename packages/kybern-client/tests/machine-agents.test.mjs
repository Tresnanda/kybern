import assert from "node:assert/strict";
import test from "node:test";
import { agentLine, defaultAgent, machineAgents, machineChoiceDetail, noAgentWarning, signedInOf } from "../src/machineAgents.ts";

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
