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
const { APPIMAGE, APPDIR } = process.env
if (APPIMAGE && APPDIR && root.startsWith(`${APPDIR.replace(/\/+$/, '')}/`)) {
  // An AppImage's mount goes away when the app quits; kybernd outlives it (`linuxPackage.ts`). The daemon and CLI run
  // only from the staged copies, never from the mount: if neither folder is writable they stay unset and the shell
  // says so (`shell/daemon.ts`). Values inherited from another install's environment are replaced, not trusted.
  const staged = stageAppImageCommands(root, process.env.KYBERN_GPUIX_VERSION)
  delete process.env.KYBERND
  delete process.env.KYBERN_BUNDLED_CLI
  delete process.env.KYBERN_GPUIX_PACKAGED_DAEMON
  if (staged) {
    process.env.KYBERN_GPUIX_PACKAGED_DAEMON = staged.kybernd
    process.env.KYBERND = staged.kybernd
    process.env.KYBERN_BUNDLED_CLI = staged.kybern
  }
} else {
  delete process.env.KYBERN_GPUIX_PACKAGED_DAEMON
  process.env.KYBERND ??= path.join(root, 'kybernd')
  process.env.KYBERN_BUNDLED_CLI ??= path.join(root, 'kybern')
}
await import('../src/main.tsx')
