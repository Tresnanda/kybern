/** Bounded VT screen. No DOM, shell evaluation, OSC clipboard or external links. */
export interface Pen { fg?: string | number; bg?: string | number; bold?: boolean; italic?: boolean; underline?: boolean; inverse?: boolean }
export interface Line { id: number; chars: string[]; styles: number[]; revision: number }
export interface Run { text: string; style: Pen; columns: number }
let lineId = 0
const blank = (): Line => ({ id: ++lineId, chars: [], styles: [], revision: 0 })
export function cellWidth(char: string): number {
  const cp = char.codePointAt(0) ?? 0
  if (/\p{Mark}/u.test(char) || cp === 0x200d || cp === 0xfe0f) return 0
  return cp >= 0x1100 && (cp <= 0x115f || cp === 0x2329 || cp === 0x232a || (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe10 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || cp >= 0x20000) ? 2 : 1
}
export class VT {
  screen: Line[]
  history: Line[] = []
  pens: Pen[] = [{}]
  x = 0; y = 0; title = ''; cursorVisible = true; bracketedPaste = false; applicationCursor = false
  mouseTracking = 0; mouseSgr = false; mouseUtf8 = false; mouseUrxvt = false; focusReporting = false
  private pen: Pen = {}; private style = 0; private penIds = new Map<string, number>([['{}', 0]])
  private sequence = ''; private mode: 'text' | 'esc' | 'csi' | 'osc' | 'oscEsc' | 'charset' | 'ignore' | 'ignoreEsc' = 'text'
  private saved: [number, number, Pen] = [0, 0, {}]
  private normal?: { screen: Line[]; x: number; y: number; top: number; bottom: number; pen?: Pen }
  private alternateBuffer?: Line[]
  private historyCells = 0
  private top = 0; private bottom: number; private wrap = true; private origin = false; private insert = false
  constructor(public cols = 80, public rows = 24, readonly maxHistory = 5000, readonly maxCells = 1_000_000, private reply: (text: string) => void = () => {}) { this.screen = Array.from({ length: rows }, blank); this.bottom = rows - 1 }
  get alternate() { return !!this.normal }
  resize(cols: number, rows: number) {
    cols = Math.max(2, Math.min(512, Math.floor(cols))); rows = Math.max(2, Math.min(200, Math.floor(rows)))
    if (cols === this.cols && rows === this.rows) return
    // Fit may run immediately after replay. Remove rows below the cursor first;
    // shifting every removed row discarded fresh output at the top of the pane.
    while (this.screen.length > rows) {
      if (this.y < this.screen.length - 1) this.screen.pop()
      else { const line = this.screen.shift()!; if (!this.alternate) this.remember(line); this.y-- }
    }
    while (this.screen.length < rows) this.screen.push(blank())
    this.cols = cols; this.rows = rows; this.bottom = rows - 1; this.top = 0
    this.x = Math.min(this.x, cols - 1); this.y = Math.max(0, Math.min(this.y, rows - 1))
    // Resizing keeps source cells; a narrowed line is clipped and reappears when widened.
  }
  private remember(line: Line) {
    this.history.push(line); this.historyCells += line.chars.length
    // Drop in batches; repeated shift per byte would make a noisy process quadratic.
    if (this.history.length > this.maxHistory + 128 || this.historyCells > this.maxCells) {
      let count = Math.max(0, this.history.length - this.maxHistory)
      let cells = this.history.slice(0, count).reduce((n, line) => n + line.chars.length, 0)
      while (this.historyCells - cells > this.maxCells && count < this.history.length) cells += this.history[count++]!.chars.length
      this.history.splice(0, count); this.historyCells -= cells
    }
  }
  private scroll(up = true) {
    if (up) { const line = this.screen.splice(this.top, 1)[0]!; if (!this.alternate && this.top === 0 && this.bottom === this.rows - 1) this.remember(line); this.screen.splice(this.bottom, 0, blank()) }
    else { this.screen.splice(this.bottom, 1); this.screen.splice(this.top, 0, blank()) }
  }
  private linefeed() { if (this.y === this.bottom) this.scroll(); else this.y = Math.min(this.rows - 1, this.y + 1) }
  private put(char: string) {
    const width = cellWidth(char)
    if (!width) { const line = this.screen[this.y]!; let at = Math.max(0, Math.min(this.cols - 1, this.x - 1)); if (line.chars[at] === '' && at > 0) at--; line.chars[at] = ((line.chars[at] ?? '') + char).slice(0, 64); line.revision++; return }
    if (this.x >= this.cols || this.x + width > this.cols) { if (this.wrap) { this.x = 0; this.linefeed() } else this.x = this.cols - width }
    const line = this.screen[this.y]!
    // Overwriting either half of a wide glyph clears its companion cell.
    if (line.chars[this.x] === '' && this.x > 0) line.chars[this.x - 1] = ' '
    if (cellWidth(line.chars[this.x] ?? ' ') === 2) line.chars[this.x + 1] = ' '
    while (line.chars.length < this.x) { line.chars.push(' '); line.styles.push(0) }
    if (this.insert) { line.chars.splice(this.x, 0, ...Array(width).fill(' ')); line.styles.splice(this.x, 0, ...Array(width).fill(this.style)); line.chars.length = Math.min(this.cols, line.chars.length); line.styles.length = line.chars.length }
    line.chars[this.x] = char; line.styles[this.x] = this.style
    if (width === 2) { line.chars[this.x + 1] = ''; line.styles[this.x + 1] = this.style }
    line.revision++; this.x += width
  }
  private clear(line: Line, from: number, to: number) { for (let i = from; i <= to; i++) { line.chars[i] = ' '; line.styles[i] = this.style }; line.revision++ }
  private restoreCursor() { [this.x, this.y, this.pen] = this.saved; this.pen = { ...this.pen }; this.x = Math.max(0, Math.min(this.x, this.cols - 1)); this.y = Math.max(0, Math.min(this.y, this.rows - 1)); this.setPen() }
  private setPen() { const key = JSON.stringify(this.pen); const existing = this.penIds.get(key); if (existing !== undefined) this.style = existing; else if (this.pens.length < 4096) { this.style = this.pens.length; this.pens.push({ ...this.pen }); this.penIds.set(key, this.style) } else this.style = 0 }
  private sgr(values: number[]) {
    for (let i = 0; i < values.length; i++) {
      const n = values[i]!
      if (n === 0) this.pen = {}
      else if (n === 1) this.pen.bold = true
      else if (n === 3) this.pen.italic = true
      else if (n === 4) this.pen.underline = true
      else if (n === 7) this.pen.inverse = true
      else if (n === 22) delete this.pen.bold
      else if (n === 23) delete this.pen.italic
      else if (n === 24) delete this.pen.underline
      else if (n === 27) delete this.pen.inverse
      else if (n === 39) delete this.pen.fg
      else if (n === 49) delete this.pen.bg
      else if (n >= 30 && n <= 37) this.pen.fg = n - 30
      else if (n >= 40 && n <= 47) this.pen.bg = n - 40
      else if (n >= 90 && n <= 97) this.pen.fg = n - 90 + 8
      else if (n >= 100 && n <= 107) this.pen.bg = n - 100 + 8
      else if (n === 38 || n === 48) {
        const key = n === 38 ? 'fg' : 'bg'
        if (values[i + 1] === 5 && values[i + 2] !== undefined) { this.pen[key] = Math.max(0, Math.min(255, values[i + 2]!)); i += 2 }
        else if (values[i + 1] === 2 && values[i + 4] !== undefined) { this.pen[key] = `rgb(${values.slice(i + 2, i + 5).map(v => Math.min(255, Math.max(0, v))).join(',')})`; i += 4 }
      }
    }
    this.setPen()
  }
  private csi(final: string) {
    const privateMode = this.sequence.startsWith('?')
    const values = this.sequence.replace(/^[?>!]/, '').split(';').flatMap(part => { const fields = part.split(':'); if (final === 'm' && (fields[0] === '38' || fields[0] === '48') && fields[1] === '2' && fields.length === 6) fields.splice(2, 1); return fields.map(v => Number(v) || 0) })
    const n = Math.max(1, Math.min(512, values[0] || 1)), x = this.x, y = this.y
    if (final === 'n' && values[0] === 6) this.reply(`\x1b[${this.y - (this.origin ? this.top : 0) + 1};${Math.min(this.x, this.cols - 1) + 1}R`)
    else if (final === 'n' && values[0] === 5) this.reply('\x1b[0n')
    else if (final === 'c') this.reply('\x1b[?1;2c')
    else if (final === 'm') this.sgr(values)
    else if (final === 'A') this.y = Math.max(this.origin ? this.top : 0, y - n)
    else if (final === 'B' || final === 'e') this.y = Math.min(this.origin ? this.bottom : this.rows - 1, y + n)
    else if (final === 'C' || final === 'a') this.x = Math.min(this.cols - 1, x + n)
    else if (final === 'D') this.x = Math.max(0, x - n)
    else if (final === 'E') { this.y = Math.min(this.origin ? this.bottom : this.rows - 1, y + n); this.x = 0 }
    else if (final === 'F') { this.y = Math.max(this.origin ? this.top : 0, y - n); this.x = 0 }
    else if (final === 'G' || final === '`') this.x = Math.min(this.cols - 1, n - 1)
    else if (final === 'd') this.y = Math.min(this.origin ? this.bottom : this.rows - 1, (this.origin ? this.top : 0) + n - 1)
    else if (final === 'H' || final === 'f') { this.y = Math.min(this.origin ? this.bottom : this.rows - 1, (this.origin ? this.top : 0) + (values[0] || 1) - 1); this.x = Math.min(this.cols - 1, (values[1] || 1) - 1) }
    else if (final === 'K') { const m = values[0]; this.clear(this.screen[y]!, m === 0 ? Math.min(x, this.cols - 1) : 0, m === 1 ? Math.min(x, this.cols - 1) : this.cols - 1) }
    else if (final === 'J') {
      const m = values[0]
      if (m === 3) { this.history = []; this.historyCells = 0 }
      else { if (m === 0 || m === 2) { if (m === 0) this.clear(this.screen[y]!, Math.min(x, this.cols - 1), this.cols - 1); for (let row = m === 0 ? y + 1 : 0; row < this.rows; row++) this.screen[row] = blank() }; if (m === 1) { for (let row = 0; row < y; row++) this.screen[row] = blank(); this.clear(this.screen[y]!, 0, Math.min(x, this.cols - 1)) } }
    } else if (final === 's') this.saved = [x, y, { ...this.pen }]
    else if (final === 'u') this.restoreCursor()
    else if (final === 'r' && !privateMode) { this.top = Math.max(0, Math.min(this.rows - 2, (values[0] || 1) - 1)); this.bottom = Math.min(this.rows - 1, Math.max(this.top + 1, (values[1] || this.rows) - 1)); this.x = 0; this.y = this.origin ? this.top : 0 }
    else if (final === 'S' || final === 'T') { for (let i = 0; i < n; i++) this.scroll(final === 'S') }
    else if (final === 'L' || final === 'M') { if (y >= this.top && y <= this.bottom) for (let i = 0; i < Math.min(n, this.bottom - y + 1); i++) { if (final === 'L') { this.screen.splice(y, 0, blank()); this.screen.splice(this.bottom + 1, 1) } else { this.screen.splice(y, 1); this.screen.splice(this.bottom, 0, blank()) } } }
    else if (final === 'P' || final === '@') { const line = this.screen[y]!; if (final === 'P') { line.chars.splice(x, n); line.styles.splice(x, n) } else { line.chars.splice(x, 0, ...Array(n).fill(' ')); line.styles.splice(x, 0, ...Array(n).fill(this.style)); line.chars.length = Math.min(line.chars.length, this.cols); line.styles.length = line.chars.length }; line.revision++ }
    else if (final === 'X') this.clear(this.screen[y]!, x, Math.min(this.cols - 1, x + n - 1))
    else if ((final === 'h' || final === 'l') && !privateMode && values.includes(4)) this.insert = final === 'h'
    else if ((final === 'h' || final === 'l') && privateMode) for (const mode of values) {
      const on = final === 'h'
      if (mode === 6) { this.origin = on; this.x = 0; this.y = on ? this.top : 0 }
      if (mode === 1048) { if (on) this.saved = [x, y, { ...this.pen }]; else this.restoreCursor() }
      if (mode === 25) this.cursorVisible = on
      if (mode === 7) this.wrap = on
      if (mode === 1) this.applicationCursor = on
      if (mode === 2004) this.bracketedPaste = on
      if ([9, 1000, 1002, 1003].includes(mode)) this.mouseTracking = on ? mode : 0
      if (mode === 1004) this.focusReporting = on
      if (mode === 1005) this.mouseUtf8 = on
      if (mode === 1006) this.mouseSgr = on
      if (mode === 1015) this.mouseUrxvt = on
      if (mode === 1049 || mode === 1047 || mode === 47) {
        if (on && !this.normal) { this.normal = { screen: this.screen, x, y, top: this.top, bottom: this.bottom, pen: mode === 1049 ? { ...this.pen } : undefined }; this.screen = mode === 47 && this.alternateBuffer ? this.alternateBuffer : Array.from({ length: this.rows }, blank); while (this.screen.length < this.rows) this.screen.push(blank()); this.screen.length = this.rows; this.x = this.y = this.top = 0; this.bottom = this.rows - 1 }
        else if (!on && this.normal) { const normal = this.normal; this.alternateBuffer = mode === 47 ? this.screen : undefined; this.normal = undefined; this.screen = normal.screen; if (normal.pen) { this.pen = normal.pen; this.setPen() }; this.x = normal.x; this.y = normal.y; this.top = Math.min(normal.top, this.rows - 2); this.bottom = Math.max(this.top + 1, Math.min(normal.bottom, this.rows - 1)); this.x = Math.min(this.x, this.cols - 1); while (this.screen.length < this.rows) this.screen.push(blank()); this.screen.length = this.rows; this.y = Math.min(this.y, this.rows - 1) }
      }
    }
  }
  write(text: string) {
    for (const char of text) {
      if (this.mode === 'text') {
        if (char === '\x1b') this.mode = 'esc'
        else if (char === '\r') this.x = 0
        else if (char === '\n' || char === '\v' || char === '\f') this.linefeed()
        else if (char === '\b') this.x = Math.max(0, this.x - 1)
        else if (char === '\t') this.x = Math.min(this.cols - 1, (Math.floor(this.x / 8) + 1) * 8)
        else if (char >= ' ' && char !== '\x7f') this.put(char)
      } else if (this.mode === 'esc') {
        this.sequence = ''
        if (char === '[') this.mode = 'csi'
        else if (char === ']') this.mode = 'osc'
        else if ('P^_'.includes(char)) this.mode = 'ignore'
        else if ('()*+'.includes(char)) this.mode = 'charset'
        else { this.mode = 'text'; if (char === '7') this.saved = [this.x, this.y, { ...this.pen }]; else if (char === '8') this.restoreCursor(); if (char === 'D') this.linefeed(); if (char === 'E') { this.x = 0; this.linefeed() }; if (char === 'M') { if (this.y === this.top) this.scroll(false); else this.y = Math.max(0, this.y - 1) }; if (char === 'c') { this.normal = undefined; this.alternateBuffer = undefined; this.top = 0; this.bottom = this.rows - 1; this.origin = this.insert = false; this.wrap = this.cursorVisible = true; this.applicationCursor = this.bracketedPaste = false; this.mouseTracking = 0; this.mouseSgr = this.mouseUtf8 = this.mouseUrxvt = this.focusReporting = false; this.saved = [0, 0, {}]; this.screen = Array.from({ length: this.rows }, blank); this.x = this.y = 0; this.pen = {}; this.setPen() } }
      } else if (this.mode === 'csi') {
        if (char >= '@' && char <= '~') { this.csi(char); this.mode = 'text'; this.sequence = '' }
        else if (this.sequence.length < 1024) this.sequence += char
        else { this.sequence = ''; this.mode = 'text' }
      } else if (this.mode === 'osc' || this.mode === 'oscEsc') {
        if (char === '\x07' || (this.mode === 'oscEsc' && char === '\\')) { const match = /^(?:0|2);(.*)$/s.exec(this.sequence); if (match) this.title = match[1]!.slice(0, 200); this.sequence = ''; this.mode = 'text' }
        else if (char === '\x1b') this.mode = 'oscEsc'
        else { this.mode = 'osc'; if (this.sequence.length < 4096) this.sequence += char }
      } else if (this.mode === 'charset') this.mode = 'text'
      else if (this.mode === 'ignore') { if (char === '\x1b') this.mode = 'ignoreEsc' }
      else { this.mode = char === '\\' ? 'text' : 'ignore' }
    }
  }
  lines() { return this.alternate ? this.screen : [...this.history, ...this.screen] }
  text() { return this.lines().map(line => line.chars.join('').trimEnd()).join('\n') }
  runs(line: Line): Run[] {
    const runs: Run[] = []
    let last = -1
    for (let i = 0; i < Math.min(line.chars.length, this.cols); i++) {
      const id = line.styles[i] ?? 0, text = line.chars[i] ?? ' '
      if (id !== last) { runs.push({ text, style: this.pens[id] ?? {}, columns: 1 }); last = id }
      else { const run = runs[runs.length - 1]!; run.text += text; run.columns++ }
    }
    return runs
  }
}
