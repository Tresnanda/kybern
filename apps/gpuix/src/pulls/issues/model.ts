// Pure logic of the Issues tab (#217): the state words, the filters, the comment timeline and the first message of a thread
// started from an issue. No React and no theme, so it is unit-tested directly (`model.test.ts`).
import type { Issue, IssueComment, IssueDetailResult, PrTimelineEvent } from '../../../../../packages/kybern-client/src/types.ts'

/** Issues per read: a page of the daemon's list. */
export const PAGE = 30

export type IssueFilterState = 'open' | 'closed'
export const STATES = [['open', 'Open'], ['closed', 'Closed']] as const

export interface IssueStateWord { label: 'Open' | 'Closed' | 'Not planned'; tone: 'open' | 'done' | 'muted' }

/** How an issue's state reads: GitHub says "Not planned" for an issue closed as such. */
export function stateWord(issue: Pick<Issue, 'state' | 'state_reason'>): IssueStateWord {
  if (issue.state !== 'CLOSED') return { label: 'Open', tone: 'open' }
  return issue.state_reason === 'NOT_PLANNED' ? { label: 'Not planned', tone: 'muted' } : { label: 'Closed', tone: 'done' }
}

/** The label names after choosing or clearing `name`. */
export function toggleLabel(labels: readonly string[], name: string): string[] {
  return labels.includes(name) ? labels.filter(l => l !== name) : [...labels, name]
}

/** The logins the Assignee menu offers: the signed-in account first, then everyone assigned in the loaded issues. */
export function assigneeChoices(issues: readonly Issue[], chosen?: string): string[] {
  const logins = new Set<string>()
  for (const issue of issues) for (const a of issue.assignees ?? []) logins.add(a.login)
  if (chosen && chosen !== '@me') logins.add(chosen)
  return [...logins].sort((a, b) => a.localeCompare(b))
}

/** Merge a further page into what is held; an issue already held (by number) keeps its place. */
export function appendIssues(held: readonly Issue[], page: readonly Issue[]): Issue[] {
  const numbers = new Set(held.map(i => i.number))
  return [...held, ...page.filter(i => !numbers.has(i.number))]
}

/** An issue's comments as the pull request timeline's events, so its rows draw them. */
export function commentEvents(comments: readonly IssueComment[]): PrTimelineEvent[] {
  return comments.map(c => ({
    id: c.id, kind: 'comment', created_at: c.created_at, author: c.author, body: c.body, url: c.url,
    ...(c.author_avatar_url ? { avatar_url: c.author_avatar_url } : {}),
    ...(c.author_is_bot ? { author_is_bot: true } : {}),
  }))
}

/** A thread's first message reads at most this much of an issue. */
export const PROMPT_BODY_LIMIT = 8_000
export const PROMPT_COMMENT_LIMIT = 1_500
export const PROMPT_COMMENTS = 20
export const PROMPT_LIMIT = 24_000

const cut = (text: string, limit: number) => text.length <= limit ? text : `${text.slice(0, limit).trimEnd()}…`
const clean = (text: string) => text.replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n').trim()

/**
 * The first message of a thread started from an issue: its title, number and link, its description and its comments,
 * each bounded and the whole under `PROMPT_LIMIT`, then what to do first. `repoName` names the repository of a group project.
 */
export function issuePrompt(detail: IssueDetailResult, repoName?: string): string {
  const { issue } = detail
  const facts = [`State: ${stateWord(issue).label.toLowerCase()}`, issue.labels?.length ? `Labels: ${issue.labels.map(l => l.name).join(', ')}` : '', issue.milestone ? `Milestone: ${issue.milestone}` : '', `Opened by ${issue.author || 'someone'}`].filter(Boolean)
  const head = `Issue #${issue.number} "${issue.title}"${repoName ? ` in ${repoName}` : ''} (${issue.url}).\n${facts.join('. ')}.`
  const body = clean(detail.body)
  const tail = 'Start by reading the code this issue is about, then tell me what you plan to change. Do not push or close the issue without asking.'
  const parts = [head, body ? cut(body, PROMPT_BODY_LIMIT) : 'The issue has no description.']
  const shown = detail.comments.slice(0, PROMPT_COMMENTS)
  const comments: string[] = []
  let budget = PROMPT_LIMIT - parts.join('\n\n').length - tail.length - 400
  for (const c of shown) {
    const text = clean(c.body)
    if (!text) continue
    const entry = `${c.author || 'Someone'} (${c.created_at.slice(0, 10)}):\n${cut(text, PROMPT_COMMENT_LIMIT)}`
    if (entry.length > budget) break
    budget -= entry.length + 2
    comments.push(entry)
  }
  if (comments.length) parts.push(`Comments:\n\n${comments.join('\n\n')}`)
  const unread = detail.comment_count - comments.length
  if (unread > 0) parts.push(`${unread} more ${unread === 1 ? 'comment is' : 'comments are'} on GitHub: ${issue.url}`)
  parts.push(tail)
  return parts.join('\n\n')
}

/** The thread's title: the issue's number and title, bounded. */
export function threadTitle(issue: Pick<Issue, 'number' | 'title'>): string {
  return cut(`#${issue.number} ${issue.title}`, 80)
}
