// Images in notes: the Markdown round trip of `![alt](kybern://asset/<id>)` (and web
// images) through the note editor's schema, and the escaping of each part.
import assert from "node:assert/strict"
import test from "node:test"

import { getSchema } from "@tiptap/core"
import { MarkdownManager } from "@tiptap/markdown"
import StarterKit from "@tiptap/starter-kit"
import { TaskItem, TaskList } from "@tiptap/extension-list"

import { assetLinkId, createNoteImage, imageMarkdown } from "./src/views/notes/noteImage.ts"
import { createTaskRef } from "./src/views/notes/taskRef.ts"

const ID = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"

const extensions = () => [
  StarterKit.configure({ heading: { levels: [1, 2, 3] }, underline: false, link: { protocols: ["kybern"] } }),
  TaskList,
  TaskItem.configure({ nested: true }),
  createTaskRef(),
  createNoteImage(),
]
const schema = getSchema(extensions())

function manager() {
  return new MarkdownManager({ extensions: extensions() })
}

/** Parsed Markdown the editor can actually hold: throws when the schema rejects it. */
const valid = (json) => schema.nodeFromJSON(json).check()

const images = (node, found = []) => {
  if (node.type === "image") found.push(node.attrs)
  for (const child of node.content ?? []) images(child, found)
  return found
}

test("note images round-trip through the editor's Markdown unchanged", () => {
  const md = manager()
  const source = [
    "# Screens",
    "",
    `![](kybern://asset/${ID})`,
    "",
    "Before ![the old card](https://example.com/card.png \"Old\") and after.",
    "",
    "A [link](https://example.com) stays a link.",
  ].join("\n")
  const doc = md.parse(source)
  valid(doc)
  // A line holding only an image stays a paragraph around it.
  assert.deepEqual(doc.content[1].type, "paragraph")
  assert.deepEqual(
    images(doc).map((attrs) => [attrs.src, attrs.alt, attrs.title]),
    [
      [`kybern://asset/${ID}`, "", null],
      ["https://example.com/card.png", "the old card", "Old"],
    ],
  )
  assert.equal(md.serialize(doc), source)
})

test("image Markdown escapes what would end each part", () => {
  assert.equal(imageMarkdown(`kybern://asset/${ID}`), `![](kybern://asset/${ID})`)
  assert.equal(imageMarkdown("https://x.dev/a b.png", "a [b]", 'say "hi"'), '![a \\[b\\]](<https://x.dev/a b.png> "say \\"hi\\"")')
  const md = manager()
  const tricky = imageMarkdown("https://x.dev/a (1).png", "one ] two")
  valid(md.parse(tricky))
  assert.deepEqual(images(md.parse(tricky)).map((attrs) => [attrs.src, attrs.alt]), [["https://x.dev/a (1).png", "one ] two"]])
})

test("asset links name their asset; other sources do not", () => {
  assert.equal(assetLinkId(`kybern://asset/${ID.toUpperCase()}`), ID)
  assert.equal(assetLinkId(`kybern://asset/${ID}/`), ID)
  assert.equal(assetLinkId("https://example.com/a.png"), null)
  assert.equal(assetLinkId("kybern://asset/nope"), null)
  assert.equal(assetLinkId(null), null)
})
