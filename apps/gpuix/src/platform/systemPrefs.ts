// Windows and Linux appearance and motion preferences read before the window exists (WP3), so the first frame is drawn
// in the right theme and motion. Once the window is up GPUI reports appearance live (`shell/windowChrome.ts`: the
// registry on Windows, the freedesktop portal's `color-scheme` on Linux) and Windows' "Animation effects" through the
// addon; GNOME's keys are followed with one `gsettings monitor` per schema (`watchGsettings`), shared with
// `osDisplay.ts`. No app imports: `ui.tsx` and `reducedMotion.ts` read these while modules initialise. macOS keeps its
// own reads.
//
// Launch cost: Windows reads the registry through bun:ffi (no process); Linux runs one `gsettings list-recursively` for
// GNOME's interface keys (theme and animations), remembered for the session. The title-bar double click is read
// without blocking, when the window is up.
import { dlopen, FFIType } from 'bun:ffi'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'

type Run = (command: string, args: string[]) => string | null

const run: Run = (command, args) => {
  try {
    const r = spawnSync(command, args, { encoding: 'utf8', timeout: 1500, windowsHide: true })
    return r.status === 0 ? r.stdout : null
  } catch {
    return null
  }
}

// ---- Windows ----

/** A HKCU DWORD, or null when it is missing or unreadable. */
type ReadDword = (subkey: string, value: string) => number | null
let regGetValue: ((key: bigint, subkey: Uint8Array, value: Uint8Array, flags: number, type: null, data: Uint32Array, size: Uint32Array) => number) | null | undefined
const wide = (text: string) => new Uint8Array(Buffer.from(`${text}\0`, 'utf16le'))
// HKEY_CURRENT_USER is `(HKEY)(LONG)0x80000001`, sign-extended to a 64-bit handle.
const HKEY_CURRENT_USER = 0xFFFFFFFF80000001n
const RRF_RT_REG_DWORD = 0x10
const readRegDword: ReadDword = (subkey, value) => {
  if (regGetValue === undefined) {
    try {
      const advapi32 = dlopen('advapi32.dll', { RegGetValueW: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 } })
      regGetValue = (key, sub, name, flags, type, data, size) => advapi32.symbols.RegGetValueW(key, sub, name, flags, type, data, size)
    } catch { regGetValue = null }
  }
  if (!regGetValue) return null
  try {
    const data = new Uint32Array(1), size = new Uint32Array([4])
    return regGetValue(HKEY_CURRENT_USER, wide(subkey), wide(value), RRF_RT_REG_DWORD, null, data, size) === 0 ? data[0]! : null
  } catch { return null }
}

// ---- Linux ----

/** `gsettings list-recursively <schema>` lines (`org.gnome.desktop.interface color-scheme 'prefer-dark'`) by key. */
export function parseGsettingsList(out: string | null, schema: string): Map<string, string> {
  const keys = new Map<string, string>()
  for (const line of out?.split('\n') ?? []) {
    const [owner, key, ...value] = line.trim().split(' ')
    if (owner === schema && key && value.length) keys.set(key, value.join(' '))
  }
  return keys
}

const INTERFACE = 'org.gnome.desktop.interface'
let gnomeInterface: Map<string, string> | undefined
/** GNOME's interface keys, read once (one process for the theme and animations); `exec` other than the default is not remembered. */
function interfaceKeys(exec: Run): Map<string, string> {
  if (exec !== run) return parseGsettingsList(exec('gsettings', ['list-recursively', INTERFACE]), INTERFACE)
  return gnomeInterface ??= parseGsettingsList(run('gsettings', ['list-recursively', INTERFACE]), INTERFACE)
}

/**
 * Windows: `AppsUseLightTheme` 0 is dark. Linux: GNOME's `color-scheme` (`prefer-dark`), else the GTK theme's name.
 * GPUI follows only the portal's `color-scheme` once the window is up, so `shell/windowChrome.ts` does not let its
 * first report override this read.
 */
export function readSystemVariant(platform: NodeJS.Platform = process.platform, exec: Run = run, dword: ReadDword = readRegDword): 'dark' | 'light' | null {
  if (platform === 'win32') {
    const value = dword('Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', 'AppsUseLightTheme')
    return value === null ? null : value === 0 ? 'dark' : 'light'
  }
  if (platform === 'linux') {
    const keys = interfaceKeys(exec)
    const scheme = keys.get('color-scheme')
    if (scheme?.includes('prefer-dark')) return 'dark'
    if (scheme?.includes('prefer-light')) return 'light'
    const theme = keys.get('gtk-theme')
    if (theme) return /dark/i.test(theme) ? 'dark' : 'light'
  }
  return null
}

/** Linux: GNOME's `enable-animations` false means reduced motion. Null when it cannot be read (Windows asks the addon). */
export function readLinuxReducedMotion(exec: Run = run): boolean | null {
  const out = interfaceKeys(exec).get('enable-animations')
  return out === 'false' ? true : out === 'true' ? false : null
}

/** A GNOME `action-double-click-titlebar` value (`'toggle-maximize'`), in the addon's names. */
export function parseTitlebarDoubleClick(value: string | null | undefined): 'maximize' | 'minimize' | 'menu' | 'none' {
  switch (value?.trim().replace(/'/g, '')) {
    case 'minimize': return 'minimize'
    case 'menu': return 'menu'
    case 'none': case 'lower': return 'none'
    default: return 'maximize'
  }
}

/** What a double click on the title bar does on GNOME, read without blocking; `onValue` is not called when it cannot be read. */
export function readTitlebarDoubleClick(onValue: (action: ReturnType<typeof parseTitlebarDoubleClick>) => void) {
  try {
    const child = spawn('gsettings', ['get', 'org.gnome.desktop.wm.preferences', 'action-double-click-titlebar'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.on('error', () => {})
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { out += chunk })
    child.on('close', (code) => { if (code === 0) onValue(parseTitlebarDoubleClick(out)) })
  } catch { /* Keep the default. */ }
}

// ---- gsettings monitor ----

type KeyListener = (key: string, value: string) => void
const monitors = new Map<string, { child: ChildProcess | null; listeners: Set<KeyListener> }>()
let cleanupInstalled = false

/** A `gsettings monitor` line: `enable-animations: false` → key and value. */
export function parseMonitorLine(line: string): { key: string; value: string } | null {
  const colon = line.indexOf(':')
  if (colon <= 0) return null
  const key = line.slice(0, colon).trim(), value = line.slice(colon + 1).trim()
  return key && value ? { key, value } : null
}

function stopMonitors() {
  for (const monitor of monitors.values()) { try { monitor.child?.kill() } catch { /* Gone. */ } monitor.child = null }
}

function installCleanup() {
  if (cleanupInstalled) return
  cleanupInstalled = true
  // The monitors are unref'd, so they never hold the app open, but they outlive it unless killed: a monitor only notices
  // its closed pipe at the next change it prints.
  process.on('exit', stopMonitors)
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      stopMonitors()
      // With no other handler, keep the signal's default: end the process.
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal)
    })
  }
}

/**
 * Follow `keys` of a GNOME schema while the app runs: one `gsettings monitor <schema>` per schema, whoever asks, its
 * output split by line. Returns a stop function; the child ends with its last listener, and on exit, SIGTERM or SIGINT.
 * A missing `gsettings` just never calls back.
 */
export function watchGsettings(schema: string, keys: readonly string[], onChange: (key: string, value: string) => void): () => void {
  let monitor = monitors.get(schema)
  if (!monitor) {
    monitor = { child: null, listeners: new Set() }
    monitors.set(schema, monitor)
    try {
      const child = spawn('gsettings', ['monitor', schema], { stdio: ['ignore', 'pipe', 'ignore'] })
      monitor.child = child
      installCleanup()
      child.on('error', () => {})
      let buffered = ''
      const listeners = monitor.listeners
      const line = (text: string) => { const change = parseMonitorLine(text); if (change) for (const listener of [...listeners]) listener(change.key, change.value) }
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        buffered += chunk
        const lines = buffered.split('\n')
        buffered = lines.pop() ?? ''
        for (const text of lines) line(text)
      })
      child.stdout.on('end', () => { if (buffered) line(buffered) })
      child.unref()
      ;(child.stdout as { unref?: () => void }).unref?.()
    } catch { /* No gsettings: nothing to follow. */ }
  }
  const listener: KeyListener = (key, value) => { if (keys.includes(key)) onChange(key, value) }
  monitor.listeners.add(listener)
  const own = monitor
  return () => {
    own.listeners.delete(listener)
    if (own.listeners.size || monitors.get(schema) !== own) return
    monitors.delete(schema)
    try { own.child?.kill() } catch { /* Gone. */ }
  }
}

/** Tests only: the monitor children running now. */
export const monitorCount = () => [...monitors.values()].filter(m => m.child && m.child.exitCode === null && !m.child.killed).length
