import { expect, test } from 'bun:test'
import { BODY_LIMIT, NOTIFICATION_APP_ID, NOTIFICATION_APP_NAME, chooseBackend, createHostBackend, hostPayload, hostReason, isNotificationHost, type NotificationHost } from './notifications.ts'

/** A host that records every call, with a settable status and a way to click. */
function fakeHost(status = 'granted') {
  const calls: unknown[][] = []
  let click: ((error: Error | null, event?: { tag: string; action: string | null }) => void) | null = null
  const host: NotificationHost & { status: string } = {
    status,
    setAppIdentity: (...args) => { calls.push(['identity', ...args]) },
    showSystemNotification: (...args) => { calls.push(['show', ...args]) },
    dismissSystemNotification: (...args) => { calls.push(['dismiss', ...args]) },
    setSystemNotificationCallback: callback => { click = callback; calls.push(['callback', callback ? 'set' : 'cleared']) },
    systemNotificationStatus: async identifier => { calls.push(['status', identifier]); return host.status },
  }
  return { host, calls, click: (tag: string, action: string | null = null) => click?.(null, { tag, action }) }
}

test('each platform is served by one backend, and a missing addon method leaves Windows and Linux unsupported', () => {
  expect(chooseBackend('darwin', false)).toBe('companion')
  expect(chooseBackend('darwin', true)).toBe('companion')
  expect(chooseBackend('win32', true)).toBe('host')
  expect(chooseBackend('linux', true)).toBe('host')
  expect(chooseBackend('win32', false)).toBe('none')
  expect(chooseBackend('linux', false)).toBe('none')
  expect(chooseBackend('aix', true)).toBe('none')
  expect(isNotificationHost(fakeHost().host)).toBe(true)
  expect(isNotificationHost({ ...fakeHost().host, showSystemNotification: undefined })).toBe(false)
  expect(isNotificationHost(null)).toBe(false)
  expect(isNotificationHost({})).toBe(false)
})

test('the payload is keyed by group, cleaned and clipped per platform', () => {
  expect(hostPayload({ id: 'agent:t1:9', title: 'Fix login', body: 'Finished working', group: 't1' }, 'win32')).toEqual({ tag: 't1', title: 'Fix login', body: 'Finished working' })
  // No group: the id is the tag.
  expect(hostPayload({ id: 'settings-test-1', title: 'Kybern', body: 'ok' }, 'linux').tag).toBe('settings-test-1')
  // Linux servers read the body as markup; Windows takes plain text.
  const body = 'Failed: <Error> a & b'
  expect(hostPayload({ id: 'a', title: 't', body }, 'linux').body).toBe('Failed: &lt;Error&gt; a &amp; b')
  expect(hostPayload({ id: 'a', title: 't', body }, 'win32').body).toBe(body)
  // A thread title is one line; control characters go; a long body is cut with an ellipsis.
  expect(hostPayload({ id: 'a', title: 'Two\nlines\u0007 here', body: 'x' }, 'win32').title).toBe('Two lines here')
  const long = hostPayload({ id: 'a', title: 't', body: 'y'.repeat(BODY_LIMIT + 50) }, 'win32').body
  expect([...long]).toHaveLength(BODY_LIMIT)
  expect(long.endsWith('…')).toBe(true)
  expect(hostPayload({ id: 'a', title: 't', body: 'line one\nline two\ttab' }, 'win32').body).toBe('line one\nline two\ttab')
})

test('reasons say what to do per platform', () => {
  expect(hostReason('win32', 'granted')).toBeUndefined()
  expect(hostReason('win32', 'denied')).toMatch(/Windows settings/)
  expect(hostReason('linux', 'unsupported')).toMatch(/org\.freedesktop\.Notifications/)
  expect(hostReason('win32', 'unsupported')).toMatch(/Windows could not show/)
})

test('the first query sets the identity and the click callback, then posts replace per group', async () => {
  const { host, calls, click } = fakeHost()
  const backend = createHostBackend({ host, platform: 'linux' })
  const clicks: string[] = []
  backend.onClick(id => clicks.push(id))
  expect(await backend.requestPermission()).toBe('granted')
  expect(calls.slice(0, 3)).toEqual([['identity', NOTIFICATION_APP_ID, NOTIFICATION_APP_NAME], ['callback', 'set'], ['status', NOTIFICATION_APP_ID]])
  expect(await backend.post({ id: 'agent:t1:1', title: 'Fix login', body: 'Needs approval: run tests', group: 't1' })).toBe(true)
  expect(await backend.post({ id: 'agent:t1:2', title: 'Fix login', body: 'Finished working', group: 't1' })).toBe(true)
  expect(calls.filter(call => call[0] === 'show')).toEqual([
    ['show', 't1', 'Fix login', 'Needs approval: run tests'],
    ['show', 't1', 'Fix login', 'Finished working'],
  ])
  // A click reports the id of the notification that is on screen for that tag, and an unknown tag as itself.
  click('t1')
  click('settings-test-9')
  expect(clicks).toEqual(['agent:t1:2', 'settings-test-9'])
  // The identity is set once however many queries follow.
  expect(calls.filter(call => call[0] === 'identity')).toHaveLength(1)
})

test('status follows the platform and is cached for a few seconds', async () => {
  const { host, calls } = fakeHost('denied')
  let at = 1_000
  const backend = createHostBackend({ host, platform: 'win32', now: () => at })
  expect(await backend.status()).toBe('denied')
  expect(backend.reason).toMatch(/Windows settings/)
  expect(await backend.post({ id: 'a', title: 't', body: 'b' })).toBe(false)
  expect(calls.filter(call => call[0] === 'show')).toHaveLength(0)
  expect(calls.filter(call => call[0] === 'status')).toHaveLength(1)
  // The user turns notifications on; the next query after the cache expires sees it.
  host.status = 'granted'
  expect(await backend.status()).toBe('denied')
  at += 11_000
  expect(await backend.status()).toBe('granted')
  expect(backend.reason).toBeUndefined()
  expect(await backend.post({ id: 'a', title: 't', body: 'b' })).toBe(true)
})

test('no notification daemon, or a failing addon, is unsupported rather than an error', async () => {
  const absent = createHostBackend({ host: fakeHost('unsupported').host, platform: 'linux' })
  expect(await absent.status()).toBe('unsupported')
  expect(absent.reason).toMatch(/No notification service/)
  expect(await absent.post({ id: 'a', title: 't', body: 'b' })).toBe(false)

  const broken = fakeHost()
  broken.host.setAppIdentity = () => { throw new Error('GPUI application is not initialized') }
  const failing = createHostBackend({ host: broken.host, platform: 'win32' })
  expect(await failing.requestPermission()).toBe('unsupported')
  expect(failing.reason).toMatch(/GPUI application is not initialized/)
  expect(await failing.post({ id: 'a', title: 't', body: 'b' })).toBe(false)
  await expect(failing.post({ id: '', title: 't', body: 'b' })).rejects.toThrow(/id must not be empty/)
})
