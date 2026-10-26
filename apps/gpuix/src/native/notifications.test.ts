import { expect, test } from 'bun:test'
import { BODY_LIMIT, NOTIFICATION_APP_ID, NOTIFICATION_APP_NAME, QUIET_REPLACE_MS, chooseBackend, createHostBackend, hostPayload, hostReason, isNotificationHost, notificationIdentity, parseHostStatus, setEarlyAppIdentity, type NotificationHost } from './notifications.ts'

/** A host that records every call, with a settable status and a way to click. */
const BASE = { id: NOTIFICATION_APP_ID, name: NOTIFICATION_APP_NAME }
function fakeHost(status: string | { status: string; markup?: boolean | null } = 'granted') {
  const calls: unknown[][] = []
  let click: ((error: Error | null, event?: { tag: string; action: string | null }) => void) | null = null
  const host: NotificationHost & { status: string | { status: string; markup?: boolean | null } } = {
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
  const backend = createHostBackend({ host, platform: 'linux', identity: BASE })
  const clicks: string[] = []
  backend.onClick(id => clicks.push(id))
  expect(await backend.requestPermission()).toBe('granted')
  expect(calls.slice(0, 3)).toEqual([['identity', NOTIFICATION_APP_ID, NOTIFICATION_APP_NAME], ['callback', 'set'], ['status', NOTIFICATION_APP_ID]])
  expect(await backend.post({ id: 'agent:t1:1', title: 'Fix login', body: 'Needs approval: run tests', group: 't1' })).toBe(true)
  expect(await backend.post({ id: 'agent:t1:2', title: 'Fix login', body: 'Finished working', group: 't1' })).toBe(true)
  expect(calls.filter(call => call[0] === 'show')).toEqual([
    ['show', 't1', 'Fix login', 'Needs approval: run tests', false],
    // The second post for the thread comes right after the first: it replaces it without a sound.
    ['show', 't1', 'Fix login', 'Finished working', true],
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
  const backend = createHostBackend({ host, platform: 'win32', identity: BASE, now: () => at })
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
  const absent = createHostBackend({ host: fakeHost('unsupported').host, platform: 'linux', identity: BASE })
  expect(await absent.status()).toBe('unsupported')
  expect(absent.reason).toMatch(/No notification service/)
  expect(await absent.post({ id: 'a', title: 't', body: 'b' })).toBe(false)

  const broken = fakeHost()
  broken.host.setAppIdentity = () => { throw new Error('GPUI application is not initialized') }
  const failing = createHostBackend({ host: broken.host, platform: 'win32', identity: BASE })
  expect(await failing.requestPermission()).toBe('unsupported')
  expect(failing.reason).toMatch(/GPUI application is not initialized/)
  expect(await failing.post({ id: 'a', title: 't', body: 'b' })).toBe(false)
  await expect(failing.post({ id: '', title: 't', body: 'b' })).rejects.toThrow(/id must not be empty/)
})

test('a replacement soon after the last post is silent, a later one is not, and a dismissed thread starts over', async () => {
  const { host, calls } = fakeHost()
  let at = 1_000_000
  const backend = createHostBackend({ host, platform: 'win32', identity: BASE, now: () => at })
  const post = (group: string) => backend.post({ id: `agent:${group}:${at}`, title: 't', body: 'b', group })
  const shows = () => calls.filter(call => call[0] === 'show').map(call => call[4])
  await post('t1')
  await post('t2')
  at += QUIET_REPLACE_MS - 1
  await post('t1')
  at += QUIET_REPLACE_MS
  await post('t1')
  expect(shows()).toEqual([false, false, true, false])
  // Withdrawn, the thread's next notification is a new one and plays its sound.
  at += 1
  await backend.dismiss('t1')
  await post('t1')
  expect(shows().at(-1)).toBe(false)
  expect(calls.filter(call => call[0] === 'dismiss')).toEqual([['dismiss', 't1']])
})

test('dismiss does nothing before the backend has started, and a group is dismissed by its tag', async () => {
  const { host, calls } = fakeHost()
  const backend = createHostBackend({ host, platform: 'linux', identity: BASE })
  await backend.dismiss('t1')
  expect(calls).toEqual([])
  await backend.post({ id: 'agent:t1:1', title: 't', body: 'b', group: 't1' })
  await backend.dismiss('t1')
  await backend.post({ id: 'solo-1', title: 't', body: 'b' })
  await backend.dismiss('solo-1')
  expect(calls.filter(call => call[0] === 'dismiss')).toEqual([['dismiss', 't1'], ['dismiss', 'solo-1']])
})

test('a body is escaped only for a server that reads markup', async () => {
  const body = 'Failed: <Error> a & b'
  const note = { id: 'a', title: 't', body }
  expect(hostPayload(note, 'linux', true).body).toBe('Failed: &lt;Error&gt; a &amp; b')
  // The server could not say: escape, as before.
  expect(hostPayload(note, 'linux', null).body).toBe('Failed: &lt;Error&gt; a &amp; b')
  expect(hostPayload(note, 'linux').body).toBe('Failed: &lt;Error&gt; a &amp; b')
  // A server without `body-markup` would print the entities.
  expect(hostPayload(note, 'linux', false).body).toBe(body)
  const plain = fakeHost({ status: 'granted', markup: false })
  const backend = createHostBackend({ host: plain.host, platform: 'linux', identity: BASE })
  await backend.post({ id: 'a', title: 't', body })
  expect(plain.calls.find(call => call[0] === 'show')?.[3]).toBe(body)
  // An addon that returns only the status name keeps the escaping.
  const old = fakeHost('granted')
  await createHostBackend({ host: old.host, platform: 'linux', identity: BASE }).post({ id: 'a', title: 't', body })
  expect(old.calls.find(call => call[0] === 'show')?.[3]).toBe('Failed: &lt;Error&gt; a &amp; b')
  // The addon resolves the object as JSON text.
  expect(parseHostStatus('{"status":"granted","markup":true}')).toEqual({ status: 'granted', markup: true })
  expect(parseHostStatus('{"status":"unsupported","markup":null}')).toEqual({ status: 'unsupported', markup: null })
  expect(parseHostStatus('granted')).toEqual({ status: 'granted', markup: null })
  expect(parseHostStatus('{not json')).toEqual({ status: '{not json', markup: null })
  expect(parseHostStatus({ status: 'denied' })).toEqual({ status: 'denied', markup: null })
  const json = fakeHost('{"status":"granted","markup":false}')
  await createHostBackend({ host: json.host, platform: 'linux', identity: BASE }).post({ id: 'a', title: 't', body })
  expect(json.calls.find(call => call[0] === 'show')?.[3]).toBe(body)
  // The status can come as the object, with the same meaning as the bare name.
  expect(await createHostBackend({ host: fakeHost({ status: 'denied' }).host, platform: 'win32', identity: BASE }).status()).toBe('denied')
})

test('a click on a post older than the remembered ones reports its tag', async () => {
  const { host, click } = fakeHost()
  const backend = createHostBackend({ host, platform: 'linux', identity: BASE })
  const clicks: string[] = []
  backend.onClick(id => clicks.push(id))
  await backend.requestPermission()
  for (let index = 0; index < 300; index++) await backend.post({ id: `agent:t${index}:1`, title: 't', body: 'b', group: `t${index}` })
  click('t0')
  click('t299')
  expect(clicks).toEqual(['t0', 'agent:t299:1'])
})

test('an installed Windows copy owns the app id; a loose one posts under its own', () => {
  expect(notificationIdentity('win32', true)).toEqual({ id: 'dev.kybern.gpuix', name: 'Kybern' })
  expect(notificationIdentity('win32', false)).toEqual({ id: 'dev.kybern.gpuix.dev', name: 'Kybern (dev)' })
  // Linux names the desktop entry and the icon: the one id.
  expect(notificationIdentity('linux', false)).toEqual({ id: 'dev.kybern.gpuix', name: 'Kybern' })
  expect(notificationIdentity('darwin', false).id).toBe('dev.kybern.gpuix')
})

test('the early identity needs an addon that has it', () => {
  const saved = process.env.NAPI_RS_NATIVE_LIBRARY_PATH
  try {
    delete process.env.NAPI_RS_NATIVE_LIBRARY_PATH
    expect(setEarlyAppIdentity({ id: 'x', name: 'X' }, 'linux')).toBe(false)
    process.env.NAPI_RS_NATIVE_LIBRARY_PATH = '/nonexistent/addon.node'
    expect(setEarlyAppIdentity({ id: 'x', name: 'X' }, 'linux')).toBe(false)
    expect(setEarlyAppIdentity({ id: 'x', name: 'X' }, 'darwin')).toBe(false)
  } finally {
    if (saved === undefined) delete process.env.NAPI_RS_NATIVE_LIBRARY_PATH; else process.env.NAPI_RS_NATIVE_LIBRARY_PATH = saved
  }
})

test('concurrent first queries probe the service once', async () => {
  const { host, calls } = fakeHost({ status: 'granted', markup: true })
  const backend = createHostBackend({ host, platform: 'linux', identity: BASE })
  const answers = await Promise.all([backend.status(), backend.requestPermission(), backend.post({ id: 'a', title: 't', body: 'b' })])
  expect(answers.slice(0, 2)).toEqual(['granted', 'granted'])
  expect(calls.filter(call => call[0] === 'status')).toHaveLength(1)
})
