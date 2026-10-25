import test from "node:test";
import assert from "node:assert/strict";
import {
  builtAgo,
  changeRow,
  groupNotes,
  mapHead,
  monthDay,
  noteSnippet,
  staleSnippet,
  supersededDate,
  supersededLabel,
  supersededLines,
  undatedSnippet,
} from "../src/notesHistory.ts";

const note = (title, extra = {}) => ({ title, preview: `${title}  preview`, ...extra });

test("notes group by category in the index order, with undated last and empty groups left out", () => {
  const groups = groupNotes([
    note("a", { undated: true }),
    note("b", { category: "gotcha" }),
    note("c"),
    note("d", { category: "preference" }),
    note("e", { category: "gotcha" }),
  ]);
  assert.deepEqual(groups.map((g) => [g.label, g.notes.map((n) => n.title)]), [
    ["Preferences", ["d"]],
    ["Gotchas", ["b", "e"]],
    ["Other", ["c"]],
    ["Undated", ["a"]],
  ]);
});

test("a stale note names the file, an undated one the date categories began", () => {
  assert.equal(staleSnippet({ path: "src/auth/session.ts" }), "May be outdated · session.ts changed");
  assert.equal(undatedSnippet("2026-10-25"), "Undated, before Oct 25");
  assert.equal(undatedSnippet(null), "Undated");
  assert.deepEqual(noteSnippet(note("a", { stale: { path: "a/b.ts", commit: "f19b20c" } })), { kind: "stale", text: "May be outdated · b.ts changed" });
  assert.deepEqual(noteSnippet(note("a", { undated: true }), "2026-10-25"), { kind: "undated", text: "Undated, before Oct 25" });
  assert.deepEqual(noteSnippet(note("a", { category: "decision", undated: true })), { kind: "preview", text: "a preview" });
});

test("a retired claim is recognised by its date, outside fences", () => {
  assert.equal(supersededDate(" (superseded 2026-10-25)"), "2026-10-25");
  assert.equal(supersededDate("plain"), null);
  assert.equal(supersededLabel("2026-10-25"), "Superseded Oct 25");
  const body = "- new claim\n- ~~old claim `a.ts`~~ (superseded 2026-10-02)\n```\n~~in fence~~ (superseded 2026-10-03)\n```\n1. ~~numbered~~ (superseded 2026-10-04)";
  assert.deepEqual(supersededLines(body).map((l) => [l.line, l.text, l.date]), [
    [1, "old claim `a.ts`", "2026-10-02"],
    [5, "numbered", "2026-10-04"],
  ]);
});

test("the map is stamped with its first repository and aged in whole units", () => {
  assert.deepEqual(mapHead({ repos: [{ name: "lumen-web", head: "def5678abcdef", branch: "main" }] }), { repo: "lumen-web", sha: "def5678", branch: "main" });
  assert.equal(mapHead({ repos: [] }), null);
  const now = Date.parse("2026-10-25T12:00:00Z");
  assert.equal(builtAgo("2026-10-25T11:59:40Z", now), "just now");
  assert.equal(builtAgo("2026-10-25T11:58:00Z", now), "2 min ago");
  assert.equal(builtAgo("2026-10-25T09:00:00Z", now), "3 hours ago");
  assert.equal(builtAgo("2026-10-23T12:00:00Z", now), "2 days ago");
  assert.equal(monthDay("2026-10-26"), "Oct 26");
  assert.deepEqual(changeRow({ kind: "renamed", path: "supabase/client.ts", from: "src/lib/supabase.ts", commit: "0123456789", date: "2026-10-22" }), {
    status: "R",
    path: "src/lib/supabase.ts → supabase/client.ts",
    commit: "0123456",
    date: "Oct 22",
  });
  assert.equal(changeRow({ kind: "deleted", path: "a.ts", commit: "abcdefg1", date: "2026-10-25" }).status, "D");
});
