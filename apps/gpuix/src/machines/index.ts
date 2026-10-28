// The app's machine hub and the lookups the rest of GPUIX uses. The hub is made
// on first use from the saved environments; state.ts feeds it the primary
// connection (see hub.ts).
import { useSyncExternalStore } from 'react'
import type { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import type { MergedView } from '../../../../packages/kybern-client/src/machines.ts'
import { localProfile, readRegistry } from '../environments/registry.ts'
import { readCredential } from '../environments/credentials.ts'
import { MachineHub } from './hub.ts'
import { recordsFromRegistry } from './records.ts'

let hub: MachineHub | undefined
export function machineHub(): MachineHub {
  hub ??= new MachineHub({
    records: () => {
      try { return recordsFromRegistry(readRegistry(), localProfile) } catch { return recordsFromRegistry({ selected_id: 'local', environments: [] }, localProfile) }
    },
    readCredential,
  })
  return hub
}
/** Tests: forget the hub so the next use builds a fresh one. */
export function resetMachineHub() { hub?.dispose(); hub = undefined }

/** The merged projects and threads of every machine. Nothing renders from it until N6 step 3. */
export function useMachineView(): MergedView {
  const h = machineHub()
  return useSyncExternalStore(h.subscribe.bind(h), () => h.view())
}
export const clientFor = (machineId: string): KybernClient => machineHub().clientFor(machineId)
export const clientForThread = (threadId: string, machineId?: string): KybernClient => machineHub().clientForThread(threadId, machineId)
export const clientForProject = (projectId: string, machineId?: string): KybernClient => machineHub().clientForProject(projectId, machineId)
