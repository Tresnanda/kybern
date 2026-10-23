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
  /** Coat behind the thread panel and the window frame, OPACITY_MIN…100. */
  sidebarOpacity: number
  /** Coat behind the conversation and every route page, OPACITY_MIN…100. 100 = "Sidebar only". */
  contentOpacity: number
  /** The content opacity to restore when Sidebar only is switched off (never 100). */
  lastContentOpacity: number
  /** Desktop blur radius in points, BLUR_MIN…BLUR_MAX; null = native vibrancy ("Auto"). One per window. */
  blur: number | null
  /**
   * How solid the frosted and raised surfaces are (composer, menus, pills, cards): the composer's frost alpha in percent.
   * null = the recipe default for the variant (`SURFACE_DEFAULT`). Held at the readability floor (`effectiveSurface`).
   */
  surfaceOpacity: number | null
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
export const DEFAULT_VARIANT_MATERIAL: VariantMaterial = {
  material: 'translucent', sidebarOpacity: 90, contentOpacity: DEFAULT_SIDEBAR_ONLY ? 100 : 90, lastContentOpacity: 90, blur: 64, surfaceOpacity: null,
}
/** Sidebar only also makes the thread panel glass (the source's own `--app-sidebar-surface`); false keeps it opaque. */
export const SIDEBAR_ONLY_PANEL_GLASS = true
/** Content opacity 100 is the "Sidebar only" preset. */
export const isSidebarOnly = (m: Pick<VariantMaterial, 'contentOpacity'>) => m.contentOpacity >= 100

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
    sidebarOpacity: integerInRange(v.sidebarOpacity, OPACITY_MIN, 100, fallback.sidebarOpacity),
    contentOpacity: integerInRange(v.contentOpacity, OPACITY_MIN, 100, fallback.contentOpacity),
    // 100 would make the preset restore itself: only a content opacity below 100 is worth coming back to.
    lastContentOpacity: typeof v.lastContentOpacity === 'number' && v.lastContentOpacity < 99.5 ? integerInRange(v.lastContentOpacity, OPACITY_MIN, 99, fallback.lastContentOpacity) : fallback.lastContentOpacity,
    blur: typeof v.blur === 'number' && Number.isFinite(v.blur) ? integerInRange(v.blur, BLUR_MIN, BLUR_MAX, BLUR_MIN) : v.blur === null ? null : fallback.blur,
    surfaceOpacity: typeof v.surfaceOpacity === 'number' && Number.isFinite(v.surfaceOpacity) ? integerInRange(v.surfaceOpacity, SURFACE_MIN, 100, SURFACE_MIN) : null,
  }
}

/** A saved v2 variant (`opacity`, `sidebarOnly`) as the v3 fields. */
function migrateV2(value: unknown): VariantMaterial {
  const v = isRecord(value) ? value : {}
  const old = normalizeVariantMaterialV2(v)
  return normalizeVariantMaterial({
    material: old.material,
    sidebarOpacity: old.opacity,
    contentOpacity: old.sidebarOnly ? 100 : old.opacity,
    lastContentOpacity: old.opacity < 100 ? old.opacity : 90,
    blur: old.blur,
  })
}
function normalizeVariantMaterialV2(v: Record<string, unknown>) {
  const fallback = DEFAULT_VARIANT_MATERIAL
  return {
    material: v.material === 'solid' || v.material === 'translucent' ? v.material : fallback.material,
    opacity: integerInRange(v.opacity, OPACITY_MIN, 100, fallback.sidebarOpacity),
    blur: typeof v.blur === 'number' && Number.isFinite(v.blur) ? integerInRange(v.blur, BLUR_MIN, BLUR_MAX, BLUR_MIN) : v.blur === null ? null : fallback.blur,
    sidebarOnly: typeof v.sidebarOnly === 'boolean' ? v.sidebarOnly : DEFAULT_SIDEBAR_ONLY,
  }
}

/** The saved `window` map of an appearance file (§2.3, §5.2). Pure; the file's `theme` is validated by `settings/appearance.ts`. */
export function migrateWindow(saved: unknown): Record<ThemeVariant, VariantMaterial> {
  const file = isRecord(saved) ? saved : {}
  const window = isRecord(file.window) ? file.window : {}
  if (file.version === 3) return { dark: normalizeVariantMaterial(window.dark), light: normalizeVariantMaterial(window.light) }
  if (file.version === 2) return { dark: migrateV2(window.dark), light: migrateV2(window.light) }
  // The old switch asked for glass content: keep that, whole window, even if new installs default to Sidebar only.
  if (file.version === undefined && file.translucent === true) {
    const glass: VariantMaterial = { ...DEFAULT_VARIANT_MATERIAL, material: 'translucent', sidebarOpacity: 90, contentOpacity: 90, lastContentOpacity: 90, blur: 64 }
    return { dark: { ...glass }, light: { ...glass } }
  }
  return { dark: { ...DEFAULT_VARIANT_MATERIAL }, light: { ...DEFAULT_VARIANT_MATERIAL } }
}

/** The Advanced section's values (§5.4) at their defaults: Sidebar only keeps the content at 100, else it is 90. */
export function advancedDefaults(m: Pick<VariantMaterial, 'contentOpacity'>): Pick<VariantMaterial, 'sidebarOpacity' | 'contentOpacity' | 'lastContentOpacity' | 'blur' | 'surfaceOpacity'> {
  const d = DEFAULT_VARIANT_MATERIAL
  return { sidebarOpacity: d.sidebarOpacity, contentOpacity: isSidebarOnly(m) ? 100 : 90, lastContentOpacity: d.lastContentOpacity, blur: d.blur, surfaceOpacity: null }
}
/** Whether the Advanced values already equal their defaults (the Sidebar only preset aside); the Reset button is disabled then. */
export function isAdvancedDefault(m: VariantMaterial, variant: ThemeVariant): boolean {
  const d = advancedDefaults(m)
  return m.sidebarOpacity === d.sidebarOpacity && m.blur === d.blur && (isSidebarOnly(m) || m.contentOpacity === d.contentOpacity)
    && (m.surfaceOpacity === null || m.surfaceOpacity === SURFACE_DEFAULT[variant])
}

export function resolveScope(m: Pick<VariantMaterial, 'material' | 'contentOpacity'>, a11y: Pick<AccessibilityDisplay, 'reduceTransparency' | 'increaseContrast'>, opaqueWindow = OPAQUE_WINDOW): WindowScope {
  if (opaqueWindow || a11y.reduceTransparency || a11y.increaseContrast || m.material === 'solid') return 'none'
  return isSidebarOnly(m) ? 'sidebar' : 'window'
}

// Source RAIL_SHELL_OPACITY_RATIO_BY_VARIANT.
const SHELL_RATIO: Record<ThemeVariant, number> = { dark: 64 / 72, light: 82 / 38 }

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

/** The colour of a recipe fill, `rgba(r, g, b, a)`, as the parts `blend` takes. */
const fillOf = (rgb: readonly [number, number, number], alpha: number): Rgba => [rgb[0], rgb[1], rgb[2], alpha]
/** Whether text reaches 4.5:1 and secondary text 3:1 on a backdrop. */
const readable = (text: Rgba, muted: Rgba, backdrop: Rgba) =>
  contrast(blend(text, text[3], backdrop), backdrop) >= 4.5 && contrast(blend(muted, muted[3], backdrop), backdrop) >= 3

function readableColors(O: Record<string, string>) {
  const surface = parseRgba(O['--color-background-surface'])
  const text = parseRgba(O['--color-text-foreground'])
  const muted = parseRgba(O['--color-text-foreground-secondary'])
  return surface && text && muted ? { surface, text, muted } : null
}
const coatColor = (variant: ThemeVariant, surface: Rgba): Rgba =>
  variant === 'dark' ? [surface[0] * DARK_COAT_MIX, surface[1] * DARK_COAT_MIX, surface[2] * DARK_COAT_MIX, 1] : surface

/**
 * Readability floor for the coat (Zeron's `contrast_checked_tint_alpha`, `crates/ui/src/theme.rs`): the least opacity, in
 * 5% steps, at which text reaches 4.5:1 and secondary text 3:1 over the worst desktop for the variant, white behind a dark
 * coat and black behind a light one, both on the coat alone and under the raised tint that cards stack on it. The Opacity
 * sliders keep their range but are held at this floor, so their low end is flat rather than unreadable (`effectiveOpacity`).
 * 0 when the colours cannot be read, 100 when no lower step passes. With the default themes it is 70% dark (raised cards
 * read 6.0 / 3.2 there, 5.1 / 2.85 at 65%) and 55% light.
 */
export function coatFloor(variant: ThemeVariant, O: Record<string, string>): number {
  const c = readableColors(O)
  if (!c) return 0
  const coat = coatColor(variant, c.surface)
  const raised = glassRecipe(variant, 1).raised
  for (let percent = 0; percent <= 100; percent += 5) {
    const backdrop = blend(coat, percent / 100, ADVERSE[variant])
    if (readable(c.text, c.muted, backdrop) && readable(c.text, c.muted, blend(fillOf(raised.rgb, raised.alpha), raised.alpha, backdrop))) return percent
  }
  return 100
}
/**
 * Quiet text on a frosted panel (request cards): the text colour at the least alpha, in 1% steps, at which tertiary text,
 * placeholders and disabled labels reach 4.5:1, both on `fill` and inside a field on it (the field's ink wash), over the coat
 * at its floor on the worst desktop; secondary text keeps 7% more alpha and 4.5:1 on the fill. Each never drops below the
 * theme's own alpha. Null when the colours cannot be read. With the default themes and the stacked frost: tertiary 0.65 in
 * both variants, secondary 0.72.
 */
export function frostQuietInk(variant: ThemeVariant, O: Record<string, string>, fill: string): { secondary: string; tertiary: string } | null {
  const c = readableColors(O)
  const f = parseRgba(fill)
  const tertiary = parseRgba(O['--color-text-foreground-tertiary'])
  if (!c || !f || !tertiary) return null
  const under = blend(coatColor(variant, c.surface), coatFloor(variant, O) / 100, ADVERSE[variant])
  const panel = blend(f, f[3], under)
  const field = blend(c.text, variant === 'light' ? 0.04 : 0.06, panel)
  const least = (on: Rgba[], from: number) => {
    for (let a = from; a < 1; a = Math.round((a + 0.01) * 100) / 100) if (on.every((b) => contrast(blend(c.text, a, b), b) >= 4.5)) return a
    return 1
  }
  const rgba = (a: number) => `rgba(${c.text[0]}, ${c.text[1]}, ${c.text[2]}, ${a})`
  const quiet = least([panel, field], Math.max(tertiary[3], 0.01))
  return { tertiary: rgba(quiet), secondary: rgba(least([panel], Math.max(c.muted[3], Math.min(1, quiet + 0.07)))) }
}

/** The opacity the window paints: the slider's value, held at the readability floor. */
export const effectiveOpacity = (variant: ThemeVariant, O: Record<string, string>, opacity: number) => Math.max(opacity, coatFloor(variant, O))

// ─── Glass recipes (Zeron and Synara values, `THIRD_PARTY_NOTICES.md`) ────────────────────────────────────────────────

export type FrostClass = 'composer' | 'pills' | 'menus'
export const FROST_CLASSES: readonly FrostClass[] = ['composer', 'pills', 'menus']
/**
 * Frost classes on by default: all three. The round-2 gate (`perf/translucency-r2-gate-2026-10-22.md`) found no stutter for any
 * of them (frame p95, intervals over 33 ms, CPU and idle all passed); the cost is GPUIX GPU time per frame on a 1–2.5 ms base
 * (composer +73%, menus +91%, pills +27%), which failed the spec's stricter +30% GPU limit. The rule agreed for this feature is
 * stutter, so the blur stays. Frost only paints on whole-window glass; the default (Sidebar only) puts these surfaces on the
 * opaque content card. `KYBERN_GLASS_FROST=none` (or a comma list) overrides at launch.
 */
export const FROST_DEFAULT: readonly FrostClass[] = ['composer', 'pills', 'menus']
/** `KYBERN_GLASS_FROST`: `none`, `all`, or a comma list of classes; unset = `FROST_DEFAULT`. Read once at launch. */
export function parseFrostClasses(value: string | undefined): ReadonlySet<FrostClass> {
  if (value === undefined || value.trim() === '') return new Set(FROST_DEFAULT)
  const v = value.trim().toLowerCase()
  if (v === 'none') return new Set()
  if (v === 'all') return new Set(FROST_CLASSES)
  return new Set(v.split(',').map((c) => c.trim()).filter((c): c is FrostClass => (FROST_CLASSES as readonly string[]).includes(c)))
}
export const FROST_ENABLED: ReadonlySet<FrostClass> = parseFrostClasses(process.env.KYBERN_GLASS_FROST)

/** The composer's frost alpha in percent at the recipe default: the Surface opacity slider's resting value (light 0.70, user decision over the spec's 0.62). */
export const SURFACE_DEFAULT: Record<ThemeVariant, number> = { dark: 55, light: 70 }
/** The lowest Surface opacity: below it the transcript text behind a frosted composer shows through the blur. */
export const SURFACE_MIN = 30
const INK_RGB: Record<ThemeVariant, readonly [number, number, number]> = { dark: [255, 255, 255], light: [13, 13, 13] }

interface RecipeFill { rgb: readonly [number, number, number]; alpha: number }
/** Recipe fills: [colour, alpha at the default Surface opacity, cap]. The caps keep a raised dark card from whitening past readability at 100%. */
const RECIPE: Record<ThemeVariant, Record<'raised' | 'raisedHover' | 'band' | 'frost' | 'frostStacked' | 'frostMenu' | 'denseFloat', readonly [readonly [number, number, number], number, number]>> = {
  dark: {
    raised: [[255, 255, 255], 0.045, 0.06], raisedHover: [[255, 255, 255], 0.075, 0.09], band: [[255, 255, 255], 0.03, 0.04],
    frost: [[46, 46, 46], 0.55, 1], frostStacked: [[46, 46, 46], 0.48, 1], frostMenu: [[46, 46, 46], 0.66, 1], denseFloat: [[46, 46, 46], 0.92, 1],
  },
  light: {
    raised: [[255, 255, 255], 0.55, 0.92], raisedHover: [[255, 255, 255], 0.72, 0.96], band: [[13, 13, 13], 0.025, 0.04],
    frost: [[255, 255, 255], 0.7, 1], frostStacked: [[255, 255, 255], 0.6, 1], frostMenu: [[255, 255, 255], 0.72, 1], denseFloat: [[255, 255, 255], 0.94, 1],
  },
}
/** How many times the recipe alphas a Surface opacity (percent) asks for. */
export const surfaceScale = (variant: ThemeVariant, surfaceOpacity: number) => surfaceOpacity / SURFACE_DEFAULT[variant]

/** The window-scope fills at a Surface scale (1 = the recipe default). Alphas are rounded to 3 places. */
export function glassRecipe(variant: ThemeVariant, scale: number): Record<keyof (typeof RECIPE)['dark'], RecipeFill> {
  const out = {} as Record<keyof (typeof RECIPE)['dark'], RecipeFill>
  for (const [name, [rgb, alpha, cap]] of Object.entries(RECIPE[variant]) as [keyof (typeof RECIPE)['dark'], (typeof RECIPE)['dark'][keyof (typeof RECIPE)['dark']]][])
    out[name] = { rgb, alpha: Math.round(Math.min(cap, alpha * scale) * 1000) / 1000 }
  return out
}

/**
 * The text and secondary-text contrast of every glass fill at a Surface opacity, on the worst desktop for the variant (the
 * coat at its floor over white behind dark, black behind light): [name, text, secondary] per fill. 0 when the colours
 * cannot be read.
 */
export function glassContrast(variant: ThemeVariant, O: Record<string, string>, surfaceOpacity: number): [string, number, number][] {
  const c = readableColors(O)
  if (!c) return []
  const under = blend(coatColor(variant, c.surface), coatFloor(variant, O) / 100, ADVERSE[variant])
  return (Object.entries(glassRecipe(variant, surfaceScale(variant, surfaceOpacity))) as [string, RecipeFill][]).map(([name, f]) => {
    const backdrop = blend(fillOf(f.rgb, f.alpha), f.alpha, under)
    return [name, contrast(blend(c.text, c.text[3], backdrop), backdrop), contrast(blend(c.muted, c.muted[3], backdrop), backdrop)]
  })
}
/** The fills that carry body text. Hover and band tints are fractions of a percent over them. */
const READABLE_FILLS = ['raised', 'frost', 'frostStacked', 'frostMenu', 'denseFloat']
/**
 * The readability floor for Surface opacity: the least value, in 5% steps, from which every glass fill keeps text at 4.5:1
 * and secondary text at 3:1 up to 100%. The recipe caps keep the white raised tint of a dark card from whitening past it.
 */
export function surfaceFloor(variant: ThemeVariant, O: Record<string, string>): number {
  if (!readableColors(O)) return SURFACE_MIN
  let floor = 100
  for (let percent = 100; percent >= SURFACE_MIN; percent -= 5) {
    if (!glassContrast(variant, O, percent).filter(([name]) => READABLE_FILLS.includes(name)).every(([, text, muted]) => text >= 4.5 && muted >= 3)) break
    floor = percent
  }
  return floor
}
/** The Surface opacity in force: the saved value (or the default), held at the readability floor. */
export const effectiveSurface = (variant: ThemeVariant, O: Record<string, string>, surfaceOpacity: number | null) =>
  Math.min(100, Math.max(surfaceOpacity ?? SURFACE_DEFAULT[variant], surfaceFloor(variant, O)))

/** The tokens one scope paints; `resolve` in `theme.ts` turns these into rgba(). */
export function materialFormulas(variant: ThemeVariant, O: Record<string, string>, opacity: number) {
  const S = O['--color-background-surface']!
  const coat = variant === 'dark' ? mix(`color-mix(in srgb, ${S} 80%, black)`, opacity) : mix(S, opacity)
  const shellPercent = Math.min(100, Math.round(opacity * SHELL_RATIO[variant]))
  return {
    coat,
    shellPercent,
    shell: mix(O['--app-frame-surface']!, shellPercent),
    dense: mix('var(--popover)', 96),
  }
}

/**
 * The variables whose value follows an opacity. Everything else in a scope's map is the same at every opacity, which is
 * why `theme.ts` keeps them out of `Theme` and serves them from `materialFor`: an Opacity step then re-renders only the
 * views that read these (`useMaterial`).
 */
export const OPACITY_VARS = ['--app-frame-surface', '--app-sidebar-surface'] as const
/** Whole-window glass also paints the conversation's coat from a variable. */
export const opacityVarsFor = (scope: WindowScope): readonly string[] => scope === 'window' ? [...OPACITY_VARS, '--app-content-surface'] : OPACITY_VARS

/**
 * The lowest alpha, 0…1, any visible region of the window paints for a scope; at or above `OPAQUE_COVERAGE` nothing shows
 * through, and `backingFor` gives the window an opaque backing. Whole window: the frame, which follows the more transparent
 * of the two opacities (`windowCoats`). Sidebar only: the frame shell (title bar, rail, gutters); the thread panel's coat
 * over it and the content card are denser.
 */
export function materialCoverage(variant: ThemeVariant, O: Record<string, string>, scope: WindowScope, sidebarOpacity: number, contentOpacity = 100): number {
  if (scope === 'none') return 1
  const s = effectiveOpacity(variant, O, sidebarOpacity)
  if (scope === 'window') return Math.min(s, effectiveOpacity(variant, O, contentOpacity)) / 100
  return materialFormulas(variant, O, s).shellPercent / 100
}
/** Coverage from which the desktop is invisible: the window is opaque and the blur is skipped. */
export const OPAQUE_COVERAGE = 0.99

/**
 * Whole-window stacking (§5.3). The root paints `coat(r)`, r = the more transparent of the two opacities; the thread panel
 * and the content card each stack the same coat on top so that they read `coat(v)`: `x = (v − r) / (100 − r) × 100`. A
 * region whose x is 0 paints nothing. With equal opacities (the default) the root is the only fill.
 */
export function windowCoats(variant: ThemeVariant, O: Record<string, string>, sidebarOpacity: number, contentOpacity: number) {
  const s = effectiveOpacity(variant, O, sidebarOpacity)
  const c = effectiveOpacity(variant, O, contentOpacity)
  const r = Math.min(s, c)
  const extra = (v: number) => r >= 100 ? 0 : Math.round(((v - r) / (100 - r)) * 100 * 1000) / 1000
  return { frame: r, sidebar: extra(s), content: extra(c) }
}

/**
 * The override map for a scope, applied over the opaque variables. `--color-background-surface` is never
 * overridden: about 35 call sites use it as a control fill. Route content uses `--app-content-surface`.
 */
export function materialVars(variant: ThemeVariant, O: Record<string, string>, scope: WindowScope, sidebarOpacity: number, contentOpacity = 100): Record<string, string> {
  const content = O['--color-background-surface']!
  if (scope === 'none') return { '--app-content-surface': content }
  if (scope === 'window') {
    const coats = windowCoats(variant, O, sidebarOpacity, contentOpacity)
    const coat = (percent: number) => percent > 0 ? materialFormulas(variant, O, percent).coat : 'transparent'
    return {
      '--app-frame-surface': materialFormulas(variant, O, coats.frame).coat,
      '--app-sidebar-surface': coat(coats.sidebar),
      '--app-content-surface': coat(coats.content),
      '--app-glass-dense-surface': materialFormulas(variant, O, 100).dense,
    }
  }
  const f = materialFormulas(variant, O, effectiveOpacity(variant, O, sidebarOpacity))
  return {
    '--app-frame-surface': f.shell,
    '--app-sidebar-surface': SIDEBAR_ONLY_PANEL_GLASS ? f.coat : O['--app-sidebar-surface']!,
    '--app-content-surface': content,
    '--app-glass-dense-surface': f.dense,
  }
}
