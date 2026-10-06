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
const model = await import("../src/state/notesModel.ts");
const { NoteSession, noteDrafts } = await import("../src/state/noteSession.ts");
const store = await import("../src/state/notes.ts");

const summary = (id, patch = {}) => ({
  id,
  scope: "global",
  title: id,
  preview: "",
  checklist: { done: 0, total: 0 },
  pinned: false,
  revision: 1,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
  ...patch,
});
const full = (id, patch = {}) => ({ ...summary(id), body: "", ...patch });
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("notes sort pinned first then newest, and folding keeps the newest row", () => {
  const list = model.sortNotes([
    summary("old", { updated_at: "2026-10-01T00:00:00Z" }),
    summary("new", { updated_at: "2026-10-03T00:00:00Z" }),
    summary("pin", { pinned: true, updated_at: "2026-09-01T00:00:00Z" }),
  ]);
  assert.deepEqual(list.map((n) => n.id), ["pin", "new", "old"]);
  const edited = model.applyNoteChange(list, { note: summary("old", { revision: 2, updated_at: "2026-10-05T00:00:00Z" }) });
  assert.deepEqual(edited.map((n) => n.id), ["pin", "old", "new"]);
  assert.equal(model.applyNoteChange(edited, { note: summary("old", { revision: 1 }) }), edited, "late older notification is ignored");
  assert.deepEqual(model.applyNoteChange(edited, { purged_id: "new" }).map((n) => n.id), ["pin", "old"]);
});

test("groups follow the list sections and show a pinned note once", () => {
  const notes = [
    summary("pinned-thread", { scope: "thread", project_id: "p1", pinned: true }),
    summary("g1"),
    summary("pn", { scope: "project", project_id: "p1" }),
    summary("tn", { scope: "thread", project_id: "p1", thread_id: "t" }),
    summary("chat", { scope: "thread", project_id: "free", thread_id: "c" }),
    summary("gone", { deleted_at: "2026-10-04T00:00:00Z", origin: "kybern" }),
  ];
  const g = model.groupNotes(notes, [{ id: "p1", name: "kybern" }], (id) => id === "free");
  assert.deepEqual(g.pinned.map((n) => n.id), ["pinned-thread"]);
  assert.deepEqual(g.global.map((n) => n.id), ["g1"]);
  assert.equal(g.projects.length, 1);
  assert.deepEqual(g.projects[0].notes.map((n) => n.id), ["pn"]);
  assert.deepEqual(g.projects[0].threadNotes.map((n) => n.id), ["tn"]);
  assert.deepEqual(g.chats.map((n) => n.id), ["chat"]);
  assert.deepEqual(g.deleted.map((n) => n.id), ["gone"]);
});

test("search matches titles and previews locally and adds body hits", () => {
  const notes = [
    summary("a", { title: "Release plan" }),
    summary("b", { preview: "ship the release" }),
    summary("c", { title: "Groceries" }),
    summary("d", { title: "Misc", deleted_at: "2026-10-04T00:00:00Z" }),
  ];
  const { notes: found, snippets } = model.filterNotes(notes, " release ", [
    { id: "c", snippet: "…release milk…" },
    { id: "d", snippet: "…release…" },
    { id: "a", snippet: "…release…" },
  ]);
  assert.deepEqual(found.map((n) => n.id), ["a", "b", "c"]);
  assert.equal(snippets.get("c"), "…release milk…");
  assert.equal(snippets.has("a"), false);
  assert.equal(model.filterNotes(notes, "").notes, notes);
});

test("badges, titles, markdown and retention read plainly", () => {
  assert.equal(model.checklistBadge({ checklist: { done: 3, total: 7 } }), "3/7");
  assert.equal(model.checklistBadge({ checklist: { done: 0, total: 0 } }), "");
  assert.equal(model.noteTitle({ title: "  " }), "Untitled");
  assert.equal(model.noteMarkdown("Plan", "- [ ] one"), "# Plan\n\n- [ ] one\n");
  assert.equal(model.noteMarkdown("", "text"), "text");
  assert.equal(model.daysLeft("2026-10-01T00:00:00Z", Date.parse("2026-10-11T12:00:00Z")), 20);
  assert.equal(model.daysLeft("2026-08-01T00:00:00Z", Date.parse("2026-10-11T12:00:00Z")), 0);
});

function fakeDaemon(initial = full("n1", { body: "hello", revision: 3 })) {
  const calls = [];
  let current = initial;
  const listeners = new Set();
  const daemon = {
    calls,
    failNext: null,
    set(note) { current = note; },
    change(change) { listeners.forEach((fn) => fn(change)); },
    deps: {
      scope: "test",
      subscribeChanges: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
      async call(method, params) {
        calls.push({ method, params });
        if (daemon.failNext) { const e = daemon.failNext; daemon.failNext = null; throw e; }
        if (method === "notes.get") return { note: current };
        if (method === "notes.update") {
          if (params.expected_revision !== current.revision) throw Object.assign(new Error("conflict"), { code: -32004 });
          current = { ...current, ...(params.title !== undefined ? { title: params.title } : {}), body: params.body, revision: current.revision + 1 };
          return current;
        }
        if (method === "notes.create") { current = full("created", { title: params.title, body: params.body, scope: params.scope, project_id: params.project_id, revision: 1 }); return current; }
        throw new Error(`unexpected ${method}`);
      },
    },
  };
  return daemon;
}

test("autosave waits for typing to pause, then saves against the loaded revision", async (t) => {
  noteDrafts.clear();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const daemon = fakeDaemon();
  const session = new NoteSession({ kind: "id", id: "n1" }, daemon.deps);
  await session.sync();
  assert.equal(session.getSnapshot().body, "hello");
  session.setBody("hello w");
  t.mock.timers.tick(400);
  session.setBody("hello world");
  t.mock.timers.tick(400);
  assert.equal(daemon.calls.filter((c) => c.method === "notes.update").length, 0, "typing restarts the timer");
  assert.equal(session.getSnapshot().status, "dirty");
  t.mock.timers.tick(300);
  await tick();
  const update = daemon.calls.find((c) => c.method === "notes.update");
  assert.equal(update.params.expected_revision, 3);
  assert.equal(update.params.body, "hello world");
  const snap = session.getSnapshot();
  assert.equal(snap.status, "saved");
  assert.equal(snap.dirty, false);
  assert.equal(noteDrafts.size, 0);
});

test("a revision conflict keeps the draft until the reader chooses", async () => {
  noteDrafts.clear();
  const daemon = fakeDaemon();
  const session = new NoteSession({ kind: "id", id: "n1" }, daemon.deps);
  await session.sync();
  daemon.set(full("n1", { body: "theirs", revision: 4 }));
  session.setBody("mine");
  await session.flush();
  let snap = session.getSnapshot();
  assert.equal(snap.conflict, true);
  assert.equal(snap.status, "conflict");
  assert.equal(snap.body, "mine", "the draft is not lost");
  await session.keepMine();
  snap = session.getSnapshot();
  assert.equal(snap.conflict, false);
  assert.equal(snap.status, "saved");
  assert.equal(daemon.calls.filter((c) => c.method === "notes.update").at(-1).params.expected_revision, 4);

  daemon.set(full("n1", { body: "theirs again", revision: 9 }));
  session.setBody("mine again");
  await session.flush();
  assert.equal(session.getSnapshot().conflict, true);
  await session.loadTheirs();
  snap = session.getSnapshot();
  assert.equal(snap.body, "theirs again");
  assert.equal(snap.dirty, false);
  assert.equal(snap.conflict, false);
  assert.equal(noteDrafts.size, 0);
});

test("a failed save keeps the text and retries on request", async () => {
  noteDrafts.clear();
  const daemon = fakeDaemon();
  const session = new NoteSession({ kind: "id", id: "n1" }, daemon.deps);
  await session.sync();
  daemon.failNext = new Error("offline");
  session.setBody("kept");
  await session.flush();
  let snap = session.getSnapshot();
  assert.equal(snap.status, "error");
  assert.equal(snap.body, "kept");
  assert.equal(noteDrafts.size, 1, "draft survives leaving the screen");
  await session.retry();
  snap = session.getSnapshot();
  assert.equal(snap.status, "saved");
  assert.equal(snap.note.body, "kept");
});

test("an unsaved draft is restored on reopening and conflicts if the note moved on", async () => {
  noteDrafts.clear();
  const daemon = fakeDaemon();
  const first = new NoteSession({ kind: "id", id: "n1" }, daemon.deps);
  await first.sync();
  daemon.failNext = new Error("offline");
  first.setBody("draft text");
  await first.flush();
  daemon.set(full("n1", { body: "elsewhere", revision: 5 }));
  const second = new NoteSession({ kind: "id", id: "n1" }, daemon.deps);
  await second.sync();
  const snap = second.getSnapshot();
  assert.equal(snap.body, "draft text");
  assert.equal(snap.conflict, true);
});

test("a new note is created on the first non-empty save, never before", async () => {
  noteDrafts.clear();
  const daemon = fakeDaemon();
  const session = new NoteSession({ kind: "new", projectId: "p1" }, daemon.deps);
  assert.equal(session.getSnapshot().loaded, true);
  session.setBody("");
  await session.flush();
  assert.equal(daemon.calls.length, 0);
  session.setTitle("Plan");
  await session.flush();
  const create = daemon.calls.find((c) => c.method === "notes.create");
  assert.deepEqual({ scope: create.params.scope, project_id: create.params.project_id, title: create.params.title }, { scope: "project", project_id: "p1", title: "Plan" });
  session.setBody("- [ ] one");
  await session.flush();
  const update = daemon.calls.find((c) => c.method === "notes.update");
  assert.equal(update.params.id, "created");
  assert.equal(update.params.expected_revision, 1);
});

test("a thread note saves its text only, creating the note at revision 0", async () => {
  noteDrafts.clear();
  const daemon = fakeDaemon(null);
  const session = new NoteSession({ kind: "thread", threadId: "t1" }, daemon.deps);
  await session.sync();
  assert.equal(session.getSnapshot().note, null);
  daemon.set(full("thread-note", { scope: "thread", thread_id: "t1", title: "Fix login", revision: 0 }));
  session.setBody("remember this");
  await session.flush();
  const update = daemon.calls.find((c) => c.method === "notes.update");
  assert.deepEqual(update.params, { thread_id: "t1", expected_revision: 0, body: "remember this" });
});

test("another device's save refreshes a clean note", async () => {
  noteDrafts.clear();
  const daemon = fakeDaemon();
  const session = new NoteSession({ kind: "id", id: "n1" }, daemon.deps);
  session.attach();
  await session.sync();
  daemon.set(full("n1", { body: "from desktop", revision: 4 }));
  daemon.change({ note: summary("n1", { revision: 4 }) });
  await tick();
  assert.equal(session.getSnapshot().body, "from desktop");
  session.detach();
});

test("the notes list loads, follows notifications, offers undo, and ignores old daemons", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const handlers = new Map();
  let fail = null;
  const client = {
    onNotification(method, fn) { handlers.set(method, fn); return () => {}; },
    async call(method, params) {
      if (fail) throw fail;
      if (method === "notes.list") return { notes: [summary("a", { updated_at: "2026-10-01T00:00:00Z" })] };
      if (method === "notes.delete") return summary(params.id, { deleted_at: "2026-10-05T00:00:00Z", title: "Plan" });
      if (method === "notes.restore") return summary(params.id);
      throw new Error(method);
    },
  };
  store.resetNotes();
  store.attachNotes(client, () => true);
  await store.loadNotes();
  assert.equal(store.getNotes().loaded, true);
  assert.deepEqual(store.getNotes().notes.map((n) => n.id), ["a"]);
  handlers.get("notes.changed")({ note: summary("b", { updated_at: "2026-10-04T00:00:00Z" }) });
  assert.deepEqual(store.getNotes().notes.map((n) => n.id), ["b", "a"]);
  handlers.get("notes.changed")({ purged_id: "a" });
  assert.deepEqual(store.getNotes().notes.map((n) => n.id), ["b"]);
  await store.deleteNote("b");
  assert.equal(store.getNotes().undo.id, "b");
  assert.ok(store.getNotes().notes[0].deleted_at);
  t.mock.timers.tick(model.UNDO_MS + 10);
  assert.equal(store.getNotes().undo, null);
  await store.deleteNote("b");
  await store.restoreNote("b");
  assert.equal(store.getNotes().undo, null);
  assert.equal(store.getNotes().notes[0].deleted_at, undefined);

  store.resetNotes();
  assert.equal(store.getNotes().notes.length, 0, "switching computers clears notes");
  store.attachNotes(client, () => true);
  fail = Object.assign(new Error("Method not found"), { code: -32601 });
  await store.loadNotes();
  assert.equal(store.getNotes().unsupported, true);
  store.resetNotes();
});
