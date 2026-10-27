// The Projects scene's rules, pure: which scanned rows show and in what order, what each import mode says on a row and in the
// toolbar, how long ago a chat was, what the primary button asks, how an import's progress events fold into per-project state and
// into the summary the handoff reads, and where rows move when a scan adds one (SPEC `.kybern-artifacts/onboarding-cinematic/SPEC.md`
// §4 and v1 §6). No GPUIX, no daemon: `projects.test.ts` checks it.
import type {
  ImportProjectState, ProviderKind, ScanProviderStatus, ScannedProject, SessionSkip, SessionsImportJob, SessionsImportProgress, SessionsImportRoot,
} from '../../../../packages/kybern-client/src/types.ts'
import { AGENT_NAMES, AGENT_ORDER, LATEST_CHATS, count, limitFor, noun, type ImportMode } from './model.ts'

const NUMBER = new Intl.NumberFormat('en')
export const formatCount = (n: number) => NUMBER.format(n)

/** The daemon takes at most this many roots in one `sessions.import_all`. */
export const MAX_IMPORT_ROOTS = 500

// ─── Rows ─────────────────────────────────────────────────────────────────

/** A scanned project, or a folder the user added by hand (no past chats, imported with `limit: 0` so it still becomes a project). */
export interface Row extends ScannedProject {
  added?: boolean
}

/** The row for "Choose a folder": checked, at the top of Suggested, "No past chats / Just added". */
export function addedRow(root: string, now: number, projectId: string | null = null): Row {
  const trimmed = root.replace(/[\\/]+$/, '')
  const name = trimmed.split(/[\\/]/).pop() || trimmed || root
  return {
    root, name, is_git: false, project_id: projectId, providers: [], session_count: 0, imported_count: 0, recent_count: 0,
    last_activity: new Date(now).toISOString(), folder_missing: false, suggested: true, added: true,
  }
}

/** `/Users/ada/projects/ade` → `~/projects/ade` (and the Linux, root and Windows equivalents). The home folder of a remote machine is not known here, so this is a shape rule. */
export function displayPath(path: string): string {
  return path
    .replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~')
    .replace(/^\/root(?=\/|$)/, '~')
    .replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/, '~')
}

const activity = (row: Row) => Date.parse(row.last_activity) || 0
/** Newest activity first; the name breaks ties so a scan that repeats itself never reorders rows. */
export const compareRecent = (a: Row, b: Row) => activity(b) - activity(a) || a.name.localeCompare(b.name) || a.root.localeCompare(b.root)

export interface Split {
  suggested: Row[]
  others: Row[]
  /** Rows whose folder no longer exists: never shown, only counted. */
  hidden: number
}

/** The scan's rows as the list shows them: one per root, missing folders counted and dropped, Suggested pre-sorted by recency with added folders first. */
export function splitRows(projects: readonly ScannedProject[], added: readonly Row[] = []): Split {
  const merged = new Map<string, Row>()
  for (const project of projects) {
    const old = merged.get(project.root)
    if (!old) { merged.set(project.root, project); continue }
    // The daemon already groups by repository; if a root repeats, fold its counts together rather than list it twice.
    const providers = new Map(old.providers.map((p) => [p.provider, { ...p }]))
    for (const p of project.providers) {
      const have = providers.get(p.provider)
      if (have) { have.sessions += p.sessions; have.imported += p.imported } else providers.set(p.provider, { ...p })
    }
    merged.set(project.root, {
      ...old, providers: [...providers.values()], session_count: old.session_count + project.session_count, imported_count: old.imported_count + project.imported_count,
      recent_count: old.recent_count + project.recent_count, suggested: old.suggested || project.suggested,
      last_activity: activity(project) > activity(old) ? project.last_activity : old.last_activity, folder_missing: old.folder_missing && project.folder_missing,
      project_id: old.project_id ?? project.project_id,
    })
  }
  let hidden = 0
  const scanned: Row[] = []
  for (const row of merged.values()) { if (row.folder_missing) hidden++; else scanned.push(row) }
  const mine = added.filter((row) => !merged.has(row.root)).sort((a, b) => activity(b) - activity(a))
  const suggested = [...mine, ...scanned.filter((row) => row.suggested).sort(compareRecent)]
  const others = scanned.filter((row) => !row.suggested).sort(compareRecent)
  return { suggested, others, hidden }
}

export function rowEqual(a: Row, b: Row): boolean {
  if (a === b) return true
  if (a.root !== b.root || a.name !== b.name || a.is_git !== b.is_git || (a.project_id ?? null) !== (b.project_id ?? null) || a.session_count !== b.session_count
    || a.imported_count !== b.imported_count || a.recent_count !== b.recent_count || a.last_activity !== b.last_activity || a.folder_missing !== b.folder_missing
    || a.suggested !== b.suggested || !!a.added !== !!b.added || a.providers.length !== b.providers.length) return false
  return a.providers.every((p, i) => p.provider === b.providers[i]!.provider && p.sessions === b.providers[i]!.sessions && p.imported === b.providers[i]!.imported)
}

/** `next`, with every row that did not change replaced by the previous object (and the previous array if nothing changed), so a 4 Hz scan never re-renders or re-animates a settled row. */
export function reconcileRows(prev: readonly Row[], next: readonly Row[]): Row[] {
  const old = new Map(prev.map((row) => [row.root, row]))
  const rows = next.map((row) => { const was = old.get(row.root); return was && rowEqual(was, row) ? was : row })
  return rows.length === prev.length && rows.every((row, i) => row === prev[i]) ? (prev as Row[]) : rows
}

/** Roots of Suggested rows not yet seen: these arrive pre-checked. `seen` is the full set afterwards. */
export function newSuggested(seen: ReadonlySet<string>, suggested: readonly Row[]): { fresh: string[]; seen: Set<string> } {
  const next = new Set(seen)
  const fresh: string[] = []
  for (const row of suggested) if (!next.has(row.root)) { next.add(row.root); fresh.push(row.root) }
  return { fresh, seen: next }
}

// ─── List layout ──────────────────────────────────────────────────────────

export const ROW_H = 60
export const ROW_GAP = 6
/** A row and the gap under it: the pitch every row and every slide is measured in. */
export const ROW_SLOT = ROW_H + ROW_GAP
export const HEAD_H = 36
export const OTHERS_HEAD_H = 44
export const NOTE_H = 40
export const TAIL_H = 28
export const SKELETON_ROWS = 3

export type EntryKind = 'skeleton' | 'head' | 'row' | 'others-head' | 'note' | 'tail'
export interface Entry { key: string; kind: EntryKind; height: number; root?: string }

export interface ListShape {
  suggested: readonly string[]
  others: readonly string[]
  othersOpen: boolean
  hidden: number
  /** Three placeholders until the first rows land. */
  skeleton: boolean
}

/** With nothing suggested, Other projects is the list: it opens by itself. */
export const othersShown = (shape: Pick<ListShape, 'suggested' | 'others' | 'othersOpen'>) => shape.others.length > 0 && (shape.othersOpen || shape.suggested.length === 0)

/** The flat list the virtual list renders, with each entry's height (they are all fixed, so no measuring pass). */
export function entriesFor(shape: ListShape): Entry[] {
  const entries: Entry[] = []
  if (shape.skeleton) {
    for (let i = 0; i < SKELETON_ROWS; i++) entries.push({ key: `skeleton:${i}`, kind: 'skeleton', height: ROW_SLOT })
    return entries
  }
  if (shape.suggested.length > 0) {
    entries.push({ key: 'head:suggested', kind: 'head', height: HEAD_H })
    for (const root of shape.suggested) entries.push({ key: `row:${root}`, kind: 'row', height: ROW_SLOT, root })
  }
  if (shape.others.length > 0) {
    entries.push({ key: 'head:others', kind: 'others-head', height: OTHERS_HEAD_H })
    if (othersShown(shape)) for (const root of shape.others) entries.push({ key: `row:${root}`, kind: 'row', height: ROW_SLOT, root })
  }
  if (shape.hidden > 0 && (shape.suggested.length > 0 || shape.others.length > 0)) entries.push({ key: 'note', kind: 'note', height: NOTE_H })
  entries.push({ key: 'tail', kind: 'tail', height: TAIL_H })
  return entries
}

/** How far each row that stayed has moved down (+) or up (−) when the list changed, in px: the FLIP the rows play to slide into the room a new row made. Zero moves are left out. */
export function flipDeltas(prev: readonly Entry[], next: readonly Entry[]): Record<string, number> {
  const was = new Map<string, number>()
  let y = 0
  for (const entry of prev) { was.set(entry.key, y); y += entry.height }
  const out: Record<string, number> = {}
  y = 0
  for (const entry of next) {
    const before = was.get(entry.key)
    if (entry.kind === 'row' && before !== undefined && Math.abs(before - y) > 0.5) out[entry.key] = before - y
    y += entry.height
  }
  return out
}

/** Delays (seconds) of a staggered change down a list: `step` apart, the first `cap` rows only; the rest share the last. */
export function staggerDelay(index: number, step = 0.028, cap = 12): number {
  return Math.min(Math.max(0, index), cap) * step
}

/** A wave of ticks for Select all / Clear: the first `cap` roots `step` ms apart, the rest together right after. */
export function wave(roots: readonly string[], step = 35, cap = 16): { root: string; at: number }[] {
  return roots.map((root, i) => ({ root, at: Math.min(i, cap) * step }))
}

// ─── Words on a row ───────────────────────────────────────────────────────

const DAY = 86_400_000
const dayStart = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime() }

/** `Just now`, `12m ago`, `3h ago`, `Yesterday`, `3d ago`, `2w ago`, `4mo ago`, `1y ago`. */
export function ageLabel(iso: string, now: number): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const diff = now - then
  if (diff < 60_000) return 'Just now'
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  const days = Math.round((dayStart(now) - dayStart(then)) / DAY)
  if (days <= 0 || hours < 12) return `${hours}h ago`
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days}d ago`
  if (days < 30) return `${Math.floor(days / 7)}w ago`
  if (days < 365) return `${Math.floor(days / 30)}mo ago`
  return `${Math.floor(days / 365)}y ago`
}

export const ageLine = (row: Row, now: number) => (row.added ? 'Just added' : ageLabel(row.last_activity, now))

/** Chats an import would bring in from this row. */
export function chatsFor(row: Row, mode: ImportMode): number {
  if (row.added || mode === 'none') return 0
  return mode === 'latest' ? Math.min(row.session_count, LATEST_CHATS) : row.session_count
}

/** The right column's first line (SPEC §4): `Last 50 of 323`, `43 chats`, `323 chats` or `Project only`. */
export function countLine(row: Row, mode: ImportMode): string {
  if (row.added) return 'No past chats'
  if (mode === 'none') return 'Project only'
  if (mode === 'latest' && row.session_count > LATEST_CHATS) return `Last ${LATEST_CHATS} of ${formatCount(row.session_count)}`
  return count(row.session_count, 'chat')
}

export interface Totals { projects: number; chats: number }
export function totals(rows: readonly Row[], selected: ReadonlySet<string>, mode: ImportMode): Totals {
  let projects = 0, chats = 0
  for (const row of rows) if (selected.has(row.root)) { projects++; chats += chatsFor(row, mode) }
  return { projects, chats }
}

/** The toolbar's right end: nothing with nothing selected, `Projects only` with Don’t import, else a rolling chat count. */
export type TotalLabel = { kind: 'none' } | { kind: 'projects-only' } | { kind: 'chats'; chats: number; noun: string }
export function totalLabel(t: Totals, mode: ImportMode): TotalLabel {
  if (t.projects === 0) return { kind: 'none' }
  if (mode === 'none') return { kind: 'projects-only' }
  return { kind: 'chats', chats: t.chats, noun: noun(t.chats, 'chat') }
}

export const MODE_CAPTION: Record<ImportMode, string> = {
  latest: `Brings in the ${LATEST_CHATS} most recent chats from each project.`,
  all: 'Brings in every chat. Big projects take a little longer.',
  none: 'Adds the projects without their chats. You can import chats later.',
}
export const MODE_OPTIONS: readonly { value: ImportMode; label: string }[] = [
  { value: 'latest', label: `Latest ${LATEST_CHATS}` },
  { value: 'all', label: 'All chats' },
  { value: 'none', label: 'Don’t import chats' },
]

/** The primary button (SPEC §4): `Import 8 projects`, `Add 8 projects` with Don’t import, `Continue without importing` with nothing picked, `Continue` once an import runs. */
export type CtaLabel =
  | { kind: 'continue'; text: string }
  | { kind: 'skip'; text: string }
  | { kind: 'import'; verb: 'Import' | 'Add'; n: number; noun: string; text: string }
export function ctaLabel(mode: ImportMode, selected: number, importing: boolean): CtaLabel {
  if (importing) return { kind: 'continue', text: 'Continue' }
  if (selected === 0) return { kind: 'skip', text: 'Continue without importing' }
  const verb = mode === 'none' ? 'Add' : 'Import'
  return { kind: 'import', verb, n: selected, noun: noun(selected, 'project'), text: `${verb} ${count(selected, 'project')}` }
}

/** The note after the list: `700 projects whose folders no longer exist are hidden.` */
export function hiddenNote(hidden: number): string {
  return `${count(hidden, 'project')} whose ${noun(hidden, 'folder')} no longer ${noun(hidden, 'exists', 'exist')} ${noun(hidden, 'is', 'are')} hidden.`
}

// ─── Harness chips ────────────────────────────────────────────────────────

export type ChipState = 'scanning' | 'done' | 'failed'
export interface ChipInfo { provider: ProviderKind; name: string; state: ChipState; sessions: number; error: string | null }
export interface Chips {
  chips: ChipInfo[]
  /** Agents that are not installed: one quiet chip. */
  missing: { provider: ProviderKind; name: string; error: string | null }[]
  failed: ChipInfo[]
}

const providerName = (kind: ProviderKind) => AGENT_NAMES[kind] ?? kind
const rank = (kind: ProviderKind) => { const i = AGENT_ORDER.indexOf(kind); return i < 0 ? AGENT_ORDER.length : i }

/** One chip per harness (its accounts are summed), in provider order; harnesses that are not installed fold into `missing`. */
export function chipsFor(providers: readonly ScanProviderStatus[]): Chips {
  const groups = new Map<ProviderKind, ScanProviderStatus[]>()
  for (const status of providers) groups.set(status.provider, [...(groups.get(status.provider) ?? []), status])
  const chips: ChipInfo[] = []
  const missing: Chips['missing'] = []
  for (const [provider, list] of [...groups].sort((a, b) => rank(a[0]) - rank(b[0]))) {
    const error = list.find((s) => s.error)?.error ?? null
    if (list.every((s) => s.state === 'unavailable')) { missing.push({ provider, name: providerName(provider), error }); continue }
    const live = list.filter((s) => s.state !== 'unavailable')
    const state: ChipState = live.some((s) => s.state === 'scanning' || s.state === 'pending') ? 'scanning' : live.some((s) => s.state === 'done') ? 'done' : 'failed'
    chips.push({ provider, name: providerName(provider), state, sessions: live.reduce((n, s) => n + s.sessions, 0), error: state === 'failed' ? error : null })
  }
  return { chips, missing, failed: chips.filter((chip) => chip.state === 'failed') }
}

/** `Codex history couldn’t be read.` / `Codex and Cursor histories couldn’t be read.` */
export function failureLine(failed: readonly { name: string }[]): string {
  const names = failed.map((f) => f.name)
  if (names.length === 0) return ''
  const joined = new Intl.ListFormat('en-US', { style: 'long', type: 'conjunction' }).format(names)
  return names.length === 1 ? `${joined} history couldn’t be read.` : `${joined} histories couldn’t be read.`
}

// ─── Import ───────────────────────────────────────────────────────────────

export interface ImportRootPlan {
  root: string
  project_id?: string
  /** 50, `null` (all) or 0 (the project without chats). */
  limit: number | null
  expected: number
  name: string
}

/** What `sessions.import_all` is asked: the checked rows, newest first (so the most recent project is imported first), each with the mode's limit. Added folders always use 0. */
export function importRoots(rows: readonly Row[], selected: ReadonlySet<string>, mode: ImportMode, max = MAX_IMPORT_ROOTS): ImportRootPlan[] {
  return rows
    .filter((row) => selected.has(row.root))
    .sort(compareRecent)
    .slice(0, max)
    .map((row) => {
      const limit = row.added ? 0 : limitFor(mode)
      return {
        root: row.root, ...(row.project_id ? { project_id: row.project_id } : {}), limit, name: row.name,
        expected: limit === null ? row.session_count : Math.min(row.session_count, limit),
      }
    })
}
export const toRequestRoot = (plan: ImportRootPlan): SessionsImportRoot => ({ root: plan.root, ...(plan.project_id ? { project_id: plan.project_id } : {}), limit: plan.limit })

export interface RootImport {
  root: string
  state: ImportProjectState
  project_id: string | null
  total: number
  done: number
  imported: number
  already_imported: number
  skipped_count: number
  error: string | null
  /** Chats the plan expected before the daemon counted them. */
  expected: number
}

export function startImports(plans: readonly ImportRootPlan[]): Record<string, RootImport> {
  const out: Record<string, RootImport> = {}
  for (const plan of plans) out[plan.root] = { root: plan.root, state: 'queued', project_id: plan.project_id ?? null, total: 0, done: 0, imported: 0, already_imported: 0, skipped_count: 0, error: null, expected: plan.expected }
  return out
}

/** Fold one progress event in. An event for a root that was not planned is dropped. */
export function applyProgress(imports: Record<string, RootImport>, event: SessionsImportProgress): Record<string, RootImport> {
  const old = imports[event.root]
  if (!old) return imports
  return {
    ...imports,
    [event.root]: {
      ...old, state: event.state, project_id: event.project_id ?? old.project_id, total: event.total, done: event.done, imported: event.imported,
      already_imported: event.already_imported, skipped_count: event.skipped_count, error: event.error ?? null,
    },
  }
}

/** The authoritative job (the `finished` notification or the RPC's answer) over what progress events built. */
export function applyJob(imports: Record<string, RootImport>, job: SessionsImportJob): Record<string, RootImport> {
  let out = imports
  for (const project of job.projects) {
    const old = out[project.root]
    if (!old) continue
    out = { ...out, [project.root]: { ...old, state: project.state, project_id: project.project_id ?? old.project_id, total: project.total, done: project.done, imported: project.imported, already_imported: project.already_imported, skipped_count: project.skipped_count, error: project.error ?? null } }
  }
  return out
}

export interface SkipDetail { project: string; title: string; reason: string; detail: string }
export const MAX_SKIP_DETAILS = 200

export function appendSkips(skips: readonly SkipDetail[], project: string, news: readonly SessionSkip[]): SkipDetail[] {
  if (news.length === 0) return skips as SkipDetail[]
  return [...skips, ...news.map((s) => ({ project, title: s.title, reason: s.reason, detail: s.detail }))].slice(-MAX_SKIP_DETAILS)
}

/** Overall progress 0…1 in chats (a project with none counts as one unit, so Add 8 projects still fills). */
export function overallProgress(imports: Record<string, RootImport>): number {
  let weight = 0, done = 0
  for (const imp of Object.values(imports)) {
    const w = Math.max(1, imp.total > 0 ? imp.total : imp.expected)
    weight += w
    done += imp.state === 'done' || imp.state === 'failed' ? w : Math.min(imp.done, w)
  }
  return weight === 0 ? 0 : Math.min(1, done / weight)
}

export type RowImportLine = { kind: 'waiting' | 'running' | 'done' | 'failed'; text: string; fraction: number }
/** What a row says during and after an import (SPEC §4): `Waiting`, `Importing 12 of 50`, `49 imported · 1 skipped`, `50 imported`, `Added`. */
export function importLine(imp: RootImport): RowImportLine {
  if (imp.state === 'queued') return { kind: 'waiting', text: 'Waiting', fraction: 0 }
  if (imp.state === 'running') return { kind: 'running', text: imp.total > 0 ? `Importing ${formatCount(imp.done)} of ${formatCount(imp.total)}` : 'Importing…', fraction: imp.total > 0 ? Math.min(1, imp.done / imp.total) : 0 }
  if (imp.state === 'failed') return { kind: 'failed', text: 'Couldn’t import', fraction: 1 }
  const parts: string[] = []
  if (imp.imported > 0) parts.push(`${formatCount(imp.imported)} imported`)
  if (imp.already_imported > 0) parts.push(`${formatCount(imp.already_imported)} already imported`)
  if (imp.skipped_count > 0) parts.push(`${formatCount(imp.skipped_count)} skipped`)
  return { kind: 'done', text: parts.length > 0 ? parts.join(' · ') : 'Added', fraction: 1 }
}

export type ImportPhase = 'none' | 'running' | 'done'
export interface ImportSummary {
  phase: ImportPhase
  mode: ImportMode
  projects: number
  doneProjects: number
  chats: number
  totalChats: number
  skipped: number
  skippedDetails: SkipDetail[]
  /** The Kybern project id of the most recent imported project. */
  recentProjectId: string | null
  recentProjectName: string | null
  /** Imported projects' names, newest first. */
  names: string[]
}

export const EMPTY_SUMMARY: ImportSummary = { phase: 'none', mode: 'latest', projects: 0, doneProjects: 0, chats: 0, totalChats: 0, skipped: 0, skippedDetails: [], recentProjectId: null, recentProjectName: null, names: [] }

export function summarize(input: {
  phase: ImportPhase
  mode: ImportMode
  /** Planned roots, newest activity first. */
  order: readonly string[]
  imports: Record<string, RootImport>
  names: Record<string, string>
  skips: readonly SkipDetail[]
  /** Project ids known before the import (a scanned root that already is a Kybern project). */
  known?: Record<string, string | null | undefined>
}): ImportSummary {
  const { phase, mode, order, imports, names, skips, known = {} } = input
  if (phase === 'none') return { ...EMPTY_SUMMARY, mode }
  const all = order.map((root) => imports[root]).filter((imp): imp is RootImport => !!imp)
  const idOf = (imp: RootImport) => imp.project_id ?? known[imp.root] ?? null
  const recent = all.find((imp) => imp.state !== 'failed' && idOf(imp) !== null)
  const started = all.filter((imp) => imp.state === 'running' || imp.state === 'done')
  return {
    phase, mode,
    projects: all.length,
    doneProjects: all.filter((imp) => imp.state === 'done' || imp.state === 'failed').length,
    chats: all.reduce((n, imp) => n + imp.imported + imp.already_imported, 0),
    totalChats: all.reduce((n, imp) => n + (imp.total > 0 || imp.state === 'done' ? imp.total : imp.expected), 0),
    skipped: all.reduce((n, imp) => n + imp.skipped_count, 0),
    skippedDetails: [...skips],
    recentProjectId: recent ? idOf(recent) : null,
    recentProjectName: recent ? names[recent.root] ?? null : null,
    names: started.map((imp) => names[imp.root] ?? imp.root),
  }
}
