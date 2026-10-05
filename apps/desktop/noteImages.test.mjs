// Images in notes: the Markdown round trip of `![alt](kybern://asset/<id>)` (and web
// images) through the note editor's schema, and the escaping of each part.
import assert from "node:assert/strict"
import test from "node:test"

import { getSchema } from "@tiptap/core"
import { MarkdownManager } from "@tiptap/markdown"
import StarterKit from "@tiptap/starter-kit"
import { TaskItem, TaskList } from "@tiptap/extension-list"

import { assetLinkId, createNoteImage, dataUrlToFile, imageMarkdown, isDataImage, renderImageMarkdown } from "./src/views/notes/noteImage.ts"
import { filterSlashItems, slashItemsFor } from "./src/views/notes/slashItems.ts"
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

test("inline data: images become files to keep as assets", async () => {
  // A 1x1 transparent PNG, as a page or document puts it on the clipboard.
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
  const file = dataUrlToFile(png)
  assert.ok(file)
  assert.equal(file.type, "image/png")
  assert.equal(file.name, "pasted-image.png")
  const bytes = new Uint8Array(await file.arrayBuffer())
  assert.deepEqual([...bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47])

  const svg = dataUrlToFile("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E")
  assert.equal(svg?.type, "image/svg+xml")
  assert.equal(svg?.name, "pasted-image.svg")
  assert.equal(await svg?.text(), "<svg xmlns='http://www.w3.org/2000/svg'/>")
  assert.equal(dataUrlToFile("data:image/jpeg;base64,/9j/\n4AAQ")?.name, "pasted-image.jpg")

  assert.equal(dataUrlToFile("data:text/html,<b>hi</b>"), null)
  assert.equal(dataUrlToFile("data:image/png;base64,"), null)
  assert.equal(dataUrlToFile("data:image/png;base64,%%%"), null)
  assert.equal(dataUrlToFile(`kybern://asset/${ID}`), null)
  assert.equal(isDataImage(png), true)
  assert.equal(isDataImage("data:text/plain,x"), false)
  assert.equal(isDataImage("https://example.com/a.png"), false)
})

test("inline data: images are never written to the Markdown", () => {
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
  assert.equal(renderImageMarkdown({ src: png, alt: "pasted" }), "")
  assert.equal(renderImageMarkdown({ src: null }), "")
  assert.equal(renderImageMarkdown({ src: `kybern://asset/${ID}`, alt: "kept" }), `![kept](kybern://asset/${ID})`)

  // Through the editor's own serializer: the image is left out, the text around it stays.
  const md = manager()
  const doc = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Before" }] },
      { type: "paragraph", content: [{ type: "image", attrs: { src: png, alt: "pasted", title: null } }] },
      { type: "paragraph", content: [{ type: "image", attrs: { src: `kybern://asset/${ID}`, alt: "", title: null } }] },
      { type: "paragraph", content: [{ type: "text", text: "After" }] },
    ],
  }
  valid(doc)
  const out = md.serialize(doc)
  assert.ok(!out.includes("data:"), out)
  assert.ok(!out.includes("base64"), out)
  assert.ok(out.includes(`![](kybern://asset/${ID})`), out)
  assert.ok(out.includes("Before") && out.includes("After"), out)
  // A body that already holds one (written elsewhere) loses it on the next save rather than keeping the bytes.
  assert.ok(!md.serialize(md.parse(`Text ![x](${png}) more`)).includes("data:"))
})

test("the slash menu offers Image only where images can be kept", () => {
  assert.equal(filterSlashItems("image").length, 0)
  assert.equal(filterSlashItems("image", slashItemsFor(true))[0].id, "image")
  assert.equal(filterSlashItems("screenshot", slashItemsFor(true))[0].id, "image")
  assert.equal(slashItemsFor(false).some((item) => item.id === "image"), false)
})
