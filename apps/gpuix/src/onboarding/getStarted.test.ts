import { describe, expect, test } from 'bun:test'
import {
  allDone, defaultExpanded, doneCount, glideDistance, groupSkipped, needsAfterFlow, progressLabel, skippedTitle, UNKNOWN, unlistedSkips, visibleItems,
  type Facts, type Needs,
} from './getStarted.ts'

const facts = (over: Partial<Facts> = {}): Facts => ({ ...UNKNOWN, ...over })
const ids = (platform: NodeJS.Platform, needs: Needs, f: Facts) => visibleItems(platform, needs, f).map((i) => i.id)

describe('which items show', () => {
  const none: Needs = { agent: false, import: false }
  test('the agent item only when no agent was ready', () => {
    expect(ids('darwin', { agent: true, import: false }, UNKNOWN)).toContain('agent')
    expect(ids('darwin', none, UNKNOWN)).not.toContain('agent')
  })
  test('import only when it was skipped', () => {
    expect(ids('darwin', { agent: false, import: true }, UNKNOWN)).toContain('import')
    expect(ids('darwin', none, UNKNOWN)).not.toContain('import')
  })
  test('Computer use is macOS only', () => {
    expect(ids('darwin', none, UNKNOWN)).toContain('computer')
    expect(ids('win32', none, UNKNOWN)).not.toContain('computer')
    expect(ids('linux', none, UNKNOWN)).not.toContain('computer')
  })
  test('an item the machine cannot offer is dropped', () => {
    expect(ids('darwin', none, facts({ computer: 'unsupported' }))).not.toContain('computer')
    expect(ids('darwin', none, facts({ notifications: 'unsupported' }))).not.toContain('notifications')
  })
  test('keeps the card order, and shows unread items unticked so the list does not jump', () => {
    expect(ids('darwin', { agent: true, import: true }, UNKNOWN)).toEqual(['agent', 'cli', 'phone', 'computer', 'notifications', 'import'])
    expect(visibleItems('darwin', none, UNKNOWN).every((i) => !i.done)).toBe(true)
  })
  test('five items on a Mac with an agent ready and chats imported', () => {
    expect(visibleItems('darwin', none, UNKNOWN)).toHaveLength(4)
    expect(visibleItems('darwin', { agent: true, import: false }, UNKNOWN)).toHaveLength(5)
  })
})

describe('when an item ticks', () => {
  const tick = (id: string, f: Facts, needs: Needs = { agent: true, import: true }) => visibleItems('darwin', needs, f).find((i) => i.id === id)?.done
  test('agent: an agent is ready', () => {
    expect(tick('agent', facts({ agentReady: true }))).toBe(true)
    expect(tick('agent', facts({ agentReady: false }))).toBe(false)
  })
  test('cli: the command is on PATH', () => {
    expect(tick('cli', facts({ cli: true }))).toBe(true)
    expect(tick('cli', facts({ cli: false }))).toBe(false)
  })
  test('phone: a device has paired', () => {
    expect(tick('phone', facts({ phone: true }))).toBe(true)
    expect(tick('phone', facts({ phone: false }))).toBe(false)
  })
  test('computer: only when setup is ready', () => {
    expect(tick('computer', facts({ computer: 'ready' }))).toBe(true)
    expect(tick('computer', facts({ computer: 'pending' }))).toBe(false)
  })
  test('notifications: only when granted', () => {
    expect(tick('notifications', facts({ notifications: 'granted' }))).toBe(true)
    expect(tick('notifications', facts({ notifications: 'pending' }))).toBe(false)
  })
  test('import: a real import has finished', () => {
    expect(tick('import', facts({ importDone: true }))).toBe(true)
    expect(tick('import', facts({ importDone: false }))).toBe(false)
  })
  test('counts and the header words', () => {
    const items = visibleItems('darwin', { agent: false, import: false }, facts({ cli: true, notifications: 'granted' }))
    expect(doneCount(items)).toBe(2)
    expect(progressLabel(items)).toBe('2 of 4 done')
    expect(allDone(items)).toBe(false)
    expect(allDone(visibleItems('darwin', { agent: false, import: false }, facts({ cli: true, phone: true, computer: 'ready', notifications: 'granted' })))).toBe(true)
    expect(allDone([])).toBe(false)
  })
})

describe('what the flow left to do', () => {
  const base = { kind: 'built' as const, agentReady: true, importPhase: 'done' as const, importMode: 'latest' as const }
  test('a finished flow with an agent and imported chats leaves nothing', () => {
    expect(needsAfterFlow(base)).toEqual({ agent: false, import: false })
  })
  test('no ready agent leaves the agent item', () => expect(needsAfterFlow({ ...base, agentReady: false }).agent).toBe(true))
  test('a running import counts as chosen', () => expect(needsAfterFlow({ ...base, importPhase: 'running' }).import).toBe(false))
  test('Set up later, a free chat and "Don’t import chats" leave the import item', () => {
    expect(needsAfterFlow({ ...base, kind: 'later', importPhase: 'none' }).import).toBe(true)
    expect(needsAfterFlow({ ...base, kind: 'free', importPhase: 'none' }).import).toBe(true)
    expect(needsAfterFlow({ ...base, importMode: 'none' }).import).toBe(true)
    expect(needsAfterFlow({ ...base, importPhase: 'none' }).import).toBe(true)
  })
})

describe('the glide', () => {
  test('a short window opens the card collapsed', () => {
    expect(defaultExpanded(900)).toBe(true)
    expect(defaultExpanded(759)).toBe(false)
  })
  test('the Draft follows 13/20 of the card’s height', () => {
    expect(glideDistance(200)).toBe(130)
    expect(glideDistance(-120)).toBe(-78)
    expect(glideDistance(0)).toBe(0)
  })
})

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
