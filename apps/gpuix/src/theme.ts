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
import { SINGLE_FILL, effectiveSurface, glassRecipe, materialCoverage, materialVars, opacityVarsFor, surfaceScale, type WindowScope } from './platform/translucency.ts'

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

/** The desktop's opaque variables for a variant (`isMac: false`); the scope's material is applied over them. */
const opaqueCache: Partial<Record<ThemeVariant, Vars>> = {}
function opaqueVars(variant: ThemeVariant): Vars {
  return opaqueCache[variant] ??= (() => {
    const pack = {
      codeThemeId: DEFAULT_THEME_STATE.codeThemeIds[variant],
      theme: DEFAULT_THEME_STATE.chromeThemes[variant],
    }
    const base = buildThemeCssVariables(pack, variant, { electron: true, isMac: false, systemUiFont: true }).variables as Vars
    return { ...base, '--app-opaque-content-surface': base['--color-background-surface']! }
  })()
}

/**
 * Everything in a theme is the same at every glass opacity: the variables that follow it (`opacityVarsFor`) are left out of
 * `raw` and served by `materialFor`, which also carries the Surface opacity tints (`GlassTokens`). A slider step therefore
 * does not make a new `Theme`, and the views that read the theme do not render again.
 */
function build(variant: ThemeVariant, scope: WindowScope = 'none', contrast = false, reduceTransparency = false) {
  const opaque = opaqueVars(variant)
  const raw: Vars = { ...opaque, ...materialVars(variant, opaque, scope, 100, 100) }
  for (const name of opacityVarsFor(scope)) delete raw[name]
  const v = (name: string) => resolve(raw[name] ?? 'transparent', raw)
  const popover = v('--app-opaque-popover')
  const dense = scope === 'none' ? popover : v('--app-glass-dense-surface')
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
    /** A control or card fill. Never glass; page and pane backgrounds use `content`. */
    surface: v('--color-background-surface'),
    /** `--app-content-surface`: route content (workspace card, dock body, subagent page, terminal), clear on whole-window glass. Opaque otherwise, at every opacity. */
    content: v('--app-content-surface'),
    glass: {
      /** Tooltips, hover cards, toasts. */
      dense,
      /** The composer: whole window → dense (no transcript edge mask on GPUIX), else its own fill. */
      composer: scope === 'window' ? dense : variant === 'dark' ? v('--composer-surface') : '#ffffff',
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
    // A content well (code block, tool output): on whole-window glass a translucent tint that darkens (lightens) what is under it, never an opaque slab.
    codeSurface: scope === 'window' ? (variant === 'dark' ? 'rgba(0, 0, 0, 0.22)' : 'rgba(13, 13, 13, 0.05)') : v('--app-chat-code-surface'),
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
/**
 * The theme for a window scope, with the accessibility display options applied. Built once per combination; the glass
 * opacity is not part of it (`materialFor`), so the map stays at a handful of entries.
 */
export function themeFor(variant: ThemeVariant, scope: WindowScope, contrast: boolean, reduceTransparency: boolean): Theme {
  if (scope === 'none' && !contrast && !reduceTransparency) return THEMES[variant]
  const key = `${variant}:${scope}:${contrast}:${reduceTransparency}`
  let theme = derived.get(key)
  if (!theme) {
    theme = build(variant, scope, contrast, reduceTransparency)
    derived.set(key, theme)
  }
  return theme
}
export const derivedThemeCount = () => derived.size

/**
 * The glass recipe of `platform/glass.ts`, resolved for one variant, scope and Surface opacity. Window scope only: in
 * Solid and Sidebar only `on` is false and the helpers return the call site's own fill, so every field here is the empty
 * string except the popover fallbacks of the frost fills.
 */
export interface GlassTokens {
  on: boolean
  /** Raised cards: settings, inbound message, edited files, task dock, notes. */
  raised: string
  raisedHover: string
  /** A header band inside a raised card. */
  band: string
  rim: string
  /** The 1px catch along a raised card's top edge. */
  highlight: string
  /** Frost fills: composer and pills; stacked request panels; menus, pickers and popover cards. */
  frost: string
  frostStacked: string
  frostMenu: string
  /** A frost pill under the pointer. */
  frostHover: string
  frostRim: string
  frostHighlight: string
  /** Light pills use a stronger rim: a white pill otherwise vanishes on the white plane. */
  pillRim: string
  /** The tint-only fallback for a frost class that does not blur, and that fill under the pointer. */
  denseFloat: string
  denseHover: string
  /** The segmented control's recessed track. */
  recess: string
  recessRim: string
  recessShade: string
}

/**
 * The surfaces that follow the glass opacities and the Surface opacity, read with `useMaterial()` (`ui.tsx`). Each is a
 * resolved rgba() string.
 */
export interface Material {
  /** The app root fill and the rail, title bar and gutters: whole window → coat, Sidebar only → shell, none → the opaque frame. */
  frame: string
  /** The thread panel's coat: Sidebar only → over the shell, whole window → the extra coat its opacity needs (clear at equal opacities), none → the opaque panel. Also the settings list. */
  sidebar: string
  /** What the thread panel paints in the app shell: `sidebar`, or with `SINGLE_FILL` that coat already stacked on the shell. */
  panel: string
  /** The conversation card (workspace card, dock body, subagent page, terminal): whole window → the extra coat its opacity needs, else the opaque content. */
  content: string
  glass: GlassTokens
}

/** Stack a translucent colour on another: the one fill that paints the same pixels as the pair. */
export function stack(top: string, under: string): string {
  const t = parseColor(top)
  const u = parseColor(under)
  if (!t || !u) return top
  const alpha = t[3] + u[3] * (1 - t[3])
  if (alpha === 0) return 'rgba(0, 0, 0, 0)'
  const ch = (i: number) => (t[i] * t[3] + u[i] * u[3] * (1 - t[3])) / alpha
  return rgba([ch(0), ch(1), ch(2), alpha])
}

const materials = new Map<string, Material>()
const MAX_MATERIALS = 64
const INK: Record<ThemeVariant, [number, number, number]> = { dark: [252, 252, 252], light: [13, 13, 13] }
const rgbaOf = (rgb: readonly number[], alpha: number) => `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`

function glassTokens(variant: ThemeVariant, scope: WindowScope, opaque: Vars, surfaceOpacity: number | null, popover: string): GlassTokens {
  if (scope !== 'window') {
    return { on: false, raised: '', raisedHover: '', band: '', rim: '', highlight: '', frost: '', frostStacked: popover, frostMenu: popover, frostHover: '', frostRim: '', frostHighlight: '', pillRim: '', denseFloat: '', denseHover: '', recess: '', recessRim: '', recessShade: '' }
  }
  const r = glassRecipe(variant, surfaceScale(variant, effectiveSurface(variant, opaque, surfaceOpacity)))
  const fill = (name: keyof typeof r) => rgbaOf(r[name].rgb, r[name].alpha)
  const dark = variant === 'dark'
  return {
    on: true,
    raised: fill('raised'), raisedHover: fill('raisedHover'), band: fill('band'),
    rim: dark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(13, 13, 13, 0.08)',
    highlight: dark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(255, 255, 255, 0.9)',
    frost: fill('frost'), frostStacked: fill('frostStacked'), frostMenu: fill('frostMenu'),
    frostHover: stack(rgbaOf(INK[variant], 0.06), fill('frost')),
    frostRim: dark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(13, 13, 13, 0.1)',
    frostHighlight: dark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(255, 255, 255, 0.95)',
    pillRim: dark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(13, 13, 13, 0.14)',
    denseFloat: fill('denseFloat'),
    denseHover: stack(rgbaOf(INK[variant], 0.06), fill('denseFloat')),
    recess: dark ? 'rgba(0, 0, 0, 0.22)' : 'rgba(13, 13, 13, 0.06)',
    recessRim: dark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(13, 13, 13, 0.08)',
    recessShade: dark ? 'rgba(0, 0, 0, 0.25)' : 'rgba(0, 0, 0, 0.06)',
  }
}

/**
 * The material for a scope and the opacities, memoized so the same inputs give the same object (and no render). Scope none
 * ignores them all; Sidebar only ignores the content opacity and the Surface opacity (its content is Solid).
 */
export function materialFor(variant: ThemeVariant, scope: WindowScope, sidebarOpacity: number, contentOpacity = 100, surfaceOpacity: number | null = null): Material {
  const key = scope === 'none' ? `${variant}:none` : scope === 'sidebar' ? `${variant}:sidebar:${sidebarOpacity}` : `${variant}:window:${sidebarOpacity}:${contentOpacity}:${surfaceOpacity ?? ''}`
  let material = materials.get(key)
  if (material) return material
  const opaque = opaqueVars(variant)
  const raw: Vars = { ...opaque, ...materialVars(variant, opaque, scope, sidebarOpacity, contentOpacity) }
  const v = (name: string) => resolve(raw[name] ?? 'transparent', raw)
  const frame = v('--app-frame-surface')
  const sidebar = v('--app-sidebar-surface')
  material = {
    frame,
    sidebar,
    panel: SINGLE_FILL && scope === 'sidebar' ? stack(sidebar, frame) : sidebar,
    content: v('--app-content-surface'),
    glass: glassTokens(variant, scope, opaque, surfaceOpacity, v('--app-opaque-popover')),
  }
  materials.set(key, material)
  if (materials.size > MAX_MATERIALS) materials.delete(materials.keys().next().value!)
  return material
}
export const materialCount = () => materials.size

/** The lowest alpha any visible region paints for a scope and the opacities (`platform/translucency.ts`); the window backing follows it. */
export const windowCoverage = (variant: ThemeVariant, scope: WindowScope, sidebarOpacity: number, contentOpacity = 100) => materialCoverage(variant, opaqueVars(variant), scope, sidebarOpacity, contentOpacity)

export const FONT_UI = '.SystemUIFont'
export const FONT_MONO = 'Menlo'
