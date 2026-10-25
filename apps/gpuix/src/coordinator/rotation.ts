// Coordinator context refresh in the GPUIX client: the calls (`coordinator.refresh_context`, `coordinator.edit_handoff`),
// what the open thread says about its latest rotation, and the budget in force. The words and arithmetic are shared
// (`packages/kybern-client/src/rotation.ts`); the transcript row is `transcript/Rotation.tsx`.
import type { Block } from '../../../../packages/kybern-client/src/transcript.ts'
import { effectiveCoordinatorSettings } from '../../../../packages/kybern-client/src/coordinatorSettings.ts'
import { effectiveRotationBudget, ROTATION_COPY } from '../../../../packages/kybern-client/src/rotation.ts'
import type { Settings, Thread } from '../../../../packages/kybern-client/src/types.ts'
import { useComposer } from '../composer/store.ts'
import { getClient, useApp } from '../state.ts'
import { reportError } from '../transcript/store.ts'

export type RotationBlock = Extract<Block, { kind: 'rotation' }>

/** The newest rotation in the loaded blocks, looking back `within` blocks at most. A pending one is always the newest, so the scan stops at the first it meets. */
export function latestRotation(blocks: readonly Block[], within = blocks.length): RotationBlock | undefined {
  for (let i = blocks.length - 1; i >= Math.max(0, blocks.length - within); i--) {
    const block = blocks[i]!
    if (block.kind === 'rotation') return block
  }
  return undefined
}

/** The id of the open thread's latest rotation: the only one whose handoff can still be edited. */
export const useLatestRotationId = (): string | null => useApp((s) => latestRotation(s.open.blocks)?.id ?? null)

/** How far back a pending refresh is looked for: it is the newest block, and a store update must not scan a long thread. */
const PENDING_WINDOW = 64

/** A refresh is under way: the old session is writing its handoff, and sends queue until it ends. `enabled` is false off a Coordinator thread (no scan). */
export const useRotationPending = (enabled = true): boolean => useApp((s) => enabled && (latestRotation(s.open.blocks, PENDING_WINDOW)?.pending ?? false))

/** Start a refresh now. The daemon refuses it while a turn runs; the refusal is shown as the transcript's action error. */
export async function refreshContext(threadId: string): Promise<boolean> {
  try {
    await getClient()!.call('coordinator.refresh_context', { thread_id: threadId })
    return true
  } catch (error) {
    reportError(ROTATION_COPY.refreshFailed, error)
    return false
  }
}

/** Replace the latest rotation's handoff. Resolves false (with the error shown) when the daemon refuses. */
export async function editHandoff(threadId: string, rotationId: string, text: string): Promise<string | null> {
  try {
    await getClient()!.call('coordinator.edit_handoff', { thread_id: threadId, rotation_id: rotationId, text })
    return null
  } catch (error) {
    return `${ROTATION_COPY.editFailed}. ${error instanceof Error ? error.message : String(error)}`
  }
}

/** The settings the composer already holds, for the global budget. */
const useGlobalSettings = (): Settings | null => useComposer((s) => s.settings) ?? null

/** The budget in force for a Coordinator thread (project override, then Settings, then 200k); 0 is off. Null for any other thread. */
export function useRotationBudget(thread: Thread | null | undefined): number | null {
  const global = useGlobalSettings()
  const project = useApp((s) => (thread?.coordinator_project_id ? s.projects.find((p) => p.id === thread.coordinator_project_id) : undefined))
  if (!thread?.coordinator_project_id) return null
  return effectiveCoordinatorSettings(global?.orchestration, project?.coordinator).rotation_budget_tokens ?? 0
}

/** The size at which the daemon refreshes this thread, with the model's window in mind; null off a Coordinator, 0 when off. */
export function useRefreshPoint(thread: Thread | null | undefined, windowTokens: number | null | undefined): number | null {
  const budget = useRotationBudget(thread)
  return budget === null ? null : effectiveRotationBudget(budget, windowTokens)
}
