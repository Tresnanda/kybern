import { expect, test } from 'bun:test'
import type { ApprovalRequest } from '../../../../packages/kybern-client/src/types.ts'
import { questionLine, waitingLine } from './waitingLine.ts'

const card = (tool_name: string, input: unknown, summary = 'summary') => ({ id: 'a', thread_id: 't', tool_name, input, summary }) as unknown as ApprovalRequest

test('a summoned card says what the agent waits for, never "approval"', () => {
  expect(waitingLine(card('kybern_visual_answer', { visual_id: 'v', title: 'Pick a layout' }), 'Claude')).toBe('Claude is waiting for your choice in “Pick a layout”')
  expect(waitingLine(card('kybern_request_pick', { kind: 'preview_element', prompt: 'Which button should I make larger?' }), 'Claude')).toBe('Claude is waiting for you to point: Which button should I make larger?')
  expect(waitingLine(card('kybern_request_login', { cli: 'gh', service: 'GitHub' }), 'Codex')).toBe('Codex is waiting for you to sign in to GitHub')
  expect(waitingLine(card('kybern_askpass', { purpose: 'sudo', prompt: 'Password:' }), 'Claude')).toBe('Claude is waiting for your Mac password')
  expect(waitingLine(card('kybern_askpass', { purpose: 'ssh_host_key', confirm: true, host: 'example.dev', secret: false }), 'Claude')).toBe('Claude is waiting for you to trust example.dev')
  expect(waitingLine(card('kybern_request_permission', { pane: 'camera', app: 'Photo Booth' }), 'Claude')).toBe('Claude is waiting for you to let Photo Booth use the camera')
  expect(waitingLine(card('kybern_request_secret', { env_key: 'STRIPE_KEY', label: 'Stripe key' }), 'Claude')).toBe('Claude is waiting for Stripe key')
  for (const line of [
    waitingLine(card('kybern_visual_answer', { visual_id: 'v', title: 'x' }), 'Claude'),
    waitingLine(card('kybern_request_pick', { kind: 'window', prompt: '' }), 'Claude'),
  ]) expect(line).not.toContain('approval')
})

test('a real approval and a question keep their own words', () => {
  expect(waitingLine(card('Bash', { command: 'rm -rf build' }, 'Run rm -rf build'), 'Claude')).toBe('Needs approval: Run rm -rf build')
  expect(waitingLine(card('AskUserQuestion', { questions: [], deadline: {} }, 'Which database?'), 'Claude')).toBe('Claude is waiting for your answer: Which database?')
  expect(questionLine(card('AskUserQuestion', {}, 'Which database?'), 'Claude')).toBe('Claude is waiting for your answer: Which database?')
  expect(questionLine(card('AskUserQuestion', {}, "Answer the agent's questions"), 'Codex')).toBe('Codex is waiting for your answers')
  const asked = { ...card('AskUserQuestion', {}, 'AskUserQuestion'), questions: [{ id: 'Which fruit?', question: 'Which fruit?\nPick one.', options: [] }] } as unknown as ApprovalRequest
  expect(questionLine(asked, 'Claude')).toBe('Claude is waiting for your answer: Which fruit?')
  expect(questionLine(card('AskUserQuestion', {}, 'AskUserQuestion'), 'Claude')).toBe('Claude is waiting for your answers')
})
