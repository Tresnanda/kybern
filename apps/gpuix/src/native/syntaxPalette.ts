import type { SyntaxTheme } from '@gpuix/native/host'

/**
 * Editor token colours for native diffs: Atom One Dark / One Light, the palettes Zed's One themes are built on. Each
 * entry is the editor colour; `diffSyntaxTheme` darkens (light) or lightens (dark) any that would read below the WCAG
 * contrast floor on the diff's own row backgrounds, so the palette stays recognisable and still readable on the
 * added/deleted tints, and stronger under Increase contrast.
 */
type Palette = Required<Pick<SyntaxTheme, 'comment' | 'keyword' | 'string' | 'stringSpecial' | 'escape' | 'number' | 'boolean' | 'typeName' | 'typeBuiltin' | 'constructor' | 'function' | 'functionBuiltin' | 'macroName' | 'property' | 'constant' | 'variableSpecial' | 'parameter' | 'operator' | 'punctuation' | 'tag' | 'attribute' | 'label' | 'invalid'>>

const ONE_DARK: Palette = {
  comment: '#7f848e', keyword: '#c678dd', string: '#98c379', stringSpecial: '#56b6c2', escape: '#56b6c2', number: '#d19a66', boolean: '#d19a66',
  typeName: '#e5c07b', typeBuiltin: '#e5c07b', constructor: '#61afef', function: '#61afef', functionBuiltin: '#56b6c2', macroName: '#61afef',
  property: '#e06c75', constant: '#d19a66', variableSpecial: '#e06c75', parameter: '#abb2bf', operator: '#56b6c2', punctuation: '#abb2bf',
  tag: '#e06c75', attribute: '#d19a66', label: '#61afef', invalid: '#f44747',
}
const ONE_LIGHT: Palette = {
  comment: '#7c7e86', keyword: '#a626a4', string: '#50a14f', stringSpecial: '#0184bc', escape: '#0184bc', number: '#986801', boolean: '#986801',
  typeName: '#c18401', typeBuiltin: '#c18401', constructor: '#4078f2', function: '#4078f2', functionBuiltin: '#0184bc', macroName: '#4078f2',
  property: '#e45649', constant: '#986801', variableSpecial: '#e45649', parameter: '#383a42', operator: '#0184bc', punctuation: '#383a42',
  tag: '#e45649', attribute: '#986801', label: '#4078f2', invalid: '#ca1243',
}

type Rgb = [number, number, number]
const BASE: Record<'dark' | 'light', Rgb> = { dark: [24, 24, 24], light: [255, 255, 255] }

/** `#rgb`, `#rrggbb`, `rgb()` or `rgba()` composited over `base`; null for anything else. */
function parse(color: string, base: Rgb): Rgb | null {
  let ch: number[], a = 1
  const hex = color.trim().match(/^#([0-9a-f]{3,8})$/i)?.[1]
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map(c => c + c).join('') : hex
    if (full.length !== 6 && full.length !== 8) return null
    ch = [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16))
    if (full.length === 8) a = parseInt(full.slice(6, 8), 16) / 255
  } else {
    const m = color.match(/rgba?\(([^)]+)\)/)
    if (!m) return null
    const parts = m[1]!.split(/[\s,/]+/).filter(Boolean).map(Number)
    if (parts.length < 3 || parts.some(Number.isNaN)) return null
    ch = parts.slice(0, 3)
    a = parts[3] ?? 1
  }
  return [0, 1, 2].map(i => ch[i]! * a + base[i]! * (1 - a)) as Rgb
}

const lin = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
const luminance = ([r, g, b]: Rgb) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}
const hex = ([r, g, b]: Rgb) => `#${[r, g, b].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`

/** `color` pushed toward black or white in small steps until it reaches `min` against every background. */
function atContrast(color: Rgb, backgrounds: Rgb[], toward: Rgb, min: number): Rgb {
  let out = color
  for (let step = 0; step <= 20; step++) {
    out = color.map((v, i) => v + (toward[i]! - v) * (step / 20)) as Rgb
    if (backgrounds.every(bg => contrastRatio(out, bg) >= min)) break
  }
  return out
}

const cache = new Map<string, SyntaxTheme>()

/**
 * The syntax colours for a diff whose rows sit on `backgrounds` (the body and its added, deleted and hunk tints; a
 * translucent one is read over the variant's base). Floor 4.5:1, or 7:1 under Increase contrast.
 */
export function diffSyntaxTheme(variant: 'dark' | 'light', backgrounds: string[], contrast = false): SyntaxTheme {
  const base = BASE[variant]
  const solid = backgrounds.map(b => parse(b, base)).filter((b): b is Rgb => b !== null)
  const key = `${variant}:${contrast}:${solid.map(hex).join(',')}`
  const cached = cache.get(key)
  if (cached) return cached
  const palette = variant === 'dark' ? ONE_DARK : ONE_LIGHT
  const toward: Rgb = variant === 'dark' ? [255, 255, 255] : [0, 0, 0]
  const min = contrast ? 7 : 4.5
  const theme = Object.fromEntries(Object.entries(palette).map(([kind, color]) => [kind, hex(atContrast(parse(color, base)!, solid, toward, min))])) as unknown as SyntaxTheme
  cache.set(key, theme)
  return theme
}
