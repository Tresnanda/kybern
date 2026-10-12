import test from "node:test";
import assert from "node:assert/strict";
import { coordinatorEditsEnforced, createCoordinatorStarter, isCoordinatorThread } from "../src/coordinator.ts";

const provider = {
  kind: "claude-code", available: true, instances: ["default", "team"],
  supported_permission_modes: ["supervised", "full-access"], models: [{ id: "model", efforts: ["medium"] }],
};
const input = { projectId: "project-one", provider, model: "model", effort: "medium" };

function fixture() {
  let id = 0;
  const calls = [];
  const coordinators = new Map();
  const fail = { sendAcknowledgement: false };
  const call = async (method, params) => {
    calls.push({ method, params: structuredClone(params) });
    if (method === "coordinator.get") return coordinators.get(params.project_id) ?? null;
    if (method === "threads.send") {
      if (fail.sendAcknowledgement) { fail.sendAcknowledgement = false; throw new Error("Connection closed after first send"); }
      return { turn_id: "turn", message_id: params.message_id };
    }
    assert.equal(method, "coordinator.open");
    let thread = coordinators.get(params.project_id);
    const created = !thread;
    if (!thread) {
      thread = { id: `coordinator-${params.project_id}`, project_id: params.project_id, coordinator_project_id: params.project_id };
      coordinators.set(params.project_id, thread);
    }
    return { thread, created };
  };
  return { calls, coordinators, fail, call, starter: createCoordinatorStarter(call, () => `message-${++id}`) };
}

test("the lead marker is the coordinator project id", () => {
  assert.equal(isCoordinatorThread({ coordinator_project_id: "p" }), true);
  assert.equal(isCoordinatorThread({ coordinator_project_id: null }), false);
  assert.equal(isCoordinatorThread({}), false);
  assert.equal(isCoordinatorThread(undefined), false);
});

test("only harnesses that select tools can block Coordinator edits", () => {
  for (const kind of ["claude-code", "opencode", "pi", "omp"]) assert.equal(coordinatorEditsEnforced(kind), true, kind);
  for (const kind of ["codex", "cursor"]) assert.equal(coordinatorEditsEnforced(kind), false, kind);
});

test("opening creates an idle Coordinator with a supported permission default", async () => {
  const f = fixture();
  const result = await f.starter.start(input);
  assert.equal(result.created, true);
  assert.deepEqual(f.calls.map((call) => call.method), ["coordinator.get", "coordinator.open"]);
  const request = f.calls[1].params;
  assert.equal(request.permission_mode, "supervised");
  assert.equal(request.model, "model");
  assert.equal(request.effort, "medium");
  assert.equal(request.provider.instance, "default");
  assert.equal("operation_id" in request, false);
});

test("custom models and the selected provider instance follow the normal composer", async () => {
  const f = fixture();
  await f.starter.start({ ...input, model: "custom/model", effort: "high", instance: "team" });
  assert.equal(f.calls[1].params.model, "custom/model");
  assert.equal(f.calls[1].params.effort, "high");
  assert.equal(f.calls[1].params.provider.instance, "team");
});

test("opening a saved Coordinator needs no available provider", async () => {
  const f = fixture();
  const saved = { id: "saved", coordinator_project_id: input.projectId };
  f.coordinators.set(input.projectId, saved);
  const result = await f.starter.start({ ...input, provider: { ...provider, available: false } });
  assert.deepEqual(result, { thread: saved, created: false });
  assert.deepEqual(f.calls.map((call) => call.method), ["coordinator.get"]);
});

test("concurrent clicks coalesce and cannot switch projects while opening", async () => {
  const f = fixture();
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const starter = createCoordinatorStarter(async (method, params) => {
    await waiting;
    return f.call(method, params);
  }, () => "message");
  const first = starter.start(input);
  const second = starter.start(input);
  await assert.rejects(starter.start({ ...input, projectId: "other" }), /Wait for/);
  release();
  const results = await Promise.all([first, second]);
  assert.equal(results[0], results[1]);
  assert.equal(f.calls.filter((call) => call.method === "coordinator.open").length, 1);
});

test("the first message opens a new Coordinator with it and sends nothing else", async () => {
  const f = fixture();
  const message = { parts: [{ type: "text", text: "We're building Kybern. " }, { type: "skill", name: "review", path: "/skills/review" }, { type: "text", text: " small PRs please" }] };
  const result = await f.starter.send(input, message);
  assert.equal(result.created, true);
  const opens = f.calls.filter((call) => call.method === "coordinator.open");
  assert.equal(opens.length, 1);
  assert.equal(opens[0].params.opening_message, "We're building Kybern. $review small PRs please");
  assert.equal("initial_brief" in opens[0].params, false, "the opening message is never sent as the brief");
  assert.equal(f.calls.some((call) => call.method === "threads.send"), false, "the daemon starts the first turn with it");
});

test("a lost acknowledgement after creating does not send the message twice", async () => {
  const f = fixture();
  let lose = true;
  const starter = createCoordinatorStarter(async (method, params) => {
    const answer = await f.call(method, params);
    if (method === "coordinator.open" && lose) { lose = false; throw new Error("Connection closed"); }
    return answer;
  }, () => "message");
  const message = { parts: [{ type: "text", text: "Set yourself up." }] };
  await assert.rejects(starter.send(input, message), /Connection closed/);
  const result = await starter.send(input, message);
  assert.equal(result.created, false);
  assert.equal(f.calls.filter((call) => call.method === "coordinator.open").length, 1);
  assert.equal(f.calls.some((call) => call.method === "threads.send"), false);
});

test("an existing Coordinator gets the first message as one frozen send", async () => {
  const f = fixture();
  f.coordinators.set(input.projectId, { id: "saved", coordinator_project_id: input.projectId });
  const message = { parts: [{ type: "text", text: "Ship the Coordinator with native fixture proof." }] };
  f.fail.sendAcknowledgement = true;
  await assert.rejects(f.starter.send(input, message), /Connection closed/);
  await f.starter.send(input, message);
  const sends = f.calls.filter((call) => call.method === "threads.send");
  assert.equal(f.calls.filter((call) => call.method === "coordinator.open").length, 0);
  assert.deepEqual(sends[0].params, sends[1].params);
  assert.equal(sends[0].params.message_id, "message-1");
  assert.deepEqual(sends[0].params.message, message);
});

test("an empty first message is refused before anything is opened", async () => {
  const f = fixture();
  await assert.rejects(f.starter.send(input, { parts: [{ type: "text", text: "  " }] }), /Tell the Coordinator/);
  assert.equal(f.calls.length, 0);
});

test("unavailable harness, known-model effort, and permission fail before creation", async () => {
  for (const change of [
    { provider: { ...provider, available: false } },
    { effort: "missing" },
    { permissionMode: "auto" },
  ]) {
    const f = fixture();
    await assert.rejects(f.starter.start({ ...input, ...change }), /Choose/);
    assert.equal(f.calls.some((call) => call.method === "coordinator.open"), false);
  }
});
