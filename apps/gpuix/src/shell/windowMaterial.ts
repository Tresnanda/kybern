// Applies the window material to the native window: GPUI's backing (opaque, blurred or transparent)
// and, for a custom blur, the window-server blur radius behind it.
//
// Ported from Synara, apps/desktop/src/windowMaterial.ts (createWindowMaterialApplier) and
// apps/web/src/hooks/useTheme.ts (syncDesktopWindowMaterial) (MIT License):
//   Copyright (c) 2026 T3 Tools Inc.
//   Copyright (c) 2026 Emanuele Di Pietro
// Full notice: THIRD_PARTY_NOTICES.md at the repository root.
//
// - Solid, Reduce transparency, Increase contrast, `KYBERN_OPAQUE` and glass that fully covers the desktop → 'opaque', blur radius 0.
// - Blur Auto → 'blurred': GPUI's `NSVisualEffectView`, tuned to the desktop's vibrancy (`native/material.ts`).
// - Blur 1–64 → 'transparent' plus `CGSSetWindowBackgroundBlurRadius` (`native/windowBlur.ts`). If the private
//   call is refused the window falls back to the vibrancy material and the Settings button reads
//   "Unavailable, use Auto". Vibrancy always applies; only a custom blur can be refused.
// - Windows 11 22H2+ (`platform/desktopMaterial.ts`, WP9): Auto → Mica, a custom blur → Acrylic (DWM; the system sets the
//   strength, so the radius is not applied), opaque stays opaque. Linux and Windows 10: always opaque; the theme paints the
//   Solid frame colour under the glass (`theme.ts`).
import { useEffect, useSyncExternalStore } from 'react'
import { useGpuix } from '@gpuix/react'
import { applyDesktopMaterial } from '../native/material.ts'
import { blurCallAvailable, forgetTransparentFlags, setWindowBlurRadius } from '../native/windowBlur.ts'
import { DESKTOP_MATERIAL, type DesktopMaterial } from '../platform/desktopMaterial.ts'
import { OPAQUE_COVERAGE, type ThemeVariant, type VariantMaterial, type WindowScope } from '../platform/translucency.ts'
import { windowCoverage } from '../theme.ts'
import { syncWindowAppearance } from './appearance.ts'

export type Backing = { mode: 'opaque' | 'blurred' | 'transparent'; radius: number }
/**
 * Opaque when nothing can show through: Solid and the accessibility overrides, and any scope whose lightest region covers
 * the desktop (`windowCoverage` ≥ `OPAQUE_COVERAGE`: light Sidebar only at the default 90, or both opacities 100). Blurring the
 * desktop behind an opaque window only costs WindowServer; the colours are unchanged.
 */
export function backingFor(m: Pick<VariantMaterial, 'blur' | 'sidebarOpacity' | 'contentOpacity'>, scope: WindowScope, variant: ThemeVariant): Backing {
  if (scope === 'none' || windowCoverage(variant, scope, m.sidebarOpacity, m.contentOpacity) >= OPAQUE_COVERAGE) return { mode: 'opaque', radius: 0 }
  return m.blur === null ? { mode: 'blurred', radius: 0 } : { mode: 'transparent', radius: m.blur }
}

/** The addon's window background for `backing` on this OS: macOS takes the backing as it is (`apply` adds the blur). */
export type NativeBackground = Backing['mode'] | 'mica' | 'acrylic'
export function nativeBackground(backing: Backing, material: DesktopMaterial = DESKTOP_MATERIAL): NativeBackground {
  if (material === 'vibrancy') return backing.mode
  if (material === 'none' || backing.mode === 'opaque') return 'opaque'
  return backing.mode === 'blurred' ? 'mica' : 'acrylic'
}

// The source's `lastDesktopWindowMaterial`: the last applied `${mode}:${radius}:${variant}`, so an unchanged render does nothing.
let lastKey: string | null = null
let blurEverApplied = false
let unavailable = false
const listeners = new Set<() => void>()
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
function setUnavailable(value: boolean) {
  if (unavailable === value) return
  unavailable = value
  for (const l of listeners) l()
}
/** The custom blur was refused on this macOS. Only a `transparent` attempt re-evaluates it. */
export const useBlurUnavailable = () => useSyncExternalStore(subscribe, () => unavailable)
export const blurUnavailable = () => unavailable

type Renderer = { setWindowBackground?: (mode: string) => void }
let warned = false
/** GPUI's current backing; `main.tsx` creates the window with it, so the first apply only changes what differs. */
let nativeMode: NativeBackground | null = null
let knownRenderer: Renderer | undefined
function setBackground(renderer: Renderer | null | undefined, mode: NativeBackground) {
  if (nativeMode === mode) return
  const target = renderer ?? knownRenderer
  if (!target?.setWindowBackground) {
    if (!warned) { warned = true; console.log('[material] runtime backing needs the patched addon') }
    return
  }
  try { target.setWindowBackground(mode); nativeMode = mode; forgetTransparentFlags(); if (process.env.KYBERN_DEBUG_MATERIAL) console.log(`[material] window background ${mode}`) } catch (error) { console.error('[material] window background:', error) }
}

let timer: ReturnType<typeof setTimeout> | undefined
/** Retry for up to two seconds: GPUI creates the window and its blur view a few frames after `render`. `step` returns true when
 * done, false to try again, or 'give-up' when trying again cannot help. */
function retry(step: () => boolean | 'give-up', onGiveUp?: () => void) {
  let tries = 0
  const tick = () => {
    const done = step()
    if (done === 'give-up') { onGiveUp?.(); return }
    if (done) return
    if (++tries > 40) { onGiveUp?.(); return }
    timer = setTimeout(tick, 50)
  }
  clearTimeout(timer)
  timer = setTimeout(tick, 0)
}

const vibrancy = (variant: ThemeVariant) => retry(() => applyDesktopMaterial(variant))

/** Move the window to `backing`. */
function apply(renderer: Renderer | null | undefined, backing: Backing, variant: ThemeVariant) {
  clearTimeout(timer)
  if (DESKTOP_MATERIAL !== 'vibrancy') {
    setBackground(renderer, nativeBackground(backing))
    return
  }
  if (backing.mode === 'opaque') {
    setBackground(renderer, 'opaque')
    if (blurEverApplied) setWindowBlurRadius(0)
    syncWindowAppearance(variant)
    return
  }
  if (backing.mode === 'blurred') {
    setBackground(renderer, 'blurred')
    if (blurEverApplied) setWindowBlurRadius(0)
    vibrancy(variant)
    return
  }
  // Refused, or the private call is gone: keep the vibrancy material.
  const fallBack = () => {
    setUnavailable(true)
    setBackground(renderer, 'blurred')
    vibrancy(variant)
  }
  // Without the call there is nothing to wait for, and the window never shows the sharp desktop through a clear backing.
  if (!blurCallAvailable()) return fallBack()
  // transparent: on the next tick, after GPUI has applied its own background change.
  setBackground(renderer, 'transparent')
  retry(() => {
    const result = setWindowBlurRadius(backing.radius)
    if (result === 'unavailable') return 'give-up'
    if (result === 'not-ready') return false
    blurEverApplied = true
    setUnavailable(false)
    return true
  }, fallBack)
}

/**
 * Launch (`main.tsx`): GPUI was created with `backing.mode` and the renderer does not exist yet. Start the window-server
 * blur once the window is up. GPUI keeps a `transparent` creation option as blurred until `setWindowBackground` runs,
 * so a transparent launch is applied again from the first `useWindowMaterial` effect (the key stays unset).
 */
export function installWindowMaterial(backing: Backing, variant: ThemeVariant) {
  if (DESKTOP_MATERIAL !== 'vibrancy') {
    // Created with `nativeBackground(backing)` (main.tsx), which GPUI applies itself.
    nativeMode = nativeBackground(backing)
    return
  }
  nativeMode = backing.mode === 'transparent' ? null : backing.mode
  if (backing.mode !== 'opaque') apply(null, backing, variant)
}

/** Keep the native window in step with the theme: called from `ThemeProvider`. */
export function useWindowMaterial(variant: ThemeVariant, m: Pick<VariantMaterial, 'blur' | 'sidebarOpacity' | 'contentOpacity'>, scope: WindowScope) {
  const renderer = useGpuix()?.renderer as Renderer | undefined
  knownRenderer = renderer
  const backing = backingFor(m, scope, variant)
  const key = `${backing.mode}:${backing.radius}:${variant}`
  useEffect(() => {
    if (key === lastKey) return
    lastKey = key
    apply(renderer, backing, variant)
  }, [key])
}
