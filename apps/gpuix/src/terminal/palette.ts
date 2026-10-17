// The desktop terminal palette (views/Terminal.tsx DARK / LIGHT). Colours it does not list
// (bright red to bright white) are xterm.js 6.0.0's defaults, so they are the same here.
import { paletteColor, type RGB, type TerminalColors } from './vt.ts'

const XTERM_BRIGHT = ['#ef2929', '#8ae234', '#fce94f', '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec']
const DARK = {
  foreground: 'rgb(237,241,247)', cursor: 'rgb(180,203,255)', selection: 'rgba(180,203,255,0.25)',
  ansi: ['rgb(24,30,38)', 'rgb(255,122,142)', 'rgb(134,231,149)', 'rgb(244,205,114)', 'rgb(137,190,255)', 'rgb(208,176,255)', 'rgb(124,232,237)', 'rgb(210,218,230)', 'rgb(110,120,136)', ...XTERM_BRIGHT],
}
const LIGHT = {
  foreground: 'rgb(28,33,41)', cursor: 'rgb(38,56,78)', selection: 'rgba(37,63,99,0.2)',
  ansi: ['rgb(44,53,66)', 'rgb(191,70,87)', 'rgb(60,126,86)', 'rgb(146,112,35)', 'rgb(72,102,163)', 'rgb(132,86,149)', 'rgb(53,127,141)', 'rgb(210,215,223)', 'rgb(112,123,140)', ...XTERM_BRIGHT],
}
export interface TerminalPalette { foreground: string; cursor: string; selection: string; ansi: string[] }
export const terminalPalette = (variant: 'dark' | 'light'): TerminalPalette => variant === 'dark' ? DARK : LIGHT

export type RGBA = [number, number, number, number]
/** `#rgb`, `#rrggbb`, `rgb(...)` and `rgba(...)`; undefined for anything else. */
export function parseCss(color: string): RGBA | undefined {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)
  if (hex) {
    const h = hex[1]!.length === 3 ? hex[1]!.replace(/./g, c => c + c) : hex[1]!
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1]
  }
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/.exec(color)
  return fn ? [Number(fn[1]), Number(fn[2]), Number(fn[3]), fn[4] === undefined ? 1 : Number(fn[4])] : undefined
}
export const css = (c: RGB) => `rgb(${c[0]},${c[1]},${c[2]})`
const rgbOf = (color: string): RGB => { const p = parseCss(color) ?? [0, 0, 0, 1]; return [p[0], p[1], p[2]] }
/** What OSC 4/10/11/12 report: the terminal theme over the app surface. */
export function terminalColors(variant: 'dark' | 'light', surface: string): TerminalColors {
  const palette = terminalPalette(variant), ansi = palette.ansi.map(rgbOf)
  return { foreground: rgbOf(palette.foreground), background: rgbOf(surface), cursor: rgbOf(palette.cursor), ansi: i => ansi[i]! }
}
/** An ANSI palette index as CSS (0-15 theme, then the 6x6x6 cube and the grey ramp). */
export function indexedColor(index: number, palette: TerminalPalette, overrides?: Map<number, RGB>): string {
  const override = overrides?.get(index)
  if (override) return css(override)
  if (index < 16) return palette.ansi[index]!
  return css(paletteColor(index))
}
/** `fg` over `bg` at `amount` (0 = bg, 1 = fg); used for faint text, which xterm draws at half opacity. */
export function blend(fg: string, bg: string, amount: number): string {
  const a = parseCss(fg), b = parseCss(bg)
  if (!a || !b) return fg
  return `rgb(${[0, 1, 2].map(i => Math.round(a[i]! * amount + b[i]! * (1 - amount))).join(',')})`
}
