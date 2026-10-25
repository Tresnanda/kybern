// How a Linux build of Kybern GPUIX was installed, and the AppImage's stable
// copies of its daemon and CLI. `scripts/package-linux.ts` writes the format
// into `resources/package` of each tree it packs (`appimage`, `deb`, `rpm`), so
// the updater never guesses from paths or package databases.
import { chmodSync, copyFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export type LinuxInstall =
  /** A running AppImage: `image` is the file the updater replaces. */
  | { kind: 'appimage'; image: string }
  | { kind: 'deb' | 'rpm' }
  /** An AppImage unpacked with `--appimage-extract`: nothing to replace in place. */
  | { kind: 'unpacked' }

const isFile = (file: string) => { try { return statSync(file).isFile() } catch { return false } }

/** The release AppImage's file name; the updater refuses one whose signature names another file. */
export const appImageName = (version: string, arch: string = process.arch) => `kybern-gpuix_${version}_${arch === 'arm64' ? 'aarch64' : 'x86_64'}.AppImage`

/** Null outside a packaged Linux build (a source run, macOS). */
export function linuxInstall(env: NodeJS.ProcessEnv = process.env, execPath = process.execPath, platform = process.platform): LinuxInstall | null {
  if (platform !== 'linux' || !env.KYBERN_GPUIX_RESOURCES) return null
  let format: string
  try { format = readFileSync(path.join(env.KYBERN_GPUIX_RESOURCES, 'package'), 'utf8').trim() } catch { return null }
  if (format === 'deb' || format === 'rpm') return { kind: format }
  if (format !== 'appimage') return null
  // The AppImage runtime sets both. A value inherited from another AppImage's
  // environment names a different mount than the one this process runs from.
  const { APPIMAGE: image, APPDIR: appDir } = env
  if (image && appDir && isFile(image) && execPath.startsWith(`${appDir.replace(/\/+$/, '')}/`)) return { kind: 'appimage', image }
  return { kind: 'unpacked' }
}

/**
 * Copy the image's `kybernd` and `kybern` to `$XDG_DATA_HOME/kybern-gpuix/bin`.
 * An AppImage is mounted only while the app runs, but kybernd outlives the app
 * and a linked `kybern` command must survive the next launch's new mount path.
 * Copies are refreshed by rename when the version stamp changes, so a running
 * daemon keeps its file. Returns null when that folder cannot be written; the
 * caller then runs the copies inside the image.
 */
export function stageAppImageCommands(appDir: string, version: string, dataHome = process.env.XDG_DATA_HOME || path.join(homedir(), '.local/share')): { kybernd: string; kybern: string } | null {
  const dir = path.join(dataHome, 'kybern-gpuix/bin')
  const names = ['kybernd', 'kybern'] as const
  try {
    const stamp = `${version} ${names.map(name => statSync(path.join(appDir, name)).size).join(' ')}`
    const stampFile = path.join(dir, 'stamp')
    let current = ''
    try { current = readFileSync(stampFile, 'utf8').trim() } catch { /* First launch. */ }
    if (current !== stamp || !names.every(name => isFile(path.join(dir, name)))) {
      mkdirSync(dir, { recursive: true })
      for (const name of names) {
        const temp = path.join(dir, `.${name}.${process.pid}.new`)
        copyFileSync(path.join(appDir, name), temp)
        chmodSync(temp, 0o755)
        renameSync(temp, path.join(dir, name))
      }
      writeFileSync(stampFile, `${stamp}\n`)
    }
    return { kybernd: path.join(dir, 'kybernd'), kybern: path.join(dir, 'kybern') }
  } catch { return null }
}

/** The command a deb or rpm install updates with, run in the folder holding the downloaded `file`. */
export function packageCommand(kind: 'deb' | 'rpm', file: string, zypper = isFile('/usr/bin/zypper')): string {
  if (kind === 'deb') return `sudo apt install ./${file}`
  // The packages are not GPG-signed; dnf installs a local file without asking, zypper needs the flag.
  return zypper ? `sudo zypper install --allow-unsigned-rpm ./${file}` : `sudo dnf install ./${file}`
}
