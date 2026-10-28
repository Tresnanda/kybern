// Notes and tasks of every machine in one list (design §9.2). `machine: "all"` asks the machine the user is at, which merges
// what the online members hold and says which ids each contributed. A note or task of another machine is read here but written
// where it lives: its owner is remembered from the sections, and edits go to that machine's client.
import { MACHINE_ALL, type Federation, type MachineId } from '../../../../packages/kybern-client/src/types.ts'
import type { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import { machineHub } from './index.ts'

export { MACHINE_ALL }
type Kind = 'notes' | 'tasks'
const owners: Record<Kind, Map<string, { id: MachineId; name: string }>> = { notes: new Map(), tasks: new Map() }

/** Remember which machine holds each id of a merged list; ids of this machine are not tracked (they are written as always). */
export function recordFederation(kind: Kind, federation: Federation | null | undefined) {
  owners[kind].clear()
  for (const section of federation?.sections ?? []) if (!section.is_self) for (const id of section.ids) owners[kind].set(id, { id: section.machine_id, name: section.machine_name })
}
/** The machine that holds a note or task of another machine, or `undefined` for one of this machine. */
export function foreignOwner(kind: Kind, id: string | undefined): { id: MachineId; name: string } | undefined { return id ? owners[kind].get(id) : undefined }
/** The client to write an item with: its owner's, else `fallback`. Throws `OfflineError` while the owner is away. */
export function ownerClient(kind: Kind, id: string | undefined, fallback: () => KybernClient | null): KybernClient | null {
  const owner = foreignOwner(kind, id)
  return owner ? machineHub().clientFor(owner.id) : fallback()
}
/** Tests: forget every owner. */
export function resetFederated() { owners.notes.clear(); owners.tasks.clear() }
