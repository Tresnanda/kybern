// This machine's harness update records (`harness_updates.list`, then `harness_updates.changed`), what the person
// dismissed, and the actions behind the sidebar pill and Settings › Agent providers. Rules live in `model.ts`.
import { useEffect, useSyncExternalStore } from 'react'
import { HARNESS_UPDATES_CHANGED_NOTIFICATION, type HarnessUpdate, type HarnessUpdatesRunAllResult, type ProviderKind } from '../../../../packages/kybern-client/src/types.ts'
import { getClient, requireClient, useApp } from '../state.ts'
import { latestSettings } from '../settings/store.ts'
import { load, save } from '../shell/persist.ts'
import { toast } from '../shell/toasts.tsx'
import { toastProblem } from '../problems/toast.ts'
import { AGENT_NAMES } from '../onboarding/model.ts'
import { dismiss, justUpdated, runAllSummary, updatedText, type Dismissed } from './model.ts'

const DISMISSED_KEY = 'kybern.harnessUpdates.dismissed'

interface State {
  records: HarnessUpdate[]
  dismissed: Dismissed
  /** Kinds whose update this window asked for and has not heard back about yet. */
  starting: ProviderKind[]
  allMachines: boolean
}
let state: State = { records: [], dismissed: {}, starting: [], allMachines: false }
let dismissedLoaded = false
const listeners = new Set<() => void>()
const emit = (patch: Partial<State>) => { state = { ...state, ...patch }; for (const listener of listeners) listener() }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }

export function useHarnessUpdates<T>(pick: (s: State) => T): T {
  if (!dismissedLoaded) { dismissedLoaded = true; state = { ...state, dismissed: load<Dismissed>(DISMISSED_KEY, {}) } }
  return useSyncExternalStore(subscribe, () => pick(state))
}

/** Take a new list; an automatic update that just finished gets one quiet toast. */
export function receive(records: HarnessUpdate[]) {
  const before = state.records
  emit({ records })
  if (before.length === 0 || !latestSettings()?.auto_update_harnesses) return
  const text = updatedText(justUpdated(before, records))
  if (text) toast.success(text, { id: 'harness-updated', description: 'New turns use the new version.' })
}

/** Read the list again (after an action, or for a daemon too old to send `harness_updates.changed`). */
export async function loadHarnessUpdates() {
  const client = getClient()
  if (!client) return
  try { receive((await client.call('harness_updates.list', {})).updates) } catch { /* the next notification or reconnect catches up */ }
}

/** Follow this machine's records while connected. Mount once (`App.tsx`). */
export function HarnessUpdatesFollower() {
  const open = useApp((s) => s.status === 'open')
  useEffect(() => {
    const client = getClient()
    if (!open || !client) return
    // A reconnect starts from the daemon's list, without toasting what changed while away.
    emit({ records: [] })
    void loadHarnessUpdates()
    return client.onNotification(HARNESS_UPDATES_CHANGED_NOTIFICATION, (params) => receive((params as { updates: HarnessUpdate[] }).updates))
  }, [open])
  return null
}

/** Hide the pill until a newer version comes out. */
export function dismissPill() {
  const dismissed = dismiss(state.records, state.dismissed)
  save(DISMISSED_KEY, dismissed)
  emit({ dismissed })
}

/** Update harnesses on this machine. Each one waits until its agent is idle. */
export async function updateHarnesses(kinds: readonly ProviderKind[]) {
  emit({ starting: [...new Set([...state.starting, ...kinds])] })
  try {
    for (const kind of kinds) {
      try {
        await requireClient().call('harness_updates.run', { kind })
      } catch (error) {
        toastProblem(error, { action: `update ${AGENT_NAMES[kind] ?? kind}` })
      }
    }
    await loadHarnessUpdates()
  } finally {
    emit({ starting: state.starting.filter((kind) => !kinds.includes(kind)) })
  }
}

/** "Update on all machines": this machine and every online member, each updating what its own check found. */
export async function updateOnAllMachines(nameOf: (machineId: string) => string, localId: string | undefined): Promise<HarnessUpdatesRunAllResult | null> {
  emit({ allMachines: true })
  try {
    const result = await requireClient().call('harness_updates.run_all', {})
    const summary = runAllSummary(result, nameOf, localId)
    if (summary.started) toast.success(summary.started, { description: 'Each harness updates once its agents are idle.' })
    else if (summary.problems.length === 0) toast.info('Every harness is up to date')
    for (const problem of summary.problems) {
      toast.problem(problem.title, { id: `harness-run-all-${problem.machineId}`, tone: problem.offline ? 'neutral' : 'warning', icon: problem.offline ? 'offline' : 'alert', description: problem.body })
    }
    await loadHarnessUpdates()
    return result
  } catch (error) {
    toastProblem(error, { action: 'update harnesses on your machines' })
    return null
  } finally {
    emit({ allMachines: false })
  }
}
