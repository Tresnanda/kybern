// The Actions pipeline (ADE-97, design "C · Pipeline") for every client: GitHub's jobs placed on their workflow file's
// `needs` graph (columns by dependency depth, the failing path from its root to the final job), the geometry of that graph,
// the run list grouped by branch with one bead per run, and the facts the run header states. GPUIX draws them; mobile can
// reuse them as they are. Nothing here reads the clock except where a function takes `now`.
import { runBucket, type RunBucket } from "./actions.ts"
import type { BranchPull, WorkflowJob, WorkflowJobSpec, WorkflowRun } from "./types.ts"

// ---- matching GitHub's jobs to the workflow file ----

const EXPRESSION = /\$\{\{[\s\S]*?\}\}/g
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

interface Pattern { spec: string; test: RegExp; score: number }

/**
 * How GitHub names a declared job's runs: `name:` with each `${{ }}` filled in (or kept verbatim on a skipped job), the id
 * when unnamed, ` (values)` after an unnamed or expression-free matrix job, and ` / <callee>` after a reusable workflow's
 * caller. `score` ranks the patterns: an exact name above any pattern, then the longest fixed text, so `${{ matrix.id }}`
 * only takes what nothing else claims.
 */
function pattern(spec: WorkflowJobSpec): Pattern {
  const template = spec.name || spec.id
  const parts = template.split(EXPRESSION)
  const dynamic = parts.length > 1
  let base = dynamic ? parts.map(escape).join("(?:.+?)") : escape(template)
  // A literal template also matches itself: a skipped job reports its unexpanded name.
  if (dynamic) base = `(?:${base}|${escape(template)})`
  const matrix = !dynamic && spec.matrix !== undefined
  if (matrix) base += "(?: \\(.+\\))?"
  const fixed = parts.join("").length
  const exact = !dynamic && !matrix && !spec.uses
  return { spec: spec.id, test: new RegExp(`^${base}${spec.uses ? "(?: / .+)?" : ""}$`), score: exact ? 1000 + fixed : fixed }
}

/**
 * The declared job each of GitHub's jobs belongs to, by API job id; null when one can't be placed or two declarations claim
 * it equally (the graph would be a guess).
 */
export function matchJobs(jobs: readonly Pick<WorkflowJob, "id" | "name">[], specs: readonly WorkflowJobSpec[]): Map<number, string> | null {
  const { matched, complete } = matchEach(jobs, specs)
  return complete && specs.length ? matched : null
}

/** `matchJobs` without giving up: every job that can be placed, and whether that was all of them. */
function matchEach(jobs: readonly Pick<WorkflowJob, "id" | "name">[], specs: readonly WorkflowJobSpec[]): { matched: Map<number, string>; complete: boolean } {
  const patterns = specs.map(pattern)
  const matched = new Map<number, string>()
  let complete = true
  for (const job of jobs) {
    let best: Pattern | null = null
    let tie = false
    for (const p of patterns) {
      if (!p.test.test(job.name)) continue
      if (!best || p.score > best.score) { best = p; tie = false }
      else if (p.score === best.score) tie = true
    }
    if (!best || tie) complete = false
    else matched.set(job.id, best.spec)
  }
  return { matched, complete }
}

// ---- the graph ----

export type EdgeKind = "done" | "failure" | "running" | "waiting" | "skipped"
export interface GraphNode {
  /** The API job. */
  job: WorkflowJob
  bucket: RunBucket
  column: number
  /** Position within its column, top first. */
  row: number
}
export interface GraphEdge {
  from: number
  to: number
  kind: EdgeKind
  /** A waiting edge out of a running job (drawn amber). */
  hot?: boolean
}
export interface JobGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  columns: number
  /** The tallest column's node count. */
  rows: number
  /** The jobs are in one column in run order: the workflow file was unreadable or didn't account for every job. */
  fallback: boolean
  /** Failed jobs no failed job leads to: where the failure starts. */
  failureOrigins: number[]
}

/** Each declared job's depth: 0 without `needs`, else one past its deepest need; null on a cycle. */
export function depths(specs: readonly WorkflowJobSpec[]): Map<string, number> | null {
  const byId = new Map(specs.map(s => [s.id, s]))
  const depth = new Map<string, number>()
  const visiting = new Set<string>()
  const visit = (id: string): number | null => {
    const known = depth.get(id)
    if (known !== undefined) return known
    if (visiting.has(id)) return null
    visiting.add(id)
    let d = 0
    for (const need of byId.get(id)?.needs ?? []) {
      if (!byId.has(need)) continue
      const n = visit(need)
      if (n === null) return null
      d = Math.max(d, n + 1)
    }
    visiting.delete(id)
    depth.set(id, d)
    return d
  }
  for (const s of specs) if (visit(s.id) === null) return null
  return depth
}

/**
 * The declared jobs `id` waits on that ran: its own needs, or, through a need that has no job in this run (filtered out
 * by an `if:` upstream), that need's needs.
 */
function presentNeeds(id: string, byId: Map<string, WorkflowJobSpec>, present: Set<string>, seen = new Set<string>()): string[] {
  const out: string[] = []
  for (const need of byId.get(id)?.needs ?? []) {
    if (seen.has(need) || !byId.has(need)) continue
    seen.add(need)
    if (present.has(need)) out.push(need)
    else out.push(...presentNeeds(need, byId, present, seen))
  }
  return out
}

/** Edges whose kind follows the jobs at both ends (the failure path is applied after). */
function edgeKind(from: RunBucket, to: RunBucket): Pick<GraphEdge, "kind" | "hot"> {
  if (to === "skipped" || to === "cancelled" || from === "skipped" || from === "cancelled") return { kind: "skipped" }
  if (to === "running") return { kind: "running" }
  if (to === "queued") return from === "running" ? { kind: "waiting", hot: true } : { kind: "waiting" }
  return { kind: "done" }
}

/** The jobs of one run on their workflow's `needs` graph, or in run order when that can't be done faithfully. */
export function buildGraph(jobs: readonly WorkflowJob[], specs: readonly WorkflowJobSpec[] | undefined): JobGraph {
  const { matched, complete } = matchEach(jobs, specs ?? [])
  const depth = specs?.length ? depths(specs) : null
  const byId = new Map((specs ?? []).map(s => [s.id, s]))
  const present = new Set(matched.values())
  const nodes: GraphNode[] = []
  const placedGraph = complete && !!depth && !!specs?.length
  if (!placedGraph) {
    jobs.forEach((job, row) => nodes.push({ job, bucket: runBucket(job), column: 0, row }))
  } else {
    const order = new Map(specs.map((s, i) => [s.id, i]))
    // Columns that hold no job (a gated job that never ran) close up.
    const used = [...new Set([...present].map(id => depth.get(id)!))].sort((a, b) => a - b)
    const column = new Map(used.map((d, i) => [d, i]))
    const placed = jobs.map((job, i) => ({ job, i, spec: matched.get(job.id)! }))
    placed.sort((a, b) => depth.get(a.spec)! - depth.get(b.spec)! || order.get(a.spec)! - order.get(b.spec)! || a.i - b.i)
    const counts: number[] = []
    for (const p of placed) {
      const c = column.get(depth.get(p.spec)!)!
      counts[c] = (counts[c] ?? 0) + 1
      nodes.push({ job: p.job, bucket: runBucket(p.job), column: c, row: counts[c]! - 1 })
    }
  }
  // Edges wherever both ends are known, in run order too.
  const edges: GraphEdge[] = []
  if (depth) {
    const bySpec = new Map<string, GraphNode[]>()
    for (const n of nodes) {
      const s = matched.get(n.job.id)
      if (s) bySpec.set(s, [...(bySpec.get(s) ?? []), n])
    }
    for (const n of nodes) {
      const s = matched.get(n.job.id)
      if (!s) continue
      for (const need of presentNeeds(s, byId, present)) {
        for (const from of bySpec.get(need) ?? []) edges.push({ from: from.job.id, to: n.job.id, ...edgeKind(from.bucket, n.bucket) })
      }
    }
  }
  const columns = placedGraph ? Math.max(1, ...nodes.map(n => n.column + 1)) : 1
  return finish(nodes, reduce(edges), nodes.length ? columns : 0, !placedGraph)
}

/**
 * Only the edges no longer path implies: `CI` waiting on `changes` directly as well as through every check would draw a line
 * straight through the checks' column, and says nothing the path doesn't.
 */
function reduce(edges: GraphEdge[]): GraphEdge[] {
  const out = new Map<number, number[]>()
  for (const e of edges) out.set(e.from, [...(out.get(e.from) ?? []), e.to])
  const reachesWithoutEdge = (from: number, to: number) => {
    const seen = new Set<number>()
    const queue = (out.get(from) ?? []).filter(x => x !== to)
    while (queue.length) {
      const x = queue.pop()!
      if (x === to) return true
      if (seen.has(x)) continue
      seen.add(x)
      queue.push(...(out.get(x) ?? []))
    }
    return false
  }
  return edges.filter(e => !reachesWithoutEdge(e.from, e.to))
}

function finish(nodes: GraphNode[], edges: GraphEdge[], columns: number, fallback: boolean): JobGraph {
  const rows = Math.max(0, ...Array.from({ length: columns }, (_, c) => nodes.filter(n => n.column === c).length))
  const failureOrigins = markFailurePath(nodes, edges)
  return { nodes, edges, columns, rows, fallback, failureOrigins }
}

/**
 * Turn the failure path red and return where it starts. The path runs from the graph's roots through every job the first
 * failure waited on, then on through the failed jobs it took down (the final `CI` gate); edges into passing or skipped
 * siblings stay as they were.
 */
function markFailurePath(nodes: readonly GraphNode[], edges: GraphEdge[]): number[] {
  const failed = new Set(nodes.filter(n => n.bucket === "failed").map(n => n.job.id))
  if (!failed.size) return []
  const into = new Map<number, GraphEdge[]>()
  const out = new Map<number, GraphEdge[]>()
  for (const e of edges) {
    into.set(e.to, [...(into.get(e.to) ?? []), e])
    out.set(e.from, [...(out.get(e.from) ?? []), e])
  }
  const reach = (start: number, step: (id: number) => number[]) => {
    const seen = new Set<number>()
    const queue = [start]
    while (queue.length) for (const next of step(queue.pop()!)) if (!seen.has(next)) { seen.add(next); queue.push(next) }
    return seen
  }
  const upstream = (id: number) => reach(id, x => (into.get(x) ?? []).map(e => e.from))
  const origins = [...failed].filter(id => ![...upstream(id)].some(a => failed.has(a)))
  const red = new Set<GraphEdge>()
  for (const o of origins) {
    const before = upstream(o)
    for (const e of edges) if (before.has(e.from) && (e.to === o || before.has(e.to))) red.add(e)
    const after = reach(o, x => (out.get(x) ?? []).filter(e => failed.has(e.to)).map(e => e.to))
    for (const e of edges) if ((e.from === o || after.has(e.from)) && after.has(e.to)) red.add(e)
  }
  for (const e of red) { e.kind = "failure"; delete e.hot }
  return origins
}

// ---- geometry ----

export interface GraphMetrics {
  /** Each column's node width. */
  columnWidths: readonly number[]
  nodeHeight: number
  rowGap: number
  columnGap: number
}
export interface PlacedNode { id: number; x: number; y: number; width: number; height: number }
export interface PlacedEdge extends GraphEdge { d: string; length: number }
export interface GraphLayout { width: number; height: number; nodes: Map<number, PlacedNode>; edges: PlacedEdge[] }

/**
 * Where everything goes: columns left to right, each column centred on the tallest, edges as horizontal S-curves from a
 * node's right edge to the next one's left edge (`d` is SVG path data; `length` its approximate length, for dashes and
 * draw-ins). In run order (one column) an edge loops out to the right and back in.
 */
export function placeGraph(graph: JobGraph, m: GraphMetrics): GraphLayout {
  const xs: number[] = []
  let x = 0
  for (let c = 0; c < graph.columns; c++) { xs.push(x); x += (m.columnWidths[c] ?? m.columnWidths.at(-1) ?? 0) + m.columnGap }
  const pitch = m.nodeHeight + m.rowGap
  const height = Math.max(0, graph.rows * pitch - m.rowGap)
  const perColumn = (c: number) => graph.nodes.filter(n => n.column === c).length
  const nodes = new Map<number, PlacedNode>()
  for (const n of graph.nodes) {
    const width = m.columnWidths[n.column] ?? m.columnWidths.at(-1) ?? 0
    const top = (height - (perColumn(n.column) * pitch - m.rowGap)) / 2
    nodes.set(n.job.id, { id: n.job.id, x: xs[n.column]!, y: top + n.row * pitch, width, height: m.nodeHeight })
  }
  const loop = graph.fallback ? 24 : 0
  const width = Math.max(0, x - m.columnGap) + loop
  const edges = graph.edges.flatMap(e => {
    const a = nodes.get(e.from), b = nodes.get(e.to)
    if (!a || !b) return []
    const y1 = a.y + a.height / 2, y2 = b.y + b.height / 2
    if (graph.fallback || b.x <= a.x) {
      const right = Math.max(a.x + a.width, b.x + b.width), bulge = Math.min(loop, 8 + Math.abs(y2 - y1) / 6)
      const d = `M${r(a.x + a.width)} ${r(y1)}C${r(right + bulge)} ${r(y1)} ${r(right + bulge)} ${r(y2)} ${r(b.x + b.width)} ${r(y2)}`
      return [{ ...e, d, length: Math.round(Math.abs(y2 - y1) + bulge * 1.6) }]
    }
    const x1 = a.x + a.width, x2 = b.x, mid = (x2 - x1) / 2
    const d = `M${r(x1)} ${r(y1)}C${r(x1 + mid)} ${r(y1)} ${r(x2 - mid)} ${r(y2)} ${r(x2)} ${r(y2)}`
    return [{ ...e, d, length: Math.round(Math.hypot(x2 - x1, y2 - y1) * 1.08) }]
  })
  return { width, height, nodes, edges }
}
const r = (v: number) => Math.round(v * 10) / 10

/**
 * Column widths for labels measured by `measure` (an estimate is fine): room for the glyph, the name and the duration,
 * between `min` and `max`; a column wider than `max` truncates its names. With a `budget` (the room for all columns) the widest
 * columns give way first, down to `min`, so short columns keep their names whole.
 */
export function columnWidths(graph: JobGraph, measure: (text: string) => number, { min = 128, max = 300, chrome = 92, budget = Infinity } = {}): number[] {
  // `chrome` holds the glyph, padding and a duration; a waiting job's "Waits for 2 jobs" needs more.
  const room = (n: GraphNode) => measure(n.job.name) + Math.max(0, measure(nodeTime(graph, n)) - (chrome - 52))
  const widths = Array.from({ length: graph.columns }, (_, c) => {
    const widest = Math.max(0, ...graph.nodes.filter(n => n.column === c).map(room))
    return Math.round(Math.min(max, Math.max(min, widest + chrome)))
  })
  let over = widths.reduce((a, b) => a + b, 0) - budget
  while (over > 0) {
    const top = Math.max(...widths)
    if (top <= min) break
    const next = Math.max(min, ...widths.filter(w => w < top))
    const at = widths.filter(w => w === top).length
    const cut = Math.min(top - next, Math.ceil(over / at))
    for (let i = 0; i < widths.length; i++) if (widths[i] === top) widths[i] = top - cut
    over -= cut * at
  }
  return widths
}

/** How many unfinished jobs a waiting job still waits for. */
export function waitsFor(graph: JobGraph, node: GraphNode): number {
  if (node.bucket !== "queued") return 0
  const open = new Set(graph.nodes.filter(n => n.bucket === "running" || n.bucket === "queued").map(n => n.job.id))
  return graph.edges.filter(e => e.to === node.job.id && open.has(e.from)).length
}

/** The text at a node's trailing edge, when it isn't a duration: `Skipped`, `Waits for 2 jobs`, `Queued`, `Cancelled`. */
export function nodeTime(graph: JobGraph, node: GraphNode): string {
  switch (node.bucket) {
    case "skipped": return "Skipped"
    case "cancelled": return "Cancelled"
    case "queued": {
      const n = waitsFor(graph, node)
      return n ? `Waits for ${n} ${n === 1 ? "job" : "jobs"}` : "Queued"
    }
    default: return ""
  }
}

// ---- the run header ----

/** Seconds from `start` to `end` (or `now`), or null without a start. */
export function seconds(start: string | undefined, end: string | undefined, now = Date.now()): number | null {
  const from = start ? Date.parse(start) : NaN
  const to = end ? Date.parse(end) : now
  return Number.isFinite(from) && Number.isFinite(to) && to >= from ? (to - from) / 1000 : null
}

/** `8m 20s`, `45s`, `1h 5m`. */
export function duration(s: number): string {
  const t = Math.round(s)
  if (t < 60) return `${t}s`
  const m = Math.floor(t / 60)
  return m < 60 ? `${m}m ${t % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

/** A running clock: `4:12`, `1:02:09`. */
export function clock(s: number): string {
  const t = Math.max(0, Math.floor(s)), h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, sec = String(t % 60).padStart(2, "0")
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`
}

/** A workflow's usual run time: the median of its last ten passing runs in `runs`, or null without three. */
export function usualDuration(runs: readonly WorkflowRun[], workflowId: number, excluding?: number): number | null {
  const times = runs
    .filter(r => r.workflow_id === workflowId && r.id !== excluding && r.status === "completed" && r.conclusion === "success")
    .slice(0, 10)
    .map(r => seconds(r.started_at ?? r.created_at, r.updated_at))
    .filter((s): s is number => s !== null)
    .sort((a, b) => a - b)
  return times.length >= 3 ? times[Math.floor(times.length / 2)]! : null
}

/** Each job's time in a finished run, by name: what a running job's progress line measures against. */
export function jobTimes(jobs: readonly WorkflowJob[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const j of jobs) {
    const s = j.status === "completed" && j.conclusion === "success" ? seconds(j.started_at, j.completed_at) : null
    if (s !== null && s > 0) out.set(j.name, s)
  }
  return out
}

/** How far along a running job is against its usual time (0..0.96, never full until it finishes); null when unknown. */
export function jobProgress(job: WorkflowJob, usual: ReadonlyMap<string, number> | undefined, now = Date.now()): number | null {
  const typical = usual?.get(job.name)
  const ran = seconds(job.started_at, undefined, now)
  if (!typical || ran === null) return null
  return Math.min(0.96, Math.max(0.02, ran / typical))
}

/** The header's line: where a failure runs, how far a running run is, or what a finished one did. */
export function runSummary(run: WorkflowRun, graph: JobGraph, usual: number | null): string {
  const buckets = graph.nodes.map(n => n.bucket)
  const count = (b: RunBucket) => buckets.filter(x => x === b).length
  if (run.status !== "completed") {
    const done = buckets.filter(b => b !== "running" && b !== "queued").length
    const parts = [buckets.length ? `${done} of ${buckets.length} ${buckets.length === 1 ? "job" : "jobs"} done` : "Waiting for a runner"]
    if (usual) parts.push(`usually ${duration(usual)}`)
    return parts.join(" · ")
  }
  if (graph.failureOrigins.length) {
    const names = graph.failureOrigins.map(id => graph.nodes.find(n => n.job.id === id)!.job.name)
    const list = names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names[0]} and ${names.length - 1} more jobs`
    return `The failure runs through ${list}`
  }
  const parts = [count("passed") && `${count("passed")} ${count("passed") === 1 ? "job" : "jobs"} passed`, count("skipped") && `${count("skipped")} skipped`, count("cancelled") && `${count("cancelled")} cancelled`].filter(Boolean)
  return parts.length ? `${parts.join(", ")}` : ""
}

/** The step a job's log header names: the failed one, else the one running, else the longest. */
export function headlineStep(job: WorkflowJob): WorkflowJob["steps"][number] | undefined {
  const failed = job.steps.find(s => s.status === "completed" && runBucket(s) === "failed")
  if (failed) return failed
  const running = job.steps.find(s => s.status === "in_progress")
  if (running) return running
  let best: WorkflowJob["steps"][number] | undefined, most = -1
  for (const s of job.steps) {
    const t = seconds(s.started_at, s.completed_at) ?? -1
    if (t > most) { most = t; best = s }
  }
  return best
}

// ---- the run list: branches and beads ----

/** One run as a bead. Beads are interned by run, attempt and state, so an unchanged run is the same object on every refresh. */
export interface Bead { readonly runId: number; readonly attempt: number; readonly bucket: RunBucket; readonly number: number }
const beads = new Map<string, Bead>()
export function bead(run: WorkflowRun): Bead {
  const key = `${run.id}:${run.attempt}:${run.status}:${run.conclusion ?? ""}`
  let b = beads.get(key)
  if (!b) {
    if (beads.size > 4000) beads.clear()
    b = Object.freeze({ runId: run.id, attempt: run.attempt, bucket: runBucket(run), number: run.number })
    beads.set(key, b)
  }
  return b
}

export interface BeadRow {
  workflowId: number
  workflow: string
  /** Oldest first, the latest last. */
  beads: Bead[]
  latest: WorkflowRun
  /** `#699`, or the tag a release ran for. */
  label: string
}
export interface BranchGroup {
  branch: string
  isDefault: boolean
  pull?: BranchPull
  latest: WorkflowRun
  rows: BeadRow[]
}

const TAG = /^v?\d+\.\d+(?:\.\d+)?(?:[-+.][0-9A-Za-z.-]+)?$/
/** A head "branch" that is a release tag (`v0.20.4`): its runs belong with the default branch. */
export const isTag = (ref: string) => TAG.test(ref)

/** Whether two bead rows draw the same (so a memoized row can skip a render). */
export function sameRow(a: BeadRow, b: BeadRow): boolean {
  return a.workflowId === b.workflowId && a.label === b.label && a.workflow === b.workflow && a.beads.length === b.beads.length && a.beads.every((x, i) => x === b.beads[i])
}

/**
 * The run list as the pipeline design shows it: the default branch first with one bead row per workflow (release tags
 * included), then every other branch, latest push first, each with its pull request, its latest run and a bead row per
 * workflow. `runs` is newest first, as GitHub lists them.
 */
export function groupRuns(runs: readonly WorkflowRun[], { defaultBranch, pulls = [], beads: limit = { main: 14, branch: 8 } }: {
  defaultBranch?: string; pulls?: readonly BranchPull[]; beads?: { main: number; branch: number }
}): { main?: BranchGroup; branches: BranchGroup[] } {
  const groups = new Map<string, WorkflowRun[]>()
  for (const run of runs) {
    const branch = defaultBranch && isTag(run.head_branch) ? defaultBranch : run.head_branch
    if (!groups.has(branch)) groups.set(branch, [])
    groups.get(branch)!.push(run)
  }
  const pullFor = new Map(pulls.map(p => [p.branch, p]))
  const group = (branch: string, list: WorkflowRun[]): BranchGroup => {
    const isDefault = branch === defaultBranch
    const byWorkflow = new Map<number, WorkflowRun[]>()
    for (const r of list) byWorkflow.set(r.workflow_id, [...(byWorkflow.get(r.workflow_id) ?? []), r])
    const rows = [...byWorkflow.entries()].sort(([a], [b]) => a - b).map(([workflowId, rs]): BeadRow => ({
      workflowId,
      workflow: rs[0]!.workflow_name,
      beads: rs.slice(0, isDefault ? limit.main : limit.branch).reverse().map(bead),
      latest: rs[0]!,
      label: isTag(rs[0]!.head_branch) ? rs[0]!.head_branch : `#${rs[0]!.number}`,
    }))
    const pull = pullFor.get(branch) ?? list.flatMap(r => r.pull_requests ?? []).map(n => ({ branch, number: n, state: "OPEN" }))[0]
    return { branch, isDefault, latest: list[0]!, rows, ...(pull ? { pull } : {}) }
  }
  const all = [...groups.entries()].map(([b, list]) => group(b, list))
  const main = all.find(g => g.isDefault)
  const branches = all.filter(g => !g.isDefault).sort((a, b) => Date.parse(b.latest.created_at) - Date.parse(a.latest.created_at))
  return { ...(main ? { main } : {}), branches }
}

/** Groups whose branch (or pull request number) contains `query`. */
export function filterGroups<T extends Pick<BranchGroup, "branch" | "pull">>(groups: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase().replace(/^#/, "")
  return q ? groups.filter(g => g.branch.toLowerCase().includes(q) || (g.pull && String(g.pull.number) === q)) : [...groups]
}
