import { describe, expect, test } from 'bun:test'
import { START_MARK, defaultAgentAnnouncement, importAnnouncements } from './announce.ts'
import { EMPTY_SUMMARY, type RootImport } from './projects.ts'

const imp = (root: string, over: Partial<RootImport> = {}): RootImport => ({ root, state: 'queued', project_id: null, total: 0, done: 0, imported: 0, already_imported: 0, skipped_count: 0, error: null, expected: 10, ...over })
const plan = [{ root: '/a', name: 'alpha' }, { root: '/b', name: 'beta' }]

describe('import announcements', () => {
  test('start, each project once, and the end; ticks are silent', () => {
    let mark = START_MARK
    const step = (imports: Record<string, RootImport>, phase: 'running' | 'done' = 'running', summary = EMPTY_SUMMARY) => {
      const out = importAnnouncements(mark, { phase, plan, imports, summary })
      mark = out.mark
      return out.lines
    }
    expect(step({ '/a': imp('/a'), '/b': imp('/b') })).toEqual(['Importing 2 projects.'])
    expect(step({ '/a': imp('/a', { state: 'running', done: 3 }), '/b': imp('/b') })).toEqual([])
    expect(step({ '/a': imp('/a', { state: 'running', done: 7 }), '/b': imp('/b') })).toEqual([])
    expect(step({ '/a': imp('/a', { state: 'done', imported: 12 }), '/b': imp('/b') })).toEqual(['alpha imported, 12 chats.'])
    expect(step({ '/a': imp('/a', { state: 'done', imported: 12 }), '/b': imp('/b', { state: 'failed' }) })).toEqual(['beta couldn’t be imported.'])
    expect(step({ '/a': imp('/a', { state: 'done', imported: 12 }), '/b': imp('/b', { state: 'failed' }) }, 'done', { ...EMPTY_SUMMARY, phase: 'done', projects: 2, chats: 12, skipped: 1 }))
      .toEqual(['Import finished. 2 projects, 12 chats, 1 skipped.'])
    expect(step({ '/a': imp('/a', { state: 'done', imported: 12 }), '/b': imp('/b', { state: 'failed' }) }, 'done')).toEqual([])
  })
  test('a project with no chats is added, not imported', () => {
    const out = importAnnouncements({ phase: 'running', settled: new Set() }, { phase: 'running', plan: [plan[0]!], imports: { '/a': imp('/a', { state: 'done' }) }, summary: EMPTY_SUMMARY })
    expect(out.lines).toEqual(['alpha added.'])
  })
  test('the default agent change names the agent', () => {
    expect(defaultAgentAnnouncement('codex')).toBe('Codex is now your default agent.')
  })
})
