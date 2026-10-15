// Use the Kybern-patched GPUIX native module (apps/gpuix/native) when it has
// been built. Imported first by main.tsx: @gpuix/native reads this variable when
// it loads. An explicit NAPI_RS_NATIVE_LIBRARY_PATH, or KYBERN_GPUIX_NATIVE=npm,
// keeps the stock npm binary (cached islands then render inline).
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const built = fileURLToPath(new URL('../../native/build/gpuix-native.darwin-arm64.node', import.meta.url))

export const PATCHED_NATIVE =
  process.platform === 'darwin' &&
  process.arch === 'arm64' &&
  process.env.KYBERN_GPUIX_NATIVE !== 'npm' &&
  !process.env.NAPI_RS_NATIVE_LIBRARY_PATH &&
  existsSync(built)

if (PATCHED_NATIVE) process.env.NAPI_RS_NATIVE_LIBRARY_PATH = built
