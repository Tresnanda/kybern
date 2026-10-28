import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { markNoticeShown, noticeFor, noticeShown } from './notice.ts'

let dir = ''
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'kybern-notice-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
const status = (over: Record<string, unknown> = {}) => ({ enabled: true, members: [{ is_self: true }], tailscale: { installed: true, running: true }, ...over }) as never

test('said once, never when the network is off, and the count counts other machines', () => {
  expect(noticeFor(status(), false)?.title).toBe('Your machines can now find each other')
  expect(noticeFor(status({ members: [{ is_self: true }, {}, {}] }), false)?.title).toBe('Your machines are connected (3)')
  expect(noticeFor(status(), true)).toBeNull()
  expect(noticeFor(status({ enabled: false }), false)).toBeNull()
  expect(noticeFor(status({ tailscale: { installed: true, running: false } }), false)?.description).toContain('not running here')
})
test('the flag survives a restart and a missing folder is not an error', () => {
  expect(noticeShown(dir)).toBe(false)
  markNoticeShown(dir)
  expect(noticeShown(dir)).toBe(true)
  expect(noticeShown(path.join(dir, 'nope'))).toBe(false)
})
