import { describe, expect, test } from 'bun:test'
import type { ApprovalRequest } from '../../../../packages/kybern-client/src/types.ts'
import { chosenAnswers, expiredQuestion, recordText, replyInChatMessage, requestRecord } from '../../../../packages/kybern-client/src/requestCards.ts'
import { pendingKind } from '../../../../packages/kybern-client/src/userInput.ts'
import { pendingBadge } from '../sidebar/model.ts'
import { splitQuestion } from './Question.tsx'

const question = (extra: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  id: 'a1', thread_id: 't1', turn_id: 'u1', tool_name: 'AskUserQuestion', summary: 'Which palette?', suggestions: [], created_at: '2026-10-23T10:00:00Z',
  input: { questions: [{ question: 'Which palette?', multiSelect: true, options: [{ label: 'Warm, soft' }, { label: 'Cool' }] }] },
  questions: [{ id: 'Which palette?', question: 'Which palette?', options: [{ label: 'Warm, soft' }, { label: 'Cool' }], multi_select: true, allow_custom: true, secret: false, attachments: true }],
  ...extra,
})

describe('question records', () => {
  test('an agent answer names the agent and keeps labels whole', () => {
    const decision = { decision: 'submit' as const, response: { answers: { 'Which palette?': ['Warm, soft', 'Cool'] }, annotations: {} } }
    expect(chosenAnswers(question(), decision)).toEqual(['Warm, soft', 'Cool'])
    const record = requestRecord(question(), decision, true, undefined, { thread_id: 'p', title: 'Coordinator' })!
    expect(recordText(record)).toBe('Answered by Coordinator · “Warm, soft”, “Cool”')
    // The user's own answer keeps the ordinary row.
    expect(requestRecord(question(), decision, true)).toBeNull()
  })

  test('attachment lines stay out of the record', () => {
    const codex = question({ tool_name: 'request_user_input', questions: [{ id: 'c', question: 'Which?', options: [], multi_select: false, allow_custom: true, secret: false, attachments: true }] })
    expect(chosenAnswers(codex, { decision: 'submit', response: { answers: { c: { answers: ['Teal', 'Attached image: /a/b'] } } } })).toEqual(['Teal'])
  })

  test('a question a restart cut off expires and can be answered in the chat', () => {
    const decision = { decision: 'deny' as const, reason: 'daemon restarted' }
    expect(expiredQuestion(question(), decision)).toBe(true)
    expect(expiredQuestion(question({ tool_name: 'Bash', input: { command: 'ls' }, questions: [] }), decision)).toBe(false)
    expect(recordText(requestRecord(question(), decision, false)!)).toBe('This question expired when Kybern restarted.')
    const free = question({ questions: [{ id: 'q', question: 'Name it?', options: [], multi_select: false, allow_custom: true, secret: false, attachments: true }] })
    expect(recordText(requestRecord(free, decision, false)!)).toBe('This question expired when Kybern restarted. · answer it in the chat instead')
    expect(replyInChatMessage('Which\n palette?', 'Cool')).toBe('For “Which palette?”: Cool')
  })
})

describe('needs input versus pending approval', () => {
  test('kinds', () => {
    expect(pendingKind(question())).toBe('question')
    expect(pendingKind({ tool_name: 'kybern_request_secret', input: {} })).toBe('question')
    expect(pendingKind({ tool_name: 'Bash', input: { command: 'ls' } })).toBe('approval')
    expect(pendingKind({ tool_name: 'mcp_elicitation', input: { _meta: { codex_approval_kind: 'mcp_tool_call' } } })).toBe('approval')
  })

  test('sidebar badges', () => {
    expect(pendingBadge('awaiting-approval', { own: 'question' })).toBe('Needs input')
    expect(pendingBadge('awaiting-approval', { own: 'approval' })).toBe('Pending approval')
    expect(pendingBadge('awaiting-approval', undefined)).toBe('Pending')
    expect(pendingBadge('running', { child: 'question' })).toBe('Needs input')
    expect(pendingBadge('idle', { child: 'approval' })).toBe('Pending approval')
    expect(pendingBadge('running', undefined)).toBeNull()
  })
})

test('the question\'s first paragraph is the title, as plain text; the rest is the Markdown body', () => {
  expect(splitQuestion('Which layout should the dashboard use?')).toEqual({ title: 'Which layout should the dashboard use?', body: '' })
  expect(splitQuestion('Which **layout** should the settings page use?\n\nWe render it at `1280×800`; pick the one that reads best.'))
    .toEqual({ title: 'Which layout should the settings page use?', body: 'We render it at `1280×800`; pick the one that reads best.' })
  expect(splitQuestion('Use `grid` or `flex`?')).toEqual({ title: 'Use grid or flex?', body: '' })
  expect(splitQuestion('Pick one:\n- A\n- B')).toEqual({ title: 'Pick one:', body: '- A\n- B' })
  // A question that opens with a block, or a paragraph too long for a title, stays whole under its header word.
  expect(splitQuestion('- A\n- B', 'Layout')).toEqual({ title: 'Layout', body: '- A\n- B' })
  expect(splitQuestion('x'.repeat(201))).toEqual({ title: 'Question', body: 'x'.repeat(201) })
})
