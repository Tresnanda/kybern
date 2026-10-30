// The skills on every machine (ADE-86): `skills.network_view` read from the machine the user is at, which asks the other
// members. Read while Settings → Skills shows it, and again when the outbox or a machine changes. Copies go to the same
// daemon (`skills.copy`), which forwards one to the machine that sends the skill.
import { useEffect, useSyncExternalStore } from 'react'
import type { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import { NETWORK_MACHINE_CHANGED_NOTIFICATION, OUTBOX_CHANGED_NOTIFICATION, type SkillsCopyParams, type SkillsCopyResult, type SkillsNetworkView } from '../../../../packages/kybern-client/src/types.ts'
import { errorText } from '../nav/actions.ts'
import { getClient } from '../state.ts'

interface SkillsState { view: SkillsNetworkView | null; error: string; loading: boolean }
let state: SkillsState = { view: null, error: '', loading: false }
const listeners = new Set<() => void>()
const emit = (patch: Partial<SkillsState>) => { state = { ...state, ...patch }; for (const listener of listeners) listener() }

/** Native fixtures only (`skills.fixture.tsx`): one in-memory client instead of the app's connection. */
let fixture: (() => KybernClient) | null = null
export function setSkillsFixture(next: typeof fixture) { fixture = next }
export const skillsClient = (): KybernClient | null => fixture?.() ?? getClient()

let reading = false
let again = false
export async function refreshSkills(): Promise<void> {
  const client = skillsClient()
  if (!client || (!fixture && client.status !== 'open')) return
  if (reading) { again = true; return }
  reading = true
  if (!state.view) emit({ loading: true })
  try {
    do {
      again = false
      try {
        const view = await client.call('skills.network_view', {})
        if (skillsClient() !== client) return
        emit({ view, error: '', loading: false })
      } catch (e) {
        if (skillsClient() === client) emit({ error: `Unable to read your skills. ${errorText(e)}`, loading: false })
      }
    } while (again)
  } finally { reading = false }
}

export async function copySkill(params: SkillsCopyParams): Promise<SkillsCopyResult> {
  const client = skillsClient()
  if (!client) throw new Error('Kybern is not connected. Check the connection and try again.')
  const result = await client.call('skills.copy', params)
  void refreshSkills()
  return result
}

export function useSkillsView(): SkillsState {
  const current = useSyncExternalStore((fn) => { listeners.add(fn); return () => { listeners.delete(fn) } }, () => state)
  useEffect(() => {
    const client = skillsClient()
    void refreshSkills()
    if (!client) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const soon = () => { clearTimeout(timer); timer = setTimeout(() => void refreshSkills(), 400) }
    const stops = [client.onNotification(OUTBOX_CHANGED_NOTIFICATION, soon), client.onNotification(NETWORK_MACHINE_CHANGED_NOTIFICATION, soon)]
    return () => { clearTimeout(timer); for (const stop of stops) stop() }
  }, [])
  return current
}
