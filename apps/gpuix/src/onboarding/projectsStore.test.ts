// The Projects store against a fake daemon client: scan notifications fold into rows, selection and the import follow the SPEC.
// The store's client source is swapped for a fake, so no connection is needed (run with KYBERN_GPUIX_NATIVE=npm).
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import type { ScannedProject, SessionsImportJob, SessionsImportProgress, SessionsScan } from '../../../../packages/kybern-client/src/types.ts'

type Handler = (params: unknown) => void
const handlers = new Map<string, Set<Handler>>()
const calls: { method: string; params: unknown }[] = []
let answers: Record<string, (params: unknown) => unknown> = {}
const fake = {
  call: (method: string, params: unknown) => { calls.push({ method, params }); const answer = answers[method]; return answer ? Promise.resolve(answer(params)) : Promise.reject(new Error(`no answer for ${method}`)) },
  onNotification: (method: string, handler: Handler) => { const set = handlers.get(method) ?? new Set(); set.add(handler); handlers.set(method, set); return () => { set.delete(handler) } },
}
const emit = (method: string, params: unknown) => { for (const handler of handlers.get(method) ?? []) handler(params) }

const store = await import('./projectsStore.ts')
const { projectsStore } = store
store.setClientSourceForTests(() => fake as never)

const now = Date.now()
const project = (root: string, over: Partial<ScannedProject> = {}): ScannedProject => ({
  root, name: root.split('/').pop()!, is_git: true, providers: [{ provider: 'claude-code', sessions: 80, imported: 0 }], session_count: 80, imported_count: 0, recent_count: 5,
  last_activity: new Date(now - 60_000).toISOString(), folder_missing: false, suggested: false, ...over,
})
const scan = (projects: ScannedProject[], over: Partial<SessionsScan> = {}): SessionsScan => ({
  scan_id: 's1', state: 'running', started_at: '', providers: [{ provider: 'claude-code', instance: 'default', state: 'scanning', sessions: 3 }], projects, sessions_found: 80, sessions_without_folder: 0, ...over,
})
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

afterAll(() => { store.resetProjects(); store.setClientSourceForTests(null) })

beforeEach(() => {
  store.resetProjects()
  handlers.clear()
  calls.length = 0
  answers = { 'sessions.scan_projects': () => scan([]) }
})

describe('scan', () => {
  test('starts once per run and shows skeletons until rows land', async () => {
    store.startScan()
    store.startScan()
    await flush()
    expect(calls.filter((c) => c.method === 'sessions.scan_projects')).toHaveLength(1)
    expect(projectsStore.get().status).toBe('scanning')
    expect(store.shapeOf(projectsStore.get()).skeleton).toBe(true)
  })

  test('suggested rows arrive pre-checked, others do not, missing folders are only counted', async () => {
    store.startScan()
    await flush()
    emit('sessions.scan.changed', { scan: scan([project('/a', { suggested: true }), project('/b'), project('/gone', { folder_missing: true })]) })
    const s = projectsStore.get()
    expect(s.suggested.map((r) => r.root)).toEqual(['/a'])
    expect(s.others.map((r) => r.root)).toEqual(['/b'])
    expect(s.hidden).toBe(1)
    expect([...s.selected]).toEqual(['/a'])
    expect(s.arrivals['/a']).toBeDefined()
    expect(store.shapeOf(s).skeleton).toBe(false)
  })

  test('a repeated notification keeps the same row objects and does not re-check a box the user cleared', async () => {
    store.startScan()
    await flush()
    emit('sessions.scan.changed', { scan: scan([project('/a', { suggested: true })]) })
    const before = projectsStore.get().suggested
    store.toggleRow('/a')
    emit('sessions.scan.changed', { scan: scan([project('/a', { suggested: true })]) })
    expect(projectsStore.get().suggested).toBe(before)
    expect(projectsStore.get().selected.has('/a')).toBe(false)
  })

  test('a row dropped in above makes the rows below slide', async () => {
    store.startScan()
    await flush()
    emit('sessions.scan.changed', { scan: scan([project('/a', { suggested: true, last_activity: new Date(now - 3_600_000).toISOString() })]) })
    emit('sessions.scan.changed', { scan: scan([project('/a', { suggested: true, last_activity: new Date(now - 3_600_000).toISOString() }), project('/n', { suggested: true })]) })
    const s = projectsStore.get()
    expect(s.suggested.map((r) => r.root)).toEqual(['/n', '/a'])
    expect(s.flips['row:/a']?.dy).toBe(-66)
    expect(s.arrivals['/n']).toBeDefined()
  })

  test('a scan with nothing in it is the empty state', async () => {
    store.startScan()
    await flush()
    emit('sessions.scan.changed', { scan: scan([], { state: 'done', sessions_found: 0 }) })
    expect(store.isEmptyScan(projectsStore.get())).toBe(true)
  })

  test('a failed scan call is reported and Scan again starts a new one', async () => {
    answers = {}
    store.startScan()
    await flush()
    expect(projectsStore.get().status).toBe('failed')
    expect(projectsStore.get().scanError).toContain('no answer')
    answers = { 'sessions.scan_projects': () => scan([project('/a', { suggested: true })], { scan_id: 's2' }) }
    store.rescan()
    await flush()
    expect(projectsStore.get().status).toBe('scanning')
    expect(projectsStore.get().scanId).toBe('s2')
    expect(projectsStore.get().suggested).toHaveLength(1)
  })

  test('cancelScan asks the daemon once it knows the scan', async () => {
    answers = { 'sessions.scan_projects': () => scan([]), 'sessions.scan_cancel': () => scan([], { state: 'canceled' }) }
    store.startScan()
    await flush()
    store.cancelScan()
    expect(calls.some((c) => c.method === 'sessions.scan_cancel' && (c.params as { scan_id: string }).scan_id === 's1')).toBe(true)
  })
})

describe('selection and mode', () => {
  test('Choose a folder adds a checked row at the top of Suggested', async () => {
    store.startScan()
    await flush()
    emit('sessions.scan.changed', { scan: scan([project('/a', { suggested: true })]) })
    store.addFolder('/work/new/')
    const s = projectsStore.get()
    expect(s.suggested.map((r) => r.root)).toEqual(['/work/new', '/a'])
    expect(s.suggested[0]!.added).toBe(true)
    expect(s.selected.has('/work/new')).toBe(true)
    expect(s.topGen).toBe(1)
  })

  test('the mode is not persisted and Select all ticks a whole section', async () => {
    store.startScan()
    await flush()
    emit('sessions.scan.changed', { scan: scan([project('/a', { suggested: true }), project('/b'), project('/c')]) })
    store.setMode('all')
    expect(projectsStore.get().mode).toBe('all')
    expect(projectsStore.get().modeGen).toBe(1)
    store.selectGroup('others', true)
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(projectsStore.get().selected.has('/b')).toBe(true)
    expect(projectsStore.get().selected.has('/c')).toBe(true)
    store.selectGroup('others', false)
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(projectsStore.get().selected.has('/b')).toBe(false)
  })
})

describe('import', () => {
  const job = (over: Partial<SessionsImportJob> = {}): SessionsImportJob => ({ job_id: 'j1', state: 'running', started_at: '', projects: [], imported: 0, already_imported: 0, skipped_count: 0, ...over })
  const event = (over: Partial<SessionsImportProgress> & { root: string }): SessionsImportProgress => ({
    job_id: 'j1', state: 'running', project_id: null, total: 0, done: 0, imported: 0, already_imported: 0, skipped_count: 0, new_thread_ids: [], new_skipped: [], ...over,
  })

  async function ready() {
    store.startScan()
    await flush()
    emit('sessions.scan.changed', { scan: scan([project('/a', { suggested: true, session_count: 323 }), project('/b', { suggested: true, session_count: 43, last_activity: new Date(now - 7_200_000).toISOString() })], { state: 'done' }) })
  }

  test('sends one import_all with the mode’s limit, locks, and walks the summary through the events', async () => {
    answers['sessions.import_all'] = () => job()
    await ready()
    const finished: unknown[] = []
    const stop = store.onImportFinished((s) => finished.push(s))
    store.startImport()
    await flush()
    const call = calls.find((c) => c.method === 'sessions.import_all')!
    expect(call.params).toEqual({ roots: [{ root: '/a', limit: 50 }, { root: '/b', limit: 50 }], scan_id: 's1' })
    expect(projectsStore.get().job?.phase).toBe('running')
    expect(store.getImportSummary()).toMatchObject({ phase: 'running', projects: 2, doneProjects: 0 })

    // Locked: the checkboxes and the mode no longer change.
    store.toggleRow('/a')
    store.setMode('none')
    expect(projectsStore.get().selected.has('/a')).toBe(true)
    expect(projectsStore.get().mode).toBe('latest')

    emit('sessions.import.progress', event({ root: '/a', total: 50, done: 12, imported: 12, project_id: 'k-a', new_skipped: [{ provider: 'codex', session_id: 's', title: 'Big', reason: 'too_large', detail: 'Too large to import.' }] }))
    expect(projectsStore.get().imports['/a']).toMatchObject({ state: 'running', done: 12 })
    expect(store.getImportSummary()).toMatchObject({ recentProjectId: 'k-a', recentProjectName: 'a', names: ['a'] })
    expect(store.getImportSummary().skippedDetails).toEqual([{ project: 'a', title: 'Big', reason: 'too_large', detail: 'Too large to import.' }])
    expect(projectsStore.get().progress).toBeGreaterThan(0)

    emit('sessions.import.progress', event({ root: '/a', state: 'done', total: 50, done: 50, imported: 49, skipped_count: 1 }))
    emit('sessions.import.progress', event({ root: '/b', state: 'done', total: 43, done: 43, imported: 43, project_id: 'k-b' }))
    expect(finished).toHaveLength(0)
    emit('sessions.import.finished', { job: job({ state: 'done', projects: [] }) })
    expect(finished).toHaveLength(1)
    expect(store.getImportSummary()).toMatchObject({ phase: 'done', projects: 2, doneProjects: 2, chats: 92, skipped: 1, names: ['a', 'b'] })
    expect(projectsStore.get().progress).toBe(1)
    stop()
  })

  test('a finished event that beats the reply keeps the job done', async () => {
    let reply: (job: SessionsImportJob) => void = () => {}
    answers['sessions.import_all'] = () => new Promise<SessionsImportJob>((resolve) => { reply = resolve })
    await ready()
    const finished: unknown[] = []
    const stop = store.onImportFinished((s) => finished.push(s))
    store.startImport()
    await flush()
    emit('sessions.import.progress', event({ root: '/a', state: 'done', total: 5, done: 5, imported: 5, project_id: 'k-a' }))
    emit('sessions.import.progress', event({ root: '/b', state: 'done', total: 5, done: 5, imported: 5, project_id: 'k-b' }))
    emit('sessions.import.finished', { job: job({ state: 'done' }) })
    expect(projectsStore.get().job).toEqual({ id: 'j1', phase: 'done' })
    expect(finished).toHaveLength(1)
    // The reply is older than the notification: it describes a job that was still running.
    reply(job({ state: 'running' }))
    await flush()
    expect(projectsStore.get().job).toEqual({ id: 'j1', phase: 'done' })
    expect(store.getImportSummary().phase).toBe('done')
    expect(finished).toHaveLength(1)
    stop()
  })

  test('a running reply only supplies the job id', async () => {
    answers['sessions.import_all'] = () => job({ job_id: 'j9' })
    await ready()
    store.startImport()
    await flush()
    expect(projectsStore.get().job).toEqual({ id: 'j9', phase: 'running' })
    expect(store.getImportSummary().phase).toBe('running')
  })

  test('events for another job are ignored; a failed call unlocks with a message', async () => {
    answers['sessions.import_all'] = () => job()
    await ready()
    store.startImport()
    await flush()
    emit('sessions.import.progress', event({ job_id: 'other', root: '/a', total: 9, done: 9, imported: 9 }))
    expect(projectsStore.get().imports['/a']!.imported).toBe(0)

    store.resetProjects()
    answers = { 'sessions.scan_projects': () => scan([project('/a', { suggested: true })]) }
    store.startScan()
    await flush()
    delete answers['sessions.import_all']
    store.startImport()
    await flush()
    expect(projectsStore.get().job).toBeNull()
    expect(projectsStore.get().importError).toContain('Couldn’t start the import')
    expect(store.getImportSummary().phase).toBe('none')
  })

  test('Don’t import chats asks for limit 0 and an added folder always does', async () => {
    answers['sessions.import_all'] = () => job()
    await ready()
    store.addFolder('/work/mine')
    store.setMode('none')
    store.startImport()
    await flush()
    const call = calls.find((c) => c.method === 'sessions.import_all')!
    expect((call.params as { roots: { root: string; limit: number }[] }).roots.map((r) => [r.root, r.limit])).toEqual([['/work/mine', 0], ['/a', 0], ['/b', 0]])
    expect(store.getImportSummary().mode).toBe('none')
  })

  test('nothing checked starts no import', async () => {
    await ready()
    store.selectGroup('suggested', false)
    await new Promise((resolve) => setTimeout(resolve, 80))
    store.startImport()
    expect(calls.some((c) => c.method === 'sessions.import_all')).toBe(false)
    expect(projectsStore.get().job).toBeNull()
  })
})
