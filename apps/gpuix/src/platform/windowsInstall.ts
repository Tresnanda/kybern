import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * The folder of an installed copy on Windows, or null for anything else: a loose copy, `bun`, a build output folder.
 * The installer writes `uninstall.exe` beside the app, which is what marks an installed copy. Light enough for the
 * notification identity (`native/notifications.ts`) to ask at startup; `update.ts` adds its test override on top.
 */
export function installedWindowsFolder(execPath = process.execPath, exists: (file: string) => boolean = existsSync): string | null {
  if (path.win32.basename(execPath).toLowerCase() !== 'kybern gpuix.exe') return null
  const dir = path.win32.dirname(execPath)
  return exists(path.win32.join(dir, 'uninstall.exe')) ? dir : null
}
