import { parseMarkdownDocument } from '../shared/lib/markdownParser.ts'
import { toMarkdown } from 'mdast-util-to-markdown'
import { gfmToMarkdown } from 'mdast-util-gfm'

/** Source-positioned CommonMark/GFM, with a native visible-text projection.
 * Text edits patch the original source range. Formatting serializes only the
 * touched parsed block; unrelated nodes retain their exact source bytes. */
export type RichKind = 'bold' | 'italic' | 'strike' | 'code' | 'link' | 'marker' | 'image'
export interface RichMark { start: number; end: number; kind: RichKind; href?: string; source?: string; sourceStart?: number; sourceEnd?: number }
export interface RichLine { start: number; prefix: string }
interface SyntaxNode {
  type: string; value?: string; alt?: string | null; url?: string; title?: string | null
  lang?: string | null; meta?: string | null; depth?: number; ordered?: boolean; checked?: boolean | null
  identifier?: string; children?: SyntaxNode[]
  position?: { start: { offset?: number }; end: { offset?: number } }
  [key: string]: unknown
}
interface Leaf { start: number; end: number; sourceStart: number; sourceEnd: number; offsets: number[]; node: SyntaxNode; literal?: boolean; atomic?: boolean }
interface NodeRange { start: number; end: number }
export interface RichText {
  text: string; marks: RichMark[]; lines: RichLine[]; tail?: string
  fence?: { open: string; close: string }; original?: string
  markdown?: string; tree?: SyntaxNode; leaves?: Leaf[]; ranges?: Map<SyntaxNode, NodeRange>
  context?: string
}
const markdown = (node: SyntaxNode, emphasis: '*' | '_' = '*', strong: '*' | '_' = '*'): string => {
  // Phrasing needs its paragraph context for the serializer's unsafe-character
  // rules. Serializing a text node alone can turn literal stars into emphasis.
  const root = ['text', 'inlineCode', 'image', 'imageReference', 'link', 'strong', 'emphasis', 'delete'].includes(node.type) ? { type: 'paragraph', children: [node] } : node
  return toMarkdown(root as Parameters<typeof toMarkdown>[0], { extensions: [gfmToMarkdown()], fences: true, bullet: '-', emphasis, strong }).replace(/\n$/, '')
}
const begin = (node: SyntaxNode) => node.position?.start.offset ?? 0
const finish = (node: SyntaxNode) => node.position?.end.offset ?? begin(node)
const styleKind: Record<string, RichKind | undefined> = { strong: 'bold', emphasis: 'italic', delete: 'strike', inlineCode: 'code', link: 'link', linkReference: 'link' }

/** GFM cell positions include separator pipes; phrasing positions do not. */
export function richTableCellRange(source: string, cell: SyntaxNode): { start: number; end: number } {
  if (cell.children?.length) return { start: begin(cell.children[0]!), end: finish(cell.children.at(-1)!) }
  let start = begin(cell), end = finish(cell)
  while (start < end && /[ \t]/.test(source[start]!)) start++
  if (source[start] === '|') start++
  while (end > start && /[ \t]/.test(source[end - 1]!)) end--
  if (source[end - 1] === '|') end--
  while (start < end && /[ \t]/.test(source[start]!)) start++
  while (end > start && /[ \t]/.test(source[end - 1]!)) end--
  return { start, end }
}

// The parser has already decoded escapes/entities. Align that leaf's decoded
// characters with its original source, retaining complete escape boundaries.
function offsets(raw: string, value: string, base: number): number[] {
  const result = [base]
  let at = 0
  for (let index = 0; index < value.length; index++) {
    const ch = value[index]!
    if (raw[at] === '\\' && raw[at + 1] === ch) at += 2
    else if (raw[at] === '&' && /^&(?:#x?[a-f\d]+|[a-z][a-z\d]+);/i.test(raw.slice(at))) {
      const end = raw.indexOf(';', at) + 1
      // The mdast text leaf supplies the decoded value; skip one source entity.
      const entity = raw.slice(at, end)
      const numeric = /^&#(x[\da-f]+|\d+);$/i.exec(entity)
      const codePoint = numeric ? parseInt(numeric[1]!.replace(/^x/i, ''), /^x/i.test(numeric[1]!) ? 16 : 10) : 0
      const count = numeric && Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint).length : 1
      at = end
      for (let n = 1; n < count && index + 1 < value.length; n++) { result.push(base + at); index++ }
    } else if (raw[at] === '\r' && raw[at + 1] === '\n' && ch === '\n') at += 2
    else if (raw[at] === ch) at++
    else {
      const next = raw.indexOf(ch, at)
      at = next < 0 ? Math.min(raw.length, at + 1) : next + 1
    }
    result.push(base + at)
  }
  return result
}

export function parseRichText(source: string, context = ''): RichText {
  const parsed = parseMarkdownDocument(source + (context ? '\n\n' + context : '')) as SyntaxNode
  const definitions = new Map((parsed.children ?? []).filter(n => n.type === 'definition').map(n => [n.identifier, n]))
  const tree = context ? { ...parsed, children: parsed.children?.filter(node => begin(node) < source.length) } : parsed
  const doc: RichText = { text: '', marks: [], lines: [], markdown: source, original: source, tree, context, leaves: [], ranges: new Map() }
  const append = (value: string, node: SyntaxNode, from = begin(node), to = finish(node), atomic = false, literal = false) => {
    const start = doc.text.length
    doc.text += value
    doc.leaves!.push({ start, end: doc.text.length, sourceStart: from, sourceEnd: to, offsets: atomic ? [from, to] : offsets(source.slice(from, to), value, from), node, atomic, literal })
  }
  const gap = (from: number, to: number, visible = source.slice(from, to)) => {
    if (visible) append(visible, { type: 'gap' }, from, to)
  }
  const walk = (node: SyntaxNode) => {
    const start = doc.text.length
    if (node.type === 'text') append(node.value ?? '', node)
    else if (node.type === 'inlineCode') {
      const raw = source.slice(begin(node), finish(node)), size = /^`+/.exec(raw)?.[0].length ?? 1
      append(node.value ?? '', node, begin(node) + size, finish(node) - size, false, true)
    } else if (node.type === 'code') {
      const raw = source.slice(begin(node), finish(node)), opening = /^ {0,3}(`{3,}|~{3,})[^\n]*\n/.exec(raw)
      const from = opening ? begin(node) + opening[0].length : begin(node)
      append(node.value ?? '', node, from, from + (node.value ?? '').length, false, true)
      doc.marks.push({ start, end: doc.text.length, kind: 'code', sourceStart: begin(node), sourceEnd: finish(node) })
    } else if (node.type === 'image' || node.type === 'imageReference') {
      append(node.alt || 'Image', node, begin(node), finish(node), true)
      doc.marks.push({ start, end: doc.text.length, kind: 'image', source: source.slice(begin(node), finish(node)), sourceStart: begin(node), sourceEnd: finish(node) })
    } else if (node.type === 'html') append(node.value ?? '', node, begin(node), finish(node), false, true)
    else if (node.type === 'footnoteReference') {
      append(`[^${node.identifier ?? ''}]`, node, begin(node), finish(node), true)
      doc.marks.push({ start, end: doc.text.length, kind: 'marker', source: source.slice(begin(node), finish(node)), sourceStart: begin(node), sourceEnd: finish(node) })
    }
    else if (node.type === 'break') append('\n', node, begin(node), finish(node), true)
    else if (node.type === 'thematicBreak') {
      append('—', node, begin(node), finish(node), true)
      doc.marks.push({ start, end: doc.text.length, kind: 'marker', source: source.slice(begin(node), finish(node)), sourceStart: begin(node), sourceEnd: finish(node) })
    } else if (node.type === 'definition') { /* Reference metadata has no rendered text. */ }
    else {
      if (node.type === 'heading') doc.lines.push({ start, prefix: '#'.repeat(node.depth ?? 1) + ' ' })
      if (node.type === 'blockquote') doc.lines.push({ start, prefix: '> ' })
      if (node.type === 'listItem') {
        const first = node.children?.[0], prefix = first ? source.slice(begin(node), begin(first)) : ''
        const label = node.checked != null ? node.checked ? '☑ ' : '☐ ' : /^\d/.test(prefix) ? (/^\d+[.)]\s*/.exec(prefix)?.[0] ?? '1. ') : '• '
        append(label, node, begin(node), first ? begin(first) : begin(node), true)
        doc.marks.push({ start, end: doc.text.length, kind: 'marker', source: prefix, sourceStart: begin(node), sourceEnd: first ? begin(first) : begin(node) })
      }
      const children = node.children ?? []
      for (const [index, child] of children.entries()) {
        if (index) {
          const previous = children[index - 1]!
          if (node.type === 'root') gap(finish(previous), begin(child))
          else if (node.type === 'list' || node.type === 'table') gap(finish(previous), begin(child), '\n')
          else if (node.type === 'tableRow') gap(finish(previous), begin(child), ' │ ')
          else if (node.type === 'blockquote' || node.type === 'listItem') gap(finish(previous), begin(child), '\n\n')
        }
        walk(child)
      }
      const last = children.at(-1)
      if (last && ['paragraph', 'heading', 'tableCell'].includes(node.type)) {
        const trailing = source.slice(finish(last), finish(node))
        if (/^ +$/.test(trailing)) gap(finish(last), finish(node))
      }
    }
    const end = doc.text.length
    doc.ranges!.set(node, { start, end })
    const kind = styleKind[node.type]
    if (kind && end > start) doc.marks.push({ start, end, kind, href: node.url ?? definitions.get(node.identifier)?.url, sourceStart: begin(node), sourceEnd: finish(node) })
  }
  walk(tree)
  if (!tree.children?.length && source && !source.trim()) gap(0, source.replace(/\n+$/, '').length)
  const last = tree.children?.at(-1)
  doc.tail = last ? source.slice(finish(last)) : source
  const only = tree.children?.filter(n => n.type !== 'definition')
  if (only?.length === 1 && only[0]?.type === 'code') {
    const raw = source.slice(begin(only[0]), finish(only[0])), open = /^(`{3,}|~{3,})[^\n]*\n/.exec(raw)?.[0] ?? ''
    doc.fence = { open, close: raw.slice(open.length + (only[0].value ?? '').length) + doc.tail }
  }
  return doc
}

export function serializeRichText(doc: RichText): string { return doc.markdown ?? doc.original ?? doc.text }

function sourceOffset(doc: RichText, offset: number, end = false): number {
  const leaves = doc.leaves ?? []
  const leaf = end ? [...leaves].reverse().find(l => l.start < offset && offset <= l.end) : leaves.find(l => l.start <= offset && offset < l.end)
  if (leaf) {
    if (leaf.atomic) return end ? leaf.sourceEnd : leaf.sourceStart
    return leaf.offsets[Math.max(0, Math.min(leaf.offsets.length - 1, offset - leaf.start))] ?? leaf.sourceEnd
  }
  if (offset === doc.text.length) return leaves.at(-1)?.sourceEnd ?? (doc.markdown?.length ?? 0) - (doc.tail?.length ?? 0)
  return leaves[0]?.sourceStart ?? 0
}
function escapeText(text: string): string { return text.replace(/[\\`*_[\]~<>#!+().-]/g, '\\$&') }
function patchSource(doc: RichText, start: number, end: number, replacement: string): RichText {
  const source = serializeRichText(doc)
  return parseRichText(source.slice(0, start) + replacement + source.slice(end), doc.context)
}
function preserveEditingWhitespace(doc: RichText, expected: string): RichText {
  if (doc.text === expected || !expected.startsWith(doc.text)) return doc
  const extra = expected.slice(doc.text.length)
  if (!/^\s+$/.test(extra)) return doc
  const from = doc.leaves?.at(-1)?.sourceEnd ?? 0
  const leaf: Leaf = { start: doc.text.length, end: expected.length, sourceStart: from, sourceEnd: from + extra.length, offsets: Array.from({ length: extra.length + 1 }, (_, i) => from + i), node: { type: 'gap' } }
  return { ...doc, text: expected, leaves: [...(doc.leaves ?? []), leaf] }
}
export function replaceRichText(doc: RichText, start: number, end: number, text: string): RichText {
  const expected = doc.text.slice(0, start) + text + doc.text.slice(end)
  const edited = (next: RichText) => {
    const result = preserveEditingWhitespace(next, expected)
    if (result.text === expected) return result
    const repaired = replaceParsedSelection(doc, start, end, text, expected)
    if (repaired) return repaired
    throw new Error('This selection crosses unsupported document boundaries. Edit within one block.')
  }
  const leaf = doc.leaves?.find(l => l.start <= start && end <= l.end && l.start < l.end)
  if (leaf?.node.type === 'text') {
    // Prefer the smallest safe patch so unrelated escapes/entities inside this
    // text leaf retain their exact spelling as well as rendering semantics.
    const from = leaf.offsets[start - leaf.start], to = leaf.offsets[end - leaf.start]
    if (from != null && to != null) {
      const local = preserveEditingWhitespace(patchSource(doc, from, to, text ? markdown({ type: 'text', value: text }) : ''), expected)
      if (local.text === expected) return local
    }
    const value = doc.text.slice(leaf.start, start) + text + doc.text.slice(end, leaf.end)
    if (value) return edited(patchSource(doc, begin(leaf.node), finish(leaf.node), markdown({ ...leaf.node, value })))
  }
  if (leaf && ['inlineCode', 'code', 'image', 'imageReference'].includes(leaf.node.type)) {
    const value = doc.text.slice(leaf.start, start) + text + doc.text.slice(end, leaf.end)
    const node = { ...leaf.node, ...(leaf.node.type.startsWith('image') ? { alt: value } : { value }) }
    return edited(patchSource(doc, begin(leaf.node), finish(leaf.node), markdown(node)))
  }
  let from = sourceOffset(doc, start), to = sourceOffset(doc, end, true)
  // Selecting a whole formatted node removes its delimiters too. Partial edits
  // keep their existing wrappers and link destinations/titles in the source.
  if (start !== end) for (const mark of doc.marks) {
    if (mark.start >= start && mark.end <= end && mark.sourceStart != null && mark.sourceEnd != null) {
      from = Math.min(from, mark.sourceStart); to = Math.max(to, mark.sourceEnd)
    }
  }
  return edited(patchSource(doc, from, to, leaf?.literal ? text : escapeText(text)))
}

/** Removing text across a mark boundary must also rebalance that parsed mark;
 * cutting raw source alone could strand an opening strong/link delimiter. */
function replaceParsedSelection(doc: RichText, start: number, end: number, text: string, expected: string): RichText | null {
  let root = doc.tree?.children?.find(node => {
    const range = doc.ranges?.get(node)
    return range && range.start <= start && end <= range.end && ['paragraph', 'heading'].includes(node.type)
  })
  let sourceStart = root ? begin(root) : 0, sourceEnd = root ? finish(root) : 0
  const ranges = new Map(doc.ranges)
  if (!root) {
    const visible = doc.tree?.children?.filter(node => node.type !== 'definition') ?? []
    let first = -1
    visible.forEach((node, index) => { if ((ranges.get(node)?.start ?? Infinity) <= start) first = index })
    const last = visible.findIndex(node => (ranges.get(node)?.end ?? -1) >= end)
    const blocks = first < 0 || last < first ? [] : visible.slice(first, last + 1)
    if (!blocks.length || blocks.some(node => !['paragraph', 'heading'].includes(node.type))) return null
    const children: SyntaxNode[] = []
    for (const [index, block] of blocks.entries()) {
      if (index) {
        const from = ranges.get(blocks[index - 1]!)!.end, to = ranges.get(block)!.start
        const gap: SyntaxNode = { type: 'text', value: doc.text.slice(from, to) }
        children.push(gap); ranges.set(gap, { start: from, end: to })
      }
      children.push(...(block.children ?? []))
    }
    root = { ...blocks[0]!, children }
    ranges.set(root, { start: ranges.get(blocks[0]!)!.start, end: ranges.get(blocks.at(-1)!)!.end })
    sourceStart = begin(blocks[0]!); sourceEnd = finish(blocks.at(-1)!)
  }
  let inserted = false
  const visit = (node: SyntaxNode): SyntaxNode | null => {
    const range = ranges.get(node)
    if (!range || range.end <= start || range.start >= end) return node
    if (node.children) {
      const children = node.children.map(visit).filter((child): child is SyntaxNode => child != null)
      return children.length ? { ...node, children } : null
    }
    const from = Math.max(0, start - range.start), to = Math.min(range.end - range.start, end - range.start)
    if (isFinite(from) && node.value != null) {
      const value = node.value.slice(0, from) + (inserted ? '' : text) + node.value.slice(to)
      inserted = true
      return value ? { ...node, value } : null
    }
    if (!inserted && text) { inserted = true; return { type: 'text', value: text } }
    return null
  }
  const changed = visit(root) ?? { type: 'paragraph', children: [] }
  const original = serializeRichText(doc)
  for (const [emphasis, strong] of [['*', '*'], ['_', '*'], ['*', '_'], ['_', '_']] as const) {
    const source = original.slice(0, sourceStart) + markdown(changed, emphasis, strong) + original.slice(sourceEnd)
    const next = preserveEditingWhitespace(parseRichText(source, doc.context), expected)
    if (next.text === expected) return next
  }
  return null
}

/** Longest equal Unicode prefix/suffix; never cuts a surrogate pair. */
export function textEdit(before: string, after: string): { start: number; end: number; text: string } {
  let start = 0, end = before.length, tail = after.length
  while (start < end && start < tail && before[start] === after[start]) start++
  if (start > 0 && /[\uD800-\uDBFF]/.test(before[start - 1]!)) start--
  while (end > start && tail > start && before[end - 1] === after[tail - 1]) { end--; tail-- }
  if (end < before.length && /[\uDC00-\uDFFF]/.test(before[end]!)) { end++; tail++ }
  return { start, end, text: after.slice(start, tail) }
}
export function updateRichText(doc: RichText, value: string): RichText {
  if (value === doc.text) return doc
  const edit = textEdit(doc.text, value)
  return replaceRichText(doc, edit.start, edit.end, edit.text)
}

export function richInputRule(doc: RichText, caret: number, allowBlock = true): { doc: RichText; caret: number } | null {
  const leaf = doc.leaves?.find(l => l.start <= caret && caret <= l.end)
  if (leaf?.literal) return null
  const lineStart = doc.text.lastIndexOf('\n', caret - 1) + 1, before = doc.text.slice(lineStart, caret)
  const block = allowBlock && /^(?:#{1,3} |[-*+] |1\. |> )$/.test(before)
  const match = block ? before : /(?:\*\*[^*\n]+\*\*|(?<!\*)\*[^*\n]+\*|~~[^~\n]+~~|`[^`\n]+`)$/.exec(before)?.[0]
  if (!match) return null
  const start = caret - match.length
  const next = patchSource(doc, sourceOffset(doc, start), sourceOffset(doc, caret, true), match)
  return { doc: next, caret: caret - match.length + parseRichText(match).text.length }
}

const nodeType: Partial<Record<RichKind, string>> = { bold: 'strong', italic: 'emphasis', strike: 'delete', code: 'inlineCode', link: 'link' }
interface Run { node: SyntaxNode; wrappers: SyntaxNode[]; start: number; end: number }
function sameWrapper(a: SyntaxNode, b: SyntaxNode): boolean { return a.type === b.type && a.url === b.url && a.title === b.title && a.identifier === b.identifier }
/** Split parsed phrasing nodes at the selection, then rebuild proper nested
 * Markdown nodes. The established serializer owns delimiter escaping, code
 * fence widths, link titles, and crossing/adjacent marks. */
export function toggleRichMark(doc: RichText, start: number, end: number, kind: RichKind, href?: string): RichText {
  if (start === end || !doc.tree || !nodeType[kind]) return doc
  const type = nodeType[kind]!, remove = !href && doc.marks.some(m => m.kind === kind && m.start <= start && m.end >= end)
  const runs = (node: SyntaxNode, wrappers: SyntaxNode[] = []): Run[] => {
    const range = doc.ranges?.get(node) ?? { start: 0, end: 0 }
    if (node.children && styleKind[node.type]) return node.children.flatMap(child => runs(child, [...wrappers, node]))
    return [{ node, wrappers, ...range }]
  }
  const rebuild = (items: Run[]): SyntaxNode[] => {
    const output: SyntaxNode[] = []
    const spaced = items.flatMap(run => {
      if (run.node.type !== 'text') return [run]
      let offset = run.start
      return (run.node.value ?? '').split(/(\s+)/).filter(Boolean).map(value => {
        const start = offset; offset += value.length
        return { ...run, node: { ...run.node, value }, start, end: offset, wrappers: /^\s+$/.test(value) ? run.wrappers.filter(w => w.type === 'link' || w.type === 'linkReference') : run.wrappers }
      })
    })
    for (const run of spaced) {
      let parent = output
      for (const wrapper of run.wrappers) {
        const last = parent.at(-1)
        if (last && sameWrapper(last, wrapper)) parent = last.children!
        else { const next = { ...wrapper, position: undefined, children: [] }; parent.push(next); parent = next.children }
      }
      const last = parent.at(-1)
      if (last?.type === 'text' && run.node.type === 'text') last.value = (last.value ?? '') + (run.node.value ?? '')
      else parent.push({ ...run.node, position: undefined })
    }
    return output
  }
  const transform = (node: SyntaxNode): SyntaxNode => {
    const range = doc.ranges?.get(node)
    if (!range || range.end <= start || range.start >= end) return node
    if (['paragraph', 'heading', 'tableCell'].includes(node.type)) {
      const items = (node.children ?? []).flatMap(child => runs(child)).flatMap(run => {
        if (run.end <= start || run.start >= end || !['text', 'inlineCode'].includes(run.node.type)) return [run]
        const value = run.node.value ?? '', cuts = [...new Set([0, Math.max(0, start - run.start), Math.min(value.length, end - run.start), value.length])].filter(n => n >= 0 && n <= value.length).sort((a, b) => a - b)
        return cuts.slice(0, -1).map((from, i) => {
          const to = cuts[i + 1]!, selected = run.start + from >= start && run.start + to <= end
          let wrappers: SyntaxNode[] = run.wrappers.map(w => ({ ...w, children: undefined }))
          let leaf = { ...run.node, value: value.slice(from, to) }
          if (selected) {
            wrappers = wrappers.filter(w => w.type !== type)
            if (kind === 'code') leaf = { ...leaf, type: remove ? 'text' : 'inlineCode' }
            else if (run.node.type !== 'inlineCode' && !remove) wrappers.push({ type, ...(kind === 'link' ? { url: href } : {}) })
          }
          // One wrapper order lets a selected mark continue across an existing
          // link/strong boundary, rather than producing adjacent closing/opening
          // emphasis runs that CommonMark interprets as literal delimiter text.
          const order: Record<string, number> = { emphasis: 0, strong: 1, delete: 2, link: 3, linkReference: 3 }
          wrappers.sort((a, b) => (order[a.type] ?? 4) - (order[b.type] ?? 4))
          return { ...run, node: leaf, wrappers, start: run.start + from, end: run.start + to }
        })
      })
      return { ...node, children: rebuild(items) }
    }
    if (!node.children) return node
    const children = node.children.map(transform)
    return children.every((child, i) => child === node.children![i]) ? node : { ...node, children }
  }
  const changes = (doc.tree.children ?? []).map(node => ({ node, next: transform(node) })).filter(item => item.next !== item.node).reverse()
  const original = serializeRichText(doc)
  for (const [emphasis, strong] of [['*', '*'], ['_', '*'], ['*', '_'], ['_', '_']] as const) {
    let source = original
    for (const { node, next } of changes) source = source.slice(0, begin(node)) + markdown(next, emphasis, strong) + source.slice(finish(node))
    const parsed = preserveEditingWhitespace(parseRichText(source, doc.context), doc.text)
    if (parsed.text !== doc.text) continue
    let valid = true
    const edges = [...new Set([0, doc.text.length, start, end, ...doc.marks.flatMap(m => [m.start, m.end]), ...parsed.marks.flatMap(m => [m.start, m.end])])].sort((a, b) => a - b)
    for (let at = 0; at < edges.length - 1 && valid; at++) {
      const from = edges[at]!, to = edges[at + 1]!, visible = doc.text.slice(from, to).search(/\S/)
      if (visible < 0) continue
      const i = from + visible
      if (!/\S/.test(doc.text[i]!) || doc.marks.some(m => m.kind === 'image' && m.start <= i && i < m.end)) continue
      for (const candidate of ['bold', 'italic', 'strike', 'code'] as const) {
        const active = (value: RichText) => value.marks.some(m => m.kind === candidate && m.start <= i && i < m.end)
        const code = doc.marks.some(m => m.kind === 'code' && m.start <= i && i < m.end)
        const selected = start <= i && i < end && (!code || kind === 'code')
        const expected = selected && candidate === kind ? !remove : active(doc)
        if (active(parsed) !== expected) { valid = false; break }
      }
    }
    if (valid) return parsed
  }
  // Some Markdown mark combinations are not representable. Preserve the
  // document instead of accepting a serializer result that changes content.
  return doc
}

export function setRichLink(doc: RichText, start: number, end: number, href: string): RichText { return toggleRichMark(doc, start, end, 'link', href) }
export function toggleRichChecklist(doc: RichText, mark: RichMark): RichText {
  if (mark.sourceStart == null || mark.sourceEnd == null || !mark.source) return doc
  const source = mark.source.replace(/\[[ xX]\]/, /\[[xX]\]/.test(mark.source) ? '[ ]' : '[x]')
  return patchSource(doc, mark.sourceStart, mark.sourceEnd, source)
}

export interface RichEntry { doc: RichText; start: number; end: number; reversed?: boolean }
/** Mirrors ComposerEditor's 200 entries and 800ms typing group. Formatting,
 * paste, picks, and selection replacements form distinct history entries. */
export class RichHistory {
  entries: RichEntry[]
  index = 0
  private typed = false
  private at = 0
  constructor(initial: RichEntry) { this.entries = [initial] }
  record(entry: RichEntry, typed: boolean, now = Date.now()) {
    this.entries = this.entries.slice(0, this.index + 1)
    if (typed && this.typed && now - this.at < 800 && this.index > 0) this.entries[this.index] = entry
    else { this.entries.push(entry); if (this.entries.length > 200) this.entries.shift(); this.index = this.entries.length - 1 }
    this.typed = typed; this.at = now
  }
  selection(start: number, end: number, reversed = false) { this.entries[this.index] = { ...this.entries[this.index]!, start, end, reversed }; this.typed = false }
  restore(step: -1 | 1): RichEntry | null {
    if (!this.entries[this.index + step]) return null
    this.typed = false; this.index += step; return this.entries[this.index]!
  }
}
