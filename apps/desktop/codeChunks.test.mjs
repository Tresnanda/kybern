import assert from "node:assert/strict"
import test from "node:test"
import { chunkHighlightedHtml, chunkPlainCode } from "./src/lib/codeChunks.ts"

const line = (i) => `<span class="line"><span style="color:#fff">line ${i}</span></span>`
const html = (n) => `<pre class="shiki" style="color:#fff" tabindex="0"><code>${Array.from({ length: n }, (_, i) => line(i)).join("\n")}</code></pre>`
const textOf = (markup) => markup.replace(/<[^>]+>/g, "")

test("short highlighted blocks are returned unchanged", () => {
  assert.equal(chunkHighlightedHtml(html(40), 40), html(40))
  assert.equal(chunkPlainCode("a\nb\nc", 40), null)
})

test("chunks keep every line and newline and wrap only the code contents", () => {
  const source = html(95)
  const chunked = chunkHighlightedHtml(source, 40)
  assert.equal(textOf(chunked), textOf(source))
  assert.equal((chunked.match(/<span class="chat-code-chunk">/g) ?? []).length, 3)
  assert.ok(chunked.startsWith('<pre class="shiki" style="color:#fff" tabindex="0"><code><span class="chat-code-chunk">'))
  assert.ok(chunked.endsWith("</span></code></pre>"))
  assert.ok(!chunked.includes("</span>\n<span class=\"chat-code-chunk\">"), "newlines stay inside the chunk that precedes them")
  assert.ok(!chunked.includes("\n</span></code>"), "the final chunk has no trailing newline")
})

test("plain chunks concatenate back to the source", () => {
  const code = Array.from({ length: 101 }, (_, i) => `row ${i}`).join("\n") + "\n"
  const chunks = chunkPlainCode(code, 40)
  assert.equal(chunks.length, 3)
  assert.equal(chunks.join(""), code)
  assert.ok(chunks.slice(0, -1).every((chunk) => chunk.endsWith("\n")))
})
