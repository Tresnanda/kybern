// The "/" menu: what can be inserted and how it is found by typing.
import type { Editor, Range } from "@tiptap/core"

export type SlashIcon =
  | "text"
  | "heading1"
  | "heading2"
  | "heading3"
  | "bullet"
  | "number"
  | "checklist"
  | "quote"
  | "code"
  | "divider"

export interface SlashItem {
  id: string
  title: string
  /** The Markdown you can type instead, shown beside the title so the shortcut gets learned. */
  shortcut: string
  /** Extra words that find this item, beyond its title. */
  keywords: string[]
  icon: SlashIcon
  run: (editor: Editor, range: Range) => void
}

const at = (editor: Editor, range: Range) => editor.chain().focus().deleteRange(range)

export const SLASH_ITEMS: SlashItem[] = [
  { id: "text", title: "Body", shortcut: "", keywords: ["text", "paragraph", "plain", "p"], icon: "text", run: (e, r) => at(e, r).clearNodes().run() },
  { id: "h1", title: "Heading 1", shortcut: "#", keywords: ["h1", "title", "header", "#"], icon: "heading1", run: (e, r) => at(e, r).setNode("heading", { level: 1 }).run() },
  { id: "h2", title: "Heading 2", shortcut: "##", keywords: ["h2", "subtitle", "header", "##"], icon: "heading2", run: (e, r) => at(e, r).setNode("heading", { level: 2 }).run() },
  { id: "h3", title: "Heading 3", shortcut: "###", keywords: ["h3", "header", "###"], icon: "heading3", run: (e, r) => at(e, r).setNode("heading", { level: 3 }).run() },
  { id: "bullet", title: "Bullet list", shortcut: "-", keywords: ["ul", "unordered", "list", "-"], icon: "bullet", run: (e, r) => at(e, r).toggleBulletList().run() },
  { id: "number", title: "Numbered list", shortcut: "1.", keywords: ["ol", "ordered", "list", "1."], icon: "number", run: (e, r) => at(e, r).toggleOrderedList().run() },
  { id: "checklist", title: "Checklist", shortcut: "[ ]", keywords: ["todo", "task", "check", "tasks", "[]"], icon: "checklist", run: (e, r) => at(e, r).toggleTaskList().run() },
  { id: "quote", title: "Quote", shortcut: ">", keywords: ["blockquote", "cite", ">"], icon: "quote", run: (e, r) => at(e, r).toggleBlockquote().run() },
  { id: "code", title: "Code block", shortcut: "```", keywords: ["pre", "snippet", "```"], icon: "code", run: (e, r) => at(e, r).toggleCodeBlock().run() },
  { id: "divider", title: "Divider", shortcut: "---", keywords: ["hr", "rule", "line", "separator", "---"], icon: "divider", run: (e, r) => at(e, r).setHorizontalRule().run() },
]

/** Items for what has been typed after "/": title matches first, then keywords. */
export function filterSlashItems(query: string, items: readonly SlashItem[] = SLASH_ITEMS): SlashItem[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...items]
  const rank = (item: SlashItem): number => {
    const title = item.title.toLowerCase()
    if (title.startsWith(needle)) return 0
    if (title.split(" ").some((word) => word.startsWith(needle))) return 1
    if (item.keywords.some((keyword) => keyword.startsWith(needle))) return 2
    if (title.includes(needle) || item.keywords.some((keyword) => keyword.includes(needle))) return 3
    return -1
  }
  return items
    .map((item, order) => ({ item, order, rank: rank(item) }))
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .map((entry) => entry.item)
}

/** The blocks the format bar's "Body" menu turns a selection into: the slash items minus the divider. */
export const TURN_INTO_ITEMS: readonly SlashItem[] = SLASH_ITEMS.filter((item) => item.id !== "divider")

/** Which of the turn-into blocks the selection is in right now. */
export function currentBlockId(editor: Editor): string {
  if (editor.isActive("heading", { level: 1 })) return "h1"
  if (editor.isActive("heading", { level: 2 })) return "h2"
  if (editor.isActive("heading", { level: 3 })) return "h3"
  if (editor.isActive("taskList")) return "checklist"
  if (editor.isActive("bulletList")) return "bullet"
  if (editor.isActive("orderedList")) return "number"
  if (editor.isActive("blockquote")) return "quote"
  if (editor.isActive("codeBlock")) return "code"
  return "text"
}

/** Turn the selected blocks into `item`, with the same commands the slash menu runs. */
export function turnInto(editor: Editor, item: SlashItem) {
  // Start from plain paragraphs, so a heading can become a list and one list another.
  editor.chain().focus().clearNodes().run()
  const { from } = editor.state.selection
  item.run(editor, { from, to: from })
}
