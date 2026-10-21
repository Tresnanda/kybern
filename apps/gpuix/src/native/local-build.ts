// Use the Kybern-patched GPUIX native module (apps/gpuix/native) when it has
// been built. Imported first by main.tsx: @gpuix/native reads this variable when
// it loads. An explicit NAPI_RS_NATIVE_LIBRARY_PATH selects another local build;
// KYBERN_GPUIX_NATIVE=npm disables the default override (and the island helpers).
import { existsSync } from 'node:fs'
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
