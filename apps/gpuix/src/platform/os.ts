// Every call into the operating system that is not the window itself: open a URL or file, reveal a file in the file manager,
// the clipboard's text, the folder and save pickers, the app's config and cache folders, and window captures. One module, so
// a call site never names `open`, `pbcopy`, `osascript` or `~/Library`; the desktop's `lib/tauri.ts` plays the same role.
//
// macOS runs exactly the commands it always did. Windows and Linux use the addon's GPUI binding when it exposes one
// (`setOsHost`), else a system command. The table of what to add to the addon is in PORTING-PLATFORMS.md ("Native bindings
// wanted"). Everything that chooses a command or a folder is a pure function of an `OsContext`, so the tests simulate
// each platform by passing one instead of touching `process`.
import { execFile, spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export type OsName = 'macos' | 'windows' | 'linux'
export interface OsContext {
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
  home: string
}
/** The user's home folder: `USERPROFILE` on Windows (`HOME` is only set by Git Bash and the like), `HOME` elsewhere. */
export const homeFor = (platform: NodeJS.Platform, env: Record<string, string | undefined>) => (platform === 'win32' ? env.USERPROFILE : env.HOME) || homedir()
export const osContext = (): OsContext => ({ platform: process.platform, env: process.env, home: homeFor(process.platform, process.env) })
export const osName = (platform: NodeJS.Platform): OsName => platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : 'linux'
export const pathFor = (platform: NodeJS.Platform) => platform === 'win32' ? path.win32 : path.posix

// ---- copy that names the platform ----

export interface OsLabels {
  /** The local environment's name ("This Mac"). */
  thisComputer: string
  /** "on this Mac" in a sentence. */
  onThisComputer: string
  /** "this Mac" in the middle of a sentence (the proper noun keeps its capital). */
  thisComputerInline: string
  fileManager: string
  /** Menu item: select a file in the file manager. */
  reveal: string
  /** Menu item: open the folder in the file manager. */
  openFolder: string
  /** Button: pick something in the system's own picker. */
  choose: string
}
export function osLabels(platform: NodeJS.Platform = process.platform): OsLabels {
  switch (osName(platform)) {
    case 'macos': return { thisComputer: 'This Mac', onThisComputer: 'on this Mac', thisComputerInline: 'this Mac', fileManager: 'Finder', reveal: 'Reveal in Finder', openFolder: 'Open in Finder', choose: 'Choose in Finder…' }
    case 'windows': return { thisComputer: 'This computer', onThisComputer: 'on this computer', thisComputerInline: 'this computer', fileManager: 'Explorer', reveal: 'Show in Explorer', openFolder: 'Open in Explorer', choose: 'Choose in Explorer…' }
    case 'linux': return { thisComputer: 'This computer', onThisComputer: 'on this computer', thisComputerInline: 'this computer', fileManager: 'Files', reveal: 'Show in Files', openFolder: 'Open in Files', choose: 'Choose in Files…' }
  }
}

// ---- folders ----

/** An `XDG_*` folder variable counts only when it is an absolute path; the spec says to ignore a relative one. */
const absoluteDir = (value: string | undefined) => value && path.posix.isAbsolute(value) ? value : undefined

/** The folder an app keeps settings in: Application Support, `%APPDATA%`, `$XDG_CONFIG_HOME`. */
export function appConfigDir(app: string, ctx: OsContext = osContext()): string {
  const p = pathFor(ctx.platform)
  switch (osName(ctx.platform)) {
    case 'macos': return p.join(ctx.home, 'Library/Application Support', app)
    case 'windows': return p.join(ctx.env.APPDATA || p.join(ctx.home, 'AppData', 'Roaming'), app)
    case 'linux': return p.join(absoluteDir(ctx.env.XDG_CONFIG_HOME) || p.join(ctx.home, '.config'), app)
  }
}
/** The folder an app keeps disposable files in: Caches, `%LOCALAPPDATA%`, `$XDG_CACHE_HOME`. */
export function appCacheDir(app: string, ctx: OsContext = osContext()): string {
  const p = pathFor(ctx.platform)
  switch (osName(ctx.platform)) {
    case 'macos': return p.join(ctx.home, 'Library/Caches', app)
    case 'windows': return p.join(ctx.env.LOCALAPPDATA || p.join(ctx.home, 'AppData', 'Local'), app)
    case 'linux': return p.join(absoluteDir(ctx.env.XDG_CACHE_HOME) || p.join(ctx.home, '.cache'), app)
  }
}
/**
 * Per-machine files that must not roam: the credential fallback and the memory log. `%LOCALAPPDATA%` on Windows (`%APPDATA%`
 * roams with the user's profile across machines and into backups), the config folder elsewhere.
 */
export const appLocalDataDir = (app: string, ctx: OsContext = osContext()) => osName(ctx.platform) === 'windows' ? appCacheDir(app, ctx) : appConfigDir(app, ctx)
export const gpuixLocalDir = (ctx: OsContext = osContext()) => ctx.env.KYBERN_CLIENT_CONFIG_DIR ?? appLocalDataDir('kybern-gpuix', ctx)
/** GPUIX's own settings (`app.json`, appearance, workspace preferences). `KYBERN_CLIENT_CONFIG_DIR` moves it for tests. */
export const gpuixConfigDir = (ctx: OsContext = osContext()) => ctx.env.KYBERN_CLIENT_CONFIG_DIR ?? appConfigDir('kybern-gpuix', ctx)
/**
 * The folder shared with the Tauri client (`environments.json`; its bundle id is the folder name on every platform, as
 * Tauri's `app_config_dir` does).
 */
export const desktopConfigDir = (ctx: OsContext = osContext()) => ctx.env.KYBERN_CLIENT_CONFIG_DIR ?? appConfigDir('dev.kybern.desktop', ctx)
/** GPUIX's cache. A scratch config folder keeps its caches inside as `<config>/<scratch>`, so a test never reaches the real one. */
export function gpuixCacheDir(scratch: string, sub: string | null = null, ctx: OsContext = osContext()): string {
  const p = pathFor(ctx.platform)
  const config = ctx.env.KYBERN_CLIENT_CONFIG_DIR
  if (config) return p.join(config, scratch)
  const base = appCacheDir('kybern-gpuix', ctx)
  return sub ? p.join(base, sub) : base
}
/** `XDG_DOWNLOAD_DIR` from `user-dirs.dirs` (what `xdg-user-dir DOWNLOAD` reads): `XDG_DOWNLOAD_DIR="$HOME/Téléchargements"`. */
export function userDirsDownload(contents: string, home: string): string | null {
  const match = /^\s*XDG_DOWNLOAD_DIR\s*=\s*"([^"\n]*)"/m.exec(contents)
  const dir = match?.[1]?.replace(/^\$\{?HOME\}?(?=\/|$)/, home).replace(/\\(.)/g, '$1')
  return dir && path.posix.isAbsolute(dir) ? dir : null
}
/**
 * Where a save panel starts. Linux asks the session first (`XDG_DOWNLOAD_DIR`, then `~/.config/user-dirs.dirs`, which holds
 * a translated name such as `Téléchargements`); everything else, and a session that says nothing, gets `~/Downloads`.
 */
export function downloadsDir(ctx: OsContext = osContext()): string {
  const p = pathFor(ctx.platform)
  if (osName(ctx.platform) === 'linux') {
    const fromEnv = absoluteDir(ctx.env.XDG_DOWNLOAD_DIR)
    if (fromEnv) return fromEnv
    try {
      const configured = userDirsDownload(readFileSync(p.join(absoluteDir(ctx.env.XDG_CONFIG_HOME) || p.join(ctx.home, '.config'), 'user-dirs.dirs'), 'utf8'), ctx.home)
      if (configured) return configured
    } catch { /* No user-dirs.dirs: the English default below. */ }
  }
  return p.join(ctx.home, 'Downloads')
}

// ---- PATH and executable names ----

export const pathDelimiter = (platform: NodeJS.Platform) => platform === 'win32' ? ';' : ':'
export const executableName = (name: string, platform: NodeJS.Platform) => platform === 'win32' && !name.toLowerCase().endsWith('.exe') ? `${name}.exe` : name
/** The installer's `bin` folder (`installer.nsi`: `$LOCALAPPDATA\\Programs\\Kybern GPUIX`, with `kybern.exe` in `bin` and only `bin` on PATH). */
export const WINDOWS_APP_BIN = (local: string, p: typeof path.win32) => p.join(local, 'Programs', 'Kybern GPUIX', 'bin')
export interface PathPlan {
  /** Used when the shell cannot be asked, and appended to what it answers. */
  fallback: string[]
  /** `$SHELL -ilc …` to print the login PATH; null where the environment is already right (Windows). */
  shell: { command: string; args: string[] } | null
}
/** The variable `Path` or `PATH` of a Windows environment (the process may hold either spelling, rarely both). */
export const inheritedPath = (env: Record<string, string | undefined>) => env.PATH ?? env.Path ?? Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? ''
/** `env` with its PATH set to `value`. On Windows every spelling (`Path`, `PATH`, `pAtH`) is removed first, or a child sees two. */
export function withPath(env: Record<string, string | undefined>, value: string, platform: NodeJS.Platform = process.platform): Record<string, string | undefined> {
  const next = { ...env }
  if (platform === 'win32') for (const key of Object.keys(next)) if (key.toUpperCase() === 'PATH') delete next[key]
  next[platform === 'win32' ? 'Path' : 'PATH'] = value
  return next
}
/**
 * The PATH a launched tool should see. macOS and Linux apps start with a thin PATH (Dock, desktop entry), so the login
 * shell is asked. Windows apps inherit the user's PATH from Explorer, so nothing is asked. The shell is POSIX-shaped
 * (`-ilc`, `printf`); a login shell that is not (fish and nushell take other syntax, or none) just fails the one call and the
 * fallback list stands in, which is also what a missing `$SHELL` gets.
 */
export function pathPlan(ctx: OsContext = osContext()): PathPlan {
  const p = pathFor(ctx.platform)
  const home = ctx.home
  const inherited = inheritedPath(ctx.env).split(pathDelimiter(ctx.platform)).filter(Boolean)
  if (osName(ctx.platform) === 'windows') {
    const local = ctx.env.LOCALAPPDATA || p.join(home, 'AppData', 'Local')
    return { fallback: [...inherited, p.join(home, '.cargo', 'bin'), p.join(home, '.bun', 'bin'), WINDOWS_APP_BIN(local, p)], shell: null }
  }
  const brew = osName(ctx.platform) === 'macos' ? ['/opt/homebrew/bin'] : ['/home/linuxbrew/.linuxbrew/bin', '/snap/bin']
  const fallback = [p.join(home, '.local/bin'), p.join(home, '.cargo/bin'), p.join(home, '.bun/bin'), ...brew, '/usr/local/bin', ...inherited]
  const shell = ctx.env.SHELL
  return { fallback, shell: shell ? { command: shell, args: ['-ilc', 'printf \'%s\' "$PATH"'] } : null }
}

let loginPath: Promise<string[]> | undefined
/**
 * The folders a new terminal searches: the login shell's PATH on macOS and Linux (asked once, without blocking), the
 * inherited PATH on Windows or when the shell cannot be asked. A desktop-launched app has a thin PATH, so a tool a shell
 * profile adds (`~/.local/bin`, snap, a version manager) is only found through this.
 */
export function loginShellPath(ctx: OsContext = osContext()): Promise<string[]> {
  return loginPath ??= new Promise((resolve) => {
    const delimiter = pathDelimiter(ctx.platform), plan = pathPlan(ctx)
    const fallback = () => inheritedPath(ctx.env).split(delimiter).filter(Boolean)
    if (!plan.shell || !existsSync(plan.shell.command)) return resolve(fallback())
    execFile(plan.shell.command, plan.shell.args, { timeout: 5000, maxBuffer: 128 * 1024, windowsHide: true }, (error, stdout) => {
      const text = String(stdout ?? '').trim()
      resolve(!error && text ? text.split(delimiter).filter(Boolean) : fallback())
    })
  })
}

// ---- commands ----

export interface Cmd {
  command: string
  args: string[]
  /** Added to the child's environment. A script reads caller-controlled text from here, never from its own source. */
  env?: Record<string, string>
  /** Windows: hand `args` to the program unquoted (Explorer's `/select,"path"` carries its own quotes). */
  verbatim?: boolean
}
/**
 * Run a PowerShell script without quoting trouble (`-EncodedCommand` is the script as base64 UTF-16LE). The script is fixed
 * text: anything that comes from a file name, a title or an agent goes in `env` and is read as `$env:KYBERN_…`, because no
 * quoting rule survives every character PowerShell treats as a quote (the typographic ‘ ’ ‚ ‛ end a single-quoted string too).
 */
export function powershell(script: string, options: { sta?: boolean; env?: Record<string, string> } = {}): Cmd {
  return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', ...(options.sta ? ['-STA'] : []), '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], ...(options.env ? { env: options.env } : {}) }
}
const UTF8_IO = '[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);'
/** An environment value a child can hold: no NUL, which ends a Windows or POSIX environment string. */
const envValue = (value: string) => value.replaceAll('\0', '')
const isWayland = (ctx: OsContext) => !!ctx.env.WAYLAND_DISPLAY
/** Whether a Linux session has a display for a dialog to open on. */
const hasDisplay = (ctx: OsContext) => !!(ctx.env.DISPLAY || ctx.env.WAYLAND_DISPLAY)

// ---- opening files on Windows ----

/** A target the Windows launcher must not touch. The message says what to do instead. */
export class UnsafeTargetError extends Error {
  constructor(message: string) { super(message); this.name = 'UnsafeTargetError' }
}
/** Files Windows runs, installs or loads when "opened" instead of showing them (PATHEXT, plus the shell's own script and link types). */
const RUNNABLE_EXTENSIONS = ['.com', '.exe', '.bat', '.cmd', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.msc', '.cpl', '.lnk', '.url', '.hta', '.scr', '.msi', '.msp', '.ps1', '.psm1', '.psc1', '.reg', '.scf', '.appref-ms', '.application', '.gadget', '.pif', '.jar', '.inf', '.library-ms', '.settingcontent-ms', '.diagcab', '.dll']
export function runnableExtensions(env: Record<string, string | undefined>): Set<string> {
  const pathext = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATHEXT')?.[1] ?? ''
  return new Set([...RUNNABLE_EXTENSIONS, ...pathext.split(';').map(ext => ext.trim().toLowerCase()).filter(Boolean)])
}
/** The web, mail, phone and editor links Windows hands to the registered app. Anything else (`file:`, `ms-msdt:`, `search-ms:`) is refused. */
const WINDOWS_LINK = /^(https?|mailto|tel|vscode|cursor|windsurf):/i
export type WindowsTarget = { kind: 'link'; target: string } | { kind: 'open'; file: string } | { kind: 'reveal'; file: string }
/**
 * Decide what opening `target` on Windows means. A link goes to its handler; a path on a local drive opens with its default
 * app, except programs, scripts and shortcuts, which are shown in Explorer instead of run. Network paths (`\\host\share`,
 * which send the user's NTLM hash to `host`) and `\\?\` / `\\.\` device paths are refused.
 */
export function windowsTarget(target: string, ctx: OsContext = osContext()): WindowsTarget {
  // A scheme has two or more characters; `C:` is a drive.
  if (/^[a-z][a-z0-9+.-]+:/i.test(target)) {
    if (WINDOWS_LINK.test(target)) return { kind: 'link', target }
    throw new UnsafeTargetError('Kybern opens web, email, phone and editor links only. Open this one from the program that owns it.')
  }
  const file = target.replaceAll('/', '\\')
  if (file.startsWith('\\\\')) throw new UnsafeTargetError('Kybern doesn’t open network or device paths. Copy the file to this computer, then open it.')
  if (!/^[a-z]:\\/i.test(file)) throw new UnsafeTargetError('Open files by their full path, such as C:\\Users\\you\\notes.md.')
  if (file.slice(2).includes(':') || /["<>|*?\u0000-\u001f]/.test(file)) throw new UnsafeTargetError('This path has characters Windows doesn’t allow in file names. Rename the file, then try again.')
  // Windows ignores trailing dots and spaces, so `payload.exe.` is `payload.exe`.
  const name = path.win32.basename(file.replace(/[. ]+$/, ''))
  return runnableExtensions(ctx.env).has(path.win32.extname(name).toLowerCase()) ? { kind: 'reveal', file } : { kind: 'open', file }
}

/** What opens a web address, a file or a folder with its default app, in the order to try. */
export function openCommands(target: string, ctx: OsContext = osContext()): Cmd[] {
  switch (osName(ctx.platform)) {
    case 'macos': return [{ command: 'open', args: [target] }]
    case 'windows': {
      const plan = windowsTarget(target, ctx)
      // `url.dll` takes a link and never goes through cmd.exe, so `&` in a link cannot start another command. Files go to
      // Explorer, which opens them with their default app without parsing the name as a link.
      if (plan.kind === 'link') return [{ command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', plan.target] }]
      if (plan.kind === 'reveal') return revealCommands(plan.file, ctx)
      return [{ command: 'explorer.exe', args: [plan.file] }]
    }
    case 'linux': return [{ command: 'xdg-open', args: [target] }, { command: 'gio', args: ['open', target] }]
  }
}
/** Several files at once (the files an agent changed outside the project): macOS opens them in one call. */
export function openManyCommands(targets: string[], ctx: OsContext = osContext()): Cmd[][] {
  return osName(ctx.platform) === 'macos' ? [[{ command: 'open', args: targets }]] : targets.map(target => openCommands(target, ctx))
}
/** What selects a file in the file manager. Explorer exits 1 even when it worked (`ignoreExit` at the call). */
export function revealCommands(file: string, ctx: OsContext = osContext()): Cmd[] {
  switch (osName(ctx.platform)) {
    case 'macos': return [{ command: 'open', args: ['-R', file] }]
    case 'windows': {
      const plan = windowsTarget(file, ctx)
      if (plan.kind === 'link') throw new UnsafeTargetError('Showing a file needs a path on this computer.')
      // `/select,` ends at the first comma unless the path is quoted; a Windows path never holds a quote of its own.
      return [{ command: 'explorer.exe', args: [`/select,"${plan.file}"`], verbatim: true }]
    }
    case 'linux': {
      const dir = path.posix.dirname(file)
      // FileManager1 selects the item in Nautilus, Dolphin, Nemo, Thunar and others; a desktop without it just opens the folder.
      return [
        { command: 'dbus-send', args: ['--session', '--print-reply', '--dest=org.freedesktop.FileManager1', '--type=method_call', '/org/freedesktop/FileManager1', 'org.freedesktop.FileManager1.ShowItems', `array:string:${fileUri(file)}`, 'string:'] },
        { command: 'xdg-open', args: [dir] },
        { command: 'gio', args: ['open', dir] },
      ]
    }
  }
}
/** `file:///…` with every byte outside the unreserved set escaped, as D-Bus clients expect. */
export const fileUri = (file: string) => `file://${file.split('/').map(encodeURIComponent).join('/')}`

export function clipboardWriteCommands(ctx: OsContext = osContext()): Cmd[] {
  switch (osName(ctx.platform)) {
    case 'macos': return [{ command: 'pbcopy', args: [] }]
    case 'windows': return [powershell(`${UTF8_IO}$t=[Console]::In.ReadToEnd();if($t.Length -eq 0){Set-Clipboard -Value $null}else{Set-Clipboard -Value $t}`)]
    case 'linux': {
      const wl = { command: 'wl-copy', args: [] as string[] }
      const xclip = { command: 'xclip', args: ['-selection', 'clipboard', '-in'] }
      const xsel = { command: 'xsel', args: ['--clipboard', '--input'] }
      return isWayland(ctx) ? [wl, xclip, xsel] : [xclip, xsel, wl]
    }
  }
}
export function clipboardReadCommands(ctx: OsContext = osContext()): Cmd[] {
  switch (osName(ctx.platform)) {
    case 'macos': return [{ command: 'pbpaste', args: [] }]
    case 'windows': return [powershell(`${UTF8_IO}$t=Get-Clipboard -Raw;if($null -ne $t){[Console]::Out.Write($t)}`)]
    case 'linux': {
      const wl = { command: 'wl-paste', args: ['--no-newline'] }
      const xclip = { command: 'xclip', args: ['-selection', 'clipboard', '-out'] }
      const xsel = { command: 'xsel', args: ['--clipboard', '--output'] }
      return isWayland(ctx) ? [wl, xclip, xsel] : [xclip, xsel, wl]
    }
  }
}
/** The tools to name when no clipboard command runs. */
export const clipboardTools = (ctx: OsContext = osContext()) => osName(ctx.platform) === 'linux' ? (isWayland(ctx) ? 'wl-clipboard (wl-copy, wl-paste)' : 'xclip or xsel') : 'the system clipboard'

/** The folder picker, when the addon's `promptForPaths` is absent. macOS keeps its osascript dialog. */
export function folderPickerCommands(ctx: OsContext = osContext()): Cmd[] {
  switch (osName(ctx.platform)) {
    case 'macos': return [{ command: 'osascript', args: ['-e', 'POSIX path of (choose folder with prompt "Choose a folder")'] }]
    case 'windows': return [powershell(`${UTF8_IO}Add-Type -AssemblyName System.Windows.Forms;$d=New-Object System.Windows.Forms.FolderBrowserDialog;$d.Description='Choose a folder';if($d.ShowDialog() -eq 'OK'){[Console]::Out.Write($d.SelectedPath)}`, { sta: true })]
    case 'linux': return [{ command: 'zenity', args: ['--file-selection', '--directory', '--title=Choose a folder'] }, { command: 'kdialog', args: ['--getexistingdirectory', ctx.home, '--title', 'Choose a folder'] }]
  }
}
/** The save panel, when the addon's `promptForNewPath` is absent (it exists on every platform in the patched build). */
export function savePanelCommands(directory: string, suggestedName: string | null | undefined, ctx: OsContext = osContext()): Cmd[] {
  const start = pathFor(ctx.platform).join(directory, suggestedName ?? '')
  switch (osName(ctx.platform)) {
    case 'macos': return []
    // The folder and the suggested name come from agent-written titles: they reach the script as environment values only.
    case 'windows': return [powershell(`${UTF8_IO}Add-Type -AssemblyName System.Windows.Forms;$d=New-Object System.Windows.Forms.SaveFileDialog;$d.InitialDirectory=$env:KYBERN_SAVE_DIR;$d.FileName=$env:KYBERN_SAVE_NAME;if($d.ShowDialog() -eq 'OK'){[Console]::Out.Write($d.FileName)}`, { sta: true, env: { KYBERN_SAVE_DIR: envValue(directory), KYBERN_SAVE_NAME: envValue(suggestedName ?? '') } })]
    case 'linux': return [{ command: 'zenity', args: ['--file-selection', '--save', '--confirm-overwrite', `--filename=${start}`] }, { command: 'kdialog', args: ['--getsavefilename', start] }]
  }
}
/** The system's window capture by id (`screencapture -l`). Off macOS the addon's `captureScreenshot` takes over. */
export function windowCaptureCommand(windowId: string | number, file: string, ctx: OsContext = osContext()): Cmd | null {
  return osName(ctx.platform) === 'macos' ? { command: 'screencapture', args: ['-l', String(windowId), '-x', '-o', file] } : null
}

// ---- running them ----

/** A tool this platform needs is not installed. The message says which, in a sentence the user can act on. */
export class MissingToolError extends Error {
  constructor(message: string) { super(message); this.name = 'MissingToolError' }
}
interface RunOptions {
  input?: string
  timeout?: number
  /** Count any exit as success (Explorer's `/select,`), once the program started. */
  ignoreExit?: boolean
  /** Exit codes that mean "the user said no" (a closed dialog): returned as an empty result instead of trying the next tool. */
  stopOnExit?: number[]
  /** Send stdout and stderr to the null device and settle when the program exits, not when its pipes close. */
  discardOutput?: boolean
  /** What to tell the user when no candidate exists. */
  missing: string
}
interface RunResult { status: number | null; stdout: string; stderr: string }
const failed = (command: string, result: RunResult) => new Error(`${command} exited with ${result.status}${result.stderr.trim() ? `: ${result.stderr.trim().slice(0, 200)}` : ''}`)
const childEnv = (cmd: Cmd) => cmd.env ? { ...process.env, ...cmd.env } : undefined

function spawnCmd(cmd: Cmd, options: RunOptions): Promise<RunResult | 'missing'> {
  return new Promise(resolve => {
    let child
    const out = options.discardOutput ? 'ignore' : 'pipe'
    try { child = spawn(cmd.command, cmd.args, { stdio: [options.input === undefined ? 'ignore' : 'pipe', out, out], windowsHide: true, windowsVerbatimArguments: cmd.verbatim, env: childEnv(cmd) }) } catch { return resolve('missing') }
    let stdout = '', stderr = '', done = false
    const finish = (value: RunResult | 'missing') => { if (done) return; done = true; clearTimeout(timer); resolve(value) }
    const timer = options.timeout ? setTimeout(() => { child.kill(); finish({ status: null, stdout, stderr: `${stderr}timed out` }) }, options.timeout) : undefined
    child.stdout?.on('data', chunk => { stdout += chunk })
    child.stderr?.on('data', chunk => { stderr += chunk })
    child.on('error', error => finish((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : { status: null, stdout, stderr: String(error.message) }))
    // `xclip -in` and `wl-copy` fork a background owner of the selection that keeps inherited pipes open for as long as the
    // clipboard holds the text, so a discarding run settles on the program's own exit; a capturing run waits for its output.
    child.on(options.discardOutput ? 'exit' : 'close', status => finish({ status, stdout, stderr }))
    if (options.input !== undefined) { child.stdin!.on('error', () => {}); child.stdin!.end(options.input) }
  })
}
/** Try each candidate until one is installed and succeeds. Rejects with a MissingToolError only when none is installed. */
export async function runFirst(cmds: Cmd[], options: RunOptions): Promise<RunResult> {
  let last: Error | null = null
  for (const cmd of cmds) {
    const result = await spawnCmd(cmd, options)
    if (result === 'missing') continue
    if (result.status === 0 || options.ignoreExit) return result
    if (result.status !== null && options.stopOnExit?.includes(result.status)) return { ...result, stdout: '' }
    last = failed(cmd.command, result)
  }
  if (last) throw last
  throw new MissingToolError(options.missing)
}
/** `runFirst` for callers that cannot wait (macOS's copy shortcut: `pbcopy` is instant there). */
export function runFirstSync(cmds: Cmd[], options: RunOptions): RunResult {
  let last: Error | null = null
  for (const cmd of cmds) {
    // With `discardOutput` there are no pipes to wait on, so a tool that leaves a background child behind still returns at once.
    const out = options.discardOutput ? 'ignore' : 'pipe'
    const r = spawnSync(cmd.command, cmd.args, { input: options.input, encoding: 'utf8', timeout: options.timeout ?? 5000, stdio: [options.input === undefined ? 'ignore' : 'pipe', out, out], windowsHide: true, windowsVerbatimArguments: cmd.verbatim, env: childEnv(cmd) })
    if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') continue
    const result = { status: r.status, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') }
    if (r.error) { last = r.error; continue }
    if (result.status === 0 || options.ignoreExit) return result
    last = failed(cmd.command, result)
  }
  if (last) throw last
  throw new MissingToolError(options.missing)
}

// ---- launching: a file manager or the default app may outlive the call ----

/** How long a launched program may run before the call counts as succeeded (it opened a window and stays open). */
const LAUNCH_SETTLE_MS = 1000
type Launch = 'missing' | 'running' | RunResult
function launchCmd(cmd: Cmd, settleMs: number): Promise<Launch> {
  return new Promise(resolve => {
    let child
    try { child = spawn(cmd.command, cmd.args, { stdio: 'ignore', detached: true, windowsHide: true, windowsVerbatimArguments: cmd.verbatim, env: childEnv(cmd) }) } catch { return resolve('missing') }
    let done = false
    const finish = (value: Launch) => { if (done) return; done = true; clearTimeout(timer); resolve(value) }
    // Still running after the settle time: it started, and whatever it shows is its own to finish (never kill it).
    const timer = setTimeout(() => finish('running'), settleMs)
    child.on('spawn', () => child.unref())
    child.on('error', error => finish((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : { status: null, stdout: '', stderr: String(error.message) }))
    child.on('exit', status => finish({ status, stdout: '', stderr: '' }))
  })
}
/**
 * Start each candidate in turn for something that opens a window (xdg-open, a file manager, Explorer). Detached, no output
 * captured: a slow foreground app does not turn into a timeout, and the next candidate runs only when this one is missing or
 * exited non-zero straight away, so one target never opens twice.
 */
export async function launchFirst(cmds: Cmd[], options: { missing: string; ignoreExit?: boolean; settleMs?: number }): Promise<void> {
  let last: Error | null = null
  for (const cmd of cmds) {
    const result = await launchCmd(cmd, options.settleMs ?? LAUNCH_SETTLE_MS)
    if (result === 'missing') continue
    if (result === 'running' || result.status === 0 || options.ignoreExit) return
    last = failed(cmd.command, result)
  }
  if (last) throw last
  throw new MissingToolError(options.missing)
}

// ---- the addon ----

/**
 * What the GPUIX addon may expose. macOS never uses these (it keeps its commands); Windows and Linux take them over the
 * commands when present. The ones still missing are listed in PORTING-PLATFORMS.md.
 */
export interface OsHost {
  /** GPUI `cx.open_url`. */
  openUrl?: (url: string) => void
  /** GPUI `cx.open_with_system(path)`. */
  openPath?: (path: string) => void
  /** GPUI `cx.reveal_path(path)`. */
  revealPath?: (path: string) => void
  /** GPUI `cx.read_from_clipboard()` text. */
  readClipboardText?: () => string | null
  /** GPUI `cx.write_to_clipboard(ClipboardItem::new_string)`. */
  writeClipboardText?: (text: string) => void
  /** GPUI `cx.prompt_for_paths` (shipped by GPUIX). */
  promptForPaths?: (options?: { files?: boolean; directories?: boolean; multiple?: boolean; prompt?: string }) => Promise<string[] | null>
  /** GPUI `cx.prompt_for_new_path` (Kybern's patch). */
  promptForNewPath?: (directory: string, suggestedName?: string | null) => Promise<string[] | null>
  /** GPUI window render to PNG (shipped by GPUIX). */
  captureScreenshot?: (path: string) => void
}
let host: OsHost | null = null
/** Register the renderer once at startup. */
export function setOsHost(renderer: object | null) { host = renderer as OsHost | null }
const native = (ctx: OsContext): OsHost | null => osName(ctx.platform) === 'macos' ? null : host

// ---- the services ----

const openMissing = (ctx: OsContext) => osName(ctx.platform) === 'linux' ? 'Opening links needs xdg-open (xdg-utils). Install it, then try again.' : 'Unable to open this. Check your default apps, then try again.'
/** macOS keeps its captured `open` call; the other platforms launch and let the program outlive the call. */
const launches = (ctx: OsContext) => osName(ctx.platform) !== 'macos'
const isLink = (target: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(target) || /^(mailto|tel):/i.test(target)

/**
 * Test seam for the on-screen checks (`native/check-harness.ts`): with `KYBERN_OPEN_LOG` set, "open" appends the targets to
 * that file instead of starting an app, so a check can assert what Kybern asked the system to open on any OS. macOS checks
 * still stub `open` on PATH; Windows has no stubbable opener and Linux hands links to the addon first.
 */
function recordOpen(targets: string[], ctx: OsContext): boolean {
  const log = ctx.env.KYBERN_OPEN_LOG
  if (!log) return false
  appendFileSync(log, targets.join(' ') + '\n')
  return true
}
/** Open a web address or a path with the default app. */
export async function openTarget(target: string, ctx: OsContext = osContext()): Promise<void> {
  if (recordOpen([target], ctx)) return
  const h = native(ctx)
  // The addon would hand a Windows path to ShellExecute as is, so the same refusals apply before it.
  const windows = osName(ctx.platform) === 'windows' ? windowsTarget(target, ctx) : null
  if (windows?.kind === 'reveal') return revealPath(windows.file, ctx)
  if (isLink(target)) { if (h?.openUrl) return void h.openUrl(target) }
  else if (h?.openPath) return void h.openPath(windows?.kind === 'open' ? windows.file : target)
  await runCommands(openCommands(target, ctx), ctx, { missing: openMissing(ctx) })
}
/** Open several files (macOS: one `open` call). */
export async function openTargets(targets: string[], ctx: OsContext = osContext()): Promise<void> {
  if (recordOpen(targets, ctx)) return
  if (osName(ctx.platform) === 'windows') { for (const target of targets) await openTarget(target, ctx); return }
  for (const group of openManyCommands(targets, ctx)) await runCommands(group, ctx, { missing: openMissing(ctx) })
}
/** Show a file selected in Finder, Explorer or the Linux file manager. */
export async function revealPath(file: string, ctx: OsContext = osContext()): Promise<void> {
  const commands = revealCommands(file, ctx)
  const h = native(ctx)
  if (h?.revealPath) return void h.revealPath(file)
  await runCommands(commands, ctx, { missing: osName(ctx.platform) === 'linux' ? 'Showing a file needs a file manager that supports FileManager1 or xdg-open. Install xdg-utils, then try again.' : 'Unable to show the file.' })
}
function runCommands(cmds: Cmd[], ctx: OsContext, options: { missing: string }) {
  // Explorer exits 1 even when it opened the file or selected it, so on Windows only "not started" is a failure.
  if (launches(ctx)) return launchFirst(cmds, { ...options, ignoreExit: osName(ctx.platform) === 'windows' })
  return runFirst(cmds, { ...options, timeout: 10000 }).then(() => {})
}

const clipboardMissing = (verb: string, ctx: OsContext) => `${verb} needs ${clipboardTools(ctx)}. Install it, then try again.`
/** Put text on the clipboard. */
export async function writeClipboardText(text: string, ctx: OsContext = osContext()): Promise<void> {
  const h = native(ctx)
  if (h?.writeClipboardText) return void h.writeClipboardText(text)
  await runFirst(clipboardWriteCommands(ctx), { input: text, missing: clipboardMissing('Copying', ctx), timeout: 5000, discardOutput: true })
}
/** `writeClipboardText` that finishes before it returns, for macOS's ⌘X (`pbcopy` is instant). Off macOS use the async one: a spawn can take a second. */
export function writeClipboardTextSync(text: string, ctx: OsContext = osContext()): void {
  const h = native(ctx)
  if (h?.writeClipboardText) return void h.writeClipboardText(text)
  runFirstSync(clipboardWriteCommands(ctx), { input: text, missing: clipboardMissing('Copying', ctx), discardOutput: true })
}
/** The clipboard's text for a paste; rejects with a sentence when the clipboard cannot be read. */
export async function readClipboardText(ctx: OsContext = osContext()): Promise<string> {
  const h = native(ctx)
  if (h?.readClipboardText) return h.readClipboardText() ?? ''
  return (await runFirst(clipboardReadCommands(ctx), { missing: clipboardMissing('Pasting', ctx), timeout: 5000 })).stdout
}

/** Linux dialogs need a desktop session; without one `zenity` exits 1 like a cancel, so say so up front. */
function requireDisplay(ctx: OsContext, what: string) {
  if (osName(ctx.platform) === 'linux' && !hasDisplay(ctx)) throw new MissingToolError(`${what} needs a desktop session, and this one has no display. Start Kybern from your desktop, or set DISPLAY or WAYLAND_DISPLAY, then try again.`)
}
/** Ask for an existing folder with the system picker; null when canceled. */
export async function pickFolderDialog(ctx: OsContext = osContext()): Promise<string | null> {
  const h = native(ctx)
  if (h?.promptForPaths) return (await h.promptForPaths({ directories: true, files: false, multiple: false, prompt: 'Choose' }))?.[0] ?? null
  requireDisplay(ctx, 'Choosing a folder')
  const missing = osName(ctx.platform) === 'linux' ? 'Choosing a folder needs zenity or kdialog. Install one, then try again.' : 'Unable to open the folder picker.'
  try {
    const out = (await runFirst(folderPickerCommands(ctx), { missing, stopOnExit: [1] })).stdout.trim()
    return (osName(ctx.platform) === 'macos' ? out.replace(/\/$/, '') : out) || null
  } catch (error) {
    // A canceled dialog exits non-zero; only a missing tool is worth telling the user about.
    if (error instanceof MissingToolError) throw error
    return null
  }
}
/** Ask where to save; null when dismissed. Prefers the addon's panel, which every platform has in the patched build. */
export async function savePanelDialog(hostObject: object | null | undefined, directory: string, suggestedName: string | null | undefined, ctx: OsContext = osContext()): Promise<string | null> {
  const prompt = (hostObject as OsHost | null | undefined)?.promptForNewPath ?? host?.promptForNewPath
  if (prompt) return (await prompt.call(hostObject ?? host, directory, suggestedName))?.[0] ?? null
  const commands = savePanelCommands(directory, suggestedName, ctx)
  if (!commands.length) throw Error('The save panel needs the patched native module. Rebuild it with native/update.sh.')
  requireDisplay(ctx, 'Saving')
  try {
    const out = (await runFirst(commands, { missing: 'Saving needs zenity or kdialog. Install one, then try again.', stopOnExit: [1] })).stdout.trim()
    return out || null
  } catch (error) {
    if (error instanceof MissingToolError) throw error
    return null
  }
}

/**
 * Capture one window's image into `file` (tests and verify scripts). macOS: `screencapture -l`. Elsewhere the addon renders
 * its own window; a window of another process cannot be captured, so callers get a sentence to print and skip.
 */
export function captureWindowImage(windowId: string | number, file: string, ctx: OsContext = osContext()): void {
  const cmd = windowCaptureCommand(windowId, file, ctx)
  if (cmd) {
    const result = spawnSync(cmd.command, cmd.args)
    if (result.status !== 0) throw Error(`${cmd.command} failed: ${result.stderr?.toString() ?? ''}`)
    return
  }
  if (native(ctx)?.captureScreenshot) return void native(ctx)!.captureScreenshot!(file)
  throw Error(`Window capture needs macOS, or the addon's captureScreenshot inside the app. Skip this check on ${osName(ctx.platform)}.`)
}

/** Fire and forget, for a menu item that has nowhere to show a failure. */
export const openQuietly = (target: string) => { void openTarget(target).catch(() => {}) }
export const openManyQuietly = (targets: string[]) => { void openTargets(targets).catch(() => {}) }
export const revealQuietly = (file: string) => { void revealPath(file).catch(() => {}) }
