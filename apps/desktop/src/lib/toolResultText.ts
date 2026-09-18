/** Open tool results stay in a max-h-72 scroller. Bound the mounted text
 * without slicing the source: offscreen lines unmount, copy still gets
 * the full string, and short results keep a single `<pre>` identity. */

export const TOOL_RESULT_LINE_LIMIT = 32
export const TOOL_RESULT_CHAR_LIMIT = 8192
export const TOOL_RESULT_WRAP = 2048

export interface ToolResultRow {
  start: number
  end: number
  eol: boolean
}

export function shouldVirtualizeToolResult(text: string): boolean {
  if (text.length > TOOL_RESULT_CHAR_LIMIT) return true
  let lines = 1
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10 && ++lines > TOOL_RESULT_LINE_LIMIT) return true
  }
  return false
}

export function splitToolResultRows(text: string): ToolResultRow[] | null {
  if (!shouldVirtualizeToolResult(text)) return null
  const rows: ToolResultRow[] = []
  let start = 0
  for (let index = 0; index <= text.length; index++) {
    const eol = index < text.length && text.charCodeAt(index) === 10
    if (!eol && index !== text.length) continue
    if (index - start <= TOOL_RESULT_WRAP) {
      rows.push({ start, end: index, eol })
    } else {
      for (let offset = start; offset < index; offset += TOOL_RESULT_WRAP) {
        const end = Math.min(offset + TOOL_RESULT_WRAP, index)
        rows.push({ start: offset, end, eol: eol && end === index })
      }
    }
    start = index + 1
  }
  return rows
}

export function joinToolResultRows(text: string, rows: readonly ToolResultRow[]): string {
  let out = ""
  for (const row of rows) {
    out += text.slice(row.start, row.end)
    if (row.eol) out += "\n"
  }
  return out
}

export function toolResultRowText(text: string, row: ToolResultRow): string {
  return text.slice(row.start, row.end)
}

/** Select-all of the mounted scroller copies the whole result. A partial
 * selection keeps the browser string so on-screen copy is not rewritten.
 * WebKit joins block rows with newlines while `textContent` does not, so
 * ignore newline-only differences when detecting a full mounted selection. */
export function toolResultCopyText(full: string, mounted: string, selected: string): string {
  if (!selected) return selected
  if (full !== mounted && sameCharsIgnoringNewlines(selected, mounted)) return full
  return selected
}

function sameCharsIgnoringNewlines(left: string, right: string): boolean {
  if (left === right) return true
  let i = 0
  let j = 0
  for (;;) {
    while (i < left.length && (left.charCodeAt(i) === 10 || left.charCodeAt(i) === 13)) i++
    while (j < right.length && (right.charCodeAt(j) === 10 || right.charCodeAt(j) === 13)) j++
    if (i >= left.length || j >= right.length) return i >= left.length && j >= right.length
    if (left.charCodeAt(i) !== right.charCodeAt(j)) return false
    i++
    j++
  }
}

export function estimateToolResultRow(row: ToolResultRow): number {
  const chars = row.end - row.start || 1
  return Math.max(22, Math.ceil(chars / 72) * 22)
}
