import { unified } from "unified"
import remarkParse from "remark-parse"
import remarkGfm from "remark-gfm"
import remarkRehype from "remark-rehype"
import { urlAttributes } from "html-url-attributes"
import { defaultUrlTransform } from "react-markdown"
import { imageSource, localImageLink } from "./responseImages"

// The same GFM, HTML-as-text and URL policy as our ReactMarkdown renderer.
const processor = unified().use(remarkParse).use(remarkGfm).use(remarkRehype, { allowDangerousHtml: true })
type MarkdownTree = ReturnType<typeof processor.parse>
export type MarkdownTreeNode = ReturnType<typeof processor.runSync>["children"][number]
export interface MarkdownBlock { key: string; signature: string; node: MarkdownTreeNode }
export interface ParsedMarkdown { source: string; blocks: MarkdownBlock[] }

function sanitize(node: MarkdownTreeNode): MarkdownTreeNode {
  if (node.type === "raw") return { type: "text", value: node.value, position: node.position }
  if (node.type === "element") {
    for (const [key, tags] of Object.entries(urlAttributes)) {
      if (Object.hasOwn(node.properties, key) && (tags === null || tags.includes(node.tagName))) {
        const url = String(node.properties[key] || "")
        node.properties[key] = key === "src" ? (imageSource(url) ? url : "") : key === "href" && localImageLink(url) ? url : defaultUrlTransform(url)
      }
    }
    node.children = node.children.map(sanitize) as typeof node.children
  }
  return node
}

function shiftPositions(node: MarkdownTree | MarkdownTree["children"][number], offset: number, lines: number) {
  if (node.position) for (const point of [node.position.start, node.position.end]) {
    if (point.offset !== undefined) point.offset += offset
    point.line += lines
  }
  if ("children" in node) for (const child of node.children) shiftPositions(child as MarkdownTree["children"][number], offset, lines)
}

/** Appends reparse the last complete top-level construct (including whole lists,
 * tables and fences). Definitions can change any earlier link/footnote, so any
 * possible definition conservatively selects the full-document path. */
export function createMarkdownParser() {
  let previous: ParsedMarkdown | undefined
  let tree: MarkdownTree | undefined
  return {
    parse(source: string): ParsedMarkdown {
      if (previous?.source === source) return previous
      let prefix: MarkdownBlock[] = []
      let nextTree: MarkdownTree
      const last = tree?.children.at(-1)
      const offset = last?.position?.start.offset
      if (previous && tree && offset !== undefined && source.startsWith(previous.source) && !source.includes("]:")) {
        const boundary = Math.max(source.lastIndexOf("\n", offset - 1), source.lastIndexOf("\r", offset - 1)) + 1
        nextTree = processor.parse(source.slice(boundary))
        shiftPositions(nextTree, boundary, (last!.position!.start.line - 1))
        // Whitespace between blocks belongs to the boundary, not the prefix.
        const first = previous.blocks.findIndex((block) => block.node.position !== undefined && (block.node.position.start.offset ?? 0) >= boundary)
        prefix = first < 0 ? previous.blocks : previous.blocks.slice(0, first)
        while (prefix.at(-1)?.node.type === "text" && !(prefix.at(-1)!.node.position)) prefix = prefix.slice(0, -1)
        const tailTree = nextTree
        tree = { type: "root", children: [...tree.children.slice(0, -1), ...tailTree.children] }
      } else {
        nextTree = processor.parse(source)
        tree = nextTree
      }
      const nodes = processor.runSync(nextTree).children.map(sanitize)
      if (prefix.length && nodes.length) nodes.unshift({ type: "text", value: "\n" })
      let previousKey = prefix.at(-1)?.key ?? "start"
      const old = new Map(previous?.blocks.map((block) => [block.key, block]))
      const blocks = nodes.map((node) => {
        const key = node.position ? `${node.position.start.offset}:${node.type === "element" ? node.tagName : node.type}` : `${previousKey}:gap`
        previousKey = key
        const signature = JSON.stringify(node)
        const existing = old.get(key)
        return existing?.signature === signature ? existing : { key, signature, node }
      })
      previous = { source, blocks: [...prefix, ...blocks] }
      return previous
    },
  }
}
