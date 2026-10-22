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
/** Set by the perf gate (`perf/translucency-2026-10.md`). true → new installs default to Sidebar only. */
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
 * The override map for a scope, applied over the opaque variables. `--color-background-surface` is never
 * overridden: about 35 call sites use it as a control fill. Route content uses `--app-content-surface`.
 */
export function materialVars(variant: ThemeVariant, O: Record<string, string>, scope: WindowScope, opacity: number): Record<string, string> {
  const content = O['--color-background-surface']!
  if (scope === 'none') return { '--app-content-surface': content }
  const f = materialFormulas(variant, O, opacity)
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
