// Colors come from the desktop's own theme code, run here in Bun, so this client
// paints exactly the tokens `applyAppearance` writes onto <html>. GPUIX parses
// hex, rgb()/rgba() and oklch(), but not `color-mix()` or `var()`; those are
// resolved below. The window material (`platform/translucency.ts`) is an override
// map over the desktop's opaque variables, chosen by scope.
import {
  DEFAULT_THEME_STATE,
  buildThemeCssVariables,
  type ThemeVariant,
} from '../../desktop/src/lib/kit/theme/theme.logic.ts'
import { materialVars, type WindowScope } from './platform/translucency.ts'

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
  if (v === 'black') return [0, 0, 0, 1]
  if (v === 'white') return [255, 255, 255, 1]
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

/** A `color-mix()` whose arguments hold no other `color-mix()`, so nested mixes resolve from the inside out. */
const INNERMOST_MIX = /color-mix\((?:(?!color-mix\()(?:[^()]|\([^()]*\)))*\)/g

function mixColors(v: string, vars: Vars, depth: number): string {
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

function resolve(value: string, vars: Vars, depth = 0): string {
  let v = value.trim()
  if (depth > 8) return v
  v = v.replace(/var\((--[\w-]+)\)/g, (_, name: string) => resolve(vars[name] ?? 'transparent', vars, depth + 1))
  for (let pass = 0; pass < 4 && v.includes('color-mix('); pass++) {
    const next = v.replace(INNERMOST_MIX, (m) => mixColors(m, vars, depth))
    if (next === v) break
    v = next
  }
  return v === 'transparent' ? 'rgba(0, 0, 0, 0)' : v
}

/** Paint a translucent colour over an opaque one; overlays must be opaque in GPUIX. */
export function over(top: string, base: string): string {
  const t = parseColor(top)
  const b = parseColor(base)
  if (!t || !b) return top
  const ch = (i: number) => t[i] * t[3] + b[i] * (1 - t[3])
  return rgba([ch(0), ch(1), ch(2), 1])
}

function build(variant: ThemeVariant, scope: WindowScope = 'none', opacity = 90, contrast = false, reduceTransparency = false) {
  const pack = {
    codeThemeId: DEFAULT_THEME_STATE.codeThemeIds[variant],
    theme: DEFAULT_THEME_STATE.chromeThemes[variant],
  }
  // The opaque variables (`isMac: false`); the scope's material is applied over them below.
  const base = buildThemeCssVariables(pack, variant, { electron: true, isMac: false, systemUiFont: true }).variables as Vars
  const opaque: Vars = { ...base, '--app-opaque-content-surface': base['--color-background-surface']! }
  const raw: Vars = { ...opaque, ...materialVars(variant, opaque, scope, opacity) }
  const v = (name: string) => resolve(raw[name] ?? 'transparent', raw)
  const popover = v('--app-opaque-popover')
  const dense = scope === 'none' ? popover : v('--app-glass-dense-surface')
  const raised = scope === 'window' ? v('--app-glass-raised-surface') : ''
  return {
    variant,
    /** Which surfaces are glass: none (Solid, Reduce transparency, Increase contrast), the sidebar only, or the whole window. */
    scope,
    // Task status colours, desktop styles/tasks.css:17–20 and 53–56.
    taskRun: variant === 'dark' ? 'oklch(0.72 0.13 255)' : 'oklch(0.55 0.17 258)',
    taskReview: variant === 'dark' ? 'oklch(0.8 0.13 78)' : 'oklch(0.68 0.15 68)',
    taskDone: variant === 'dark' ? 'oklch(0.7 0.1 152)' : 'oklch(0.58 0.12 152)',
    taskUrgent: variant === 'dark' ? 'oklch(0.7 0.15 42)' : 'oklch(0.62 0.17 40)',
    raw,
    v,
    frame: v('--app-frame-surface'),
    sidebar: v('--app-sidebar-surface'),
    /** A control or card fill. Never glass; page and pane backgrounds use `content`. */
    surface: v('--color-background-surface'),
    /** `--app-content-surface`: route content (workspace card, dock body, subagent page, terminal), clear on whole-window glass. */
    content: v('--app-content-surface'),
    glass: {
      /** The app root fill: whole window → coat, Sidebar only → shell, none → the opaque frame. */
      window: v('--app-frame-surface'),
      /** Whole window → raised tint; '' elsewhere (unused). */
      raised,
      /** Menus, pickers, selects, comboboxes: whole window → raised, Sidebar only → dense, none → popover. */
      menu: scope === 'window' ? raised : dense,
      /** Tooltips, hover cards, toasts. */
      dense,
      /** The composer: whole window → dense (no transcript edge mask on GPUIX), else its own fill. */
      composer: scope === 'window' ? dense : variant === 'dark' ? v('--composer-surface') : '#ffffff',
      settingsCard: v('--app-settings-card-surface'),
      settingsCardBorder: v('--app-settings-card-border'),
    },
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
    /** `--app-surface-divider` (`kit.css:102`, set inside a layer the token build doesn't see): header and chrome row dividers. */
    surfaceDivider: resolve('color-mix(in srgb, var(--color-border) 60%, transparent)', raw),
    hover: v('--color-token-list-hover-background'),
    selected: v('--color-token-list-active-selection-background'),
    buttonSecondary: v('--color-background-button-secondary'),
    buttonSecondaryHover: v('--color-background-button-secondary-hover'),
    buttonTertiaryHover: v('--color-background-button-tertiary-hover'),
    buttonPrimary: v('--color-background-button-primary'),
    buttonPrimaryText: v('--color-text-button-primary'),
    inputGroupFill: variant === 'dark' ? resolve('color-mix(in srgb, var(--input) 32%, transparent)', raw) : v('--background'),
    composer: v('--composer-surface'),
    composerFocusBorder: v('--app-composer-focus-border'),
    codeSurface: v('--app-chat-code-surface'),
    popover,
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
    /** `--app-card-edge` (`kit.css:139-150`): the border under Increase contrast. */
    cardEdge: contrast ? resolve('var(--color-border)', raw) : variant === 'dark' ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.10)',
    /** Accessibility › Display, so a change re-renders every themed view (src/platform/material.ts). */
    contrast,
    reduceTransparency,
  }
}

export type Theme = ReturnType<typeof build>

export const THEMES: Record<ThemeVariant, Theme> = { dark: build('dark'), light: build('light') }

const derived = new Map<string, Theme>()
const MAX_DERIVED = 16
/**
 * The theme for a window scope and glass opacity, with the accessibility display options applied. Built once per
 * combination in a bounded map (an opacity drag visits many), oldest evicted first. Scope none ignores the opacity.
 */
export function themeFor(variant: ThemeVariant, scope: WindowScope, opacity: number, contrast: boolean, reduceTransparency: boolean): Theme {
  if (scope === 'none' && !contrast && !reduceTransparency) return THEMES[variant]
  const key = `${variant}:${scope}:${scope === 'none' ? '' : opacity}:${contrast}:${reduceTransparency}`
  let theme = derived.get(key)
  if (!theme) {
    theme = build(variant, scope, opacity, contrast, reduceTransparency)
    derived.set(key, theme)
    if (derived.size > MAX_DERIVED) derived.delete(derived.keys().next().value!)
  } else {
    // Refresh recency so the theme in use is the last to go.
    derived.delete(key)
    derived.set(key, theme)
  }
  return theme
}
export const derivedThemeCount = () => derived.size

export const FONT_UI = '.SystemUIFont'
export const FONT_MONO = 'Menlo'
