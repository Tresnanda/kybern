import { expect, test } from 'bun:test'
import { contrastRatio, diffSyntaxTheme } from './syntaxPalette.ts'
import { desktopDiffTheme } from './diff.ts'
import { themeFor } from '../theme.ts'

const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]

test('every token reaches the contrast floor on the darkest and lightest row tints', () => {
  for (const [variant, bgs] of [['dark', ['#181818', '#1f3a28', '#432326']], ['light', ['#ffffff', '#e6f4ea', '#fbe4e4']]] as const) {
    for (const [contrast, floor] of [[false, 4.5], [true, 7]] as const) {
      const theme = diffSyntaxTheme(variant, [...bgs], contrast)
      for (const [kind, color] of Object.entries(theme)) {
        for (const bg of bgs) expect(contrastRatio(rgb(color!), rgb(bg))).toBeGreaterThanOrEqual(floor - 0.01)
        expect(kind).toBeTruthy()
      }
    }
  }
})

test('keywords, strings and functions stay distinct colours', () => {
  for (const variant of ['dark', 'light'] as const) {
    const t = diffSyntaxTheme(variant, [variant === 'dark' ? '#181818' : '#ffffff'])
    expect(new Set([t.keyword, t.string, t.function, t.number, t.typeName, t.comment]).size).toBe(6)
  }
})

test('syntax colours are opt-in: transcript and dock diffs stay plain', () => {
  for (const variant of ['dark', 'light'] as const) {
    const t = themeFor(variant, 'none', false, false)
    const plain = desktopDiffTheme(t, false)
    expect(plain.diff?.syntaxHighlight).toBe(false)
    expect(plain.syntax).toBeUndefined()
    const colored = desktopDiffTheme(t, false, 13, { syntax: true })
    expect(colored.diff?.syntaxHighlight).toBe(true)
    expect(colored.syntax?.keyword).toMatch(/^#[0-9a-f]{6}$/)
  }
})

test('Increase contrast and glass themes still get a palette', () => {
  const t = themeFor('light', 'window', true, false)
  expect(desktopDiffTheme(t, false, 13, { syntax: true, glass: true }).syntax?.string).toBeTruthy()
})
