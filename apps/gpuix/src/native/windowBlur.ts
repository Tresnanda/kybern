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

const debug = (message: string) => { if (process.env.KYBERN_DEBUG_MATERIAL) console.log(`[material] ${message}`) }

/**
 * Set the desktop blur behind every GPUI window. Returns true only if the window server accepted every call.
 * A radius above zero also makes the window non-opaque with a nearly clear background: the blur only shows
 * through such a window, and a fully clear one (alpha 0) with a native shadow draws a gap between border and
 * content, so a sliver of alpha stays (`setWindowBackground('transparent')` writes 0.0001). Radius 0 only
 * clears the blur and leaves the window as GPUI's backing set it.
 */
export function setWindowBlurRadius(radius: number): boolean {
  if (process.platform !== 'darwin' || process.env.KYBERN_WINDOW_BLUR_FAIL === '1') return false
  const api = resolve()
  if (!api) return false
  try {
    const o = getObjc()
    const app = nsApp()
    if (!app) return false
    const value = clampRadius(radius)
    let ok = true, found = false
    withPool(o, () => {
      each(o, o.msg(app, sel(o, 'windows')) as Pointer, (window) => {
        if (!o.msg(window, sel(o, 'contentView'))) return
        const name = className(o, window)
        if (!name.includes('GPUI')) return
        found = true
        if (value > 0) {
          o.msgSetBool(window, sel(o, 'setOpaque:'), false)
          const clear = o.msg(cls(o, 'NSColor')!, sel(o, 'clearColor')) as Pointer
          o.msgSetPtr(window, sel(o, 'setBackgroundColor:'), o.msgF64Ptr(clear, sel(o, 'colorWithAlphaComponent:'), 0.01) as Pointer)
        }
        const code = api.set(api.main(), Number(o.msgU64(window, sel(o, 'windowNumber'))), value)
        debug(`CGSSetWindowBackgroundBlurRadius(${value}) -> ${code}`)
        ok = code === 0 && ok
        if (value > 0) {
          o.msgSetBool(window, sel(o, 'setHasShadow:'), true)
          o.msg(window, sel(o, 'invalidateShadow'))
        }
      })
    })
    return found && ok
  } catch (error) {
    debug(`blur failed: ${error}`)
    return false
  }
}
