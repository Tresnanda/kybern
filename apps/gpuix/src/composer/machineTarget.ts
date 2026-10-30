// Where the composer's next new chat runs (design §6.1, Q35). With one machine none of this costs anything: `useMachineTarget`
// answers a shared, frozen "this machine" and the composer looks as it always did. With several, it works out the picker's rows,
// the default (the last machine used for the project, else the machine you are at) and the machine's own agent lists.
import { useEffect, useMemo } from 'react'
import {
  machineChoices, machineMemoryKey, machineReachable, resolveMachine, showMachinePicker, type MachineChoice,
} from '../../../../packages/kybern-client/src/machineTarget.ts'
import type { MachineId, ProjectId } from '../../../../packages/kybern-client/src/types.ts'
import { machineHub, useMachines } from '../machines/index.ts'
import { getFocusedPaneId, useApp } from '../state.ts'
import { getData, loadMachineLists, patchDraft, useComposer, type RemoteLists } from './store.ts'

export interface MachineTarget {
  /** Show the picker chip: there is a real choice. */
  show: boolean
  choices: readonly MachineChoice[]
  /** The machine the next chat goes to; unset with one machine. */
  chosen?: MachineChoice
  /** The chosen machine, or `undefined` for the one the user is at (the common case). */
  machineId?: MachineId
  /** The chat is made on another machine (even without a picker: a project only that machine has). */
  remote: boolean
  /** The chosen machine can be reached now; if not, the send waits in the outbox. */
  reachable: boolean
  /** The key the pick is remembered under: the logical project, or the free chat's. */
  key: string
}

const SOLO: MachineTarget = Object.freeze({ show: false, choices: [], remote: false, reachable: true, key: 'free' })

/** `projectId` is the listed project (the machine you are at's when it has one); `null` is a free chat. */
export function useMachineTarget(projectId: ProjectId | null | undefined, enabled = true): MachineTarget {
  const rows = useMachines()
  const picked = useComposer((d) => d.draft.machines)
  // A project's checkouts change with the lists; re-derive when they do.
  const projects = useApp((s) => s.projects)
  return useMemo(() => {
    if (!enabled || rows.length < 2) return SOLO
    const logical = projectId ? machineHub().view().projects.find((item) => item.instances.some((instance) => instance.project.id === projectId)) ?? null : null
    // A project the merged view does not know yet must not read as a free chat.
    if (projectId && !logical) return SOLO
    const choices = machineChoices({ machines: rows, project: logical })
    const key = machineMemoryKey(logical)
    const chosen = resolveMachine(choices, picked?.[key], picked?.[key])
    if (!chosen) return { ...SOLO, key }
    return {
      show: showMachinePicker(choices, logical),
      choices,
      chosen,
      ...(chosen.isLocal ? {} : { machineId: chosen.machineId }),
      remote: !chosen.isLocal,
      reachable: chosen.state === 'online',
      key,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, projectId, picked, projects, enabled])
}

/** Pick (and so remember) the machine for a project's next chats. */
export function chooseMachine(key: string, machineId: MachineId, paneId = getFocusedPaneId()) {
  // A branch picked from one machine's list means nothing on another's.
  patchDraft({ machines: { ...getData(paneId).draft.machines, [key]: machineId }, baseBranch: null }, paneId)
}

const NO_PROVIDERS: RemoteLists['providers'] = []
const NO_ACCOUNTS: RemoteLists['accounts'] = []

/**
 * The agents, accounts and settings the composer offers for a machine: the machine you are at reads the composer's own, another
 * machine's come from that machine (`providers.list` there), so changing the machine changes the harness and model chips.
 */
export function useMachineLists(machineId: MachineId | undefined) {
  const providers = useComposer((d) => (machineId ? d.remote[machineId]?.providers ?? NO_PROVIDERS : d.providers))
  const accounts = useComposer((d) => (machineId ? d.remote[machineId]?.accounts ?? NO_ACCOUNTS : d.accounts))
  const settings = useComposer((d) => (machineId ? d.remote[machineId]?.settings ?? null : d.settings))
  const loading = useComposer((d) => (machineId ? d.remote[machineId]?.loading ?? false : d.providersLoading))
  const loaded = useComposer((d) => (machineId ? d.remote[machineId]?.loaded ?? false : true))
  const status = useMachines().find((row) => row.machineId === machineId)?.status
  const reachable = status ? machineReachable(status) : false
  useEffect(() => {
    if (machineId && reachable) void loadMachineLists(machineId)
  }, [machineId, reachable])
  return { providers, accounts, settings, loading, loaded }
}
