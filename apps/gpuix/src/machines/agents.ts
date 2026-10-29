// The agents a machine can run and whether each is signed in there, read from that machine (`machines.info` for the
// installed harnesses, `providers.accounts.list` for the sign-in state). Cached briefly so a sheet or picker that
// opens twice does not ask twice; an unreachable machine reports nothing rather than "signed out".
import { useEffect, useState } from 'react'
import { machineAgents, type MachineAgent } from '../../../../packages/kybern-client/src/machineAgents.ts'
import { machineHub } from './index.ts'

const FRESH_MS = 20_000
const cache = new Map<string, { at: number; agents: MachineAgent[] | null }>()
const reads = new Map<string, Promise<MachineAgent[] | null>>()

/** The agents of one machine, or null while it cannot be reached. */
export function loadMachineAgents(machineId: string): Promise<MachineAgent[] | null> {
  const cached = cache.get(machineId)
  if (cached && Date.now() - cached.at < FRESH_MS) return Promise.resolve(cached.agents)
  const running = reads.get(machineId)
  if (running) return running
  const read = (async () => {
    try {
      const client = machineHub().clientFor(machineId)
      const [info, accounts] = await Promise.all([client.call('machines.info', {}), client.call('providers.accounts.list', {}).then((result) => result.accounts, () => null)])
      return machineAgents(info.harnesses ?? [], accounts)
    } catch { return null }
  })().then((agents) => { cache.set(machineId, { at: Date.now(), agents }); return agents }).finally(() => reads.delete(machineId))
  reads.set(machineId, read)
  return read
}

/** `undefined` while it loads, `null` when the machine cannot be reached. */
export function useMachineAgents(machineId: string | undefined): MachineAgent[] | null | undefined {
  const [agents, setAgents] = useState<MachineAgent[] | null | undefined>(() => (machineId ? cache.get(machineId)?.agents : undefined))
  useEffect(() => {
    if (!machineId) { setAgents(undefined); return }
    let live = true
    setAgents(cache.get(machineId)?.agents)
    void loadMachineAgents(machineId).then((next) => { if (live) setAgents(next) })
    return () => { live = false }
  }, [machineId])
  return agents
}
