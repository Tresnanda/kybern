import { expect, test } from 'bun:test'
import { answerBarCopy, answerStubHint, STATIC_VISUAL, visualMode } from './visualFallback.ts'

test('a visual goes live only where a web view exists', () => {
  expect(visualMode(true)).toBe('live')
  expect(visualMode(false)).toBe('static')
})
test('the answer bar keeps its words with the page and offers replying without it', () => {
  const live = answerBarCopy(true, 'choice', 'Claude', null)
  expect(live).toEqual({ title: 'Claude is waiting for your choice', hint: 'Choose above, then send it.', replyLabel: null })
  expect(answerBarCopy(true, 'choice', 'Claude', 'Layout B').hint).toBe('Layout B selected. Press ↵ to send it.')
  const still = answerBarCopy(false, 'choice', 'Claude', null)
  expect(still.title).toBe(live.title)
  expect(still.replyLabel).toBe('Reply in your own words')
  expect(still.hint).toContain('Reply in your own words')
  expect(still.hint).not.toContain('Press ↵')
})
test('the stub above the composer points at the composer when the page cannot run', () => {
  expect(answerStubHint(true, 'Choose in the visual.')).toBe('Choose in the visual.')
  expect(answerStubHint(false, 'Choose in the visual.')).toBe('Type a reply below to answer in words, or skip.')
})
test('static visual copy is sentence case and verb-first', () => {
  expect(STATIC_VISUAL.openBrowser).toBe('Open in browser')
  expect(STATIC_VISUAL.hint).toContain('Open it in your browser')
})
