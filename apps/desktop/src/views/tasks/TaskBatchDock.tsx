// Send to agent for the selection: the task page's run composer, for several tasks. It
// slides up over the Tasks page with a chip for each task that will start, how they
// start (a run each, or one run for all), where they run, and "Start 3 runs" for the
// button. The tasks that already have a live run are skipped and the dock says so.
import { motion, useReducedMotion } from "motion/react"
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { toast } from "sonner"

import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "@/components/kit/alert-dialog"
import { Button } from "@/components/kit/button"
import { TextSwap } from "@/components/kybern/motion"
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/kit/tooltip"
import { mod } from "@/lib/format"
import { taskMentionPart, type MentionPart } from "@/lib/userInput"
import type { GitBranchesResult, PermissionMode, ProjectId, TaskItem, UserMessage } from "@/protocol"
import { rpc } from "@/state/rpc"
import { useStore } from "@/state/store"
import {
  clearSelection,
  closeBatchComposer,
  openRunThread,
  readSendPrefs,
  sendTasks,
  setSelection,
  useTasks,
  writeSendPrefs,
  type BatchComposerRequest,
  type TaskBatchMode,
  type TaskBatchResult,
} from "@/state/tasks"
import { batchProjects, effectiveProject, listKeys, mentionedTaskIds, runsLabel } from "@/state/tasksSelection"
import { Composer, LandingTray, type ComposerHandle } from "../Composer"
import { SendCancelled } from "../sendCancelled"
import { BranchTrayChip, ProjectTrayChip, ProjectWorkspacesTrayChip, RunModeTrayChip, WorkspaceTrayChip } from "../trayChips"
import { useSendPicker } from "./sendDefaults"
import { projectForNewTask, useTaskProjects } from "./taskActions"
import { HideButton, TrayButton } from "./DockButtons"
import { panelMotion, parentPath } from "./dockMotion"

/** More separate runs than this at once asks first. */
const CONFIRM_ABOVE = 5

const isProjectTask = (task: Pick<TaskItem, "scope" | "project_id">) => task.scope === "project" && !!task.project_id

export function TaskBatchDock({ request }: { request: BatchComposerRequest }) {
  const reducedMotion = useReducedMotion()
  const composer = useRef<ComposerHandle>(null)
  const openAfter = useRef(false)

  const tasks = useTasks((s) => s.tasks)
  const projects = useStore((s) => s.projects)
  const allProviders = useStore((s) => s.providers)
  const providersLoading = useStore((s) => s.providersLoading)
  const projectList = useTaskProjects()

  // The chips are the batch: taking one out of the message takes its task out of the run.
  const [chipIds, setChipIds] = useState(request.ids)
  const chosen = useMemo(() => chipIds.flatMap((id) => (tasks[id] ? [tasks[id]!] : [])), [chipIds, tasks])
  const initialMentions = useMemo<MentionPart[]>(
    () => request.ids.flatMap((id) => (useTasks.getState().tasks[id] ? [taskMentionPart(useTasks.getState().tasks[id]!)] : [])),
    [request.ids],
  )
  const skippedKeys = request.skipped.flatMap((id) => (tasks[id] ? [tasks[id]!.key] : []))

  // ---- where they run: each project's own tasks in it, global tasks in the one chosen here ----
  const globals = chosen.filter((task) => !isProjectTask(task))
  const [globalProject, setGlobalProject] = useState<ProjectId | null>(() => {
    const own = batchProjects(request.ids.flatMap((id) => (tasks[id] && isProjectTask(tasks[id]!) ? [tasks[id]!] : [])), null)
    return (own.length === 1 ? own[0]! : projectForNewTask()) as ProjectId | null
  })
  const projectIds = batchProjects(chosen, globalProject) as ProjectId[]
  const mixed = projectIds.length > 1
  const soleProject = projectIds.length === 1 ? projectIds[0]! : null
  const project = soleProject ? projects[soleProject] : undefined
  const isGit = project?.is_git ?? false

  // ---- how they start ----
  const [chosenMode, setMode] = useState<TaskBatchMode>("separate")
  const mode: TaskBatchMode = mixed ? "separate" : chosenMode
  const count = chosen.length
  const runs = mode === "combined" ? 1 : count

  const { config, pick, chooseProvider, chooseModel, reset } = useSendPicker(projectIds[0] ?? null)
  const [worktrees, setWorktrees] = useState<Record<string, boolean>>({})
  const worktreeFor = (id: ProjectId): boolean => {
    const git = projects[id]?.is_git ?? false
    if (!git) return false
    if (id === soleProject) return config.useWorktree
    return worktrees[id] ?? readSendPrefs(id).useWorktree ?? true
  }
  const baseBranchFor = (id: ProjectId): string | null => (id === soleProject ? config.baseBranch : readSendPrefs(id).baseBranch ?? null)

  const [branches, setBranches] = useState<{ projectId: ProjectId; result: GitBranchesResult } | null>(null)
  const loadBranches = () => {
    if (!soleProject || !isGit) return
    rpc()
      .call("git.branches", { project_id: soleProject })
      .then((result) => setBranches({ projectId: soleProject, result }))
      .catch(() => setBranches({ projectId: soleProject, result: { current: null, branches: [] } }))
  }
  useEffect(() => {
    if (!soleProject || !isGit) return
    let current = true
    rpc()
      .call("git.branches", { project_id: soleProject })
      .then((result) => current && setBranches({ projectId: soleProject, result }))
      .catch(() => current && setBranches({ projectId: soleProject, result: { current: null, branches: [] } }))
    return () => {
      current = false
    }
  }, [soleProject, isGit])
  const projectBranches = branches?.projectId === soleProject ? branches.result : null

  // ---- more than five runs at once asks first ----
  const [confirm, setConfirm] = useState<{ count: number; resolve: (ok: boolean) => void } | null>(null)
  // The count stays in the dialog's words while it fades out.
  const [confirmCount, setConfirmCount] = useState(0)
  const askToStart = (many: number) =>
    new Promise<boolean>((resolve) => {
      setConfirmCount(many)
      setConfirm({ count: many, resolve })
    })
  const answer = (ok: boolean) => {
    confirm?.resolve(ok)
    setConfirm(null)
  }

  // ---- sending ----
  const onSend = async (message: UserMessage) => {
    const open = openAfter.current
    openAfter.current = false
    if (!config.provider) throw new Error("Install a coding agent, then try again.")
    const live = useTasks.getState().tasks
    const batch = mentionedTaskIds(message.parts, request.ids).flatMap((id) => (live[id] ? [live[id]!] : []))
    if (!batch.length) throw new Error("Add at least one task to start.")
    if (batch.some((task) => !isProjectTask(task)) && !globalProject) throw new Error("Choose a project for the global tasks, then try again.")
    const several = batchProjects(batch, globalProject).length > 1
    const runMode: TaskBatchMode = several ? "separate" : mode
    if (runMode === "separate" && batch.length > CONFIRM_ABOVE && !(await askToStart(batch.length))) throw new SendCancelled()

    const items = batch.map((task) => {
      const projectId = effectiveProject(task, globalProject)! as ProjectId
      const useWorktree = worktreeFor(projectId)
      return { id: task.id, project_id: projectId, use_worktree: useWorktree, base_branch: useWorktree ? baseBranchFor(projectId) : null }
    })
    const result = await sendTasks({
      mode: runMode,
      items,
      provider: config.provider,
      model: config.model,
      effort: config.effort,
      permission_mode: config.permissionMode as PermissionMode,
      message,
    })
    for (const item of items) {
      writeSendPrefs(item.project_id, {
        provider: config.provider,
        model: config.model,
        effort: config.effort,
        permissionMode: config.permissionMode,
        useWorktree: item.use_worktree,
        baseBranch: baseBranchFor(item.project_id),
      })
    }
    closeBatchComposer()
    // Whatever did not start stays selected, so it can be tried again.
    const retry = result.failed.map((failure) => failure.id)
    if (retry.length) setSelection(retry)
    else clearSelection()
    report(result, items.length, runMode, open)
  }

  const startAndOpen = () => {
    openAfter.current = true
    composer.current?.submit()
    // `onSend` reads this synchronously; nothing was sent if it is still set.
    openAfter.current = false
  }

  // ---- keys: ⌘⇧↵ starts and opens, Esc hides (once pickers have had theirs) ----
  const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    if (mode !== "combined" || event.key !== "Enter" || !event.shiftKey || !(event.metaKey || event.ctrlKey) || event.nativeEvent.isComposing) return
    event.preventDefault()
    event.stopPropagation()
    startAndOpen()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing) return
    if ((event.target as HTMLElement).closest("[data-slot=menu-popup], [role=menu], [role=dialog], [role=alertdialog], [role=listbox]")) return
    event.preventDefault()
    hide()
  }

  const explain = count === 1 ? "This task starts a run with this message." : mode === "combined" ? `One agent works through all ${count} tasks in one thread.` : "Each task starts its own run with this message."
  const needsProject = globals.length > 0 && !globalProject

  return (
    <motion.div className="tk-dock" data-filled data-batch {...panelMotion(reducedMotion)} onKeyDownCapture={onKeyDownCapture} onKeyDown={onKeyDown}>
      <div className="tk-dock-col">
        <Composer
          ref={composer}
          draftKey={`tasks:batch:${request.ids.join(",")}`}
          autoFocus
          initialMentions={initialMentions}
          onMentionsChange={(parts) => setChipIds(mentionedTaskIds(parts, request.ids))}
          placeholder={count === 1 ? "Add instructions, or start it as it is" : `Add instructions for all ${count}, or start them as they are`}
          sendLabel={`Start ${runsLabel(runs)}`}
          mode={config.permissionMode}
          onModeChange={(next: PermissionMode) => pick({ permissionMode: next })}
          provider={config.provider}
          providers={allProviders}
          onProviderChange={chooseProvider}
          model={config.model}
          effort={config.effort}
          onModelChange={chooseModel}
          projectId={projectIds[0]}
          sendDisabled={!config.provider || count === 0 || needsProject}
          disabledReason={providersLoading ? "Checking installed coding agents…" : "Install a coding agent first"}
          onSend={onSend}
          above={
            <>
              <div className="tk-dock-line">
                <TextSwap className="t" text={explain} />
                {skippedKeys.length > 0 && (
                  <Tooltip>
                    <TooltipTrigger render={<span className="skip" tabIndex={0} />}>{skippedKeys.length} already running, skipped</TooltipTrigger>
                    <TooltipPopup side="top">
                      {listKeys(skippedKeys)} {skippedKeys.length === 1 ? "has" : "have"} a live run
                    </TooltipPopup>
                  </Tooltip>
                )}
              </div>
              <LandingTray>
                {count > 1 && <RunModeTrayChip mode={mode} count={count} combinedDisabled={mixed ? "One run needs tasks from one project" : null} onChange={setMode} />}
                {globals.length > 0 && (
                  <ProjectTrayChip
                    projectId={globalProject}
                    projects={projectList}
                    prefix="Global tasks run in"
                    placeholder="Choose a project"
                    onPick={(id) => {
                      setGlobalProject(id)
                      reset()
                    }}
                    label="Choose the project the global tasks run in"
                  />
                )}
                {mixed && (
                  <ProjectWorkspacesTrayChip
                    entries={projectIds.map((id) => ({
                      projectId: id,
                      name: projects[id]?.name ?? "Project",
                      isGit: projects[id]?.is_git ?? false,
                      useWorktree: worktreeFor(id),
                      checkoutHint: projects[id] ? parentPath(projects[id]!.path) : undefined,
                    }))}
                    onChange={(id, useWorktree) => setWorktrees((current) => ({ ...current, [id]: useWorktree }))}
                  />
                )}
                {project && isGit && (
                  <WorkspaceTrayChip
                    useWorktree={config.useWorktree}
                    isGit
                    checkoutHint={parentPath(project.path)}
                    onChange={(useWorktree) => pick({ useWorktree })}
                    label="Choose where the runs happen"
                  />
                )}
                {project && isGit && config.useWorktree && (
                  <BranchTrayChip
                    branches={projectBranches}
                    baseBranch={config.baseBranch}
                    useWorktree
                    onOpen={loadBranches}
                    onBranch={(baseBranch) => pick({ baseBranch })}
                    onWorktree={(useWorktree) => pick({ useWorktree })}
                  />
                )}
                <span className="min-w-0 flex-1" />
                {mode === "combined" && (
                  <TrayButton tip={`Start the run and show it (${mod}⇧↵)`} onClick={startAndOpen} disabled={!config.provider || count === 0 || needsProject}>
                    Start and open
                  </TrayButton>
                )}
                <HideButton onClick={hide} tip="Hide (Esc). The selection stays." />
              </LandingTray>
            </>
          }
        />
      </div>
      <AlertDialog open={!!confirm} onOpenChange={(open) => !open && answer(false)}>
        <AlertDialogPopup className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Start {confirmCount} runs at once?</AlertDialogTitle>
            <AlertDialogDescription className="text-pretty">
              Each task gets its own agent, and all {confirmCount} work at the same time. They share your plan’s usage limits.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="chrome-outline" />}>Cancel</AlertDialogClose>
            <AlertDialogClose render={<Button autoFocus />} onClick={() => answer(true)}>
              Start {confirmCount} runs
            </AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </motion.div>
  )
}

/** Hide the dock and give the focus back to the bar's Send to agent button when it returns. */
function hide() {
  closeBatchComposer()
  requestAnimationFrame(() =>
    requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-selbar-send]")?.focus({ preventScroll: true })),
  )
}

/** What happened, in one toast: how many runs started, which tasks, and what to try again. */
function report(result: TaskBatchResult, asked: number, mode: TaskBatchMode, open: boolean) {
  const first = result.started[0]
  const started = mode === "combined" ? (first ? 1 : 0) : result.started.length
  if (open && first) openRunThread(first.thread_id)
  const failures = [
    ...result.failed.map((failure) => ({ id: failure.id, text: failure.error })),
    ...result.skipped.map((item) => ({ id: item.id, text: item.reason })),
  ]
  const keyOf = (id: string) => useTasks.getState().tasks[id]?.key ?? id
  if (failures.length) {
    toast(`Started ${started} of ${runsLabel(mode === "combined" ? 1 : asked)}`, {
      description: `${failures.map((failure) => `${keyOf(failure.id)}: ${failure.text}`).join(". ")}. Try again from its page.`,
    })
    return
  }
  if (open) return
  if (started === 1 && first) {
    toast("Started 1 run", { action: { label: "Open", onClick: () => openRunThread(first.thread_id) } })
    return
  }
  const keys = result.started.map((item) => item.task.key)
  toast(`Started ${runsLabel(started)}`, { description: `${listKeys(keys)} ${keys.length === 1 ? "is" : "are"} in Running.` })
}

