import assert from "node:assert/strict";
import test from "node:test";
import { agentsCapsuleLabel, agentsModel, ago } from "../src/state/agents.ts";

const now = Date.parse("2026-10-24T10:00:00Z");
const base = {
  project_id: "p",
  provider: { kind: "claude-code", instance: "default" },
  permission_mode: "supervised",
  status: "idle",
  cwd: "/tmp",
  pinned: false,
  updated_at: "2026-10-24T09:58:00Z",
  last_seq: 1,
  parent_thread_id: "parent",
};
const delegated = (id, status, started) => ({
  ...base,
  id,
  title: id,
  created_at: started,
  delegation: {
    task_id: `t-${id}`,
    operation_id: `o-${id}`,
    parent_thread_id: "parent",
    depth: 1,
    role: "general",
    workspace: "shared",
    status,
    started_at: started,
    completed_at: status === "running" ? null : "2026-10-24T09:58:00Z",
  },
});
const task = (id, kind, status, title, extra = {}) => ({
  id,
  thread_id: "parent",
  origin_turn_id: "turn",
  started_seq: 1,
  updated_seq: 2,
  kind,
  status,
  title,
  backgrounded: false,
  stats: {},
  capabilities: {},
  started_at: "2026-10-24T09:59:00Z",
  updated_at: "2026-10-24T09:59:12Z",
  completed_at: status === "completed" ? "2026-10-24T09:59:12Z" : null,
  ...extra,
});

test("running agents first, oldest first; finished newest first", () => {
  const model = agentsModel(
    [
      delegated("old-done", "completed", "2026-10-24T08:00:00Z"),
      delegated("new-done", "completed", "2026-10-24T09:00:00Z"),
      delegated("late-run", "running", "2026-10-24T09:50:00Z"),
      delegated("early-run", "running", "2026-10-24T09:40:00Z"),
    ],
    [],
    now,
  );
  assert.deepEqual(model.agents.map((row) => row.title), ["early-run", "late-run", "new-done", "old-done"]);
  assert.equal(model.runningAgents, 2);
  assert.equal(model.agents[0].subtitle, "Working · 20m 00s");
  assert.equal(model.agents[2].subtitle, "Done · 58m 00s · 2 min ago");
});

test("processes show the cleaned command and settle with duration and age", () => {
  const model = agentsModel(
    [],
    [
      task("a", "shell", "completed", "cd /repo && rtk cargo test -p kybern 2>&1 | tail -n 40"),
      task("b", "shell", "running", "pnpm dev"),
    ],
    now,
  );
  assert.deepEqual(model.processes.map((row) => row.title), ["pnpm dev", "cargo test -p kybern"]);
  assert.equal(model.processes[0].mono, true);
  assert.equal(model.processes[0].subtitle, "Running · 1m 00s");
  assert.equal(model.processes[1].subtitle, "Completed · 12s · now");
  assert.equal(agentsCapsuleLabel(model), "1 process running");
});

test("a subagent thread stands for its own agent task; nested tasks stay on their parent", () => {
  const child = { ...base, id: "sub", title: "Explore", created_at: "2026-10-24T09:59:00Z", subagent: { root_thread_id: "parent", task_id: "agent-1", status: "completed", started_at: "2026-10-24T09:59:00Z", completed_at: "2026-10-24T09:59:30Z" } };
  const model = agentsModel(
    [child],
    [task("agent-1", "agent", "completed", "Explore"), task("tool", "shell", "completed", "ls", { parent_id: "agent-1" }), task("agent-2", "agent", "running", "Review")],
    now,
  );
  assert.deepEqual(model.agents.map((row) => row.key), ["task:agent-2", "thread:sub"]);
  assert.equal(model.processes.length, 0);
  assert.equal(agentsCapsuleLabel(model), "2 agents · 1 running");
});

test("relative ages", () => {
  assert.equal(ago(now - 20_000, now), "now");
  assert.equal(ago(now - 5 * 60_000, now), "5 min ago");
  assert.equal(ago(now - 3 * 3600_000, now), "3 h ago");
});
