// Window translucency: the settings model and the material formulas.
//
// Ported from Synara, apps/web/src/theme/theme.logic.ts and apps/web/src/index.css (MIT License):
//   Copyright (c) 2026 T3 Tools Inc.
//   Copyright (c) 2026 Emanuele Di Pietro
// Full notice: THIRD_PARTY_NOTICES.md at the repository root.
//
// Kybern's own theme colors stay; only the material system is ported. The desktop's opaque
// variables go in (`buildThemeCssVariables` with `isMac: false`), and `materialVars` returns a
// GPUIX-only override map for the chosen scope, resolved by `theme.ts`.
// No runtime imports: `theme.ts` loads this before the UI module graph exists.
import type { AccessibilityDisplay } from './material.ts'

/** Capture mode (`KYBERN_OPAQUE=1`): an opaque window with no native material. */
export const OPAQUE_WINDOW = process.env.KYBERN_OPAQUE === '1'
/**
 * Temporary A/B switch for the perf bench (`perf/translucency-zeron-research.md` R2): no full-window root fill under the
 * opaque content card, and one fill on the thread panel instead of the coat over the frame. Same pixels, less overdraw.
 */
export const SINGLE_FILL = process.env.KYBERN_TRANSLUCENCY_SINGLE_FILL === '1'

export type ThemeVariant = 'dark' | 'light'
export type WindowMaterial = 'solid' | 'translucent'
/** Window translucency per theme variant (the source's `WindowTranslucency` plus its pack's `opaqueWindows`). */
export interface VariantMaterial {
  material: WindowMaterial
  /** Glass fill strength, OPACITY_MIN…100. */
  opacity: number
  /** Desktop blur radius in points, BLUR_MIN…BLUR_MAX; null = native vibrancy ("Auto"). */
  blur: number | null
  /** Glass only on the frame and thread panel; the conversation stays opaque. */
  sidebarOnly: boolean
}
export type WindowScope = 'none' | 'sidebar' | 'window'

export const OPACITY_MIN = 15 // source WINDOW_TRANSLUCENCY_OPACITY_MIN
export const BLUR_MIN = 1 // source DESKTOP_WINDOW_BLUR_RADIUS_MIN
export const BLUR_MAX = 64 // source DESKTOP_WINDOW_BLUR_RADIUS_MAX
export const NATIVE_BLUR_MAX = 100 // WindowMaterial.m kMaxBlurRadius (native clamp)
/** Where the slider rests while blur is Auto (source VIBRANCY_EQUIVALENT_BLUR_RADIUS). */
export const VIBRANCY_EQUIVALENT_BLUR = 30
/**
 * Set by the perf gate (`perf/translucency-2026-10.md`, rerun in `perf/translucency-gate-2-2026-10-22.md`). true → new installs
 * default to Sidebar only. The rerun kept it: whole-window glass fails streaming intervals over 33 ms and WindowServer GPU time.
 */
export const DEFAULT_SIDEBAR_ONLY = true
export const DEFAULT_VARIANT_MATERIAL: VariantMaterial = { material: 'translucent', opacity: 90, blur: 64, sidebarOnly: DEFAULT_SIDEBAR_ONLY }
/** Sidebar only also makes the thread panel glass (the source's own `--app-sidebar-surface`); false keeps it opaque. */
export const SIDEBAR_ONLY_PANEL_GLASS = true

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
/** The source's `normalizeIntegerInRange`: clamp, then round. */
const integerInRange = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value !== 'number' || !Number.isFinite(value) ? fallback : Math.round(Math.min(max, Math.max(min, value)))

/** The source's `normalizeWindowTranslucency`, plus `material`. Anything unusable falls back to the default. */
export function normalizeVariantMaterial(value: unknown): VariantMaterial {
  const v = isRecord(value) ? value : {}
  const fallback = DEFAULT_VARIANT_MATERIAL
  return {
    material: v.material === 'solid' || v.material === 'translucent' ? v.material : fallback.material,
    opacity: integerInRange(v.opacity, OPACITY_MIN, 100, fallback.opacity),
    blur: typeof v.blur === 'number' && Number.isFinite(v.blur) ? integerInRange(v.blur, BLUR_MIN, BLUR_MAX, BLUR_MIN) : v.blur === null ? null : fallback.blur,
    sidebarOnly: typeof v.sidebarOnly === 'boolean' ? v.sidebarOnly : fallback.sidebarOnly,
  }
}

/** The saved `window` map of an appearance file (§2.3). Pure; the file's `theme` is validated by `settings/appearance.ts`. */
export function migrateWindow(saved: unknown): Record<ThemeVariant, VariantMaterial> {
  const file = isRecord(saved) ? saved : {}
  if (file.version === 2) {
    const window = isRecord(file.window) ? file.window : {}
    return { dark: normalizeVariantMaterial(window.dark), light: normalizeVariantMaterial(window.light) }
  }
  // The old switch asked for glass content: keep that, whole window, even if new installs default to Sidebar only.
  if (file.version === undefined && file.translucent === true) {
    const glass: VariantMaterial = { material: 'translucent', opacity: 90, blur: 64, sidebarOnly: false }
    return { dark: { ...glass }, light: { ...glass } }
  }
  return { dark: { ...DEFAULT_VARIANT_MATERIAL }, light: { ...DEFAULT_VARIANT_MATERIAL } }
}

export function resolveScope(m: VariantMaterial, a11y: Pick<AccessibilityDisplay, 'reduceTransparency' | 'increaseContrast'>, opaqueWindow = OPAQUE_WINDOW): WindowScope {
  if (opaqueWindow || a11y.reduceTransparency || a11y.increaseContrast || m.material === 'solid') return 'none'
  return m.sidebarOnly ? 'sidebar' : 'window'
}

// Source RAIL_SHELL_OPACITY_RATIO_BY_VARIANT and RAISED_GLASS_OPACITY_BY_VARIANT.
const SHELL_RATIO: Record<ThemeVariant, number> = { dark: 64 / 72, light: 82 / 38 }
const RAISED: Record<ThemeVariant, { floor: number; ratio: number }> = { dark: { floor: 10, ratio: 0.5 }, light: { floor: 4, ratio: 0.3 } }

const mix = (color: string, percent: number) => `color-mix(in srgb, ${color} ${percent}%, transparent)`

type Rgba = [number, number, number, number]
/** Hex and `rgb()`/`rgba()` only; the desktop's text and surface variables are written in these. */
function parseRgba(value: string | undefined): Rgba | null {
  const v = value?.trim()
  if (!v) return null
  if (v.startsWith('#')) {
    const h = v.slice(1)
    const full = h.length <= 4 ? [...h].map((c) => c + c).join('') : h
    const n = (i: number) => parseInt(full.slice(i, i + 2), 16)
    const out: Rgba = [n(0), n(2), n(4), full.length === 8 ? n(6) / 255 : 1]
    return out.some(Number.isNaN) ? null : out
  }
  const m = v.match(/^rgba?\(([^)]+)\)$/)
  if (!m) return null
  const parts = m[1]!.split(/[\s,/]+/).filter(Boolean).map(Number)
  return parts.length >= 3 && parts.every(Number.isFinite) ? [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1] : null
}
const luminance = ([r, g, b]: Rgba) => {
  const lin = (c: number) => { const x = c / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}
const contrast = (a: Rgba, b: Rgba) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
const blend = (top: Rgba, alpha: number, base: Rgba): Rgba => [0, 1, 2].map((i) => top[i]! * alpha + base[i]! * (1 - alpha)).concat(1) as Rgba

/** The coat's fill before opacity: the surface at 80% over black in dark, the surface itself in light (`materialFormulas`). */
const DARK_COAT_MIX = 0.8
const ADVERSE: Record<ThemeVariant, Rgba> = { dark: [255, 255, 255, 1], light: [0, 0, 0, 1] }

/**
 * Readability floor for the coat (Zeron's `contrast_checked_tint_alpha`, `crates/ui/src/theme.rs`): the least opacity, in
 * 5% steps, at which text reaches 4.5:1 and secondary text 3:1 over the worst desktop for the variant, white behind a dark
 * coat and black behind a light one. The Opacity slider keeps its range but is held at this floor, so its low end is flat
 * rather than unreadable (`effectiveOpacity`). 0 when the colours cannot be read, 100 when no lower step passes. With the
 * default themes it is 65% dark and 55% light, below the 90% default, so only the slider's low end changes.
 */
export function coatFloor(variant: ThemeVariant, O: Record<string, string>): number {
  const surface = parseRgba(O['--color-background-surface'])
  const text = parseRgba(O['--color-text-foreground'])
  const muted = parseRgba(O['--color-text-foreground-secondary'])
  if (!surface || !text || !muted) return 0
  const coat: Rgba = variant === 'dark' ? [surface[0] * DARK_COAT_MIX, surface[1] * DARK_COAT_MIX, surface[2] * DARK_COAT_MIX, 1] : surface
  for (let percent = 0; percent <= 100; percent += 5) {
    const backdrop = blend(coat, percent / 100, ADVERSE[variant])
    if (contrast(blend(text, text[3], backdrop), backdrop) >= 4.5 && contrast(blend(muted, muted[3], backdrop), backdrop) >= 3) return percent
  }
  return 100
}
/** The opacity the window paints: the slider's value, held at the readability floor. */
export const effectiveOpacity = (variant: ThemeVariant, O: Record<string, string>, opacity: number) => Math.max(opacity, coatFloor(variant, O))

/** The tokens one scope paints; `resolve` in `theme.ts` turns these into rgba(). */
export function materialFormulas(variant: ThemeVariant, O: Record<string, string>, opacity: number) {
  const S = O['--color-background-surface']!
  const coat = variant === 'dark' ? mix(`color-mix(in srgb, ${S} 80%, black)`, opacity) : mix(S, opacity)
  const raisedPercent = Math.round(RAISED[variant].floor + opacity * RAISED[variant].ratio)
  const shellPercent = Math.min(100, Math.round(opacity * SHELL_RATIO[variant]))
  return {
    coat,
    raisedPercent,
    raised: mix('var(--popover)', raisedPercent),
    shellPercent,
    shell: mix(O['--app-frame-surface']!, shellPercent),
    dense: mix('var(--popover)', 96),
  }
}

/**
 * The variables whose value follows the opacity. Everything else in a scope's map is the same at every opacity, which is
 * why `theme.ts` keeps them out of `Theme` and serves them from `materialFor`: an Opacity step then re-renders only the
 * views that read these (`useMaterial`).
 */
export const OPACITY_VARS = ['--app-frame-surface', '--app-sidebar-surface', '--app-glass-raised-surface', '--app-settings-card-surface'] as const

/**
 * The lowest alpha, 0…1, any visible region of the window paints for a scope; at or above `OPAQUE_COVERAGE` nothing shows
 * through, and `backingFor` gives the window an opaque backing. Whole window: the coat. Sidebar only: the frame shell
 * (title bar, rail, gutters); the thread panel's coat over it and the content card are denser.
 */
export function materialCoverage(variant: ThemeVariant, O: Record<string, string>, scope: WindowScope, opacity: number): number {
  if (scope === 'none') return 1
  const effective = effectiveOpacity(variant, O, opacity)
  return (scope === 'window' ? effective : materialFormulas(variant, O, effective).shellPercent) / 100
}
/** Coverage from which the desktop is invisible: the window is opaque and the blur is skipped. */
export const OPAQUE_COVERAGE = 0.99

/**
 * The override map for a scope, applied over the opaque variables. `--color-background-surface` is never
 * overridden: about 35 call sites use it as a control fill. Route content uses `--app-content-surface`.
 */
export function materialVars(variant: ThemeVariant, O: Record<string, string>, scope: WindowScope, opacity: number): Record<string, string> {
  const content = O['--color-background-surface']!
  if (scope === 'none') return { '--app-content-surface': content }
  const f = materialFormulas(variant, O, effectiveOpacity(variant, O, opacity))
  if (scope === 'window') {
    return {
      '--app-frame-surface': f.coat,
      '--app-sidebar-surface': 'transparent',
      '--app-content-surface': 'transparent',
      '--app-glass-raised-surface': f.raised,
      '--app-glass-dense-surface': f.dense,
      '--app-settings-card-surface': f.raised,
      '--app-settings-card-border': 'var(--color-border)',
    }
  }
  return {
    '--app-frame-surface': f.shell,
    '--app-sidebar-surface': SIDEBAR_ONLY_PANEL_GLASS ? f.coat : O['--app-sidebar-surface']!,
    '--app-content-surface': content,
    '--app-glass-dense-surface': f.dense,
  }
}
