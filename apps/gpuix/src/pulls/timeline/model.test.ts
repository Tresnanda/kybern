import { describe, expect, test } from 'bun:test'
import type { PrTimelineEvent } from '../../../../../packages/kybern-client/src/types.ts'
import { collapseCommits, filterCounts, findingFor, reviewFindings, matchesFilter, mergeTimeline, reviewVerb, timelineItems, TIMELINE_LIMIT } from './model.ts'

let n = 0
const event = (over: Partial<PrTimelineEvent> & Pick<PrTimelineEvent, 'kind'>): PrTimelineEvent => ({ id: `e${++n}`, created_at: `2026-10-28T10:${String(n).padStart(2, '0')}:00Z`, author: 'ana', ...over })
const commit = (author = 'ana') => event({ kind: 'commit', author, sha: `sha${n}abcdef0` })

describe('collapseCommits', () => {
  test('consecutive commits by one author become one push', () => {
    const items = collapseCommits([commit(), commit(), commit()])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ type: 'push', author: 'ana' })
    expect(items[0]!.type === 'push' && items[0]!.commits).toHaveLength(3)
  })
  test('another author, or any other event, ends the push', () => {
    const items = collapseCommits([commit('ana'), commit('bo'), commit('bo'), event({ kind: 'comment', body: 'hi' }), commit('bo')])
    expect(items.map(i => i.type === 'push' ? `push:${i.author}:${i.commits.length}` : i.event.kind)).toEqual(['push:ana:1', 'push:bo:2', 'comment', 'push:bo:1'])
  })
  test('a push is keyed by its first commit, so loading more never reshuffles keys', () => {
    const first = commit(); const second = commit()
    const before = collapseCommits([first])
    const after = collapseCommits([first, second])
    expect(after[0]!.id).toBe(before[0]!.id)
  })
  test('does not mutate its input and keeps other events as they are', () => {
    const events = [event({ kind: 'merged' }), commit()]
    const copy = structuredClone(events)
    collapseCommits(events)
    expect(events).toEqual(copy)
    expect(collapseCommits(events)[0]).toMatchObject({ type: 'event' })
  })
})

describe('filters', () => {
  const all = [event({ kind: 'comment' }), event({ kind: 'review', state: 'APPROVED' }), commit(), event({ kind: 'force_push' }), event({ kind: 'review_requested', target: 'kevin' })]
  test('each filter keeps its own kinds; All keeps everything', () => {
    expect(all.filter(e => matchesFilter(e, 'comments')).map(e => e.kind)).toEqual(['comment'])
    expect(all.filter(e => matchesFilter(e, 'reviews')).map(e => e.kind)).toEqual(['review'])
    expect(all.filter(e => matchesFilter(e, 'commits')).map(e => e.kind)).toEqual(['commit', 'force_push'])
    expect(all.filter(e => matchesFilter(e, 'all'))).toHaveLength(5)
  })
  test('commits across hidden events collapse once the others are filtered out', () => {
    const events = [commit(), event({ kind: 'comment' }), commit()]
    expect(timelineItems(events, 'all')).toHaveLength(3)
    expect(timelineItems(events, 'commits')).toHaveLength(1)
  })
  test('counts come from the detail when it has them, else from what is loaded', () => {
    expect(filterCounts(all)).toEqual({ all: 3, comments: 1, reviews: 1, commits: 1 })
    expect(filterCounts(all, { comments: 4, reviews: 2, commits: 9 })).toEqual({ all: 15, comments: 4, reviews: 2, commits: 9 })
  })
})

describe('mergeTimeline', () => {
  test('appends a page and replaces an event it already holds', () => {
    const a = event({ kind: 'comment', body: 'old' }); const b = event({ kind: 'comment' }); const c = event({ kind: 'comment' })
    const merged = mergeTimeline([a, b], [{ ...a, body: 'new' }, c])
    expect(merged.map(e => e.id)).toEqual([a.id, b.id, c.id])
    expect(merged[0]!.body).toBe('new')
  })
  test('is bounded and keeps the oldest events', () => {
    const page = Array.from({ length: 40 }, () => event({ kind: 'comment' }))
    let held: PrTimelineEvent[] = []
    for (let i = 0; i < 12; i++) held = mergeTimeline(held, page.map(e => ({ ...e, id: `${e.id}-${i}` })))
    expect(held).toHaveLength(TIMELINE_LIMIT)
    expect(held[0]!.id).toBe(`${page[0]!.id}-0`)
  })
})

test('reviewVerb names every state', () => {
  expect(reviewVerb('APPROVED')).toBe('approved these changes')
  expect(reviewVerb('changes_requested')).toBe('requested changes')
  expect(reviewVerb('COMMENTED')).toBe('reviewed')
  expect(reviewVerb(undefined)).toBe('reviewed')
})

describe('findings', () => {
  const review = event({ kind: 'review', state: 'CHANGES_REQUESTED', body: 'Add a down step.', author: 'kevin', inline_comments: [{ path: 'db/a.sql', line: 12, body: 'on conflict do nothing', url: 'u' }, { path: 'db/b.sql', body: 'again', url: 'v' }] })
  test('a review and each inline comment have their own key', () => {
    expect(findingFor(review)?.id).toBe(`timeline:${review.id}`)
    expect(findingFor(review, 0)).toMatchObject({ id: `timeline:${review.id}:0`, entry: { path: 'db/a.sql', line: 12, body: 'on conflict do nothing', side: 'RIGHT' } })
    expect(findingFor(review, 1)?.entry.line).toBeNull()
    expect(findingFor(review, 5)).toBeNull()
  })
  test('only comments and reviews with text can be sent', () => {
    expect(findingFor(event({ kind: 'merged' }))).toBeNull()
    expect(findingFor(event({ kind: 'review', body: '  ' }))).toBeNull()
    expect(findingFor(event({ kind: 'comment', body: 'hello' }))?.entry).toMatchObject({ author: 'ana', body: 'hello', path: null })
  })
  test('reviewFindings gathers the summary and every inline comment', () => {
    expect(reviewFindings(review).map(f => f.id)).toEqual([`timeline:${review.id}`, `timeline:${review.id}:0`, `timeline:${review.id}:1`])
    expect(reviewFindings(event({ kind: 'review', state: 'APPROVED' }))).toEqual([])
  })
})
