// The Projects scene's state, at module level: scenes mount and unmount as the flow moves, but a scan keeps running when the user
// goes Back, and an import keeps running after Continue. The scan, the selection, the import mode and the import job live here;
// the scene only draws them. `getClient()` is bound once per daemon connection (notifications: `sessions.scan.changed`,
// `sessions.import.progress`, `sessions.import.finished`).
import type { ProjectId, SessionsImportFinished, SessionsImportJob, SessionsImportProgress, SessionsScan, SessionsScanChanged } from '../../../../packages/kybern-client/src/types.ts'
import {
  SESSIONS_IMPORT_FINISHED_NOTIFICATION, SESSIONS_IMPORT_PROGRESS_NOTIFICATION, SESSIONS_SCAN_CHANGED_NOTIFICATION,
} from '../../../../packages/kybern-client/src/types.ts'
import { showDialog } from '../dialogs/store.ts'
import { activeEnvironment } from '../shell/environment.ts'
import { REDUCED_MOTION } from '../platform/reducedMotion.ts'
import { getClient, getState, subscribe as subscribeApp } from '../state.ts'
import { createStore } from './store.ts'
import { type ImportMode } from './model.ts'
import {
  EMPTY_SUMMARY, MAX_IMPORT_ROOTS, addedRow, appendSkips, applyJob, applyProgress, entriesFor, flipDeltas, importRoots, newSuggested, overallProgress, reconcileRows,
  splitRows, startImports, summarize, toRequestRoot, wave, type ImportRootPlan, type ImportSummary, type ListShape, type Row, type RootImport, type SkipDetail,
} from './projects.ts'

export type { ImportSummary } from './projects.ts'

export type ScanStatus = 'idle' | 'scanning' | 'done' | 'failed'
export type Group = 'suggested' | 'others'

/** A row that arrived in the latest batch plays its drop-in until `until` (a remount later does not replay it). */
export interface Arrival { order: number; until: number; /** Seconds between rows. */ step: number }
/** A row that moved to make room slides from `dy` px away until `until`. */
export interface Flip { dy: number; at: number; until: number }

interface PState {
  /** `startScan()` ran for this flow run. */
  started: boolean
  status: ScanStatus
  /** The scan call itself failed (not one harness). */
  scanError: string | null
  scanId: string | null
  scan: SessionsScan | null
  /** Folders added with "Choose a folder", newest first. */
  added: Row[]
  suggested: Row[]
  others: Row[]
  hidden: number
  selected: ReadonlySet<string>
  /** Suggested roots already considered for the pre-check. */
  seen: ReadonlySet<string>
  mode: ImportMode
  /** Bumps on every mode change: rows rewrite their count line top to bottom. */
  modeGen: number
  othersOpen: boolean
  arrivals: Record<string, Arrival>
  flips: Record<string, Flip>
  /** Bumps when the list should scroll to its top (a folder was added). */
  topGen: number
  /** The import: null until the primary is pressed with something checked. Its controls lock from then on. */
  job: { id: string | null; phase: 'running' | 'done' } | null
  importError: string | null
  /** The mode the import ran with. */
  importMode: ImportMode | null
  plan: ImportRootPlan[]
  imports: Record<string, RootImport>
  skips: SkipDetail[]
  /** Overall import progress, 0…1. */
  progress: number
  summary: ImportSummary
}

const initial = (): PState => ({
  started: false, status: 'idle', scanError: null, scanId: null, scan: null, added: [], suggested: [], others: [], hidden: 0, selected: new Set(), seen: new Set(),
  mode: 'latest', modeGen: 0, othersOpen: false, arrivals: {}, flips: {}, topGen: 0, job: null, importError: null, importMode: null, plan: [], imports: {}, skips: [], progress: 0,
  summary: EMPTY_SUMMARY,
})

export const projectsStore = createStore<PState>(initial())
export const useProjects = projectsStore.use
const get = projectsStore.get
const set = projectsStore.set

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

// ─── Derived ──────────────────────────────────────────────────────────────

export const isLocked = (s: Pick<PState, 'job'>) => s.job !== null
/** Every visible row. */
export const allRows = (s: Pick<PState, 'suggested' | 'others'>): Row[] => [...s.suggested, ...s.others]

export const shapeOf = (s: Pick<PState, 'suggested' | 'others' | 'othersOpen' | 'hidden' | 'status'>): ListShape => ({
  suggested: s.suggested.map((r) => r.root), others: s.others.map((r) => r.root), othersOpen: s.othersOpen, hidden: s.hidden,
  skeleton: s.suggested.length === 0 && s.others.length === 0 && s.status === 'scanning',
})

/** Nothing to bring in: the scan is over and found no project that still exists. */
export const isEmptyScan = (s: Pick<PState, 'suggested' | 'others' | 'status'>) => s.status === 'done' && s.suggested.length === 0 && s.others.length === 0

// ─── Scan ─────────────────────────────────────────────────────────────────

let scanToken = 0
let cancelWhenKnown = false
type Client = NonNullable<ReturnType<typeof getClient>>
/** The daemon connection; tests swap in a fake. */
let clientSource: () => Client | null = () => getClient()
export function setClientSourceForTests(source: (() => Client | null) | null) { clientSource = source ?? (() => getClient()) }
let bound: { client: Client; stop: (() => void)[] } | null = null
const finishedListeners = new Set<(summary: ImportSummary) => void>()
let timers: ReturnType<typeof setTimeout>[] = []
let stopRemoteWatch: (() => void) | null = null

function unbind() {
  if (!bound) return
  for (const stop of bound.stop) stop()
  bound = null
}

function bind(client: Client) {
  if (bound?.client === client) return
  unbind()
  bound = {
    client,
    stop: [
      client.onNotification(SESSIONS_SCAN_CHANGED_NOTIFICATION, (params) => { const scan = (params as SessionsScanChanged | null)?.scan; if (scan) applyScan(scan) }),
      client.onNotification(SESSIONS_IMPORT_PROGRESS_NOTIFICATION, (params) => { if (params) onProgress(params as SessionsImportProgress) }),
      client.onNotification(SESSIONS_IMPORT_FINISHED_NOTIFICATION, (params) => { const job = (params as SessionsImportFinished | null)?.job; if (job) onJob(job) }),
    ],
  }
}

/** Recompute the rows from a scan and the added folders; the one place rows change. Settled rows keep their identity, new rows arrive pre-checked and dropped in, and the rows under them slide. */
function commitRows(scan: SessionsScan | null, added: Row[], extra: Partial<PState> = {}) {
  const s = get()
  const split = splitRows(scan?.projects ?? [], added)
  const suggested = reconcileRows(s.suggested, split.suggested)
  const others = reconcileRows(s.others, split.others)
  const { fresh, seen } = newSuggested(s.seen, suggested)
  const merged = { ...s, ...extra }
  const next = { suggested, others, hidden: split.hidden, othersOpen: merged.othersOpen, status: merged.status }
  const before = new Set(allRows(s).map((r) => r.root))
  const now = Date.now()
  const shownBefore = entriesFor(shapeOf(s))
  const shownAfter = entriesFor(shapeOf(next))
  const visible = new Set(shownAfter.flatMap((e) => (e.root ? [e.root] : [])))
  const arrivals: Record<string, Arrival> = {}
  let order = 0
  for (const row of [...suggested, ...others]) {
    if (before.has(row.root) || !visible.has(row.root)) continue
    arrivals[row.root] = { order: Math.min(order++, 10), until: now + 1600, step: 0.06 }
  }
  const deltas = flipDeltas(shownBefore, shownAfter)
  const flips: Record<string, Flip> = {}
  for (const [key, dy] of Object.entries(deltas)) flips[key] = { dy, at: now, until: now + 900 }
  const patch: Partial<PState> = { suggested, others, hidden: split.hidden, ...extra, seen: new Set([...seen, ...(extra.seen ?? [])]) }
  if (Object.keys(arrivals).length > 0) patch.arrivals = { ...s.arrivals, ...arrivals }
  if (Object.keys(flips).length > 0) patch.flips = flips
  // Rows that arrive during an import are listed but not pre-checked: the selection is frozen.
  if (fresh.length > 0 && !isLocked(s)) patch.selected = new Set([...(extra.selected ?? s.selected), ...fresh])
  set(patch)
}

function applyScan(scan: SessionsScan) {
  const s = get()
  if (s.scanId && scan.scan_id !== s.scanId) return
  commitRows(scan, s.added, { scan, scanId: scan.scan_id, status: scan.state === 'running' ? 'scanning' : 'done', scanError: null })
  if (cancelWhenKnown && scan.state === 'running') requestCancel(scan.scan_id)
}

function requestCancel(scanId: string) {
  cancelWhenKnown = false
  void clientSource()?.call('sessions.scan_cancel', { scan_id: scanId }).catch(() => undefined)
}

function begin(force: boolean) {
  const s = get()
  if (s.started && !force) return
  const client = clientSource()
  if (!client) { set({ started: false, status: 'failed', scanError: 'Kybern isn’t connected. Reconnect, then scan again.' }); return }
  bind(client)
  const token = ++scanToken
  cancelWhenKnown = false
  set({ started: true, status: 'scanning', scanError: null, scanId: null })
  client.call('sessions.scan_projects', {}).then(
    (scan) => { if (token === scanToken) applyScan(scan) },
    (error) => { if (token === scanToken) set({ status: 'failed', scanError: errorText(error) }) },
  )
}

/** Start the chat-history scan once per flow run. Safe to call again (the Agents scene may start it early). */
export function startScan(): void { begin(false) }
/** "Scan again": a new scan; the selection and added folders stay. */
export function rescan(): void { begin(true) }

/** Stop a running scan (the free-chat path and finishing the flow). Leaving the scene does not call this. */
export function cancelScan(): void {
  const s = get()
  if (s.status !== 'scanning') return
  scanToken++
  if (s.scanId) requestCancel(s.scanId)
  else cancelWhenKnown = true
  set({ status: 'done' })
}

/** A fresh flow run: forget everything (the next `startScan()` scans again). Import-finished listeners stay. */
export function resetProjects(): void {
  scanToken++
  cancelWhenKnown = false
  unbind()
  for (const timer of timers) clearTimeout(timer)
  timers = []
  stopRemoteWatch?.()
  stopRemoteWatch = null
  projectsStore.reset(initial())
}

// ─── Selection and mode ───────────────────────────────────────────────────

export function setMode(mode: ImportMode): void {
  const s = get()
  if (isLocked(s) || s.mode === mode) return
  set({ mode, modeGen: s.modeGen + 1 })
}

export function toggleRow(root: string): void {
  const s = get()
  if (isLocked(s)) return
  const next = new Set(s.selected)
  if (next.has(root)) next.delete(root)
  else if (next.size < MAX_IMPORT_ROOTS) next.add(root)
  set({ selected: next })
}

export function toggleOthers(): void {
  const s = get()
  const open = !s.othersOpen
  commitRows(s.scan, s.added, { othersOpen: open })
  if (!open) return
  // The rows come into the list at once; the first ones step in, 35 ms apart, so it reads as opening.
  const now = Date.now()
  const arrivals = { ...get().arrivals }
  get().others.slice(0, 10).forEach((row, order) => { arrivals[row.root] = { order, until: now + 1200, step: 0.035 } })
  set({ arrivals })
}

/** Select all / Clear for one section. The boxes tick in a wave, 35 ms apart down the list (the first 16 rows; the rest follow together). */
export function selectGroup(group: Group, value: boolean): void {
  const s = get()
  if (isLocked(s)) return
  for (const timer of timers) clearTimeout(timer)
  timers = []
  const roots = (group === 'suggested' ? s.suggested : s.others).map((r) => r.root)
  const apply = (batch: string[]) => {
    const next = new Set(get().selected)
    for (const root of batch) {
      if (!value) next.delete(root)
      else if (next.size < MAX_IMPORT_ROOTS) next.add(root)
    }
    set({ selected: next })
  }
  if (REDUCED_MOTION) { apply(roots); return }
  const steps = new Map<number, string[]>()
  for (const { root, at } of wave(roots)) steps.set(at, [...(steps.get(at) ?? []), root])
  for (const [at, batch] of steps) {
    if (at === 0) apply(batch)
    else timers.push(setTimeout(() => { if (!isLocked(get())) apply(batch) }, at))
  }
}

// ─── Choose a folder ──────────────────────────────────────────────────────

/** Insert a folder at the top of Suggested, checked: no past chats, imported with limit 0 so it still becomes a project. */
export function addFolder(path: string, projectId: ProjectId | null = null): void {
  const s = get()
  if (isLocked(s)) return
  const root = path.length > 1 ? path.replace(/[\\/]+$/, '') : path
  const existing = allRows(s).find((r) => r.root === root)
  if (existing) {
    const selected = new Set(s.selected)
    if (selected.size < MAX_IMPORT_ROOTS) selected.add(root)
    set({ selected, topGen: s.topGen + 1 })
    return
  }
  if (s.added.some((r) => r.root === root)) return
  const added = [addedRow(root, Date.now(), projectId), ...s.added]
  commitRows(s.scan, added, { added, selected: new Set([...s.selected, root]), seen: new Set([...s.seen, root]), topGen: s.topGen + 1 })
}

/** The native folder panel on this machine; on a remote machine the folder browser (which adds the project itself), and the project it adds appears in the list. */
export async function chooseFolder(renderer: { promptForPaths?: (options: { directories: boolean; files: boolean; prompt?: string }) => Promise<string[] | null | undefined> } | null | undefined): Promise<void> {
  if (isLocked(get())) return
  if (activeEnvironment().local) {
    const paths = await renderer?.promptForPaths?.({ directories: true, files: false, prompt: 'Choose a folder' })
    if (paths?.[0]) addFolder(paths[0])
    return
  }
  const known = new Set(getState().projects.map((p) => p.id))
  stopRemoteWatch?.()
  const stop = subscribeApp(() => {
    const fresh = getState().projects.find((p) => !known.has(p.id))
    if (!fresh) return
    stop()
    if (stopRemoteWatch === stop) stopRemoteWatch = null
    addFolder(fresh.path, fresh.id)
  })
  stopRemoteWatch = stop
  showDialog({ kind: 'project' })
}

// ─── Import ───────────────────────────────────────────────────────────────

function recompute() {
  const s = get()
  const names = Object.fromEntries(s.plan.map((p) => [p.root, p.name]))
  const known = Object.fromEntries(s.plan.map((p) => [p.root, p.project_id ?? null]))
  const summary = summarize({
    phase: s.job ? s.job.phase : 'none', mode: s.importMode ?? s.mode, order: s.plan.map((p) => p.root), imports: s.imports, names, skips: s.skips, known,
  })
  set({ summary, progress: overallProgress(s.imports) })
}

function onProgress(event: SessionsImportProgress) {
  const s = get()
  if (!s.job || (s.job.id && s.job.id !== event.job_id)) return
  if (!s.job.id) set({ job: { ...s.job, id: event.job_id } })
  const name = s.plan.find((p) => p.root === event.root)?.name ?? event.root
  set({ imports: applyProgress(s.imports, event), skips: appendSkips(s.skips, name, event.new_skipped) })
  recompute()
}

function onJob(job: SessionsImportJob) {
  const s = get()
  if (!s.job || (s.job.id && s.job.id !== job.job_id)) return
  const ended = job.state !== 'running'
  set({ job: { id: job.job_id, phase: ended ? 'done' : 'running' }, imports: applyJob(s.imports, job) })
  recompute()
  if (ended) for (const listener of [...finishedListeners]) listener(get().summary)
}

/** Press Import: one `sessions.import_all` for the checked rows, newest first. The mode, the checkboxes and Select all lock from this moment. */
export function startImport(): void {
  const s = get()
  if (s.job) return
  const plan = importRoots(allRows(s), s.selected, s.mode)
  if (plan.length === 0) return
  const client = clientSource()
  if (!client) { set({ importError: 'Kybern isn’t connected. Reconnect, then import again.' }); return }
  bind(client)
  set({ job: { id: null, phase: 'running' }, importError: null, importMode: s.mode, plan, imports: startImports(plan), skips: [], progress: 0 })
  recompute()
  const scanId = s.scan?.state === 'running' ? null : s.scanId
  client.call('sessions.import_all', { roots: plan.map(toRequestRoot), scan_id: scanId }).then(
    (job) => onJob(job),
    (error) => {
      // Nothing started: unlock and say so next to the button.
      set({ job: null, plan: [], imports: {}, skips: [], progress: 0, importMode: null, importError: `Couldn’t start the import (${errorText(error).replace(/[.\s]+$/, '')}). Try again.` })
      recompute()
    },
  )
}

export function stopImport(): void {
  const id = get().job?.id
  if (id) void clientSource()?.call('sessions.import_cancel', { job_id: id }).catch(() => undefined)
}

// ─── What the handoff reads ───────────────────────────────────────────────

export const useImportSummary = (): ImportSummary => projectsStore.use((s) => s.summary)
export const getImportSummary = (): ImportSummary => get().summary

/** Called once when an import job ends (also after the scene is gone). Returns the unsubscribe. */
export function onImportFinished(callback: (summary: ImportSummary) => void): () => void {
  finishedListeners.add(callback)
  return () => { finishedListeners.delete(callback) }
}
