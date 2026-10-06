import assert from "node:assert/strict";
import test from "node:test";
import { chatLink, kybernRef, kybernRefsIn, splitKybernRefs } from "../src/chatLinks.ts";
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

const NOTE = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const TASK = "0199A1B2-C3D4-7E5F-8A9B-FFFFFFFFFFFF";

test("kybern note and task links classify as references, other kybern URIs stay unsupported", () => {
  assert.deepEqual(chatLink(`kybern://note/${NOTE}`), { kind: "kybern", target: "note", id: NOTE });
  assert.deepEqual(chatLink(`<kybern://task/${TASK}/>`), { kind: "kybern", target: "task", id: TASK.toLowerCase() });
  assert.deepEqual(kybernRef(` KYBERN://Task/${NOTE} `), { target: "task", id: NOTE });
  for (const url of ["kybern://note/7b0c", `kybern://thread/${NOTE}`, "kybern://computer", "kybern://pair?code=1", `kybern://note/${NOTE}/extra`, `kybern://note/${NOTE}?x=1`, `xkybern://note/${NOTE}`])
    assert.deepEqual(chatLink(url), { kind: "unsupported" }, url);
  assert.equal(kybernRef("https://example.com"), null);
});

test("bare kybern references are found in running text and keep their punctuation outside", () => {
  assert.deepEqual(splitKybernRefs("no refs here"), [{ text: "no refs here" }]);
  const parts = splitKybernRefs(`Filed kybern://task/${TASK}, see (kybern://note/${NOTE}).`);
  assert.deepEqual(parts.map((p) => p.text), ["Filed ", `kybern://task/${TASK}`, ", see (", `kybern://note/${NOTE}`, ")."]);
  assert.deepEqual(parts[1].ref, { target: "task", id: TASK.toLowerCase() });
  assert.equal(splitKybernRefs(`https://example.com/kybern://note/${NOTE}`).length, 1);
  assert.equal(splitKybernRefs(`kybern://note/${NOTE}-more`).length, 1);
});

test("a message references an item as a link, a bare URI or inline code, but not inside a fenced block", () => {
  assert.deepEqual(kybernRefsIn(null), []);
  assert.deepEqual(kybernRefsIn("Nothing to see"), []);
  assert.deepEqual(kybernRefsIn(`Filed [ADE-12 Title](kybern://task/${TASK}).`), [{ target: "task", id: TASK.toLowerCase() }]);
  assert.deepEqual(kybernRefsIn(`Saved \`kybern://note/${NOTE}\` for later`), [{ target: "note", id: NOTE }]);
  assert.deepEqual(kybernRefsIn(`Open kybern://note/${NOTE}\n\nand again [x](kybern://note/${NOTE.toUpperCase()})`), [{ target: "note", id: NOTE }]);
  assert.deepEqual(kybernRefsIn(["Example:", "```md", `[x](kybern://note/${NOTE})`, "```", "", `~~~~`, `kybern://task/${TASK}`, "~~~~"].join("\n")), []);
  assert.deepEqual(kybernRefsIn(["```", "unclosed", `kybern://note/${NOTE}`].join("\n")), []);
  assert.deepEqual(kybernRefsIn(["```", "x", "```", `kybern://note/${NOTE}`].join("\n")), [{ target: "note", id: NOTE }]);
  assert.deepEqual(kybernRefsIn("kybern://note/not-a-uuid"), []);
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
