import type { Line } from './vt.ts'
export interface CellPoint { line: number; column: number }
export interface TerminalSelection { anchor: CellPoint; head: CellPoint }
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
export function selectedText(lines: Line[], selection: TerminalSelection | null, cols: number) {
  if (!selection) return ''
  const result: string[] = []
  const indexed = selectionByIndex(lines, selection)
  for (const [index, line] of lines.entries()) {
    const range = selectionColumns(indexed, index, cols)
    if (!range) continue
    // A wide glyph belongs to both cells, including a drag starting on its trailing cell.
    const start = line.chars[range[0]] === '' ? Math.max(0, range[0] - 1) : range[0]
    result.push(line.chars.slice(start, range[1]).join('').trimEnd())
  }
  return result.join('\n')
}
