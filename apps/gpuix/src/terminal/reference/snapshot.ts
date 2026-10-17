import { cellText, type VT } from '../vt.ts'

const hex = (n: number) => n.toString(16).padStart(2, '0')
const color = (value: string | number | undefined) => value === undefined ? '-' : typeof value === 'number' ? String(value) : '#' + /rgb\((\d+),(\d+),(\d+)\)/.exec(value)!.slice(1).map(v => hex(Number(v))).join('')

/** The same cell encoding `dump-xterm.ts` records from xterm.js. */
export function snapshot(vt: VT) {
  const rows = vt.lines().map(line => ({
    wrapped: !!(line as { wrapped?: boolean }).wrapped,
    cells: Array.from({ length: vt.cols }, (_, x) => {
      const pen = vt.pens[line.styles[x] ?? 0] ?? {}, ch = cellText(line.chars[x])
      const flags = [pen.bold && 'b', pen.italic && 'i', (pen.underline || pen.link) && 'u', pen.inverse && 'v', pen.dim && 'd', pen.strike && 's', pen.hidden && 'h', pen.blink && 'k', pen.overline && 'o'].filter(Boolean).join('')
      return `${ch}|${color(pen.fg)}|${color(pen.bg)}|${flags}`
    }),
  }))
  return rows
}

