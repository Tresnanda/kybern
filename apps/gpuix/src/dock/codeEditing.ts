// The file editor's typing helpers (ADE-61): Tab / Shift-Tab indent, Enter keeps the indent, brackets and quotes pair. Pure
// functions over the buffer and its selection (UTF-16 offsets, as the native editor reports them); `FileEditor.tsx` applies the
// result with one `editInput` (one undo step) and places the caret. `null` means: let the native editor handle the key.

export interface Selection { start: number; end: number }
/** Replace `start..end` with `text`, then select `caret..caretEnd` (a caret when `caretEnd` is absent). */
export interface CodeEdit { start: number; end: number; text: string; caret: number; caretEnd?: number }

const OPEN: Record<string, string> = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' }
const CLOSE = new Set([')', ']', '}', '"', "'", '`'])
const QUOTES = new Set(['"', "'", '`'])

/** The file's indent: a tab when most indented lines start with one, else the most common step of 2 or 4 spaces (2 by default). */
export function indentUnit(text: string): string {
  let tabs = 0, two = 0, four = 0
  const sample = text.length > 200_000 ? text.slice(0, 200_000) : text
  for (const line of sample.split('\n')) {
    if (line.startsWith('\t')) { tabs++; continue }
    const spaces = line.length - line.trimStart().length
    if (!spaces || spaces === line.length) continue
    if (spaces % 4 === 0) four++
    else if (spaces % 2 === 0) two++
  }
  if (tabs > two + four) return '\t'
  return four > two * 2 && two === 0 ? '    ' : '  '
}

const lineStart = (text: string, at: number) => text.lastIndexOf('\n', at - 1) + 1
const lineEnd = (text: string, at: number) => { const end = text.indexOf('\n', at); return end < 0 ? text.length : end }
const leading = (line: string) => line.slice(0, line.length - line.trimStart().length)

/** The 1-based line of `offset`. */
export function lineOf(text: string, offset: number): number {
  let line = 1
  for (let i = text.indexOf('\n'); i >= 0 && i < offset; i = text.indexOf('\n', i + 1)) line++
  return line
}

/** The lines a selection touches, as `[from, to)`: a selection ending at the start of a line leaves that line out. */
function touched(text: string, selection: Selection): [number, number] {
  const from = lineStart(text, selection.start)
  const endAt = selection.end > selection.start && selection.end === lineStart(text, selection.end) ? selection.end - 1 : selection.end
  return [from, lineEnd(text, Math.max(endAt, from))]
}

function indentLines(text: string, selection: Selection, unit: string, outdent: boolean): CodeEdit | null {
  const [from, to] = touched(text, selection)
  const lines = text.slice(from, to).split('\n')
  let firstDelta = 0, total = 0
  const next = lines.map((line, index) => {
    let delta: number
    let out: string
    if (outdent) {
      const remove = line.startsWith('\t') ? 1 : Math.min(unit === '\t' ? 4 : unit.length, line.length - line.trimStart().length)
      out = line.slice(remove); delta = -remove
    } else if (!line.length && lines.length > 1) { out = line; delta = 0 } else { out = unit + line; delta = unit.length }
    if (index === 0) firstDelta = delta
    total += delta
    return out
  })
  if (!total && outdent) return null
  const replaced = next.join('\n')
  const keepStart = selection.start === from && !outdent && selection.start !== selection.end
  return { start: from, end: to, text: replaced, caret: keepStart ? from : Math.max(from, selection.start + firstDelta), caretEnd: Math.max(from, selection.end + total) }
}

/**
 * What `key` (with the character it types, `char`) does to `text` at `selection`, or null for the native default. `path` picks
 * language rules (a Python block opens after `:`).
 */
export function codeKeyEdit(text: string, selection: Selection, key: string, char: string | undefined, shift: boolean, unit: string, path = ''): CodeEdit | null {
  const { start, end } = selection
  const empty = start === end
  if (key === 'tab') {
    if (shift) return indentLines(text, selection, unit, true)
    if (!empty && text.slice(start, end).includes('\n')) return indentLines(text, selection, unit, false)
    return { start, end, text: unit, caret: start + unit.length }
  }
  if (key === 'enter') {
    const from = lineStart(text, start)
    const before = text.slice(from, start)
    const after = text.slice(end, lineEnd(text, end))
    // The line's indent, cut at the caret when it sits inside that indent.
    const indent = leading(text.slice(from, lineEnd(text, from))).slice(0, before.length)
    const trimmed = before.trimEnd()
    const last = trimmed.at(-1) ?? ''
    const opens = last in OPEN && !QUOTES.has(last) || (/\.py$/i.test(path) && last === ':')
    const closer = opens ? OPEN[last] : undefined
    if (closer && after.trimStart().startsWith(closer)) {
      const inner = `\n${indent}${unit}`
      return { start, end, text: `${inner}\n${indent}`, caret: start + inner.length }
    }
    const insert = `\n${indent}${opens ? unit : ''}`
    return { start, end, text: insert, caret: start + insert.length }
  }
  if (key === 'backspace' && empty && start > 0) {
    const previous = text[start - 1]!
    if (OPEN[previous] && text[start] === OPEN[previous]) return { start: start - 1, end: start + 1, text: '', caret: start - 1 }
    return null
  }
  if (!char || char.length !== 1) return null
  if (CLOSE.has(char) && empty && text[start] === char && !(QUOTES.has(char) && text[start - 1] === '\\')) {
    return { start, end, text: '', caret: start + 1 }
  }
  const pair = OPEN[char]
  if (!pair) return null
  if (!empty) {
    const inner = text.slice(start, end)
    if (inner.includes('\n') && QUOTES.has(char)) return null
    return { start, end, text: char + inner + pair, caret: start + 1, caretEnd: end + 1 }
  }
  const next = text[start] ?? ''
  const previous = text[start - 1] ?? ''
  const freeAfter = next === '' || /\s/.test(next) || CLOSE.has(next) || next === ';' || next === ',' || next === '.' || next === ':'
  if (!freeAfter) return null
  if (QUOTES.has(char) && (/[\p{L}\p{N}_\\]/u.test(previous) || previous === char)) return null
  return { start, end, text: char + pair, caret: start + 1 }
}
