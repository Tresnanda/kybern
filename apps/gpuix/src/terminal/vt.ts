/**
 * Bounded VT screen with the behaviour of xterm.js 6.0.0, the desktop terminal
 * (its InputHandler, Buffer and BufferReflow). `reference/` replays the same byte
 * streams through both and compares screens, so change behaviour there first.
 * No DOM, shell evaluation, OSC clipboard or external links.
 */
import { CHARSETS, type Charset } from './charsets.ts'
import { DOUBLE_WIDTH, ZERO_WIDTH } from './width.ts'

export interface Pen {
  fg?: string | number; bg?: string | number
  bold?: boolean; dim?: boolean; italic?: boolean; underline?: boolean; inverse?: boolean; hidden?: boolean; strike?: boolean; blink?: boolean; overline?: boolean
  /** 2 double, 3 curly, 4 dotted, 5 dashed; absent for a single underline. */
  underlineStyle?: number
  underlineColor?: string | number
  /** OSC 8 target. */
  link?: string
}
/** A cell nothing has written (xterm's "null cell"); a typed space is `' '`. A wide glyph's second cell is `''`. */
export const NULL = '\0'
export interface Line { id: number; chars: string[]; styles: number[]; revision: number; /** Continues the line above (soft wrap). */ wrapped: boolean }
export interface Run { text: string; style: Pen; columns: number }
export type RGB = [number, number, number]
/** What OSC 4, 10, 11 and 12 report; the terminal view supplies its theme. */
export interface TerminalColors { foreground: RGB; background: RGB; cursor: RGB; ansi(index: number): RGB }
export type CursorShape = 'block' | 'underline' | 'bar'

let lineId = 0
const ASCII = Array.from({ length: 128 }, (_, i) => String.fromCharCode(i))
const blank = (style = 0, cols = 0, wrapped = false): Line => ({ id: ++lineId, chars: style ? new Array<string>(cols).fill(NULL) : [], styles: style ? new Array<number>(cols).fill(style) : [], revision: 0, wrapped })

function inRanges(table: number[], cp: number) {
  let lo = 0, hi = table.length / 2 - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (cp < table[mid * 2]!) hi = mid - 1
    else if (cp > table[mid * 2 + 1]!) lo = mid + 1
    else return true
  }
  return false
}
/** xterm.js's default (Unicode 6) width: zero for marks and controls, two for East Asian wide, one otherwise. */
export function codeWidth(cp: number): 0 | 1 | 2 {
  if (cp < 127) return cp < 32 ? 0 : 1
  if (inRanges(ZERO_WIDTH, cp)) return 0
  return inRanges(DOUBLE_WIDTH, cp) ? 2 : 1
}
export function cellWidth(char: string): number { return codeWidth(char.codePointAt(0) ?? 0) }
/** The characters a cell shows: null cells are blanks. */
export const cellText = (char: string | undefined) => char === undefined || char === NULL ? ' ' : char
export function lineText(line: Line, from = 0, to = line.chars.length) {
  let text = ''
  for (let i = from; i < to; i++) text += cellText(line.chars[i])
  return text
}

interface Saved { x: number; y: number; pen: Pen; charset: Charset }
interface Buf { screen: Line[]; top: number; bottom: number; saved: Saved; tabs: boolean[] }
const defaultTabs = (cols: number) => Array.from({ length: cols }, (_, i) => i % 8 === 0)
const XTERM_ANSI: RGB[] = [[0x2e, 0x34, 0x36], [0xcc, 0, 0], [0x4e, 0x9a, 0x06], [0xc4, 0xa0, 0], [0x34, 0x65, 0xa4], [0x75, 0x50, 0x7b], [0x06, 0x98, 0x9a], [0xd3, 0xd7, 0xcf], [0x55, 0x57, 0x53], [0xef, 0x29, 0x29], [0x8a, 0xe2, 0x34], [0xfc, 0xe9, 0x4f], [0x72, 0x9f, 0xcf], [0xad, 0x7f, 0xa8], [0x34, 0xe2, 0xe2], [0xee, 0xee, 0xec]]
const CUBE = [0, 95, 135, 175, 215, 255]
/** The standard 256-colour palette; the first sixteen are the terminal theme's. */
export function paletteColor(index: number, ansi: (i: number) => RGB = i => XTERM_ANSI[i]!): RGB {
  if (index < 16) return ansi(index)
  if (index >= 232) { const c = 8 + (index - 232) * 10; return [c, c, c] }
  const i = index - 16
  return [CUBE[Math.floor(i / 36)]!, CUBE[Math.floor(i / 6) % 6]!, CUBE[i % 6]!]
}
const DEFAULT_COLORS: TerminalColors = { foreground: [255, 255, 255], background: [0, 0, 0], cursor: [255, 255, 255], ansi: i => XTERM_ANSI[i]! }

type Mode = 'ground' | 'esc' | 'escInter' | 'csi' | 'csiInter' | 'csiIgnore' | 'osc' | 'ignore'
export class VT {
  history: Line[] = []
  pens: Pen[] = [{}]
  x = 0; y = 0; title = ''
  cursorVisible = true; bracketedPaste = false; applicationCursor = false; applicationKeypad = false; reverseWrap = false; synchronizedOutput = false
  mouseTracking = 0; mouseSgr = false; mouseUtf8 = false; mouseUrxvt = false; focusReporting = false
  /** DECSCUSR; `undefined` means the terminal's own option (the desktop uses a blinking bar). */
  cursorShape: CursorShape | undefined; cursorBlink: boolean | undefined
  /** The terminal's own blink option (DECSET 12 changes it); the desktop terminal blinks. */
  blinkOption = false
  /** Colours a program set with OSC 4, 10, 11 and 12 (cleared by their reset sequences). */
  paletteOverrides = new Map<number, RGB>(); foregroundOverride?: RGB; backgroundOverride?: RGB; cursorOverride?: RGB
  /** Bumps whenever the line list itself (not a line's cells) changes. */
  structure = 0
  private pen: Pen = {}; private style = 0; private erase = 0; private penIds = new Map<string, number>([['{}', 0]])
  private mode: Mode = 'ground'
  private prefix = ''; private inter = ''; private params: number[] = [0]; private subs: (number[] | undefined)[] = []; private inSub = false
  private osc = ''
  private normal: Buf; private alt: Buf; private buf: Buf
  private charsets: Charset[] = [undefined, undefined, undefined, undefined]; private glevel = 0; private charset: Charset = undefined
  private base = 0
  private historyCells = 0
  private wrap = true; private origin = false; private insert = false; private newline = false
  /** Width of the last printed glyph (xterm's preceding join state); zero after any control sequence. */
  private joinWidth = 0
  private titleStack: string[] = []
  private linesCache: Line[] = []; private linesVersion = -1
  constructor(public cols = 80, public rows = 24, readonly maxHistory = 5000, readonly maxCells = 1_000_000, private reply: (text: string) => void = () => {}, public colors: TerminalColors = DEFAULT_COLORS) {
    this.normal = this.newBuf(); this.alt = this.newBuf(); this.buf = this.normal
  }
  private newBuf(): Buf { return { screen: Array.from({ length: this.rows }, () => blank()), top: 0, bottom: this.rows - 1, saved: { x: 0, y: 0, pen: {}, charset: undefined }, tabs: defaultTabs(this.cols) } }
  get screen() { return this.buf.screen }
  get alternate() { return this.buf === this.alt }
  private get bottom() { return this.buf.bottom }
  private get top() { return this.buf.top }

  // ---- buffer geometry ------------------------------------------------------------------
  /** Rows first, then columns: xterm pulls scrollback back into view or pushes rows out, then reflows. */
  resize(cols: number, rows: number) {
    cols = Math.max(2, Math.min(512, Math.floor(cols))); rows = Math.max(2, Math.min(200, Math.floor(rows)))
    if (cols === this.cols && rows === this.rows) return
    this.trimHistory()
    const cursor = { x: this.x, y: this.y }
    if (this.alternate) {
      this.resizeBuffer(this.alt, cols, rows, false, cursor)
      // The hidden normal buffer follows with the cursor it had when the alternate screen opened.
      this.resizeBuffer(this.normal, cols, rows, true, this.normalCursor)
    } else this.resizeBuffer(this.normal, cols, rows, true, cursor)
    this.x = cursor.x; this.y = cursor.y
    this.cols = cols; this.rows = rows
    if (!this.alternate) this.alt = this.newBuf()
    for (const buf of [this.normal, this.alt]) {
      let i = cols
      if (!buf.tabs[i]) i = this.prevStop(buf, i)
      for (; i < cols; i += 8) buf.tabs[i] = true
    }
    this.structure++
  }
  private normalCursor = { x: 0, y: 0 }
  private trimHistory() {
    if (this.history.length > this.maxHistory) { this.history.splice(0, this.history.length - this.maxHistory); this.historyCells = this.history.reduce((n, line) => n + line.chars.length, 0) }
    this.base = this.history.length
  }
  /** A port of xterm.js Buffer.resize over `history + screen` as one list. */
  private resizeBuffer(buf: Buf, newCols: number, newRows: number, scrollback: boolean, cursor: { x: number; y: number }) {
    const oldCols = this.cols, oldRows = this.rows
    const lines = scrollback ? [...this.history, ...buf.screen] : buf.screen.slice()
    let ybase = scrollback ? this.history.length : 0
    let y = cursor.y, x = cursor.x
    const maxLength = newRows + (scrollback ? this.maxHistory : 0)
    const nullBlank = () => blank(0, 0)
    let savedY = buf.saved.y
    if (lines.length > 0) {
      let addToY = 0
      if (oldRows < newRows) {
        for (let r = oldRows; r < newRows; r++) {
          if (lines.length < newRows + ybase) {
            if (ybase > 0 && lines.length <= ybase + y + addToY + 1) { ybase--; addToY++ }
            else lines.push(nullBlank())
          }
        }
      } else {
        for (let r = oldRows; r > newRows; r--) {
          if (lines.length > newRows + ybase) {
            if (lines.length > ybase + y + 1) lines.pop()
            else ybase++
          }
        }
      }
      if (maxLength < lines.length) {
        const trim = lines.length - maxLength
        if (trim > 0) { lines.splice(0, trim); ybase = Math.max(ybase - trim, 0); savedY = Math.max(savedY - trim, 0) }
      }
      x = Math.min(x, newCols - 1); y = Math.min(y, newRows - 1)
      if (addToY) y += addToY
      buf.saved.x = Math.min(buf.saved.x, newCols - 1)
      buf.top = 0
    }
    buf.bottom = newRows - 1
    if (scrollback && oldCols !== newCols) {
      const state = { lines, ybase, y, maxLength, rows: newRows, savedY }
      if (newCols > oldCols) this.reflowLarger(state, oldCols, newCols)
      else this.reflowSmaller(state, oldCols, newCols)
      ybase = state.ybase; y = state.y; savedY = state.savedY
    }
    // The alternate screen does not reflow, so xterm keeps its cells past a narrowed edge too.
    for (const line of scrollback ? lines : []) {
      if (line.chars.length > newCols) { line.chars.length = newCols; line.styles.length = newCols; line.revision++ }
    }
    cursor.x = x; cursor.y = y
    buf.screen = lines.slice(ybase, ybase + newRows)
    while (buf.screen.length < newRows) buf.screen.push(blank())
    if (scrollback) { this.history.length = 0; for (let i = 0; i < ybase; i++) this.history.push(lines[i]!); this.base = this.history.length; this.historyCells = this.history.reduce((n, line) => n + line.chars.length, 0) }
    buf.saved.y = savedY
  }
  private trimmedLength(line: Line, cols: number) {
    for (let i = Math.min(line.chars.length, cols) - 1; i >= 0; i--) {
      const ch = line.chars[i]
      if (ch !== undefined && ch !== NULL && ch !== '') return i + (this.widthAt(line, i) === 2 ? 2 : 1)
      if (ch === '') {
        // A wide glyph's second cell counts with its first.
        const lead = line.chars[i - 1]
        if (lead !== undefined && lead !== NULL && lead !== '') return i + 1
      }
    }
    return 0
  }
  private widthAt(line: Line, x: number) {
    const ch = line.chars[x]
    return ch === '' ? 0 : ch === undefined || ch === NULL ? 1 : codeWidth(ch.codePointAt(0)!)
  }
  private hasContent(line: Line, x: number) { const ch = line.chars[x]; return ch !== undefined && ch !== NULL && ch !== '' }
  private wrappedTrimmedLength(lines: Line[], i: number, cols: number) {
    if (i === lines.length - 1) return this.trimmedLength(lines[i]!, cols)
    const endsInNull = !this.hasContent(lines[i]!, cols - 1) && this.widthAt(lines[i]!, cols - 1) === 1
    const followingStartsWide = this.widthAt(lines[i + 1]!, 0) === 2
    return endsInNull && followingStartsWide ? cols - 1 : cols
  }
  private copyCells(src: Line, srcCol: number, dest: Line, destCol: number, length: number) {
    while (dest.chars.length < destCol) { dest.chars.push(NULL); dest.styles.push(0) }
    for (let i = 0; i < length; i++) { dest.chars[destCol + i] = src.chars[srcCol + i] ?? NULL; dest.styles[destCol + i] = src.styles[srcCol + i] ?? 0 }
    dest.revision++
  }
  private setNull(line: Line, x: number, style = 0) { while (line.chars.length <= x) { line.chars.push(NULL); line.styles.push(0) } line.chars[x] = NULL; line.styles[x] = style; line.revision++ }
  private reflowLarger(state: { lines: Line[]; ybase: number; y: number; maxLength: number; rows: number; savedY: number }, oldCols: number, newCols: number) {
    const { lines } = state
    const toRemove: number[] = []
    const cursorRow = state.ybase + state.y
    for (let y = 0; y < lines.length - 1; y++) {
      let i = y
      let next = lines[++i]!
      if (!next.wrapped) continue
      const wrapped: Line[] = [lines[y]!]
      while (i < lines.length && next.wrapped) { wrapped.push(next); next = lines[++i]! }
      // The cursor's own logical line is left for the program to repaint.
      if (cursorRow >= y && cursorRow < i) { y += wrapped.length - 1; continue }
      let destLine = 0, destCol = this.wrappedTrimmedLength(wrapped, destLine, oldCols)
      let srcLine = 1, srcCol = 0
      while (srcLine < wrapped.length) {
        const srcTrimmed = this.wrappedTrimmedLength(wrapped, srcLine, oldCols)
        const srcRemaining = srcTrimmed - srcCol, destRemaining = newCols - destCol
        const toCopy = Math.min(srcRemaining, destRemaining)
        this.copyCells(wrapped[srcLine]!, srcCol, wrapped[destLine]!, destCol, toCopy)
        destCol += toCopy
        if (destCol === newCols) { destLine++; destCol = 0 }
        srcCol += toCopy
        if (srcCol === srcTrimmed) { srcLine++; srcCol = 0 }
        // The last cell must not be half of a wide glyph.
        if (destCol === 0 && destLine !== 0 && this.widthAt(wrapped[destLine - 1]!, newCols - 1) === 2) {
          this.copyCells(wrapped[destLine - 1]!, newCols - 1, wrapped[destLine]!, destCol++, 1)
          this.setNull(wrapped[destLine - 1]!, newCols - 1)
        }
      }
      // Clear what is left in the last destination line.
      const last = wrapped[destLine]!
      for (let c = destCol; c < Math.min(newCols, last.chars.length); c++) { last.chars[c] = NULL; last.styles[c] = 0 }
      last.revision++
      let count = 0
      for (let r = wrapped.length - 1; r > 0; r--) { if (r > destLine || this.trimmedLength(wrapped[r]!, newCols) === 0) count++; else break }
      if (count > 0) { toRemove.push(y + wrapped.length - count, count) }
      y += wrapped.length - 1
    }
    if (!toRemove.length) return
    const kept: Line[] = []
    let next = 0, removeStart = toRemove[0], removed = 0
    for (let i = 0; i < lines.length; i++) {
      if (removeStart === i) { const count = toRemove[++next]!; i += count - 1; removed += count; removeStart = toRemove[++next] }
      else kept.push(lines[i]!)
    }
    lines.length = 0; lines.push(...kept)
    // Adjust the viewport for the removed rows.
    let adjust = removed
    while (adjust-- > 0) {
      if (state.ybase === 0) { if (state.y > 0) state.y--; if (lines.length < state.rows) lines.push(blank()) }
      else state.ybase--
    }
    state.savedY = Math.max(state.savedY - removed, 0)
  }
  private reflowSmaller(state: { lines: Line[]; ybase: number; y: number; maxLength: number; rows: number; savedY: number }, oldCols: number, newCols: number) {
    const { lines } = state
    const toInsert: { start: number; newLines: Line[] }[] = []
    let countToInsert = 0
    for (let y = lines.length - 1; y >= 0; y--) {
      let next = lines[y]
      if (!next || (!next.wrapped && this.trimmedLength(next, oldCols) <= newCols)) continue
      const wrapped: Line[] = [next]
      while (next.wrapped && y > 0) { next = lines[--y]!; wrapped.unshift(next) }
      // The cursor's own logical line is left alone.
      const cursorRow = state.ybase + state.y
      if (cursorRow >= y && cursorRow < y + wrapped.length) continue
      const lastLength = this.trimmedLength(wrapped[wrapped.length - 1]!, oldCols)
      const destLengths = this.newLineLengths(wrapped, oldCols, newCols)
      const toAdd = destLengths.length - wrapped.length
      let trimmed: number
      if (state.ybase === 0 && state.y !== lines.length - 1) trimmed = Math.max(0, state.y - state.maxLength + toAdd)
      else trimmed = Math.max(0, lines.length - state.maxLength + toAdd)
      const newLines: Line[] = []
      for (let i = 0; i < toAdd; i++) newLines.push(blank(0, 0, true))
      if (newLines.length) { toInsert.push({ start: y + wrapped.length + countToInsert, newLines }); countToInsert += newLines.length }
      wrapped.push(...newLines)
      // Copy backwards so the move is safe in place.
      let destIndex = destLengths.length - 1, destCol = destLengths[destIndex]!
      if (destCol === 0) { destIndex--; destCol = destLengths[destIndex]! }
      let srcIndex = wrapped.length - toAdd - 1, srcCol = lastLength
      while (srcIndex >= 0) {
        const toCopy = Math.min(srcCol, destCol)
        if (wrapped[destIndex] === undefined) break
        this.copyCells(wrapped[srcIndex]!, srcCol - toCopy, wrapped[destIndex]!, destCol - toCopy, toCopy)
        destCol -= toCopy
        if (destCol === 0) { destIndex--; destCol = destLengths[destIndex]! }
        srcCol -= toCopy
        if (srcCol === 0) { srcIndex--; srcCol = this.wrappedTrimmedLength(wrapped, Math.max(srcIndex, 0), oldCols) }
      }
      // A wide glyph that moved to the next line leaves its old cell empty.
      for (let i = 0; i < wrapped.length; i++) { if (destLengths[i]! < newCols) this.setNull(wrapped[i]!, destLengths[i]!) }
      let adjust = toAdd - trimmed
      while (adjust-- > 0) {
        if (state.ybase === 0) {
          if (state.y < state.rows - 1) { state.y++; lines.pop() }
          else state.ybase++
        } else if (state.ybase < Math.min(state.maxLength, lines.length + countToInsert) - state.rows) state.ybase++
      }
      state.savedY = Math.min(state.savedY + toAdd, state.ybase + state.rows - 1)
    }
    if (toInsert.length) {
      const original = lines.slice(), originalLength = original.length
      let originalIndex = originalLength - 1, nextIndex = 0, nextInsert = toInsert[0]
      lines.length = Math.min(state.maxLength, originalLength + countToInsert)
      let insertedSoFar = 0
      for (let i = Math.min(state.maxLength - 1, originalLength + countToInsert - 1); i >= 0; i--) {
        if (nextInsert && nextInsert.start > originalIndex + insertedSoFar) {
          for (let n = nextInsert.newLines.length - 1; n >= 0; n--) lines[i--] = nextInsert.newLines[n]!
          i++
          insertedSoFar += nextInsert.newLines.length
          nextInsert = toInsert[++nextIndex]
        } else lines[i] = original[originalIndex--]!
      }
      const trim = Math.max(0, originalLength + countToInsert - state.maxLength)
      if (trim > 0) {
        lines.splice(0, trim)
        state.ybase = Math.max(state.ybase - trim, 0)
        state.savedY = Math.max(state.savedY - trim, 0)
      }
    }
  }
  private newLineLengths(wrapped: Line[], oldCols: number, newCols: number) {
    const lengths: number[] = []
    const needed = wrapped.map((_, i) => this.wrappedTrimmedLength(wrapped, i, oldCols)).reduce((p, c) => p + c)
    let srcCol = 0, srcLine = 0, available = 0
    while (available < needed) {
      if (needed - available < newCols) { lengths.push(needed - available); break }
      srcCol += newCols
      const oldTrimmed = this.wrappedTrimmedLength(wrapped, srcLine, oldCols)
      if (srcCol > oldTrimmed) { srcCol -= oldTrimmed; srcLine++ }
      const endsWide = this.widthAt(wrapped[srcLine]!, srcCol - 1) === 2
      if (endsWide) srcCol--
      const length = endsWide ? newCols - 1 : newCols
      lengths.push(length); available += length
    }
    return lengths
  }
  private remember(line: Line) {
    this.history.push(line); this.historyCells += line.chars.length
    if (this.base < this.maxHistory) this.base++
    // Drop in batches; repeated shift per byte would make a noisy process quadratic.
    if (this.history.length > this.maxHistory + 128 || this.historyCells > this.maxCells) {
      let count = Math.max(0, this.history.length - this.maxHistory)
      let cells = this.history.slice(0, count).reduce((n, line) => n + line.chars.length, 0)
      while (this.historyCells - cells > this.maxCells && count < this.history.length) cells += this.history[count++]!.chars.length
      this.history.splice(0, count); this.historyCells -= cells
    }
  }
  /** Scrolls the margins one row; only a region starting at the top feeds the scrollback (xterm.js does so even when the bottom margin is above the last row). */
  private scrollRegion(wrapped = false) {
    const buf = this.buf, line = blank(this.erase, this.cols, wrapped)
    if (buf.top === 0) { const removed = buf.screen.shift()!; buf.screen.splice(buf.bottom, 0, line); if (buf === this.normal) this.remember(removed) }
    else { buf.screen.splice(buf.top, 1); buf.screen.splice(buf.bottom, 0, line) }
    this.structure++
  }
  private nextStop(buf: Buf, x: number) { while (!buf.tabs[++x] && x < this.cols); return x >= this.cols ? this.cols - 1 : x < 0 ? 0 : x }
  private prevStop(buf: Buf, x: number) { while (!buf.tabs[--x] && x > 0); return x >= this.cols ? this.cols - 1 : x < 0 ? 0 : x }

  // ---- cells ----------------------------------------------------------------------------
  private row(): Line { return this.buf.screen[this.y]! }
  private pad(line: Line, upTo: number) { while (line.chars.length < upTo) { line.chars.push(NULL); line.styles.push(0) } }
  private setCell(line: Line, x: number, char: string, style: number) { this.pad(line, x); line.chars[x] = char; line.styles[x] = style }
  /** Replace [start, end) with erased cells, fixing the halves of any wide glyph cut by an edge. */
  private replaceCells(line: Line, start: number, end: number, style: number) {
    if (start && this.widthAt(line, start - 1) === 2) this.setCell(line, start - 1, NULL, style)
    if (end < this.cols && this.widthAt(line, end - 1) === 2) this.setCell(line, end, NULL, style)
    end = Math.min(end, this.cols)
    if (!style && end >= line.chars.length) { if (start < line.chars.length) { line.chars.length = start; line.styles.length = start } }
    else for (let i = start; i < end; i++) this.setCell(line, i, NULL, style)
    line.revision++
  }
  private insertCells(line: Line, x: number, n: number, style: number) {
    if (x && this.widthAt(line, x - 1) === 2) this.setCell(line, x - 1, NULL, style)
    this.pad(line, x)
    line.chars.splice(x, 0, ...Array<string>(n).fill(NULL)); line.styles.splice(x, 0, ...Array<number>(n).fill(style))
    line.chars.length = Math.min(line.chars.length, this.cols); line.styles.length = line.chars.length
    if (this.widthAt(line, this.cols - 1) === 2 && line.chars.length === this.cols) this.setCell(line, this.cols - 1, NULL, style)
    line.revision++
  }
  private deleteCells(line: Line, x: number, n: number, style: number) {
    if (x >= this.cols) return
    n = Math.min(n, this.cols - x)
    if (x && this.widthAt(line, x - 1) === 2) this.setCell(line, x - 1, NULL, style)
    if (x < line.chars.length) {
      line.chars.splice(x, n); line.styles.splice(x, n)
      // A second half whose glyph was deleted becomes empty.
      if (line.chars[x] === '') this.setCell(line, x, NULL, style)
    }
    if (style) { this.pad(line, this.cols - n); for (let i = this.cols - n; i < this.cols; i++) this.setCell(line, i, NULL, style) }
    line.revision++
  }

  // ---- printing -------------------------------------------------------------------------
  private print(code: number) {
    let ch = code < 128 ? ASCII[code]! : String.fromCodePoint(code)
    const charset = this.charset
    if (code < 127 && charset) { const mapped = charset[ch]; if (mapped) { ch = mapped; code = mapped.charCodeAt(0) } }
    let width: number = codeWidth(code), oldWidth = 0
    const previous = this.joinWidth
    const join = width === 0 && previous !== 0
    if (join) { oldWidth = previous; if (oldWidth > width) width = oldWidth }
    this.joinWidth = join ? width : width
    const cols = this.cols, buf = this.buf
    let line = this.row()
    // Overwriting the second half of a wide glyph blanks the first.
    if (this.x && this.widthAt(line, this.x - 1) === 2) this.setCell(line, this.x - 1, NULL, this.style)
    if (this.x + width - oldWidth > cols) {
      if (this.wrap) {
        const oldRow = line
        let oldCol = this.x - oldWidth
        this.x = oldWidth
        this.y++
        if (this.y === buf.bottom + 1) { this.y--; this.scrollRegion(true) }
        else {
          if (this.y >= this.rows) this.y = this.rows - 1
          buf.screen[this.y]!.wrapped = true
        }
        line = this.row()
        if (oldWidth > 0) this.copyCells(oldRow, oldCol, line, 0, oldWidth)
        while (oldCol < cols) this.setCell(oldRow, oldCol++, NULL, this.style)
        oldRow.revision++
      } else {
        this.x = cols - 1
        if (width === 2) return
      }
    }
    if (join && this.x) {
      const at = this.x - (this.widthAt(line, this.x - 1) ? 1 : 2)
      const base = line.chars[at]
      if (base !== undefined && base !== NULL && base !== '') line.chars[at] = (base + ch).slice(0, 64)
      line.revision++
      return
    }
    if (this.insert) this.insertCells(line, this.x, width - oldWidth, this.style)
    this.setCell(line, this.x++, ch, this.style)
    if (width > 0) while (--width) this.setCell(line, this.x++, '', this.style)
    // The cell under the cursor may be an orphaned second half.
    if (this.x < cols && line.chars[this.x] === '') this.setCell(line, this.x, NULL, this.style)
    line.revision++
  }

  // ---- cursor ---------------------------------------------------------------------------
  private restrictCursor(maxCol = this.cols - 1) {
    this.x = Math.min(maxCol, Math.max(0, this.x))
    this.y = this.origin ? Math.min(this.bottom, Math.max(this.top, this.y)) : Math.min(this.rows - 1, Math.max(0, this.y))
  }
  private setCursor(x: number, y: number) { this.x = x; this.y = this.origin ? this.top + y : y; this.restrictCursor() }
  private moveCursor(dx: number, dy: number) { this.restrictCursor(); this.setCursor(this.x + dx, this.y + dy) }
  private lineFeed() {
    if (this.newline) this.x = 0
    this.y++
    if (this.y === this.bottom + 1) { this.y--; this.scrollRegion() }
    else if (this.y >= this.rows) this.y = this.rows - 1
    else this.row().wrapped = false
    if (this.x >= this.cols) this.x--
  }
  private saveCursor() { this.buf.saved = { x: this.x, y: this.base * (this.alternate ? 0 : 1) + this.y, pen: { ...this.pen }, charset: this.charset } }
  private restoreCursor() {
    const saved = this.buf.saved
    this.x = saved.x || 0
    this.y = Math.max(saved.y - (this.alternate ? 0 : this.base), 0)
    this.pen = { ...saved.pen }; this.setPen()
    this.charset = saved.charset
    this.restrictCursor()
  }
  private setPen() {
    const key = JSON.stringify(this.pen), existing = this.penIds.get(key)
    if (existing !== undefined) this.style = existing
    else if (this.pens.length < 4096) { this.style = this.pens.length; this.pens.push({ ...this.pen }); this.penIds.set(key, this.style) }
    else this.style = 0
    // Erased cells keep only the background colour (back_color_erase).
    if (this.pen.bg === undefined) this.erase = 0
    else {
      const bgKey = JSON.stringify({ bg: this.pen.bg }), id = this.penIds.get(bgKey)
      if (id !== undefined) this.erase = id
      else if (this.pens.length < 4096) { this.erase = this.pens.length; this.pens.push({ bg: this.pen.bg }); this.penIds.set(bgKey, this.erase) }
      else this.erase = 0
    }
  }

  // ---- SGR ------------------------------------------------------------------------------
  private color(mode: number, a: number, b: number, c: number, current: string | number | undefined) {
    if (mode === 2) return `rgb(${Math.min(255, a)},${Math.min(255, b)},${Math.min(255, c)})`
    if (mode === 5) return a & 0xff
    return current
  }
  private extractColor(pos: number, set: (value: string | number | undefined, mode: number) => void) {
    const accu = [0, 0, -1, 0, 0, 0], params = this.params
    let cSpace = 0, advance = 0
    do {
      accu[advance + cSpace] = params[pos + advance]!
      const subs = this.subs[pos + advance]
      if (subs) {
        let i = 0
        do {
          if (accu[1] === 5) cSpace = 1
          accu[advance + i + 1 + cSpace] = subs[i]!
        } while (++i < subs.length && i + advance + 1 + cSpace < accu.length)
        break
      }
      if ((accu[1] === 5 && advance + cSpace >= 2) || (accu[1] === 2 && advance + cSpace >= 5)) break
      if (accu[1]) cSpace = 1
    } while (++advance + pos < params.length && advance + cSpace < accu.length)
    for (let i = 2; i < accu.length; i++) if (accu[i] === -1) accu[i] = 0
    set(accu[1] === 2 || accu[1] === 5 ? this.color(accu[1]!, accu[3]!, accu[4]!, accu[5]!, undefined) : undefined, accu[1]!)
    return advance
  }
  private sgr() {
    const pen = this.pen, params = this.params
    if (params.length === 1 && params[0] === 0) { this.pen = {}; this.setPen(); return }
    for (let i = 0; i < params.length; i++) {
      const n = params[i]!
      if (n >= 30 && n <= 37) pen.fg = n - 30
      else if (n >= 40 && n <= 47) pen.bg = n - 40
      else if (n >= 90 && n <= 97) pen.fg = n - 90 + 8
      else if (n >= 100 && n <= 107) pen.bg = n - 100 + 8
      else if (n === 0) { for (const key of Object.keys(pen) as (keyof Pen)[]) if (key !== 'link') delete pen[key] }
      else if (n === 1) pen.bold = true
      else if (n === 2) pen.dim = true
      else if (n === 3) pen.italic = true
      else if (n === 4) { const sub = this.subs[i]; this.underline(sub ? sub[0]! : 1) }
      else if (n === 5) pen.blink = true
      else if (n === 7) pen.inverse = true
      else if (n === 8) pen.hidden = true
      else if (n === 9) pen.strike = true
      else if (n === 21) this.underline(2)
      else if (n === 22) { delete pen.bold; delete pen.dim }
      else if (n === 23) delete pen.italic
      else if (n === 24) this.underline(0)
      else if (n === 25) delete pen.blink
      else if (n === 27) delete pen.inverse
      else if (n === 28) delete pen.hidden
      else if (n === 29) delete pen.strike
      else if (n === 39) delete pen.fg
      else if (n === 49) delete pen.bg
      else if (n === 38) i += this.extractColor(i, (value, mode) => { if (mode === 2 || mode === 5) pen.fg = value })
      else if (n === 48) i += this.extractColor(i, (value, mode) => { if (mode === 2 || mode === 5) pen.bg = value })
      else if (n === 58) i += this.extractColor(i, (value, mode) => { if (mode === 2 || mode === 5) pen.underlineColor = value })
      else if (n === 53) pen.overline = true
      else if (n === 55) delete pen.overline
      else if (n === 59) delete pen.underlineColor
    }
    this.setPen()
  }
  private underline(style: number) {
    const pen = this.pen
    if (style < 0 || style > 5) style = 1
    if (style === 0) { delete pen.underline; delete pen.underlineStyle; return }
    pen.underline = true
    if (style === 1) delete pen.underlineStyle; else pen.underlineStyle = style
  }

  // ---- reports --------------------------------------------------------------------------
  private rgb16(color: RGB) { return color.map(v => v.toString(16).padStart(2, '0').repeat(2)).join('/') }
  private requestMode(ansi: boolean) {
    const p = this.params[0]!, prefix = ansi ? '' : '?'
    const send = (value: number) => this.reply(`\x1b[${prefix}${p};${value}$y`)
    const flag = (on: boolean) => send(on ? 1 : 2)
    if (ansi) { if (p === 2) send(4); else if (p === 4) flag(this.insert); else if (p === 12) send(3); else if (p === 20) flag(this.newline); else send(0); return }
    switch (p) {
      case 1: flag(this.applicationCursor); break
      case 6: flag(this.origin); break
      case 7: flag(this.wrap); break
      case 8: send(3); break
      case 9: flag(this.mouseTracking === 9); break
      case 12: flag(this.blinkOption); break
      case 25: flag(this.cursorVisible); break
      case 45: flag(this.reverseWrap); break
      case 66: flag(this.applicationKeypad); break
      case 67: send(4); break
      case 1000: flag(this.mouseTracking === 1000); break
      case 1002: flag(this.mouseTracking === 1002); break
      case 1003: flag(this.mouseTracking === 1003); break
      case 1004: flag(this.focusReporting); break
      case 1005: send(4); break
      case 1006: flag(this.mouseSgr); break
      case 1015: send(4); break
      case 1016: flag(this.mousePixels); break
      case 1048: send(1); break
      case 47: case 1047: case 1049: flag(this.alternate); break
      case 2004: flag(this.bracketedPaste); break
      case 2026: flag(this.synchronizedOutput); break
      default: send(0)
    }
  }
  mousePixels = false
  /** Whether the terminal view has keyboard focus (reported when focus reporting turns on). */
  focused = false
  private colorSlot(slot: number, text: string, reportPrefix: string) {
    if (text === '?') {
      const colors = this.colors
      const value = slot === 10 ? this.foregroundOverride ?? colors.foreground : slot === 11 ? this.backgroundOverride ?? colors.background : this.cursorOverride ?? colors.cursor
      this.reply(`\x1b]${slot};rgb:${this.rgb16(value)}\x1b\\`)
      return
    }
    const color = parseColor(text)
    if (!color) return
    if (slot === 10) this.foregroundOverride = color; else if (slot === 11) this.backgroundOverride = color; else this.cursorOverride = color
    void reportPrefix
  }
  private oscCommand(data: string) {
    const split = data.indexOf(';'), id = split < 0 ? data : data.slice(0, split), rest = split < 0 ? '' : data.slice(split + 1)
    if (!/^\d+$/.test(id)) return
    const code = Number(id)
    if (code === 0 || code === 2) { this.title = rest.slice(0, 200); this.titleChanged?.(this.title) }
    else if (code === 4) {
      const slots = rest.split(';')
      while (slots.length > 1) {
        const index = slots.shift()!, spec = slots.shift()!
        if (!/^\d+$/.test(index) || Number(index) > 255) continue
        const n = Number(index)
        if (spec === '?') this.reply(`\x1b]4;${n};rgb:${this.rgb16(this.paletteOverrides.get(n) ?? paletteColor(n, this.colors.ansi))}\x1b\\`)
        else { const color = parseColor(spec); if (color) this.paletteOverrides.set(n, color) }
      }
    } else if (code === 8) {
      const at = rest.indexOf(';')
      if (at < 0) return
      const uri = rest.slice(at + 1)
      if (uri) this.pen.link = uri.slice(0, 2048); else delete this.pen.link
      this.setPen()
    } else if (code >= 10 && code <= 12) {
      const slots = rest.split(';')
      for (let i = 0; i < slots.length && code + i <= 12; i++) this.colorSlot(code + i, slots[i]!, '')
    } else if (code === 104) { if (!rest) this.paletteOverrides.clear(); else for (const part of rest.split(';')) this.paletteOverrides.delete(Number(part)) }
    else if (code === 110) this.foregroundOverride = undefined
    else if (code === 111) this.backgroundOverride = undefined
    else if (code === 112) this.cursorOverride = undefined
  }
  /** Called when a program sets the title (OSC 0 or 2). */
  titleChanged?: (title: string) => void

  // ---- control sequences ----------------------------------------------------------------
  private csi(final: string) {
    const params = this.params, key = this.prefix + this.inter + final
    const p0 = params[0] ?? 0, n = p0 || 1
    const joined = this.joinWidth
    this.joinWidth = 0
    switch (key) {
      case '@': { this.restrictCursor(); this.insertCells(this.row(), this.x, n, this.erase); break }
      case 'A': { const diff = this.y - this.top; this.moveCursor(0, -(diff >= 0 ? Math.min(diff, n) : n)); break }
      case 'B': { const diff = this.bottom - this.y; this.moveCursor(0, diff >= 0 ? Math.min(diff, n) : n); break }
      case 'C': case 'a': this.moveCursor(n, 0); break
      case 'D': this.moveCursor(-n, 0); break
      case 'E': { const diff = this.bottom - this.y; this.moveCursor(0, diff >= 0 ? Math.min(diff, n) : n); this.x = 0; break }
      case 'F': { const diff = this.y - this.top; this.moveCursor(0, -(diff >= 0 ? Math.min(diff, n) : n)); this.x = 0; break }
      case 'G': case '`': this.setCursor(n - 1, this.y); break
      case 'H': case 'f': this.setCursor(params.length >= 2 ? (params[1] || 1) - 1 : 0, n - 1); break
      case 'I': { if (this.x >= this.cols) break; let count = n; while (count--) this.x = this.nextStop(this.buf, this.x); break }
      case 'Z': { if (this.x >= this.cols) break; let count = n; while (count--) this.x = this.prevStop(this.buf, this.x); break }
      case 'J': case '?J': this.eraseDisplay(p0); break
      case 'K': case '?K': this.eraseLine(p0); break
      case 'L': case 'M': {
        this.restrictCursor()
        if (this.y > this.bottom || this.y < this.top) break
        const screen = this.buf.screen
        for (let i = 0; i < n; i++) {
          if (final === 'L') { screen.splice(this.bottom, 1); screen.splice(this.y, 0, blank(this.erase, this.cols)) }
          else { screen.splice(this.y, 1); screen.splice(this.bottom, 0, blank(this.erase, this.cols)) }
        }
        this.structure++; this.x = 0
        break
      }
      case 'P': { this.restrictCursor(); this.deleteCells(this.row(), this.x, n, this.erase); break }
      case 'S': case 'T': {
        const screen = this.buf.screen
        for (let i = 0; i < n; i++) {
          if (final === 'S') { screen.splice(this.top, 1); screen.splice(this.bottom, 0, blank(this.erase, this.cols)) }
          else { screen.splice(this.bottom, 1); screen.splice(this.top, 0, blank(0, this.cols)) }
        }
        this.structure++
        break
      }
      case 'X': { this.restrictCursor(); this.replaceCells(this.row(), this.x, this.x + n, this.erase); break }
      case 'b': this.repeatPreceding(n, joined); break
      case 'c': if (p0 === 0) this.reply('\x1b[?1;2c'); break
      case '>c': if (p0 === 0) this.reply('\x1b[>0;276;0c'); break
      case 'd': this.setCursor(this.x, n - 1); break
      case 'e': this.moveCursor(0, n); break
      case 'g': if (p0 === 0) this.buf.tabs[this.x] = false; else if (p0 === 3) this.buf.tabs = []; break
      case 'h': case 'l': for (const mode of params) { if (mode === 4) this.insert = final === 'h'; else if (mode === 20) this.newline = final === 'h' } break
      case '?h': case '?l': for (const mode of params) this.privateMode(mode, final === 'h'); break
      case 'm': this.sgr(); break
      case 'n': if (p0 === 5) this.reply('\x1b[0n'); else if (p0 === 6) this.reply(`\x1b[${this.y + 1};${this.x + 1}R`); break
      case '?n': if (p0 === 6) this.reply(`\x1b[?${this.y + 1};${this.x + 1}R`); break
      case '!p': this.softReset(); break
      case ' q': this.cursorStyle(p0); break
      case 'r': {
        const top = p0 || 1
        let bottom = params.length < 2 || params[1]! > this.rows || params[1] === 0 ? this.rows : params[1]!
        if (bottom > top) { this.buf.top = top - 1; this.buf.bottom = bottom - 1; this.setCursor(0, 0) }
        break
      }
      case 's': this.saveCursor(); break
      case 'u': this.restoreCursor(); break
      case 't': this.windowOps(); break
      case '$p': this.requestMode(true); break
      case '?$p': this.requestMode(false); break
      default: break
    }
  }
  private windowOps() {
    const second = this.params.length > 1 ? this.params[1]! : 0
    if (this.params[0] === 22) { if (second === 0 || second === 2) { this.titleStack.push(this.title); if (this.titleStack.length > 10) this.titleStack.shift() } }
    else if (this.params[0] === 23) { if ((second === 0 || second === 2) && this.titleStack.length) { this.title = this.titleStack.pop()!; this.titleChanged?.(this.title) } }
  }
  private cursorStyle(p: number) {
    if (p === 0) { this.cursorShape = undefined; this.cursorBlink = undefined; return }
    this.cursorShape = p <= 2 ? 'block' : p <= 4 ? 'underline' : 'bar'
    this.cursorBlink = p % 2 === 1
  }
  /** Blank a line where it stands so its identity (and any selection on it) survives. */
  private resetLine(line: Line) {
    line.chars = this.erase ? new Array<string>(this.cols).fill(NULL) : []; line.styles = this.erase ? new Array<number>(this.cols).fill(this.erase) : []
    line.wrapped = false; line.revision++
  }
  private eraseDisplay(mode: number) {
    this.restrictCursor(this.cols)
    const screen = this.buf.screen, rows = this.rows
    if (mode === 0) {
      const line = screen[this.y]!
      this.replaceCells(line, this.x, this.cols, this.erase); if (this.x === 0) line.wrapped = false
      for (let r = this.y + 1; r < rows; r++) this.resetLine(screen[r]!)
    } else if (mode === 1) {
      const line = screen[this.y]!
      this.replaceCells(line, 0, this.x + 1, this.erase); line.wrapped = false
      if (this.x + 1 >= this.cols && screen[this.y + 1]) screen[this.y + 1]!.wrapped = false
      for (let r = 0; r < this.y; r++) this.resetLine(screen[r]!)
    } else if (mode === 2) {
      for (let r = 0; r < rows; r++) this.resetLine(screen[r]!)
    } else if (mode === 3) {
      if (!this.alternate) { this.history.length = 0; this.historyCells = 0; this.base = 0 }
    }
    this.structure++
  }
  private eraseLine(mode: number) {
    this.restrictCursor(this.cols)
    const line = this.row()
    if (mode === 0) { this.replaceCells(line, this.x, this.cols, this.erase); if (this.x === 0) line.wrapped = false }
    else if (mode === 1) this.replaceCells(line, 0, this.x + 1, this.erase)
    else if (mode === 2) { this.replaceCells(line, 0, this.cols, this.erase); line.wrapped = false }
  }
  private repeatPreceding(count: number, width: number) {
    if (!width) return
    const line = this.row(), at = this.x - width
    if (at < 0) return
    const text = line.chars[at]
    if (text === undefined || text === NULL || text === '') return
    const codes = Array.from(text, ch => ch.codePointAt(0)!)
    for (let i = 0; i < count; i++) for (const code of codes) this.print(code)
  }
  private privateMode(mode: number, on: boolean) {
    switch (mode) {
      case 1: this.applicationCursor = on; break
      case 2: if (on) this.charsets = [undefined, undefined, undefined, undefined]; this.charset = this.charsets[this.glevel]; break
      case 6: this.origin = on; this.setCursor(0, 0); break
      case 7: this.wrap = on; break
      case 12: this.blinkOption = on; break
      case 45: this.reverseWrap = on; break
      case 66: this.applicationKeypad = on; break
      case 9: this.mouseTracking = on ? 9 : 0; break
      case 1000: case 1002: case 1003: this.mouseTracking = on ? mode : 0; break
      case 1004: this.focusReporting = on; if (on) this.reply(this.focused ? '\x1b[I' : '\x1b[O'); break
      case 1005: this.mouseUtf8 = false; break
      case 1006: this.mouseSgr = on; if (on) this.mousePixels = false; break
      case 1015: this.mouseUrxvt = false; break
      case 1016: this.mousePixels = on; this.mouseSgr = on ? true : this.mouseSgr; break
      case 25: this.cursorVisible = on; break
      case 1048: if (on) this.saveCursor(); else this.restoreCursor(); break
      case 1049: case 47: case 1047:
        if (on) { if (mode === 1049) this.saveCursor(); this.enterAlternate() }
        else { this.leaveAlternate(); if (mode === 1049) this.restoreCursor() }
        break
      case 2004: this.bracketedPaste = on; break
      case 2026: this.synchronizedOutput = on; break
    }
  }
  private enterAlternate() {
    if (this.alternate) return
    // The alternate screen is always blank when it opens and keeps the cursor.
    this.normalCursor = { x: this.x, y: this.y }
    this.alt = this.newBuf(); this.buf = this.alt
    this.structure++
  }
  private leaveAlternate() {
    if (!this.alternate) return
    this.buf = this.normal; this.alt = this.newBuf()
    this.structure++
  }
  private softReset() {
    this.cursorVisible = true
    this.buf.top = 0; this.buf.bottom = this.rows - 1
    this.pen = {}; this.setPen()
    this.applicationCursor = this.applicationKeypad = this.bracketedPaste = this.reverseWrap = false
    this.insert = false; this.wrap = true; this.origin = false; this.synchronizedOutput = false; this.cursorShape = this.cursorBlink = undefined
    this.charsets = [undefined, undefined, undefined, undefined]; this.glevel = 0; this.charset = undefined
    this.buf.saved = { x: 0, y: this.alternate ? 0 : this.base, pen: {}, charset: undefined }
  }
  private fullReset() {
    this.buf = this.normal = this.newBuf(); this.alt = this.newBuf(); this.history = []; this.historyCells = 0; this.base = 0
    this.pen = {}; this.setPen(); this.x = this.y = 0
    this.cursorVisible = true; this.wrap = true; this.origin = this.insert = this.newline = false
    this.applicationCursor = this.applicationKeypad = this.bracketedPaste = this.reverseWrap = this.synchronizedOutput = false
    this.mouseTracking = 0; this.mouseSgr = this.mouseUtf8 = this.mouseUrxvt = this.mousePixels = this.focusReporting = false
    this.cursorShape = this.cursorBlink = undefined
    this.charsets = [undefined, undefined, undefined, undefined]; this.glevel = 0; this.charset = undefined
    this.paletteOverrides.clear(); this.foregroundOverride = this.backgroundOverride = this.cursorOverride = undefined
    this.joinWidth = 0; this.mode = 'ground'; this.structure++
  }
  private control(code: number) {
    this.joinWidth = 0
    switch (code) {
      case 0x08: {
        if (!this.reverseWrap) { this.restrictCursor(); if (this.x > 0) this.x--; break }
        this.restrictCursor(this.cols)
        if (this.x > 0) this.x--
        else if (this.x === 0 && this.y > this.top && this.y <= this.bottom && this.row().wrapped) {
          this.row().wrapped = false
          this.y--; this.x = this.cols - 1
          const line = this.row()
          if (this.widthAt(line, this.x) === 1 && !this.hasContent(line, this.x)) this.x--
        }
        this.restrictCursor()
        break
      }
      case 0x09: if (this.x < this.cols) this.x = this.nextStop(this.buf, this.x); break
      case 0x0a: case 0x0b: case 0x0c: this.lineFeed(); break
      case 0x0d: this.x = 0; break
      case 0x0e: this.glevel = 1; this.charset = this.charsets[1]; break
      case 0x0f: this.glevel = 0; this.charset = this.charsets[0]; break
      case 0x07: this.bell?.(); break
      case 0x84: this.indexDown(); break
      case 0x85: this.x = 0; this.indexDown(); break
      case 0x88: this.buf.tabs[this.x] = true; break
      default: break
    }
  }
  /** Called for BEL. */
  bell?: () => void
  private indexDown() {
    this.restrictCursor()
    this.y++
    if (this.y === this.bottom + 1) { this.y--; this.scrollRegion() }
    else if (this.y >= this.rows) this.y = this.rows - 1
    this.restrictCursor()
  }
  private escape(final: string) {
    this.joinWidth = 0
    const key = this.inter + final
    switch (key) {
      case '7': this.saveCursor(); return
      case '8': this.restoreCursor(); return
      case 'D': this.indexDown(); return
      case 'E': this.x = 0; this.indexDown(); return
      case 'H': this.buf.tabs[this.x] = true; return
      case 'M': {
        this.restrictCursor()
        if (this.y === this.top) { const screen = this.buf.screen; screen.splice(this.bottom, 1); screen.splice(this.top, 0, blank(this.erase, this.cols)); this.structure++ }
        else { this.y--; this.restrictCursor() }
        return
      }
      case '=': this.applicationKeypad = true; return
      case '>': this.applicationKeypad = false; return
      case 'c': this.fullReset(); return
      case 'n': this.glevel = 2; this.charset = this.charsets[2]; return
      case 'o': case '|': this.glevel = 3; this.charset = this.charsets[3]; return
      case '}': this.glevel = 2; this.charset = this.charsets[2]; return
      case '~': this.glevel = 1; this.charset = this.charsets[1]; return
      case '#8': {
        for (let r = 0; r < this.rows; r++) { const line = this.buf.screen[r]!; line.chars = Array<string>(this.cols).fill('E'); line.styles = Array<number>(this.cols).fill(0); line.wrapped = false; line.revision++ }
        this.buf.top = 0; this.buf.bottom = this.rows - 1; this.x = this.y = 0; this.structure++
        return
      }
    }
    const group = '()*+-./'.indexOf(this.inter)
    if (this.inter.length === 1 && group >= 0 && final in CHARSETS) {
      const index = group <= 3 ? group : group - 3 // - . / designate G1 G2 G3
      this.charsets[index] = CHARSETS[final]
      if (this.glevel === index) this.charset = CHARSETS[final]
    }
  }
  private startSequence(mode: Mode) { this.mode = mode; this.prefix = ''; this.inter = ''; this.params = [0]; this.subs = []; this.inSub = false; this.osc = '' }
  private param(code: number) {
    const last = this.params.length - 1
    if (code === 0x3b) { this.params.push(0); this.inSub = false; return }
    if (code === 0x3a) {
      const subs = this.subs[last] ?? (this.subs[last] = [])
      subs.push(0); this.inSub = true
      return
    }
    const digit = code - 0x30
    if (this.inSub) { const subs = this.subs[last]!; subs[subs.length - 1] = Math.min(0x7fffffff, subs[subs.length - 1]! * 10 + digit) }
    else this.params[last] = Math.min(0x7fffffff, this.params[last]! * 10 + digit)
    if (this.params.length > 32) this.params.length = 32
  }

  // ---- input ----------------------------------------------------------------------------
  write(text: string) {
    for (let i = 0, n = text.length; i < n; i++) {
      let code = text.charCodeAt(i)
      if (code >= 0xd800 && code < 0xdc00 && i + 1 < n) {
        const low = text.charCodeAt(i + 1)
        if (low >= 0xdc00 && low < 0xe000) { code = ((code - 0xd800) << 10) + (low - 0xdc00) + 0x10000; i++ }
      }
      // Cancel and escape work in every state.
      if (code === 0x18 || code === 0x1a) {
        if (this.mode === 'osc') this.osc = ''
        this.mode = 'ground'; this.joinWidth = 0; continue
      }
      if (code === 0x1b) {
        if (this.mode === 'osc') { this.oscCommand(this.osc); this.osc = '' }
        this.startSequence('esc'); continue
      }
      if (code >= 0x80 && code <= 0x9f && this.c1(code)) continue
      switch (this.mode) {
        case 'ground':
          if (code >= 0x20) { if (code !== 0x7f) this.print(code) }
          else this.control(code)
          break
        case 'esc':
          if (code < 0x20) this.control(code)
          else if (code === 0x5b) this.startSequence('csi')
          else if (code === 0x5d) this.startSequence('osc')
          else if (code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f) this.mode = 'ignore'
          else if (code >= 0x20 && code <= 0x2f) { this.inter += String.fromCharCode(code); this.mode = 'escInter' }
          else if (code !== 0x7f) { this.escape(String.fromCharCode(code)); this.mode = 'ground' }
          break
        case 'escInter':
          if (code < 0x20) this.control(code)
          else if (code <= 0x2f) this.inter += String.fromCharCode(code)
          else if (code !== 0x7f) { this.escape(String.fromCharCode(code)); this.mode = 'ground' }
          break
        case 'csi': case 'csiInter': case 'csiIgnore':
          if (code < 0x20) { this.control(code); break }
          if (code === 0x7f) break
          if (this.mode === 'csiIgnore') { if (code >= 0x40 && code <= 0x7e) this.mode = 'ground'; break }
          if (code >= 0x40 && code <= 0x7e) { this.csi(String.fromCharCode(code)); this.mode = 'ground' }
          else if (code >= 0x20 && code <= 0x2f) { this.inter += String.fromCharCode(code); this.mode = 'csiInter' }
          else if (this.mode === 'csiInter') this.mode = 'csiIgnore'
          else if (code >= 0x3c && code <= 0x3f) {
            if (this.params.length === 1 && this.params[0] === 0 && !this.subs.length && !this.prefix && !this.inSub && this.mode === 'csi') this.prefix = String.fromCharCode(code)
            else this.mode = 'csiIgnore'
          } else this.param(code)
          break
        case 'osc':
          if (code === 0x07) { this.oscCommand(this.osc); this.osc = ''; this.mode = 'ground'; this.joinWidth = 0 }
          else if (code >= 0x20 && this.osc.length < 65536) this.osc += code > 0xffff ? String.fromCodePoint(code) : String.fromCharCode(code)
          break
        case 'ignore': break
      }
    }
  }
  /** C1 controls arrive as characters because the stream is decoded UTF-8; true when handled. */
  private c1(code: number): boolean {
    if (code === 0x9c) { if (this.mode === 'osc') { this.oscCommand(this.osc); this.osc = '' }; this.mode = 'ground'; return true }
    if (code === 0x9b) { this.startSequence('csi'); return true }
    if (code === 0x9d) { this.startSequence('osc'); return true }
    if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) { this.mode = 'ignore'; this.joinWidth = 0; return true }
    if (this.mode === 'osc') this.osc = ''
    this.control(code)
    this.mode = 'ground'
    return true
  }

  // ---- views ----------------------------------------------------------------------------
  /** History plus the screen; the same array until the line list changes. */
  lines() {
    if (this.alternate) return this.buf.screen
    if (this.linesVersion !== this.structure) { this.linesCache = [...this.history, ...this.buf.screen]; this.linesVersion = this.structure }
    return this.linesCache
  }
  text() { return this.lines().map(line => lineText(line, 0, Math.min(line.chars.length, this.cols)).trimEnd()).join('\n') }
  runs(line: Line): Run[] {
    const runs: Run[] = []
    let last = -1
    for (let i = 0; i < Math.min(line.chars.length, this.cols); i++) {
      const id = line.styles[i] ?? 0, text = cellText(line.chars[i])
      if (id !== last) { runs.push({ text, style: this.pens[id] ?? {}, columns: 1 }); last = id }
      else { const run = runs[runs.length - 1]!; run.text += text; run.columns++ }
    }
    return runs
  }
}

/** XParseColor subset used by OSC 4/10/11/12: rgb:r/g/b with 1-4 hex digits per channel, and #rgb forms. */
export function parseColor(spec: string): RGB | undefined {
  const rgb = /^rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})$/i.exec(spec)
  const scale = (hex: string) => Math.round(parseInt(hex, 16) / (16 ** hex.length - 1) * 255)
  if (rgb) return [scale(rgb[1]!), scale(rgb[2]!), scale(rgb[3]!)]
  const hash = /^#([0-9a-f]+)$/i.exec(spec)
  if (hash && hash[1]!.length % 3 === 0 && hash[1]!.length <= 12) {
    const size = hash[1]!.length / 3
    return [0, 1, 2].map(i => scale(hash[1]!.slice(i * size, (i + 1) * size))) as RGB
  }
  return undefined
}
