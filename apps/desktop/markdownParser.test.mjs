import assert from "node:assert/strict"
import { test } from "node:test"
import { registerHooks } from "node:module"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import ReactMarkdown, { defaultUrlTransform } from "react-markdown"
import remarkGfm from "remark-gfm"
import { toJsxRuntime } from "hast-util-to-jsx-runtime"
import { jsx, jsxs } from "react/jsx-runtime"
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith("./") && !/\.[a-z]+$/.test(specifier)) {
    try { return next(specifier + ".ts", context) } catch {}
  }
  return next(specifier, context)
} })
const { createMarkdownParser } = await import("./src/lib/markdownParser.ts")
const { imageSource } = await import("./src/lib/responseImages.ts")
const urlTransform = (url, key) => key === "src" ? (imageSource(url) ? url : "") : defaultUrlTransform(url)
const render = (result) => renderToStaticMarkup(toJsxRuntime({ type: "root", children: result.blocks.map(b => b.node) }, { Fragment: React.Fragment, jsx, jsxs }))
const expected = (source) => renderToStaticMarkup(React.createElement(ReactMarkdown, { children: source, remarkPlugins: [remarkGfm], urlTransform }))
const examples = [
  "# Heading\n\nFirst **bold** and _em_ 😀.\n\nSecond paragraph\n----\n\nFinal.",
  "- one\n  - nested\n\n    paragraph\n- two\n\nOutside\n\n> quote\n> continued\n\n---\n",
  "| A | B |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n\n```js\nconst x = 2\n```\n\n    indented\n    code\n",
  "Text [link][ref] and [^note].\n\n[ref]: https://example.com \"Title\"\n\n[^note]: footnote\n\n    continued\n",
  "<div>\n<p>raw</p>\n</div>\n\n<https://example.com> and www.example.com ~~strike~~\n\n![image](file:///tmp/image.png) [unsafe](javascript:alert%281%29)",
  "  first\r\n\r\n  - one\r\n\tcontinued\r\n\r\n  ```\r\n  code\r\n  ```\r\n",
  "- [ ] task\n- [x] done\n\n**open\n\nclose**\n\n[late]\n\n[late]: /path\n",
]
test("incremental Markdown matches the full renderer at every character prefix", () => {
  for (const source of examples) {
    const parser = createMarkdownParser()
    for (let end = 0; end <= source.length; end++) {
      const prefix = source.slice(0, end)
      assert.equal(render(parser.parse(prefix)), expected(prefix), JSON.stringify(prefix))
    }
  }
})
test("mixed appends and edits preserve full Markdown semantics", () => {
  let seed = 421
  const random = n => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n }
  for (let run = 0; run < 30; run++) {
    const source = Array.from({ length: 6 }, () => examples[random(examples.length)]).join("\n\n")
    const parser = createMarkdownParser()
    for (let end = 1; end < source.length; end += 1 + random(61)) {
      const prefix = source.slice(0, end)
      assert.equal(render(parser.parse(prefix)), expected(prefix))
    }
    assert.equal(render(parser.parse(source)), expected(source))
    const edit = source.replace(/one/g, "changed").slice(3)
    assert.equal(render(parser.parse(edit)), expected(edit))
  }
})
test("settled blocks retain their object identity during appends", () => {
  const parser = createMarkdownParser()
  const before = parser.parse("# Heading\n\nFirst paragraph.\n\nLast")
  const after = parser.parse(before.source + " **more**")
  assert.equal(after.blocks[0], before.blocks[0])
  assert.equal(after.blocks[2], before.blocks[2])
  assert.notEqual(after.blocks.at(-1), before.blocks.at(-1))
})
