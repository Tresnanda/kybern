// Reduce transparency and Increase contrast off macOS (WP9 review S3), for `platform/material.ts`:
//
//   Windows  Settings › Personalization › Colors › Transparency effects (HKCU …\Themes\Personalize EnableTransparency = 0)
//            and a contrast theme (SystemParametersInfo SPI_GETHIGHCONTRAST, HCF_HIGHCONTRASTON). Read through bun:ffi on
//            every poll of the window shell: two calls of a few microseconds, no process.
//   Linux    increaseContrast only (no desktop has a transparency switch): GNOME's
//            `org.gnome.desktop.a11y.interface high-contrast`, followed live by the schema's shared `gsettings monitor`
//            (`systemPrefs.ts` `watchGsettings`, killed on exit), and the
//            freedesktop portal's `org.freedesktop.appearance contrast` (GNOME 47+, KDE Plasma 6), read once at launch.
//
// Reduce motion is not read here: WP3 reads the OS theme and reduced motion off macOS in its own module; this one stays
// limited to the two options that turn scene backdrops and the window material off.
import { dlopen, FFIType } from 'bun:ffi'
import { spawn } from 'node:child_process'
import { watchGsettings } from './systemPrefs.ts'

export interface OsDisplay { reduceTransparency: boolean; increaseContrast: boolean }

/** `gsettings get` / `gsettings monitor` output: `true`, `false`, or `high-contrast: true`. */
export function parseGsettingsBool(line: string): boolean | null {
  const value = line.trim().split(/\s+/).pop()
  return value === 'true' ? true : value === 'false' ? false : null
}
/** A portal `ReadOne` (`(<uint32 1>,)`) or `Read` (`(<<uint32 1>>,)`) reply: contrast 1 is high contrast. */
export function parsePortalContrast(reply: string): boolean | null {
  const match = /uint32\s+(\d+)/.exec(reply)
  return match ? match[1] === '1' : null
}

/** What Settings says when an option keeps Kybern solid, in this OS's words. */
export function solidReason(a11y: OsDisplay, platform: NodeJS.Platform = process.platform): string | undefined {
  if (!a11y.reduceTransparency && !a11y.increaseContrast) return undefined
  if (platform === 'win32') {
    return a11y.increaseContrast && a11y.reduceTransparency ? 'A contrast theme is on and transparency effects are off in Windows Settings, so Kybern stays solid.'
      : a11y.increaseContrast ? 'A contrast theme is on in Windows Settings, so Kybern stays solid.'
      : 'Transparency effects are off in Windows Settings, so Kybern stays solid.'
  }
  if (platform === 'linux') return 'High contrast is on in your system settings, so Kybern stays solid.'
  return a11y.reduceTransparency && a11y.increaseContrast ? 'Reduce transparency and Increase contrast are on in System Settings, so Kybern stays solid.'
    : a11y.reduceTransparency ? 'Reduce transparency is on in System Settings, so Kybern stays solid.'
    : 'Increase contrast is on in System Settings, so Kybern stays solid.'
}

// ---- Windows ----

type WindowsCalls = {
  systemParametersInfo: (action: number, size: number, data: Uint32Array, flags: number) => number
  regGetValue: (key: bigint, subkey: Uint8Array, value: Uint8Array, flags: number, type: null, data: Uint32Array, size: Uint32Array) => number
}
let windowsCalls: WindowsCalls | null | undefined
function windows(): WindowsCalls | null {
  if (windowsCalls !== undefined) return windowsCalls
  try {
    const user32 = dlopen('user32.dll', { SystemParametersInfoW: { args: [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 } })
    const advapi32 = dlopen('advapi32.dll', { RegGetValueW: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 } })
    windowsCalls = {
      systemParametersInfo: (action, size, data, flags) => user32.symbols.SystemParametersInfoW(action, size, data, flags),
      regGetValue: (key, subkey, value, flags, type, data, size) => advapi32.symbols.RegGetValueW(key, subkey, value, flags, type, data, size),
    }
  } catch { windowsCalls = null }
  return windowsCalls
}
const wide = (text: string) => new Uint8Array(Buffer.from(`${text}\0`, 'utf16le'))
// HKEY_CURRENT_USER is `(HKEY)(LONG)0x80000001`, sign-extended to a 64-bit handle.
const HKEY_CURRENT_USER = 0xFFFFFFFF80000001n
const PERSONALIZE = wide('Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize')
const ENABLE_TRANSPARENCY = wide('EnableTransparency')
const RRF_RT_REG_DWORD = 0x10
const SPI_GETHIGHCONTRAST = 0x42
const HCF_HIGHCONTRASTON = 1

function readWindows(): OsDisplay | null {
  const calls = windows()
  if (!calls) return null
  try {
    // HIGHCONTRASTW: cbSize, dwFlags, then the scheme name pointer (16 bytes on x64).
    const contrast = new Uint32Array(4)
    contrast[0] = contrast.byteLength
    const increaseContrast = calls.systemParametersInfo(SPI_GETHIGHCONTRAST, contrast.byteLength, contrast, 0) !== 0 && (contrast[1]! & HCF_HIGHCONTRASTON) !== 0
    const data = new Uint32Array(1), size = new Uint32Array([4])
    // A missing value means the default: transparency effects on.
    const found = calls.regGetValue(HKEY_CURRENT_USER, PERSONALIZE, ENABLE_TRANSPARENCY, RRF_RT_REG_DWORD, null, data, size) === 0
    return { reduceTransparency: found && data[0] === 0, increaseContrast }
  } catch { return null }
}

// ---- Linux ----

let linux: OsDisplay | null = null
let linuxStarted = false
let gnomeSeen = false
const changeListeners = new Set<() => void>()
/** Linux values arrive from child processes; `material.ts` re-reads on each. */
export const onOsDisplayChange = (listener: () => void) => { changeListeners.add(listener); return () => { changeListeners.delete(listener) } }

function setLinuxContrast(source: 'gnome' | 'portal', value: boolean) {
  // GNOME's own key is live, so it wins over the launch-time portal read.
  if (source === 'portal' && gnomeSeen) return
  if (source === 'gnome') gnomeSeen = true
  if (linux?.increaseContrast === value) return
  linux = { reduceTransparency: false, increaseContrast: value }
  for (const listener of changeListeners) listener()
}

function startLinux() {
  if (linuxStarted) return
  linuxStarted = true
  const run = (command: string, args: string[], onLine: (line: string) => void) => {
    try {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] })
      child.on('error', () => { /* Not installed: the option stays off. */ })
      let buffered = ''
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        buffered += chunk
        const lines = buffered.split('\n')
        buffered = lines.pop() ?? ''
        for (const line of lines) onLine(line)
      })
      child.stdout.on('end', () => { if (buffered) onLine(buffered) })
    } catch { /* The option stays off. */ }
  }
  const schema = 'org.gnome.desktop.a11y.interface'
  const gnome = (line: string) => { const value = parseGsettingsBool(line); if (value !== null) setLinuxContrast('gnome', value) }
  run('gsettings', ['get', schema, 'high-contrast'], gnome)
  watchGsettings(schema, ['high-contrast'], (_key, value) => gnome(value))
  run('gdbus', ['call', '--session', '--dest', 'org.freedesktop.portal.Desktop', '--object-path', '/org/freedesktop/portal/desktop',
    '--method', 'org.freedesktop.portal.Settings.ReadOne', 'org.freedesktop.appearance', 'contrast'], (line) => {
    const value = parsePortalContrast(line)
    if (value !== null) setLinuxContrast('portal', value)
  })
}

/** This OS's Reduce transparency / Increase contrast; null on macOS (NSWorkspace, `material.ts`) or when unreadable. */
export function readOsDisplay(platform: NodeJS.Platform = process.platform): OsDisplay | null {
  if (platform === 'win32') return readWindows()
  if (platform === 'linux') {
    startLinux()
    return linux
  }
  return null
}
