import assert from "node:assert/strict"
import test from "node:test"

import {
  daysUntilPurge,
  editedLabel,
  exportFileName,
  groupNotes,
  noteMarkdown,
  noteScopeLabel,
  projectsToShow,
  purgeLabel,
  resolveNewNoteHome,
  searchNotes,
  splitMatches,
} from "./src/state/notesModel.ts"
import { ageLabel, dateBucket, editedAgo, filterChoices, filterNotes, gallerySections } from "./src/state/notesModel.ts"
import { countWords, miniMarkdown, parseInline, wordCountLabel } from "./src/state/miniMarkdown.ts"
import { filterSlashItems } from "./src/views/notes/slashItems.ts"
import { normalizeLinkTarget } from "./src/views/notes/linkTarget.ts"
import { tidyMarkdown } from "./src/views/notes/tidyMarkdown.ts"

const FREE = "00000000-0000-0000-0000-000000000001"
const note = (id, extra = {}) => ({
  id,
  scope: "global",
  project_id: null,
  thread_id: null,
  title: id,
  preview: "",
  checklist: { done: 0, total: 0 },
  pinned: false,
  revision: 1,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
  deleted_at: null,
  origin: null,
  ...extra,
})
const projects = { a: { id: "a", name: "Alpha" }, b: { id: "b", name: "Beta" }, [FREE]: { id: FREE, name: "Chats" } }

test("notes group into pinned, global, projects, chats and deleted", () => {
  const notes = [
    note("g1", { updated_at: "2026-10-02T00:00:00Z" }),
    note("g2"),
    note("p1", { scope: "project", project_id: "a", pinned: true }),
    note("p2", { scope: "project", project_id: "a" }),
    note("t1", { scope: "thread", project_id: "a", thread_id: "t1", preview: "text" }),
    note("t-empty", { scope: "thread", project_id: "a", thread_id: "t2" }),
    note("c1", { scope: "thread", project_id: FREE, thread_id: "t3", preview: "chat text" }),
    note("d1", { deleted_at: "2026-10-03T00:00:00Z" }),
  ]
  const groups = groupNotes(notes, projects, [])
  assert.deepEqual(groups.pinned.map((n) => n.id), ["p1"])
  assert.deepEqual(groups.global.map((n) => n.id), ["g1", "g2"])
  assert.deepEqual(groups.projects.map((p) => p.project.id), ["a", "b"])
  assert.deepEqual(groups.projects[0].pages.map((n) => n.id), ["p2"])
  assert.deepEqual(groups.projects[0].threadNotes.map((n) => n.id), ["t1"])
  assert.equal(groups.projects[1].pages.length, 0)
  assert.deepEqual(groups.chats.map((n) => n.id), ["c1"])
  assert.deepEqual(groups.deleted.map((n) => n.id), ["d1"])
})

test("projects follow the sidebar order", () => {
  const groups = groupNotes([], projects, ["b", "a"])
  assert.deepEqual(groups.projects.map((p) => p.project.id), ["b", "a"])
})

test("search finds titles, previews and daemon body hits, never deleted notes", () => {
  const notes = [
    note("one", { title: "Release plan" }),
    note("two", { title: "Groceries", preview: "buy plans" }),
    note("three", { title: "Other" }),
    note("four", { title: "Release gone", deleted_at: "2026-10-03T00:00:00Z" }),
  ]
  const hits = searchNotes(notes, "plan", new Map([["three", "…a plan in the body…"]]))
  assert.deepEqual(hits.map((h) => h.note.id).sort(), ["one", "three", "two"])
  assert.equal(hits.find((h) => h.note.id === "three").snippet, "…a plan in the body…")
  assert.equal(hits.find((h) => h.note.id === "one").snippet, null)
})

test("new notes go where the user is working", () => {
  const base = { focus: null, openNote: null, contextProjectId: null, projects }
  assert.deepEqual(resolveNewNoteHome(base), { scope: "global" })
  assert.deepEqual(resolveNewNoteHome({ ...base, contextProjectId: "a" }), { scope: "project", projectId: "a" })
  assert.deepEqual(resolveNewNoteHome({ ...base, contextProjectId: FREE }), { scope: "global" })
  assert.deepEqual(resolveNewNoteHome({ ...base, contextProjectId: "gone" }), { scope: "global" })
  assert.deepEqual(resolveNewNoteHome({ ...base, contextProjectId: "a", focus: { kind: "global" } }), { scope: "global" })
  assert.deepEqual(resolveNewNoteHome({ ...base, focus: { kind: "project", projectId: "b" } }), { scope: "project", projectId: "b" })
  assert.deepEqual(resolveNewNoteHome({ ...base, openNote: { scope: "thread", project_id: "a" } }), { scope: "project", projectId: "a" })
  assert.deepEqual(resolveNewNoteHome({ ...base, openNote: { scope: "global", project_id: null }, contextProjectId: "a" }), { scope: "global" })
})

test("scope labels name where a note lives", () => {
  const threads = { t1: { title: "Fix login" } }
  assert.equal(noteScopeLabel(note("g"), projects, threads), "Global")
  assert.equal(noteScopeLabel(note("p", { scope: "project", project_id: "a" }), projects, threads), "Alpha")
  assert.equal(noteScopeLabel(note("t", { scope: "thread", project_id: "a", thread_id: "t1", title: "Fix login" }), projects, threads), "Alpha › Fix login")
  assert.equal(noteScopeLabel(note("c", { scope: "thread", project_id: FREE, thread_id: "t1" }), projects, threads), "Fix login")
})

test("deleted notes count down their retention", () => {
  const deleted = "2026-10-01T00:00:00Z"
  assert.equal(daysUntilPurge(deleted, Date.parse("2026-10-01T12:00:00Z")), 30)
  assert.equal(daysUntilPurge(deleted, Date.parse("2026-10-30T12:00:00Z")), 1)
  assert.equal(daysUntilPurge(deleted, Date.parse("2026-12-01T00:00:00Z")), 0)
  // Right after deleting it is 30 days, even when clocks disagree by a few hours.
  assert.equal(daysUntilPurge(deleted, Date.parse("2026-10-01T00:00:00Z")), 30)
  assert.equal(daysUntilPurge(deleted, Date.parse("2026-09-30T20:00:00Z")), 30)
})

test("the purge countdown says today, tomorrow, then days", () => {
  const deleted = "2026-10-01T00:00:00Z"
  assert.equal(purgeLabel(deleted, Date.parse("2026-10-01T00:00:00Z")), "Deleted forever in 30 days")
  assert.equal(purgeLabel(deleted, Date.parse("2026-10-20T00:00:00Z")), "Deleted forever in 11 days")
  assert.equal(purgeLabel(deleted, Date.parse("2026-10-29T12:00:00Z")), "Deleted forever tomorrow")
  assert.equal(purgeLabel(deleted, Date.parse("2026-10-30T12:00:00Z")), "Deleted forever today")
})

test("exports get safe names and a heading", () => {
  assert.equal(exportFileName("Plan: Q4/Q1"), "Plan- Q4-Q1.md")
  assert.equal(exportFileName("  "), "Untitled.md")
  assert.equal(noteMarkdown("Plan", "- a\n"), "# Plan\n\n- a\n")
  assert.equal(noteMarkdown("", "body\n"), "body\n")
})

test("the slash menu matches titles first, then keywords", () => {
  assert.equal(filterSlashItems("").length, 10)
  assert.deepEqual(filterSlashItems("head").map((i) => i.id), ["h1", "h2", "h3"])
  assert.equal(filterSlashItems("todo")[0].id, "checklist")
  assert.equal(filterSlashItems("h2")[0].id, "h2")
  assert.equal(filterSlashItems("code")[0].id, "code")
  assert.equal(filterSlashItems("zzz").length, 0)
})

test("pasted link addresses gain a scheme only when they lack one", () => {
  assert.equal(normalizeLinkTarget(" example.com "), "https://example.com")
  assert.equal(normalizeLinkTarget("http://a.b"), "http://a.b")
  assert.equal(normalizeLinkTarget("kybern://thread/x"), "kybern://thread/x")
  assert.equal(normalizeLinkTarget("mailto:a@b.c"), "mailto:a@b.c")
  assert.equal(normalizeLinkTarget("  "), "")
})

test("serializer entities become plain characters, except where they would change meaning", () => {
  assert.equal(tidyMarkdown("a &gt; b &amp; c &lt; d"), "a > b & c < d")
  assert.equal(tidyMarkdown("&gt; not a quote"), "&gt; not a quote")
  assert.equal(tidyMarkdown("x\n  &gt; indented"), "x\n  &gt; indented")
  assert.equal(tidyMarkdown("&lt;b&gt;tag&lt;/b&gt;"), "&lt;b>tag&lt;/b>")
  assert.equal(tidyMarkdown("fish &amp;amp; chips &amp;copy;"), "fish &amp;amp; chips &amp;copy;")
  assert.equal(tidyMarkdown("`&gt;` and &gt;\n\n```\n&amp; &gt;\n```\n"), "`&gt;` and >\n\n```\n&amp; &gt;\n```\n")
})

test("Save to note quotes every line and links the thread", async () => {
  const { blockquote, savedMessageMarkdown, threadLink, titleFromText } = await import("./src/state/notesModel.ts")
  assert.equal(blockquote("one\n\ntwo  \n- three"), "> one\n>\n> two\n> - three")
  assert.equal(threadLink("Fix [auth]\nbug", "11111111-1111-1111-1111-111111111111"), "[From Fix \\[auth\\] bug](kybern://thread/11111111-1111-1111-1111-111111111111)")
  assert.equal(threadLink("  ", "t"), "[From Untitled thread](kybern://thread/t)")
  assert.equal(savedMessageMarkdown("hi", "T", "id"), "> hi\n\n[From T](kybern://thread/id)")
  assert.equal(titleFromText("\n## **Plan** for [docs](http://x)\nmore"), "Plan for docs")
  assert.equal(titleFromText("- [ ] " + "a".repeat(80)).length, 60)
  assert.equal(titleFromText("   "), "")
})

test("only projects with notes, or being looked at, get a section", () => {
  const entries = [
    { project: { id: "a", name: "A" }, pages: [note("p")], threadNotes: [] },
    { project: { id: "b", name: "B" }, pages: [], threadNotes: [] },
    { project: { id: "c", name: "C" }, pages: [], threadNotes: [note("t")] },
    { project: { id: "d", name: "D" }, pages: [], threadNotes: [] },
  ]
  assert.deepEqual(projectsToShow(entries, []).map((e) => e.project.id), ["a", "c"])
  assert.deepEqual(projectsToShow(entries, ["d", null]).map((e) => e.project.id), ["a", "c", "d"])
})

test("edited labels read as sentences", () => {
  assert.equal(editedLabel("now"), "Edited just now")
  assert.equal(editedLabel("5m"), "Edited 5m ago")
  assert.equal(editedLabel("2w"), "Edited 2w ago")
  assert.equal(editedLabel("Oct 3"), "Edited Oct 3")
  assert.equal(editedLabel(""), "")
})

test("search matches are picked out, ignoring case", () => {
  assert.deepEqual(splitMatches("Release plan, Plans", "plan"), [
    { text: "Release ", match: false },
    { text: "plan", match: true },
    { text: ", ", match: false },
    { text: "Plan", match: true },
    { text: "s", match: false },
  ])
  assert.deepEqual(splitMatches("nothing", "zz"), [{ text: "nothing", match: false }])
  assert.deepEqual(splitMatches("text", "  "), [{ text: "text", match: false }])
})

test("every slash block shows the Markdown that makes it, except plain text", () => {
  const items = filterSlashItems("")
  assert.deepEqual(items.map((i) => i.shortcut), ["", "#", "##", "###", "-", "1.", "[ ]", ">", "```", "---"])
})

test("thumbnails read the first blocks of a note and stop at the line budget", () => {
  const doc = miniMarkdown("Intro with `code` and **bold** [a link](https://x.y).\n\n## Before tagging\n\n- [x] Done thing\n- [ ] Open thing\n\n```sh\ncargo build\n```\n\n> Quoted\n")
  assert.deepEqual(doc.blocks.map((b) => b.kind), ["paragraph", "heading", "checklist", "code", "quote"])
  assert.deepEqual(doc.blocks[0].spans, [{ text: "Intro with " }, { text: "code", code: true }, { text: " and " }, { text: "bold", strong: true }, { text: " a link." }])
  assert.deepEqual(doc.blocks[2].items.map((i) => i.done), [true, false])
  assert.deepEqual(doc.blocks[3].lines, ["cargo build"])
  const long = Array.from({ length: 500 }, (_, i) => `- [ ] item ${i}`).join("\n")
  const capped = miniMarkdown(long)
  assert.equal(capped.blocks[0].items.length, 14)
  assert.equal(capped.lines, 14)
  assert.equal(miniMarkdown("Short.").lines, 1)
  assert.deepEqual(miniMarkdown("").blocks, [])
})

test("inline markup keeps snake_case words and task keys", () => {
  assert.equal(parseInline("use snake_case_name here").map((s) => s.text).join(""), "use snake_case_name here")
  assert.equal(parseInline("Migrate [ADE-14](kybern://task/abc) _now_").map((s) => s.text).join(""), "Migrate ADE-14 now")
  const id = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"
  assert.deepEqual(parseInline(`Migrate **SDK** [ADE-14](kybern://task/${id}) now`), [
    { text: "Migrate " },
    { text: "SDK", strong: true },
    { text: " " },
    { text: "ADE-14", task: id },
    { text: " now" },
  ])
})

test("word counts and reading time", () => {
  assert.equal(countWords("Don’t ship the banner — yet, ok?"), 6)
  assert.equal(wordCountLabel(0), "")
  assert.equal(wordCountLabel(1), "1 word · 1 min read")
  assert.equal(wordCountLabel(1234), "1,234 words · 5 min read")
})

test("gallery ages, date groups and edited labels", () => {
  const now = Date.parse("2026-10-05T12:00:00")
  const at = (h) => new Date(now - h * 3_600_000).toISOString()
  assert.equal(ageLabel(at(0), now), "Just now")
  assert.equal(ageLabel(new Date(now - 120_000).toISOString(), now), "2 min ago")
  assert.equal(ageLabel(at(1), now), "1 hour ago")
  assert.equal(ageLabel(at(30), now), "Yesterday")
  assert.equal(editedAgo(at(30), now), "Edited yesterday")
  assert.equal(dateBucket(at(2), now), "Today")
  assert.equal(dateBucket(at(24 * 4), now), "Previous 7 days")
  assert.equal(dateBucket(at(24 * 20), now), "Previous 30 days")
  assert.match(editedAgo(at(24 * 90), now), /^Edited on [A-Z][a-z]{2} \d+$/)
})

test("gallery filters and sections", () => {
  const notes = [
    note("g1", { updated_at: "2026-10-05T10:00:00Z" }),
    note("p1", { scope: "project", project_id: "P", pinned: true, updated_at: "2026-10-05T09:00:00Z" }),
    note("t1", { scope: "thread", project_id: "P", thread_id: "T", preview: "x", updated_at: "2026-10-05T08:00:00Z" }),
    note("t0", { scope: "thread", project_id: "P", thread_id: "U" }),
    note("d1", { deleted_at: "2026-10-04T00:00:00Z" }),
  ]
  assert.deepEqual(filterNotes(notes, { kind: "all" }).map((n) => n.id), ["g1", "p1", "t1"])
  assert.deepEqual(filterNotes(notes, { kind: "project", projectId: "P" }).map((n) => n.id), ["p1", "t1"])
  assert.deepEqual(filterNotes(notes, { kind: "threads" }).map((n) => n.id), ["t1"])
  assert.deepEqual(filterNotes(notes, { kind: "deleted" }).map((n) => n.id), ["d1"])
  const projects = { P: { id: "P", name: "ade" } }
  const sections = gallerySections(filterNotes(notes, { kind: "all" }), { group: "none", sort: "edited", projects, projectOrder: ["P"] })
  assert.deepEqual(sections.map((s) => [s.label, s.notes.map((n) => n.id)]), [["Pinned", ["p1"]], ["Recent", ["g1", "t1"]]])
  const byProject = gallerySections(filterNotes(notes, { kind: "all" }), { group: "project", sort: "title", projects, projectOrder: ["P"] })
  assert.deepEqual(byProject.map((s) => s.label), ["Pinned", "Global", "ade"])
  assert.deepEqual(gallerySections([], { group: "none", sort: "edited", projects, projectOrder: [] }), [])
  const choices = filterChoices(notes, projects, ["P"])
  assert.deepEqual([choices.projects.map((p) => p.id), choices.threads, choices.deleted], [["P"], 1, 1])
})
