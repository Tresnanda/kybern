import { expect, test } from 'bun:test'
import { Utf8ToUtf32 } from './utf8.ts'

const bytes = (...b: number[]) => new Uint8Array(b)
const enc = (s: string) => new TextEncoder().encode(s)

test('valid UTF-8 decodes like TextDecoder', () => {
  const text = 'ascii 漢字 🙂 é ★'
  expect(new Utf8ToUtf32().decodeString(enc(text))).toBe(text)
})
test('invalid bytes are dropped, not replaced (xterm.js)', () => {
  // vim in a latin-1 locale: "æ~W" as raw bytes.
  expect(new Utf8ToUtf32().decodeString(bytes(0xE6, 0x7E, 0x57, 0x20, 0xFF, 0x41))).toBe('~W A')
  expect(new Utf8ToUtf32().decodeString(bytes(0x80, 0x41))).toBe('A') // stray continuation
  expect(new Utf8ToUtf32().decodeString(bytes(0xC0, 0x80, 0x41))).toBe('A') // overlong NUL: starter dropped, continuation skipped
  expect(new Utf8ToUtf32().decodeString(bytes(0xED, 0xA0, 0x80, 0x41))).toBe('A') // surrogate
  expect(new Utf8ToUtf32().decodeString(bytes(0xEF, 0xBB, 0xBF, 0x41))).toBe('A') // BOM
})
test('a sequence split across chunks waits for the rest', () => {
  const d = new Utf8ToUtf32(), all = enc('a🙂b漢')
  let out = ''
  for (let i = 0; i < all.length; i++) out += d.decodeString(all.subarray(i, i + 1))
  expect(out).toBe('a🙂b漢')
  expect(new Utf8ToUtf32().decodeString(new Uint8Array(70_000).fill(0x61)).length).toBe(70_000)
})
