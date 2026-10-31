import { useEffect, useState } from 'react'
import type { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import type { PathCheck, ProvisionPlan } from '../../../../packages/kybern-client/src/types.ts'
import { expandPath } from '../../../../packages/kybern-client/src/provision.ts'

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error)

/** A verdict belongs to an exact source, target and typed folder, including while effects have not run yet. */
export function useProvisionPlan(source: KybernClient | null, projectId: string, machineId: string | null, path: string | null, initial?: ProvisionPlan, retry = 0) {
  const [loaded, setLoaded] = useState<{ source: KybernClient; projectId: string; machineId: string; retry: number; plan: ProvisionPlan | null; error: string } | null>(null)
  const current = loaded?.source === source && loaded?.projectId === projectId && loaded?.machineId === machineId && loaded?.retry === retry
  const base = initial ?? (current ? loaded.plan : null)
  const error = !initial && current ? loaded.error : ''
  const [checked, setChecked] = useState<{ base: ProvisionPlan; path: string; plan: ProvisionPlan | null; check: PathCheck | null } | null>(null)
  useEffect(() => {
    if (initial || !source || !machineId) return
    let live = true
    const save = (plan: ProvisionPlan | null, error = '') => { if (live) setLoaded({ source, projectId, machineId, retry, plan, error }) }
    void source.call('projects.provision_plan', { project_id: projectId, machine: machineId }).then((plan) => save(plan), (error) => save(null, messageOf(error)))
    return () => { live = false }
  }, [source, projectId, machineId, initial, retry])
  const original = !!base && (path === null || expandPath(path, base.target_home, base.target.os) === base.path_check?.path)
  const matching = checked?.base === base && checked?.path === path
  useEffect(() => {
    if (!source || !machineId || !base || path === null || original) return
    let live = true
    const timer = setTimeout(() => {
      void source.call('projects.provision_plan', { project_id: projectId, machine: machineId, path }).then(
        (plan) => { if (live) setChecked({ base, path, plan, check: plan.path_check ?? null }) },
        (error) => { if (live) setChecked({ base, path, plan: null, check: { state: 'forbidden', path, message: messageOf(error) } }) },
      )
    }, 300)
    return () => { live = false; clearTimeout(timer) }
  }, [source, projectId, machineId, base, path, original])
  return {
    plan: original ? base : matching ? checked.plan ?? base : base,
    check: original ? base?.path_check ?? null : matching ? checked.check : null,
    checking: !!base && path !== null && !original && !matching,
    error,
  }
}
