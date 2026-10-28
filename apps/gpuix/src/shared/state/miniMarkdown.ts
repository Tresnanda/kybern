// The gallery's thumbnails: the start of a note's Markdown read into a few small
// blocks (headings, paragraphs, checklists, lists, code, quotes), cheap enough to
// run on the main thread for every visible card. It reads only the first few
// kilobytes and stops after a budget of lines, so a 500 KB note costs the same as
// a short one. Pure: no DOM, no React, testable in Node.

export interface MiniSpan {
  text: string
  code?: boolean
  strong?: boolean
  /** A task reference (`[ADE-14](kybern://task/<id>)`): the task's id; `text` is its label. */
  task?: string
}

export type MiniBlock =
  | { kind: "heading"; level: 1 | 2 | 3; spans: MiniSpan[] }
  | { kind: "paragraph"; spans: MiniSpan[] }
  | { kind: "checklist"; items: { done: boolean; spans: MiniSpan[] }[] }
  | { kind: "list"; ordered: boolean; items: MiniSpan[][] }
  | { kind: "code"; lines: string[] }
  | { kind: "quote"; spans: MiniSpan[] }
  | { kind: "rule" }

export interface MiniDoc {
  blocks: MiniBlock[]
  /** Roughly how many text lines the blocks fill at thumbnail width; short notes are laid out larger. */
  lines: number
}

/** Characters read from the start of a note. A thumbnail never shows more than this. */
export const MINI_SOURCE_LIMIT = 4000
/** Lines a thumbnail can show; parsing stops once they are used. */
export const MINI_LINE_BUDGET = 14
/** Characters on one thumbnail line, for the line estimate. */
const LINE_CHARS = 64
const CODE_LINES = 5
/** A paragraph longer than this many characters is cut; nothing past it would be visible. */
const PARAGRAPH_CHARS = 420

const TASK_LINK = /\[([^\]\n]{1,64})\]\(kybern:\/\/task\/([0-9a-fA-F-]{36})\/?\)/g

/**
 * `**bold**`, `` `code` `` and links read as plain words, with code and bold kept
 * apart; task links keep their key and task id, for a glyph beside the key.
 */
export function parseInline(source: string): MiniSpan[] {
  const spans: MiniSpan[] = []
  const push = (text: string, flags: Omit<MiniSpan, "text"> = {}) => {
    if (!text) return
    const last = spans[spans.length - 1]
    if (last && !last.code && !flags.code && !last.task && !flags.task && !!last.strong === !!flags.strong) last.text += text
    else spans.push({ text, ...flags })
  }
  const plain = (text: string) =>
    text
      // Links and images keep their label; task references (kybern://task) keep their key.
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/<https?:\/\/([^>]+)>/g, "$1")
      .replace(/(^|[^\\*])\*(?=\S)([^*]+?)\*/g, "$1$2")
      .replace(/~~(?=\S)([^~]+?)~~/g, "$1")
      // `_emphasis_`, but not the underscores inside snake_case words.
      .replace(/(^|[^\w\\])_(?=\S)([^_]+?)_(?!\w)/g, "$1$2")
      .replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, "$1")
  const pushText = (text: string, flags: Omit<MiniSpan, "text"> = {}) => {
    let at = 0
    for (const match of text.matchAll(TASK_LINK)) {
      const index = match.index ?? 0
      push(plain(text.slice(at, index)), flags)
      push(match[1]!, { task: match[2]!.toLowerCase() })
      at = index + match[0].length
    }
    push(plain(text.slice(at)), flags)
  }
  let rest = source
  while (rest) {
    const code = rest.match(/`+/)
    const bold = rest.match(/\*\*(?=\S)([\s\S]+?)\*\*/)
    const codeAt = code?.index ?? -1
    const boldAt = bold?.index ?? -1
    if (codeAt >= 0 && (boldAt < 0 || codeAt <= boldAt)) {
      const fence = code![0]
      const close = rest.indexOf(fence, codeAt + fence.length)
      if (close < 0) {
        pushText(rest)
        break
      }
      pushText(rest.slice(0, codeAt))
      push(rest.slice(codeAt + fence.length, close).trim(), { code: true })
      rest = rest.slice(close + fence.length)
    } else if (boldAt >= 0) {
      pushText(rest.slice(0, boldAt))
      pushText(bold![1]!, { strong: true })
      rest = rest.slice(boldAt + bold![0].length)
    } else {
      pushText(rest)
      break
    }
  }
  return spans
}

const spansLength = (spans: MiniSpan[]) => spans.reduce((sum, span) => sum + span.text.length, 0)
const linesFor = (chars: number, perLine = LINE_CHARS) => Math.max(1, Math.ceil(chars / perLine))

const TASK = /^\s{0,3}(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s?(.*)$/
const BULLET = /^\s{0,3}([-*+])\s+(.*)$/
const ORDERED = /^\s{0,3}(\d+)[.)]\s+(.*)$/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const FENCE = /^\s{0,3}(`{3,}|~{3,})/
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/

/** The first blocks of a note, up to `budget` lines. */
export function miniMarkdown(markdown: string, budget = MINI_LINE_BUDGET): MiniDoc {
  const source = markdown.length > MINI_SOURCE_LIMIT ? markdown.slice(0, MINI_SOURCE_LIMIT) : markdown
  const rows = source.replace(/\r\n?/g, "\n").split("\n")
  const blocks: MiniBlock[] = []
  let lines = 0
  let paragraph: string[] = []

  const room = () => budget - lines
  const flushParagraph = () => {
    if (paragraph.length === 0) return
    let text = paragraph.join(" ").replace(/\s+/g, " ").trim()
    paragraph = []
    if (!text || room() <= 0) return
    if (text.length > PARAGRAPH_CHARS) text = `${text.slice(0, PARAGRAPH_CHARS).trimEnd()}…`
    const spans = parseInline(text)
    blocks.push({ kind: "paragraph", spans })
    lines += Math.min(room(), linesFor(spansLength(spans)))
  }

  for (let index = 0; index < rows.length && room() > 0; index++) {
    const row = rows[index]!
    if (!row.trim()) {
      flushParagraph()
      continue
    }
    const fence = row.match(FENCE)
    if (fence) {
      flushParagraph()
      const body: string[] = []
      for (index++; index < rows.length && !rows[index]!.trimStart().startsWith(fence[1]!); index++) {
        if (body.length < CODE_LINES) body.push(rows[index]!.replace(/\t/g, "  "))
      }
      if (body.length > 0) {
        blocks.push({ kind: "code", lines: body.slice(0, Math.max(1, room())) })
        lines += Math.min(room(), body.length) + 1
      }
      continue
    }
    const heading = row.match(HEADING)
    if (heading) {
      flushParagraph()
      const level = Math.min(3, heading[1]!.length) as 1 | 2 | 3
      blocks.push({ kind: "heading", level, spans: parseInline(heading[2]!) })
      lines += 2
      continue
    }
    if (RULE.test(row)) {
      flushParagraph()
      blocks.push({ kind: "rule" })
      lines += 1
      continue
    }
    const task = row.match(TASK)
    if (task) {
      flushParagraph()
      const last = blocks[blocks.length - 1]
      const item = { done: task[1] !== " ", spans: parseInline(task[2]!) }
      if (last?.kind === "checklist") last.items.push(item)
      else blocks.push({ kind: "checklist", items: [item] })
      lines += 1
      continue
    }
    const bullet = row.match(BULLET)
    const ordered = bullet ? null : row.match(ORDERED)
    if (bullet || ordered) {
      flushParagraph()
      const isOrdered = !!ordered
      const text = (bullet ?? ordered)![2]!
      const last = blocks[blocks.length - 1]
      if (last?.kind === "list" && last.ordered === isOrdered) last.items.push(parseInline(text))
      else blocks.push({ kind: "list", ordered: isOrdered, items: [parseInline(text)] })
      lines += 1
      continue
    }
    if (/^\s{0,3}>/.test(row)) {
      flushParagraph()
      const quoted: string[] = []
      for (; index < rows.length && /^\s{0,3}>/.test(rows[index]!); index++) quoted.push(rows[index]!.replace(/^\s{0,3}>\s?/, ""))
      index--
      const text = quoted.join(" ").replace(/\s+/g, " ").trim()
      if (text) {
        const spans = parseInline(text.length > PARAGRAPH_CHARS ? `${text.slice(0, PARAGRAPH_CHARS)}…` : text)
        blocks.push({ kind: "quote", spans })
        lines += Math.min(room(), linesFor(spansLength(spans), LINE_CHARS - 4))
      }
      continue
    }
    paragraph.push(row.trim())
  }
  flushParagraph()
  return { blocks, lines: Math.min(lines, budget) }
}

/** Words in a note's text, for the word count under a document. */
export function countWords(text: string): number {
  const matches = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu)
  return matches ? matches.length : 0
}

/** "286 words · 2 min read". Reading time assumes 230 words a minute and is never under a minute. */
export function wordCountLabel(words: number): string {
  if (words === 0) return ""
  const minutes = Math.max(1, Math.round(words / 230))
  return `${words === 1 ? "1 word" : `${words.toLocaleString("en-US")} words`} · ${minutes} min read`
}
