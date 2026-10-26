import { expect, test } from 'bun:test'
import { defaultCache, pinned, signerMatches, WEBVIEW2_BOOTSTRAPPER } from './webview2.ts'

test('the bootstrapper is pinned by SHA-256 and size', () => {
  const bytes = new TextEncoder().encode('not the bootstrapper')
  expect(pinned(bytes)).toMatchObject({ ok: false, size: bytes.length })
  const pin = { sha256: pinned(bytes).sha256, size: bytes.length }
  expect(pinned(bytes, pin).ok).toBe(true)
  expect(pinned(new Uint8Array([...bytes, 0]), pin).ok).toBe(false)
  expect(WEBVIEW2_BOOTSTRAPPER.sha256).toMatch(/^[0-9a-f]{64}$/)
})

test("only a valid signature by Microsoft Corporation from a Microsoft Code Signing PCA passes", () => {
  const subject = 'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US'
  const issuer = 'CN=Microsoft Code Signing PCA 2024, O=Microsoft Corporation, L=Redmond, S=Washington, C=US'
  expect(signerMatches(`Valid|${subject}|${issuer}\r\n`)).toBe(true)
  // What Get-AuthenticodeSignature reports for the pinned bootstrapper on windows-2022.
  expect(signerMatches(`Valid|${subject}|CN=Microsoft Code Signing PCA 2024, O=Microsoft Corporation, C=US`)).toBe(true)
  expect(signerMatches(`Valid|${subject}|CN=Microsoft Code Signing PCA 2024, O=Microsoft Corporation, C=US, OU=x`)).toBe(false)
  expect(signerMatches(`Valid|${subject}|CN=Microsoft Code Signing PCA, O=Microsoft Corporation, L=Redmond, S=Washington, C=US`)).toBe(true)
  expect(signerMatches(`HashMismatch|${subject}|${issuer}`)).toBe(false)
  expect(signerMatches(`Valid|CN=Microsoft Corporation Fake, O=Microsoft Corporation, L=Redmond, S=Washington, C=US|${issuer}`)).toBe(false)
  expect(signerMatches(`Valid|${subject}|CN=Evil CA, O=Microsoft Corporation`)).toBe(false)
  expect(signerMatches(`Valid|${subject}`)).toBe(false)
})

test('the cache lives in the user cache folder of each OS', () => {
  expect(defaultCache('win32', { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'C:\\Users\\a')).toBe('C:\\Users\\a\\AppData\\Local\\kybern-gpuix-packaging')
  expect(defaultCache('darwin', {}, '/Users/a')).toBe('/Users/a/Library/Caches/kybern-gpuix-packaging')
  expect(defaultCache('linux', { XDG_CACHE_HOME: '/c' }, '/home/a')).toBe('/c/kybern-gpuix-packaging')
})
