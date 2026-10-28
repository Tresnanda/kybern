import { describe, expect, test } from 'bun:test'
import { groupSkipped, skippedTitle, unlistedSkips } from './skipped.ts'

describe('skipped chats', () => {
  const skip = (project: string, title: string, detail = `${title} is in use.`) => ({ project, title, reason: 'in_use', detail })
  test('title follows the plural rule', () => {
    expect(skippedTitle(1)).toBe('1 chat was skipped')
    expect(skippedTitle(3)).toBe('3 chats were skipped')
    expect(skippedTitle(1234)).toBe('1,234 chats were skipped')
  })
  test('groups by project in first-seen order, keeping the daemon’s order inside', () => {
    const groups = groupSkipped([skip('ade', 'a'), skip('site', 'b'), skip('ade', 'c')])
    expect(groups.map((g) => g.project)).toEqual(['ade', 'site'])
    expect(groups[0]!.chats.map((c) => c.title)).toEqual(['a', 'c'])
    expect(groups[1]!.chats.map((c) => c.title)).toEqual(['b'])
  })
  test('no skips, no groups', () => expect(groupSkipped([])).toEqual([]))
  test('skips beyond the kept detail are counted, never negative', () => {
    expect(unlistedSkips(240, 200)).toBe(40)
    expect(unlistedSkips(3, 3)).toBe(0)
    expect(unlistedSkips(2, 5)).toBe(0)
  })
})
