import { describe, expect, test } from 'bun:test'
import type { ScanProviderStatus, ScannedProject, SessionsImportJob, SessionsImportProgress } from '../../../../packages/kybern-client/src/types.ts'
import {
  addedRow, ageLabel, ageLine, appendSkips, applyJob, applyProgress, chatsFor, chipsFor, countLine, ctaLabel, displayPath, entriesFor, failureLine, flipDeltas, hiddenNote,
  importLine, importRoots, newSuggested, overallProgress, reconcileRows, rowEqual, splitRows, staggerDelay, startImports, summarize, toRequestRoot, totalLabel, totals, wave,
  ROW_SLOT, type Row,
} from './projects.ts'

const NOW = new Date(2026, 9, 27, 15, 0, 0).getTime()
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000

const project = (over: Partial<ScannedProject> & { root: string }): ScannedProject => ({
  name: over.root.split('/').pop()!, is_git: true, providers: [{ provider: 'claude-code', sessions: over.session_count ?? 10, imported: 0 }], session_count: 10, imported_count: 0,
  recent_count: 5, last_activity: ago(HOUR), folder_missing: false, suggested: false, ...over,
})

describe('rows', () => {
  test('missing folders are counted and hidden; suggested and other rows are separate and newest first', () => {
    const split = splitRows([
      project({ root: '/a/old', suggested: true, last_activity: ago(3 * DAY) }),
      project({ root: '/a/new', suggested: true, last_activity: ago(MIN) }),
      project({ root: '/a/other-b', last_activity: ago(2 * HOUR) }),
      project({ root: '/a/other-a', last_activity: ago(HOUR) }),
      project({ root: '/gone/1', folder_missing: true }),
      project({ root: '/gone/2', folder_missing: true, suggested: true }),
    ])
    expect(split.suggested.map((r) => r.name)).toEqual(['new', 'old'])
    expect(split.others.map((r) => r.name)).toEqual(['other-a', 'other-b'])
    expect(split.hidden).toBe(2)
  })

  test('equal activity keeps a stable order by name', () => {
    const when = ago(HOUR)
    const a = splitRows([project({ root: '/x/b', last_activity: when }), project({ root: '/x/a', last_activity: when })])
    const b = splitRows([project({ root: '/x/a', last_activity: when }), project({ root: '/x/b', last_activity: when })])
    expect(a.others.map((r) => r.name)).toEqual(['a', 'b'])
    expect(b.others.map((r) => r.name)).toEqual(['a', 'b'])
  })

  test('a root the daemon returns twice is listed once with its counts folded together', () => {
    const split = splitRows([
      project({ root: '/r/ade', session_count: 30, suggested: true, providers: [{ provider: 'claude-code', sessions: 30, imported: 0 }] }),
      project({ root: '/r/ade', session_count: 12, providers: [{ provider: 'claude-code', sessions: 5, imported: 0 }, { provider: 'codex', sessions: 7, imported: 0 }] }),
    ])
    expect(split.suggested).toHaveLength(1)
    expect(split.suggested[0]!.session_count).toBe(42)
    expect(split.suggested[0]!.providers.find((p) => p.provider === 'claude-code')!.sessions).toBe(35)
    expect(split.suggested[0]!.providers.find((p) => p.provider === 'codex')!.sessions).toBe(7)
  })

  test('a folder the user added leads Suggested, newest first, unless the scan has it', () => {
    const mine = addedRow('/work/mine', NOW)
    const theirs = addedRow('/r/ade', NOW)
    const split = splitRows([project({ root: '/r/ade', suggested: true })], [mine, theirs])
    expect(split.suggested.map((r) => r.root)).toEqual(['/work/mine', '/r/ade'])
    expect(split.suggested[1]!.added).toBeUndefined()
  })

  test('suggested roots are pre-checked once, when first seen', () => {
    const first = splitRows([project({ root: '/a', suggested: true }), project({ root: '/b', suggested: true })])
    const one = newSuggested(new Set(), first.suggested)
    expect(one.fresh.sort()).toEqual(['/a', '/b'])
    const second = splitRows([project({ root: '/a', suggested: true }), project({ root: '/b', suggested: true }), project({ root: '/c', suggested: true })])
    const two = newSuggested(one.seen, second.suggested)
    expect(two.fresh).toEqual(['/c'])
    expect(newSuggested(two.seen, second.suggested).fresh).toEqual([])
  })

  test('displayPath makes the home folder a tilde', () => {
    expect(displayPath('/Users/ada/projects/ade')).toBe('~/projects/ade')
    expect(displayPath('/home/ada/code')).toBe('~/code')
    expect(displayPath('/root')).toBe('~')
    expect(displayPath('C:\\Users\\ada\\src\\kybern')).toBe('~\\src\\kybern')
    expect(displayPath('/opt/work/app')).toBe('/opt/work/app')
  })
})

describe('reconcile', () => {
  test('a rescan that changed nothing keeps every object and the array', () => {
    const prev = splitRows([project({ root: '/a', suggested: true }), project({ root: '/b', suggested: true })]).suggested
    const next = splitRows([project({ root: '/a', suggested: true }), project({ root: '/b', suggested: true })]).suggested
    expect(next[0]).not.toBe(prev[0])
    expect(reconcileRows(prev, next)).toBe(prev)
  })

  test('only the row that changed is a new object', () => {
    const prev = splitRows([project({ root: '/a', suggested: true }), project({ root: '/b', suggested: true })]).suggested
    const next = splitRows([project({ root: '/a', suggested: true, session_count: 99 }), project({ root: '/b', suggested: true })]).suggested
    const out = reconcileRows(prev, next)
    expect(out).not.toBe(prev)
    expect(out.find((r) => r.root === '/b')).toBe(prev.find((r) => r.root === '/b'))
    expect(out.find((r) => r.root === '/a')!.session_count).toBe(99)
    expect(rowEqual(out[0]!, prev[0]!)).toBe(out[0] === prev[0])
  })
})

describe('count lines per mode', () => {
  const big = project({ root: '/big', session_count: 323 })
  const small = project({ root: '/small', session_count: 43 })
  const exactly = project({ root: '/fifty', session_count: 50 })
  const one = project({ root: '/one', session_count: 1 })
  test('Latest 50', () => {
    expect(countLine(big, 'latest')).toBe('Last 50 of 323')
    expect(countLine(small, 'latest')).toBe('43 chats')
    expect(countLine(exactly, 'latest')).toBe('50 chats')
    expect(countLine(one, 'latest')).toBe('1 chat')
  })
  test('All chats', () => {
    expect(countLine(big, 'all')).toBe('323 chats')
    expect(countLine(project({ root: '/k', session_count: 1662 }), 'all')).toBe('1,662 chats')
  })
  test('Don’t import chats', () => expect(countLine(big, 'none')).toBe('Project only'))
  test('an added folder has no past chats', () => {
    expect(countLine(addedRow('/x', NOW), 'latest')).toBe('No past chats')
    expect(chatsFor(addedRow('/x', NOW), 'all')).toBe(0)
    expect(ageLine(addedRow('/x', NOW), NOW)).toBe('Just added')
  })
  test('chats per mode', () => {
    expect(chatsFor(big, 'latest')).toBe(50)
    expect(chatsFor(small, 'latest')).toBe(43)
    expect(chatsFor(big, 'all')).toBe(323)
    expect(chatsFor(big, 'none')).toBe(0)
  })
})

describe('totals and the primary label', () => {
  const rows: Row[] = [project({ root: '/a', session_count: 323 }), project({ root: '/b', session_count: 43 }), project({ root: '/c', session_count: 10 })]
  test('totals count only the checked rows through the mode', () => {
    const picked = new Set(['/a', '/b'])
    expect(totals(rows, picked, 'latest')).toEqual({ projects: 2, chats: 93 })
    expect(totals(rows, picked, 'all')).toEqual({ projects: 2, chats: 366 })
    expect(totals(rows, picked, 'none')).toEqual({ projects: 2, chats: 0 })
    expect(totals(rows, new Set(), 'all')).toEqual({ projects: 0, chats: 0 })
  })
  test('the toolbar total', () => {
    expect(totalLabel({ projects: 0, chats: 0 }, 'latest')).toEqual({ kind: 'none' })
    expect(totalLabel({ projects: 2, chats: 0 }, 'none')).toEqual({ kind: 'projects-only' })
    expect(totalLabel({ projects: 2, chats: 321 }, 'latest')).toEqual({ kind: 'chats', chats: 321, noun: 'chats' })
    expect(totalLabel({ projects: 1, chats: 1 }, 'all')).toEqual({ kind: 'chats', chats: 1, noun: 'chat' })
  })
  test('the import label by mode', () => {
    expect(ctaLabel('latest', 8, false).text).toBe('Import 8 projects')
    expect(ctaLabel('all', 1, false).text).toBe('Import 1 project')
    expect(ctaLabel('none', 8, false).text).toBe('Add 8 projects')
    expect(ctaLabel('none', 1, false).text).toBe('Add 1 project')
    expect(ctaLabel('latest', 0, false)).toEqual({ kind: 'skip', text: 'Continue without importing' })
    expect(ctaLabel('latest', 8, true)).toEqual({ kind: 'continue', text: 'Continue' })
  })
  test('the hidden note pluralizes', () => {
    expect(hiddenNote(700)).toBe('700 projects whose folders no longer exist are hidden.')
    expect(hiddenNote(1)).toBe('1 project whose folder no longer exists is hidden.')
  })
})

describe('age', () => {
  test('relative strings', () => {
    expect(ageLabel(ago(10_000), NOW)).toBe('Just now')
    expect(ageLabel(ago(12 * MIN), NOW)).toBe('12m ago')
    expect(ageLabel(ago(3 * HOUR), NOW)).toBe('3h ago')
    expect(ageLabel(new Date(2026, 9, 26, 11, 0).toISOString(), NOW)).toBe('Yesterday')
    expect(ageLabel(new Date(2026, 9, 24, 9, 0).toISOString(), NOW)).toBe('3d ago')
    expect(ageLabel(new Date(2026, 9, 13, 9, 0).toISOString(), NOW)).toBe('2w ago')
    expect(ageLabel(new Date(2026, 6, 1, 9, 0).toISOString(), NOW)).toBe('3mo ago')
    expect(ageLabel(new Date(2024, 9, 1, 9, 0).toISOString(), NOW)).toBe('2y ago')
  })
  test('a clock in the future and a bad date are harmless', () => {
    expect(ageLabel(new Date(NOW + HOUR).toISOString(), NOW)).toBe('Just now')
    expect(ageLabel('nope', NOW)).toBe('')
  })
})

describe('harness chips', () => {
  const status = (over: Partial<ScanProviderStatus> & Pick<ScanProviderStatus, 'provider'>): ScanProviderStatus => ({ instance: 'default', state: 'done', sessions: 0, ...over })
  test('one chip per harness, in provider order, accounts summed', () => {
    const { chips } = chipsFor([
      status({ provider: 'codex', sessions: 492 }),
      status({ provider: 'claude-code', sessions: 800 }),
      status({ provider: 'claude-code', instance: 'work', sessions: 67 }),
    ])
    expect(chips.map((c) => [c.provider, c.sessions, c.state])).toEqual([['claude-code', 867, 'done'], ['codex', 492, 'done']])
  })
  test('scanning wins over done; unavailable harnesses fold into one list', () => {
    const out = chipsFor([status({ provider: 'claude-code', state: 'scanning', sessions: 3 }), status({ provider: 'cursor', state: 'unavailable', error: 'not found' }), status({ provider: 'pi', state: 'pending' })])
    expect(out.chips.map((c) => [c.provider, c.state])).toEqual([['claude-code', 'scanning'], ['pi', 'scanning']])
    expect(out.missing).toEqual([{ provider: 'cursor', name: 'Cursor', error: 'not found' }])
  })
  test('a failed harness keeps its error for the tooltip and names itself in the line', () => {
    const out = chipsFor([status({ provider: 'codex', state: 'failed', error: 'timed out' }), status({ provider: 'claude-code' })])
    expect(out.failed).toHaveLength(1)
    expect(out.failed[0]!.error).toBe('timed out')
    expect(failureLine(out.failed)).toBe('Codex history couldn’t be read.')
    expect(failureLine([{ name: 'Codex' }, { name: 'Cursor' }])).toBe('Codex and Cursor histories couldn’t be read.')
    expect(failureLine([])).toBe('')
  })
})

describe('list layout', () => {
  const shape = (over = {}) => ({ suggested: ['/a', '/b'], others: ['/c', '/d', '/e'], othersOpen: false, hidden: 0, skeleton: false, ...over })
  test('three skeletons until rows land', () => {
    expect(entriesFor(shape({ suggested: [], others: [], skeleton: true })).map((e) => e.kind)).toEqual(['skeleton', 'skeleton', 'skeleton'])
  })
  test('Other projects is closed behind its header', () => {
    expect(entriesFor(shape()).map((e) => e.key)).toEqual(['head:suggested', 'row:/a', 'row:/b', 'head:others', 'tail'])
    expect(entriesFor(shape({ othersOpen: true, hidden: 4 })).map((e) => e.key)).toEqual(['head:suggested', 'row:/a', 'row:/b', 'head:others', 'row:/c', 'row:/d', 'row:/e', 'note', 'tail'])
  })
  test('with nothing suggested the other projects open by themselves', () => {
    expect(entriesFor(shape({ suggested: [] })).map((e) => e.key)).toEqual(['head:others', 'row:/c', 'row:/d', 'row:/e', 'tail'])
  })
  test('a new row makes room: the rows below were higher', () => {
    const before = entriesFor(shape({ suggested: ['/a', '/b'], othersOpen: true }))
    const after = entriesFor(shape({ suggested: ['/n', '/a', '/b'], othersOpen: true }))
    const deltas = flipDeltas(before, after)
    expect(deltas['row:/a']).toBe(-ROW_SLOT)
    expect(deltas['row:/b']).toBe(-ROW_SLOT)
    expect(deltas['row:/c']).toBe(-ROW_SLOT)
    expect(deltas['row:/n']).toBeUndefined()
  })
  test('a row dropped in place above only moves the rows under it', () => {
    const before = entriesFor(shape({ suggested: ['/a', '/b'] }))
    const after = entriesFor(shape({ suggested: ['/a', '/n', '/b'] }))
    const deltas = flipDeltas(before, after)
    expect(deltas['row:/a']).toBeUndefined()
    expect(deltas['row:/b']).toBe(-ROW_SLOT)
  })
  test('stagger and wave are capped', () => {
    expect(staggerDelay(0)).toBe(0)
    expect(staggerDelay(3)).toBeCloseTo(0.084)
    expect(staggerDelay(100)).toBeCloseTo(0.336)
    const w = wave(Array.from({ length: 40 }, (_, i) => `/r${i}`))
    expect(w[0]!.at).toBe(0)
    expect(w[3]!.at).toBe(105)
    expect(w[39]!.at).toBe(560)
  })
})

describe('import', () => {
  const rows: Row[] = [
    project({ root: '/old', name: 'old', session_count: 323, last_activity: ago(3 * DAY), project_id: 'p-old' }),
    project({ root: '/new', name: 'new', session_count: 43, last_activity: ago(MIN) }),
    addedRow('/mine', NOW),
    project({ root: '/skip', name: 'skip', session_count: 9 }),
  ]
  const picked = new Set(['/old', '/new', '/mine'])

  test('the limit per root follows the mode, newest first; an added folder is always 0', () => {
    const latest = importRoots(rows, picked, 'latest')
    expect(latest.map((p) => [p.root, p.limit, p.expected])).toEqual([['/mine', 0, 0], ['/new', 50, 43], ['/old', 50, 50]])
    expect(importRoots(rows, picked, 'all').map((p) => [p.root, p.limit, p.expected])).toEqual([['/mine', 0, 0], ['/new', null, 43], ['/old', null, 323]])
    expect(importRoots(rows, picked, 'none').map((p) => [p.root, p.limit, p.expected])).toEqual([['/mine', 0, 0], ['/new', 0, 0], ['/old', 0, 0]])
  })
  test('the request keeps a known project id and caps the count', () => {
    const plan = importRoots(rows, picked, 'all')
    expect(toRequestRoot(plan.find((p) => p.root === '/old')!)).toEqual({ root: '/old', project_id: 'p-old', limit: null })
    expect(toRequestRoot(plan.find((p) => p.root === '/new')!)).toEqual({ root: '/new', limit: null })
    const many = Array.from({ length: 600 }, (_, i) => project({ root: `/m/${i}`, last_activity: ago(i * MIN) }))
    expect(importRoots(many, new Set(many.map((r) => r.root)), 'latest')).toHaveLength(500)
  })

  const event = (over: Partial<SessionsImportProgress> & { root: string }): SessionsImportProgress => ({
    job_id: 'j', state: 'running', project_id: null, total: 0, done: 0, imported: 0, already_imported: 0, skipped_count: 0, new_thread_ids: [], new_skipped: [], ...over,
  })

  test('per-row lines from progress events', () => {
    const plan = importRoots(rows, picked, 'latest')
    let imports = startImports(plan)
    expect(importLine(imports['/old']!)).toEqual({ kind: 'waiting', text: 'Waiting', fraction: 0 })
    imports = applyProgress(imports, event({ root: '/old', total: 50, done: 12, imported: 12, project_id: 'k-old' }))
    expect(importLine(imports['/old']!)).toEqual({ kind: 'running', text: 'Importing 12 of 50', fraction: 12 / 50 })
    imports = applyProgress(imports, event({ root: '/old', state: 'done', total: 50, done: 50, imported: 49, skipped_count: 1 }))
    expect(importLine(imports['/old']!).text).toBe('49 imported · 1 skipped')
    imports = applyProgress(imports, event({ root: '/new', state: 'done', total: 43, done: 43, imported: 43 }))
    expect(importLine(imports['/new']!).text).toBe('43 imported')
    imports = applyProgress(imports, event({ root: '/mine', state: 'done', total: 0, done: 0 }))
    expect(importLine(imports['/mine']!)).toEqual({ kind: 'done', text: 'Added', fraction: 1 })
    imports = applyProgress(imports, event({ root: '/new', state: 'failed', error: 'no folder' }))
    expect(importLine(imports['/new']!).kind).toBe('failed')
    expect(applyProgress(imports, event({ root: '/unknown' }))).toBe(imports)
  })

  test('already imported chats are said, not hidden', () => {
    const imports = applyProgress(startImports([{ root: '/a', limit: 50, expected: 10, name: 'a' }]), event({ root: '/a', state: 'done', total: 10, done: 10, already_imported: 10 }))
    expect(importLine(imports['/a']!).text).toBe('10 already imported')
  })

  test('overall progress is in chats', () => {
    let imports = startImports(importRoots(rows, picked, 'latest'))
    // expected 0 + 43 + 50 (the added folder counts as one unit): 94
    expect(overallProgress(imports)).toBe(0)
    imports = applyProgress(imports, event({ root: '/mine', state: 'done' }))
    imports = applyProgress(imports, event({ root: '/new', state: 'running', total: 43, done: 43 }))
    expect(overallProgress(imports)).toBeCloseTo(44 / 94)
    imports = applyProgress(imports, event({ root: '/new', state: 'done', total: 43, done: 43 }))
    imports = applyProgress(imports, event({ root: '/old', state: 'done', total: 50, done: 50 }))
    expect(overallProgress(imports)).toBe(1)
  })

  test('the job over the events: authoritative counts', () => {
    const imports = startImports(importRoots(rows, picked, 'latest'))
    const job = {
      job_id: 'j', state: 'done', started_at: '', imported: 0, already_imported: 0, skipped_count: 0,
      projects: [{ root: '/old', state: 'done', project_id: 'k-old', total: 50, done: 50, imported: 50, already_imported: 0, skipped_count: 0, skipped: [], imported_thread_ids: [] }],
    } as unknown as SessionsImportJob
    expect(applyJob(imports, job)['/old']).toMatchObject({ state: 'done', project_id: 'k-old', imported: 50 })
    expect(applyJob(imports, job)['/new']!.state).toBe('queued')
  })

  test('skip details keep the daemon’s sentence and are bounded', () => {
    const skip = (n: number) => ({ provider: 'codex' as const, session_id: `s${n}`, title: `Chat ${n}`, reason: 'in_use' as const, detail: 'Still in use. Close it in Codex and import it from the project’s menu.' })
    let skips = appendSkips([], 'old', [skip(1)])
    expect(skips).toEqual([{ project: 'old', title: 'Chat 1', reason: 'in_use', detail: 'Still in use. Close it in Codex and import it from the project’s menu.' }])
    expect(appendSkips(skips, 'old', [])).toBe(skips)
    skips = appendSkips(skips, 'old', Array.from({ length: 250 }, (_, i) => skip(i)))
    expect(skips).toHaveLength(200)
  })

  test('the summary the handoff reads', () => {
    const plan = importRoots(rows, picked, 'latest')
    const names = Object.fromEntries(rows.map((r) => [r.root, r.name]))
    const order = plan.map((p) => p.root)
    let imports = startImports(plan)
    const idle = summarize({ phase: 'none', mode: 'latest', order: [], imports: {}, names, skips: [] })
    expect(idle).toMatchObject({ phase: 'none', projects: 0, recentProjectId: null, names: [] })

    const queued = summarize({ phase: 'running', mode: 'latest', order, imports, names, skips: [], known: { '/old': 'p-old' } })
    expect(queued).toMatchObject({ phase: 'running', projects: 3, doneProjects: 0, chats: 0, totalChats: 93, skipped: 0, recentProjectId: 'p-old', recentProjectName: 'old', names: [] })

    imports = applyProgress(imports, event({ root: '/mine', state: 'done', project_id: 'k-mine' }))
    imports = applyProgress(imports, event({ root: '/new', state: 'running', total: 43, done: 20, imported: 20, project_id: 'k-new' }))
    const mid = summarize({ phase: 'running', mode: 'latest', order, imports, names, skips: [] })
    expect(mid).toMatchObject({ doneProjects: 1, chats: 20, recentProjectId: 'k-mine', recentProjectName: 'mine', names: ['mine', 'new'] })

    imports = applyProgress(imports, event({ root: '/new', state: 'done', total: 43, done: 43, imported: 42, skipped_count: 1 }))
    imports = applyProgress(imports, event({ root: '/old', state: 'done', total: 50, done: 50, imported: 50, project_id: 'k-old' }))
    const skips = appendSkips([], 'new', [{ provider: 'codex', session_id: 's', title: 'Big one', reason: 'too_large', detail: 'Too large to import.' }])
    const done = summarize({ phase: 'done', mode: 'latest', order, imports, names, skips })
    expect(done).toMatchObject({ phase: 'done', projects: 3, doneProjects: 3, chats: 92, totalChats: 93, skipped: 1, recentProjectId: 'k-mine', names: ['mine', 'new', 'old'] })
    expect(done.skippedDetails).toEqual([{ project: 'new', title: 'Big one', reason: 'too_large', detail: 'Too large to import.' }])
  })

  test('a failed project is never the recent one', () => {
    const plan = importRoots(rows, new Set(['/mine', '/new']), 'latest')
    let imports = startImports(plan)
    imports = applyProgress(imports, event({ root: '/mine', state: 'failed', error: 'x', project_id: 'k-mine' }))
    imports = applyProgress(imports, event({ root: '/new', state: 'done', project_id: 'k-new', total: 43, done: 43, imported: 43 }))
    const s = summarize({ phase: 'done', mode: 'latest', order: plan.map((p) => p.root), imports, names: { '/mine': 'mine', '/new': 'new' }, skips: [] })
    expect(s.recentProjectId).toBe('k-new')
    expect(s.names).toEqual(['new'])
  })
})
