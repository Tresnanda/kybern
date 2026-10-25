// Platform services against simulated platforms: each test passes an `OsContext`, so nothing reads this machine's
// PATH, home or session.
import { afterAll, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  MissingToolError, UnsafeTargetError, appCacheDir, appConfigDir, appLocalDataDir, clipboardReadCommands, clipboardWriteCommands, desktopConfigDir, downloadsDir, executableName, fileUri, folderPickerCommands,
  gpuixCacheDir, gpuixConfigDir, homeFor, launchFirst, openCommands, openManyCommands, osLabels, pathPlan, pickFolderDialog, powershell, revealCommands, runFirst, runFirstSync,
  openTarget, openTargets, savePanelCommands, userDirsDownload, windowCaptureCommand, windowsTarget, withPath, type Cmd, type OsContext,
} from './os.ts'

const mac: OsContext = { platform: 'darwin', env: {}, home: '/Users/ada' }
const win: OsContext = { platform: 'win32', env: { APPDATA: 'C:\\Users\\ada\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\ada\\AppData\\Local', PATH: 'C:\\Windows;C:\\Tools' }, home: 'C:\\Users\\ada' }
const linux: OsContext = { platform: 'linux', env: { DISPLAY: ':0', SHELL: '/bin/zsh', PATH: '/usr/bin:/bin' }, home: '/home/ada' }
const wayland: OsContext = { ...linux, env: { ...linux.env, WAYLAND_DISPLAY: 'wayland-0' } }
const decode = (cmd: { args: string[] }) => Buffer.from(cmd.args.at(-1)!, 'base64').toString('utf16le')

test('config and cache folders follow each platform, and macOS keeps its existing paths', () => {
  expect(gpuixConfigDir(mac)).toBe('/Users/ada/Library/Application Support/kybern-gpuix')
  expect(desktopConfigDir(mac)).toBe('/Users/ada/Library/Application Support/dev.kybern.desktop')
  expect(gpuixCacheDir('cache', null, mac)).toBe('/Users/ada/Library/Caches/kybern-gpuix')
  expect(gpuixCacheDir('image-cache', 'images', mac)).toBe('/Users/ada/Library/Caches/kybern-gpuix/images')
  expect(gpuixConfigDir(win)).toBe('C:\\Users\\ada\\AppData\\Roaming\\kybern-gpuix')
  expect(desktopConfigDir(win)).toBe('C:\\Users\\ada\\AppData\\Roaming\\dev.kybern.desktop')
  expect(gpuixCacheDir('image-cache', 'images', win)).toBe('C:\\Users\\ada\\AppData\\Local\\kybern-gpuix\\images')
  expect(gpuixConfigDir(linux)).toBe('/home/ada/.config/kybern-gpuix')
  expect(gpuixCacheDir('cache', null, linux)).toBe('/home/ada/.cache/kybern-gpuix')
  expect(gpuixConfigDir({ ...linux, env: { ...linux.env, XDG_CONFIG_HOME: '/cfg' } })).toBe('/cfg/kybern-gpuix')
  expect(appCacheDir('x', { ...linux, env: { XDG_CACHE_HOME: '/c' } })).toBe('/c/x')
})
test('Windows falls back to AppData under the home folder when APPDATA is unset', () => {
  const bare: OsContext = { platform: 'win32', env: {}, home: 'C:\\Users\\ada' }
  expect(appConfigDir('x', bare)).toBe('C:\\Users\\ada\\AppData\\Roaming\\x')
  expect(appCacheDir('x', bare)).toBe('C:\\Users\\ada\\AppData\\Local\\x')
})
test('a scratch config folder holds the caches too, on every platform', () => {
  for (const base of [mac, win, linux]) {
    const ctx = { ...base, env: { ...base.env, KYBERN_CLIENT_CONFIG_DIR: '/scratch/client' } }
    expect(gpuixConfigDir(ctx)).toBe('/scratch/client')
    expect(desktopConfigDir(ctx)).toBe('/scratch/client')
    expect(gpuixCacheDir('cache', null, ctx).replaceAll('\\', '/')).toBe('/scratch/client/cache')
    expect(gpuixCacheDir('image-cache', 'images', ctx).replaceAll('\\', '/')).toBe('/scratch/client/image-cache')
  }
})
test('downloads', () => {
  expect(downloadsDir(mac)).toBe('/Users/ada/Downloads')
  expect(downloadsDir(win)).toBe('C:\\Users\\ada\\Downloads')
  expect(downloadsDir(linux)).toBe('/home/ada/Downloads')
  expect(downloadsDir({ ...linux, env: { XDG_DOWNLOAD_DIR: '/home/ada/Téléchargements' } })).toBe('/home/ada/Téléchargements')
  // A relative XDG_* value is invalid by the spec and ignored.
  expect(downloadsDir({ ...linux, env: { XDG_DOWNLOAD_DIR: 'Downloads' } })).toBe('/home/ada/Downloads')
  expect(appConfigDir('x', { ...linux, env: { XDG_CONFIG_HOME: '.config' } })).toBe('/home/ada/.config/x')
  expect(appCacheDir('x', { ...linux, env: { XDG_CACHE_HOME: 'cache' } })).toBe('/home/ada/.cache/x')
})
test('Linux asks user-dirs.dirs for a translated Downloads folder', () => {
  expect(userDirsDownload('# comment\nXDG_DESKTOP_DIR="$HOME/Bureau"\nXDG_DOWNLOAD_DIR="$HOME/Téléchargements"\n', '/home/ada')).toBe('/home/ada/Téléchargements')
  expect(userDirsDownload('XDG_DOWNLOAD_DIR="/data/dl"', '/home/ada')).toBe('/data/dl')
  expect(userDirsDownload('XDG_DOWNLOAD_DIR="relative"', '/home/ada')).toBeNull()
  expect(userDirsDownload('', '/home/ada')).toBeNull()
  const home = mkdtempSync(path.join(tmpdir(), 'kybern-home-'))
  try {
    mkdirSync(path.join(home, 'cfg'), { recursive: true })
    writeFileSync(path.join(home, 'cfg/user-dirs.dirs'), 'XDG_DOWNLOAD_DIR="$HOME/Téléchargements"\n')
    expect(downloadsDir({ platform: 'linux', env: { XDG_CONFIG_HOME: path.join(home, 'cfg') }, home })).toBe(path.join(home, 'Téléchargements'))
    expect(downloadsDir({ platform: 'linux', env: { XDG_CONFIG_HOME: path.join(home, 'none') }, home })).toBe(path.join(home, 'Downloads'))
  } finally { rmSync(home, { recursive: true, force: true }) }
})
test('Windows home is USERPROFILE, not HOME; per-machine files go to %LOCALAPPDATA%', () => {
  expect(homeFor('win32', { HOME: '/c/Users/git-bash', USERPROFILE: 'C:\\Users\\ada' })).toBe('C:\\Users\\ada')
  expect(homeFor('darwin', { HOME: '/Users/ada', USERPROFILE: 'ignored' })).toBe('/Users/ada')
  expect(appLocalDataDir('kybern-gpuix', win)).toBe('C:\\Users\\ada\\AppData\\Local\\kybern-gpuix')
  expect(appLocalDataDir('kybern-gpuix', mac)).toBe('/Users/ada/Library/Application Support/kybern-gpuix')
})

test('copy names the platform; macOS keeps Finder', () => {
  expect(osLabels('darwin')).toMatchObject({ thisComputer: 'This Mac', onThisComputer: 'on this Mac', thisComputerInline: 'this Mac', reveal: 'Reveal in Finder', openFolder: 'Open in Finder', choose: 'Choose in Finder…' })
  expect(osLabels('win32')).toMatchObject({ thisComputer: 'This computer', thisComputerInline: 'this computer', reveal: 'Show in Explorer', openFolder: 'Open in Explorer' })
  expect(osLabels('linux')).toMatchObject({ thisComputer: 'This computer', reveal: 'Show in Files', onThisComputer: 'on this computer' })
})

test('open and reveal pick the platform tool', () => {
  expect(openCommands('https://a.dev/?x=1&y=2', mac)).toEqual([{ command: 'open', args: ['https://a.dev/?x=1&y=2'] }])
  // Windows never goes through cmd.exe, so `&` stays part of the address.
  expect(openCommands('https://a.dev/?x=1&y=2', win)).toEqual([{ command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', 'https://a.dev/?x=1&y=2'] }])
  // A file opens through Explorer, not the URL handler.
  expect(openCommands('C:/Users/ada/notes.md', win)).toEqual([{ command: 'explorer.exe', args: ['C:\\Users\\ada\\notes.md'] }])
  expect(openCommands('/tmp/a b.md', linux).map(c => c.command)).toEqual(['xdg-open', 'gio'])
  expect(openManyCommands(['/a', '/b'], mac)).toEqual([[{ command: 'open', args: ['/a', '/b'] }]])
  expect(openManyCommands(['/a', '/b'], linux)).toHaveLength(2)
  expect(revealCommands('/Users/ada/a b.txt', mac)).toEqual([{ command: 'open', args: ['-R', '/Users/ada/a b.txt'] }])
  expect(revealCommands('C:/Users/ada/a b.txt', win)).toEqual([{ command: 'explorer.exe', args: ['/select,"C:\\Users\\ada\\a b.txt"'], verbatim: true }])
  // S7: a comma ends Explorer's `/select,` argument unless the path is quoted, and the quotes must reach it as written.
  expect(revealCommands('C:\\Users\\ada\\a, b\\c,d.txt', win)).toEqual([{ command: 'explorer.exe', args: ['/select,"C:\\Users\\ada\\a, b\\c,d.txt"'], verbatim: true }])
  const reveal = revealCommands('/home/ada/My Files/#1.txt', linux)
  expect(reveal.map(c => c.command)).toEqual(['dbus-send', 'xdg-open', 'gio'])
  expect(reveal[0]!.args).toContain('array:string:file:///home/ada/My%20Files/%231.txt')
  expect(reveal[1]!.args).toEqual(['/home/ada/My Files'])
  expect(fileUri('/a/ü b')).toBe('file:///a/%C3%BC%20b')
})

test('the clipboard uses pbcopy, PowerShell, wl-clipboard or xclip by session', () => {
  expect(clipboardWriteCommands(mac)).toEqual([{ command: 'pbcopy', args: [] }])
  expect(clipboardReadCommands(mac)).toEqual([{ command: 'pbpaste', args: [] }])
  expect(clipboardWriteCommands(linux).map(c => c.command)).toEqual(['xclip', 'xsel', 'wl-copy'])
  expect(clipboardWriteCommands(wayland).map(c => c.command)).toEqual(['wl-copy', 'xclip', 'xsel'])
  expect(clipboardReadCommands(wayland).map(c => c.command)).toEqual(['wl-paste', 'xclip', 'xsel'])
  expect(clipboardReadCommands(wayland)[0]!.args).toContain('--no-newline')
  const [write] = clipboardWriteCommands(win), [read] = clipboardReadCommands(win)
  expect(write!.command).toBe('powershell.exe')
  expect(decode(write!)).toContain('Set-Clipboard')
  expect(decode(write!)).toContain('UTF8Encoding')
  expect(decode(read!)).toContain('Get-Clipboard -Raw')
  // The text arrives on stdin, never in the command line.
  expect(write!.args.join(' ')).not.toContain('hello')
})

test('PowerShell scripts travel encoded and carry no caller text', () => {
  const cmd = powershell('Write-Output "a b"', { sta: true, env: { KYBERN_X: 'v' } })
  expect(cmd).toEqual({ command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from('Write-Output "a b"', 'utf16le').toString('base64')], env: { KYBERN_X: 'v' } })
})

test('pickers: osascript on macOS, a PowerShell dialog on Windows, zenity or kdialog on Linux', () => {
  expect(folderPickerCommands(mac)[0]).toMatchObject({ command: 'osascript' })
  expect(folderPickerCommands(win)[0]!.args).toContain('-STA')
  expect(decode(folderPickerCommands(win)[0]!)).toContain('FolderBrowserDialog')
  expect(folderPickerCommands(linux).map(c => c.command)).toEqual(['zenity', 'kdialog'])
  expect(savePanelCommands('/Users/ada/Downloads', 'a.md', mac)).toEqual([])
  expect(decode(savePanelCommands('C:\\Users\\O\'Brien', 'n.md', win)[0]!)).toContain('$d.InitialDirectory=$env:KYBERN_SAVE_DIR')
  expect(savePanelCommands('/home/ada/Downloads', 'n.md', linux)[0]!.args).toContain('--filename=/home/ada/Downloads/n.md')
})

test('window capture exists on macOS only', () => {
  expect(windowCaptureCommand(42, '/tmp/a.png', mac)).toEqual({ command: 'screencapture', args: ['-l', '42', '-x', '-o', '/tmp/a.png'] })
  expect(windowCaptureCommand(42, 'a.png', win)).toBeNull()
  expect(windowCaptureCommand(42, 'a.png', linux)).toBeNull()
})

test('PATH: the login shell on macOS and Linux, the inherited environment on Windows', () => {
  const m = pathPlan({ ...mac, env: { SHELL: '/bin/zsh', PATH: '/usr/bin' } })
  expect(m.shell).toEqual({ command: '/bin/zsh', args: ['-ilc', 'printf \'%s\' "$PATH"'] })
  expect(m.fallback).toEqual(['/Users/ada/.local/bin', '/Users/ada/.cargo/bin', '/Users/ada/.bun/bin', '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'])
  const l = pathPlan(linux)
  expect(l.shell?.command).toBe('/bin/zsh')
  expect(l.fallback).not.toContain('/opt/homebrew/bin')
  expect(l.fallback).toContain('/home/linuxbrew/.linuxbrew/bin')
  expect(pathPlan({ ...linux, env: {} }).shell).toBeNull()
  const w = pathPlan(win)
  expect(w.shell).toBeNull()
  expect(w.fallback.slice(0, 2)).toEqual(['C:\\Windows', 'C:\\Tools'])
  expect(w.fallback.join(';')).not.toContain('/opt/homebrew')
})
test('executables take .exe on Windows only', () => {
  expect(executableName('kybern', 'win32')).toBe('kybern.exe')
  expect(executableName('kybern.exe', 'win32')).toBe('kybern.exe')
  expect(executableName('kybern', 'darwin')).toBe('kybern')
  expect(executableName('kybernd', 'linux')).toBe('kybernd')
})

// ---- B1: no caller-controlled bytes in any PowerShell script ----

// Everything PowerShell can read as a quote, a substitution, a separator or a line break.
const NASTY = [
  'x’;Start-Process calc;’.html', 'a‘b’c‚d‛e', "O'Brien's", '"; calc; "', '$(calc)', '${env:USERNAME}', '`calc`', 'a;b&c|d', 'a\nb\r\nc', '@\'\ncalc\n\'@', '<#', '%PATH%', '..\\..\\x', 'ü—✓',
]
test('B1: the save panel script is the same fixed text whatever the folder or file name holds; the values travel in the environment', () => {
  const fixed = savePanelCommands('C:\\Users\\ada\\Downloads', 'plain.md', win)[0]!
  for (const value of NASTY) {
    for (const [directory, name] of [['C:\\Users\\ada\\Downloads', value], [`C:\\${value}`, 'plain.md']] as const) {
      const cmd = savePanelCommands(directory, name, win)[0]!
      expect(decode(cmd)).toBe(decode(fixed))
      // The encoded script is the only argument that varies in kind; it holds nothing of the value.
      expect(cmd.args).toEqual(fixed.args)
      expect(cmd.env).toEqual({ KYBERN_SAVE_DIR: directory, KYBERN_SAVE_NAME: name })
    }
  }
  expect(decode(fixed)).toContain('$env:KYBERN_SAVE_NAME')
  expect(decode(fixed)).toContain('$env:KYBERN_SAVE_DIR')
})
test('B1: a NUL cannot cut an environment value short', () => {
  expect(savePanelCommands('C:\\d', 'a\0b.md', win)[0]!.env!.KYBERN_SAVE_NAME).toBe('ab.md')
})
test('B1: every PowerShell script in the app is a fixed literal (no interpolation but the encoding preamble), and psQuote is gone', () => {
  const root = path.join(import.meta.dir, '..')
  const sources = [path.join(root, 'platform/os.ts'), path.join(root, 'environments/credentials.ts'), path.join(root, 'platform/update.ts'), path.join(root, 'platform/cli.ts'), path.join(root, 'dock/editors.ts')]
  for (const file of sources) {
    const source = readFileSync(file, 'utf8')
    expect(source).not.toContain('psQuote')
    for (const match of source.matchAll(/powershell\(\s*`([^`]*)`/g)) expect(match[1]!.replaceAll('${UTF8_IO}', '')).not.toContain('${')
    // No script is assembled by adding strings to it.
    expect(source).not.toMatch(/powershell\([^)]*\+/)
  }
})
test('B1: the other generated scripts take values as arguments or the environment too (no shell in the open, reveal or editor path)', () => {
  for (const value of NASTY) {
    for (const ctx of [mac, linux, win]) {
      // Argument vectors carry the value whole; nothing is joined into one command string.
      const cmds: Cmd[][] = [clipboardWriteCommands(ctx), folderPickerCommands(ctx), savePanelCommands('/tmp', value, ctx)]
      for (const cmd of cmds.flat()) { expect(cmd.command).not.toMatch(/^(sh|bash|cmd|cmd\.exe)$/i); expect(cmd.args.some(arg => /^(-c|\/c)$/i.test(arg))).toBe(false) }
    }
  }
})

// ---- S1: a clipboard tool that leaves a background owner holding the pipes ----

const scratch = mkdtempSync(path.join(tmpdir(), 'kybern-os-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
function fakeTool(name: string, body: string, env: Record<string, string> = {}): Cmd {
  const file = path.join(scratch, name)
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
  return { command: file, args: [], env }
}
const posix = process.platform !== 'win32'
const timed = async <T>(fn: () => Promise<T> | T) => { const start = performance.now(); const value = await fn(); return { value, ms: performance.now() - start } }

test.skipIf(!posix)('S1: copy returns promptly and succeeds when the tool forks a background owner that holds stderr', async () => {
  const out = path.join(scratch, 'copied')
  // Like `xclip -in`: read the text, fork the selection owner (it inherits stdout and stderr), exit 0.
  const xclip = fakeTool('fake-xclip', 'cat > "$FAKE_OUT"\nsleep 4 &\nexit 0', { FAKE_OUT: out })
  const { ms } = await timed(() => runFirst([xclip], { input: 'hello clipboard', missing: 'none', timeout: 10000, discardOutput: true }))
  expect(readFileSync(out, 'utf8')).toBe('hello clipboard')
  expect(ms).toBeLessThan(1500)
})
test.skipIf(!posix)('S1: the synchronous copy (macOS ⌘X) is not held either', () => {
  const out = path.join(scratch, 'copied-sync')
  const xclip = fakeTool('fake-xclip-sync', 'cat > "$FAKE_OUT"\nsleep 4 &\nexit 0', { FAKE_OUT: out })
  const start = performance.now()
  runFirstSync([xclip], { input: 'sync text', missing: 'none', discardOutput: true })
  expect(readFileSync(out, 'utf8')).toBe('sync text')
  expect(performance.now() - start).toBeLessThan(1500)
})
test.skipIf(!posix)('S1: a tool that really fails is still a failure, and the next candidate runs', async () => {
  const out = path.join(scratch, 'second')
  const bad = fakeTool('fake-bad-copy', 'cat >/dev/null\nexit 3')
  const good = fakeTool('fake-good-copy', 'cat > "$FAKE_OUT"', { FAKE_OUT: out })
  await runFirst([bad, good], { input: 'x', missing: 'none', discardOutput: true })
  expect(readFileSync(out, 'utf8')).toBe('x')
  await expect(runFirst([bad], { input: 'x', missing: 'none', discardOutput: true })).rejects.toThrow('exited with 3')
})
test.skipIf(!posix)('S1: stopOnExit treats a closed dialog as "no" and does not open the next picker', async () => {
  const log = path.join(scratch, 'pickers')
  const zenity = fakeTool('fake-zenity', 'echo zenity >> "$LOG"\nexit 1', { LOG: log })
  const kdialog = fakeTool('fake-kdialog', 'echo kdialog >> "$LOG"\necho /picked', { LOG: log })
  const result = await runFirst([zenity, kdialog], { missing: 'none', stopOnExit: [1] })
  expect(result.stdout).toBe('')
  expect(readFileSync(log, 'utf8')).toBe('zenity\n')
})

// ---- S2: a slow foreground app is not a failure, and the target never opens twice ----

test.skipIf(!posix)('S2: an app that keeps running counts as opened; the fallback tool does not open the target a second time', async () => {
  const log = path.join(scratch, 'open-slow')
  const xdg = fakeTool('fake-xdg-open-slow', 'echo xdg >> "$LOG"\nsleep 6', { LOG: log })
  const gio = fakeTool('fake-gio-slow', 'echo gio >> "$LOG"', { LOG: log })
  // Settles well before the tool's own 6 s: the call does not wait for the app, and does not read its running as a failure.
  const { ms } = await timed(() => launchFirst([xdg, gio], { missing: 'none', settleMs: 800 }))
  expect(ms).toBeLessThan(3500)
  expect(readFileSync(log, 'utf8')).toBe('xdg\n')
})
test.skipIf(!posix)('S2: a tool that exits non-zero straight away, or is not installed, falls through to the next', async () => {
  const log = path.join(scratch, 'open-fallthrough')
  const xdg = fakeTool('fake-xdg-open-fail', 'echo xdg >> "$LOG"\nexit 4', { LOG: log })
  const gio = fakeTool('fake-gio-ok', 'echo gio >> "$LOG"', { LOG: log })
  const absent: Cmd = { command: path.join(scratch, 'does-not-exist'), args: [] }
  await launchFirst([absent, xdg, gio], { missing: 'none', settleMs: 500 })
  expect(readFileSync(log, 'utf8')).toBe('xdg\ngio\n')
})
test.skipIf(!posix)('S2: every candidate failing is an error, none installed is a MissingToolError, and ignoreExit accepts an Explorer-style exit 1', async () => {
  const fail = fakeTool('fake-open-fail', 'exit 2')
  await expect(launchFirst([fail], { missing: 'none', settleMs: 500 })).rejects.toThrow('exited with 2')
  await expect(launchFirst([{ command: path.join(scratch, 'nope'), args: [] }], { missing: 'Install it.', settleMs: 500 })).rejects.toThrow(MissingToolError)
  const explorer = fakeTool('fake-explorer', 'exit 1')
  await launchFirst([explorer], { missing: 'none', ignoreExit: true, settleMs: 500 })
})

// ---- S6: Windows open must not run files or leak credentials ----

test('S6: network, device and relative paths are refused for open and reveal', () => {
  for (const target of ['\\\\evil.example\\share\\a.md', '//evil.example/share/a.md', '\\\\?\\C:\\a.md', '\\\\.\\pipe\\x', '\\\\?\\UNC\\evil\\share\\a.md']) {
    expect(() => openCommands(target, win)).toThrow(UnsafeTargetError)
    expect(() => revealCommands(target, win)).toThrow(UnsafeTargetError)
    expect(() => windowsTarget(target, win)).toThrow('network or device')
  }
  expect(() => openCommands('notes.md', win)).toThrow('full path')
  expect(() => openCommands('C:\\a.txt:evil.exe', win)).toThrow('characters Windows doesn’t allow')
  expect(() => openCommands('C:\\a<b>.txt', win)).toThrow(UnsafeTargetError)
})
test('S6: programs, scripts and shortcuts are shown in Explorer, not run', () => {
  for (const name of ['setup.exe', 'run.BAT', 'x.cmd', 'link.lnk', 'x.url', 'a.hta', 'a.scr', 'a.msi', 'a.ps1', 'a.vbs', 'a.js', 'a.wsf', 'a.jse', 'a.vbe', 'a.cpl', 'a.reg', 'a.scf', 'a.appref-ms', 'payload.exe.', 'payload.exe  ']) {
    const plan = windowsTarget(`C:\\Users\\ada\\${name}`, win)
    expect(plan.kind).toBe('reveal')
    expect(openCommands(`C:\\Users\\ada\\${name}`, win)[0]!.args[0]).toMatch(/^\/select,"/)
  }
  // PATHEXT of this machine counts too.
  expect(windowsTarget('C:\\t\\x.pyw', { ...win, env: { ...win.env, PATHEXT: '.COM;.EXE;.PYW' } }).kind).toBe('reveal')
  expect(windowsTarget('C:\\t\\x.pyw', win).kind).toBe('open')
  for (const name of ['notes.md', 'photo.PNG', 'report.pdf', 'folder', 'a.exe.txt']) expect(windowsTarget(`C:\\Users\\ada\\${name}`, win).kind).toBe('open')
})
test('S6: only web, mail, phone and editor links reach the URL handler', () => {
  for (const link of ['https://a.dev/?q=1&r=2', 'http://a.dev', 'mailto:a@b.dev', 'tel:+15551234', 'vscode://file/C:/a.ts:3:1', 'cursor://file/C:/a.ts:3:1', 'windsurf://file/C:/a.ts:3:1']) {
    expect(windowsTarget(link, win).kind).toBe('link')
    expect(openCommands(link, win)[0]).toEqual({ command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', link] })
  }
  for (const link of ['file:///C:/Windows/System32/calc.exe', 'ms-msdt:/id', 'search-ms:query=x', 'javascript:alert(1)', 'ftp://a.dev/x', 'shell:startup', 'ms-settings:']) expect(() => openCommands(link, win)).toThrow(UnsafeTargetError)
  // A drive letter is not a scheme.
  expect(windowsTarget('C:\\notes.md', win).kind).toBe('open')
})
test('S6: macOS and Linux keep their commands for any target', () => {
  expect(openCommands('/Applications/Foo.app', mac)).toEqual([{ command: 'open', args: ['/Applications/Foo.app'] }])
  expect(openCommands('\\\\host\\share', linux).map(c => c.command)).toEqual(['xdg-open', 'gio'])
})

// ---- Linux dialogs, PATH and the rest of the nits ----

test('a Linux session with no display gets a sentence, not a silent null', async () => {
  const headless: OsContext = { platform: 'linux', env: {}, home: '/home/ada' }
  await expect(pickFolderDialog(headless)).rejects.toThrow('no display')
  await expect(pickFolderDialog(headless)).rejects.toThrow(MissingToolError)
})
test('PATH: a Windows child gets one Path variable whatever case the process used', () => {
  expect(withPath({ Path: 'C:\\a', pAtH: 'C:\\b', KEEP: '1' }, 'C:\\c', 'win32')).toEqual({ KEEP: '1', Path: 'C:\\c' })
  expect(withPath({ PATH: '/a', KEEP: '1' }, '/b', 'linux')).toEqual({ PATH: '/b', KEEP: '1' })
  expect(pathPlan({ ...win, env: { Path: 'C:\\Only' } }).fallback[0]).toBe('C:\\Only')
  expect(pathPlan(win).fallback.at(-1)).toBe('C:\\Users\\ada\\AppData\\Local\\Programs\\Kybern GPUIX\\bin')
  expect(pathPlan(linux).fallback).toContain('/snap/bin')
  expect(pathPlan(linux).fallback).toContain('/home/ada/.local/bin')
})

test('KYBERN_OPEN_LOG records what Kybern asked the system to open, and starts nothing', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'open-log-'))
  const log = path.join(dir, 'opened.log')
  try {
    for (const ctx of [mac, win, linux]) {
      const withLog: OsContext = { ...ctx, env: { ...ctx.env, KYBERN_OPEN_LOG: log, PATH: '' } }
      await openTarget('http://127.0.0.1:1234/', withLog)
      await openTargets(['http://a.test/', 'https://b.test/'], withLog)
    }
    expect(readFileSync(log, 'utf8').split('\n').filter(Boolean)).toEqual(Array(3).fill(['http://127.0.0.1:1234/', 'http://a.test/ https://b.test/']).flat())
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
