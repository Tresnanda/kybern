// "Open in…" for file tabs (ADE-61): the code editors installed on this Mac, and opening a file at a line in one. Detection
// looks for the app bundles in /Applications and ~/Applications once per launch (a few `existsSync`s). Opening goes through
// each editor's URL scheme or command-line tool, so the file lands at the caret's line; editors without either open the file.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
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

let found: Editor[] | null = null
/** The editors installed here, in a fixed order. */
export function installedEditors(): Editor[] {
  if (found) return found
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
  return editors.find((editor) => editor.id === saved) ?? editors.find((editor) => editor.id !== 'textedit') ?? editors[0] ?? null
}
export function setDefaultEditor(id: string) { save(PREF, id) }

/** Open `file` (absolute) at `line` in `editor`; remembers it as the default. Rejects with a message to show. */
export function openInEditor(editor: Editor, file: string, line: number): Promise<void> {
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
