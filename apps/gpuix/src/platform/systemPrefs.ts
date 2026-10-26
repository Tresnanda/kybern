// Windows and Linux appearance and motion preferences read before the window exists (WP3), so the first frame is drawn
// in the right theme and motion. Once the window is up GPUI reports appearance live (`shell/windowChrome.ts`: the
// registry on Windows, the freedesktop portal's `color-scheme` on Linux) and Windows' "Animation effects" through the
// addon; GNOME's `enable-animations` is followed with `gsettings monitor`. No app imports: `ui.tsx` and
// `reducedMotion.ts` read these while modules initialise. macOS keeps its own reads.
import { spawn, spawnSync } from 'node:child_process'

type Run = (command: string, args: string[]) => string | null

const run: Run = (command, args) => {
  try {
    const r = spawnSync(command, args, { encoding: 'utf8', timeout: 1500, windowsHide: true })
    return r.status === 0 ? r.stdout : null
  } catch {
    return null
  }
}

/** Windows: `AppsUseLightTheme` 0 is dark. Linux: GNOME's `color-scheme` (`prefer-dark`), else the GTK theme's name. */
export function readSystemVariant(platform: NodeJS.Platform = process.platform, exec: Run = run): 'dark' | 'light' | null {
  if (platform === 'win32') {
    const out = exec('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', '/v', 'AppsUseLightTheme'])
    const value = out?.match(/AppsUseLightTheme\s+REG_DWORD\s+0x([0-9a-f]+)/i)?.[1]
    return value === undefined ? null : parseInt(value, 16) === 0 ? 'dark' : 'light'
  }
  if (platform === 'linux') {
    const scheme = exec('gsettings', ['get', 'org.gnome.desktop.interface', 'color-scheme'])?.trim()
    if (scheme?.includes('prefer-dark')) return 'dark'
    if (scheme?.includes('prefer-light')) return 'light'
    const theme = exec('gsettings', ['get', 'org.gnome.desktop.interface', 'gtk-theme'])?.trim()
    if (theme) return /dark/i.test(theme) ? 'dark' : 'light'
  }
  return null
}

/** Linux: GNOME's `enable-animations` false means reduced motion. Null when it cannot be read (Windows asks the addon). */
export function readLinuxReducedMotion(exec: Run = run): boolean | null {
  const out = exec('gsettings', ['get', 'org.gnome.desktop.interface', 'enable-animations'])?.trim()
  return out === 'false' ? true : out === 'true' ? false : null
}

/** What a double click on the title bar does on GNOME (`action-double-click-titlebar`), in the addon's names. */
export function readTitlebarDoubleClick(exec: Run = run): 'maximize' | 'minimize' | 'menu' | 'none' {
  const out = exec('gsettings', ['get', 'org.gnome.desktop.wm.preferences', 'action-double-click-titlebar'])?.trim().replace(/'/g, '')
  switch (out) {
    case 'minimize': return 'minimize'
    case 'menu': return 'menu'
    case 'none': case 'lower': return 'none'
    default: return 'maximize'
  }
}

/** Follow one GNOME key while the app runs. Returns a stop function; a missing `gsettings` just never calls back. */
export function watchGnomeSetting(schema: string, key: string, onChange: (value: string) => void): () => void {
  try {
    const child = spawn('gsettings', ['monitor', schema, key], { stdio: ['ignore', 'pipe', 'ignore'] })
    child.on('error', () => {})
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        const value = line.slice(line.indexOf(':') + 1).trim()
        if (line.includes(':') && value) onChange(value)
      }
    })
    child.unref()
    ;(child.stdout as { unref?: () => void } | null)?.unref?.()
    return () => child.kill()
  } catch {
    return () => {}
  }
}
