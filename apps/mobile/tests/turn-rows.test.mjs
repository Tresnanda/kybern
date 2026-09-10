import assert from "node:assert/strict";
import test from "node:test";
import { createTurnRows, workDuration } from "../src/state/turnRows.ts";

const base = {
  turnId: "turn-1",
  at: "2026-09-09T00:00:00Z",
  origin: { kind: "root" },
};
const user = {
  ...base,
  kind: "user",
  id: "user",
  seq: 1,
  message: { parts: [{ type: "text", text: "Make the change" }] },
};
const narration = {
  ...base,
  kind: "assistant",
  id: "narration",
  messageId: "narration",
  segment: 0,
  seq: 2,
  text: "Checking the implementation.",
  thinking: "",
  complete: true,
};
const tool = {
  ...base,
  kind: "tool",
  id: "tool",
  seq: 3,
  call: { id: "tool", name: "read_file", input: {} },
  stream: "",
  output: "All source",
  complete: true,
  isError: false,
};
const answer = {
  ...base,
  kind: "assistant",
  id: "answer",
  messageId: "final",
  segment: 0,
  seq: 4,
  text: "## Done\n\n```ts\nconst result = 42;\n```",
  thinking: "Check the result carefully.",
  complete: true,
};
const end = {
  ...base,
  kind: "turn_end",
  id: "end",
  seq: 5,
  terminalMessageId: "final",
  stopReason: "completed",
  durationMs: 83000,
  error: null,
  costUsd: null,
  usage: {},
};
const blocks = [user, narration, tool, answer, end];
const content = (rows) =>
  rows.filter((row) => row.kind === "block").map((row) => row.block);

test("a completed turn shows its final formatted answer and discloses preceding work", () => {
  const project = createTurnRows();
  const rows = project(blocks, new Set());
  const rendered = content(rows);
  assert.deepEqual(
    rendered.map((block) => block.kind),
    ["user", "assistant", "turn_end"],
  );
  assert.equal(rendered[1].text, answer.text);
  assert.equal(rendered[1].thinking, "");
  assert.equal(rows.find((row) => row.kind === "work").durationMs, 83000);
  const expanded = project(blocks, new Set(["turn-1"]));
  assert(content(expanded).some((block) => block === narration));
  assert(content(expanded).some((block) => block === tool));
  assert(
    content(expanded).some(
      (block) =>
        block.kind === "assistant" && block.thinking === answer.thinking,
    ),
  );
  assert.equal(
    content(expanded).filter(
      (block) => block.kind === "assistant" && block.text === answer.text,
    ).length,
    1,
  );
});

test("live and partially loaded turns remain chronological until their completion arrives", () => {
  const project = createTurnRows();
  assert.deepEqual(
    content(project(blocks.slice(0, -1), new Set())),
    blocks.slice(0, -1),
  );
  assert.deepEqual(content(project([narration, tool], new Set())), [
    narration,
    tool,
  ]);
  // A history page can include a summary whose final message is on an older page.
  assert.doesNotThrow(() => project([tool, end], new Set()));
});

test("approvals, errors and continuing background work remain reachable when collapsed", () => {
  const pending = {
    ...base,
    kind: "approval",
    id: "approval",
    seq: 3,
    approval: { id: "approval" },
    decision: null,
  };
  const activeTool = { ...tool, complete: false };
  const task = {
    ...base,
    kind: "runtime_task",
    id: "task",
    seq: 3,
    task: { id: "task", status: "running" },
  };
  const error = {
    ...base,
    kind: "notice",
    id: "notice",
    seq: 3,
    level: "error",
    text: "Connection lost",
  };
  const rendered = content(
    createTurnRows()(
      [user, pending, activeTool, task, error, answer, end],
      new Set(),
    ),
  );
  for (const block of [pending, activeTool, task, error])
    assert(rendered.includes(block));
});

test("finished background processes fold with work while delegated agents stay visible", () => {
  const process = {
    ...base,
    kind: "runtime_task",
    id: "process",
    seq: 3,
    task: { id: "process", kind: "process", status: "completed" },
  };
  const agent = {
    ...process,
    id: "agent",
    task: { id: "agent", kind: "agent", status: "completed" },
  };
  const project = createTurnRows();
  const history = [user, process, agent, answer, end];
  const collapsed = content(project(history, new Set()));
  assert(!collapsed.includes(process));
  assert(collapsed.includes(agent));
  assert(content(project(history, new Set(["turn-1"]))).includes(process));
  const image = {
    ...base,
    kind: "image",
    id: "image",
    seq: 3,
    source: "example.png",
  };
  assert.deepEqual(content(project([narration, image], new Set())), [
    narration,
    image,
  ]);
});

test("settled row identities and expanded work survive updates in another turn", () => {
  const project = createTurnRows();
  const open = new Set(["turn-1"]);
  const before = project(blocks, open);
  const live = {
    ...narration,
    turnId: "turn-2",
    id: "live",
    messageId: "live",
    seq: 6,
    complete: false,
  };
  const after = project([...blocks, live], open);
  for (let i = 0; i < before.length; i++) assert.equal(after[i], before[i]);
  const updated = project([...blocks, { ...live, text: "New output" }], open);
  for (let i = 0; i < before.length; i++) assert.equal(updated[i], before[i]);
});

test("large expanded work stays as individual virtual rows and folding omits its content", () => {
  const tools = Array.from({ length: 1000 }, (_, i) => ({
    ...tool,
    id: `tool-${i}`,
    seq: i + 3,
  }));
  const project = createTurnRows();
  const history = [user, ...tools, answer, end];
  assert.equal(project(history, new Set()).length, 4);
  const expanded = project(history, new Set(["turn-1"]));
  assert.equal(
    content(expanded).filter((block) => block.kind === "tool").length,
    1000,
  );
  assert.equal(new Set(expanded.map((row) => row.key)).size, expanded.length);
  assert.equal(workDuration(83000), "1m 23s");
  assert.equal(workDuration(0), "1s");
});


test("live completed steps fold between narration without hiding failures or approvals", () => {
  const project = createTurnRows();
  const tools = Array.from({ length: 1000 }, (_, i) => ({ ...tool, id: `step-${i}`, seq: i + 3 }));
  const failed = { ...tool, id: "failed", seq: 1004, isError: true };
  const active = { ...tool, id: "active", seq: 1005, complete: false };
  const history = [user, narration, ...tools, failed, active];
  const rows = project(history, new Set());
  const disclosure = rows.find((row) => row.kind === "work");
  assert.equal(disclosure.label, "1000 completed steps");
  assert.deepEqual(content(rows), [user, narration, failed, active]);
  const opened = project(history, new Set([disclosure.turnId]));
  assert.equal(content(opened).length, history.length);
  assert.equal(new Set(opened.map((row) => row.key)).size, opened.length);
  assert.equal(project(history, new Set()).length, rows.length);
});


test("live agent launches and task-linked tools stay outside automatic groups", () => {
  const launch = { ...tool, id: "launch", call: { ...tool.call, name: "collaboration.spawn_agent" } };
  const linked = { ...tool, id: "linked", call: { ...tool.call, id: "linked" } };
  const task = { ...base, kind: "runtime_task", id: "task", seq: 5,
    task: { id: "task", kind: "agent", status: "running", tool_call_id: "linked" } };
  const history = [user, tool, launch, linked, task];
  assert.deepEqual(content(createTurnRows()(history, new Set())), history);
});
