// Window-scope glass recipes: how a raised or frosted element is filled, ringed and blurred on whole-window glass.
//
// The values come from Zeron (`crates/ui/src/theme.rs`, `glass.rs`, `frost.rs`; MIT, Copyright (c) 2026 Wing) and Synara
// (`apps/web/src/theme/theme.logic.ts`; MIT, T3 Tools Inc.). Full notices: THIRD_PARTY_NOTICES.md at the repository root.
//
// The tints live in `theme.ts` (`GlassTokens`, served by `useMaterial().glass` because the Surface opacity slider moves
// them); these helpers pick the right one for a call site. In Solid and Sidebar only (`g.on` false) every helper returns
// the call site's own fill, so a component reads them unconditionally and its Solid look stays byte-identical.
// Rule for new surfaces: on whole-window glass never composite onto `t.surface` or paint an opaque fill on a content-area
// surface; use `raisedFill`, `wash` or `frostFill`. Never put an outer shadow under a fill with alpha < 0.85.
import { backdropAllowed } from './material.ts'
import { FROST_ENABLED, type FrostClass } from './translucency.ts'
import { BACKDROP, type BackdropFilter } from '../native/backdrop.ts'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { over, type GlassTokens, type Theme } from '../theme.ts'
import { ink, useMaterial } from '../ui.tsx'

export type { FrostClass }
/** The glass tints for the current theme, surface opacity and scope (`GlassTokens.on` is false outside whole-window glass). */
export const useGlass = (): GlassTokens => useMaterial().glass
/** The fill of a raised element: the glass tint on whole-window glass, else the call site's own Solid fill. */
export const raisedFill = (g: GlassTokens, solid: string, hover = false) => g.on ? (hover ? g.raisedHover : g.raised) : solid
export const raisedRim = (g: GlassTokens, solid: string) => g.on ? g.rim : solid
/** `over(ink(a), t.surface)` in Solid; the translucent ink itself on glass (never an opaque slab). */
export const wash = (t: Theme, g: GlassTokens, a: number) => g.on ? ink(t, a) : over(ink(t, a), t.surface)
/** The rule behind `frosted`, with its four inputs spelled out. */
export const frostedWith = (on: boolean, backdrops: boolean, patched: boolean, enabled: ReadonlySet<FrostClass>, c: FrostClass) => on && backdrops && patched && enabled.has(c)
/** Whether a frost class blurs right now: whole-window glass, scene backdrops allowed, patched addon, class enabled. */
export const frosted = (g: GlassTokens, c: FrostClass) => frostedWith(g.on, backdropAllowed(), PATCHED_NATIVE, FROST_ENABLED, c)
/** The `backdrop` prop for a frosted element, or undefined. */
export const frostBackdrop = (g: GlassTokens, c: FrostClass, radius: number): BackdropFilter | undefined => frosted(g, c) ? { ...BACKDROP.frost, radius } : undefined
/** A frost class's fill: the frost tint when it blurs, `denseFloat` when glass but not blurred, else the Solid fill. */
export function frostFill(g: GlassTokens, c: FrostClass, solid: string, tint: 'frost' | 'frostMenu' | 'frostStacked' = 'frost'): string {
  if (!g.on) return solid
  return frosted(g, c) ? g[tint] : g.denseFloat
}
/** A frost pill's fill under the pointer. */
export const frostHoverFill = (g: GlassTokens, c: FrostClass, solid: string) => !g.on ? solid : frosted(g, c) ? g.frostHover : g.denseHover

/** A settings list's card: the raised glass recipe on whole-window glass, the desktop's opaque card surface otherwise. */
export function settingsCardStyle(t: Theme, g: GlassTokens) {
  return { position: 'relative' as const, borderWidth: 1, borderColor: raisedRim(g, t.glass.settingsCardBorder), borderRadius: 12, backgroundColor: raisedFill(g, t.v('--app-settings-card-surface')) }
}
