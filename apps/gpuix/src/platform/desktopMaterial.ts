// What a translucent window shows behind it on this OS (WP9, PORTING-PLATFORMS.md "Window material"):
//
//   vibrancy  macOS: the NSVisualEffectView material or the adjustable desktop blur (`shell/windowMaterial.ts`).
//   dwm       Windows 11 22H2+ (build 22621): DWM system backdrops, Mica or Acrylic (Settings › Appearance; the system
//             sets their strength), through the addon's `mica` / `acrylic` window backgrounds, tinted in Kybern's theme
//             (`shell/appearance.ts`). Opt-in for now (`DWM_BY_DEFAULT`).
//   none      Linux (no compositor material standard), Windows 10, or an addon without the Windows materials: the window
//             stays opaque and the theme paints the Solid frame colour under the glass coats (`theme.ts` `materialFor`),
//             so frosted surfaces still blur what the app draws behind them.
//
// `KYBERN_DESKTOP_MATERIAL=vibrancy|dwm|none` pins it for checks. No React imports: `theme.ts` reads it while loading.
import { release } from 'node:os'
import { WINDOW_MATERIALS } from '../native/local-build.ts'

export type DesktopMaterial = 'vibrancy' | 'dwm' | 'none'

/** The build number of a Windows `os.release()` ("10.0.22631" → 22631); 0 when it is not one. */
export const windowsBuild = (value: string) => Number(value.split('.')[2]) || 0
/** The first Windows build with DWMWA_SYSTEMBACKDROP_TYPE (Windows 11 22H2). */
export const SYSTEM_BACKDROP_BUILD = 22621

/**
 * Mica and Acrylic stay opt-in (`KYBERN_DESKTOP_MATERIAL=dwm`) until they have been seen on a real Windows 11 desktop: CI
 * captures read the scene, not what DWM composes behind it, so neither the tint in Kybern's theme nor the frame extension
 * has been checked (PORTING-PLATFORMS.md, WP9). Until then Windows 11 is opaque like Windows 10.
 */
export const DWM_BY_DEFAULT = false

export function desktopMaterialFor(platform: NodeJS.Platform, osRelease: string, materials: readonly string[], pinned?: string, dwmByDefault = DWM_BY_DEFAULT): DesktopMaterial {
  if (pinned === 'vibrancy' || pinned === 'dwm' || pinned === 'none') return pinned
  if (platform === 'darwin') return 'vibrancy'
  if (platform === 'win32' && windowsBuild(osRelease) >= SYSTEM_BACKDROP_BUILD && materials.includes('mica') && materials.includes('acrylic')) return dwmByDefault ? 'dwm' : 'none'
  return 'none'
}

export const DESKTOP_MATERIAL: DesktopMaterial = desktopMaterialFor(process.platform, release(), WINDOW_MATERIALS, process.env.KYBERN_DESKTOP_MATERIAL)
