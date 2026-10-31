// Delegated children that run on another machine join and leave `nav.children`.
import { expect, test } from 'bun:test'
import type { Thread } from '../../../../packages/kybern-client/src/types.ts'
import type { StateThread } from '../machines/merged.ts'
import { OriginChildren, RemoteChildStore, parentMachineOf, underParents, withRemoteChildren } from './remoteChildren.ts'

const child = (id: string, extra: Record<string, unknown> = {}) => ({ id, parent_thread_id: 'parent', status: 'idle', delegation: { status: 'running' }, machineId: 'vps', ...extra }) as unknown as Thread

test('a remote child joins the set and leaves it when its machine stops listing it', () => {
  const a = child('a')
  const first = withRemoteChildren({}, [a], new Set())
  expect(first.children).toEqual({ a })
  expect([...first.ids]).toEqual(['a'])
  const gone = withRemoteChildren(first.children!, [], first.ids)
  expect(gone.children).toEqual({})
  expect(gone.ids.size).toBe(0)
})

test('an unchanged list changes nothing, and a local child with the same id wins', () => {
  const a = child('a')
  const first = withRemoteChildren({}, [a], new Set())
  expect(withRemoteChildren(first.children!, [a], first.ids).children).toBeNull()
  const local = child('b', { machineId: undefined })
  const second = withRemoteChildren({ b: local }, [child('b')], new Set())
  expect(second.children).toBeNull()
  expect(second.ids.size).toBe(0)
})

// ADE-107: a child nests under the thread that started it, whatever machines the two are on.

const origin = (id: string, extra: Record<string, unknown> = {}) => ({ id, project_id: 'p-mac', status: 'running', last_seq: 1, delegation: { status: 'running' }, origin: { machine_id: 'insta', thread_id: 'parent' }, ...extra }) as unknown as StateThread

test('a child another machine’s thread started here nests under that thread, in its project row, and stays on this machine', () => {
  const parent = { id: 'parent', project_id: 'p-row', machineId: 'insta' } as unknown as StateThread
  const sameIdHere = { id: 'parent', project_id: 'p-mac' } as unknown as StateThread
  const bare = origin('c1')
  const [nested] = underParents([bare], [sameIdHere, parent], 'mac')
  expect([nested!.parent_thread_id, nested!.project_id, nested!.ownProjectId, nested!.machineId]).toEqual(['parent', 'p-row', 'p-mac', undefined])
  // Memoized per source object; a parent that is not listed keeps the child's own project.
  expect(underParents([bare], [parent], 'mac')[0]).toBe(nested)
  expect(underParents([bare], [], 'mac')[0]!.project_id).toBe('p-mac')
  // A child of the same machine as its parent, or one without an origin, is returned as it is.
  const local = origin('c2', { origin: { machine_id: 'mac', thread_id: 'parent' }, parent_thread_id: 'parent' })
  expect(underParents([local], [parent], 'mac')[0]).toBe(local)
})

test('the nested copy of a child started from another machine replaces the bare one live events left in `nav.children`', () => {
  const bare = origin('c1')
  const nested = { ...bare, parent_thread_id: 'parent' } as Thread
  const next = withRemoteChildren({ c1: bare }, [nested], new Set())
  expect(next.children).toEqual({ c1: nested })
})

test('origin children come from the lists and events; archived ones leave and older copies change nothing', () => {
  const set = new OriginChildren()
  const listed = origin('c1', { last_seq: 3 })
  expect(set.replace([listed, origin('plain', { origin: null }), origin('gone', { status: 'archived' })])).toBe(true)
  expect(set.list.map((t) => t.id)).toEqual(['c1'])
  expect(set.replace([listed])).toBe(false)
  expect(set.put(origin('c1', { last_seq: 2 }))).toBe(false)
  expect(set.put(origin('c1', { last_seq: 4, status: 'archived' }))).toBe(true)
  expect(set.list).toEqual([])
})

test('the remote child store ignores threads that are no children and keeps one snapshot until something changes', () => {
  const store = new RemoteChildStore()
  let changes = 0
  store.subscribe(() => { changes++ })
  expect(store.put('vps', [{ id: 'top', status: 'idle', last_seq: 1 } as unknown as Thread])).toBe(false)
  store.put('vps', [child('a', { last_seq: 2 })])
  const first = store.get()
  expect(store.get()).toBe(first)
  expect(store.put('vps', [child('a', { last_seq: 1 })])).toBe(false)
  expect(changes).toBe(1)
  expect(store.get().get('vps')!.map((t) => t.id)).toEqual(['a'])
})

test('"Open parent" goes to the machine of the thread that started the child', () => {
  const nestedHere = { ...origin('c1'), parent_thread_id: 'parent' } as StateThread
  expect(parentMachineOf(nestedHere)).toBe('insta')
  expect(parentMachineOf(child('c2'))).toBe('vps')
  expect(parentMachineOf(child('c3', { machineId: undefined }))).toBeUndefined()
})
