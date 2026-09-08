// Read-only transport regression probe. Use a scratch daemon with a long thread.
// KYBERN_DATA_DIR=/tmp/kyb KYBERN_THREAD_ID=<id> node perf/check-hydration.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const expoRequire = createRequire(require.resolve("expo/package.json"));
const { WebSocket } = createRequire(expoRequire.resolve("@expo/cli/package.json"))("ws");
const directory = process.env.KYBERN_DATA_DIR;
assert(directory, "Set KYBERN_DATA_DIR to the daemon to measure");
const port = fs.readFileSync(path.join(directory, "daemon.port"), "utf8").trim();
const token = fs.readFileSync(path.join(directory, "daemon.token"), "utf8").trim();
const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Authorization: `Bearer ${token}`, Origin: "tauri://localhost" } });
await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
let nextId = 0;
const pending = new Map();
socket.on("message", (raw) => {
  const message = JSON.parse(raw.toString());
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  clearTimeout(request.timer);
  if (message.error) request.reject(new Error(message.error.message));
  else request.resolve({ result: message.result, bytes: raw.length, elapsedMs: performance.now() - request.start });
});
function call(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject, start: performance.now(), timer: setTimeout(() => reject(new Error("RPC timeout")), 15000) });
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}
try {
  const { result } = await call("threads.list", { include_archived: false });
  const thread = process.env.KYBERN_THREAD_ID
    ? result.threads.find((t) => t.id === process.env.KYBERN_THREAD_ID)
    : result.threads.toSorted((a, b) => b.last_seq - a.last_seq)[0];
  assert(thread, "No thread to measure");
  const page = await call("threads.get", { thread_id: thread.id, transcript_limit: 60 });
  console.log(JSON.stringify({ entries: page.result.transcript.length, bytes: page.bytes, elapsedMs: Math.round(page.elapsedMs), hasEarlier: page.result.next_before_seq != null }));
  const recent = page.result.transcript.filter((entry) => page.result.next_before_seq == null || entry.seq >= page.result.next_before_seq);
  assert(recent.filter((entry) => entry.seq > recent[0]?.seq).length < 60, "Opening a long thread must fetch a bounded recent page instead of the complete transcript (equal-sequence boundaries and older live rows may extend the page)");
  if (process.argv.includes("--all-pages")) {
    const full = await call("threads.get", { thread_id: thread.id, through_seq: page.result.thread.last_seq });
    // Older unfinished rows accompany the first page and reappear in their
    // ordinary history page. Count them there when comparing complete history.
    let entries = recent;
    let cursor = page.result.next_before_seq;
    let pages = 1;
    while (cursor != null) {
      const older = await call("threads.get", { thread_id: thread.id, transcript_limit: 60, before_seq: cursor, through_seq: page.result.thread.last_seq });
      assert(older.result.transcript.every((entry) => entry.seq < cursor));
      assert(older.result.next_before_seq == null || older.result.next_before_seq < cursor);
      entries = [...older.result.transcript, ...entries];
      cursor = older.result.next_before_seq;
      pages++;
    }
    assert.deepEqual(entries, full.result.transcript);
    console.log(JSON.stringify({ fullBytes: full.bytes, fullElapsedMs: Math.round(full.elapsedMs), entries: entries.length, pages, exactHistory: true }));
  }
} finally {
  for (const request of pending.values()) clearTimeout(request.timer);
  socket.close();
}
