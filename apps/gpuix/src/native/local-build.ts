// Use the Kybern-patched GPUIX native module (apps/gpuix/native) when it has
// been built. Imported first by main.tsx: @gpuix/native reads this variable when
// it loads. An explicit NAPI_RS_NATIVE_LIBRARY_PATH selects another local build;
// KYBERN_GPUIX_NATIVE=npm disables the default override (and the island helpers).
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { UNIVERSAL_PROPS } from '@gpuix/native/host'
import { fileURLToPath } from 'node:url'

/** napi-rs's name for this Mac's addon: `darwin-arm64` on Apple Silicon, `darwin-x64` on Intel. */
export const NATIVE_ARCH = `darwin-${process.arch}`
const built = fileURLToPath(new URL(`../../native/build/gpuix-native.${NATIVE_ARCH}.node`, import.meta.url))

export const PATCHED_NATIVE =
  process.platform === 'darwin' &&
  (process.arch === 'arm64' || process.arch === 'x64') &&
  process.env.KYBERN_GPUIX_NATIVE !== 'npm' &&
  existsSync(process.env.NAPI_RS_NATIVE_LIBRARY_PATH ?? built)

if (PATCHED_NATIVE && !process.env.NAPI_RS_NATIVE_LIBRARY_PATH) process.env.NAPI_RS_NATIVE_LIBRARY_PATH = built

/** Native `edgeFade` (an alpha ramp toward an element's edges, `src/native/backdrop.ts`). Read once from the
 * addon this process loads; the stock addon and patched builds without it report false. */
export const EDGE_FADE: boolean = PATCHED_NATIVE && (() => {
  try {
    const addon = createRequire(import.meta.url)(process.env.NAPI_RS_NATIVE_LIBRARY_PATH!) as { kybernCapabilities?: () => { edgeFade?: boolean } }
    return addon.kybernCapabilities?.()?.edgeFade === true
  } catch { return false }
})()
// The reconciler forwards only listed props from built-in elements; the pinned JS patch predates `edgeFade`.
if (EDGE_FADE) (UNIVERSAL_PROPS as Set<string>).add('edgeFade')
