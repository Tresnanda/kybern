// What a translucent window shows behind it on this OS (WP9, PORTING-PLATFORMS.md "Window material"):
//
//   vibrancy  macOS: the NSVisualEffectView material or the adjustable desktop blur (`shell/windowMaterial.ts`).
//   dwm       Windows 11 22H2+ (build 22621): DWM system backdrops, Mica or Acrylic (Settings › Appearance; the system
//             sets their strength), through the addon's `mica` / `acrylic` window backgrounds, tinted in Kybern's theme
//             (`shell/appearance.ts`). On by default (`DWM_BY_DEFAULT`).
//   linux-blur / linux-transparent: native display capability probe; blur strength belongs to the compositor.
//   none      X11 without composition, Windows 10, or an addon without the material capability: the window
//             stays opaque and the theme paints the Solid frame colour under the glass coats (`theme.ts` `materialFor`),
//             so frosted surfaces still blur what the app draws behind them.
//
// `KYBERN_DESKTOP_MATERIAL=vibrancy|dwm|none` pins it for checks. No React imports: `theme.ts` reads it while loading.
import { release } from 'node:os'
import { LINUX_DESKTOP_MATERIAL, WINDOW_MATERIALS } from '../native/local-build.ts'

export type DesktopMaterial = 'vibrancy' | 'dwm' | 'none' | 'linux-blur' | 'linux-transparent'

/** The build number of a Windows `os.release()` ("10.0.22631" → 22631); 0 when it is not one. */
export const windowsBuild = (value: string) => Number(value.split('.')[2]) || 0
/** The first Windows build with DWMWA_SYSTEMBACKDROP_TYPE (Windows 11 22H2). */
export const SYSTEM_BACKDROP_BUILD = 22621

/**
 * Mica and Acrylic are on for Windows 11 22H2+: on a real desktop they tint in Kybern's theme, and with the DWM frame left
 * unextended (the native default; `KYBERN_DWM_EXTEND_FRAME=1` extends it) DWM paints no caption glyphs of its own
 * (PORTING-PLATFORMS.md, WP9). CI captures cannot show them: they read the scene, not what DWM composes behind it.
 */
export const DWM_BY_DEFAULT = true

export function desktopMaterialFor(platform: NodeJS.Platform, osRelease: string, materials: readonly string[], pinned?: string, dwmByDefault = DWM_BY_DEFAULT, linux = { translucent: false, blur: false }): DesktopMaterial {
  if (platform === 'linux') {
    if (!linux.translucent || pinned === 'none') return 'none'
    return linux.blur ? 'linux-blur' : 'linux-transparent'
  }
  if (pinned === 'vibrancy' || pinned === 'dwm' || pinned === 'none') return pinned
  if (platform === 'darwin') return 'vibrancy'
  if (platform === 'win32' && windowsBuild(osRelease) >= SYSTEM_BACKDROP_BUILD && materials.includes('mica') && materials.includes('acrylic')) return dwmByDefault ? 'dwm' : 'none'
  return 'none'
}

export const DESKTOP_MATERIAL: DesktopMaterial = desktopMaterialFor(process.platform, release(), WINDOW_MATERIALS, process.env.KYBERN_DESKTOP_MATERIAL, DWM_BY_DEFAULT, LINUX_DESKTOP_MATERIAL)

export const LINUX_WITHOUT_BLUR = process.platform === 'linux' && DESKTOP_MATERIAL !== 'linux-blur'
export const WINDOW_MATERIAL_DESCRIPTION = DESKTOP_MATERIAL === 'linux-transparent'
  ? "This desktop can't blur, so the background shows through sharply." + (/gnome/i.test(process.env.XDG_CURRENT_DESKTOP ?? '') ? ' You can try the Blur my Shell extension.' : '')
  : DESKTOP_MATERIAL === 'none' ? 'Translucent turns the sidebar, menus and composer to glass. On this system the window itself stays solid.'
  : 'Translucent lets your desktop show through Kybern.'
