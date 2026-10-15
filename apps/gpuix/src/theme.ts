// Colors come from the desktop's own theme code, run here in Bun, so this client
// paints exactly the tokens `applyAppearance` writes onto <html>. GPUIX parses
// hex, rgb()/rgba() and oklch(), but not `color-mix()` or `var()`; those are
// resolved below.
import {
  DEFAULT_THEME_STATE,
  buildThemeCssVariables,
  type ThemeVariant,
} from '../../desktop/src/lib/kit/theme/theme.logic.ts'

type Vars = Record<string, string>

function hexToRgb(hex: string): [number, number, number, number] {
  const h = hex.replace('#', '')
  const full = h.length <= 4 ? [...h].map((c) => c + c).join('') : h
  const n = (i: number) => parseInt(full.slice(i, i + 2), 16)
  return [n(0), n(2), n(4), full.length === 8 ? n(6) / 255 : 1]
}

function parseColor(value: string): [number, number, number, number] | null {
  const v = value.trim()
  if (v === 'transparent') return [0, 0, 0, 0]
  if (v.startsWith('#')) return hexToRgb(v)
  const m = v.match(/^rgba?\(([^)]+)\)$/)
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number)
    return [parts[0], parts[1], parts[2], parts[3] ?? 1]
  }
  return null
}

const rgba = ([r, g, b, a]: [number, number, number, number]) =>
  `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${Number(a.toFixed(3))})`

function resolve(value: string, vars: Vars, depth = 0): string {
  let v = value.trim()
  if (depth > 8) return v
  v = v.replace(/var\((--[\w-]+)\)/g, (_, name: string) => resolve(vars[name] ?? 'transparent', vars, depth + 1))
  const mix = v.match(/^color-mix\(in (?:srgb|oklab),\s*(.+?)\s+(\d+(?:\.\d+)?)%,\s*(.+?)(?:\s+(\d+(?:\.\d+)?)%)?\)$/)
  if (!mix) return v
  const a = parseColor(resolve(mix[1], vars, depth + 1))
  const b = parseColor(resolve(mix[3], vars, depth + 1))
  if (!a || !b) return v
  const p = Number(mix[2]) / 100
  // Premultiplied mix, as CSS does, so mixing with `transparent` only scales alpha.
  const alpha = a[3] * p + b[3] * (1 - p)
  if (alpha === 0) return 'rgba(0, 0, 0, 0)'
  const ch = (i: number) => (a[i] * a[3] * p + b[i] * b[3] * (1 - p)) / alpha
  return rgba([ch(0), ch(1), ch(2), alpha])
}

/** Paint a translucent colour over an opaque one; overlays must be opaque in GPUIX. */
export function over(top: string, base: string): string {
  const t = parseColor(top)
  const b = parseColor(base)
  if (!t || !b) return top
  const ch = (i: number) => t[i] * t[3] + b[i] * (1 - t[3])
  return rgba([ch(0), ch(1), ch(2), 1])
}

function build(variant: ThemeVariant) {
  const pack = {
    codeThemeId: DEFAULT_THEME_STATE.codeThemeIds[variant],
    theme: DEFAULT_THEME_STATE.chromeThemes[variant],
  }
  const raw = buildThemeCssVariables(pack, variant, { electron: true, isMac: true, systemUiFont: true }).variables as Vars
  const v = (name: string) => resolve(raw[name] ?? 'transparent', raw)
  return {
    variant,
    raw,
    v,
    frame: v('--app-frame-surface'),
    sidebar: v('--app-sidebar-surface'),
    surface: v('--color-background-surface'),
    surfaceUnder: v('--color-background-surface-under'),
    panel: v('--color-background-panel'),
    text: v('--color-text-foreground'),
    textSecondary: v('--color-text-foreground-secondary'),
    textTertiary: v('--color-text-foreground-tertiary'),
    iconPrimary: v('--color-icon-primary'),
    iconSecondary: v('--color-icon-secondary'),
    iconTertiary: v('--color-icon-tertiary'),
    border: v('--color-border'),
    borderLight: v('--color-border-light'),
    borderHeavy: v('--color-border-heavy'),
    hover: v('--color-token-list-hover-background'),
    selected: v('--color-token-list-active-selection-background'),
    buttonSecondary: v('--color-background-button-secondary'),
    buttonSecondaryHover: v('--color-background-button-secondary-hover'),
    buttonTertiaryHover: v('--color-background-button-tertiary-hover'),
    buttonPrimary: v('--color-background-button-primary'),
    buttonPrimaryText: v('--color-text-button-primary'),
    composer: v('--composer-surface'),
    composerFocusBorder: v('--app-composer-focus-border'),
    codeSurface: v('--app-chat-code-surface'),
    popover: v('--app-opaque-popover'),
    link: v('--color-text-accent'),
    accentBlue: v('--color-accent-blue'),
    green: v('--color-accent-green'),
    red: v('--color-accent-red'),
    warning: v('--warning'),
    /** Switch track (`components/kit/switch.tsx`): accent when on; ink 20% over the opaque control fill when off. */
    switchOn: v('--color-text-accent'),
    switchOff: resolve('color-mix(in srgb, var(--color-text-foreground) 20%, var(--color-background-control-opaque))', raw),
    switchOffBorder: resolve('color-mix(in srgb, var(--color-text-foreground) 14%, transparent)', raw),
    /** `--runtime-full-access-accent` (`kit.css:2647-2652`). */
    fullAccess: variant === 'dark' ? '#fe8549' : '#e25505',
  }
}

export type Theme = ReturnType<typeof build>

export const THEMES: Record<ThemeVariant, Theme> = { dark: build('dark'), light: build('light') }

export const FONT_UI = '.SystemUIFont'
export const FONT_MONO = 'Menlo'
