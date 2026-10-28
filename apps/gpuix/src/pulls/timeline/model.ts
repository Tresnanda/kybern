// Pure logic of the Timeline tab: filters, collapsing consecutive commits into one push, and merging cursor pages.
import type { PrReviewEntry, PrTimelineEvent } from '../../../../../packages/kybern-client/src/types.ts'

export type TimelineFilter = 'all' | 'comments' | 'reviews' | 'commits'
export const TIMELINE_FILTERS: readonly { value: TimelineFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'comments', label: 'Comments' },
  { value: 'reviews', label: 'Reviews' },
  { value: 'commits', label: 'Commits' },
]

/** Pushes and their force pushes are the "Commits" view. */
export function matchesFilter(event: PrTimelineEvent, filter: TimelineFilter): boolean {
  switch (filter) {
    case 'all': return true
    case 'comments': return event.kind === 'comment'
    case 'reviews': return event.kind === 'review'
    case 'commits': return event.kind === 'commit' || event.kind === 'force_push'
  }
}

/** What the list draws: one event, or a run of commits by one author ("pushed 3 commits"). */
export type TimelineItem =
  | { type: 'event'; id: string; event: PrTimelineEvent }
  | { type: 'push'; id: string; author: string; avatar_url?: string; author_is_bot?: boolean; created_at: string; commits: PrTimelineEvent[] }

/** Consecutive commits by the same author become one push; any other event, or another author, ends it. */
export function collapseCommits(events: readonly PrTimelineEvent[]): TimelineItem[] {
  const items: TimelineItem[] = []
  for (const event of events) {
    const last = items[items.length - 1]
    if (event.kind !== 'commit') { items.push({ type: 'event', id: event.id, event }); continue }
    if (last?.type === 'push' && last.author === event.author) { last.commits.push(event); continue }
    items.push({ type: 'push', id: `push:${event.id}`, author: event.author, ...(event.avatar_url ? { avatar_url: event.avatar_url } : {}), ...(event.author_is_bot ? { author_is_bot: true } : {}), created_at: event.created_at, commits: [event] })
  }
  return items
}

export function timelineItems(events: readonly PrTimelineEvent[], filter: TimelineFilter): TimelineItem[] {
  return collapseCommits(events.filter(e => matchesFilter(e, filter)))
}

/** The most events kept in memory: 10 pages. A longer history ends with a link to GitHub. */
export const TIMELINE_LIMIT = 300

/** Append a page: events already held (by id) are replaced in place, so a refetched page never duplicates. */
export function mergeTimeline(held: readonly PrTimelineEvent[], page: readonly PrTimelineEvent[], limit = TIMELINE_LIMIT): PrTimelineEvent[] {
  const byId = new Map(held.map(e => [e.id, e]))
  const out = [...held]
  for (const event of page) {
    if (byId.has(event.id)) out[out.findIndex(e => e.id === event.id)] = event
    else { byId.set(event.id, event); out.push(event) }
  }
  return out.length > limit ? out.slice(0, limit) : out
}

/** Counts for the filter chips; `counts` is the detail's (it covers events not loaded yet), else what is held. */
export function filterCounts(events: readonly PrTimelineEvent[], counts?: { comments: number; reviews: number; commits: number }): Record<TimelineFilter, number> {
  const held = { comments: 0, reviews: 0, commits: 0 }
  for (const e of events) {
    if (e.kind === 'comment') held.comments++
    else if (e.kind === 'review') held.reviews++
    else if (e.kind === 'commit') held.commits++
  }
  const c = counts ?? held
  return { all: c.comments + c.reviews + c.commits, comments: c.comments, reviews: c.reviews, commits: c.commits }
}

/** "approved", "requested changes", … for a review's state. */
export function reviewVerb(state: string | undefined): string {
  switch ((state ?? '').toUpperCase()) {
    case 'APPROVED': return 'approved these changes'
    case 'CHANGES_REQUESTED': return 'requested changes'
    case 'DISMISSED': return 'had a review dismissed'
    case 'PENDING': return 'has a pending review'
    default: return 'reviewed'
  }
}

export const shortSha = (sha: string | undefined) => sha ? sha.slice(0, 7) : ''

/** What Send to agent selects: a comment, a review's summary, or one of a review's inline comments (by position). */
export interface Finding { id: string; entry: PrReviewEntry }

/** The draft's selection key and the entry the agent prompt reads. Ids are kept apart from the old per-source lists. */
export function findingFor(event: PrTimelineEvent, inline?: number): Finding | null {
  const base = { id: 0, author: event.author, state: event.state ?? '', side: null, updated_at: event.created_at }
  if (inline === undefined) {
    if (event.kind !== 'comment' && event.kind !== 'review') return null
    const body = event.body?.trim()
    if (!body) return null
    return { id: `timeline:${event.id}`, entry: { ...base, body, path: null, line: null, url: event.url ?? '' } }
  }
  const c = event.inline_comments?.[inline]
  if (!c) return null
  return { id: `timeline:${event.id}:${inline}`, entry: { ...base, body: c.body, path: c.path, line: c.line ?? null, side: 'RIGHT', url: c.url } }
}

/** Everything a review asks for, to send in one go: its summary and the inline comments that came with it. */
export function reviewFindings(event: PrTimelineEvent): Finding[] {
  const found = [findingFor(event), ...(event.inline_comments ?? []).map((_, i) => findingFor(event, i))]
  return found.filter((f): f is Finding => !!f)
}
