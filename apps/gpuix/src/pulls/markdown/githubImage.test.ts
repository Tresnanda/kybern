import { describe, expect, test } from 'bun:test'
import { imageFailure, loadable, onGithub, publicImageUrl, sniff } from './githubImage.ts'

const ATTACHMENT = 'https://github.com/user-attachments/assets/a519dc07-d427-4203-ab12-f5d66c026c71'

describe('githubImage', () => {
  test("GitHub's image hosts go through the project's machine; others load here", () => {
    for (const url of [ATTACHMENT, 'https://github.com/acme/api/assets/1/a519dc07-d427-4203-ab12-f5d66c026c71', 'https://private-user-images.githubusercontent.com/1/2-x.png?jwt=t', 'https://camo.githubusercontent.com/abc', 'https://raw.githubusercontent.com/acme/api/main/a.png'])
      expect(onGithub(url)).toBe(true)
    for (const url of ['https://github.com/acme/api/issues/1', 'http://github.com/user-attachments/assets/x', 'https://githubusercontent.com.evil.example/a.png', 'https://example.com/a.png', 'not a url'])
      expect(onGithub(url)).toBe(false)
  })

  test('an issue cannot make this computer fetch from its own network', () => {
    for (const url of ['https://example.com/a.png', 'https://img.shields.io/badge/x.svg', 'https://8.8.8.8/a.png', 'https://[2606:4700::1]/a.png'])
      expect(publicImageUrl(url)).toBe(true)
    for (const url of ['http://example.com/a.png', 'https://localhost/a.png', 'https://printer.local/a.png', 'https://intranet/a.png', 'https://127.0.0.1/a.png',
      'https://10.0.0.5/a.png', 'https://172.20.1.1/a.png', 'https://192.168.1.10/a.png', 'https://169.254.169.254/latest', 'https://100.64.0.1/a.png',
      'https://[::1]/a.png', 'https://[fd00::1]/a.png', 'https://[fe80::1]/a.png', 'https://user:pw@example.com/a.png'])
      expect(publicImageUrl(url)).toBe(false)
  })

  test('only https sources load; the rest show their caption', () => {
    expect(loadable(ATTACHMENT)).toBe(true)
    for (const source of ['', 'docs/shot.png', 'data:image/png;base64,AA==', 'http://example.com/a.png']) expect(loadable(source)).toBe(false)
  })

  test('image types are read from the bytes', () => {
    expect(sniff(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]))).toBe('image/png')
    expect(sniff(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniff(new TextEncoder().encode('GIF89a'))).toBe('image/gif')
    expect(sniff(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp')
    expect(sniff(new TextEncoder().encode('\0\0\0\x1cftypavif'))).toBe('image/avif')
    expect(sniff(new TextEncoder().encode('<!DOCTYPE html>'))).toBeNull()
  })

  test('every failure says what to do in plain words', () => {
    for (const status of [0, -1, 401, 404, 413, 415, 500, 502]) {
      const { reason } = imageFailure(status)
      expect(reason.length).toBeGreaterThan(10)
      expect(reason).not.toMatch(/HTTP|status|Error/)
    }
  })
})
