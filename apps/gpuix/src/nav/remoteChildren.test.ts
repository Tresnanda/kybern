// Delegated children that run on another machine join and leave `nav.children`.
import { expect, test } from 'bun:test'
import type { Thread } from '../../../../packages/kybern-client/src/types.ts'
import { withRemoteChildren } from './remoteChildren.ts'

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
