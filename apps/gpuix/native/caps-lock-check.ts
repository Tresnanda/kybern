import '../src/native/local-build.ts'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchFixture } from '../src/requests/harness.ts'
import { COMPANION_CFLAGS } from '../scripts/companion-flags.ts'

// Caps Lock typing (caps_lock_gpui.py). AppKit key events with NSEventModifierFlagCapsLock go
// through GPUI's own macOS key path. Ordinary typing inserts AppKit's text; a key the composer
// intercepts, and every key queued behind it while JS answers, is replayed with GPUI's `key_char`,
// which used to ignore Caps Lock: "caps lock vxyz" came out as "cAPS LOcK vxyz" typed slowly and
// "caps lock vxyz" in a burst. Assumes a Latin layout with letters on the ANSI keys.
mkdirSync(path.join(import.meta.dir, 'build'), { recursive: true })
execFileSync('clang', ['-dynamiclib', ...COMPANION_CFLAGS, '-framework', 'Cocoa', path.join(import.meta.dir, 'caps-lock-input.m'), '-o', path.join(import.meta.dir, 'build/caps-lock-input.dylib')])
const scratch = mkdtempSync(path.join(tmpdir(), 'gpuix-caps-lock-'))
const f = await launchFixture(path.join(import.meta.dir, 'caps-lock-lab.tsx'), { GPUIX_BACKGROUND: '1', KYBERN_DATA_DIR: scratch, KYBERN_URL: '' }), a = f.app
type Result = { step: number; plain: string; composer: string; note: string; keyChars: string[] }
const failures: string[] = []
try {
  await a.getByTestId('ready').waitFor({ timeoutMs: 30_000 })
  const root = (await a.getByTestId('ready').element()).id
  // Real time only: taking over the fixture clock also stops the main-queue turns the key events need.
  const settle = () => Bun.sleep(100)
  const read = async (): Promise<Result> => {
    return JSON.parse(await a.getByTestId('result').textContent())
  }
  // Wait until the step's text has stopped changing (a slow step types one key per 80 ms).
  const run = async (): Promise<Result> => {
    await a.call('keyDown', { elementId: root, key: 'n' })
    for (let i = 0; i < 4; i++) await settle()
    await a.call('keyDown', { elementId: root, key: 't' })
    let last = '', same = 0, r = await read()
    for (let i = 0; i < 100 && same < 8; i++) {
      await settle()
      r = await read()
      const now = JSON.stringify(r)
      same = now === last && (r.plain || r.composer || r.note.trim()) ? same + 1 : 0
      last = now
    }
    if (process.env.KYBERN_CAPS_LOCK_DEBUG) console.log(JSON.stringify(r))
    return r
  }
  const expect = (name: string, actual: string, wanted: string) => {
    const line = `${actual === wanted ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(actual)}${actual === wanted ? '' : ` (wanted ${JSON.stringify(wanted)})`}`
    console.log(line)
    if (actual !== wanted) failures.push(line)
  }
  let r = await run()
  if (r.plain !== 'CAPS LOCK ON' && r.plain.toLowerCase() !== 'caps lock on') throw new Error(`AppKit key events did not reach the lab input (${JSON.stringify(r.plain)}); is the keyboard layout Latin?`)
  expect('plain input, Caps Lock (AppKit text)', r.plain, 'CAPS LOCK ON')
  r = await run()
  expect('composer, Caps Lock, one key at a time', r.composer, 'CAPS LOCK VXYZ')
  expect('composer keyChar seen by JS, Caps Lock', r.keyChars.join(''), 'CAPS LOCK VXYZ')
  r = await run()
  expect('composer, Caps Lock, fast burst', r.composer, 'CAPS LOCK VXYZ')
  r = await run()
  expect('composer, Shift', r.composer, 'CAB')
  r = await run()
  expect('composer, no modifiers', r.composer, 'cab')
  r = await run()
  expect('notes editor, Caps Lock burst behind an intercepted Escape', r.note.trim(), 'ABCD')
  assert.equal(failures.length, 0, failures.join('\n'))
  console.log('ok  Caps Lock typing keeps its case on every key path')
} catch (error) { console.error(f.diagnostics()); throw error } finally { await f.close(); rmSync(scratch, { recursive: true, force: true }) }
