// Finished-run notices (ADE-97): when a run the user started, or a run on their current branch, finishes, an in-app toast and,
// while the window is not focused, a system notification (the same plumbing and `notifications` setting as agent toasts).
//
// The Actions tab feeds every list it reads through `observe`. A repository with a run worth announcing still running is also
// read here every 60 s while the window is visible, so leaving the tab does not lose the notice; a hidden window reads
// nothing and catches up when it is shown. Nothing runs for a repository with no such run.
import { finishedSince, finishNotice, IDLE_REFRESH_MS, isActive, repoKey, shouldAnnounce, snapshotRuns, type ActionsRepo, type AnnounceContext, type RunSnapshot } from '../../../../../packages/kybern-client/src/actions.ts'
import type { WorkflowRun } from '../../../../../packages/kybern-client/src/types.ts'
import { getData } from '../../composer/store.ts'
import { notifications } from '../../native/notifications.ts'
import { isWindowVisible, onWindowVisibility } from '../../native/visibility.ts'
import { goPage } from '../../nav/history.ts'
import { toast } from '../../shell/toasts.tsx'
import { isWindowFocused } from '../../shell/window.ts'
import { prCall } from '../client.ts'
import { focusActions } from './store.ts'

const MAX_REPOS = 16
const MAX_SNAPSHOT = 200

interface Watched {
  repo: ActionsRepo
  snapshot: RunSnapshot
  viewer?: string
  branch?: string | null
  /** When a list of this repository was last read, by the tab or by the watcher. */
  readAt: number
  /** Runs worth announcing that were still running at the last read. */
  pending: boolean
}

const repos = new Map<string, Watched>()
const started = new Set<number>()
const announced = new Set<string>()
const targets = new Map<string, ActionsFocus>()
type ActionsFocus = ActionsRepo & { runId: number }
let timer: ReturnType<typeof setTimeout> | null = null
let stops: (() => void)[] = []

function start() {
  if (stops.length) return
  stops.push(onWindowVisibility(visible => { if (visible) void pollDue(true); else stop() }))
  stops.push(notifications.onClick(id => {
    const target = targets.get(id)
    if (target) openRun(target)
  }))
}
function stop() { if (timer) clearTimeout(timer); timer = null }

function openRun(target: ActionsFocus) {
  goPage('pulls')
  focusActions(target)
}

/** A run this client started or reran: its finish is announced wherever it is. */
export function markStarted(runId: number) {
  started.add(runId)
  if (started.size > 100) started.delete(started.values().next().value!)
}

const context = (w: Watched): AnnounceContext => ({ viewer: w.viewer, branch: w.branch, started })

/** A list of `repo`'s runs was read: announce what finished since the last one and keep watching what still runs. */
export function observe(repo: ActionsRepo, runs: readonly WorkflowRun[], viewer?: string, branch?: string | null) {
  start()
  const key = repoKey(repo)
  const known = repos.get(key)
  const w: Watched = known ?? { repo, snapshot: new Map(), readAt: 0, pending: false }
  if (viewer) w.viewer = viewer
  if (branch !== undefined) w.branch = branch
  for (const run of finishedSince(w.snapshot, runs)) if (shouldAnnounce(run, context(w))) announce(repo, run)
  const merged = new Map([...w.snapshot, ...snapshotRuns(runs)])
  while (merged.size > MAX_SNAPSHOT) merged.delete(merged.keys().next().value!)
  w.snapshot = merged
  w.readAt = Date.now()
  w.pending = runs.some(run => isActive(run) && shouldAnnounce(run, context(w)))
  repos.delete(key); repos.set(key, w)
  while (repos.size > MAX_REPOS) repos.delete(repos.keys().next().value!)
  schedule()
}

function schedule() {
  stop()
  if (!isWindowVisible() || ![...repos.values()].some(w => w.pending)) return
  timer = setTimeout(() => { timer = null; void pollDue(false) }, IDLE_REFRESH_MS)
}

/** Read every repository with a pending run whose last read is older than the interval (or any, once the window is shown). */
async function pollDue(shown: boolean) {
  const due = [...repos.values()].filter(w => w.pending && (shown || Date.now() - w.readAt >= IDLE_REFRESH_MS - 1000))
  for (const w of due) {
    const member = w.repo.repo ? { repo: w.repo.repo } : {}
    try {
      const [listed, branches] = await Promise.all([
        prCall(w.repo.projectId, 'github.actions.runs', { project_id: w.repo.projectId, ...member, per_page: 30 }),
        prCall(w.repo.projectId, 'git.branches', { project_id: w.repo.projectId, ...member }).catch(() => null),
      ])
      observe(w.repo, listed.runs, listed.viewer, branches ? branches.current ?? null : undefined)
    } catch { /* offline or signed out: try again at the next interval */ }
  }
  schedule()
}

function announce(repo: ActionsRepo, run: WorkflowRun) {
  const id = `actions:${repoKey(repo)}:${run.id}:${run.attempt}`
  if (announced.has(id)) return
  announced.add(id)
  if (announced.size > 200) announced.delete(announced.values().next().value!)
  if (getData().settings?.notifications === false) return
  const notice = finishNotice(run)
  const target = { ...repo, runId: run.id }
  targets.set(id, target)
  if (targets.size > 100) targets.delete(targets.keys().next().value!)
  const show = notice.kind === 'error' ? toast.error : notice.kind === 'success' ? toast.success : toast
  show(notice.title, { id, description: notice.body, duration: 8000, action: { label: 'Open run', onClick: () => openRun(target) } })
  if (isWindowFocused()) return
  void notifications.requestPermission().then(status => {
    if (status === 'granted' && !isWindowFocused()) return notifications.post({ id, title: notice.title, body: notice.body, group: `actions:${run.id}` })
  }).catch(error => console.error('[notifications]', error))
}

/** For tests: forget everything. */
export function resetWatch() {
  stop(); for (const s of stops) s(); stops = []
  repos.clear(); started.clear(); announced.clear(); targets.clear()
}
