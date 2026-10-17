import { NULL, cellText, type Line } from './vt.ts'
export interface CellPoint { line: number; column: number }
export interface TerminalSelection { anchor: CellPoint; head: CellPoint }
/** xterm.js's default `wordSeparator`. */
const WORD_SEPARATORS = ' ()[]{}\',"`'
export function selectionByIndex(lines: Line[], selection: TerminalSelection | null): TerminalSelection | null {
  if (!selection) return null
  const anchor = lines.findIndex(line => line.id === selection.anchor.line), head = lines.findIndex(line => line.id === selection.head.line)
  if (anchor < 0 || head < 0) return null // An evicted screen/history row cannot select unrelated text.
  return { anchor: { line: anchor, column: selection.anchor.column }, head: { line: head, column: selection.head.column } }
}
export function selectionColumns(selection: TerminalSelection | null, line: number, cols: number): [number, number] | null {
  if (!selection) return null
  const { anchor, head } = selection
  const forward = anchor.line < head.line || (anchor.line === head.line && anchor.column <= head.column)
  const [first, last] = forward ? [anchor, head] : [head, anchor]
  if (line < first.line || line > last.line) return null
  return [line === first.line ? first.column : 0, line === last.line ? last.column : cols]
}
/** Characters of one row in [from, to), trailing never-written cells trimmed (typed spaces stay), like xterm's translateToString. */
function rowText(line: Line, from: number, to: number) {
  let end = Math.min(to, line.chars.length)
  while (end > from && (line.chars[end - 1] === NULL || line.chars[end - 1] === undefined)) end--
  let text = ''
  for (let i = from; i < end; i++) text += cellText(line.chars[i])
  return text
}
/** A glyph belongs to both of its cells, including a drag starting on its trailing cell. */
const leadCell = (line: Line, column: number) => line.chars[column] === '' ? Math.max(0, column - 1) : column
export function selectedText(lines: Line[], selection: TerminalSelection | null, cols: number) {
  if (!selection) return ''
  let result = ''
  const indexed = selectionByIndex(lines, selection)
  let previous = -1
  for (const [index, line] of lines.entries()) {
    const range = selectionColumns(indexed, index, cols)
    if (!range) continue
    // A row that soft-wrapped into the previous one continues its line.
    if (previous >= 0 && !line.wrapped) result += '\n'
    result += rowText(line, leadCell(line, range[0]), range[1])
    previous = index
  }
  return result
}
/** Double click: the run of non-separator characters under the cell, widened across soft wraps by the caller. */
export function wordRange(lines: Line[], index: number, column: number, cols: number): TerminalSelection | null {
  const line = lines[index]
  if (!line) return null
  const at = leadCell(line, Math.min(column, cols - 1))
  const char = (i: number) => cellText(line.chars[i])
  if (WORD_SEPARATORS.includes(char(at))) return { anchor: { line: line.id, column: at }, head: { line: line.id, column: at + 1 } }
  let start = at, end = at
  while (start > 0 && !WORD_SEPARATORS.includes(char(start - 1))) start--
  while (end < cols - 1 && !WORD_SEPARATORS.includes(char(end + 1))) end++
  // A wide glyph's second cell is part of the word.
  while (end + 1 < cols && line.chars[end + 1] === '') end++
  return { anchor: { line: line.id, column: leadCell(line, start) }, head: { line: line.id, column: end + 1 } }
}
/** Triple click: the whole logical line, across soft wraps. */
export function lineRange(lines: Line[], index: number, cols: number): TerminalSelection | null {
  if (!lines[index]) return null
  let first = index, last = index
  while (first > 0 && lines[first]!.wrapped) first--
  while (last + 1 < lines.length && lines[last + 1]!.wrapped) last++
  return { anchor: { line: lines[first]!.id, column: 0 }, head: { line: lines[last]!.id, column: cols } }
}
export function allRange(lines: Line[], cols: number): TerminalSelection | null {
  return lines.length ? { anchor: { line: lines[0]!.id, column: 0 }, head: { line: lines[lines.length - 1]!.id, column: cols } } : null
}
