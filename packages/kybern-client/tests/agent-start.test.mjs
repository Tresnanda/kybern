import test from "node:test";
import assert from "node:assert/strict";
import { agentBaseRevision, createAgentStarter } from "../src/agentStart.ts";

const thread = { id: "main", project_id: "project", title: "Improve search", status: "idle", permission_mode: "accept-edits", provider: { kind: "claude-code", instance: "default" } };
const provider = { kind: "codex", available: true, instances: ["default"], models: [{ id: "sol", display_name: "Sol" }] };
const input = { thread, provider, task: "Review search ranking\nReport the largest relevance issues.", model: "sol" };
const status = { is_git: true, branch: "worktrees/search", dirty_files: 3 };

function fixture() {
  let id = 0;
  const calls = [];
  const groups = new Map();
  const assignments = new Map();
  const fail = { assignment: false, groupResponse: false, assignmentResponse: false };
  const currentStatus = { ...status };
  const call = async (method, params) => {
    calls.push({ method, params: structuredClone(params) });
    if (method === "git.status") return { ...currentStatus };
    if (method === "collaboration.groups.create") {
      const group = groups.get(params.operation_id) || { ...params, id: params.operation_id, status: "active", revision: 1 };
      groups.set(group.id, group);
      if (fail.groupResponse) { fail.groupResponse = false; throw new Error("Connection closed after group creation"); }
      return group;
    }
    if (method === "collaboration.assignments.create") {
      if (fail.assignment) { fail.assignment = false; throw new Error("Provider temporarily unavailable"); }
      const assignment = assignments.get(params.operation_id) || { ...params, id: params.operation_id, status: "pending" };
      assignments.set(assignment.id, assignment);
      if (fail.assignmentResponse) { fail.assignmentResponse = false; throw new Error("Connection closed after assignment creation"); }
      return assignment;
    }
    throw new Error(`Unexpected RPC ${method}`);
  };
  return { starter: createAgentStarter(call, () => `operation-${++id}`), calls, groups, assignments, fail, currentStatus, call };
}

test("first helper creates ordinary linkage and an isolated cross-provider task using the source branch", async () => {
  const f = fixture();
  const { group, assignment } = await f.starter.start(input);
  assert.deepEqual(f.calls.map((call) => call.method), ["git.status", "collaboration.groups.create", "collaboration.assignments.create"]);
  assert.equal(group.coordinator_mode, "ordinary");
  assert.equal(group.objective, thread.title);
  assert.equal(assignment.title, "Review search ranking");
  assert.equal(assignment.instructions, input.task);
  assert.equal(assignment.kind, "edit");
  assert.equal(assignment.child.base_revision, "refs/heads/worktrees/search");
  assert.equal(assignment.child.provider.kind, "codex");
  assert.equal(assignment.child.permission_mode, "supervised");
  assert.equal(assignment.child.model, "sol");
});

test("failed assignment keeps its created group and retries the exact request", async () => {
  const f = fixture(); f.fail.assignment = true;
  await assert.rejects(f.starter.start(input), /temporarily unavailable/);
  assert.equal(f.starter.group.id, "operation-1");
  f.currentStatus.branch = "changed-after-attempt";
  await f.starter.start(input);
  const attempts = f.calls.filter((call) => call.method === "collaboration.assignments.create");
  assert.deepEqual(attempts[0].params, attempts[1].params);
  assert.equal(f.calls.filter((call) => call.method === "git.status").length, 1);
  assert.equal(f.groups.size, 1);
  assert.equal(f.assignments.size, 1);
});

test("lost group acknowledgement retries the frozen operation even if the thread title changes", async () => {
  const f = fixture(); f.fail.groupResponse = true;
  await assert.rejects(f.starter.start(input), /group creation/);
  await f.starter.start({ ...input, thread: { ...thread, title: "Updated by a background event" } });
  const requests = f.calls.filter((call) => call.method === "collaboration.groups.create");
  assert.deepEqual(requests[0].params, requests[1].params);
  assert.equal(f.groups.size, 1);
});

test("lost assignment acknowledgement cannot start duplicate helpers on retry", async () => {
  const f = fixture(); f.fail.assignmentResponse = true;
  await assert.rejects(f.starter.start(input), /assignment creation/);
  const result = await f.starter.start(input);
  assert.equal(result.assignment.id, "operation-2");
  assert.equal(f.assignments.size, 1);
});

test("overlapping identical submissions share one start; different tasks cannot replace it", async () => {
  const f = fixture();
  let unblock;
  const blocked = new Promise((resolve) => { unblock = resolve; });
  const starter = createAgentStarter(async (method, params) => {
    if (method === "git.status") await blocked;
    return f.call(method, params);
  }, (() => { let i = 0; return () => `concurrent-${++i}`; })());
  const first = starter.start(input);
  const second = starter.start(input);
  await assert.rejects(starter.start({ ...input, task: "A different task" }), /Wait for/);
  unblock();
  const results = await Promise.all([first, second]);
  assert.equal(results[0].assignment.id, results[1].assignment.id);
  assert.equal(f.assignments.size, 1);
});

test("existing groups are reused and a second deliberate start after success is new work", async () => {
  const f = fixture();
  const group = { id: "existing", project_id: "project", status: "active" };
  const first = await f.starter.start({ ...input, group });
  const second = await f.starter.start({ ...input, group });
  assert.notEqual(first.assignment.id, second.assignment.id);
  assert.equal(f.groups.size, 0);
  assert.equal(f.assignments.size, 2);
});

test("editing needs Git isolation while research and review can start without it", async () => {
  const f = fixture(); f.currentStatus.is_git = false;
  await assert.rejects(f.starter.start(input), /Git project/);
  assert.equal(f.groups.size, 0);
  const { assignment: research } = await f.starter.start({ ...input, kind: "research" });
  assert.equal(research.child.base_revision, undefined);
  assert.equal(research.kind, "research");

  const detached = fixture(); detached.currentStatus.branch = null;
  await assert.rejects(detached.starter.start(input), /detached commit/);
  assert.equal(detached.groups.size, 0);
  const { assignment: review } = await detached.starter.start({ ...input, kind: "review" });
  assert.equal(review.child.base_revision, undefined);
  const { assignment } = await detached.starter.start({ ...input, baseRevision: "a1b2c3" });
  assert.equal(assignment.child.base_revision, "a1b2c3");
  assert.equal(agentBaseRevision(status), "refs/heads/worktrees/search");
});

test("paused/stopped work must resume explicitly; completed work can start a fresh group", async () => {
  for (const state of ["paused", "stopped"]) {
    const f = fixture();
    await assert.rejects(f.starter.start({ ...input, group: { id: "old", project_id: "project", status: state } }), /Resume agents/);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  const result = await f.starter.start({ ...input, group: { id: "finished", project_id: "project", status: "completed" } });
  assert.notEqual(result.group.id, "finished");
  assert.equal(f.calls.some((call) => /delete|control/.test(call.method)), false);
});

test("enabling chat-driven delegation requires no worker, base, or dedicated-session release", async () => {
  const f = fixture();
  const first = await f.starter.enable(thread);
  const second = await f.starter.enable(thread);
  assert.equal(first.id, second.id);
  assert.deepEqual(f.calls.map((call) => call.method), ["collaboration.groups.create"]);
  assert.equal(f.assignments.size, 0);
});


test("provider catalog refresh cannot duplicate an accepted task whose acknowledgement was lost", async () => {
  const f = fixture(); f.fail.assignmentResponse = true;
  await assert.rejects(f.starter.start({ ...input, provider: { ...provider, instances: ["default", "team"] } }), /assignment creation/);
  await f.starter.start({ ...input, provider: { ...provider, instances: ["team", "default"] } });
  const attempts = f.calls.filter((call) => call.method === "collaboration.assignments.create");
  assert.deepEqual(attempts[0].params, attempts[1].params);
  assert.equal(f.assignments.size, 1);
});

test("choosing completed history clears a different cached group but preserves the new attempt on retry", async () => {
  const f = fixture();
  await f.starter.start({ ...input, group: { id: "cached", project_id: "project", status: "active" } });
  const historicInput = { ...input, group: { id: "finished", project_id: "project", status: "completed" } };
  f.fail.assignmentResponse = true;
  await assert.rejects(f.starter.start(historicInput), /assignment creation/);
  const result = await f.starter.start(historicInput);
  assert.notEqual(result.group.id, "cached");
  assert.notEqual(result.group.id, "finished");
  assert.equal(f.groups.size, 1);
  assert.equal(f.assignments.size, 2);
});
