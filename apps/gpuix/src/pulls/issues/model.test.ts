import { expect, test } from 'bun:test'
import type { Issue, IssueComment, IssueDetailResult } from '../../../../../packages/kybern-client/src/types.ts'
import { appendIssues, assigneeChoices, commentEvents, issuePrompt, PROMPT_COMMENT_LIMIT, PROMPT_LIMIT, stateWord, threadTitle, toggleLabel } from './model.ts'

const issue = (over: Partial<Issue> = {}): Issue => ({ number: 7, title: 'Crash on start', url: 'https://github.com/acme/api/issues/7', state: 'OPEN', author: 'ada', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', ...over })
const comment = (n: number, body = `comment ${n}`): IssueComment => ({ id: `IC_${n}`, author: `user${n}`, body, created_at: `2026-01-0${(n % 9) + 1}T00:00:00Z`, url: `https://github.com/acme/api/issues/7#issuecomment-${n}` })
const detail = (over: Partial<IssueDetailResult> = {}): IssueDetailResult => ({ issue: issue(), body: 'It crashes.', comments: [], comment_count: 0, ...over })

test('a closed issue reads as closed or not planned, anything else as open', () => {
  expect(stateWord(issue())).toEqual({ label: 'Open', tone: 'open' })
  expect(stateWord(issue({ state: 'CLOSED', state_reason: 'COMPLETED' }))).toEqual({ label: 'Closed', tone: 'done' })
  expect(stateWord(issue({ state: 'CLOSED' }))).toEqual({ label: 'Closed', tone: 'done' })
  expect(stateWord(issue({ state: 'CLOSED', state_reason: 'NOT_PLANNED' }))).toEqual({ label: 'Not planned', tone: 'muted' })
})

test('labels toggle on and off in order', () => {
  expect(toggleLabel([], 'bug')).toEqual(['bug'])
  expect(toggleLabel(['bug', 'ui'], 'bug')).toEqual(['ui'])
  expect(toggleLabel(['bug'], 'ui')).toEqual(['bug', 'ui'])
})

test('the assignee menu lists everyone assigned in the loaded issues once, and keeps a chosen login', () => {
  const issues = [issue({ assignees: [{ login: 'grace' }, { login: 'ada' }] }), issue({ number: 8, assignees: [{ login: 'ada' }] }), issue({ number: 9 })]
  expect(assigneeChoices(issues)).toEqual(['ada', 'grace'])
  expect(assigneeChoices(issues, 'zed')).toEqual(['ada', 'grace', 'zed'])
  expect(assigneeChoices(issues, '@me')).toEqual(['ada', 'grace'])
})

test('a further page never repeats an issue already held', () => {
  const held = [issue({ number: 3 }), issue({ number: 2 })]
  expect(appendIssues(held, [issue({ number: 2, title: 'newer' }), issue({ number: 1 })]).map(i => i.number)).toEqual([3, 2, 1])
  expect(appendIssues(held, [])).toEqual(held)
})

test('comments become timeline comment events with their author and avatar', () => {
  const events = commentEvents([{ ...comment(1), author_avatar_url: 'https://github.com/user1.png', author_is_bot: true }, comment(2)])
  expect(events[0]).toMatchObject({ id: 'IC_1', kind: 'comment', author: 'user1', body: 'comment 1', avatar_url: 'https://github.com/user1.png', author_is_bot: true })
  expect(events[1]!.avatar_url).toBeUndefined()
  expect(events[1]!.author_is_bot).toBeUndefined()
})

test('a thread starts with the issue, its description and its comments', () => {
  const text = issuePrompt(detail({
    issue: issue({ labels: [{ name: 'bug', color: 'd73a4a' }], milestone: 'v2' }),
    body: 'It crashes.\n\n<!-- template hint -->\nSteps: open the app.',
    comments: [comment(1), comment(2)], comment_count: 2,
  }), 'acme / api')
  expect(text).toContain('Issue #7 "Crash on start" in acme / api (https://github.com/acme/api/issues/7).')
  expect(text).toContain('State: open. Labels: bug. Milestone: v2. Opened by ada.')
  expect(text).toContain('It crashes.\n\nSteps: open the app.')
  expect(text).not.toContain('template hint')
  expect(text).toContain('Comments:\n\nuser1 (2026-01-02):\ncomment 1\n\nuser2 (2026-01-03):\ncomment 2')
  expect(text).not.toContain('more comment')
  expect(text.endsWith('without asking.')).toBe(true)
})

test('an issue with no description or comments says so and names no repository', () => {
  const text = issuePrompt(detail({ body: '  ' }))
  expect(text).toContain('Issue #7 "Crash on start" (https://github.com/acme/api/issues/7).')
  expect(text).toContain('The issue has no description.')
  expect(text).not.toContain('Comments:')
})

test('the first message is bounded: long comments are cut, extra comments are left to GitHub', () => {
  const long = 'x'.repeat(PROMPT_COMMENT_LIMIT * 3)
  const many = Array.from({ length: 40 }, (_, i) => comment(i + 1, long))
  const text = issuePrompt(detail({ body: 'b'.repeat(50_000), comments: many, comment_count: 130 }))
  expect(text.length).toBeLessThanOrEqual(PROMPT_LIMIT)
  expect(text).toContain('…')
  const shown = text.match(/user\d+ \(/g)?.length ?? 0
  expect(shown).toBeGreaterThan(0)
  expect(shown).toBeLessThan(20)
  expect(text).toContain(`${130 - shown} more comments are on GitHub: https://github.com/acme/api/issues/7`)
})

test('one hidden comment is singular', () => {
  expect(issuePrompt(detail({ comments: [comment(1)], comment_count: 2 }))).toContain('1 more comment is on GitHub')
})

test('the thread title is the number and title, bounded', () => {
  expect(threadTitle(issue())).toBe('#7 Crash on start')
  const title = threadTitle(issue({ title: 'y'.repeat(200) }))
  expect(title.length).toBeLessThanOrEqual(81)
  expect(title.endsWith('…')).toBe(true)
})
