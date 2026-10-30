import type { BrokerCandidate } from '../../../../packages/kybern-client/src/loginBroker.ts'
import type { NetworkStatus } from '../../../../packages/kybern-client/src/types.ts'
import type { MachineRow } from '../machines/index.ts'

/** The daemon's membership answer is authoritative even before the hub finishes connecting new members. */
export function loginBrokerCandidates(machines: readonly MachineRow[], status: NetworkStatus | null): BrokerCandidate[] {
  if (status) {
    if (!status.enabled || status.removed) return []
    return status.members.map((member) => ({
      machineId: member.machine_id,
      name: member.name,
      online: member.status === 'online' || member.status === 'relaying',
      features: member.features ?? [],
    }))
  }
  return machines.filter((machine) => machine.member).map((machine) => ({
    machineId: machine.machineId, name: machine.name, online: !machine.offline, features: [],
  }))
}
