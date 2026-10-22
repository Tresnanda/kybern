// Adjustable desktop blur behind the window: the private CGSSetWindowBackgroundBlurRadius
// call (the one iTerm2, Ghostty and Synara use), resolved at runtime so a macOS without it
// reports failure and the caller keeps vibrancy.
//
// Ported from Synara, apps/desktop/native/window-material/WindowMaterial.m and
// apps/desktop/src/windowMaterial.ts (MIT License):
//   Copyright (c) 2026 T3 Tools Inc.
//   Copyright (c) 2026 Emanuele Di Pietro
// Full notice: THIRD_PARTY_NOTICES.md at the repository root.
//
// WindowServer only accepts the call from the connection that owns the window, so it runs in
// this process through Bun FFI, like `material.ts` reaches AppKit. No addon, no GPUI change.
import { dlopen, FFIType, type Pointer } from 'bun:ffi'
import { NATIVE_BLUR_MAX } from '../platform/translucency.ts'
import { className, cls, each, getObjc, nsApp, sel, withPool } from './objc.ts'

type Cgs = { main: () => number; set: (cid: number, window: number, radius: number) => number }
const LIBRARIES = [
  '/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics',
  '/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight',
]

function load(): Cgs | null {
  for (const library of LIBRARIES) {
    try {
      const { symbols } = dlopen(library, {
        CGSMainConnectionID: { args: [], returns: FFIType.i32 },
        CGSSetWindowBackgroundBlurRadius: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      })
      return { main: () => symbols.CGSMainConnectionID(), set: (cid, window, radius) => symbols.CGSSetWindowBackgroundBlurRadius(cid, window, radius) }
    } catch { /* Try the next library. */ }
  }
  return null
}

let loader: () => Cgs | null = load
let cgs: Cgs | null | undefined // resolved once; null = unavailable
function resolve(): Cgs | null {
  if (cgs === undefined) {
    try { cgs = loader() } catch { cgs = null }
  }
  return cgs
}
/** Tests inject the resolver; `undefined` restores the real one. */
export function setCgsLoaderForTest(next: (() => Cgs | null) | undefined) {
  loader = next ?? load
  cgs = undefined
}

export const clampRadius = (radius: number) => Math.max(0, Math.min(NATIVE_BLUR_MAX, Math.round(radius)))

// The windows already made transparent by a blur above zero. The window flags below only change when a window enters the
// transparent mode, so a blur slider drag then calls CGS alone. Radius 0 or a refusal forgets them: the window may go back
// to another backing, and the next blur must set them again.
const flagged = new Set<number>()
/** True when `window` still needs its transparent-mode flags for a blur of `radius`; remembers it. */
export function claimTransparentFlags(window: number, radius: number): boolean {
  if (radius <= 0) return false
  if (flagged.has(window)) return false
  flagged.add(window)
  return true
}
export const forgetTransparentFlags = () => flagged.clear()

const debug = (message: string) => { if (process.env.KYBERN_DEBUG_MATERIAL) console.log(`[material] ${message}`) }

/** Whether this process can call the private blur at all. False is final: retrying cannot change it. */
export function blurCallAvailable(): boolean {
  return process.platform === 'darwin' && process.env.KYBERN_WINDOW_BLUR_FAIL !== '1' && resolve() !== null
}

/**
 * Set the desktop blur behind every GPUI window: `ok` once the window server accepted every call, `not-ready` while there is
 * no GPUI window yet (worth retrying), `unavailable` when the call is missing or a shown window's call was refused.
 * A radius above zero also makes the window non-opaque with a nearly clear background: the blur only shows
 * through such a window, and a fully clear one (alpha 0) with a native shadow draws a gap between border and
 * content, so a sliver of alpha stays (`setWindowBackground('transparent')` writes 0.0001). That, and the shadow
 * refresh, happen once when a window enters the mode; later radii only call CGS. Radius 0 only clears the blur
 * and leaves the window as GPUI's backing set it.
 */
export function setWindowBlurRadius(radius: number): 'ok' | 'not-ready' | 'unavailable' {
  if (!blurCallAvailable()) return 'unavailable'
  const api = resolve()!
  try {
    const o = getObjc()
    const app = nsApp()
    if (!app) return 'not-ready'
    const value = clampRadius(radius)
    let ok = true, found = false, shown = false
    withPool(o, () => {
      each(o, o.msg(app, sel(o, 'windows')) as Pointer, (window) => {
        if (!o.msg(window, sel(o, 'contentView'))) return
        const name = className(o, window)
        if (!name.includes('GPUI')) return
        found = true
        const windowNumber = Number(o.msgU64(window, sel(o, 'windowNumber')))
        const entering = claimTransparentFlags(windowNumber, value)
        if (entering) {
          o.msgSetBool(window, sel(o, 'setOpaque:'), false)
          const clear = o.msg(cls(o, 'NSColor')!, sel(o, 'clearColor')) as Pointer
          o.msgSetPtr(window, sel(o, 'setBackgroundColor:'), o.msgF64Ptr(clear, sel(o, 'colorWithAlphaComponent:'), 0.01) as Pointer)
        }
        // A window not yet on screen has no window-server number; its refusal says nothing about the call.
        if (windowNumber > 0) shown = true
        const code = api.set(api.main(), windowNumber, value)
        debug(`CGSSetWindowBackgroundBlurRadius(${value}) -> ${code}`)
        ok = code === 0 && ok
        if (entering) {
          o.msgSetBool(window, sel(o, 'setHasShadow:'), true)
          o.msg(window, sel(o, 'invalidateShadow'))
        }
      })
    })
    if (value === 0 || !ok) forgetTransparentFlags()
    if (found && ok) return 'ok'
    return found && shown ? 'unavailable' : 'not-ready'
  } catch (error) {
    debug(`blur failed: ${error}`)
    return 'unavailable'
  }
}
