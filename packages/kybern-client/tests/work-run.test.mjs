import assert from "node:assert/strict";
import test from "node:test";
import { basename, liveAction, runSummary } from "../src/workRun.ts";

let n = 0;
const tool = (name, input, extra = {}) =>
  ({ kind: "tool", id: `b${++n}`, turnId: "t", at: "", seq: n, origin: { kind: "root" }, call: { id: `c${n}`, name, input }, stream: "", output: null, isError: false, complete: true, ...extra });
const thought = (extra = {}) =>
  ({ kind: "assistant", id: `b${++n}`, turnId: "t", at: "", seq: n, origin: { kind: "root" }, messageId: "m", segment: 0, text: "", thinking: "hmm", complete: true, ...extra });

test("a settled run counts by importance, files once each", () => {
  const blocks = [
    tool("Read", { file_path: "/w/a.ts" }),
    tool("Grep", { pattern: "x" }),
    tool("Read", { file_path: "/w/a.ts" }),
    tool("Edit", { file_path: "/w/a.ts", old_string: "a", new_string: "b" }),
    tool("Bash", { command: "bun test" }),
    thought(),
  ];
  assert.deepEqual(runSummary(blocks), { label: "Edited 1 file · ran 1 command · read 1 file · searched 1 time", live: null, failed: null });
});

test("two edits and three commands read as the issue's example", () => {
  const blocks = [
    tool("Edit", { file_path: "/w/a.ts", old_string: "a", new_string: "b" }),
    tool("Write", { file_path: "/w/b.ts", content: "x" }),
    tool("Bash", { command: "pnpm typecheck" }),
    tool("Bash", { command: "pnpm lint" }),
    tool("Bash", { command: "pnpm test" }),
  ];
  assert.equal(runSummary(blocks).label, "Edited 2 files · ran 3 commands");
});

test("cat with a redirect writes a file: it counts as an edit, not a read", () => {
  const blocks = [tool("Bash", { command: "cat > notes/plan.md <<'EOF'\n# Plan\nEOF" }), tool("Bash", { command: "cat src/lib.rs" })];
  assert.equal(runSummary(blocks).label, "Edited 1 file · read 1 file");
});

test("while live, settled calls are counted and the call in flight is the tail", () => {
  const blocks = [tool("Read", { file_path: "/w/a.ts" }), tool("Read", { file_path: "/w/src/Requests.tsx" }, { complete: false })];
  assert.deepEqual(runSummary(blocks), { label: "Read a.ts", live: "reading Requests.tsx", failed: null });
  assert.equal(runSummary(blocks.slice(1)).live, "Reading Requests.tsx");
  assert.equal(runSummary(blocks.slice(1)).label, "");
});

test("streaming reasoning is the tail; settled reasoning alone reads Thought", () => {
  const think = thought({ complete: false });
  assert.deepEqual(runSummary([tool("Bash", { command: "pnpm typecheck" }), think], think.id), { label: "Ran pnpm typecheck", live: "thinking", failed: null });
  assert.deepEqual(runSummary([think], think.id), { label: "", live: "Thinking", failed: null });
  assert.deepEqual(runSummary([thought()]), { label: "Thought", live: null, failed: null });
  assert.deepEqual(runSummary([tool("Read", { file_path: "a" })], null, true), { label: "Read a", live: "thinking", failed: null });
});

test("failed calls are counted apart", () => {
  assert.deepEqual(runSummary([tool("Read", { file_path: "a" }), tool("Bash", { command: "x" }, { isError: true })]), { label: "Read a", live: null, failed: "1 failed" });
  assert.deepEqual(runSummary([tool("Bash", { command: "x" }, { isError: true }), tool("Bash", { command: "y" }, { isError: true })]), { label: "", live: null, failed: "2 calls failed" });
});

test("background processes are named after the calls", () => {
  const task = { kind: "runtime_task", id: `b${++n}`, turnId: "t", at: "", seq: n, task: { id: "p", kind: "process", status: "running" } };
  assert.equal(runSummary([tool("Bash", { command: "pnpm dev" }), task]).label, "Ran pnpm dev · started 1 background task");
});

test("the live action names the file, command or query", () => {
  assert.equal(liveAction({ id: "x", name: "Edit", input: { file_path: "/w/src/Hero.tsx" } }), "Editing Hero.tsx");
  assert.equal(liveAction({ id: "x", name: "Bash", input: { command: "bun test" } }), "Running bun test");
  assert.equal(liveAction({ id: "x", name: "Grep", input: { pattern: "useFresh" } }), "Searching for useFresh");
});

test("one action reads as itself; counts start at two", () => {
  assert.equal(runSummary([tool("Read", { file_path: "/w/styles/system.css" })]).label, "Read system.css");
  assert.equal(runSummary([tool("Read", { file_path: "/w/a.ts" }), tool("Read", { file_path: "/w/a.ts" })]).label, "Read a.ts");
  assert.equal(runSummary([tool("Read", { file_path: "/w/a.ts" }), tool("Read", { file_path: "/w/b.ts" })]).label, "Read 2 files");
  assert.equal(runSummary([tool("Bash", { command: "bun test" }), tool("Read", { file_path: "/w/a.ts" })]).label, "Ran 1 command · read 1 file");
  assert.equal(runSummary([tool("Grep", { pattern: "useFresh" })]).label, "Searched for useFresh");
  const long = runSummary([tool("Bash", { command: `bun test ${"src/very/long/path/".repeat(6)}` })]).label;
  assert.ok(long.length <= 52);
  assert.ok(long.endsWith("…"));
});

test("a fetch is Fetched, a web search Searched", () => {
  assert.equal(liveAction({ id: "x", name: "WebFetch", input: { url: "https://example.com" } }), "Fetching https://example.com");
  assert.equal(basename("/a/b/c.ts"), "c.ts");
  assert.equal(basename("C:\\a\\b\\"), "b");
});
