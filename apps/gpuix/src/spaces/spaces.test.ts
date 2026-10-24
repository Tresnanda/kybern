import { describe, expect, test } from 'bun:test'
import type { Project, Space } from '../../../../packages/kybern-client/src/types.ts'
import { FREE_CHAT_PROJECT_ID } from '../../../../packages/kybern-client/src/types.ts'
import {
  SPACE_ICONS,
  canDeleteSpace,
  deleteTarget,
  inSpace,
  nextSpaceColor,
  spaceInitials,
  spaceOfProject,
} from '../../../../packages/kybern-client/src/spaces.ts'

const space = (id: string, color: Space['color'] = 'blue'): Space => ({
  id,
  name: id,
  color,
  logo: { kind: 'initials' },
  is_default: false,
  position: 0,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
})

const project = (id: string, space_id: string | null): Project =>
  ({ id, name: id, path: `/${id}`, is_git: false, brief_in_all_threads: false, space_id }) as Project

describe('spaceInitials', () => {
  test('one word gives one letter, two words give two', () => {
    expect(spaceInitials('Work')).toBe('W')
    expect(spaceInitials('Side Projects')).toBe('SP')
    expect(spaceInitials('side-projects')).toBe('SP')
    expect(spaceInitials('side_projects.v2 extra')).toBe('SP')
  })
  test('keeps non-ASCII letters whole', () => {
    expect(spaceInitials('ünïcode')).toBe('Ü')
    expect(spaceInitials('東京 オフィス')).toBe('東オ')
  })
  test('skips words that do not start with a letter or number', () => {
    expect(spaceInitials('🚀 Launch')).toBe('L')
    expect(spaceInitials('🚀')).toBe('')
    expect(spaceInitials('   ')).toBe('')
    expect(spaceInitials('2nd Floor')).toBe('2F')
  })
})

describe('inSpace', () => {
  const projects = [project('a', 's1'), project('b', 's2')]
  test('a null space (feature off) keeps everything', () => {
    expect(inSpace('b', projects, null)).toBe(true)
  })
  test('items without a project, free chat and unknown projects stay everywhere', () => {
    expect(inSpace(null, projects, 's1')).toBe(true)
    expect(inSpace(undefined, projects, 's1')).toBe(true)
    expect(inSpace(FREE_CHAT_PROJECT_ID, projects, 's1')).toBe(true)
    expect(inSpace('nope', projects, 's1')).toBe(true)
  })
  test('a known project shows only in its own space', () => {
    expect(inSpace('a', projects, 's1')).toBe(true)
    expect(inSpace('a', projects, 's2')).toBe(false)
  })
})

test('spaceOfProject', () => {
  const projects = [project('a', 's1')]
  expect(spaceOfProject(projects, 'a')).toBe('s1')
  expect(spaceOfProject(projects, 'x')).toBeNull()
  expect(spaceOfProject(projects, FREE_CHAT_PROJECT_ID)).toBeNull()
})

test('deleteTarget is the space above, or the next for the first', () => {
  const spaces = [space('a'), space('b'), space('c')]
  expect(deleteTarget(spaces, 'a')?.id).toBe('b')
  expect(deleteTarget(spaces, 'b')?.id).toBe('a')
  expect(deleteTarget(spaces, 'c')?.id).toBe('b')
  expect(deleteTarget([space('a')], 'a')).toBeNull()
  expect(deleteTarget(spaces, 'zzz')).toBeNull()
})

test('nextSpaceColor takes the first unused swatch, then rotates', () => {
  expect(nextSpaceColor([])).toBe('blue')
  expect(nextSpaceColor([space('a', 'blue'), space('b', 'purple')])).toBe('green')
  const all = ['blue', 'green', 'purple', 'pink', 'teal', 'amber', 'red', 'graphite'].map((c, i) => space(`s${i}`, c as Space['color']))
  expect(nextSpaceColor(all)).toBe('blue')
  expect(nextSpaceColor([...all, space('nine', 'blue')])).toBe('green')
})

test('the icon set has 31 unique slugs', () => {
  expect(SPACE_ICONS.length).toBe(31)
  expect(new Set(SPACE_ICONS).size).toBe(31)
  for (const slug of SPACE_ICONS) expect(slug).toMatch(/^[a-z0-9][a-z0-9-]{0,31}$/)
})

test('only the default space is protected from deletion', () => {
  expect(canDeleteSpace({ ...space('a'), is_default: true })).toBe(false)
  expect(canDeleteSpace(space('b'))).toBe(true)
})
