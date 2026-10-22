import { beforeEach, describe, expect, test } from 'bun:test'
import { FREE_CHAT_PROJECT_ID, type Project, type Space, type Thread } from '../../../../packages/kybern-client/src/types.ts'
import { currentEntry } from '../nav/history.ts'
import { getNav, setNav } from '../nav/store.ts'
import { getState, set } from '../state.ts'
import { currentSpaceId, scopedProjects, startSpaces, switchSpace } from './current.ts'
import { setSpacesState } from './store.ts'

const space = (id: string, position: number): Space => ({
  id, name: id, color: 'blue', logo: { kind: 'initials' }, position, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
})
const project = (id: string, space_id: string): Project => ({ id, name: id, path: `/${id}`, is_git: false, brief_in_all_threads: false, space_id }) as unknown as Project
const thread = (id: string, project_id: string): Thread =>
  ({ id, title: id, project_id, status: 'idle', updated_at: '2026-10-20T00:00:00Z', last_seq: 1, provider: { kind: 'claude-code', instance: 'default' } }) as unknown as Thread

startSpaces()

beforeEach(() => {
  setSpacesState({ supported: true, spaces: [space('s1', 0), space('s2', 1)] })
  set({
    status: 'open', listsLoaded: true, selectedId: null, draft: {},
    projects: [project('a', 's1'), project('b', 's1'), project('c', 's2')],
    threads: [thread('ta', 'a'), thread('tc', 'c'), thread('chat', FREE_CHAT_PROJECT_ID)],
  })
  setNav({ page: 'home', spaceId: 's1', spaceViews: {}, projectOrder: [], settingsOpen: false, paletteOpen: false, keyboardNav: false, history: { entries: [], index: -1 } })
})

describe('currentSpaceId', () => {
  test('is the saved id, else the first space, and null when the daemon has none', () => {
    expect(currentSpaceId()).toBe('s1')
    setNav({ spaceId: 'gone' })
    expect(currentSpaceId()).toBe('s1')
    setNav({ spaceId: null })
    expect(currentSpaceId()).toBe('s1')
    setSpacesState({ supported: false, spaces: [] })
    expect(currentSpaceId()).toBeNull()
  })
  test('uses the saved id while the list is still loading', () => {
    setSpacesState({ supported: null, spaces: [] })
    setNav({ spaceId: 's2' })
    expect(currentSpaceId()).toBe('s2')
  })
})

test('scopedProjects keeps free chat and the space’s projects', () => {
  expect(scopedProjects(getState().projects, 's1').map((p) => p.id)).toEqual(['a', 'b'])
  expect(scopedProjects(getState().projects, null).length).toBe(3)
})

describe('switchSpace', () => {
  test('ignores the current space and unknown ids', () => {
    expect(switchSpace('s1', 'pointer')).toBe(false)
    expect(switchSpace('nope', 'pointer')).toBe(false)
    expect(getNav().spaceId).toBe('s1')
  })

  test('opens the first project’s draft of a space with no remembered view', () => {
    setNav({ projectOrder: ['b', 'a'] })
    set({ selectedId: null, draft: { projectId: 'a' } })
    expect(switchSpace('s2', 'pointer')).toBe(true)
    expect(getNav().spaceId).toBe('s2')
    expect(currentEntry()).toEqual({ kind: 'draft', draft: { projectId: 'c' } })
  })

  test('falls back to a free chat draft when the space has no projects', () => {
    setSpacesState({ supported: true, spaces: [space('s1', 0), space('s2', 1), space('s3', 2)] })
    switchSpace('s3', 'pointer')
    expect(getNav().spaceId).toBe('s3')
    expect(currentEntry()).toEqual({ kind: 'draft', draft: {} })
  })

  test('saves the view it leaves and restores it when switching back', () => {
    set({ selectedId: 'ta' })
    switchSpace('s2', 'pointer')
    expect(getNav().spaceViews.s1).toEqual({ kind: 'thread', id: 'ta' })
    expect(getState().selectedId).toBeNull()
    switchSpace('s1', 'pointer')
    expect(getState().selectedId).toBe('ta')
  })

  test('never remembers a view from another space for the space it left', () => {
    set({ selectedId: 'ta' })
    set({ selectedId: 'tc' }) // the follow rule moves to s2
    expect(getNav().spaceId).toBe('s2')
    expect(getNav().spaceViews.s1).toEqual({ kind: 'thread', id: 'ta' })
    expect(getNav().spaceViews.s2).toEqual({ kind: 'thread', id: 'tc' })
  })

  test('a keyboard switch sets keyboardNav, closes Settings and the palette', () => {
    setNav({ settingsOpen: true, paletteOpen: true })
    switchSpace('s2', 'keyboard')
    expect(getNav()).toMatchObject({ keyboardNav: true, settingsOpen: false, paletteOpen: false })
  })

  test('a remembered page comes back', () => {
    setNav({ page: 'tasks' })
    switchSpace('s2', 'pointer')
    expect(getNav().page).toBe('home')
    switchSpace('s1', 'pointer')
    expect(getNav().page).toBe('tasks')
  })
})

describe('the follow rule', () => {
  test('opening a thread in another space activates that space', () => {
    set({ selectedId: 'tc' })
    expect(getNav().spaceId).toBe('s2')
  })
  test('opening a project draft in another space activates that space', () => {
    set({ selectedId: null, draft: { projectId: 'c' } })
    expect(getNav().spaceId).toBe('s2')
  })
  test('a free chat never changes the space', () => {
    set({ selectedId: 'chat' })
    expect(getNav().spaceId).toBe('s1')
    set({ selectedId: null, draft: {} })
    expect(getNav().spaceId).toBe('s1')
  })
  test('a project moved while open pulls the space along', () => {
    set({ selectedId: 'ta' })
    expect(getNav().spaceId).toBe('s1')
    set({ projects: getState().projects.map((p) => (p.id === 'a' ? { ...p, space_id: 's2' } : p)) })
    expect(getNav().spaceId).toBe('s2')
  })
  test('a stale saved space resolves to the open view’s space', () => {
    setNav({ spaceId: 'gone' })
    set({ selectedId: 'tc' })
    expect(getNav().spaceId).toBe('s2')
  })
})
