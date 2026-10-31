import type { PreviewServer, PreviewServersListResult } from '../../../../packages/kybern-client/src/types.ts'
import type { LogicalProject } from '../../../../packages/kybern-client/src/machineMerge.ts'

export interface ServerMachine { machineId: string; name: string; isLocal: boolean; offline: boolean; roots?: string[]; threadId?: string }
export interface MachineServers { machine: ServerMachine; servers: PreviewServer[]; phase: 'loading' | 'ready' | 'offline' | 'error'; error?: string }
export type DiscoveredServer = PreviewServer & { machine: ServerMachine }

/** Project identities come from the machine hub; folder names alone never imply the same repository. */
export function projectRootsOnMachines(projects: readonly LogicalProject[], projectId: string | undefined, owner: string | undefined): Map<string, string[]> {
  const logical = projects.find(project => project.instances.some(instance => instance.project.id === projectId && instance.machineId === owner))
  const roots = new Map<string, string[]>()
  for (const instance of logical?.instances ?? []) {
    const paths = roots.get(instance.machineId) ?? []
    if (!paths.includes(instance.project.path)) paths.push(instance.project.path)
    roots.set(instance.machineId, paths)
  }
  return roots
}
function within(cwd: string, root: string): boolean {
  // Windows drive/UNC paths compare without case; Unix paths retain their case.
  const windows = /^[a-z]:[/\\]/i.test(root) || /^[/\\]{2}/.test(root)
  const normalize = (path: string) => {
    const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
    return windows ? normalized.toLowerCase() : normalized
  }
  const path = normalize(cwd), base = normalize(root)
  return !!base && (path === base || path.startsWith(`${base}/`))
}

/** Equal ports on separate machines must remain independently addressable by native checks. */
export const serverTestId = (server: Pick<DiscoveredServer, 'machine' | 'port'>): string => `preview-server-${server.machine.machineId}-${server.port}`
export function discoveredServers(results: readonly MachineServers[], machineId?: string): DiscoveredServer[] {
  return results.filter(result => !machineId || result.machine.machineId === machineId).flatMap(result => result.servers.map(server => ({
    ...server, machine: result.machine,
    in_project: !!server.in_project || !!server.cwd && !!result.machine.roots?.some(root => within(server.cwd!, root)),
  }))).sort((a, b) => Number(!!b.in_project) - Number(!!a.in_project) || a.machine.name.localeCompare(b.machine.name) || a.port - b.port || a.url.localeCompare(b.url))
}

/** A bounded work queue publishes each reply immediately. Fast machines poll independently of slower ones.
 * The caller gives each RPC a deadline; stopping drops replies and never starts queued or subsequent scans. */
export function startServerDiscovery(machines: readonly ServerMachine[], query: (machine: ServerMachine) => Promise<PreviewServersListResult>, update: (results: MachineServers[]) => void, options: { concurrency?: number; pollMs?: number } = {}): () => void {
  const results: MachineServers[] = machines.map(machine => ({ machine, servers: [], phase: machine.offline ? 'offline' : 'loading' }))
  const queue = results.filter(result => !result.machine.offline)
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const concurrency = Math.max(1, options.concurrency ?? 4), pollMs = options.pollMs ?? 3000
  let live = true, active = 0
  const publish = () => { if (live) update(results.map(result => ({ ...result }))) }
  const pump = () => {
    while (live && active < concurrency && queue.length) {
      const result = queue.shift()!
      active++
      void Promise.resolve().then(() => { if (!live) throw Error('Discovery stopped'); return query(result.machine) }).then(reply => {
        result.servers = reply.servers; result.phase = 'ready'; result.error = undefined
      }, error => {
        // A failed refresh must not present a stale endpoint as a running server.
        result.servers = []; result.phase = 'error'; result.error = error instanceof Error ? error.message : String(error)
      }).finally(() => {
        active--
        if (!live) return
        publish()
        const timer = setTimeout(() => { timers.delete(timer); queue.push(result); pump() }, pollMs)
        timers.add(timer)
        pump()
      })
    }
  }
  publish(); pump()
  return () => { live = false; queue.length = 0; for (const timer of timers) clearTimeout(timer); timers.clear() }
}
