import assert from "node:assert/strict";
import test from "node:test";
import { chatLink } from "../src/chatLinks.ts";
import { createHistoryPagingGate, EARLIER_HISTORY_ENTRIES } from "../src/historyPaging.ts";

test("chat references separate connected files from external URLs and preserve location suffixes", () => {
  for (const [input, path, line] of [
    ["2026-09-10-hermes-prompt.md", "2026-09-10-hermes-prompt.md"],
    ["./docs/guide.md", "./docs/guide.md"],
    ["<docs/My File.md>", "docs/My File.md"],
    ["docs/My%20File.ts:12:3", "docs/My File.ts", 12],
    ["/workspace/src/main.rs#L7-L12", "/workspace/src/main.rs", 7],
    ["file:///workspace/My%20File.md#L9", "/workspace/My File.md", 9],
    ["C:\\workspace\\file.ts:3", "C:\\workspace\\file.ts", 3],
  ]) assert.deepEqual(chatLink(input), { kind: "file", path, ...(line ? { line } : {}) });
  for (const url of ["https://example.com/a.md#L10", "http://localhost:8080/a", "mailto:hello@example.com"])
    assert.deepEqual(chatLink(url), { kind: "external", url });
  for (const url of ["javascript:alert(1)", "data:text/html,hi", "file://another-host/a", "//another-host/a", "%00file", "file%zz"])
    assert.deepEqual(chatLink(url), { kind: "unsupported" });
  assert.deepEqual(chatLink("#overview"), { kind: "anchor", id: "overview" });
  assert.deepEqual(chatLink("../guide.md", "docs/sub/start.md"), { kind: "file", path: "docs/sub/../guide.md" });
  assert.deepEqual(chatLink("/workspace/other.md", "docs/start.md"), { kind: "file", path: "/workspace/other.md" });
});

test("history prefetch waits for reading intent and loads each nearby cursor once", () => {
  const gate = createHistoryPagingGate();
  assert.equal(EARLIER_HISTORY_ENTRIES, 120);
  assert.equal(gate.claim(100, 300, 600, false), false, "initial layout does not fetch history");
  assert.equal(gate.claim(100, 1500, 600, true), false, "distant history stays unloaded");
  assert.equal(gate.claim(100, 900, 600, true), true, "start before the visible boundary");
  assert.equal(gate.claim(100, 0, 600, true), false, "no duplicate calls or automatic retry loop");
  assert.equal(gate.claim(50, 1400, 600, true), false, "prepended history moves the boundary away");
  assert.equal(gate.claim(50, 900, 600, true), true, "browsing continues across pages");
  assert.equal(gate.claim(null, 0, 600, true), false, "oldest page stops loading");
  assert.equal(gate.claim(20, 0, 0, true), false, "hidden viewport does not fetch");
});

test("collaboration disclosure hides branches without losing orphan or selected threads", async () => {
  const { collaborationThreadRows } = await import("../src/collaboration.ts");
  const threads = [{ id: "root" }, { id: "child", parent_thread_id: "root" }, { id: "leaf", parent_thread_id: "child" }, { id: "orphan", parent_thread_id: "gone" }];
  assert.deepEqual(collaborationThreadRows(threads, {}).map(row => row.thread.id), ["root", "orphan"]);
  assert.deepEqual(collaborationThreadRows(threads, { root: true }).map(row => row.thread.id), ["root", "child", "orphan"]);
  assert.deepEqual(collaborationThreadRows(threads, {}, "leaf").map(row => row.thread.id), ["root", "child", "leaf", "orphan"]);
  assert.deepEqual(collaborationThreadRows(threads, { root: false }, "leaf").map(row => row.thread.id), ["root", "orphan"]);
  assert.equal(collaborationThreadRows([{id:"a",parent_thread_id:"b"},{id:"b",parent_thread_id:"a"}], {a:true,b:true}).length, 2);
});

test("collaboration preview keeps result text and leaves ordinary prompts alone", async () => {
  const { collaborationPreview } = await import("../src/collaboration.ts");
  const id = "01a0a0e6-85d2-7c01-adfc-8ce6a93c5b0e";
  const body = "Revised commit: abc.\n\nTests passed.";
  const raw = `Kybern collaboration Result from thread ${id} (message ${id}, reply_to None):\n${body}\n\nDo not send an acknowledgement wakeup. Continue only if this message gives you actual work; otherwise record progress without waking the sender.`;
  assert.deepEqual(collaborationPreview(raw), { purpose: "Result", senderId: id, body });
  assert.equal(collaborationPreview("Can you explain Kybern collaboration Result?"), null);
  assert.equal(collaborationPreview("Kybern collaboration Result from thread nonsense"), null);
});
