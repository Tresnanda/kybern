// Markdown ⇄ the native editor's blocks (`<rich-editor>`, `native/upstream/packages/native/src/rich_editor.rs`).
//
// A note is stored as Markdown. `parseDoc` turns it into the flat block list the
// native editor edits (nesting is `depth` for list levels, `quote` for quote
// levels, `cont` for a list item's later paragraphs) and remembers where every
// block came from. `serializeDoc` writes the edited blocks back: a block whose
// content is unchanged is copied from the original source byte for byte, together
// with the text between it and an unchanged neighbour, so an edit only rewrites
// the blocks it touched. Untouched documents round-trip exactly.
//
// Rules follow the desktop editor (TipTap 3 + @tiptap/markdown): `- ` bullets,
// `- [ ] ` checklists, `  \n` hard breaks, `&nbsp;` for a second empty paragraph.
import { parseMarkdownDocument } from '../shared/lib/markdownParser.ts'
import { toMarkdown } from 'mdast-util-to-markdown'
import { gfmToMarkdown } from 'mdast-util-gfm'

export type Mark = 'bold' | 'italic' | 'strike' | 'code'
export interface LinkJson { href: string; title: string | null }
export type AtomJson =
  | { type: 'taskRef'; id: string; label: string }
  | { type: 'image'; src: string; alt: string; title: string | null }
  | { type: 'raw'; source: string }
export type Piece = ({ text: string } | { atom: AtomJson }) & { marks?: Mark[]; link?: LinkJson }
export type BlockType = 'paragraph' | 'heading' | 'bullet' | 'ordered' | 'task' | 'code' | 'rule' | 'image' | 'raw'
export interface DocBlock {
  id: number
  type: BlockType
  level?: number
  start?: number
  checked?: boolean
  lang?: string
  src?: string
  alt?: string
  title?: string | null
  depth?: number
  quote?: number
  cont?: boolean
  text?: string
  content?: Piece[]
}
interface Origin {
  /** Source span: from the start of the block's first line to the end of its content. */
  start: number
  end: number
  /** First-line prefix (quote markers, indentation, list marker) before the content. */
  prefix: string
  index: number
  sig: string
}
export interface ParsedDoc {
  source: string
  blocks: DocBlock[]
  origins: Map<number, Origin>
}

interface Node {
  type: string
  value?: string
  url?: string
  title?: string | null
  alt?: string | null
  lang?: string | null
  meta?: string | null
  depth?: number
  ordered?: boolean | null
  start?: number | null
  checked?: boolean | null
  spread?: boolean | null
  children?: Node[]
  position?: { start: { offset?: number }; end: { offset?: number } }
}

const MARK_ORDER: Mark[] = ['bold', 'italic', 'strike', 'code']
const TASK_HREF = /^kybern:\/\/task\/([0-9a-fA-F-]{36})\/?$/
const NBSP = ' '

const begin = (node: Node) => node.position?.start.offset ?? 0
const finish = (node: Node) => node.position?.end.offset ?? begin(node)

/** The block as the native editor writes it back (`block_json`): same keys, order and normalization. */
export function canonical(block: DocBlock): DocBlock {
  const out: DocBlock = { id: block.id, type: block.type }
  switch (block.type) {
    case 'heading': out.level = Math.min(6, Math.max(1, block.level ?? 1)); break
    case 'ordered': out.start = block.start ?? 1; break
    case 'task': out.checked = !!block.checked; break
    case 'code': out.lang = block.lang ?? ''; break
    case 'image': out.src = block.src ?? ''; out.alt = block.alt ?? ''; out.title = block.title ?? null; break
  }
  if (block.depth) out.depth = Math.min(16, block.depth)
  if (block.quote) out.quote = Math.min(16, block.quote)
  if (block.cont) out.cont = true
  if (block.type === 'code' || block.type === 'raw') out.text = block.text ?? ''
  else if (block.type !== 'rule' && block.type !== 'image') out.content = normalizePieces(block.content ?? [])
  return out
}

function sameLink(a?: LinkJson, b?: LinkJson): boolean {
  return (!a && !b) || (!!a && !!b && a.href === b.href && (a.title ?? null) === (b.title ?? null))
}

function normalizePieces(pieces: Piece[]): Piece[] {
  const out: Piece[] = []
  for (const piece of pieces) {
    const marks = MARK_ORDER.filter(m => piece.marks?.includes(m))
    const link = piece.link ? { href: piece.link.href, title: piece.link.title ?? null } : undefined
    if ('atom' in piece) {
      const atom = piece.atom.type === 'taskRef' ? { type: 'taskRef' as const, id: piece.atom.id, label: piece.atom.label }
        : piece.atom.type === 'image' ? { type: 'image' as const, src: piece.atom.src, alt: piece.atom.alt, title: piece.atom.title ?? null }
          : { type: 'raw' as const, source: piece.atom.source }
      out.push({ atom, ...(marks.length ? { marks } : {}), ...(link ? { link } : {}) })
      continue
    }
    const text = piece.text.replaceAll('￼', '')
    if (!text) continue
    const last = out.at(-1)
    if (last && 'text' in last && (last.marks ?? []).join() === marks.join() && sameLink(last.link, link)) {
      last.text += text
      continue
    }
    out.push({ text, ...(marks.length ? { marks } : {}), ...(link ? { link } : {}) })
  }
  return out
}

/** Content identity, without the id. */
export function signature(block: DocBlock): string {
  const { id: _id, ...rest } = canonical(block)
  return JSON.stringify(rest)
}

// ---------------------------------------------------------------- parse ----

interface Ctx { quote: number; depth: number; strip: RegExp | null }

export function parseDoc(source: string): ParsedDoc {
  const tree = parseMarkdownDocument(source) as unknown as Node
  const blocks: DocBlock[] = []
  const spans: { start: number; end: number; prefix: string }[] = []
  const lineStart = (offset: number) => source.lastIndexOf('\n', offset - 1) + 1
  let nextId = 1
  const push = (block: Omit<DocBlock, 'id'>, start: number, end: number, contentStart: number) => {
    const id = nextId++
    blocks.push(canonical({ ...block, id } as DocBlock))
    const lineAt = lineStart(start)
    spans.push({ start: lineAt, end, prefix: source.slice(lineAt, Math.max(lineAt, contentStart)) })
  }
  /** Literal source of a node, without the container prefix on its later lines. */
  const literal = (node: Node, ctx: Ctx) => {
    const text = source.slice(begin(node), finish(node))
    return ctx.strip ? text.split('\n').map((line, i) => (i === 0 ? line : line.replace(ctx.strip!, ''))).join('\n') : text
  }
  const container = (quote: number, depth: number, indent: number): RegExp | null =>
    quote === 0 && indent === 0 ? null : new RegExp(`^(?:[ \\t]{0,3}>[ \\t]?){0,${quote}}[ \\t]{0,${indent}}`)

  const paragraph = (node: Node, ctx: Ctx, extra: Partial<DocBlock>, start: number) => {
    const children = node.children ?? []
    const onlyImage = children.filter(c => !(c.type === 'text' && !c.value?.trim()))
    if (!extra.type && onlyImage.length === 1 && onlyImage[0]!.type === 'image') {
      const image = onlyImage[0]!
      push({ type: 'image', src: image.url ?? '', alt: image.alt ?? '', title: image.title ?? null, depth: ctx.depth || undefined, quote: ctx.quote || undefined, ...(extra.cont ? { cont: true } : {}) }, start, finish(node), begin(node))
      return
    }
    const content = inline(children, ctx)
    // TipTap writes a second empty paragraph as `&nbsp;`.
    const empty = content.length === 1 && 'text' in content[0]! && (content[0]!.text === NBSP || content[0]!.text === '&nbsp;')
    push({ type: 'paragraph', content: empty ? [] : content, depth: ctx.depth || undefined, quote: ctx.quote || undefined, ...extra }, start, finish(node), children[0] ? begin(children[0]) : begin(node))
  }

  const inline = (nodes: Node[], ctx: Ctx, marks: Mark[] = [], link?: LinkJson): Piece[] => {
    const out: Piece[] = []
    for (const node of nodes) {
      const withStyle = (piece: Piece): Piece => ({ ...piece, ...(marks.length ? { marks: [...marks] } : {}), ...(link ? { link } : {}) })
      switch (node.type) {
        case 'text': out.push(withStyle({ text: node.value ?? '' })); break
        case 'break': out.push(withStyle({ text: '\n' })); break
        case 'strong': out.push(...inline(node.children ?? [], ctx, [...marks, 'bold'], link)); break
        case 'emphasis': out.push(...inline(node.children ?? [], ctx, [...marks, 'italic'], link)); break
        case 'delete': out.push(...inline(node.children ?? [], ctx, [...marks, 'strike'], link)); break
        case 'inlineCode': out.push({ text: node.value ?? '', marks: [...marks, 'code'], ...(link ? { link } : {}) }); break
        case 'link': {
          const task = TASK_HREF.exec(node.url ?? '')
          const label = (node.children ?? []).length === 1 && node.children![0]!.type === 'text' ? node.children![0]!.value ?? '' : null
          if (task && label && label.length <= 64 && !label.includes('\n')) {
            out.push(withStyle({ atom: { type: 'taskRef', id: task[1]!.toLowerCase(), label } }))
            break
          }
          out.push(...inline(node.children ?? [], ctx, marks, { href: node.url ?? '', title: node.title ?? null }))
          break
        }
        case 'image': out.push(withStyle({ atom: { type: 'image', src: node.url ?? '', alt: node.alt ?? '', title: node.title ?? null } })); break
        default:
          // Inline HTML, references, footnote calls: kept exactly, shown as their source.
          out.push(withStyle({ atom: { type: 'raw', source: literal(node, ctx) } }))
      }
    }
    return out
  }

  const walk = (nodes: Node[], ctx: Ctx) => {
    for (const node of nodes) {
      const quoteDepth = { depth: ctx.depth || undefined, quote: ctx.quote || undefined }
      switch (node.type) {
        case 'paragraph': paragraph(node, ctx, {}, begin(node)); break
        case 'heading': {
          const children = node.children ?? []
          push({ type: 'heading', level: node.depth ?? 1, content: inline(children, ctx), ...quoteDepth }, begin(node), finish(node), children[0] ? begin(children[0]) : finish(node))
          break
        }
        case 'thematicBreak': push({ type: 'rule', ...quoteDepth }, begin(node), finish(node), begin(node)); break
        case 'code': {
          const lang = [node.lang, node.meta].filter(Boolean).join(' ')
          push({ type: 'code', lang, text: node.value ?? '', ...quoteDepth }, begin(node), finish(node), begin(node))
          break
        }
        case 'blockquote': walk(node.children ?? [], { ...ctx, quote: ctx.quote + 1, strip: container(ctx.quote + 1, ctx.depth, 0) }); break
        case 'list': list(node, ctx); break
        default:
          push({ type: 'raw', text: literal(node, ctx), ...quoteDepth }, begin(node), finish(node), begin(node))
      }
    }
  }

  const list = (node: Node, ctx: Ctx) => {
    let first = true
    for (const item of node.children ?? []) {
      const children = item.children ?? []
      const type: BlockType = item.checked != null ? 'task' : node.ordered ? 'ordered' : 'bullet'
      const extra: Partial<DocBlock> = { type, ...(type === 'task' ? { checked: !!item.checked } : {}), ...(type === 'ordered' ? { start: first ? node.start ?? 1 : 1 } : {}) }
      first = false
      const head = children[0]
      const itemCtx: Ctx = { ...ctx, depth: ctx.depth }
      // Later lines of the item are indented to its content column.
      const marker = head ? begin(head) - lineStart(begin(item)) : 2
      const inner: Ctx = { quote: ctx.quote, depth: ctx.depth + 1, strip: new RegExp(`^(?:[ \\t]{0,3}>[ \\t]?){0,${ctx.quote}}[ \\t]{0,${Math.max(0, marker)}}`) }
      if (head?.type === 'paragraph') {
        paragraph(head, itemCtx, { ...extra, depth: ctx.depth || undefined }, begin(item))
      } else {
        // An item that starts with something other than text: an empty item line.
        push({ ...extra, type, content: [], depth: ctx.depth || undefined, quote: ctx.quote || undefined } as DocBlock, begin(item), head ? begin(item) + 1 : finish(item), begin(item) + Math.min(2, finish(item) - begin(item)))
        if (head) rest([head], ctx, inner)
      }
      rest(children.slice(1), ctx, inner)
    }
  }

  /** A list item's later children: nested lists one level deeper, other blocks as its continuation. */
  const rest = (children: Node[], ctx: Ctx, inner: Ctx) => {
    for (const child of children) {
      if (child.type === 'list') { list(child, { ...inner }); continue }
      const before = blocks.length
      walk([child], { ...inner, depth: ctx.depth })
      for (let i = before; i < blocks.length; i++) {
        blocks[i] = canonical({ ...blocks[i]!, depth: ctx.depth || undefined, cont: true })
      }
    }
  }

  walk(tree.children ?? [], { quote: 0, depth: 0, strip: null })
  const origins = new Map<number, Origin>()
  blocks.forEach((block, index) => {
    const span = spans[index]!
    origins.set(block.id, { ...span, index, sig: signature(block) })
  })
  if (!blocks.length) blocks.push(canonical({ id: nextId++, type: 'paragraph', content: [] }))
  return { source, blocks, origins }
}

// ------------------------------------------------------------ serialize ----

type Phrasing = { type: string; value?: string; url?: string; title?: string | null; alt?: string; children?: Phrasing[] }

function phrasing(pieces: Piece[]): Phrasing[] {
  // Links first (outermost), then marks in a fixed order; maximal runs share one node.
  const group = (items: Piece[], keys: ('link' | Mark)[]): Phrasing[] => {
    if (!keys.length) return items.map(leaf)
    const [key, ...restKeys] = keys
    const out: Phrasing[] = []
    let i = 0
    while (i < items.length) {
      const has = (p: Piece) => key === 'link' ? !!p.link : !!p.marks?.includes(key as Mark)
      const on = has(items[i]!)
      let j = i
      while (j < items.length && has(items[j]!) === on && (key !== 'link' || !on || sameLink(items[j]!.link, items[i]!.link))) j++
      const run = items.slice(i, j)
      if (!on || key === 'code') {
        out.push(...group(run, restKeys))
      } else if (key === 'link') {
        const link = run[0]!.link!
        out.push({ type: 'link', url: link.href, title: link.title, children: group(run.map(p => ({ ...p, link: undefined })), restKeys) })
      } else {
        const type = key === 'bold' ? 'strong' : key === 'italic' ? 'emphasis' : 'delete'
        out.push({ type, children: group(run.map(p => ({ ...p, marks: p.marks?.filter(m => m !== key) })), restKeys) })
      }
      i = j
    }
    return out
  }
  const leaf = (piece: Piece): Phrasing => {
    if ('atom' in piece) {
      const atom = piece.atom
      if (atom.type === 'taskRef') return { type: 'link', url: `kybern://task/${atom.id}`, title: null, children: [{ type: 'text', value: atom.label || 'Task' }] }
      if (atom.type === 'image') return { type: 'image', url: atom.src, alt: atom.alt, title: atom.title }
      return { type: 'html', value: atom.source }
    }
    if (piece.marks?.includes('code')) return { type: 'inlineCode', value: piece.text }
    // A line break inside a block is a hard break, as TipTap writes it.
    const parts = piece.text.split('\n')
    if (parts.length === 1) return { type: 'text', value: piece.text }
    return { type: 'fragment', children: parts.flatMap((part, i) => [...(i ? [{ type: 'break' }] : []), ...(part ? [{ type: 'text', value: part }] : [])]) }
  }
  const flatten = (nodes: Phrasing[]): Phrasing[] => nodes.flatMap(n => n.type === 'fragment' ? flatten(n.children ?? []) : [{ ...n, ...(n.children ? { children: flatten(n.children) } : {}) }])
  return flatten(group(pieces, ['link', 'bold', 'italic', 'strike', 'code']))
}

function md(node: Phrasing | { type: string; depth?: number; children: Phrasing[] }): string {
  return toMarkdown(node as Parameters<typeof toMarkdown>[0], { extensions: [gfmToMarkdown()], bullet: '-', emphasis: '*', strong: '*', fences: true, handlers: { break: () => '  \n' } }).replace(/\n+$/, '')
}

function inlineMarkdown(pieces: Piece[]): string {
  if (!pieces.length) return ''
  return md({ type: 'paragraph', children: phrasing(pieces) })
}

interface Generated { first: string; cont: string }

/** Prefixes for a block: the first line's (quote, indentation, marker) and later lines'. */
function prefixes(block: DocBlock, ordinal: number, indents: number[]): Generated {
  const quote = '> '.repeat(block.quote ?? 0)
  const depth = block.depth ?? 0
  const indent = ' '.repeat(indents.slice(0, depth).reduce((a, b) => a + b, 0))
  let marker = ''
  if (block.type === 'bullet') marker = '- '
  else if (block.type === 'task') marker = `- [${block.checked ? 'x' : ' '}] `
  else if (block.type === 'ordered') marker = `${ordinal}. `
  if (block.cont) {
    const own = ' '.repeat(indents[depth] ?? 2)
    return { first: quote + indent + own, cont: quote + indent + own }
  }
  const contentColumn = block.type === 'task' ? 2 : marker.length
  return { first: quote + indent + marker, cont: quote + indent + ' '.repeat(contentColumn) }
}

function blockMarkdown(block: DocBlock, prefix: Generated, previousEmpty: boolean): string {
  const lines = (text: string, first = prefix.first, cont = prefix.cont) => text.split('\n').map((line, i) => (i === 0 ? first : line ? cont : cont.trimEnd()) + line).join('\n')
  switch (block.type) {
    case 'heading': return lines(md({ type: 'heading', depth: Math.min(6, block.level ?? 1), children: phrasing(block.content ?? []) }))
    case 'rule': return prefix.first + '---'
    case 'code': {
      const text = block.text ?? ''
      let fence = '```'
      while (text.includes(fence)) fence += '`'
      const body = text.replace(/\n$/, '')
      return lines(`${fence}${block.lang ?? ''}\n${body}${body ? '\n' : ''}${fence}`, prefix.first, prefix.cont)
    }
    case 'image': return prefix.first + md({ type: 'paragraph', children: [{ type: 'image', url: block.src ?? '', alt: block.alt ?? '', title: block.title ?? null }] })
    case 'raw': return lines(block.text ?? '')
    default: {
      const text = inlineMarkdown(block.content ?? [])
      if (!text && block.type === 'paragraph') return previousEmpty ? prefix.first + '&nbsp;' : prefix.first.trimEnd()
      return lines(text)
    }
  }
}

function isList(block: DocBlock) {
  return block.type === 'bullet' || block.type === 'ordered' || block.type === 'task'
}

/** What separates two generated neighbours. */
function separator(a: DocBlock, b: DocBlock): string {
  const blank = '\n' + '> '.repeat(Math.min(a.quote ?? 0, b.quote ?? 0)).trimEnd() + '\n'
  // Separate lists (a checklist then a numbered list) keep a blank line between them.
  const newList = isList(a) && !(b.depth ?? 0) && !(a.depth ?? 0) && a.type !== b.type && !(a.type === 'bullet' && b.type === 'bullet')
  if (isList(b) && (isList(a) || a.cont) && (a.quote ?? 0) === (b.quote ?? 0) && !newList) return '\n'
  return blank
}

/** Markdown for the edited blocks; unchanged blocks keep their original source. */
export function serializeDoc(blocks: DocBlock[], base: ParsedDoc): string {
  const docs = blocks.map(canonical)
  const empty = docs.length === 1 && docs[0]!.type === 'paragraph' && !docs[0]!.content?.length && !docs[0]!.quote
  if (empty) return base.source.trim() === '' || base.source.trim() === '&nbsp;' ? base.source : ''
  // Ordinals and list indentation, as a reader would number and nest them.
  const counters = new Map<string, number>()
  const indents: number[] = []
  const pieces: { text: string; origin?: Origin; block: DocBlock }[] = []
  let previousEmpty = false
  for (const block of docs) {
    const depth = block.depth ?? 0
    const key = (d: number) => `${block.quote ?? 0}:${d}`
    let ordinal = 1
    if (isList(block)) {
      for (const k of [...counters.keys()]) if (Number(k.split(':')[1]) > depth || k.split(':')[0] !== String(block.quote ?? 0)) counters.delete(k)
      if (block.type === 'ordered') {
        ordinal = counters.has(key(depth)) ? counters.get(key(depth))! + 1 : block.start ?? 1
        counters.set(key(depth), ordinal)
      } else counters.delete(key(depth))
      indents.length = depth
      indents[depth] = block.type === 'ordered' ? `${ordinal}. `.length : 2
    } else if (!block.cont) {
      counters.clear()
      indents.length = 0
    }
    const origin = base.origins.get(block.id)
    if (origin && origin.sig === signature(block)) {
      pieces.push({ text: base.source.slice(origin.start, origin.end), origin, block })
    } else {
      let prefix = prefixes(block, ordinal, indents)
      // Same kind of block in the same place: keep how its line began (`*` bullets, `+`).
      if (origin && block.type !== 'ordered' && sameShape(base, origin, block)) prefix = { ...prefix, first: origin.prefix }
      pieces.push({ text: blockMarkdown(block, prefix, previousEmpty), block })
    }
    previousEmpty = block.type === 'paragraph' && !block.content?.length
  }
  let out = ''
  const first = pieces[0]!
  if (first.origin?.index === 0) out += base.source.slice(0, first.origin.start)
  pieces.forEach((piece, i) => {
    if (i > 0) {
      const prev = pieces[i - 1]!
      const adjacent = prev.origin && piece.origin && piece.origin.index === prev.origin.index + 1
      out += adjacent ? base.source.slice(prev.origin!.end, piece.origin!.start) : separator(prev.block, piece.block)
    }
    out += piece.text
  })
  const last = pieces.at(-1)!
  const baseLast = base.origins.size - 1
  if (last.origin && last.origin.index === baseLast) out += base.source.slice(last.origin.end)
  else out = out.trimEnd() + '\n'
  return out
}

function sameShape(base: ParsedDoc, origin: Origin, block: DocBlock): boolean {
  const old = base.blocks[origin.index]
  if (!old) return false
  return old.type === block.type && (old.depth ?? 0) === (block.depth ?? 0) && (old.quote ?? 0) === (block.quote ?? 0) && !!old.cont === !!block.cont
    && (old.level ?? 0) === (block.level ?? 0) && !!old.checked === !!block.checked && (old.lang ?? '') === (block.lang ?? '')
}

/** The visible words of a document, for word counts. */
export function plainText(blocks: DocBlock[]): string {
  return blocks.map(block => block.text ?? (block.content ?? []).map(p => 'text' in p ? p.text : p.atom.type === 'taskRef' ? p.atom.label : '').join('')).join('\n')
}
