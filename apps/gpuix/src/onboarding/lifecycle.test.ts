// The first run follows its connection: a new environment starts over, and ending the flow stops a scan nobody reads.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import type { SessionsScan } from '../../../../packages/kybern-client/src/types.ts'

const calls: string[] = []
const scan = (state: 'running' | 'done'): SessionsScan => ({ scan_id: 's1', state, started_at: '', providers: [], projects: [], sessions_found: 0, sessions_without_folder: 0 })
const fake = {
  call: (method: string) => { calls.push(method); return Promise.resolve(method === 'sessions.scan_projects' ? scan('running') : scan('done')) },
  onNotification: () => () => {},
}

const projects = await import('./projectsStore.ts')
const { flow, openFlow, goFrom, finishFlow } = await import('./flow.ts')
const { resetOnboarding } = await import('./lifecycle.ts')
const { agents, openPopover } = await import('./agentsStore.ts')
projects.setClientSourceForTests(() => fake as never)
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => { resetOnboarding(); calls.length = 0 })
afterAll(() => { resetOnboarding(); projects.setClientSourceForTests(null) })

describe('environment change', () => {
  test('the flow, the scan and the agents start over', async () => {
    openFlow()
    goFrom('hero', 'agents')
    projects.startScan()
    await flush()
    openPopover('codex')
    expect(projects.projectsStore.get().started).toBe(true)
    resetOnboarding()
    expect(flow.get()).toMatchObject({ open: false, scene: 'hero', finished: false })
    expect(projects.projectsStore.get().started).toBe(false)
    expect(agents.get().popover).toBeNull()
  })
})

describe('leaving the flow', () => {
  test('Set up later cancels a scan that is still running', async () => {
    openFlow()
    projects.startScan()
    await flush()
    expect(projects.projectsStore.get().status).toBe('scanning')
    finishFlow('later', null)
    await flush()
    expect(calls).toContain('sessions.scan_cancel')
    expect(projects.projectsStore.get().status).toBe('done')
  })
})
