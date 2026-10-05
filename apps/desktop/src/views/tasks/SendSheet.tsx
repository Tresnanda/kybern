// Send to agent: a sheet that slides down from under the title bar. One summary line
// (agent · model · workspace) opens into the pickers; then the notes sent as context,
// with their approximate size; then the prompt, prefilled from the task and editable.
// Start runs in the background; Start and open shows the run.
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { toast } from "sonner"

import { ComposerPickerMenuPopup } from "@/components/kit/chat/ComposerPickerMenuPopup"
import { Menu, MenuGroup, MenuGroupLabel, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "@/components/kit/menu"
import { mod, PERMISSION_LABEL, PROVIDER_LABEL } from "@/lib/format"
import { ChevronDownIcon } from "@/lib/kit/icons"
import type { GitBranchesResult, NoteId, PermissionMode, ProjectId, ProviderKind, TaskItem } from "@/protocol"
import { locateNote, noteClient, searchNoteBodies, useAllNotes } from "@/state/notes"
import { noteTitle } from "@/state/notesModel"
import { errorText, rpc } from "@/state/rpc"
import { closeSendSheet, openRunThread, readSendPrefs, sendTask, updateTask, useTask, useTasks, writeSendPrefs } from "@/state/tasks"
import { approxTokens, buildTaskPrompt, formatTokens, splitTaskBody, suggestionQuery } from "@/state/tasksModel"
import { selectAvailableProviders, useStore } from "@/state/store"
import { useShallow } from "zustand/react/shallow"
import { ProjectDot } from "@/lib/kit/projectDot"
import { AgentMark } from "./TaskGlyphs"
import { agentLabel, modelLabel, resolveSendConfig, workspaceLabel, type SendConfig } from "./sendDefaults"

const EASE_SHEET = [0.32, 0.72, 0, 1] as const

export function SendSheet() {
  const sheet = useTasks((s) => s.sheet)
  const reducedMotion = useReducedMotion()
  return (
    <AnimatePresence>
      {sheet && (
        <motion.div
          key={sheet.nonce}
          className="tk-sheet-layer"
          initial={{ opacity: 1 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 1, transition: { duration: 0.2 } }}
        >
          <motion.div
            className="tk-scrim"
            aria-hidden
            onClick={closeSendSheet}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { duration: 0.2, ease: "easeOut" } }}
            exit={{ opacity: 0, transition: { duration: 0.18, ease: "easeOut" } }}
          />
          <motion.div
            className="tk-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="tk-sheet-title"
            initial={reducedMotion ? { opacity: 0 } : { y: "-100%" }}
            animate={reducedMotion ? { opacity: 1, transition: { duration: 0.15 } } : { y: 0, transition: { duration: 0.24, ease: EASE_SHEET } }}
            exit={reducedMotion ? { opacity: 0, transition: { duration: 0.12 } } : { y: "-100%", transition: { duration: 0.18, ease: [0.4, 0, 1, 1] } }}
          >
            <SheetContent taskId={sheet.taskId} />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

interface ContextNote {
  id: NoteId
  title: string
  chars: number | null
}

function SheetContent({ taskId }: { taskId: string }) {
  const task = useTask(taskId)
  useEffect(() => {
    if (!task) closeSendSheet()
  }, [task])
  if (!task) return null
  return <SheetForm task={task} />
}

function SheetForm({ task }: { task: TaskItem }) {
  const projects = useStore((s) => s.projects)
  const providers = useStore(useShallow(selectAvailableProviders))
  const settings = useStore((s) => s.settings)
  const allNotes = useAllNotes()
  const global = task.scope === "global" || !task.project_id
  const [projectId, setProjectId] = useState<ProjectId | null>(global ? null : task.project_id ?? null)
  const project = projectId ? projects[projectId] : undefined
  // The choices start at the project's remembered defaults (which settle once the
  // agents are listed) and follow your picks.
  const [picked, setPicked] = useState<Partial<SendConfig>>({})
  const defaults = useMemo(() => resolveSendConfig({ prefs: readSendPrefs(projectId), providers, settings, project }), [projectId, providers, settings, project])
  const config: SendConfig = { ...defaults, ...picked }
  const setConfig = (update: (current: SendConfig) => SendConfig) => setPicked((current) => ({ ...current, ...update({ ...defaults, ...current }) }))
  const [expanded, setExpanded] = useState(global)
  const [branches, setBranches] = useState<GitBranchesResult | null>(null)
  const [busy, setBusy] = useState<"start" | "open" | null>(null)
  const [error, setError] = useState<string | null>(null)

  const parts = useMemo(() => splitTaskBody(task.body), [task.body])
  const initialPrompt = useMemo(
    () => buildTaskPrompt({ title: task.title, description: parts.description, criteria: parts.criteria, pendingFollowup: task.pending_followup }),
    [task.title, parts, task.pending_followup],
  )
  const [prompt, setPrompt] = useState(initialPrompt)
  const edited = prompt !== initialPrompt

  // ---- context ----
  const linkedIds = useMemo(() => [...new Set([...(task.source_note_id ? [task.source_note_id] : []), ...task.note_ids])], [task.source_note_id, task.note_ids])
  const [checked, setChecked] = useState<Set<NoteId>>(() => new Set(linkedIds))
  const [suggested, setSuggested] = useState<NoteId[]>([])
  const [sizes, setSizes] = useState<Record<NoteId, number>>({})
  const titles = useMemo(() => new Map(allNotes.map((note) => [note.id, noteTitle(note)])), [allNotes])

  useEffect(() => {
    let live = true
    const query = suggestionQuery(task.title)
    if (!query) return
    // One search per word; notes matching more of the words rank higher.
    void Promise.all(query.split(" ").map((word) => searchNoteBodies(word))).then((results) => {
      if (!live) return
      const score = new Map<NoteId, number>()
      for (const hits of results) for (const id of hits.keys()) score.set(id, (score.get(id) ?? 0) + 1)
      const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
      const ids = ranked.filter((id) => {
        if (linkedIds.includes(id)) return false
        const note = locateNote(id)?.summary
        if (!note || note.deleted_at || note.scope === "thread") return false
        return projectId ? note.project_id === projectId : note.scope === "global"
      })
      setSuggested(ids.slice(0, 3))
    })
    return () => {
      live = false
    }
  }, [task.title, linkedIds, projectId])

  // Sizes come from each note's body, read once.
  const shownNotes = useMemo(() => [...linkedIds, ...suggested], [linkedIds, suggested])
  useEffect(() => {
    let live = true
    for (const id of shownNotes) {
      if (sizes[id] !== undefined) continue
      const located = locateNote(id)
      if (!located) continue
      void noteClient(located.source)
        .call("notes.get", { id })
        .then(({ note }) => {
          if (live && note) setSizes((state) => ({ ...state, [id]: note.title.length + note.body.length }))
        })
        .catch(() => {})
    }
    return () => {
      live = false
    }
  }, [shownNotes, sizes])

  const contextNote = (id: NoteId): ContextNote => ({ id, title: titles.get(id) ?? "Note", chars: sizes[id] ?? null })
  const total = [...checked].reduce((sum, id) => sum + approxTokens(sizes[id] ?? 0), 0)

  // ---- workspace ----
  useEffect(() => {
    if (!project?.is_git || !projectId) return
    let live = true
    rpc()
      .call("git.branches", { project_id: projectId })
      .then((result) => live && setBranches(result))
      .catch(() => live && setBranches({ current: null, branches: [] }))
    return () => {
      live = false
    }
  }, [projectId, project?.is_git])

  const chooseProject = (id: ProjectId) => {
    setProjectId(id)
    setBranches(null)
    setPicked({})
  }
  const chooseAgent = (kind: ProviderKind) => {
    const status = providers.find((item) => item.kind === kind)
    const modes = status?.supported_permission_modes ?? []
    setConfig((current) => ({
      ...current,
      provider: { kind, instance: "default" },
      status,
      model: null,
      modelInfo: status?.models?.find((item) => item.is_default),
      effort: null,
      permissionMode: modes.length && !modes.includes(current.permissionMode) ? modes[0]! : current.permissionMode,
    }))
  }

  const isGit = project?.is_git ?? false
  const summaryParts = [modelLabel(config), projectId ? workspaceLabel(config, isGit, branches?.current) : "Choose a project"].filter(Boolean)
  const canStart = !!config.provider && !!projectId && !!prompt.trim() && !busy

  const start = async (open: boolean) => {
    if (!canStart || !config.provider || !projectId) return
    setBusy(open ? "open" : "start")
    setError(null)
    try {
      const result = await sendTask({
        id: task.id,
        provider: config.provider,
        model: config.model,
        effort: config.effort,
        permission_mode: config.permissionMode,
        use_worktree: isGit ? config.useWorktree : false,
        base_branch: isGit && config.useWorktree ? config.baseBranch : null,
        project_id: projectId,
        prompt: prompt.trim(),
        note_ids: [...checked],
      })
      writeSendPrefs(projectId, {
        provider: config.provider,
        model: config.model,
        effort: config.effort,
        permissionMode: config.permissionMode,
        useWorktree: config.useWorktree,
        baseBranch: config.baseBranch,
      })
      // The saved follow-up went out with this run.
      if (task.pending_followup?.trim() && prompt.includes(task.pending_followup.trim()) && result.task.pending_followup) {
        void updateTask(task.id, { pending_followup: "" })
      }
      closeSendSheet()
      if (open) openRunThread(result.thread_id)
      else toast(`${task.key} started`, { action: { label: "Open", onClick: () => openRunThread(result.thread_id) } })
    } catch (failure) {
      setError(`Unable to start the run. ${errorText(failure)}`)
      setBusy(null)
    }
  }

  // ---- focus and keys ----
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const sheetRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const field = promptRef.current
    if (!field) return
    field.focus({ preventScroll: true })
    field.setSelectionRange(field.value.length, field.value.length)
  }, [])
  useEffect(() => {
    const field = promptRef.current
    if (!field) return
    field.style.height = "auto"
    field.style.height = `${field.scrollHeight}px`
  }, [prompt])

  const onKeyDown = (event: React.KeyboardEvent) => {
    if ((event.target as HTMLElement).closest("[data-slot=menu-popup]")) return
    if (event.key === "Escape") {
      event.preventDefault()
      closeSendSheet()
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      void start(event.shiftKey)
    } else if (event.key === "Tab") {
      // Keep focus inside the sheet while it is open.
      const focusable = [...(sheetRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), textarea, [tabindex='0']") ?? [])]
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!first || !last) return
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
  }

  const statusModels = config.status?.models ?? []
  const efforts = config.modelInfo?.efforts ?? config.status?.supported_efforts ?? []
  const modes = config.status?.supported_permission_modes ?? []

  return (
    <div ref={sheetRef} className="contents" onKeyDown={onKeyDown}>
      <h1 id="tk-sheet-title">Send to agent</h1>
      <div className="subt">
        <span className="tk-num">{task.key}</span>&ensp;{task.title || "Untitled"}
      </div>
      <div className="tk-sheet-body">
        <button type="button" className="tk-summary" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>
          {config.provider && (
            <span className="mk">
              <AgentMark kind={config.provider.kind} size={15} />
            </span>
          )}
          <span>{agentLabel(config)}</span>
          {summaryParts.length > 0 && <span className="q">·&ensp;{summaryParts.join("  ·  ")}</span>}
          <ChevronDownIcon className="chev size-3.5" aria-hidden />
        </button>
        {expanded && (
          <div className="tk-config">
            {global && (
              <ConfigRow label="Project">
                <Choice
                  label="Project"
                  value={projectId ?? ""}
                  onValue={(value) => chooseProject(value as ProjectId)}
                  display={
                    project ? (
                      <>
                        <ProjectDot projectId={project.id} />
                        {project.name}
                      </>
                    ) : (
                      <span className="q">Choose a project</span>
                    )
                  }
                  options={Object.values(projects)
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map((item) => ({ value: item.id, label: item.name, icon: <ProjectDot projectId={item.id} /> }))}
                />
              </ConfigRow>
            )}
            <ConfigRow label="Agent">
              <Choice
                label="Agent"
                value={config.provider?.kind ?? ""}
                onValue={(value) => chooseAgent(value as ProviderKind)}
                display={
                  <>
                    {config.provider && <AgentMark kind={config.provider.kind} size={14} />}
                    {agentLabel(config)}
                  </>
                }
                options={providers.map((item) => ({ value: item.kind, label: PROVIDER_LABEL[item.kind], icon: <AgentMark kind={item.kind} size={14} /> }))}
              />
            </ConfigRow>
            <ConfigRow label="Model">
              <Choice
                label="Model"
                value={config.model ?? ""}
                disabled={statusModels.length === 0}
                onValue={(value) => {
                  const info = statusModels.find((item) => item.id === value)
                  setConfig((current) => ({ ...current, model: value || null, modelInfo: info ?? statusModels.find((item) => item.is_default), effort: null }))
                }}
                display={modelLabel(config) ?? "Agent default"}
                options={[{ value: "", label: "Agent default" }, ...statusModels.map((item) => ({ value: item.id, label: item.display_name }))]}
              />
            </ConfigRow>
            {efforts.length > 0 && (
              <ConfigRow label="Effort">
                <Choice
                  label="Effort"
                  value={config.effort ?? ""}
                  onValue={(value) => setConfig((current) => ({ ...current, effort: value || null }))}
                  display={config.effort ?? config.modelInfo?.default_effort ?? "Default"}
                  options={[{ value: "", label: "Default" }, ...efforts.map((effort) => ({ value: effort, label: effort }))]}
                />
              </ConfigRow>
            )}
            <ConfigRow label="Permissions">
              <Choice
                label="Permissions"
                value={config.permissionMode}
                onValue={(value) => setConfig((current) => ({ ...current, permissionMode: value as PermissionMode }))}
                display={PERMISSION_LABEL[config.permissionMode]}
                options={(modes.length ? modes : (Object.keys(PERMISSION_LABEL) as PermissionMode[])).map((mode) => ({ value: mode, label: PERMISSION_LABEL[mode] }))}
              />
            </ConfigRow>
            {projectId && (
              <ConfigRow label="Workspace">
                <Choice
                  label="Workspace"
                  value={config.useWorktree ? "worktree" : "local"}
                  disabled={!isGit}
                  onValue={(value) => setConfig((current) => ({ ...current, useWorktree: value === "worktree" }))}
                  display={isGit ? (config.useWorktree ? "New worktree" : "Local checkout") : "Project folder"}
                  options={[
                    { value: "worktree", label: "New worktree" },
                    { value: "local", label: "Local checkout" },
                  ]}
                />
              </ConfigRow>
            )}
            {projectId && isGit && config.useWorktree && (
              <ConfigRow label="From branch">
                <Choice
                  label="Branch"
                  value={config.baseBranch ?? ""}
                  onValue={(value) => setConfig((current) => ({ ...current, baseBranch: value || null }))}
                  display={config.baseBranch ?? branches?.current ?? "Current branch"}
                  options={[
                    { value: "", label: branches?.current ? `${branches.current} (current)` : "Current branch" },
                    ...(branches?.branches ?? []).filter((item) => item.name !== branches?.current).slice(0, 30).map((item) => ({ value: item.name, label: item.name })),
                  ]}
                />
              </ConfigRow>
            )}
          </div>
        )}

        {(linkedIds.length > 0 || suggested.length > 0) && (
          <>
            <div className="tk-slabel">
              Context
              <span className="r">{checked.size > 0 ? `About ${formatTokens(total)} tokens` : "None"}</span>
            </div>
            {linkedIds.map((id) => (
              <ContextRow key={id} note={contextNote(id)} checked={checked.has(id)} onToggle={(on) => setChecked((set) => toggle(set, id, on))} />
            ))}
            {suggested.length > 0 && (
              <>
                <div className="tk-sublabel">Suggested</div>
                {suggested.map((id) => (
                  <ContextRow key={id} note={contextNote(id)} suggested checked={checked.has(id)} onToggle={(on) => setChecked((set) => toggle(set, id, on))} />
                ))}
              </>
            )}
          </>
        )}

        <div className="tk-slabel">
          <label htmlFor="tk-sheet-prompt">Prompt</label>
          {edited && (
            <button type="button" className="r" onClick={() => setPrompt(initialPrompt)}>
              Reset
            </button>
          )}
        </div>
        <textarea id="tk-sheet-prompt" ref={promptRef} className="tk-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} spellCheck />
        {error && (
          <p className="tk-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="tk-sfoot">
        <span className="note">{projectId || !global ? "Runs in the background" : "Choose a project to start"}</span>
        <button type="button" className="tk-b" onClick={closeSendSheet}>
          Cancel
        </button>
        <button type="button" className="tk-b" data-variant="alt" disabled={!canStart} onClick={() => void start(true)} title={`Start and open (${mod}⇧↵)`}>
          Start and open
        </button>
        <button type="button" className="tk-b" data-variant="primary" disabled={!canStart} onClick={() => void start(false)} title={`Start (${mod}↵)`}>
          {busy === "start" ? "Starting…" : "Start"}
        </button>
      </div>
    </div>
  )
}

function toggle(set: Set<NoteId>, id: NoteId, on: boolean): Set<NoteId> {
  const next = new Set(set)
  if (on) next.add(id)
  else next.delete(id)
  return next
}

function ContextRow({ note, checked, suggested, onToggle }: { note: ContextNote; checked: boolean; suggested?: boolean; onToggle: (on: boolean) => void }) {
  return (
    <button type="button" role="checkbox" aria-checked={checked} className="tk-crow" data-suggested={suggested || undefined} onClick={() => onToggle(!checked)}>
      <span className="box" aria-hidden>
        {checked && (
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path d="M2.2 5.2 4.1 7.1 7.9 3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
      <span className="n">{note.title}</span>
      <span className="sz">{note.chars === null ? "" : formatTokens(approxTokens(note.chars))}</span>
    </button>
  )
}

function ConfigRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <span className="k">{label}</span>
      <span className="flex min-w-0 items-center">{children}</span>
    </>
  )
}

function Choice({
  label,
  value,
  onValue,
  display,
  options,
  disabled,
}: {
  label: string
  value: string
  onValue: (value: string) => void
  display: ReactNode
  options: { value: string; label: string; icon?: ReactNode }[]
  disabled?: boolean
}) {
  if (disabled) {
    return (
      <button type="button" className="v" disabled>
        {display}
      </button>
    )
  }
  return (
    <Menu>
      <MenuTrigger render={<button type="button" className="v" aria-label={label} />}>
        {display}
        <ChevronDownIcon className="size-3 text-[var(--task-fg3)]" aria-hidden />
      </MenuTrigger>
      <ComposerPickerMenuPopup align="start" side="bottom" className="min-w-48">
        <MenuGroup>
          <MenuGroupLabel>{label}</MenuGroupLabel>
          <MenuRadioGroup value={value} onValueChange={(next) => onValue(next as string)}>
            {options.map((option) => (
              <MenuRadioItem closeOnClick key={option.value || "default"} value={option.value}>
                {option.icon}
                <span className="min-w-0 truncate">{option.label}</span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </ComposerPickerMenuPopup>
    </Menu>
  )
}
