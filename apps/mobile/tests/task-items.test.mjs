import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "react")
      return {
        shortCircuit: true,
        url: `data:text/javascript,${encodeURIComponent("export const useSyncExternalStore = () => undefined; export const useCallback = (fn) => fn;")}`,
      };
    const url = specifier.startsWith(".") && context.parentURL ? new URL(specifier, context.parentURL) : null;
    if (url?.protocol === "file:" && !/\.[a-z]+$/i.test(url.pathname) && existsSync(fileURLToPath(url) + ".ts"))
      return { shortCircuit: true, url: url.href + ".ts" };
    return next(specifier, context);
  },
});
const model = await import("../src/state/tasksModel.ts");
const store = await import("../src/state/tasks.ts");

const task = (id, patch = {}) => ({
  id,
  key: `ADE-${id}`,
  scope: "project",
  project_id: "p1",
  title: `Task ${id}`,
  body: "",
  status: "todo",
  priority: 0,
  rank: 0,
  note_ids: [],
  runs: [],
  revision: 1,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
  status_changed_at: "2026-10-01T00:00:00Z",
  ...patch,
});
const run = (patch = {}) => ({
  thread_id: "t1",
  number: 1,
  provider: { kind: "claude-code", instance: "default" },
  started_at: "2026-10-05T10:00:00Z",
  state: "running",
  ...patch,
});
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("groups follow the list order, hide empty groups and sort by rank then key", () => {
  const groups = model.groupTasks([
    task("9", { status: "inbox", rank: 0 }),
    task("10", { status: "todo", rank: 5 }),
    task("2", { status: "todo", rank: 5 }),
    task("3", { status: "running" }),
    task("4", { status: "done", status_changed_at: "2026-10-02T00:00:00Z" }),
    task("5", { status: "done", status_changed_at: "2026-10-03T00:00:00Z" }),
  ]);
  assert.deepEqual(groups.map((g) => g.status), ["running", "todo", "inbox", "done"]);
  assert.deepEqual(groups[1].tasks.map((t) => t.key), ["ADE-2", "ADE-10"], "ADE-2 before ADE-10");
  assert.deepEqual(groups[3].tasks.map((t) => t.id), ["5", "4"], "finished work is newest first");
  assert.equal(model.startsCollapsed("done"), true);
  assert.equal(model.startsCollapsed("todo"), false);
});

test("scoping keeps a project's tasks or the Global ones", () => {
  const list = [task("1"), task("2", { scope: "global", project_id: null }), task("3", { project_id: "p2" })];
  assert.deepEqual(model.scopeTasks(list, "p1").map((t) => t.id), ["1"]);
  assert.deepEqual(model.scopeTasks(list, "global").map((t) => t.id), ["2"]);
  assert.equal(model.scopeTasks(list, undefined).length, 3);
  assert.equal(
    model.activitySummary([task("a", { status: "running" }), task("b", { status: "running" }), task("c", { status: "needs_review" })]),
    "2 running · 1 to review",
  );
  assert.equal(model.activitySummary([task("a")]), "");
});

test("change folding adds, replaces, deletes and ignores late notifications", () => {
  let list = [task("1", { updated_at: "2026-10-05T10:00:00Z" })];
  list = model.applyTaskChange(list, { task: task("2") });
  assert.deepEqual(list.map((t) => t.id), ["1", "2"]);
  const stale = model.applyTaskChange(list, { task: task("1", { title: "old", updated_at: "2026-10-05T09:00:00Z" }) });
  assert.equal(stale, list, "an older row never replaces a newer one");
  list = model.applyTaskChange(list, { task: task("1", { status: "done", updated_at: "2026-10-05T11:00:00Z" }) });
  assert.equal(list[0].status, "done");
  list = model.applyTaskChange(list, { deleted_id: "2" });
  assert.deepEqual(list.map((t) => t.id), ["1"]);
});

test("runs describe themselves: latest run, outcome, activity and diff", () => {
  const now = Date.parse("2026-10-05T10:12:30Z");
  const t = task("1", { runs: [run({ number: 1, state: "interrupted", ended_at: "2026-10-05T10:02:00Z" }), run({ number: 2, thread_id: "t2" })] });
  assert.equal(model.latestRun(t).number, 2);
  assert.equal(model.isLiveRun(model.latestRun(t)), true);
  assert.equal(model.runOutcome(t.runs[0], now), "Canceled after 2m");
  assert.equal(model.runOutcome(t.runs[1], now), "Running for 12m");
  assert.equal(model.shortDuration(64 * 60_000), "1h 4m");
  assert.equal(model.shortActivity("Editing crates/kybern-drivers/src/cursor.rs"), "Editing cursor.rs");
  assert.equal(model.diffLabel({ added: 48, removed: 12, files: 3 }), "+48 −12 in 3 files");
  assert.equal(model.diffLabel({ added: 1, removed: 0, files: 1 }), "+1 −0 in 1 file");
  assert.equal(model.ageLabel("2026-10-05T07:12:30Z", now), "3h");
  assert.equal(model.ageLabel("2026-10-05T10:12:10Z", now), "now");
});

test("the body splits into a description and acceptance criteria", () => {
  const body = "Start new sessions on the SDK.\n\nAcceptance criteria:\n- [x] New threads use the SDK\n- [ ] Old sessions keep the bridge\n  (until they end)\n\n```\n- [ ] not a criterion\n```\n";
  const parts = model.splitTaskBody(body);
  assert.deepEqual(parts.criteria, [
    { checked: true, text: "New threads use the SDK" },
    { checked: false, text: "Old sessions keep the bridge" },
  ]);
  assert.equal(parts.description, "Start new sessions on the SDK.\n\n```\n- [ ] not a criterion\n```");
});

test("toggling a criterion changes only that checkbox", () => {
  const body = "Intro\n- [ ] one\n```\n- [ ] fenced\n```\n* [X] two [ADE-3](kybern://task/abc)\n";
  assert.equal(model.toggleCriterion(body, 0), "Intro\n- [x] one\n```\n- [ ] fenced\n```\n* [X] two [ADE-3](kybern://task/abc)\n");
  assert.equal(model.toggleCriterion(body, 1), "Intro\n- [ ] one\n```\n- [ ] fenced\n```\n* [ ] two [ADE-3](kybern://task/abc)\n");
  assert.equal(model.toggleCriterion(body, 5), body, "a missing index leaves the body alone");
});

test("the prompt reads as title, description, Done when and the saved follow-up", () => {
  const prompt = model.buildTaskPrompt({
    title: "Show a conflict banner",
    body: "Keep the unsaved text.\n\n- [ ] The banner appears **fast**\n- [ ] Linked to [ADE-2](kybern://task/x)\n",
    pending_followup: "Also check iPad.",
  });
  assert.equal(
    prompt,
    "Show a conflict banner.\n\nKeep the unsaved text.\n\nDone when:\n– The banner appears fast\n– Linked to ADE-2\n\nAlso check iPad.",
  );
  assert.equal(model.buildTaskPrompt({ title: "Ship it?", body: "" }), "Ship it?");
  assert.equal(model.formatTokens(model.approxTokens(7200)), "1.8k");
  assert.equal(model.formatTokens(0), "0k");
});

test("task links are recognized and keys sort naturally", () => {
  assert.equal(model.taskLinkId("kybern://task/0f6b-11"), "0f6b-11");
  assert.equal(model.taskLinkId("<kybern://task/abc>"), "abc");
  assert.equal(model.taskLinkId("kybern://note/abc"), null);
  assert.equal(model.taskLinkId("https://example.com"), null);
  assert.ok(model.compareTaskKeys("ADE-9", "ADE-10") < 0);
  assert.ok(model.compareTaskKeys("ADE-9", "MOB-1") < 0);
});

test("send defaults use the project's last agent, else the computer's default", () => {
  const providers = [
    { kind: "claude-code", available: true, instances: ["default"], supported_permission_modes: ["supervised", "auto"] },
    { kind: "codex", available: true, instances: ["default"], supported_permission_modes: ["supervised"] },
    { kind: "cursor", available: false, instances: ["default"], supported_permission_modes: [] },
  ];
  const fallback = { provider: "claude-code", instance: "default", model: "", effort: "", permission: "auto", worktree: false };
  const thread = (patch) => ({
    project_id: "p1",
    provider: { kind: "codex", instance: "default" },
    model: "gpt-6",
    effort: "high",
    permission_mode: "supervised",
    worktree: { path: "/w", branch: "b" },
    created_at: "2026-10-04T00:00:00Z",
    ...patch,
  });
  const last = model.sendDefaults({
    projectId: "p1",
    isGit: true,
    threads: [thread({}), thread({ created_at: "2026-10-01T00:00:00Z", provider: { kind: "claude-code", instance: "default" } }), thread({ project_id: "p2", created_at: "2026-10-05T00:00:00Z" })],
    providers,
    fallback,
  });
  assert.deepEqual(last, { provider: "codex", instance: "default", model: "gpt-6", effort: "high", permission: "supervised", worktree: true });
  const fresh = model.sendDefaults({ projectId: "p3", isGit: true, threads: [], providers, fallback });
  assert.equal(fresh.provider, "claude-code");
  assert.equal(fresh.worktree, true, "git projects default to a new worktree");
  const plain = model.sendDefaults({ projectId: "p3", isGit: false, threads: [], providers, fallback });
  assert.equal(plain.worktree, false);
  const unavailable = model.sendDefaults({ projectId: null, isGit: false, threads: [], providers, fallback: { ...fallback, provider: "cursor" } });
  assert.equal(unavailable.provider, "claude-code", "an unavailable default falls back to an available agent");
  assert.equal(model.modelLabel("claude-code", "Claude Opus 5.5"), "Opus 5.5");
  assert.equal(model.modelLabel("codex", "Claude-like"), "Claude-like");
});

test("project colors are stable hex values in both themes", () => {
  assert.equal(model.oklchHex(0.72, 0.13, 255), "#6aa7f4");
  assert.match(model.projectColor("p1", true), /^#[0-9a-f]{6}$/);
  assert.equal(model.projectColor("p1", true), model.projectColor("p1", true));
  assert.notEqual(model.projectColor("p1", true), model.projectColor("p1", false));
});

test("project hues follow the order projects were added, like the desktop", () => {
  const projects = [
    { id: "b", created_at: "2026-01-02T00:00:00Z" },
    { id: "a", created_at: "2026-01-01T00:00:00Z" },
    { id: "00000000-0000-0000-0000-000000000001", created_at: "2025-01-01T00:00:00Z" },
  ];
  assert.equal(model.projectHue("a", projects), 295);
  assert.equal(model.projectHue("b", projects), 185);
  assert.equal(model.projectColor("a", true, projects), model.oklchHex(0.74, 0.1, 295));
});

function fakeClient() {
  const handlers = new Map();
  const calls = [];
  const client = {
    handlers,
    calls,
    respond: {},
    onNotification(name, fn) {
      handlers.set(name, fn);
    },
    async call(method, params) {
      calls.push([method, params]);
      const answer = client.respond[method];
      if (answer instanceof Error) throw answer;
      return typeof answer === "function" ? answer(params) : answer;
    },
  };
  return client;
}

test("the store loads, follows notifications and resets per computer", async () => {
  const client = fakeClient();
  client.respond["tasks.items.list"] = { tasks: [task("1")] };
  store.attachTasks(client, () => true);
  await store.loadTasks();
  assert.equal(store.getTasks().loaded, true);
  client.handlers.get("tasks.items.changed")({ task: task("2", { status: "running" }) });
  assert.deepEqual(store.getTasks().tasks.map((t) => t.id), ["1", "2"]);
  client.handlers.get("tasks.items.changed")({ deleted_id: "1" });
  assert.deepEqual(store.getTasks().tasks.map((t) => t.id), ["2"]);
  store.resetTasks();
  assert.equal(store.getTasks().tasks.length, 0, "switching computers clears tasks");
  store.attachTasks(client, () => true);
  client.respond["tasks.items.list"] = Object.assign(new Error("Method not found"), { code: -32601 });
  await store.loadTasks();
  assert.equal(store.getTasks().unsupported, true);
  store.resetTasks();
});

test("status changes show at once and roll back when refused", async () => {
  const client = fakeClient();
  client.respond["tasks.items.list"] = { tasks: [task("1")] };
  store.attachTasks(client, () => true);
  await store.loadTasks();

  let release;
  client.respond["tasks.items.update"] = () =>
    new Promise((resolve) => {
      release = () => resolve(task("1", { status: "done", updated_at: "2026-10-05T00:00:00Z" }));
    });
  const pending = store.setTaskStatus("1", "done");
  assert.equal(store.getTasks().tasks[0].status, "done", "shown before the computer answers");
  release();
  await pending;
  assert.equal(store.getTasks().tasks[0].status, "done");

  client.respond["tasks.items.update"] = Object.assign(new Error("Only user statuses"), { code: -32602 });
  await assert.rejects(store.setTaskPriority("1", 1));
  assert.equal(store.getTasks().tasks[0].priority, 0, "a refused change is rolled back");

  // A newer change wins over an older one still in flight.
  const releases = [];
  client.respond["tasks.items.update"] = (params) =>
    new Promise((resolve) => releases.push(() => resolve(task("1", { priority: params.priority, updated_at: `2026-10-05T0${releases.length}:00:01Z` }))));
  const first = store.setTaskPriority("1", 2);
  const second = store.setTaskPriority("1", 3);
  releases[0]();
  await first;
  assert.equal(store.getTasks().tasks[0].priority, 3, "the newer pending change stays visible");
  releases[1]();
  await second;
  assert.equal(store.getTasks().tasks[0].priority, 3);
  store.resetTasks();
});

test("checklist toggles send the edited body with the revision", async () => {
  const client = fakeClient();
  client.respond["tasks.items.list"] = { tasks: [task("1", { body: "- [ ] a\n- [ ] b\n", revision: 4 })] };
  store.attachTasks(client, () => true);
  await store.loadTasks();
  client.respond["tasks.items.update"] = (params) => task("1", { body: params.body, revision: 5, updated_at: "2026-10-05T00:00:00Z" });
  await store.toggleTaskCriterion("1", 1);
  const [, params] = client.calls.at(-1);
  assert.deepEqual(params, { id: "1", body: "- [ ] a\n- [x] b\n", expected_revision: 4 });
  assert.equal(store.getTasks().tasks[0].revision, 5);
  store.resetTasks();
});

test("deleting offers Undo, which restores the task", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = fakeClient();
  client.respond["tasks.items.list"] = { tasks: [task("1")] };
  store.attachTasks(client, () => true);
  await store.loadTasks();
  client.respond["tasks.items.delete"] = {};
  await store.deleteTask("1");
  assert.equal(store.getTasks().tasks.length, 0);
  assert.deepEqual(store.getTasks().toast.action, { kind: "undo", taskId: "1" });
  assert.equal(store.getTasks().toast.text, "ADE-1 deleted");
  t.mock.timers.tick(model.UNDO_MS + 10);
  assert.equal(store.getTasks().toast, null);
  client.respond["tasks.items.restore"] = task("1", { updated_at: "2026-10-05T00:00:00Z" });
  await store.restoreTask("1");
  await tick();
  assert.deepEqual(store.getTasks().tasks.map((x) => x.id), ["1"]);
  store.resetTasks();
});
