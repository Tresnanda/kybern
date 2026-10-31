// GitHub Actions for every client (ADE-97): status buckets and words, the refresh rule, finish detection for
// notifications, job log lines (GitHub's markers and ANSI colours mapped to tones, escapes stripped), the bounded
// log window and the "Fix with agent" prompt. GPUIX draws them; mobile can reuse them as they are.
import type { ActionsLogResult, WorkflowJob, WorkflowRun, WorkflowStep } from "./types.ts"

export type RunBucket = "failed" | "running" | "queued" | "passed" | "skipped" | "cancelled"
type Statused = Pick<WorkflowRun | WorkflowJob | WorkflowStep, "status" | "conclusion">

/** One bucket per run, job or step: what colour and mark it gets. */
export function runBucket(item: Statused): RunBucket {
  if (item.status !== "completed") return item.status === "in_progress" ? "running" : "queued"
  switch (item.conclusion) {
    case "success": return "passed"
    case "cancelled": return "cancelled"
    case "skipped": case "neutral": case "stale": return "skipped"
    default: return "failed"
  }
}

export const RUN_WORDS: Record<RunBucket, string> = {
  failed: "Failed",
  running: "Running",
  queued: "Queued",
  passed: "Passed",
  skipped: "Skipped",
  cancelled: "Cancelled",
}

/** The word for a run, with GitHub's finer conclusions where they say more than "Failed". */
export function runWord(item: Statused): string {
  if (item.status === "waiting") return "Waiting"
  if (item.status === "completed" && item.conclusion === "timed_out") return "Timed out"
  if (item.status === "completed" && item.conclusion === "action_required") return "Needs approval"
  if (item.status === "completed" && item.conclusion === "startup_failure") return "Couldn't start"
  return RUN_WORDS[runBucket(item)]
}

export const isActive = (item: Pick<WorkflowRun, "status">) => item.status !== "completed"

/** The tone a bucket draws in (`kit/tone.ts`). */
export const BUCKET_TONE = { failed: "danger", running: "warning", queued: "neutral", passed: "success", skipped: "neutral", cancelled: "neutral" } as const satisfies Record<RunBucket, string>

/** How a run started, in words. */
export function eventWord(event: string): string {
  switch (event) {
    case "push": return "Push"
    case "pull_request": case "pull_request_target": return "Pull request"
    case "workflow_dispatch": return "Manual"
    case "schedule": return "Scheduled"
    case "release": return "Release"
    case "merge_group": return "Merge queue"
    case "workflow_run": return "After workflow"
    case "repository_dispatch": return "API"
    default: return event ? event.charAt(0).toUpperCase() + event.slice(1).replace(/_/g, " ") : ""
  }
}

/** `1m 12s`, `45s`, `2h 3m`: from start to end (or `now` while running). Empty without a start. */
export function elapsed(start: string | undefined, end: string | undefined, now = Date.now()): string {
  const from = start ? Date.parse(start) : NaN
  const to = end ? Date.parse(end) : now
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return ""
  const s = Math.round((to - from) / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

// ---- refresh ----

export const ACTIVE_REFRESH_MS = 10_000
export const IDLE_REFRESH_MS = 60_000

/**
 * When to read again: every 10 s while a run on screen is in progress, every 60 s otherwise, and never while the
 * window is hidden (a hidden window reads once it is shown again).
 */
export function refreshDelay({ active, onScreen, windowVisible }: { active: boolean; onScreen: boolean; windowVisible: boolean }): number | null {
  if (!windowVisible) return null
  return active && onScreen ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS
}

// ---- finish detection ----

export interface AnnounceContext {
  /** The signed-in `gh` account. */
  viewer?: string
  /** The branch the user is on in this repository. */
  branch?: string | null
  /** Runs the user started or reran from this client. */
  started: ReadonlySet<number>
}

/** A run worth a notice when it finishes: one the user started (here, by hand or by a rerun) or one on their branch. */
export function shouldAnnounce(run: WorkflowRun, context: AnnounceContext): boolean {
  if (context.started.has(run.id)) return true
  if (context.branch && run.head_branch === context.branch) return true
  return !!context.viewer && run.actor === context.viewer && (run.event === "workflow_dispatch" || run.attempt > 1)
}

/** What a repository's runs looked like at the last read: id to `status:attempt`. */
export type RunSnapshot = ReadonlyMap<number, string>

export function snapshotRuns(runs: readonly WorkflowRun[]): RunSnapshot {
  return new Map(runs.map(r => [r.id, `${r.status}:${r.attempt}`]))
}

/**
 * Runs that finished since `previous`: seen unfinished then (or a new attempt of one), completed now. A run first
 * seen already completed is history, not news.
 */
export function finishedSince(previous: RunSnapshot, runs: readonly WorkflowRun[]): WorkflowRun[] {
  return runs.filter(run => {
    if (run.status !== "completed") return false
    const before = previous.get(run.id)
    if (!before) return false
    const [status, attempt] = before.split(":")
    return status !== "completed" || Number(attempt) < run.attempt
  })
}

/** A finished run's notice: "CI #695 failed" over "main · Fix the importer". */
export function finishNotice(run: WorkflowRun): { title: string; body: string; kind: "success" | "error" | "default" } {
  const bucket = runBucket(run)
  const verb = bucket === "passed" ? "passed" : bucket === "cancelled" ? "was cancelled" : bucket === "skipped" ? "was skipped" : run.conclusion === "timed_out" ? "timed out" : "failed"
  return {
    title: `${run.workflow_name || "Workflow"} #${run.number} ${verb}`,
    body: [run.head_branch, run.title].filter(Boolean).join(" · "),
    kind: bucket === "passed" ? "success" : bucket === "failed" ? "error" : "default",
  }
}

// ---- log lines ----

export type LogTone = "default" | "error" | "warning" | "success" | "info" | "muted" | "group" | "command"
export interface LogLine { text: string; tone: LogTone; hidden?: boolean }

/** Every ANSI escape: CSI (colours, cursor), OSC (titles, links) and lone two-byte escapes. */
// eslint-disable-next-line no-control-regex
const ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g
// eslint-disable-next-line no-control-regex
const SGR = /\u001b\[([0-9;]*)m/g

export function stripAnsi(text: string): string {
  return text.replace(ESCAPES, "")
}

/** The tone of the first colour a line sets, so a red `error:` from cargo reads red without raw escapes. */
function ansiTone(raw: string): LogTone | null {
  for (const match of raw.matchAll(SGR)) {
    const codes = (match[1] || "0").split(";").map(Number)
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i]!
      if (c === 38 || c === 48) { i += codes[i + 1] === 5 ? 2 : 4; continue }
      if (c === 31 || c === 91) return "error"
      if (c === 33 || c === 93) return "warning"
      if (c === 32 || c === 92) return "success"
      if (c === 34 || c === 94 || c === 36 || c === 96 || c === 35 || c === 95) return "info"
      if (c === 90 || c === 2) return "muted"
    }
  }
  return null
}

/** One stored log line: GitHub's workflow commands become tones (a group is a heading), ANSI colours map to tones. */
export function parseLogLine(raw: string): LogLine {
  const marker = /^##\[(group|endgroup|error|warning|notice|debug|command)\]/.exec(raw)
  const text = stripAnsi(marker ? raw.slice(marker[0].length) : raw).replace(/\t/g, "    ")
  switch (marker?.[1]) {
    case "group": return { text, tone: "group" }
    case "endgroup": return { text: "", tone: "muted", hidden: true }
    case "error": return { text: `Error: ${text}`, tone: "error" }
    case "warning": return { text: `Warning: ${text}`, tone: "warning" }
    case "notice": return { text, tone: "info" }
    case "debug": return { text, tone: "muted" }
    case "command": return { text, tone: "command" }
  }
  if (raw.startsWith("[command]")) return { text: stripAnsi(raw.slice(9)), tone: "command" }
  return { text, tone: ansiTone(raw) ?? "default" }
}

// ---- the log window ----

export const LOG_PAGE = 500
/** Lines a viewer holds at most; reading further drops the far end. */
export const LOG_WINDOW = 2000

export interface LogWindow { offset: number; lines: string[]; total: number; errors: number[] }

export function windowFrom(result: ActionsLogResult): LogWindow {
  return { offset: result.offset, lines: result.lines, total: result.total_lines, errors: result.error_lines ?? [] }
}

/** Lines shown above a failed log's last error when it opens: enough for the panic or assertion, with the error still on screen
 * in a log pane under the job graph. */
export const ERROR_CONTEXT = 8

/** Where a failed job's log opens: a few lines before its last error, so the failure is the first thing on screen. */
export function openingOffset(total: number, errors: readonly number[], failed: boolean): number {
  if (!failed || !errors.length) return 0
  const last = errors[errors.length - 1]!
  return Math.max(0, Math.min(total - 1, last - ERROR_CONTEXT))
}

/** The next read for `direction`, or null at that edge. */
export function nextRead(window: LogWindow, direction: "earlier" | "later"): { offset: number; limit: number } | null {
  if (direction === "earlier") {
    if (window.offset === 0) return null
    const offset = Math.max(0, window.offset - LOG_PAGE)
    return { offset, limit: window.offset - offset }
  }
  const end = window.offset + window.lines.length
  return end >= window.total ? null : { offset: end, limit: LOG_PAGE }
}

/** Join a page to the window and trim the far end, so the window never holds more than `LOG_WINDOW` lines. */
export function joinPage(window: LogWindow, page: ActionsLogResult, direction: "earlier" | "later"): LogWindow {
  const errors = page.error_lines ?? window.errors
  if (direction === "earlier") {
    if (page.offset + page.lines.length !== window.offset) return { ...windowFrom(page), errors }
    const lines = [...page.lines, ...window.lines].slice(0, LOG_WINDOW)
    return { offset: page.offset, lines, total: page.total_lines, errors }
  }
  if (page.offset !== window.offset + window.lines.length) return { ...windowFrom(page), errors }
  const joined = [...window.lines, ...page.lines]
  const drop = Math.max(0, joined.length - LOG_WINDOW)
  return { offset: window.offset + drop, lines: joined.slice(drop), total: page.total_lines, errors }
}

// ---- fix with agent ----

/** The step that failed, if GitHub marked one. */
export function failedStep(job: WorkflowJob): WorkflowStep | undefined {
  return job.steps.find(s => s.status === "completed" && runBucket(s) === "failed")
}

/** The agent's prompt for a failed job: what failed, where, a bounded log excerpt and the run's link. */
export function fixPrompt(run: WorkflowRun, job: WorkflowJob, excerpt: readonly string[]): string {
  const step = failedStep(job)
  const log = excerpt.map(stripAnsi).join("\n").slice(-12 * 1024)
  return [
    `Fix the failing CI job “${job.name}” in ${run.workflow_name} #${run.number}${run.attempt > 1 ? ` (attempt ${run.attempt})` : ""}.`,
    `Run: ${run.url}`,
    `Branch: ${run.head_branch} at ${run.head_sha.slice(0, 12)}`,
    ...(step ? [`Failed step: ${step.name}`] : []),
    "",
    log ? `End of the job's log:\n\`\`\`\n${log}\n\`\`\`` : "GitHub has no log for this job yet. Read the run with `gh run view` first.",
    "",
    "Find the cause, fix it on this branch and run the relevant checks locally. Report what failed, what you changed and how you verified it. Leave pushing and rerunning CI to the human.",
  ].join("\n")
}

/** A repository on a project: the project itself, or a group project's member. */
export interface ActionsRepo { projectId: string; repo?: string }
export const repoKey = (r: ActionsRepo) => `${r.projectId}${r.repo ? `/${r.repo}` : ""}`
