import test from "node:test";
import assert from "node:assert/strict";
import { createProjectCoordinatorStarter } from "../src/projectCoordinator.ts";
import { createComposerThreadReference, threadReferencePart } from "../src/threadReferences.ts";
import { buildStructuredTextParts, partToken, structuredSegments } from "../src/composerTokens.ts";

const firstThread = { id: "thread-one", project_id: "project-one", title: "Authentication decisions" };
const provider = {
  kind: "claude-code", available: true, instances: ["default", "team"],
  supported_permission_modes: ["supervised", "full-access"], models: [{ id: "model", efforts: ["medium"] }],
};
const input = { projectId: "project-one", provider, model: "model", effort: "medium" };

test("thread picker identity survives matching titles and a title refresh", () => {
  const first = createComposerThreadReference(firstThread, []);
  const second = createComposerThreadReference({ ...firstThread, id: "thread-two" }, [first], "Kybern");
  const third = createComposerThreadReference({ ...firstThread, id: "thread-three" }, [first, second], "Kybern");
  assert.equal(new Set([first.token, second.token, third.token]).size, 3);
  assert.equal(createComposerThreadReference({ ...firstThread, title: "Renamed" }, [first]), first);
  const text = `Compare ${first.token} with ${second.token} and ${third.token}.`;
  const parts = buildStructuredTextParts(text, new Set(), [], [first, second, third]);
  assert.deepEqual(parts.filter((part) => part.type === "thread_reference").map((part) => part.thread_id), ["thread-one", "thread-two", "thread-three"]);
  assert.equal(structuredSegments(text, new Set(), [], [first, second, third]).map((part) => part.text).join(""), text);
  assert.equal(text.includes(firstThread.id), false);
});

test("unselected or ambiguous thread text remains plain text", () => {
  const first = createComposerThreadReference(firstThread, []);
  assert.deepEqual(buildStructuredTextParts(first.token, new Set(), []), [{ type: "text", text: first.token }]);
  const conflicting = { token: first.token, part: { ...first.part, thread_id: "other" } };
  assert.deepEqual(buildStructuredTextParts(first.token, new Set(), [], [first, conflicting]), [{ type: "text", text: first.token }]);
  assert.deepEqual(buildStructuredTextParts(`${first.token}suffix`, new Set(), [], [first]), [{ type: "text", text: `${first.token}suffix` }]);
});

test("quoted titles keep surrounding instructions and other attachments intact", () => {
  const reference = createComposerThreadReference({ ...firstThread, title: 'Fix "UI" [draft]\nnotes' }, []);
  const text = `Read ${reference.token}, then inspect @README.md.`;
  const parts = buildStructuredTextParts(text, new Set(["README.md"]), [], [reference]);
  assert.deepEqual(parts.map((part) => part.type), ["text", "thread_reference", "text", "file_mention", "text"]);
  assert.equal(parts[1].title, 'Fix "UI" [draft] notes');
  assert.equal(partToken(threadReferencePart(firstThread)), '@"Authentication decisions"');
});

function coordinatorFixture() {
  let id = 0;
  const calls = [];
  const coordinators = new Map();
  const fail = { acknowledgement: false, sendAcknowledgement: false };
  const call = async (method, params) => {
    calls.push({ method, params: structuredClone(params) });
    if (method === "collaboration.coordinator.get") return coordinators.get(params.project_id) ?? null;
    if (method === "threads.send") {
      if (fail.sendAcknowledgement) { fail.sendAcknowledgement = false; throw new Error("Connection closed after first send"); }
      return { turn_id: "turn", message_id: params.message_id };
    }
    assert.equal(method, "collaboration.coordinator.get_or_create");
    let result = coordinators.get(params.project_id);
    if (!result) {
      result = { thread: { id: `coordinator-${params.project_id}`, project_id: params.project_id }, group: { id: "group", coordinator_mode: params.coordinator_mode, status: "active" }, created: true };
      coordinators.set(params.project_id, result);
    }
    if (fail.acknowledgement) { fail.acknowledgement = false; throw new Error("Connection closed after creation"); }
    return result;
  };
  return { calls, coordinators, fail, call, starter: createProjectCoordinatorStarter(call, () => `operation-${++id}`) };
}

test("project creation opens an idle dedicated chat with a supported permission default", async () => {
  const f = coordinatorFixture();
  await f.starter.start(input);
  assert.deepEqual(f.calls.map((call) => call.method), ["collaboration.coordinator.get", "collaboration.coordinator.get_or_create"]);
  const request = f.calls[1].params;
  assert.equal(request.coordinator_mode, "dedicated");
  assert.equal(request.permission_mode, "supervised");
  assert.equal(request.model, "model");
  assert.equal(request.effort, "medium");
});

test("Codex creates an ordinary advisory coordinator instead of being hidden", async () => {
  const f = coordinatorFixture();
  await f.starter.start({ ...input, provider: { ...provider, kind: "codex" } });
  assert.equal(f.calls[1].params.coordinator_mode, "ordinary");
});

test("custom models and the selected provider instance follow the normal composer", async () => {
  const f = coordinatorFixture();
  await f.starter.start({ ...input, model: "custom/model", effort: "high", instance: "team" });
  assert.equal(f.calls[1].params.model, "custom/model");
  assert.equal(f.calls[1].params.effort, "high");
  assert.equal(f.calls[1].params.provider.instance, "team");
});

test("opening a saved coordinator preserves its paused state and needs no available provider", async () => {
  const f = coordinatorFixture();
  const existing = { thread: { id: "saved" }, group: { status: "paused" }, created: false };
  f.coordinators.set(input.projectId, existing);
  assert.equal(await f.starter.start({ ...input, provider: { ...provider, available: false } }), existing);
  assert.deepEqual(f.calls.map((call) => call.method), ["collaboration.coordinator.get"]);
});

test("lost coordinator acknowledgement retries exact payload despite provider catalog reorder", async () => {
  const f = coordinatorFixture();
  f.fail.acknowledgement = true;
  await assert.rejects(f.starter.start(input), /Connection closed/);
  await f.starter.start({ ...input, provider: { ...provider, instances: ["team", "default"] } });
  const writes = f.calls.filter((call) => call.method.endsWith("get_or_create"));
  assert.deepEqual(writes[0].params, writes[1].params);
  assert.equal(f.coordinators.size, 1);
});

test("concurrent clicks coalesce and cannot switch projects while opening", async () => {
  const f = coordinatorFixture();
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const starter = createProjectCoordinatorStarter(async (method, params) => {
    await waiting;
    return f.call(method, params);
  }, () => "one-operation");
  const first = starter.start(input);
  const second = starter.start(input);
  await assert.rejects(starter.start({ ...input, projectId: "other" }), /Wait for/);
  release();
  const results = await Promise.all([first, second]);
  assert.equal(results[0], results[1]);
  assert.equal(f.calls.filter((call) => call.method.endsWith("get_or_create")).length, 1);
});

test("a subsequent open retrieves the existing chat without creating a turn or group", async () => {
  const f = coordinatorFixture();
  const first = await f.starter.start(input);
  const second = await f.starter.start(input);
  assert.equal(first.thread.id, second.thread.id);
  assert.deepEqual(f.calls.map((call) => call.method), ["collaboration.coordinator.get", "collaboration.coordinator.get_or_create", "collaboration.coordinator.get"]);
});

test("first send preserves the exact goal and retries one frozen client message", async () => {
  const f = coordinatorFixture();
  const message = { parts: [{ type: "text", text: "Ship the coordinator UX with native fixture proof." }] };
  f.fail.sendAcknowledgement = true;
  await assert.rejects(f.starter.send(input, message), /Connection closed/);
  await f.starter.send(input, message);
  const creates = f.calls.filter((call) => call.method === "collaboration.coordinator.get_or_create");
  const sends = f.calls.filter((call) => call.method === "threads.send");
  assert.equal(creates[0].params.initial_goal, "Ship the coordinator UX with native fixture proof.");
  assert.deepEqual(sends[0].params, sends[1].params);
  assert.equal(sends[0].params.message_id, "operation-1");
  assert.deepEqual(sends[0].params.message, message);
});

test("unavailable harness, known-model effort, and permission fail before creation", async () => {
  for (const change of [
    { provider: { ...provider, available: false } },
    { effort: "missing" },
    { permissionMode: "auto" },
  ]) {
    const f = coordinatorFixture();
    await assert.rejects(f.starter.start({ ...input, ...change }), /Choose/);
    assert.equal(f.calls.some((call) => call.method.endsWith("get_or_create")), false);
  }
});
