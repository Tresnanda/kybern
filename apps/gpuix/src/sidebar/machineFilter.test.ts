// The "All machines" filter on the sidebar's lists.
import { expect, test } from 'bun:test'
import { filterByMachine } from './MachineFilter.tsx'
import { activeMachineFilter } from './MachineFilter.tsx'

const projects = [{ id: 'both' }, { id: 'only-vps' }, { id: 'only-mac' }, { id: 'free' }]
const threads = [{ id: 'a' }, { id: 'b', machineId: 'vps' }, { id: 'c', machineId: 'sat' }]
const machinesOf = (id: string) => ({ both: ['mac', 'vps'], 'only-vps': ['vps'], 'only-mac': ['mac'] } as Record<string, string[]>)[id] ?? []
const free = (id: string) => id === 'free'

test('no filter returns the same arrays', () => {
  const result = filterByMachine(projects, threads, null, 'mac', machinesOf, free)
  expect(result.projects).toBe(projects)
  expect(result.threads).toBe(threads)
})
test('one machine: its threads, the projects it has a checkout of, and free chat', () => {
  const vps = filterByMachine(projects, threads, 'vps', 'mac', machinesOf, free)
  expect(vps.threads.map((t) => t.id)).toEqual(['b'])
  expect(vps.projects.map((p) => p.id)).toEqual(['both', 'only-vps', 'free'])
  const mac = filterByMachine(projects, threads, 'mac', 'mac', machinesOf, free)
  expect(mac.threads.map((t) => t.id)).toEqual(['a'])
  expect(mac.projects.map((p) => p.id)).toEqual(['both', 'only-mac', 'free'])
})
test('a machine that is gone is treated as no filter by the header', () => {
  const rows = [{ machineId: 'mac' }, { machineId: 'vps' }] as never[]
  expect(activeMachineFilter(rows, 'nobody')).toBeNull()
  expect(activeMachineFilter(rows, 'vps')).toEqual({ machineId: 'vps' } as never)
})
