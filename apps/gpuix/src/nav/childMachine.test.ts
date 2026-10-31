// ADE-107: a child that is never listed (a subagent or delegated child) opens on the machine `nav.children` names.
import { afterAll, expect, mock, test } from 'bun:test'
import type { Thread } from '../../../../packages/kybern-client/src/types.ts'

const real = await import('../machines/index.ts')
const hub = { localMachineId: 'mac', machineCount: 2, machineOfThread: () => 'mac' }
mock.module('../machines/index.ts', () => ({ ...real, machineHub: () => hub }))
const { machineOfThreadId } = await import('../state.ts')
const { getNav, setNav } = await import('./store.ts')

// Other test files share this process: give them the real module back.
afterAll(() => { mock.module('../machines/index.ts', () => real) })

test('a remote thread’s child opens on that machine; a local child stays here', () => {
  const before = getNav().children
  const child = (id: string, machineId?: string) => ({ id, parent_thread_id: 'parent', delegation: { status: 'running' }, ...(machineId ? { machineId } : {}) }) as unknown as Thread
  setNav({ children: { remote: child('remote', 'insta'), local: child('local') } })
  try {
    expect(machineOfThreadId('remote')).toBe('insta')
    expect(machineOfThreadId('local')).toBeUndefined()
    // The caller's machine still decides.
    expect(machineOfThreadId('remote', 'mac')).toBeUndefined()
  } finally {
    setNav({ children: before })
  }
})
