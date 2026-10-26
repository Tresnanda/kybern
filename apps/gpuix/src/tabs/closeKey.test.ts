import { expect, test } from 'bun:test'
import { closeRequestSource } from './closeKey.ts'

test('off macOS a close request is the window\'s own close, never Ctrl+W', () => {
  for (const platform of ['win32', 'linux', 'freebsd'] as const) expect(closeRequestSource(platform)).toBe('pointer')
})
