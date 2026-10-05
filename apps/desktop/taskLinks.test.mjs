// Task links in notes: the Markdown round trip of `[KEY](kybern://task/<id>)` through
// the note editor's schema, and the key patterns that autolink typed and pasted keys.
import assert from "node:assert/strict"
import test from "node:test"

import { MarkdownManager } from "@tiptap/markdown"
import StarterKit from "@tiptap/starter-kit"
import { TaskItem, TaskList } from "@tiptap/extension-list"

import { standaloneTaskKeys, taskLinkId, taskLinkMarkdown, typedTaskKey } from "./src/state/tasksModel.ts"
import { createTaskRef } from "./src/views/notes/taskRef.ts"
import { checklistLine, mergeNoteBodies } from "./src/state/noteLines.ts"

const ID = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"
const OTHER = "0199a1b2-c3d4-7e5f-8a9b-ffffffffffff"

function manager() {
  return new MarkdownManager({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] }, underline: false, link: { protocols: ["kybern"] } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      createTaskRef(),
    ],
  })
}

const refs = (node, found = []) => {
  if (node.type === "taskRef") found.push(node.attrs)
  for (const child of node.content ?? []) refs(child, found)
  return found
}

test("task links round-trip through the editor's Markdown unchanged", () => {
  const md = manager()
  const source = [
    "# Release",
    "",
    `The conflict banner can move to 0.6.1 [ADE-18](kybern://task/${ID}).`,
    "",
    `- [ ] Migrate new Cursor sessions to the native SDK [ADE-14](kybern://task/${ID})`,
    `- [x] Stop **SIGKILLing** Claude [ADE-15](kybern://task/${OTHER})`,
    "- [ ] Record the walkthrough",
    "",
    "A [link](https://example.com) stays a link.",
  ].join("\n")
  const doc = md.parse(source)
  assert.deepEqual(
    refs(doc).map((attrs) => [attrs.label, attrs.id]),
    [
      ["ADE-18", ID],
      ["ADE-14", ID],
      ["ADE-15", OTHER],
    ],
  )
  assert.equal(md.serialize(doc), source)
  // A second editor (a second manager) reads them the same way.
  assert.equal(manager().serialize(manager().parse(source)), source)
})

test("only kybern://task links become references", () => {
  const md = manager()
  const doc = md.parse(`[ADE-1](https://example.com) and [thread](kybern://thread/${ID}) and \`[ADE-2](kybern://task/${ID})\``)
  assert.equal(refs(doc).length, 0)
  const short = md.parse("[ADE-3](kybern://task/not-an-id)")
  assert.equal(refs(short).length, 0)
})

test("the label is kept as written", () => {
  const md = manager()
  const source = `- [ ] Ship it [old key](kybern://task/${ID})`
  assert.equal(refs(md.parse(source))[0].label, "old key")
  assert.equal(md.serialize(md.parse(source)), source)
})

test("task link helpers", () => {
  assert.equal(taskLinkId(`kybern://task/${ID}`), ID)
  assert.equal(taskLinkId(`kybern://task/${ID.toUpperCase()}/`), ID)
  assert.equal(taskLinkId(`kybern://thread/${ID}`), null)
  assert.equal(taskLinkId(null), null)
  assert.equal(taskLinkMarkdown("ADE-14", ID), `[ADE-14](kybern://task/${ID})`)
})

test("a typed key links when a space or punctuation follows it", () => {
  assert.deepEqual(typedTaskKey("see ADE-14 "), { key: "ADE-14", index: 4 })
  assert.deepEqual(typedTaskKey("ADE-14,"), { key: "ADE-14", index: 0 })
  assert.deepEqual(typedTaskKey("blocked (ADE-14)"), { key: "ADE-14", index: 9 })
  assert.deepEqual(typedTaskKey("“TSK2-3”"), { key: "TSK2-3", index: 1 })
  assert.deepEqual(typedTaskKey("done ADE-9."), { key: "ADE-9", index: 5 })
  // Not a finished key, not a standalone key, not a key at all.
  assert.equal(typedTaskKey("ADE-14"), null)
  assert.equal(typedTaskKey("ADE-14x "), null)
  assert.equal(typedTaskKey("ade-14 "), null)
  assert.equal(typedTaskKey("x/ADE-14 "), null)
  assert.equal(typedTaskKey("v2-ADE-14 "), null)
  assert.equal(typedTaskKey("XADE14 "), null)
  assert.equal(typedTaskKey("ADE-0 "), null)
  assert.equal(typedTaskKey("A-1 "), null)
  assert.equal(typedTaskKey("TOOLONG-1 "), null)
  assert.equal(typedTaskKey("ADE-14-2 "), null)
})

test("pasted text yields its standalone keys", () => {
  assert.deepEqual(standaloneTaskKeys("ADE-14 and (TSK-3), not ade-4, x/ADE-5 or ADE-6b; ADE-7."), [
    { key: "ADE-14", index: 0 },
    { key: "TSK-3", index: 12 },
    { key: "ADE-7", index: 50 },
  ])
  assert.deepEqual(standaloneTaskKeys("ADE-1\nADE-2"), [
    { key: "ADE-1", index: 0 },
    { key: "ADE-2", index: 6 },
  ])
})

test("a remote line edit merges into unsaved typing", () => {
  const base = "# Plan\n\n- [ ] Fix login\n- [ ] Ship\n"
  const theirs = `# Plan\n\n- [ ] Fix login [ADE-1](kybern://task/${ID})\n- [ ] Ship\n`
  const mine = "# Plan\n\nMore words.\n\n- [ ] Fix login\n- [ ] Ship it\n"
  assert.equal(mergeNoteBodies(base, mine, theirs), `# Plan\n\nMore words.\n\n- [ ] Fix login [ADE-1](kybern://task/${ID})\n- [ ] Ship it\n`)
  // Nothing typed: theirs as is.
  assert.equal(mergeNoteBodies(base, base, theirs), theirs)
  // Ticked on both sides: already agrees.
  const ticked = "- [x] Fix login\n"
  assert.equal(mergeNoteBodies("- [ ] Fix login\n", ticked, ticked), ticked)
})

test("a merge that would guess gives up", () => {
  const base = "- [ ] Fix\n- [ ] Fix\n"
  assert.equal(mergeNoteBodies(base, "- [ ] Fix\n- [ ] Fix\nmore\n", "- [x] Fix\n- [ ] Fix\n"), null)
  // The line they changed was also changed here.
  assert.equal(mergeNoteBodies("- [ ] Fix\n", "- [ ] Fix it\n", "- [x] Fix\n"), null)
  // They added or removed lines.
  assert.equal(mergeNoteBodies("a\n", "a\nb\n", "a\nc\nd\n"), null)
})

test("checklist lines are found the way the daemon reads them", () => {
  const md = ["- [ ] One", "  - [x] Nested **two**", "```", "- [ ] not this", "```", "1. [ ] Three  ", "- plain", "- [ ]"].join("\n")
  assert.equal(checklistLine(md, 0), "One")
  assert.equal(checklistLine(md, 1), "Nested **two**")
  assert.equal(checklistLine(md, 2), "Three")
  assert.equal(checklistLine(md, 3), "")
  assert.equal(checklistLine(md, 4), null)
})
