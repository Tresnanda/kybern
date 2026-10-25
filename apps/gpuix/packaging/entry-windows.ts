// The compiled Windows app's entry (`scripts/package-windows.ts`). The addon, daemon,
// fonts and version file sit beside this exe; the CLI is in `bin`, the one folder on the user's Path.
import path from 'node:path'
const resources = path.dirname(process.execPath)
process.env.KYBERN_GPUIX_RESOURCES = resources
process.env.NAPI_RS_NATIVE_LIBRARY_PATH = path.join(resources, 'gpuix-native.win32-x64-msvc.node')
process.env.KYBERN_GPUIX_NATIVE = 'local'
process.env.KYBERND ??= path.join(resources, 'kybernd.exe')
process.env.KYBERN_BUNDLED_CLI ??= path.join(resources, 'bin', 'kybern.exe')
process.env.KYBERN_GPUIX_VERSION = (await Bun.file(path.join(resources, 'version')).text()).trim()
await import('../src/main.tsx')
