// The Linux counterpart of `entry.ts`. `scripts/package-linux.ts` lays the app
// out as one folder: this executable, `kybernd`, `kybern` and `resources/`.
import path from 'node:path'
import { stageAppImageCommands } from '../src/platform/linuxPackage.ts'
const root = path.dirname(process.execPath)
const resources = path.join(root, 'resources')
process.env.KYBERN_GPUIX_RESOURCES = resources
process.env.NAPI_RS_NATIVE_LIBRARY_PATH = path.join(resources, `gpuix-native.linux-${process.arch}-gnu.node`)
process.env.KYBERN_GPUIX_NATIVE = 'local'
process.env.KYBERN_GPUIX_VERSION = (await Bun.file(path.join(resources, 'version')).text()).trim()
// An AppImage's mount goes away when the app quits; kybernd outlives it (`linuxPackage.ts`).
const staged = process.env.APPIMAGE && process.env.APPDIR && root.startsWith(process.env.APPDIR) ? stageAppImageCommands(root, process.env.KYBERN_GPUIX_VERSION) : null
if (staged) process.env.KYBERN_GPUIX_PACKAGED_DAEMON = staged.kybernd
process.env.KYBERND ??= staged?.kybernd ?? path.join(root, 'kybernd')
process.env.KYBERN_BUNDLED_CLI ??= staged?.kybern ?? path.join(root, 'kybern')
await import('../src/main.tsx')
