// #248 on the phone: the disk copy of opened transcripts (expo-sqlite adapter, versions, eviction, wipes),
// the cached copy shown at once and resumed from its cursor, the thread list by cursor, and bounded prefetch.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { nativeModuleSource, seedSecure } from "./native-mocks.mjs";
import { PROTOCOL_VERSION } from "../../../packages/kybern-client/src/types.ts";
seedSecure({
  "kybern.ink.machines": JSON.stringify({ version: 1, records: [{ machineId: "host", name: "Mac", routes: [{ kind: "direct_advertised", url: "http://localhost" }], member: false }] }),
  "kybern.ink.active": "host",
  "kybern.ink.token.host": "fixture",
});
const unsubscribers = [];
globalThis.reconnectSubscribe = (subscribe, getSnapshot) => {
  unsubscribers.push(subscribe(() => {}));
  return getSnapshot();
};
// A small SQLite stand-in for expo-sqlite: enough of the SQL the transcript cache issues.
const tables = new Map();
const fakeSqlite = `
  const rows = globalThis.__sqliteRows ??= new Map();
  const key = (m, t) => m + "\\u0000" + t;
  export async function openDatabaseAsync() {
    return {
      async runAsync(sql, params) {
        (globalThis.__sql ??= []).push(sql.split(" ")[0]);
        if (sql.startsWith("CREATE")) return {};
        if (sql.startsWith("INSERT")) { const [m, t, schema, last_seq, bytes, used_at, body] = params; rows.set(key(m, t), { machine_id: m, thread_id: t, schema, last_seq, bytes, used_at, body }); return {}; }
        if (sql.startsWith("UPDATE")) { const row = rows.get(key(params[1], params[2])); if (row) row.used_at = params[0]; return {}; }
        if (sql.startsWith("DELETE FROM transcript_cache WHERE machine_id = ? AND")) { rows.delete(key(params[0], params[1])); return {}; }
        if (sql.startsWith("DELETE FROM transcript_cache WHERE machine_id = ?")) { for (const [k, r] of rows) if (r.machine_id === params[0]) rows.delete(k); return {}; }
        if (sql.startsWith("DELETE")) { rows.clear(); return {}; }
        throw new Error("unexpected " + sql);
      },
      async getFirstAsync(sql, params) { return rows.get(key(params[0], params[1])) ?? null; },
      async getAllAsync() { return [...rows.values()].map(({ body, schema, last_seq, ...rest }) => rest); },
    };
  }`;
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "expo-sqlite") return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(fakeSqlite)}` };
  const source = nativeModuleSource(specifier);
  if (source) return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(source)}` };
  const url = specifier.startsWith(".") && context.parentURL ? new URL(specifier, context.parentURL) : null;
  if (url?.protocol === "file:" && !/\.[a-z]+$/i.test(url.pathname) && existsSync(fileURLToPath(url) + ".ts")) return { shortCircuit: true, url: url.href + ".ts" };
  return next(specifier, context);
} });
const disk = await import("../src/state/transcriptDisk.ts");
const { memoryTranscriptCacheStore } = await import("../../../packages/kybern-client/src/transcriptCache.ts");
const runtime = await import("../src/state/runtime.ts");

const thread = (id, last_seq = 1, extra = {}) => ({ id, project_id: "project", last_seq, status: "idle", pinned: false, title: id, provider: { kind: "codex" }, created_at: "2026-10-01T00:00:00Z", updated_at: `2026-10-0${Math.min(9, last_seq)}T00:00:00Z`, ...extra });
const state = (id, lastSeq, text = "Hello") => ({
  thread: thread(id, lastSeq), blocks: [{ kind: "assistant", id: "m1", turnId: "turn", at: "2026-10-01T00:00:00Z", seq: lastSeq, text, complete: true }],
  pendingApprovals: [], checkpoints: [], lastSeq, loaded: true, nextBeforeSeq: null, tasks: [], taskActivity: {},
});
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(setImmediate); };

// ---- the disk cache ----

test("the expo-sqlite store saves, loads, rejects another schema and wipes a machine or everything", async () => {
  globalThis.__sqliteRows?.clear();
  const store = disk.defaultTranscriptStore();
  const timers = [];
  const { TranscriptCache } = await import("../../../packages/kybern-client/src/transcriptCache.ts");
  const make = (schema) => new TranscriptCache(store, { schema, validate: disk.isCachedThread, timers: { setTimeout: (fn) => (timers.push(fn), timers.length), clearTimeout: () => {} } });
  const cache = make(disk.TRANSCRIPT_SCHEMA);
  cache.schedule("mac", "t1", () => ({ lastSeq: 7, data: disk.savedThread(state("t1", 7)) }));
  cache.schedule("vps", "t2", () => ({ lastSeq: 3, data: disk.savedThread(state("t2", 3)) }));
  timers.splice(0).forEach((fn) => fn());
  await cache.flush();
  assert.equal(globalThis.__sql[0], "CREATE", "the table is made once before the first statement");
  assert.equal(globalThis.__sql.filter((s) => s === "CREATE").length, 1);
  const loaded = await cache.load("mac", "t1");
  assert.equal(loaded.lastSeq, 7);
  assert.equal(loaded.data.blocks[0].text, "Hello");
  assert.equal("loadingEarlier" in loaded.data, false);
  // A record of another schema is a miss and is deleted.
  assert.equal(await make(disk.TRANSCRIPT_SCHEMA + 1).load("mac", "t1"), undefined);
  assert.equal(await cache.load("mac", "t1"), undefined);
  // A damaged record (not a thread state) is a miss too.
  globalThis.__sqliteRows.set("vps\u0000bad", { machine_id: "vps", thread_id: "bad", schema: disk.TRANSCRIPT_SCHEMA, last_seq: 1, bytes: 2, used_at: 1, body: "{}" });
  assert.equal(await make(disk.TRANSCRIPT_SCHEMA).load("vps", "bad"), undefined);
  await cache.wipeMachine("vps");
  assert.equal(await cache.load("vps", "t2"), undefined);
  cache.schedule("mac", "t3", () => ({ lastSeq: 1, data: disk.savedThread(state("t3", 1)) }));
  timers.splice(0).forEach((fn) => fn());
  await cache.flush();
  await cache.clear();
  assert.equal(globalThis.__sqliteRows.size, 0);
});

test("the least recently used transcripts go first past the entry and byte bounds", async () => {
  const { TranscriptCache } = await import("../../../packages/kybern-client/src/transcriptCache.ts");
  const store = memoryTranscriptCacheStore();
  let now = 0;
  const timers = [];
  const cache = new TranscriptCache(store, { schema: 1, validate: disk.isCachedThread, limits: { maxEntries: 2 }, now: () => ++now, timers: { setTimeout: (fn) => (timers.push(fn), 1), clearTimeout: () => {} } });
  for (const id of ["a", "b"]) cache.schedule("mac", id, () => ({ lastSeq: 1, data: disk.savedThread(state(id, 1)) }));
  timers.splice(0).forEach((fn) => fn());
  await cache.flush();
  await cache.load("mac", "a"); // "a" is now the most recently used
  cache.schedule("mac", "c", () => ({ lastSeq: 1, data: disk.savedThread(state("c", 1)) }));
  timers.splice(0).forEach((fn) => fn());
  await cache.flush();
  assert.deepEqual([...store.rows.values()].map((row) => row.threadId).sort(), ["a", "c"]);
});

test("a long thread saves its newest turns from a turn's start, and loads older ones from there", () => {
  const blocks = [];
  for (let i = 0; i < 500; i++) blocks.push({ kind: "assistant", id: `m${i}`, turnId: `turn${Math.floor(i / 7)}`, at: "", seq: i + 1, text: "x", complete: true });
  const saved = disk.savedThread({ ...state("t", 500), blocks, loadingEarlier: true });
  assert.ok(saved.blocks.length <= disk.SAVED_BLOCKS);
  assert.notEqual(saved.blocks[0].turnId, blocks[blocks.length - disk.SAVED_BLOCKS - 1].turnId === saved.blocks[0].turnId ? "" : "x");
  const first = saved.blocks[0];
  assert.equal(blocks[blocks.indexOf(blocks.find((b) => b.id === first.id)) - 1].turnId !== first.turnId, true, "starts at a turn boundary");
  assert.equal(saved.nextBeforeSeq, first.seq);
  assert.equal("loadingEarlier" in saved, false);
});

// ---- the runtime: cached copy, cursor resume, list cursor, prefetch ----

const sockets = [];
let listHead = 40;
let changed = [];
const gets = [];
const subscribes = [];
class Socket {
  readyState = 0; sent = [];
  constructor() { sockets.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  close() { this.readyState = 3; }
  frame(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
  reply(request, result) { this.frame({ jsonrpc: "2.0", id: request.id, result }); }
  send(text) {
    const request = JSON.parse(text); this.sent.push(request);
    let result;
    switch (request.method) {
      case "daemon.info": result = { protocol_version: PROTOCOL_VERSION, environment_id: "host", machine_id: "host", features: [] }; break;
      case "events.subscribe": subscribes.push(request); return;
      case "providers.list": return;
      case "threads.list":
        result = request.params.since_seq !== undefined
          ? { threads: changed, head_seq: listHead, activity: [] }
          : { threads: [thread("a", 3), thread("b", 9), thread("c", 2), ...Array.from({ length: 8 }, (_, i) => thread(`p${i}`, 1))], head_seq: listHead, omitted: [{ project_id: "project", count: 30 }], activity: [] };
        break;
      case "projects.list": result = { projects: [{ id: "project", name: "project", path: "/p", is_git: true, brief_in_all_threads: false, created_at: "", updated_at: "" }] }; break;
      case "threads.get":
        gets.push(request);
        return;
      case "approvals.list": result = { approvals: [] }; break;
      case "queue.list": result = { messages: [] }; break;
      case "settings.get": result = { default_provider: "codex", providers: {} }; break;
      default: result = {};
    }
    queueMicrotask(() => this.reply(request, result));
  }
}
const page = (id, seq, text = "Fresh") => ({ thread: thread(id, seq), transcript: [{ role: "assistant", id: "m1", turn_id: "turn", seq, text, complete: true }], pending_approvals: [], as_of_seq: 50 });

test("a cached thread shows at once, resumes from its cursor with a gap snapshot, and lists come by cursor", async (t) => {
  const previousSocket = globalThis.WebSocket;
  globalThis.WebSocket = Socket;
  const store = memoryTranscriptCacheStore();
  // "p7" was opened in an earlier session, at seq 5.
  store.rows.set("host\u0000p7", { machineId: "host", threadId: "p7", schema: disk.TRANSCRIPT_SCHEMA, lastSeq: 5, bytes: 10, usedAt: 1, body: JSON.stringify(disk.savedThread(state("p7", 5, "Cached answer"))) });
  runtime.setTranscriptStore(store);
  t.after(() => { unsubscribers.forEach((fn) => fn()); runtime.connect(null); runtime.resetMachineHub(); globalThis.WebSocket = previousSocket; });
  await runtime.boot();
  const host = sockets[0];
  host.open(); await settle();
  host.reply(subscribes.shift(), { subscription_id: "all", head_seq: 40, replay_ready: true }); await settle();
  host.frame({ jsonrpc: "2.0", method: "events.ready", params: { subscription_id: "all", head_seq: 40 } }); await settle();

  // The first list is bounded per project and remembers what it left out.
  const firstList = host.sent.find((r) => r.method === "threads.list");
  assert.equal(firstList.params.settled_limit, 25);
  assert.equal(firstList.params.since_seq, undefined);
  assert.equal(runtime.omittedThreads("project"), 30);
  const before = runtime.getState().threads;

  // Prefetch: the top six rows at most, two at a time.
  runtime.prefetchThreads(before);
  await settle();
  assert.equal(gets.length, 2, "two first pages in flight");
  assert.ok(gets.every((g) => g.params.page_budget?.turns === 10 && g.params.transcript_limit === 60), "first pages by budget, with the old daemons' limit");
  for (let round = 0; round < 6 && gets.length; round++) {
    for (const request of gets.splice(0)) host.reply(request, page(request.params.thread_id, 3));
    await settle();
  }
  const fetched = host.sent.filter((r) => r.method === "threads.get").map((r) => r.params.thread_id);
  assert.equal(fetched.length, 6, "bounded to the top six rows");
  assert.equal(fetched.includes("p7"), false);
  assert.ok(runtime.isThreadCached(fetched[0]));

  // Opening the cached thread: its copy is there before the machine answers, with no first-page read.
  runtime.useThread("p7");
  await settle();
  const shown = runtime.useThread("p7");
  assert.equal(shown.loaded, true);
  assert.equal(shown.blocks[0].text, "Cached answer");
  const getsBefore = host.sent.filter((r) => r.method === "threads.get").length;
  const opening = runtime.ensureThread("p7");
  await settle();
  const resume = subscribes.shift();
  assert.equal(resume.params.thread_id, "p7");
  assert.equal(resume.params.after_seq, 5, "resumes from the cached cursor");
  assert.equal(resume.params.gap_snapshot.page_budget.turns, 10, "a big gap comes back as a first page");
  // A live event of the main stream arrives meanwhile: it waits for the catch-up.
  host.frame({ jsonrpc: "2.0", method: "event", params: { subscription_id: "all", event: { thread_id: "p7", turn_id: "turn", at: "", seq: 52, kind: "assistant_text_delta", message_id: "m2", origin: { kind: "root" }, delta: "Live" } } });
  await settle();
  host.reply(resume, { subscription_id: "one", head_seq: 50, replay_ready: true, snapshot: page("p7", 50, "Gap snapshot") });
  await settle();
  host.frame({ jsonrpc: "2.0", method: "events.ready", params: { subscription_id: "one", head_seq: 50 } });
  await opening;
  await new Promise((resolve) => setTimeout(resolve, 40));
  const caught = runtime.useThread("p7");
  assert.equal(caught.lastSeq, 52, "the event received during the catch-up was replayed after it");
  assert.equal(caught.blocks[0].text, "Gap snapshot");
  assert.equal(host.sent.filter((r) => r.method === "threads.get").length, getsBefore, "no threads.get for a resumed thread");
  assert.ok(host.sent.some((r) => r.method === "events.unsubscribe" && r.params.subscription_id === "one"), "the catch-up subscription closes");

  // Activity: only rows changed since the cursor come back, and unchanged rows keep their objects.
  changed = [thread("a", 4, { status: "running" })];
  listHead = 60;
  host.frame({ jsonrpc: "2.0", method: "event", params: { subscription_id: "all", event: { thread_id: "a", turn_id: "t", at: "", seq: 61, kind: "approval_resolved", approval_id: "x", decision: "allow_once" } } });
  await new Promise((resolve) => setTimeout(resolve, 200));
  await settle();
  const cursorRead = host.sent.filter((r) => r.method === "threads.list").at(-1);
  assert.equal(cursorRead.params.since_seq, 40);
  const after = runtime.getState().threads;
  assert.equal(after.find((x) => x.id === "a").status, "running");
  assert.equal(after.find((x) => x.id === "c"), before.find((x) => x.id === "c"), "an unchanged row is the same object");

  // "Show more" pages older settled threads of a project in.
  await Promise.race([runtime.loadMoreThreads("project"), settle()]);
  const more = host.sent.filter((r) => r.method === "threads.list").at(-1);
  assert.equal(more.params.project_id, "project");
  assert.equal(typeof more.params.settled_offset, "number");
});

test("a daemon without list cursors gets the whole list every time", async () => {
  const { applyThreadList, refreshParams } = await import("../../../packages/kybern-client/src/threadListCursor.ts");
  const first = applyThreadList(undefined, refreshParams(undefined), { threads: [thread("a")] });
  assert.equal(first.headSeq, undefined);
  assert.equal(refreshParams(first, { include_archived: true }).since_seq, undefined);
});
