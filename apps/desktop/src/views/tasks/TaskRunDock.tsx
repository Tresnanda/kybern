// The foot of a task's page, where work goes to an agent. One place both to start a
// run and to follow one up, always visible as a one-line field that opens in place:
// - no run to follow: "Tell an agent what to do with ADE-3…" (⌘↵ opens it too), with
//   a "Draft" tag while a draft is kept. It opens into the composer with the task as a
//   chip, its linked notes as chips, suggested notes to add, and the run's project,
//   workspace and branch in the tray. Esc hides it; the draft stays.
// - a live run, or one waiting for review: "Follow up with …", which opens into the
//   composer and goes to the run through `tasks.items.followup`.
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { toast } from "sonner"
import { useShallow } from "zustand/react/shallow"

import { COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME, COMPOSER_TRAY_CHIP_CLASS_NAME as TRAY_CHIP_CLASS_NAME } from "@/components/kit/chat/composerPickerStyles"
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/kit/tooltip"
import { mod, PROVIDER_LABEL } from "@/lib/format"
import { ChevronDownIcon, PlusIcon } from "@/lib/kit/icons"
import { observeResizeFrame } from "@/lib/resizeObserver"
import { cn } from "@/lib/utils"
import { noteMentionPart, taskMentionPart, type MentionPart } from "@/lib/userInput"
import type { GitBranchesResult, NoteId, PermissionMode, ProjectId, ProviderInstance, TaskItem, TaskRun, UserMessage } from "@/protocol"
import { locateNote, searchNoteBodies, useAllNotes } from "@/state/notes"
import { noteTitle } from "@/state/notesModel"
import { errorText, rpc, updateThread } from "@/state/rpc"
import { selectAvailableProviders, useStore } from "@/state/store"
import { closeRunComposer, followupTask, openRunComposer, openRunThread, sendTask, updateTask, useTasks, writeSendPrefs } from "@/state/tasks"
import { isLiveRun, latestRun, suggestionQuery } from "@/state/tasksModel"
import { findModel } from "../../../../../packages/kybern-client/src/models"
import { Composer, LandingTray, type ComposerHandle } from "../Composer"
import { BranchTrayChip, ProjectTrayChip, WorkspaceTrayChip } from "../trayChips"
import { AgentMark } from "./TaskGlyphs"
import { useSendDefaults, type SendConfig } from "./sendDefaults"

/** The new-run draft. The follow-up draft is kept apart so neither overwrites the other. */
const runDraftKey = (taskId: string) => `task:${taskId}`
const followupDraftKey = (taskId: string) => `task-followup:${taskId}`

const EASE_DRAWER = [0.32, 0.72, 0, 1] as const
const EASE_OUT = [0.23, 1, 0.32, 1] as const

const TRAY_BUTTON_CLASS_NAME = cn(COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME, "shrink-0 whitespace-nowrap")

export function TaskRunDock({ task }: { task: TaskItem }) {
  const run = latestRun(task)
  const live = isLiveRun(run)
  const canFollowUp = !!run && (live || task.status === "needs_review")
  const request = useTasks((s) => (s.composer?.taskId === task.id ? s.composer : null))
  // One run at a time: a live run takes follow-ups; with no run there is nothing to follow.
  const kind = !request ? null : request.kind === "run" && live ? "followup" : request.kind === "followup" && !run ? "run" : request.kind
  const hasRunDraft = useStore((s) => !!s.composerDrafts[runDraftKey(task.id)])
  const hasFollowupDraft = useStore((s) => !!s.composerDrafts[followupDraftKey(task.id)])
  const reducedMotion = useReducedMotion()

  const dock = useRef<HTMLDivElement>(null)
  const composer = useRef<ComposerHandle>(null)
  const openAfter = useRef(false)

  // ---- focus: into the composer on open, back to what opened it on close ----
  const returnFocus = useRef<HTMLElement | null>(null)
  const quietFocus = useRef(false)
  const wasOpen = useRef(false)
  useLayoutEffect(() => {
    if (kind && !wasOpen.current) {
      const active = document.activeElement
      returnFocus.current = active instanceof HTMLElement && active !== document.body && !dock.current?.contains(active) ? active : null
    }
    wasOpen.current = !!kind
  }, [kind])
  const nonce = request?.nonce
  useEffect(() => {
    if (nonce !== undefined) composer.current?.focus()
  }, [nonce])
  const close = useCallback(
    (restore = true) => {
      const target = returnFocus.current
      returnFocus.current = null
      closeRunComposer(task.id)
      if (!restore) return
      requestAnimationFrame(() => {
        const field = dock.current?.querySelector<HTMLElement>("[data-dock-field]")
        const next = target?.isConnected ? target : field
        quietFocus.current = true
        next?.focus({ preventScroll: true })
        quietFocus.current = false
      })
    },
    [task.id],
  )

  // ---- room for the dock: the column's bottom padding follows its height ----
  useLayoutEffect(() => {
    const element = dock.current
    const main = element?.parentElement
    if (!element || !main) return
    const scroller = main.querySelector<HTMLElement>(".tk-dscroll")
    let last = -1
    const apply = () => {
      const height = Math.round(element.getBoundingClientRect().height)
      if (height === last) return
      last = height
      // Reading the end stays reading the end: the last lines rise with the dock.
      const atEnd = !!scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 4
      main.style.setProperty("--tk-dock-h", `${height}px`)
      if (atEnd && scroller) scroller.scrollTop = scroller.scrollHeight
    }
    apply()
    const stop = observeResizeFrame(element, apply)
    return () => {
      stop()
      main.style.removeProperty("--tk-dock-h")
    }
  }, [])

  // ---- where and how the run starts: the project's last choices, then yours ----
  const global = task.scope === "global" || !task.project_id
  const [chosenProject, setChosenProject] = useState<ProjectId | null>(null)
  const projectId = global ? chosenProject : task.project_id ?? null
  const projects = useStore((s) => s.projects)
  const project = projectId ? projects[projectId] : undefined
  const projectList = useMemo(() => Object.values(projects).sort((a, b) => a.name.localeCompare(b.name)), [projects])
  const isGit = project?.is_git ?? false
  const allProviders = useStore((s) => s.providers)
  const available = useStore(useShallow(selectAvailableProviders))
  const providersLoading = useStore((s) => s.providersLoading)
  const defaults = useSendDefaults(projectId)
  const [picked, setPicked] = useState<Partial<SendConfig>>({})
  const config: SendConfig = { ...defaults, ...picked }
  const pick = (patch: Partial<SendConfig>) => setPicked((current) => ({ ...current, ...patch }))

  const chooseProject = (id: ProjectId) => {
    setChosenProject(id)
    setPicked({})
  }
  const chooseProvider = (provider: ProviderInstance, choice?: { model?: string; effort?: string }) => {
    const status = available.find((item) => item.kind === provider.kind)
    const models = status?.models ?? []
    const modes = status?.supported_permission_modes ?? []
    const model = choice?.model ?? null
    setPicked((current) => {
      const mode = current.permissionMode ?? defaults.permissionMode
      return {
        ...current,
        provider,
        status,
        model,
        modelInfo: model ? findModel(models, model) : models.find((item) => item.is_default),
        effort: choice?.effort ?? null,
        permissionMode: modes.length && !modes.includes(mode) ? modes[0]! : mode,
      }
    })
  }
  const chooseModel = (model: string | undefined, effort: string | undefined) => {
    const models = config.status?.models ?? []
    pick({ model: model ?? null, modelInfo: model ? findModel(models, model) : models.find((item) => item.is_default), effort: effort ?? null })
  }

  const [branches, setBranches] = useState<{ projectId: ProjectId; result: GitBranchesResult } | null>(null)
  const loadBranches = useCallback(() => {
    if (!projectId || !isGit) return
    rpc()
      .call("git.branches", { project_id: projectId })
      .then((result) => setBranches({ projectId, result }))
      .catch(() => setBranches({ projectId, result: { current: null, branches: [] } }))
  }, [projectId, isGit])
  useEffect(() => {
    if (kind === "run") loadBranches()
  }, [kind, loadBranches])
  const projectBranches = branches?.projectId === projectId ? branches.result : null

  // ---- notes: linked ones start as chips, likely ones are offered ----
  const allNotes = useAllNotes()
  const titles = useMemo(() => new Map(allNotes.filter((note) => !note.deleted_at).map((note) => [note.id, noteTitle(note)])), [allNotes])
  const linkedIds = useMemo(() => [...new Set([...(task.source_note_id ? [task.source_note_id] : []), ...task.note_ids])], [task.source_note_id, task.note_ids])
  const initialMentions = useMemo<MentionPart[]>(
    () => [taskMentionPart(task), ...linkedIds.flatMap((id) => (titles.has(id) ? [noteMentionPart({ id, title: titles.get(id)! })] : []))],
    // The chips are read once, when the composer first shows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [task.id, task.key, task.title, linkedIds, titles],
  )
  const [suggested, setSuggested] = useState<{ key: string; ids: NoteId[] }>({ key: "", ids: [] })
  const [added, setAdded] = useState<NoteId[]>([])
  const suggestKey = `${task.title}\n${projectId ?? ""}\n${linkedIds.join(",")}`
  useEffect(() => {
    if (kind !== "run") return
    const query = suggestionQuery(task.title)
    if (!query) return
    let current = true
    const key = `${task.title}\n${projectId ?? ""}\n${linkedIds.join(",")}`
    // One search per word; notes matching more of the words rank higher.
    void Promise.all(query.split(" ").map((word) => searchNoteBodies(word)))
      .then((results) => {
        if (!current) return
        const score = new Map<NoteId, number>()
        for (const hits of results) for (const id of hits.keys()) score.set(id, (score.get(id) ?? 0) + 1)
        const ids = [...score.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([id]) => id)
          .filter((id) => {
            if (linkedIds.includes(id)) return false
            const note = locateNote(id)?.summary
            if (!note || note.deleted_at || note.scope === "thread") return false
            return projectId ? note.project_id === projectId : note.scope === "global"
          })
        setSuggested({ key, ids: ids.slice(0, 3) })
      })
      .catch(() => {})
    return () => {
      current = false
    }
  }, [kind, task.title, linkedIds, projectId])
  const suggestions = suggested.key === suggestKey ? suggested.ids.filter((id) => !added.includes(id) && titles.has(id)) : []

  // ---- sending ----
  const startRun = async (message: UserMessage) => {
    const open = openAfter.current
    openAfter.current = false
    if (!config.provider) throw new Error("Install a coding agent, then try again.")
    if (!projectId) throw new Error("Choose a project to run this task in.")
    const useWorktree = isGit && config.useWorktree
    const result = await sendTask({
      id: task.id,
      provider: config.provider,
      model: config.model,
      effort: config.effort,
      permission_mode: config.permissionMode,
      use_worktree: useWorktree,
      base_branch: useWorktree ? config.baseBranch : null,
      project_id: projectId,
      // The daemon adds the task's saved follow-up to this message as the run starts.
      message,
    })
    writeSendPrefs(projectId, {
      provider: config.provider,
      model: config.model,
      effort: config.effort,
      permissionMode: config.permissionMode,
      useWorktree: config.useWorktree,
      baseBranch: config.baseBranch,
    })
    close(!open)
    if (open) openRunThread(result.thread_id)
    else toast(`${task.key} started`, { action: { label: "Open", onClick: () => openRunThread(result.thread_id) } })
  }
  const startAndOpen = () => {
    openAfter.current = true
    composer.current?.submit()
    // Read synchronously by `startRun`; nothing was sent if it is still set.
    openAfter.current = false
  }

  const sendFollowup = async (message: UserMessage) => {
    if (!run) return
    const wasLive = live
    const result = await followupTask(task.id, message)
    close()
    const sentTo = result.sent_to
    if (sentTo) toast(wasLive ? `Queued for Run ${run.number}` : `Sent to Run ${run.number}`, { action: { label: "Open", onClick: () => openRunThread(sentTo) } })
    else toast("Saved for the next run")
  }

  // ---- keys: ⌘⇧↵ starts and opens, Esc hides (once pickers have had theirs) ----
  const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    if (kind !== "run" || event.key !== "Enter" || !event.shiftKey || !(event.metaKey || event.ctrlKey) || event.nativeEvent.isComposing) return
    event.preventDefault()
    event.stopPropagation()
    startAndOpen()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing) return
    if ((event.target as HTMLElement).closest("[data-slot=menu-popup], [role=menu], [role=dialog], [role=listbox]")) return
    event.preventDefault()
    close()
  }

  // ---- the follow-up composer speaks to the run's thread ----
  const thread = useStore((s) => (run ? s.threads[run.thread_id] : undefined))
  const agent = run ? PROVIDER_LABEL[(thread?.provider ?? run.provider).kind] : ""

  const pending = task.pending_followup?.trim()
  const hide = <HideButton onClick={() => close()} />

  const panel = reducedMotion
    ? {
        initial: { opacity: 0 },
        animate: { opacity: 1, transition: { duration: 0.15 } },
        exit: { opacity: 0, pointerEvents: "none" as const, transition: { duration: 0.12 } },
      }
    : {
        initial: { opacity: 0, transform: "translateY(16px)" },
        animate: { opacity: 1, transform: "translateY(0px)", transition: { duration: 0.26, ease: EASE_DRAWER } },
        exit: { opacity: 0, transform: "translateY(10px)", pointerEvents: "none" as const, transition: { duration: 0.16, ease: EASE_OUT } },
      }
  const rest = {
    initial: { opacity: 0 },
    animate: { opacity: 1, transition: { duration: 0.18, ease: EASE_OUT } },
    exit: { opacity: 0, pointerEvents: "none" as const, transition: { duration: 0.1 } },
  }

  const showField = !kind
  let content: ReactNode = null
  if (kind === "run") {
    content = (
      <motion.div key="run" {...panel} onKeyDownCapture={onKeyDownCapture} onKeyDown={onKeyDown}>
        <Composer
          ref={composer}
          draftKey={runDraftKey(task.id)}
          autoFocus
          initialMentions={initialMentions}
          placeholder={`Tell an agent what to do with ${task.key}, or start it as it is`}
          mode={config.permissionMode}
          onModeChange={(mode: PermissionMode) => pick({ permissionMode: mode })}
          provider={config.provider}
          providers={allProviders}
          onProviderChange={chooseProvider}
          model={config.model}
          effort={config.effort}
          onModelChange={chooseModel}
          projectId={projectId ?? undefined}
          sendDisabled={!config.provider || !projectId}
          disabledReason={providersLoading ? "Checking installed coding agents…" : "Install a coding agent first"}
          onSend={startRun}
          above={
            <>
              {pending && (
                <div className="tk-dock-line">
                  <span className="t" title={pending}>
                    Next run includes: {pending}
                  </span>
                  <button type="button" className="tk-tbtn" onClick={() => void updateTask(task.id, { pending_followup: "" })}>
                    Clear
                  </button>
                </div>
              )}
              {suggestions.length > 0 && (
                <div className="tk-dock-line" role="group" aria-label="Suggested notes">
                  <span className="lbl">Suggested</span>
                  {suggestions.map((id) => {
                    const title = titles.get(id)!
                    return (
                      <button
                        key={id}
                        type="button"
                        className={TRAY_CHIP_CLASS_NAME}
                        title={`Add “${title}” to the message`}
                        onClick={() => {
                          composer.current?.insertMention(noteMentionPart({ id, title }))
                          setAdded((list) => [...list, id])
                        }}
                      >
                        <PlusIcon className="size-3 shrink-0 opacity-60" aria-hidden />
                        <span className="min-w-0 truncate">{title}</span>
                      </button>
                    )
                  })}
                </div>
              )}
              <LandingTray>
                {global && <ProjectTrayChip projectId={projectId} projects={projectList} onPick={chooseProject} label="Choose the project to run in" />}
                {project && isGit && (
                  <WorkspaceTrayChip
                    useWorktree={config.useWorktree}
                    isGit
                    checkoutHint={parentPath(project.path)}
                    onChange={(useWorktree) => pick({ useWorktree })}
                    label="Choose where the run happens"
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
                <TrayButton tip={`Start the run and show it (${mod}⇧↵)`} onClick={startAndOpen} disabled={!config.provider || !projectId}>
                  Start and open
                </TrayButton>
                {hide}
              </LandingTray>
            </>
          }
        />
      </motion.div>
    )
  } else if (kind === "followup" && run) {
    content = (
      <motion.div key="followup" {...panel} onKeyDown={onKeyDown}>
        <Composer
          ref={composer}
          draftKey={followupDraftKey(task.id)}
          autoFocus
          placeholder={`Follow up with ${agent}…`}
          mode={thread?.permission_mode ?? config.permissionMode}
          onModeChange={(mode: PermissionMode) => {
            if (thread) updateThread(thread.id, { permission_mode: mode }).catch((error) => toast.error("Unable to change permissions", { description: errorText(error) }))
          }}
          provider={thread?.provider ?? run.provider}
          providerSessionId={thread?.provider_session_id}
          providers={allProviders}
          model={thread?.model ?? run.model}
          effort={thread?.effort}
          onModelChange={thread ? (model, effort) => updateThread(thread.id, { model, effort }) : undefined}
          projectId={thread?.project_id ?? projectId ?? undefined}
          onSend={sendFollowup}
          above={
            <LandingTray>
              <span className={cn(TRAY_CHIP_CLASS_NAME, "cursor-default")}>
                <AgentMark kind={run.provider.kind} size={13} />
                <span className="min-w-0 truncate">
                  Run {run.number} · {runState(run, task)}
                </span>
              </span>
              <span className="min-w-0 flex-1" />
              {!live && (
                <TrayButton tip="Start a new run instead of following up" onClick={() => openRunComposer(task.id, "run")}>
                  New run
                </TrayButton>
              )}
              {hide}
            </LandingTray>
          }
        />
      </motion.div>
    )
  } else if (showField) {
    // The field is always there. With a run to follow it follows up; otherwise it starts one.
    const following = canFollowUp && !!run
    const open = () => openRunComposer(task.id, following ? "followup" : "run")
    content = (
      <motion.div key="rest" {...rest}>
        <button
          type="button"
          className="tk-fbox"
          data-dock-field
          aria-label={following ? `Follow up with ${agent}` : `Tell an agent what to do with ${task.key}`}
          onClick={open}
          onFocus={() => {
            if (!quietFocus.current) open()
          }}
        >
          <span className="mk">
            <AgentMark kind={(following ? run!.provider.kind : config.provider?.kind) ?? "claude-code"} size={14} />
          </span>
          <span className="t">{following ? `Follow up with ${agent}…` : `Tell an agent what to do with ${task.key}…`}</span>
          {following ? hasFollowupDraft && <span className="tag">Draft</span> : hasRunDraft ? <span className="tag">Draft</span> : <span className="key">{mod}↵</span>}
        </button>
      </motion.div>
    )
  }

  return (
    <div ref={dock} className="tk-dock" data-filled>
      <div className="tk-dock-col">
        {/* Leaving and arriving share one grid cell, so a swap never shifts the page. */}
        <AnimatePresence initial={false}>
          {content}
        </AnimatePresence>
      </div>
    </div>
  )
}

function runState(run: TaskRun, task: TaskItem): string {
  if (run.state === "waiting") return "Waiting for you"
  if (run.state === "running") return "Working"
  return task.status === "needs_review" ? "Needs review" : "Finished"
}

function TrayButton({ tip, onClick, disabled, children }: { tip: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<button type="button" className={TRAY_BUTTON_CLASS_NAME} disabled={disabled} onClick={onClick} />}>{children}</TooltipTrigger>
      <TooltipPopup side="top">{tip}</TooltipPopup>
    </Tooltip>
  )
}

function HideButton({ onClick }: { onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<button type="button" aria-label="Hide the composer" className={cn(TRAY_BUTTON_CLASS_NAME, "px-1.5")} onClick={onClick} />}>
        <ChevronDownIcon className="size-3.5" aria-hidden />
      </TooltipTrigger>
      <TooltipPopup side="top">Hide (Esc). Your draft stays.</TooltipPopup>
    </Tooltip>
  )
}

function parentPath(path: string): string {
  const at = path.lastIndexOf("/")
  return at <= 0 ? path : "…/" + path.slice(path.slice(0, at).lastIndexOf("/") + 1, at)
}
