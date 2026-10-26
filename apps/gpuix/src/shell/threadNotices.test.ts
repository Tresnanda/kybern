import { expect, test } from 'bun:test'
import { createThreadNotices } from './threadNotices.ts'

test('an answered approval withdraws the thread\'s notification only while it announces that approval', () => {
  const notices = createThreadNotices()
  notices.posted('t1', 'a1')
  expect(notices.resolved('t1', 'a2')).toBe(false)
  expect(notices.resolved('t1', 'a1')).toBe(true)
  // Withdrawn once.
  expect(notices.resolved('t1', 'a1')).toBe(false)
  // A "Finished working" that replaced the approval's notification is not the approval's to remove.
  notices.posted('t2', 'a3')
  notices.posted('t2', null)
  expect(notices.resolved('t2', 'a3')).toBe(false)
  expect(notices.resolved('unknown', 'a3')).toBe(false)
})

test('looking at a thread withdraws a notification that waits on an answer, and nothing else', () => {
  const notices = createThreadNotices()
  notices.posted('t1', 'a1')
  notices.posted('t2', null)
  expect(notices.viewed('t1')).toBe(true)
  expect(notices.viewed('t1')).toBe(false)
  expect(notices.viewed('t2')).toBe(false)
  expect(notices.viewed('nobody')).toBe(false)
})

test('the ledger is bounded', () => {
  const notices = createThreadNotices(2)
  notices.posted('t1', 'a1')
  notices.posted('t2', 'a2')
  notices.posted('t3', 'a3')
  expect(notices.resolved('t1', 'a1')).toBe(false)
  expect(notices.resolved('t3', 'a3')).toBe(true)
})
