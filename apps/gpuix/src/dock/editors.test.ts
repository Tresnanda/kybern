// Which editors are offered off macOS, and how the VS Code family is opened on Windows (its URL scheme, never a `.cmd` shim).
import { afterAll, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { detectEditors, editorUrl } from './editors.ts'

const root = mkdtempSync(path.join(tmpdir(), 'kybern-editors-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const touch = (file: string) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, '#!/bin/sh\n'); chmodSync(file, 0o755); return file }
const names = (editors: { id: string }[]) => editors.map(editor => editor.id)

test('Linux editors are found on the login shell PATH folders given, including ~/.local/bin and /snap/bin style folders', () => {
  const local = path.join(root, 'home/.local/bin'), snap = path.join(root, 'snap/bin'), thin = path.join(root, 'usr/bin')
  touch(path.join(local, 'cursor')); touch(path.join(snap, 'code')); touch(path.join(thin, 'zed'))
  const found = detectEditors('linux', {}, [thin, local, snap])
  expect(names(found)).toEqual(['vscode', 'cursor', 'zed', 'default'])
  expect(found[0]!.app).toBe(path.join(snap, 'code'))
  // The thin desktop PATH alone would have found one of three.
  expect(names(detectEditors('linux', {}, [thin]))).toEqual(['zed', 'default'])
})
test('Windows editors are found by their install location; the .cmd shims on PATH are never offered', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\ada\\AppData\\Local', ProgramFiles: 'C:\\Program Files', PATH: 'C:\\Users\\ada\\shims' }
  const present = new Set(['C:\\Users\\ada\\shims\\code.cmd', 'C:\\Users\\ada\\shims\\cursor.cmd'])
  expect(names(detectEditors('win32', env, [env.PATH], file => present.has(file)))).toEqual(['default'])
  present.add('C:\\Program Files\\Microsoft VS Code\\Code.exe')
  present.add('C:\\Users\\ada\\AppData\\Local\\Programs\\Zed\\zed.exe')
  const found = detectEditors('win32', env, [env.PATH], file => present.has(file))
  expect(found).toEqual([
    { id: 'vscode', name: 'Visual Studio Code', app: 'C:\\Program Files\\Microsoft VS Code\\Code.exe' },
    { id: 'zed', name: 'Zed', app: 'C:\\Users\\ada\\AppData\\Local\\Programs\\Zed\\zed.exe' },
    { id: 'default', name: 'Default app', app: '' },
  ])
  // An unset ProgramFiles or LOCALAPPDATA skips its candidates instead of probing a malformed path.
  expect(names(detectEditors('win32', {}, [], () => true))).toEqual(['default'])
})
test('the VS Code family opens through its URL scheme with the Windows path in URL form', () => {
  expect(editorUrl('vscode', 'C:\\Users\\ada\\my proj\\a.ts', 12, 'win32')).toBe('vscode://file/C:/Users/ada/my%20proj/a.ts:12:1')
  expect(editorUrl('cursor', 'D:\\x.ts', 1, 'win32')).toBe('cursor://file/D:/x.ts:1:1')
  expect(editorUrl('windsurf', 'C:\\a&b.ts', 3, 'win32')).toBe('windsurf://file/C:/a&b.ts:3:1')
  expect(editorUrl('vscode', '/home/ada/a b.ts', 7, 'linux')).toBe('vscode://file/home/ada/a%20b.ts:7:1')
})
