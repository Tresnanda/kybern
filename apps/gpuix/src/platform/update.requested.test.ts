// The update this machine was asked for (ADE-125): installed without asking, restarted only once nothing runs, and
// reported back to the daemon at each step.
import { expect, test } from 'bun:test'
import { activityIdle, IDLE_POLL_MS, RESTART_NOTICE_MS, runRequestedUpdate, takeUpdateRequests, type RequestedUpdateDeps } from './update.ts'
import { APP_UPDATE_REQUESTED_NOTIFICATION, type AppUpdaterReportParams } from '../../../../packages/kybern-client/src/types.ts'

const release = { version: '0.21.4', notes: null, entry: { url: 'https://example/gpuix.app.tar.gz', signature: 's' } }

/** A run where the machine is idle according to `idle` (one answer per look) and every step is recorded. */
function harness(idle: boolean[], overrides: Partial<RequestedUpdateDeps> = {}) {
  const log: string[] = []
  const reports: AppUpdaterReportParams[] = []
  const deps: RequestedUpdateDeps = {
    check: async () => release,
    prepare: async () => { log.push('prepare'); return async () => { log.push('apply') } },
    idle: async () => { const answer = idle.shift() ?? true; log.push(answer ? 'idle' : 'busy'); return answer },
    report: async (params) => { reports.push(params); log.push(`report:${params.phase}`) },
    notice: async (version) => { log.push(`notice:${version}`); return () => log.push('hide') },
    sleep: async (ms) => { log.push(`sleep:${ms}`) },
    ...overrides,
  }
  return { deps, log, reports }
}

test('an idle machine installs at once and restarts after the notice', async () => {
  const { deps, log, reports } = harness([true, true])
  expect(await runRequestedUpdate(deps)).toBe('restarted')
  expect(log).toEqual(['report:installing', 'prepare', 'idle', 'notice:0.21.4', `sleep:${RESTART_NOTICE_MS}`, 'idle', 'report:restarting', 'apply'])
  expect(reports.map(report => report.version)).toEqual(['0.21.4', '0.21.4'])
})

test('it never restarts while work runs, and looks again after the notice', async () => {
  // Busy, then idle long enough for the notice, but work starts during it: the notice goes and it waits again.
  const { deps, log } = harness([false, true, false, true, true])
  expect(await runRequestedUpdate(deps)).toBe('restarted')
  expect(log).toEqual([
    'report:installing', 'prepare',
    'busy', 'report:waiting', `sleep:${IDLE_POLL_MS}`,
    'idle', 'notice:0.21.4', `sleep:${RESTART_NOTICE_MS}`, 'busy', 'hide', `sleep:${IDLE_POLL_MS}`,
    'idle', 'notice:0.21.4', `sleep:${RESTART_NOTICE_MS}`, 'idle',
    'report:restarting', 'apply',
  ])
  expect(log.filter(entry => entry === 'report:waiting')).toHaveLength(1)
})

test('nothing newer, a failed check or a refused download end the request and say so', async () => {
  const current = harness([], { check: async () => null })
  expect(await runRequestedUpdate(current.deps)).toBe('current')
  expect(current.log).toEqual(['report:current'])

  const offline = harness([], { check: async () => { throw Error('fetch failed') } })
  expect(await runRequestedUpdate(offline.deps)).toBe('failed')
  expect(offline.reports[0]?.phase).toBe('failed')

  const tampered = harness([], { prepare: async () => { throw Error('The update signature does not match the download') } })
  expect(await runRequestedUpdate(tampered.deps)).toBe('failed')
  expect(tampered.reports.at(-1)).toEqual({ phase: 'failed', message: 'The update signature does not match the download' })
  expect(tampered.log).not.toContain('apply')
  expect(tampered.log).not.toContain('notice:0.21.4')
})

test('idle means no turn, agent, background work or queued message', () => {
  const quiet = { running_threads: 0, live_sessions: 2, idle_sessions: 2, queued_messages: 0 }
  expect(activityIdle(quiet)).toBe(true)
  expect(activityIdle({ ...quiet, running_threads: 1 })).toBe(false)
  expect(activityIdle({ ...quiet, idle_sessions: 1 })).toBe(false)
  expect(activityIdle({ ...quiet, queued_messages: 1 })).toBe(false)
})

test('a window attaches on every connection and listens once', async () => {
  const calls: Array<[string, unknown]> = []
  const listeners: string[] = []
  const client = {
    call: async (method: string, params: unknown) => { calls.push([method, params]); return {} },
    onNotification: (name: string) => { listeners.push(name); return () => {} },
  } as unknown as Parameters<typeof takeUpdateRequests>[0]
  await takeUpdateRequests(client)
  await takeUpdateRequests(client)
  expect(listeners).toEqual([APP_UPDATE_REQUESTED_NOTIFICATION])
  expect(calls.map(([method]) => method)).toEqual(['app_updater.attach', 'app_updater.attach'])
  // A test run is no installed app: it attaches, saying why it cannot install.
  expect(calls[0]![1]).toMatchObject({ can_install: false })
  // An older daemon without the method is no error.
  const old = { ...client, call: async () => { throw Error('Method not found') } } as unknown as Parameters<typeof takeUpdateRequests>[0]
  await takeUpdateRequests(old)
})
