import assert from "node:assert/strict";
import test from "node:test";
import {
  bead,
  buildGraph,
  clock,
  columnWidths,
  depths,
  duration,
  filterGroups,
  groupRuns,
  headlineStep,
  isTag,
  jobProgress,
  jobTimes,
  matchJobs,
  nodeTime,
  placeGraph,
  runSummary,
  sameRow,
  usualDuration,
} from "../src/actionsPipeline.ts";

// What the daemon's parser reads from kybern's own workflow files (crates/kybern-daemon/src/github_actions.rs tests).
const CI = [
  { id: "changes", name: "changes" },
  { id: "fmt", name: "rustfmt", needs: ["changes"], conditional: true },
  { id: "check", name: "clippy + test (${{ matrix.os }})", needs: ["changes"], matrix: ["os"], conditional: true },
  { id: "windows-check", name: "cargo check (windows-latest)", needs: ["changes"], conditional: true },
  { id: "release", name: "release checks", needs: ["changes"], conditional: true },
  { id: "gpuix", name: "gpuix (typecheck + test)", needs: ["changes"], conditional: true },
  { id: "ci", name: "CI", needs: ["changes", "fmt", "check", "windows-check", "release", "gpuix"], conditional: true },
];
const RELEASE = [
  { id: "plan" },
  { id: "build-local-artifacts", name: "build-local-artifacts (${{ join(matrix.targets, ', ') }})", needs: ["plan"], matrix: [], conditional: true },
  { id: "custom-release-ci", needs: ["plan"], uses: "./.github/workflows/release-ci.yml", conditional: true },
  { id: "build-global-artifacts", needs: ["plan", "build-local-artifacts"] },
  { id: "custom-desktop", needs: ["plan", "build-local-artifacts"], uses: "./.github/workflows/desktop.yml" },
  { id: "host", needs: ["plan", "build-local-artifacts", "custom-release-ci", "build-global-artifacts", "custom-desktop"], conditional: true },
  { id: "announce", needs: ["plan", "host"], conditional: true },
];
const PLATFORMS = [
  { id: "plan", name: "plan" },
  { id: "wpe", name: "wpe", uses: "./.github/workflows/gpuix-wpe.yml" },
  { id: "checks", name: "${{ matrix.id }}", needs: ["plan", "wpe"], matrix: [], conditional: true },
];

let nextId = 100;
const job = (name, status = "completed", conclusion = "success", over = {}) => ({
  id: nextId++, name, status, conclusion: status === "completed" ? conclusion : "", url: "u", steps: [],
  started_at: "2026-10-31T16:59:05Z", completed_at: status === "completed" ? "2026-10-31T17:05:20Z" : undefined, ...over,
});
const rustfmtId = jobs => jobs.find(j => j.name === "rustfmt").id;
const names = (graph, column) => graph.nodes.filter(n => n.column === column).map(n => n.job.name);

test("CI's real jobs land in columns by needs, matrix names included", () => {
  const jobs = ["changes", "rustfmt", "clippy + test (ubuntu-24.04)", "cargo check (windows-latest)", "clippy + test (macos-15)", "gpuix (typecheck + test)", "release checks", "CI"].map(n => job(n));
  const matched = matchJobs(jobs, CI);
  assert.equal(matched.get(jobs[2].id), "check");
  assert.equal(matched.get(jobs[4].id), "check");
  const graph = buildGraph(jobs, CI);
  assert.equal(graph.fallback, false);
  assert.equal(graph.columns, 3);
  assert.deepEqual(names(graph, 0), ["changes"]);
  assert.deepEqual(names(graph, 1), ["rustfmt", "clippy + test (ubuntu-24.04)", "clippy + test (macos-15)", "cargo check (windows-latest)", "release checks", "gpuix (typecheck + test)"]);
  assert.deepEqual(names(graph, 2), ["CI"]);
  assert.equal(graph.rows, 6);
  assert.equal(graph.edges.length, 6 + 6, "changes fans out to six, CI waits on those six (its direct need on changes is implied)");
  assert.ok(!graph.edges.some(e => e.from === jobs[0].id && e.to === jobs[7].id));
});

test("a skipped job's edges are skipped and an unexpanded name still matches", () => {
  const jobs = [job("plan"), job("custom-release-ci", "completed", "skipped"), job("build-local-artifacts (${{ join(matrix.targets, ', ') }})", "completed", "skipped"), job("build-global-artifacts", "completed", "skipped"), job("custom-desktop", "completed", "skipped"), job("host", "completed", "skipped"), job("announce", "completed", "skipped")];
  const graph = buildGraph(jobs, RELEASE);
  assert.equal(graph.fallback, false);
  assert.deepEqual(names(graph, 0), ["plan"]);
  assert.deepEqual(names(graph, 1), ["build-local-artifacts (${{ join(matrix.targets, ', ') }})", "custom-release-ci"]);
  assert.deepEqual(names(graph, 2), ["build-global-artifacts", "custom-desktop"]);
  assert.deepEqual(names(graph, 3), ["host"]);
  assert.deepEqual(names(graph, 4), ["announce"]);
  assert.ok(graph.edges.every(e => e.kind === "skipped"));
});

test("reusable workflow jobs sit with their caller, and a whole-expression name takes only what is left", () => {
  const release = ["plan", "custom-release-ci / verify", "build-local-artifacts (aarch64-apple-darwin)", "build-local-artifacts (x86_64-pc-windows-msvc)", "build-global-artifacts", "custom-desktop / gpuix-wpe / WPE WebKit (ubuntu-22.04)", "custom-desktop / bundle (gpuix x86_64-apple-darwin)", "custom-desktop / updater manifest", "host", "announce"].map(n => job(n));
  const m = matchJobs(release, RELEASE);
  assert.equal(m.get(release[1].id), "custom-release-ci");
  assert.equal(m.get(release[5].id), "custom-desktop");
  assert.equal(m.get(release[7].id), "custom-desktop");
  const graph = buildGraph(release, RELEASE);
  assert.deepEqual(names(graph, 2), ["build-global-artifacts", "custom-desktop / gpuix-wpe / WPE WebKit (ubuntu-22.04)", "custom-desktop / bundle (gpuix x86_64-apple-darwin)", "custom-desktop / updater manifest"]);

  const platforms = ["plan", "wpe / WPE WebKit (ubuntu-22.04)", "windows", "linux-wayland", "linux", "linux-noble"].map(n => job(n));
  const p = matchJobs(platforms, PLATFORMS);
  assert.deepEqual([...p.values()], ["plan", "wpe", "checks", "checks", "checks", "checks"]);
  const g = buildGraph(platforms, PLATFORMS);
  assert.deepEqual(names(g, 0), ["plan", "wpe / WPE WebKit (ubuntu-22.04)"]);
  assert.equal(names(g, 1).length, 4);
  assert.equal(g.edges.length, 8);
});

test("jobs that can't be placed fall back to run order, keeping the edges it knows", () => {
  const jobs = [job("changes"), job("rustfmt"), job("something new")];
  assert.equal(matchJobs(jobs, CI), null);
  const graph = buildGraph(jobs, CI);
  assert.equal(graph.fallback, true);
  assert.equal(graph.columns, 1);
  assert.deepEqual(graph.nodes.map(n => n.row), [0, 1, 2]);
  assert.deepEqual(graph.edges.map(e => [e.from, e.to]), [[jobs[0].id, jobs[1].id]]);
  // Two declarations claiming a job equally is a guess too.
  const twins = [{ id: "a", name: "${{ matrix.x }}", matrix: [] }, { id: "b", name: "${{ matrix.y }}", matrix: [] }];
  assert.equal(matchJobs([job("linux")], twins), null);
  assert.equal(buildGraph([job("linux")], twins).fallback, true);
  // No workflow file at all.
  const none = buildGraph([job("a"), job("b")], undefined);
  assert.deepEqual([none.fallback, none.edges.length, none.columns], [true, 0, 1]);
  assert.equal(depths([{ id: "a", needs: ["b"] }, { id: "b", needs: ["a"] }]), null, "a cycle");
  assert.equal(buildGraph([job("a"), job("b")], [{ id: "a", needs: ["b"] }, { id: "b", needs: ["a"] }]).fallback, true);
});

test("a job gated out of the run closes its column and its dependants wait on what it waited on", () => {
  const specs = [{ id: "a" }, { id: "b", needs: ["a"], conditional: true }, { id: "c", needs: ["b"] }];
  const jobs = [job("a"), job("c")];
  const graph = buildGraph(jobs, specs);
  assert.deepEqual([graph.columns, graph.nodes.map(n => n.column)], [2, [0, 1]]);
  assert.deepEqual(graph.edges.map(e => [e.from, e.to]), [[jobs[0].id, jobs[1].id]]);
});

test("the failure path runs from the root through the first failure to the final job", () => {
  const jobs = [
    job("changes"), job("rustfmt"), job("clippy + test (macos-15)"), job("clippy + test (ubuntu-24.04)", "completed", "failure"),
    job("cargo check (windows-latest)"), job("gpuix (typecheck + test)", "completed", "skipped"), job("release checks", "completed", "skipped"),
    job("CI", "completed", "failure"),
  ];
  const graph = buildGraph(jobs, CI);
  const [changes, , , ubuntu, , gpuix, , ci] = jobs.map(j => j.id);
  assert.deepEqual(graph.failureOrigins, [ubuntu]);
  const red = graph.edges.filter(e => e.kind === "failure").map(e => [e.from, e.to]);
  assert.deepEqual(red, [[changes, ubuntu], [ubuntu, ci]]);
  assert.equal(graph.edges.find(e => e.from === changes && e.to === gpuix).kind, "skipped");
  assert.equal(graph.edges.find(e => e.from === rustfmtId(jobs) && e.to === ci).kind, "done", "the gate's other inputs stay neutral");
  assert.equal(runSummary({ status: "completed" }, graph, null), "The failure runs through clippy + test (ubuntu-24.04)");
});

test("running edges flow, waiting ones wait, and the header counts done jobs", () => {
  const jobs = [
    job("changes"), job("rustfmt"), job("clippy + test (macos-15)", "in_progress"), job("clippy + test (ubuntu-24.04)", "in_progress"),
    job("cargo check (windows-latest)"), job("gpuix (typecheck + test)"), job("release checks"), job("CI", "queued"),
  ];
  const graph = buildGraph(jobs, CI);
  const [changes, rustfmt, macos, , , , , ci] = jobs.map(j => j.id);
  assert.equal(graph.edges.find(e => e.from === changes && e.to === macos).kind, "running");
  const toCi = graph.edges.filter(e => e.to === ci && e.from !== changes);
  assert.ok(toCi.every(e => e.kind === "waiting"));
  assert.equal(toCi.find(e => e.from === macos).hot, true);
  assert.equal(toCi.find(e => e.from === rustfmt).hot, undefined);
  assert.equal(runSummary({ status: "in_progress" }, graph, 500), "5 of 8 jobs done · usually 8m 20s");
  assert.equal(nodeTime(graph, graph.nodes.find(n => n.job.id === ci)), "Waits for 2 jobs", "the two running checks; the finished ones don't count");
  assert.ok(columnWidths(graph, t => t.length * 7)[2] > 128, "the gate's column fits its name and what it waits for");
  assert.equal(runSummary({ status: "completed" }, buildGraph([job("changes"), job("release checks", "completed", "skipped")], CI), null), "1 job passed, 1 skipped");
});

test("geometry: columns left to right, centred, S-curves between edges", () => {
  const jobs = ["changes", "rustfmt", "clippy + test (ubuntu-24.04)", "CI"].map(n => job(n));
  const graph = buildGraph(jobs, CI);
  const widths = columnWidths(graph, t => t.length * 7);
  assert.deepEqual(widths, [7 * 7 + 92, 7 * 28 + 92, 128], "the name plus room for the glyph and time, 128 at least");
  const layout = placeGraph(graph, { columnWidths: widths, nodeHeight: 32, rowGap: 8, columnGap: 100 });
  assert.equal(layout.height, 72);
  assert.equal(layout.width, 141 + 100 + 288 + 100 + 128);
  const changes = layout.nodes.get(jobs[0].id), ci = layout.nodes.get(jobs[3].id);
  assert.deepEqual([changes.x, changes.y], [0, 20], "centred on the two-node column");
  assert.deepEqual([ci.x, ci.y], [629, 20]);
  const edge = layout.edges.find(e => e.from === jobs[0].id && e.to === jobs[1].id);
  assert.equal(edge.d, "M141 36C191 36 191 16 241 16");
  assert.ok(edge.length >= 100);
  assert.deepEqual(columnWidths(graph, t => t.length * 7, { budget: 400 }), [136, 136, 128], "the widest column gives way first, then the next");
  const fallback = placeGraph(buildGraph([job("changes"), job("rustfmt"), job("nope")], CI), { columnWidths: [200], nodeHeight: 32, rowGap: 8, columnGap: 100 });
  assert.equal(fallback.width, 224, "room for the loops on the right");
  assert.match(fallback.edges[0].d, /^M200 16C2\d\d/);
});

const run = (over = {}) => ({
  id: nextId++, number: 699, attempt: 1, workflow_name: "CI", workflow_id: 1, title: "t", head_branch: "main", head_sha: "abc",
  event: "push", status: "completed", conclusion: "success", url: "u", created_at: "2026-10-31T16:58:00Z",
  started_at: "2026-10-31T16:58:00Z", updated_at: "2026-10-31T17:06:20Z", ...over,
});

test("runs group by branch: the default branch's workflows and tags first, then branches by latest push", () => {
  const runs = [
    run({ head_branch: "fix/reading", created_at: "2026-10-31T18:00:00Z", status: "in_progress", conclusion: "", number: 700 }),
    run({ head_branch: "main", number: 699, created_at: "2026-10-31T17:00:00Z" }),
    run({ head_branch: "v0.20.4", workflow_id: 2, workflow_name: "Release", number: 566, created_at: "2026-10-31T16:30:00Z" }),
    run({ head_branch: "feat/ports", created_at: "2026-10-31T16:00:00Z", number: 698, conclusion: "failure", pull_requests: [171] }),
    run({ head_branch: "main", number: 697, created_at: "2026-10-31T15:00:00Z", conclusion: "failure" }),
    run({ head_branch: "fix/reading", created_at: "2026-10-31T14:00:00Z", number: 690, conclusion: "failure" }),
  ];
  const { main, branches } = groupRuns(runs, { defaultBranch: "main", pulls: [{ branch: "fix/reading", number: 170, state: "OPEN" }] });
  assert.equal(main.rows.length, 2);
  assert.deepEqual(main.rows.map(r => [r.workflow, r.label, r.beads.map(b => b.bucket)]), [["CI", "#699", ["failed", "passed"]], ["Release", "v0.20.4", ["passed"]]]);
  assert.deepEqual(branches.map(b => [b.branch, b.pull?.number]), [["fix/reading", 170], ["feat/ports", 171]]);
  assert.deepEqual(branches[0].rows[0].beads.map(b => b.bucket), ["failed", "running"], "oldest first");
  assert.equal(branches[0].latest.number, 700);
  assert.deepEqual(filterGroups(branches, "PORTS").map(b => b.branch), ["feat/ports"]);
  assert.deepEqual(filterGroups(branches, "#170").map(b => b.branch), ["fix/reading"]);
  assert.equal(filterGroups(branches, " ").length, 2);
  const limited = groupRuns(runs, { defaultBranch: "main", beads: { main: 1, branch: 1 } });
  assert.equal(limited.main.rows[0].beads.length, 1);
  assert.ok(isTag("v0.20.4") && isTag("1.2") && !isTag("main") && !isTag("v-next"));
});

test("beads are interned, so an unchanged refresh draws nothing new", () => {
  const a = run({ id: 1 }), again = { ...a };
  assert.equal(bead(a), bead(again));
  assert.notEqual(bead(a), bead({ ...a, attempt: 2 }));
  assert.notEqual(bead(a), bead({ ...a, status: "in_progress", conclusion: "" }));
  const first = groupRuns([a], { defaultBranch: "main" }).main.rows[0];
  const second = groupRuns([again], { defaultBranch: "main" }).main.rows[0];
  assert.ok(sameRow(first, second));
  assert.ok(!sameRow(first, groupRuns([{ ...a, conclusion: "failure" }], { defaultBranch: "main" }).main.rows[0]));
});

test("times: usual duration, job progress, clocks", () => {
  const runs = [run({}), run({}), run({ updated_at: "2026-10-31T17:08:00Z" }), run({ conclusion: "failure" }), run({ workflow_id: 9 })];
  assert.equal(usualDuration(runs, 1), 500);
  assert.equal(usualDuration(runs.slice(0, 2), 1), null);
  const usual = jobTimes([job("test", "completed", "success", { started_at: "2026-10-31T17:00:00Z", completed_at: "2026-10-31T17:10:00Z" }), job("x", "completed", "failure")]);
  assert.deepEqual([...usual], [["test", 600]]);
  const now = Date.parse("2026-10-31T17:05:00Z");
  assert.equal(jobProgress(job("test", "in_progress", "", { started_at: "2026-10-31T17:00:00Z" }), usual, now), 0.5);
  assert.equal(jobProgress(job("test", "in_progress", "", { started_at: "2026-10-31T16:00:00Z" }), usual, now), 0.96);
  assert.equal(jobProgress(job("other", "in_progress"), usual, now), null);
  assert.deepEqual([clock(252), clock(3729), duration(500), duration(45), duration(3900)], ["4:12", "1:02:09", "8m 20s", "45s", "1h 5m"]);
});

test("the log names the failed step, else the running one, else the longest", () => {
  const step = (number, name, status, conclusion, s, e) => ({ number, name, status, conclusion, started_at: s, completed_at: e });
  const t = (m) => `2026-10-31T17:${String(m).padStart(2, "0")}:00Z`;
  assert.equal(headlineStep({ steps: [step(1, "a", "completed", "success", t(0), t(1)), step(2, "test", "completed", "failure", t(1), t(2))] }).name, "test");
  assert.equal(headlineStep({ steps: [step(1, "a", "completed", "success", t(0), t(1)), step(2, "test", "in_progress", "", t(1))] }).name, "test");
  assert.equal(headlineStep({ steps: [step(1, "a", "completed", "success", t(0), t(1)), step(2, "test", "completed", "success", t(1), t(9))] }).name, "test");
  assert.equal(headlineStep({ steps: [] }), undefined);
});
