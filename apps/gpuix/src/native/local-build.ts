// Use the Kybern-patched GPUIX native module (apps/gpuix/native) when it has
// been built. Imported first by main.tsx: @gpuix/native reads this variable when
// it loads. An explicit NAPI_RS_NATIVE_LIBRARY_PATH selects another local build;
// KYBERN_GPUIX_NATIVE=npm disables the default override (and the island helpers).
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { UNIVERSAL_PROPS } from '@gpuix/native/host'
import { fileURLToPath } from 'node:url'

/**
 * napi-rs's name for this machine's addon: `darwin-arm64` on Apple Silicon,
 * `darwin-x64` on Intel, `linux-x64-gnu` and `win32-x64-msvc` for the ADE-52 port.
 */
export const NATIVE_ARCH =
  process.platform === 'linux' ? `linux-${process.arch}-gnu` : process.platform === 'win32' ? `win32-${process.arch}-msvc` : `darwin-${process.arch}`
const built = fileURLToPath(new URL(`../../native/build/gpuix-native.${NATIVE_ARCH}.node`, import.meta.url))

export const PATCHED_NATIVE =
  (process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32') &&
  (process.arch === 'arm64' || process.arch === 'x64') &&
  process.env.KYBERN_GPUIX_NATIVE !== 'npm' &&
  existsSync(process.env.NAPI_RS_NATIVE_LIBRARY_PATH ?? built)

if (PATCHED_NATIVE && !process.env.NAPI_RS_NATIVE_LIBRARY_PATH) process.env.NAPI_RS_NATIVE_LIBRARY_PATH = built

interface Capabilities { edgeFade?: boolean; backdrop?: boolean; windowMaterials?: unknown }
/** `kybernCapabilities()` of the addon this process loads, read once; the stock addon has none. */
const CAPABILITIES: Capabilities = PATCHED_NATIVE ? (() => {
  try {
    const addon = createRequire(import.meta.url)(process.env.NAPI_RS_NATIVE_LIBRARY_PATH!) as { kybernCapabilities?: () => Capabilities }
    return addon.kybernCapabilities?.() ?? {}
  } catch { return {} }
})() : {}
/** Native `edgeFade` (an alpha ramp toward an element's edges, `src/native/backdrop.ts`); patched builds without it report false. */
export const EDGE_FADE: boolean = CAPABILITIES.edgeFade === true
/**
 * The scene `backdrop` filter blurs on this OS's renderer: Metal in every patched macOS build, wgpu (Linux) and Direct3D 11
 * (Windows) in builds that report it (WP9). Without it a `backdrop` prop draws nothing and only the fill above it shows, so
 * frosted surfaces take their dense fills instead (`platform/glass.ts`, `platform/material.ts`).
 */
export const BACKDROP_BLUR: boolean = PATCHED_NATIVE && (process.platform === 'darwin' || CAPABILITIES.backdrop === true)
/** Window backgrounds the addon takes beyond opaque/blurred/transparent: `mica`, `mica-alt`, `acrylic` on Windows (WP9). */
export const WINDOW_MATERIALS: readonly string[] = Array.isArray(CAPABILITIES.windowMaterials) ? CAPABILITIES.windowMaterials.filter((m): m is string => typeof m === 'string') : []
// The reconciler forwards only listed props from built-in elements; the pinned JS patch predates `edgeFade`.
if (EDGE_FADE) (UNIVERSAL_PROPS as Set<string>).add('edgeFade')
