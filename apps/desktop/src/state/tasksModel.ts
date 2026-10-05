// Tasks model: statuses, keys, grouping, ranks, the body's acceptance criteria and
// the run composer's messages. Pure helpers, so the list's organization is testable
// without React.
import type { ContentPart, NoteId, ProjectId, TaskItem, TaskItemId, TaskPriority, TaskRun, TaskStatus, UserMessage } from "@/protocol"

// ---- statuses and priorities ----

export const STATUS_LABEL: Record<TaskStatus, string> = {
  inbox: "Inbox",
  todo: "To do",
  running: "Running",
  needs_review: "Needs review",
  done: "Done",
  canceled: "Canceled",
}

/** List groups, most urgent attention first. */
export const LIST_STATUS_ORDER: TaskStatus[] = ["running", "needs_review", "todo", "inbox", "done", "canceled"]
/** Board columns, left to right along the task's life. */
export const BOARD_STATUS_ORDER: TaskStatus[] = ["inbox", "todo", "running", "needs_review", "done", "canceled"]
/** Statuses a person sets. Running and Needs review belong to the latest run. */
export const USER_STATUSES: TaskStatus[] = ["inbox", "todo", "done", "canceled"]

export const isUserStatus = (status: TaskStatus): boolean => USER_STATUSES.includes(status)
export const isOpenStatus = (status: TaskStatus): boolean => status !== "done" && status !== "canceled"

export const PRIORITY_LABEL: Record<TaskPriority, string> = { 0: "No priority", 1: "Urgent", 2: "High", 3: "Medium", 4: "Low" }
/** Menu order: none first, like Linear. */
export const PRIORITY_MENU_ORDER: TaskPriority[] = [0, 1, 2, 3, 4]

/** Sort weight: urgent first, no priority last. */
export function priorityWeight(priority: TaskPriority): number {
  return priority === 0 ? 5 : priority
}

/** What a drop on a status does: move there, open Send to agent, or nothing. */
export function dropAction(status: TaskStatus): "move" | "send" | "none" {
  if (status === "running") return "send"
  if (status === "needs_review") return "none"
  return "move"
}

// ---- keys ----

const KEY_PATTERN = /^([A-Z][A-Z0-9]{1,4})-(\d+)$/

/** "ADE-14" → { prefix: "ADE", number: 14 }. */
export function splitTaskKey(key: string): { prefix: string; number: number } | null {
  const match = KEY_PATTERN.exec(key.trim().toUpperCase())
  return match ? { prefix: match[1]!, number: Number(match[2]) } : null
}

/**
 * Read what someone typed as a key: "ADE-14", "ade 14", "ade14", "#14" or "14".
 * Without a prefix it matches that number in any project.
 */
export function parseTaskKeyQuery(input: string): { prefix: string | null; number: number } | null {
  const match = /^#?\s*(?:([a-z][a-z0-9]{1,4}?)[-\s]?)?(\d{1,7})$/i.exec(input.trim())
  if (!match) return null
  return { prefix: match[1] ? match[1].toUpperCase() : null, number: Number(match[2]) }
}

export function keyMatchesQuery(key: string, query: string): boolean {
  const parsed = parseTaskKeyQuery(query)
  const own = splitTaskKey(key)
  if (!parsed || !own) return false
  return own.number === parsed.number && (parsed.prefix === null || parsed.prefix === own.prefix)
}

/** Every task key written in some text, e.g. to link "ADE-18" in a note. */
export function findTaskKeys(text: string): { key: string; index: number }[] {
  const found: { key: string; index: number }[] = []
  for (const match of text.matchAll(/\b([A-Z][A-Z0-9]{1,4}-\d+)\b/g)) found.push({ key: match[1]!, index: match.index ?? 0 })
  return found
}

// ---- task links in notes ----

/** Notes link a task as `[ADE-14](kybern://task/<id>)`. */
export const TASK_LINK_PREFIX = "kybern://task/"
const TASK_LINK_HREF = /^kybern:\/\/task\/([0-9a-f-]{36})\/?$/i

/** The task id a `kybern://task/<id>` link points at. */
export function taskLinkId(href: string | null | undefined): string | null {
  const match = href ? TASK_LINK_HREF.exec(href.trim()) : null
  return match ? match[1]!.toLowerCase() : null
}

export function taskLinkMarkdown(label: string, id: string): string {
  return `[${label}](${TASK_LINK_PREFIX}${id})`
}

// A key stands alone: after a space, an opening bracket or quote (or at the start),
// and before a space or punctuation. "ADE-14," links; "x/ADE-14" and "ADE-14b" do not.
const KEY_BODY = "[A-Z][A-Z0-9]{1,4}-[1-9]\\d{0,6}"
const KEY_BEFORE = "(?<=^|[\\s([{\"'“‘])"
const KEY_AFTER = "(?=$|[\\s.,;:!?)\\]}\"'”’])"
const TYPED_KEY = new RegExp(`${KEY_BEFORE}(${KEY_BODY})([\\s.,;:!?)\\]}"'”’])$`)
const STANDALONE_KEYS = new RegExp(`${KEY_BEFORE}${KEY_BODY}${KEY_AFTER}`, "g")

/**
 * A key just finished by the character typed after it: "see ADE-14," gives
 * ADE-14 and where it starts. `text` ends with that character.
 */
export function typedTaskKey(text: string): { key: string; index: number } | null {
  const match = TYPED_KEY.exec(text)
  return match ? { key: match[1]!, index: match.index } : null
}

/** Standalone keys in pasted text, for linking the ones that name a task. */
export function standaloneTaskKeys(text: string): { key: string; index: number }[] {
  return [...text.matchAll(STANDALONE_KEYS)].map((match) => ({ key: match[0], index: match.index ?? 0 }))
}

/** Sort keys by prefix, then number (ADE-9 before ADE-10). */
export function compareTaskKeys(a: string, b: string): number {
  const x = splitTaskKey(a)
  const y = splitTaskKey(b)
  if (!x || !y) return a.localeCompare(b)
  return x.prefix === y.prefix ? x.number - y.number : x.prefix.localeCompare(y.prefix)
}

// ---- runs ----

export function latestRun(task: Pick<TaskItem, "runs">): TaskRun | null {
  let best: TaskRun | null = null
  for (const run of task.runs) if (!best || run.number > best.number) best = run
  return best
}

/** What a run changed, when it changed anything. */
export function runChanges(run: TaskRun): { added: number; removed: number; files: number } | null {
  return run.diff && run.diff.files > 0 ? run.diff : null
}

export const isLiveRun = (run: TaskRun | null | undefined): boolean => run?.state === "running" || run?.state === "waiting"

/** Minutes and hours, compact: "12m", "1h 4m", "now". */
export function shortDuration(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return "<1m"
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours}h ${rest}m` : `${hours}h`
}

export function runDuration(run: TaskRun, now: number): number {
  const start = Date.parse(run.started_at)
  const end = run.ended_at ? Date.parse(run.ended_at) : now
  return Number.isNaN(start) || Number.isNaN(end) ? 0 : Math.max(0, end - start)
}

/** "Running for 12m", "Finished in 8m", "Canceled after 2m". */
export function runOutcome(run: TaskRun, now: number): string {
  const time = shortDuration(runDuration(run, now))
  switch (run.state) {
    case "running":
      return `Running for ${time}`
    case "waiting":
      return "Waiting for you"
    case "completed":
      return `Finished in ${time}`
    case "failed":
      return `Failed after ${time}`
    case "interrupted":
      return `Canceled after ${time}`
  }
}

/** The file name of an activity line: "Editing crates/x/cursor.rs" → "Editing cursor.rs". */
export function shortActivity(activity: string): string {
  return activity.replace(/(\S*\/)+(\S+)/g, "$2").replace(/^Running (?:pnpm|npm|npx|yarn|bun)(?: run)? /, "Running ")
}

// ---- filters, search and counts ----

export type TaskFilter = "all" | "inbox" | "running" | "needs_review" | "done" | "global" | `project:${string}`

export const RECENTLY_DONE_DAYS = 14

export function isRecentlyDone(task: Pick<TaskItem, "status" | "status_changed_at">, now: number): boolean {
  if (task.status !== "done") return false
  const at = Date.parse(task.status_changed_at)
  return !Number.isNaN(at) && now - at <= RECENTLY_DONE_DAYS * 86_400_000
}

export function filterProjectId(filter: TaskFilter): ProjectId | null {
  return filter.startsWith("project:") ? filter.slice("project:".length) : null
}

export function matchesFilter(task: TaskItem, filter: TaskFilter, now: number): boolean {
  switch (filter) {
    case "all":
      return true
    case "inbox":
    case "running":
    case "needs_review":
      return task.status === filter
    case "done":
      return isRecentlyDone(task, now)
    case "global":
      return task.scope === "global"
    default:
      return task.scope === "project" && task.project_id === filterProjectId(filter)
  }
}

export function filterLabel(filter: TaskFilter, projectName: (id: ProjectId) => string | undefined): string {
  switch (filter) {
    case "all":
      return "All tasks"
    case "inbox":
      return "Inbox"
    case "running":
      return "Running"
    case "needs_review":
      return "Needs review"
    case "done":
      return "Recently done"
    case "global":
      return "Global"
    default:
      return projectName(filterProjectId(filter)!) ?? "Project"
  }
}

/** Tasks matching a search, best first: the key, then titles, then descriptions. */
export function searchTasks(tasks: TaskItem[], query: string): TaskItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return tasks
  const scored: { task: TaskItem; score: number }[] = []
  for (const task of tasks) {
    const title = task.title.toLowerCase()
    let score = -1
    if (task.key.toLowerCase() === q || keyMatchesQuery(task.key, q)) score = 0
    else if (title.startsWith(q)) score = 1
    else if (title.includes(q)) score = 2
    else if (task.key.toLowerCase().includes(q)) score = 3
    else if (task.body.toLowerCase().includes(q)) score = 4
    if (score >= 0) scored.push({ task, score })
  }
  return scored.sort((a, b) => a.score - b.score || b.task.updated_at.localeCompare(a.task.updated_at)).map((entry) => entry.task)
}

export interface TaskCounts {
  /** Open tasks: neither done nor canceled. */
  all: number
  inbox: number
  running: number
  needs_review: number
  done: number
  global: number
  projects: Record<ProjectId, number>
}

export function countTasks(tasks: TaskItem[], now: number): TaskCounts {
  const counts: TaskCounts = { all: 0, inbox: 0, running: 0, needs_review: 0, done: 0, global: 0, projects: {} }
  for (const task of tasks) {
    if (isRecentlyDone(task, now)) counts.done++
    if (!isOpenStatus(task.status)) continue
    counts.all++
    if (task.status === "inbox" || task.status === "running" || task.status === "needs_review") counts[task.status]++
    if (task.scope === "global" || !task.project_id) counts.global++
    else counts.projects[task.project_id] = (counts.projects[task.project_id] ?? 0) + 1
  }
  return counts
}

// ---- grouping and ordering ----

export type TaskGrouping = "status" | "project" | "priority"
export type TaskOrdering = "manual" | "priority" | "updated"

export interface TaskGroup {
  key: string
  label: string
  status?: TaskStatus
  /** Project groups: the project, or null for Global. */
  projectId?: ProjectId | null
  priority?: TaskPriority
  tasks: TaskItem[]
}

export interface GroupOptions {
  grouping: TaskGrouping
  ordering: TaskOrdering
  showDone: boolean
  showCanceled: boolean
}

const statusIndex = (status: TaskStatus) => LIST_STATUS_ORDER.indexOf(status)

export function sortTasks(tasks: TaskItem[], ordering: TaskOrdering, withinStatus: boolean): TaskItem[] {
  const byRank = (a: TaskItem, b: TaskItem) => a.rank - b.rank || compareTaskKeys(a.key, b.key)
  const byStatus = (a: TaskItem, b: TaskItem) => (withinStatus ? 0 : statusIndex(a.status) - statusIndex(b.status))
  const closed = (a: TaskItem, b: TaskItem) => {
    // Finished work reads newest first; its rank no longer means anything.
    if (!isOpenStatus(a.status) && !isOpenStatus(b.status)) return b.status_changed_at.localeCompare(a.status_changed_at)
    return 0
  }
  return [...tasks].sort((a, b) => {
    if (ordering === "updated") return b.updated_at.localeCompare(a.updated_at)
    const status = byStatus(a, b)
    if (status) return status
    const done = closed(a, b)
    if (done) return done
    if (ordering === "priority") return priorityWeight(a.priority) - priorityWeight(b.priority) || byRank(a, b)
    return byRank(a, b)
  })
}

export function groupTasks(
  tasks: TaskItem[],
  options: GroupOptions,
  projects: { id: ProjectId; name: string }[],
): TaskGroup[] {
  const visible = tasks.filter((task) => (options.showDone || task.status !== "done") && (options.showCanceled || task.status !== "canceled"))
  if (options.grouping === "status") {
    return LIST_STATUS_ORDER.map((status) => ({
      key: `status:${status}`,
      label: STATUS_LABEL[status],
      status,
      tasks: sortTasks(visible.filter((task) => task.status === status), options.ordering, true),
    })).filter((group) => group.tasks.length > 0)
  }
  if (options.grouping === "priority") {
    return ([1, 2, 3, 4, 0] as TaskPriority[]).map((priority) => ({
      key: `priority:${priority}`,
      label: PRIORITY_LABEL[priority],
      priority,
      tasks: sortTasks(visible.filter((task) => task.priority === priority), options.ordering, false),
    })).filter((group) => group.tasks.length > 0)
  }
  const known = new Set(projects.map((project) => project.id))
  const groups: TaskGroup[] = projects.map((project) => ({
    key: `project:${project.id}`,
    label: project.name,
    projectId: project.id,
    tasks: sortTasks(visible.filter((task) => task.scope === "project" && task.project_id === project.id), options.ordering, false),
  }))
  groups.push({
    key: "project:global",
    label: "Global",
    projectId: null,
    tasks: sortTasks(visible.filter((task) => task.scope === "global" || !task.project_id || !known.has(task.project_id)), options.ordering, false),
  })
  return groups.filter((group) => group.tasks.length > 0)
}

/** Board columns: every status but Canceled, which shows only when it has tasks and Display allows. */
export function boardColumns(tasks: TaskItem[], options: Pick<GroupOptions, "ordering" | "showDone" | "showCanceled">): { status: TaskStatus; tasks: TaskItem[] }[] {
  return BOARD_STATUS_ORDER.filter(
    (status) => (status !== "done" || options.showDone) && (status !== "canceled" || (options.showCanceled && tasks.some((task) => task.status === "canceled"))),
  ).map((status) => ({ status, tasks: sortTasks(tasks.filter((task) => task.status === status), options.ordering, true) }))
}

// ---- ranks ----

const RANK_STEP = 1024

/** A rank between two neighbours; either may be missing at the ends. */
export function rankBetween(previous: number | undefined, next: number | undefined): number {
  if (previous === undefined && next === undefined) return 0
  if (previous === undefined) return next! - RANK_STEP
  if (next === undefined) return previous + RANK_STEP
  return (previous + next) / 2
}

/**
 * Where a task lands when placed at `index` among `column` (the tasks already
 * there, in order; the moving task may be among them). Returns the task it goes
 * before (what the daemon wants) and the rank to show until the daemon answers.
 */
export function placeAt(column: Pick<TaskItem, "id" | "rank">[], movingId: TaskItemId, index: number): { beforeId: TaskItemId | null; rank: number } {
  const others = column.filter((task) => task.id !== movingId)
  const at = Math.max(0, Math.min(index, others.length))
  const previous = others[at - 1]
  const next = others[at]
  return { beforeId: next?.id ?? null, rank: rankBetween(previous?.rank, next?.rank) }
}

// ---- body: description and acceptance criteria ----

export interface Criterion {
  checked: boolean
  text: string
  /** Indented lines that belonged to the item (nested points), kept as written. */
  extra?: string[]
}

const CRITERION_LINE = /^[-*+] \[([ xX])\] ?(.*)$/
const CRITERIA_HEADING = /^(?:#{1,6}\s+)?(?:\*\*)?(?:acceptance criteria|done when)(?:\*\*)?\s*:?\s*(?:\*\*)?$/i

/**
 * A task's body is Markdown: a description, then optionally a checklist. The
 * checklist items are its acceptance criteria; everything else is the description.
 */
export function splitTaskBody(body: string): { description: string; criteria: Criterion[] } {
  const lines = body.replace(/\r\n?/g, "\n").split("\n")
  const kept: string[] = []
  const criteria: Criterion[] = []
  let current: Criterion | null = null
  let inFence = false
  for (const line of lines) {
    if (/^(```|~~~)/.test(line)) inFence = !inFence
    const match = inFence ? null : CRITERION_LINE.exec(line)
    if (match) {
      current = { checked: match[1] !== " ", text: match[2]!.trim() }
      criteria.push(current)
      continue
    }
    if (current && /^\s{2,}\S/.test(line)) {
      ;(current.extra ??= []).push(line)
      continue
    }
    current = null
    kept.push(line)
  }
  // A heading that only introduced the checklist goes with it.
  while (kept.length && !kept[kept.length - 1]!.trim()) kept.pop()
  if (criteria.length && kept.length && CRITERIA_HEADING.test(kept[kept.length - 1]!.trim())) kept.pop()
  const description = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim()
  return { description, criteria }
}

export function composeTaskBody(description: string, criteria: Criterion[]): string {
  const parts: string[] = []
  const text = description.trim()
  if (text) parts.push(text)
  const items = criteria
    .filter((criterion) => criterion.text.trim() || criterion.extra?.length)
    .map((criterion) => [`- [${criterion.checked ? "x" : " "}] ${criterion.text.trim()}`, ...(criterion.extra ?? [])].join("\n"))
  if (items.length) parts.push(items.join("\n"))
  return parts.length ? `${parts.join("\n\n")}\n` : ""
}

/** `[ADE-14](kybern://task/…)` reads as "ADE-14"; other Markdown links read as their label. */
export function plainInline(text: string): string {
  return text.replace(/\[([^\]]+)\]\((?:[^)\s]+)\)/g, "$1").replace(/(\*\*|__)(.+?)\1/g, "$2").replace(/`([^`]+)`/g, "$1")
}

// ---- the run composer's messages ----

/**
 * A follow-up as the text `tasks.items.followup` takes. Chips become readable text
 * that keeps their target: a note or task keeps its `kybern://` link, a file its
 * path, a skill its name. Attachments cannot travel as text, so they are refused.
 */
export function followupText(message: UserMessage): string {
  return message.parts.map(partText).join("").trim()
}

function partText(part: ContentPart): string {
  switch (part.type) {
    case "text":
      return part.text
    case "mention": {
      const label = part.display_name?.trim() || part.name
      return /^kybern:\/\/(note|task)\//.test(part.path) ? `${label} (${part.path})` : `@${part.name}`
    }
    case "file_mention":
      return `@${part.path}`
    case "skill":
      return `$${part.name}`
    case "thread_reference":
      return `“${part.title}” (thread ${part.thread_id})`
    case "attachment":
    case "image":
      throw new Error("A follow-up to a run takes text only. Remove the attachment, or open the run and send it there.")
  }
}

/** Words worth searching notes for: the title's longer words, minus filler. */
export function suggestionQuery(title: string): string {
  const stop = new Set(["the", "and", "for", "with", "when", "into", "from", "that", "this", "should", "make", "show", "add", "fix", "use", "new", "open"])
  const words = title.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? []
  return [...new Set(words.filter((word) => !stop.has(word)))].slice(0, 4).join(" ")
}

// ---- activity ----

export type ActivityEvent =
  | { kind: "created"; at: string; noteId?: NoteId | null }
  | { kind: "status"; at: string; status: TaskStatus }
  | { kind: "run"; at: string; run: TaskRun }

export function taskActivity(task: TaskItem): ActivityEvent[] {
  const events: ActivityEvent[] = [{ kind: "created", at: task.created_at, noteId: task.source_note_id ?? null }]
  const changed = Date.parse(task.status_changed_at) - Date.parse(task.created_at)
  // The latest user-set status change; run-owned statuses show as runs instead.
  if (isUserStatus(task.status) && changed > 2000) events.push({ kind: "status", at: task.status_changed_at, status: task.status })
  for (const run of task.runs) events.push({ kind: "run", at: run.started_at, run })
  return events.sort((a, b) => a.at.localeCompare(b.at) || (a.kind === "created" ? -1 : b.kind === "created" ? 1 : 0))
}

// ---- view preferences ----

export type TaskView = "list" | "board"

export interface TaskViewPrefs {
  view: TaskView
  grouping: TaskGrouping
  ordering: TaskOrdering
  showDone: boolean
  showCanceled: boolean
  showHints: boolean
  filter: TaskFilter
  /** Group open/closed overrides, by group key. Done and Canceled start closed. */
  collapsed: Record<string, boolean>
  /** Projects pinned to the top of the panel's Projects list. */
  pinnedProjects: string[]
  /** The panel's Projects list shows only pinned projects and the one being viewed. */
  projectsCollapsed: boolean
}

export const DEFAULT_TASK_PREFS: TaskViewPrefs = {
  view: "list",
  grouping: "status",
  ordering: "manual",
  showDone: true,
  showCanceled: false,
  showHints: true,
  filter: "all",
  collapsed: {},
  pinnedProjects: [],
  projectsCollapsed: false,
}

const oneOf = <T extends string>(value: unknown, options: readonly T[], fallback: T): T =>
  typeof value === "string" && (options as readonly string[]).includes(value) ? (value as T) : fallback

export function readTaskPrefs(value: unknown): TaskViewPrefs {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_TASK_PREFS }
  const stored = value as Record<string, unknown>
  const filter = typeof stored.filter === "string" && (["all", "inbox", "running", "needs_review", "done", "global"].includes(stored.filter) || stored.filter.startsWith("project:"))
    ? (stored.filter as TaskFilter)
    : "all"
  const collapsed: Record<string, boolean> = {}
  if (stored.collapsed && typeof stored.collapsed === "object" && !Array.isArray(stored.collapsed)) {
    for (const [key, open] of Object.entries(stored.collapsed)) if (typeof open === "boolean") collapsed[key] = open
  }
  const flag = (key: keyof TaskViewPrefs) => (typeof stored[key] === "boolean" ? (stored[key] as boolean) : (DEFAULT_TASK_PREFS[key] as boolean))
  return {
    view: oneOf(stored.view, ["list", "board"] as const, "list"),
    grouping: oneOf(stored.grouping, ["status", "project", "priority"] as const, "status"),
    ordering: oneOf(stored.ordering, ["manual", "priority", "updated"] as const, "manual"),
    showDone: flag("showDone"),
    showCanceled: flag("showCanceled"),
    showHints: flag("showHints"),
    filter,
    collapsed,
    pinnedProjects: Array.isArray(stored.pinnedProjects) ? [...new Set(stored.pinnedProjects.filter((id): id is string => typeof id === "string" && id.length > 0))] : [],
    projectsCollapsed: flag("projectsCollapsed"),
  }
}

/**
 * The panel's Projects list: pinned projects first, each part in the sidebar's order.
 * Collapsed, only pinned projects and the one being viewed stay visible; the rest
 * keep their place so they can animate back in.
 */
export function arrangeTaskProjects<T extends { id: string }>(
  projects: readonly T[],
  pinned: readonly string[],
  collapsed: boolean,
  currentId: string | null,
): { project: T; pinned: boolean; visible: boolean }[] {
  const pins = new Set(pinned)
  const rows = projects.map((project) => {
    const isPinned = pins.has(project.id)
    return { project, pinned: isPinned, visible: !collapsed || isPinned || project.id === currentId }
  })
  return [...rows.filter((row) => row.pinned), ...rows.filter((row) => !row.pinned)]
}

/** Done and Canceled groups start closed; everything else starts open. */
export function isGroupCollapsed(prefs: Pick<TaskViewPrefs, "collapsed">, group: Pick<TaskGroup, "key" | "status">): boolean {
  const stored = prefs.collapsed[group.key]
  if (stored !== undefined) return stored
  return group.status === "done" || group.status === "canceled"
}
