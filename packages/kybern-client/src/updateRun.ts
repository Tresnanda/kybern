import type { DaemonUpdate, MachineCard, NetworkUpdateAllResult } from './types.ts'

export type UpdatePhase = 'checking' | 'waiting' | 'downloading' | 'installing' | 'restarting' | 'updated' | 'failed' | 'skipped' | 'legacy'
export interface UpdateRow {
  machineId: string
  name: string
  phase: UpdatePhase
  currentVersion: string
  targetVersion?: string
  updateId?: string
  previousId?: string
  startedAt: number
  text: string
  progress?: number
}
export type UpdateRun = Record<string, UpdateRow>
const active = new Set<UpdatePhase>(['checking', 'waiting', 'downloading', 'installing', 'restarting'])
export const isUpdating = (row: UpdateRow) => active.has(row.phase)

/** Synchronous optimistic feedback precedes the request on every client. */
export function beginUpdate(machines: readonly MachineCard[], now = Date.now(), previous: UpdateRun = {}): UpdateRun {
  const run = { ...previous }
  for (const m of machines) run[m.machine_id] = {
    machineId: m.machine_id, name: m.name, phase: 'checking', currentVersion: m.version ?? '',
    previousId: m.update?.update_id ?? undefined,
    updateId: m.update && ['checking', 'waiting', 'updating', 'restarting'].includes(m.update.status) ? m.update.update_id ?? undefined : undefined,
    startedAt: now, text: 'Checking…',
  }
  return run
}

function progress(row: UpdateRow, update: DaemonUpdate): UpdateRow {
  const targetVersion = update.target_version ?? undefined
  const base = { ...row, updateId: update.update_id ?? undefined, currentVersion: update.current_version, targetVersion, progress: undefined }
  switch (update.status) {
    case 'current': {
      if (!targetVersion && row.phase !== 'restarting') return { ...base, phase: 'skipped', text: `Already on ${update.current_version}` }
      const matched = !!update.update_id && (!row.updateId || row.updateId === update.update_id)
        && !!targetVersion && (!row.targetVersion || row.targetVersion === targetVersion) && targetVersion === update.current_version
      return matched ? { ...base, phase: 'updated', text: `Updated to ${targetVersion}` }
        : { ...base, phase: 'failed', text: 'The requested version did not start. Retry the update.' }
    }
    case 'failed': return { ...base, phase: 'failed', text: 'Unable to finish the update. Retry the update.' }
    case 'unsupported': return { ...base, phase: 'skipped', text: update.message || 'Update from this machine' }
    case 'waiting': return { ...base, phase: 'waiting', text: update.busy_thread ? `Waiting for “${update.busy_thread}”` : 'Waiting for running work' }
    case 'restarting': return { ...base, phase: 'restarting', text: 'Restarting…' }
    case 'updating': {
      const downloading = update.download_percent != null || update.message.startsWith('Downloading')
      return { ...base, phase: downloading ? 'downloading' : 'installing',
        progress: update.download_percent ?? undefined,
        text: downloading ? `Downloading${update.download_percent == null ? '…' : ` · ${update.download_percent}%`}` : 'Installing…' }
    }
    default: return { ...base, phase: 'checking', text: 'Checking…' }
  }
}

/** Presence is authoritative; an offline cached presence never completes or fails a restart. */
export function reconcileUpdates(run: UpdateRun, machines: readonly MachineCard[], now = Date.now()): UpdateRun {
  const next = { ...run }
  for (const machine of machines) {
    const update = machine.update
    if (!update?.update_id || machine.status === 'offline') continue
    const old = next[machine.machine_id]
    if (old?.previousId === update.update_id && !old.updateId) continue
    if (old?.phase === 'restarting' && old.updateId !== update.update_id) continue
    // A later attempt observed after navigation starts a fresh target contract.
    const sameAttempt = old && (!old.updateId || old.updateId === update.update_id)
    const row = (sameAttempt ? old : undefined) ?? { machineId: machine.machine_id, name: machine.name, phase: 'checking',
      currentVersion: machine.version ?? '', startedAt: now, text: 'Checking…' }
    next[machine.machine_id] = progress(row, update.status === 'current' && machine.version !== update.current_version
      ? { ...update, status: 'failed' } : update)
  }
  return next
}

/** Older members keep their honest one-shot answer; acceptance never means completion. */
export function acceptUpdates(run: UpdateRun, result: NetworkUpdateAllResult, machines: readonly MachineCard[]): UpdateRun {
  const next = { ...run }
  for (const id of result.started) {
    const row = next[id]
    if (!row || row.phase !== 'checking' || row.updateId) continue
    const live = machines.find(m => m.machine_id === id)?.features?.includes('update.progress.v1')
    next[id] = { ...row, phase: live ? 'checking' : 'legacy', text: live ? 'Checking…' : 'Update started' }
  }
  for (const skip of result.skipped) {
    const row = next[skip.machine_id]
    if (!row || row.updateId) continue
    const version = machines.find(m => m.machine_id === skip.machine_id)?.version
    next[skip.machine_id] = { ...row, phase: 'skipped', text: skip.reason === 'Already up to date' && version ? `Already on ${version}` : skip.reason }
  }
  return next
}

export function updateRunSummary(run: UpdateRun, now = Date.now()): string {
  const rows = Object.values(run), busy = rows.filter(isUpdating)
  if (busy.length) {
    const slowest = busy.reduce((a,b) => a.startedAt <= b.startedAt ? a : b)
    return now - slowest.startedAt >= 180_000 ? `Waiting for ${slowest.name}…` : `Updating ${busy.length} ${busy.length === 1 ? 'machine' : 'machines'}…`
  }
  const failed = rows.filter(r => r.phase === 'failed').length
  if (failed) return `${failed} ${failed === 1 ? 'machine needs' : 'machines need'} a retry`
  const version = rows[0]?.currentVersion
  if (version && rows.every(r => r.currentVersion === version && (r.phase === 'updated' || r.text === `Already on ${version}`))) return `All machines on ${version}`
  if (rows.some(r => r.phase === 'legacy')) return 'Updates started'
  return rows.some(r => r.phase === 'updated') ? 'Updates finished' : 'No updates needed'
}

export const saveUpdateRun = (run: UpdateRun): string => JSON.stringify({ version: 1, rows: Object.values(run) })
export function restoreUpdateRun(serialized: string | null): UpdateRun {
  try {
    const value = JSON.parse(serialized ?? 'null')
    if (value?.version !== 1 || !Array.isArray(value.rows) || value.rows.length > 256) return {}
    const run: UpdateRun = {}
    for (const row of value.rows) {
      if (!row || typeof row.machineId !== 'string' || typeof row.name !== 'string' || typeof row.text !== 'string'
        || typeof row.currentVersion !== 'string' || !Number.isFinite(row.startedAt)
        || ![...active,'updated','failed','skipped','legacy'].includes(row.phase)) return {}
      if ([row.targetVersion, row.updateId, row.previousId].some(v => v !== undefined && typeof v !== 'string')) return {}
      if (row.progress !== undefined && (!Number.isFinite(row.progress) || row.progress < 0 || row.progress > 100)) return {}
      if (row.machineId === '__proto__' || row.machineId === 'constructor') return {}
      run[row.machineId] = row
    }
    return run
  } catch { return {} }
}

/** One store per client, outside page lifetime. Writes serialize so a slow save cannot overwrite a restart. */
export class UpdateRunStore {
  private run: UpdateRun = {}
  private listeners = new Set<() => void>()
  private writes: Promise<void> = Promise.resolve()
  private touched = new Set<string>()
  private persist?: (value: string) => Promise<void>
  constructor(persist?: (value: string) => Promise<void>) { this.persist = persist }
  get = (): UpdateRun => this.run
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  hydrate(serialized: string | null) {
    const saved = restoreUpdateRun(serialized)
    for (const id of this.touched) delete saved[id]
    this.publish({ ...saved, ...this.run })
  }
  private publish(next: UpdateRun) {
    if (JSON.stringify(next) === JSON.stringify(this.run)) return
    this.run = next
    for (const fn of this.listeners) fn()
    if (this.persist) {
      const value = saveUpdateRun(next)
      this.writes = this.writes.catch(() => {}).then(() => this.persist!(value))
      // A failure does not crash the client. The next status change retries saving.
      void this.writes.catch(() => {})
    }
  }
  begin(machines: readonly MachineCard[], now = Date.now()) {
    for (const m of machines) this.touched.add(m.machine_id)
    this.publish(beginUpdate(machines, now, this.run))
  }
  reconcile(machines: readonly MachineCard[], now = Date.now()) {
    const next = reconcileUpdates(this.run, machines, now)
    for (const id of Object.keys(next)) if (next[id] !== this.run[id]) this.touched.add(id)
    this.publish(next)
  }
  accept(result: NetworkUpdateAllResult, machines: readonly MachineCard[]) { this.publish(acceptUpdates(this.run, result, machines)) }
  fail(ids: readonly string[]) {
    const next = { ...this.run }
    for (const id of ids) if (next[id]?.phase === 'checking' && !next[id].updateId)
      next[id] = { ...next[id], phase: 'failed', text: 'Unable to start the update. Check the connection and retry.' }
    this.publish(next)
  }
}


