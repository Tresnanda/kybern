// The control system's tokens (ADE-55, Direction C "Tinted state"): the radius, height and spacing scales every control
// reads, and the colour tokens of the control fills. Spec: `.kybern-artifacts/ade-55-design/spec.md` §1, §5.
//
// Colour means state: the commit action and every selection share one translucent accent tint, never a solid slab.
// Neutrals are ink alphas, so a control composites on any surface, including whole-window glass (`platform/glass.ts` rule),
// and the dark column serves Solid dark and glass alike. Nothing outside this file hard-codes 8/10/14 or 28/32.
import type { Theme } from '../theme.ts'
import { useTheme } from '../ui.tsx'

/** Radius scale. `field` and `check` are named uses of `md`/`xs`; the segmented track is thumb + 2 (concentric). */
export const RADIUS = { xs: 5, sm: 8, md: 9, lg: 11, xl: 13, field: 9, check: 5, kbd: 5, pill: 999, segTrack: 11, segThumb: 9 } as const

/** Control heights: xs 20 (kbd 18), sm 24 rows and token chips, md 28 default, lg 32 dialogs, xl 36 (composer Send is 32). */
export const HEIGHT = { xs: 20, sm: 24, md: 28, lg: 32, xl: 36 } as const

/** The 4 pt grid (2, 4, 6, 8, 12, 16, 20, 24, 32). */
export const SPACE = { px: 1, xxs: 2, xs: 4, sm: 6, md: 8, lg: 12, xl: 16, xxl: 20, huge: 24, max: 32 } as const

export type ControlSize = 'sm' | 'md' | 'lg'

/** Per-size geometry of buttons, selects, chips and fields: height, inline padding, label and glyph size, glyph-to-label gap. */
export const CONTROL = {
  sm: { height: HEIGHT.sm, padX: 8, iconPad: 6, font: 12, line: 16, glyph: 14, iconOnly: 14, gap: 4, radius: RADIUS.sm },
  md: { height: HEIGHT.md, padX: 12, iconPad: 10, font: 13, line: 18, glyph: 14, iconOnly: 16, gap: 6, radius: RADIUS.md },
  lg: { height: HEIGHT.lg, padX: 14, iconPad: 12, font: 14, line: 20, glyph: 16, iconOnly: 16, gap: 6, radius: RADIUS.lg },
} as const satisfies Record<ControlSize, unknown>

const INK = { dark: [252, 252, 252], light: [13, 13, 13] } as const
const ACC = { dark: [51, 134, 214], light: [1, 105, 204] } as const
const rgba = (c: readonly number[], a: number) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`

/** The colour tokens of Direction C for one variant. */
export interface Controls {
  /** `ink(a)` and `acc(a)`: the ink and accent at an alpha. */
  ink: (a: number) => string
  acc: (a: number) => string
  accent: string
  /** The accent-tinted label colour (primary label, selected segment, active toolbar glyph). */
  accentFg: string
  primary: { bg: string; hover: string; press: string; fg: string }
  secondary: { bg: string; hover: string; press: string; fg: string }
  ghost: { fg: string; hover: string; press: string }
  destructive: { bg: string; hover: string; press: string; fg: string }
  /** The label colour of a `danger` secondary or ghost button. */
  danger: string
  disabled: { bg: string; fg: string }
  /** The focus ring: 2 px of the accent, outside the shape. */
  focus: string
  field: { bg: string; hover: string; focusWash: string; invalid: string; invalidRing: string }
  chip: { bg: string; hover: string; open: string; selBg: string; selFg: string }
  token: { bg: string }
  segmented: { track: string; thumb: string; selFg: string }
  check: { edge: string; hoverEdge: string; on: string; tick: string }
  radio: { dot: string }
  iconButton: { activeBg: string; activeFg: string }
  send: { bg: string; fg: string }
  /** A selected `RadioRow` / question option. */
  optionSelected: string
  kbd: { edge: string; fg: string }
  /** The quiet property picker's hover fill (Tasks, Notes; neutral ink, never tinted). */
  prop: { hover: string }
  slider: { fill: string; track: string }
  switch: { on: string; off: string }
}

const cache = new WeakMap<Theme, Controls>()

export function controlsFor(t: Theme): Controls {
  let c = cache.get(t)
  if (c) return c
  const light = t.variant === 'light'
  const ink = (a: number) => rgba(INK[t.variant], a)
  const acc = (a: number) => rgba(ACC[t.variant], a)
  const accentFg = light ? '#0160bd' : '#8cc1f4'
  c = {
    ink, acc,
    accent: light ? '#0169cc' : '#3386d6',
    accentFg,
    primary: { bg: acc(light ? 0.11 : 0.24), hover: acc(light ? 0.16 : 0.31), press: acc(light ? 0.2 : 0.19), fg: accentFg },
    secondary: { bg: ink(light ? 0.05 : 0.075), hover: ink(light ? 0.08 : 0.105), press: ink(light ? 0.1 : 0.06), fg: t.text },
    ghost: { fg: light ? 'rgba(13, 13, 13, 0.68)' : 'rgba(252, 252, 252, 0.70)', hover: ink(0.06), press: ink(0.09) },
    destructive: { bg: light ? 'rgba(224, 46, 42, 0.10)' : 'rgba(255, 92, 84, 0.18)', hover: light ? 'rgba(224, 46, 42, 0.15)' : 'rgba(255, 92, 84, 0.25)', press: light ? 'rgba(224, 46, 42, 0.15)' : 'rgba(255, 92, 84, 0.25)', fg: light ? '#c42520' : '#ff8a83' },
    danger: light ? '#c42520' : '#ff8a83',
    disabled: { bg: ink(0.035), fg: t.textTertiary },
    focus: acc(0.85),
    field: { bg: ink(light ? 0.04 : 0.06), hover: ink(0.1), focusWash: acc(0.07), invalid: '#e02e2a', invalidRing: 'rgba(224, 46, 42, 0.18)' },
    chip: { bg: ink(light ? 0.045 : 0.06), hover: ink(light ? 0.075 : 0.09), open: ink(0.11), selBg: acc(light ? 0.11 : 0.24), selFg: accentFg },
    token: { bg: ink(light ? 0.06 : 0.08) },
    segmented: { track: ink(light ? 0.05 : 0.06), thumb: acc(light ? 0.12 : 0.26), selFg: accentFg },
    check: { edge: ink(0.26), hoverEdge: t.textSecondary, on: light ? '#0169cc' : '#3386d6', tick: '#ffffff' },
    radio: { dot: light ? '#ffffff' : '#2a2a2a' },
    iconButton: { activeBg: acc(light ? 0.11 : 0.24), activeFg: accentFg },
    send: { bg: acc(light ? 0.14 : 0.3), fg: light ? '#0160bd' : '#a6d0f7' },
    optionSelected: acc(0.12),
    kbd: { edge: ink(0.14), fg: t.textSecondary },
    prop: { hover: ink(0.06) },
    slider: { fill: light ? '#0169cc' : '#3386d6', track: ink(0.12) },
    switch: { on: light ? '#0169cc' : '#3386d6', off: light ? '#d4d4d4' : '#4a4a4a' },
  }
  cache.set(t, c)
  return c
}

/** The control tokens for the active theme (a stable object per theme, so readers do not render again). */
export const useControls = (): Controls => controlsFor(useTheme())
