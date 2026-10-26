// "Open in…" for file tabs (ADE-61): the code editors installed on this Mac, and opening a file at a line in one. Detection
// looks for the app bundles in /Applications and ~/Applications once per launch (a few `existsSync`s). Opening goes through
// each editor's URL scheme or command-line tool, so the file lands at the caret's line; editors without either open the file.
// Off macOS there are no bundles: on Linux the editors whose command-line tool is on the login shell's PATH are offered, on
// Windows the ones found at their usual install location (the VS Code family open through their URL scheme, never a `.cmd`
// shim), and "Default app" is always there, opening the file with the system's choice (`platform/os.ts`).
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { executableName, loginShellPath, openTarget, osContext, pathPlan } from '../platform/os.ts'
import { load, save } from '../shell/persist.ts'

export interface Editor {
  id: string
  name: string
  /** The `.app` bundle found on disk. */
  app: string
}

type Opener = (app: string, file: string, line: number) => { command: string; args: string[] }
const url = (scheme: string, file: string, line: number) => `${scheme}://file${encodeURI(file)}:${line}:1`
const KNOWN: { id: string; name: string; bundles: string[]; open: Opener }[] = [
  { id: 'vscode', name: 'Visual Studio Code', bundles: ['Visual Studio Code.app'], open: (_, file, line) => ({ command: 'open', args: [url('vscode', file, line)] }) },
  { id: 'cursor', name: 'Cursor', bundles: ['Cursor.app'], open: (_, file, line) => ({ command: 'open', args: [url('cursor', file, line)] }) },
  { id: 'windsurf', name: 'Windsurf', bundles: ['Windsurf.app'], open: (_, file, line) => ({ command: 'open', args: [url('windsurf', file, line)] }) },
  { id: 'zed', name: 'Zed', bundles: ['Zed.app', 'Zed Preview.app'], open: (app, file, line) => ({ command: path.join(app, 'Contents/MacOS/cli'), args: [`${file}:${line}`] }) },
  { id: 'xcode', name: 'Xcode', bundles: ['Xcode.app', 'Xcode-beta.app'], open: (_, file, line) => ({ command: '/usr/bin/xed', args: ['--line', String(line), file] }) },
  { id: 'sublime', name: 'Sublime Text', bundles: ['Sublime Text.app'], open: (app, file, line) => ({ command: path.join(app, 'Contents/SharedSupport/bin/subl'), args: [`${file}:${line}`] }) },
  { id: 'nova', name: 'Nova', bundles: ['Nova.app'], open: (_, file, line) => ({ command: 'open', args: [`nova://open?path=${encodeURIComponent(file)}&line=${line}`] }) },
  { id: 'bbedit', name: 'BBEdit', bundles: ['BBEdit.app'], open: (_, file, line) => ({ command: 'open', args: [`x-bbedit://open?url=${encodeURIComponent(`file://${file}`)}&line=${line}`] }) },
  { id: 'textmate', name: 'TextMate', bundles: ['TextMate.app'], open: (_, file, line) => ({ command: 'open', args: [`txmt://open?url=${encodeURIComponent(`file://${file}`)}&line=${line}`] }) },
  { id: 'intellij', name: 'IntelliJ IDEA', bundles: ['IntelliJ IDEA.app', 'IntelliJ IDEA CE.app'], open: (app, file, line) => ({ command: 'open', args: ['-na', app, '--args', '--line', String(line), file] }) },
  { id: 'webstorm', name: 'WebStorm', bundles: ['WebStorm.app'], open: (app, file, line) => ({ command: 'open', args: ['-na', app, '--args', '--line', String(line), file] }) },
  { id: 'textedit', name: 'TextEdit', bundles: ['TextEdit.app'], open: (app, file) => ({ command: 'open', args: ['-a', app, file] }) },
]

/**
 * Windows: the editors whose program is found at its usual install location. The VS Code family opens through its URL scheme
 * (`vscode://file/C:/…:line:1`, through the safe open path, as macOS does); the others run their real `.exe`. The `code.cmd`
 * shims are never run: a `.cmd` needs a shell, and a file name must not reach one.
 */
interface WindowsEditor { id: string; name: string; scheme?: string; exes: string[] }
const WINDOWS_EDITORS: WindowsEditor[] = [
  { id: 'vscode', name: 'Visual Studio Code', scheme: 'vscode', exes: ['%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\Code.exe', '%ProgramFiles%\\Microsoft VS Code\\Code.exe'] },
  { id: 'cursor', name: 'Cursor', scheme: 'cursor', exes: ['%LOCALAPPDATA%\\Programs\\cursor\\Cursor.exe', '%LOCALAPPDATA%\\Programs\\Cursor\\Cursor.exe'] },
  { id: 'windsurf', name: 'Windsurf', scheme: 'windsurf', exes: ['%LOCALAPPDATA%\\Programs\\Windsurf\\Windsurf.exe'] },
  { id: 'zed', name: 'Zed', exes: ['%LOCALAPPDATA%\\Programs\\Zed\\zed.exe'] },
  { id: 'sublime', name: 'Sublime Text', exes: ['%ProgramFiles%\\Sublime Text\\subl.exe'] },
]
/** `%NAME%` placeholders filled from the environment; null when one is unset. */
const expandWindows = (template: string, env: Record<string, string | undefined>) => {
  let missing = false
  const out = template.replace(/%(\w+)%/g, (_, name: string) => { const value = env[name]; if (!value) missing = true; return value ?? '' })
  return missing ? null : out
}
/** `vscode://file/C:/Users/ada/a.ts:12:1`: a Windows path needs the slash after `file` and forward slashes. */
export const editorUrl = (scheme: string, file: string, line: number, platform: NodeJS.Platform = process.platform) =>
  platform === 'win32' ? `${scheme}://file/${encodeURI(file.replaceAll('\\', '/'))}:${line}:1` : url(scheme, file, line)

/** Linux: the editor's command-line tool, which takes `file:line` or `--line`. Windows tools are in `WINDOWS_EDITORS`. */
const COMMANDS: { id: string; name: string; command: string; args: (file: string, line: number) => string[] }[] = [
  { id: 'vscode', name: 'Visual Studio Code', command: 'code', args: (file, line) => ['--goto', `${file}:${line}`] },
  { id: 'cursor', name: 'Cursor', command: 'cursor', args: (file, line) => ['--goto', `${file}:${line}`] },
  { id: 'windsurf', name: 'Windsurf', command: 'windsurf', args: (file, line) => ['--goto', `${file}:${line}`] },
  { id: 'zed', name: 'Zed', command: 'zed', args: (file, line) => [`${file}:${line}`] },
  { id: 'sublime', name: 'Sublime Text', command: 'subl', args: (file, line) => [`${file}:${line}`] },
  { id: 'intellij', name: 'IntelliJ IDEA', command: 'idea', args: (file, line) => ['--line', String(line), file] },
  { id: 'webstorm', name: 'WebStorm', command: 'webstorm', args: (file, line) => ['--line', String(line), file] },
]
const DEFAULT_APP: Editor = { id: 'default', name: 'Default app', app: '' }
const onPath = (command: string, dirs: string[], exists: (file: string) => boolean) => dirs.map((dir) => path.join(dir, executableName(command, process.platform))).find(exists)

/** Where Linux editors may be: what `pathPlan` knows (`~/.local/bin`, `/snap/bin`, version managers) plus the login shell's PATH once it has answered. */
function linuxDirs(login: string[]): string[] {
  const ctx = osContext(), plan = pathPlan(ctx)
  return [...new Set([...login, ...plan.fallback])]
}
/** The editors installed on this machine, off macOS. Pure of the `process`: the folders and the environment come in. */
export function detectEditors(platform: NodeJS.Platform, env: Record<string, string | undefined>, dirs: string[], exists: (file: string) => boolean = existsSync): Editor[] {
  if (platform === 'win32') {
    const found = WINDOWS_EDITORS.flatMap((known) => {
      const app = known.exes.map((exe) => expandWindows(exe, env)).find((candidate): candidate is string => !!candidate && exists(candidate))
      return app ? [{ id: known.id, name: known.name, app }] : []
    })
    return [...found, DEFAULT_APP]
  }
  return [...COMMANDS.flatMap((known) => { const app = onPath(known.command, dirs, exists); return app ? [{ id: known.id, name: known.name, app }] : [] }), DEFAULT_APP]
}

let found: Editor[] | null = null
let loginRefreshed = false
/** The editors installed here, in a fixed order. */
export function installedEditors(): Editor[] {
  if (found) return found
  if (process.platform !== 'darwin') {
    found = detectEditors(process.platform, process.env, linuxDirs([]))
    // The login shell's PATH arrives later; the next call (the menu opens) lists whatever it adds.
    if (process.platform === 'linux' && !loginRefreshed) {
      loginRefreshed = true
      void loginShellPath().then((dirs) => { found = detectEditors('linux', process.env, linuxDirs(dirs)) }).catch(() => {})
    }
    return found
  }
  const roots = ['/Applications', path.join(homedir(), 'Applications'), '/System/Applications']
  found = []
  for (const known of KNOWN) {
    const app = known.bundles.flatMap((bundle) => roots.map((root) => path.join(root, bundle))).find((candidate) => existsSync(candidate))
    if (app) found.push({ id: known.id, name: known.name, app })
  }
  return found
}

const PREF = 'kybern.files.editor'
/** The editor ⌘⇧O uses: the one picked last (Settings or the menu), else the first one installed. */
export function defaultEditor(): Editor | null {
  const editors = installedEditors()
  const saved = load<string | null>(PREF, null)
  return editors.find((editor) => editor.id === saved) ?? editors.find((editor) => editor.id !== 'textedit' && editor.id !== DEFAULT_APP.id) ?? editors[0] ?? null
}
export function setDefaultEditor(id: string) { save(PREF, id) }

/** Start a program and resolve once it has spawned; never through a shell. */
function launch(command: string, args: string[], editor: Editor): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true })
    child.on('error', () => reject(new Error(`Unable to open ${editor.name}. Check that it is installed, then try again.`)))
    child.on('spawn', () => { child.unref(); resolve() })
  })
}

/** Open `file` (absolute) at `line` in `editor`; remembers it as the default. Rejects with a message to show. */
export function openInEditor(editor: Editor, file: string, line: number): Promise<void> {
  if (process.platform !== 'darwin') {
    setDefaultEditor(editor.id)
    const at = Math.max(1, line)
    const failed = () => { throw new Error(`Unable to open ${editor.name}. Check your default apps, then try again.`) }
    if (process.platform === 'win32') {
      const known = WINDOWS_EDITORS.find((candidate) => candidate.id === editor.id)
      if (known?.scheme) return openTarget(editorUrl(known.scheme, file, at)).catch(failed)
      if (known) return launch(editor.app, [`${file}:${at}`], editor)
      return openTarget(file).catch(failed)
    }
    const tool = COMMANDS.find((candidate) => candidate.id === editor.id)
    if (!tool) return openTarget(file).catch(failed)
    return launch(editor.app, tool.args(file, at), editor)
  }
  const known = KNOWN.find((candidate) => candidate.id === editor.id)!
  let { command, args } = known.open(editor.app, file, Math.max(1, line))
  // Zed and Sublime ship their CLI in the bundle; when it is missing, open the file without a line.
  if (command.startsWith('/') && command !== '/usr/bin/xed' && !existsSync(command)) ({ command, args } = { command: 'open', args: ['-a', editor.app, file] })
  setDefaultEditor(editor.id)
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: true })
    child.on('error', () => reject(new Error(`Unable to open ${editor.name}. Check that it is installed, then try again.`)))
    child.on('spawn', () => { child.unref(); resolve() })
  })
}
