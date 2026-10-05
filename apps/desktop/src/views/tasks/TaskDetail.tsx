// A task's page: the title, its description (the notes editor), acceptance criteria,
// linked notes, and the activity with live runs; a follow-up box at the foot; status,
// priority, project, the default agent and workspace in the properties column.
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { toast } from "sonner"

import { ComposerPickerMenuPopup } from "@/components/kit/chat/ComposerPickerMenuPopup"
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from "@/components/kit/menu"
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/kit/popover"
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/kit/tooltip"
import { copyText, useNow } from "@/lib/hooks"
import { mod, PROVIDER_LABEL, relativeTime } from "@/lib/format"
import { ArrowUpIcon, ChevronDownIcon, ChevronUpIcon, EllipsisIcon, NoteIcon, PlusIcon, WorktreeIcon, XIcon } from "@/lib/kit/icons"
import type { NoteId, ProviderKind, TaskItem, TaskItemId } from "@/protocol"
import { openNote, useAllNotes } from "@/state/notes"
import { isEmptyThreadNote, noteTitle } from "@/state/notesModel"
import {
  deleteTask,
  fetchTask,
  followupTask,
  isConflict,
  openRunThread,
  openSendSheet,
  openTask,
  saveTaskContent,
  setTaskNotes,
  updateTask,
  useTasks,
  writeSendPrefs,
} from "@/state/tasks"
import {
  composeTaskBody,
  isLiveRun,
  latestRun,
  plainInline,
  PRIORITY_LABEL,
  runOutcome,
  splitTaskBody,
  STATUS_LABEL,
  taskActivity,
  runChanges,
  type Criterion,
} from "@/state/tasksModel"
import { errorText } from "@/state/rpc"
import { useStore } from "@/state/store"
import { selectAvailableProviders } from "@/state/store"
import { useShallow } from "zustand/react/shallow"
import { SurfaceHeader } from "../chrome"
import { ProjectDot } from "@/lib/kit/projectDot"
import { AgentMark, PriorityGlyph, TaskStatusGlyph } from "./TaskGlyphs"
import { TaskPriorityMenu, TaskProjectMenu, TaskStatusMenu } from "./TaskMenus"
import { agentLabel, modelLabel, useSendDefaults } from "./sendDefaults"

// The editor (Tiptap) is the notes chunk; it loads with the first task page.
const NoteBody = lazy(() => import("@/views/notes/NoteBody"))

const SAVE_DELAY_MS = 700

export function TaskDetail({ task, siblings }: { task: TaskItem; siblings: TaskItemId[] }) {
  const index = siblings.indexOf(task.id)
  const previous = index > 0 ? siblings[index - 1] : undefined
  const next = index >= 0 && index < siblings.length - 1 ? siblings[index + 1] : undefined
  const run = latestRun(task)

  return (
    <>
      <SurfaceHeader
        trailing={
          <>
            {task.status !== "running" && (
              <Tooltip>
                <TooltipTrigger render={<button type="button" className="tk-btn" onClick={() => openSendSheet(task.id)} />}>Send to agent</TooltipTrigger>
                <TooltipPopup side="bottom">{mod}↵</TooltipPopup>
              </Tooltip>
            )}
            <span className="flex items-center">
              <IconButton label="Previous task (K)" disabled={!previous} onClick={() => previous && openTask(previous)}>
                <ChevronUpIcon className="size-4" />
              </IconButton>
              <IconButton label="Next task (J)" disabled={!next} onClick={() => next && openTask(next)}>
                <ChevronDownIcon className="size-4" />
              </IconButton>
            </span>
            <MoreMenu task={task} after={next ?? previous} />
          </>
        }
      >
        <nav aria-label="Breadcrumb" className="tk-crumb font-system-ui">
          <button type="button" onClick={() => useStore.getState().selectTasks()}>
            Tasks
          </button>
          <span aria-hidden style={{ color: "var(--task-fg4)" }}>
            /
          </span>
          <b className="tk-num">{task.key}</b>
        </nav>
      </SurfaceHeader>
      <div className="tk-detail">
        <div className="tk-dmain">
          <div className="tk-dscroll">
            <div className="tk-dcol">
              <TaskContent
                key={task.id}
                task={task}
                meta={
                  <div className="tk-props-inline">
                    <Properties task={task} compact />
                  </div>
                }
              />
              <LinkedNotes task={task} />
              <Activity task={task} />
            </div>
          </div>
          <FollowUp task={task} run={run} />
        </div>
        <aside className="tk-dside" aria-label="Properties">
          <Properties task={task} />
        </aside>
      </div>
    </>
  )
}

function IconButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<button type="button" className="tk-btn" aria-label={label} disabled={disabled} onClick={onClick} />}>{children}</TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  )
}

function MoreMenu({ task, after }: { task: TaskItem; after?: TaskItemId }) {
  const run = latestRun(task)
  return (
    <Menu>
      <MenuTrigger render={<button type="button" className="tk-btn" aria-label="More" />}>
        <EllipsisIcon className="size-4" />
      </MenuTrigger>
      <ComposerPickerMenuPopup align="end" side="bottom" className="min-w-48">
        <MenuGroup>
          {run && <MenuItem onClick={() => openRunThread(run.thread_id)}>Open run {run.number}</MenuItem>}
          <MenuItem onClick={() => void copyText(task.key).then(() => toast(`Copied ${task.key}`))}>Copy key</MenuItem>
          <MenuItem onClick={() => void copyText(`[${task.key}](kybern://task/${task.id})`).then(() => toast("Copied link"))}>Copy link</MenuItem>
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <MenuItem
            variant="destructive"
            onClick={() => {
              void deleteTask(task.id)
              useStore.getState().selectTasks(after)
            }}
          >
            Delete task
          </MenuItem>
        </MenuGroup>
      </ComposerPickerMenuPopup>
    </Menu>
  )
}

// ---- title, description and criteria ----

/** Saves title and body edits in order, each against the revision the last one produced. */
function useContentSaver(task: TaskItem, onReloaded: (latest: TaskItem) => void) {
  const revision = useRef(task.revision)
  const chain = useRef<Promise<void>>(Promise.resolve())
  const pending = useRef(0)
  const reloaded = useRef(onReloaded)
  useEffect(() => {
    reloaded.current = onReloaded
  })
  useEffect(() => {
    if (pending.current === 0 && task.revision > revision.current) revision.current = task.revision
  }, [task.revision])
  const save = useCallback(
    (content: { title?: string; body?: string }) => {
      pending.current++
      chain.current = chain.current.then(async () => {
        try {
          const saved = await saveTaskContent(task.id, revision.current, content)
          revision.current = saved.revision
        } catch (error) {
          if (isConflict(error)) {
            const latest = await fetchTask(task.id).catch(() => null)
            if (latest) {
              revision.current = latest.revision
              reloaded.current(latest)
              toast(`${latest.key} changed elsewhere`, { description: "Showing the latest version. Make your edit again." })
            }
          } else {
            toast.error("Unable to save the task", { description: errorText(error) })
          }
        } finally {
          pending.current--
        }
      })
      return chain.current
    },
    [task.id],
  )
  return { save, pending }
}

function TaskContent({ task, meta }: { task: TaskItem; meta: ReactNode }) {
  const parts = useMemo(() => splitTaskBody(task.body), [task.body])
  const [epoch, setEpoch] = useState(0)
  const [description, setDescription] = useState(parts.description)
  const [criteria, setCriteria] = useState<Criterion[]>(parts.criteria)
  const [title, setTitle] = useState(task.title)
  const titleFocused = useRef(false)
  const dirty = useRef(false)
  const read = useRef<(() => string) | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const criteriaRef = useRef(criteria)
  useEffect(() => {
    criteriaRef.current = criteria
  })
  const lastBody = useRef(task.body)

  const adopt = useCallback((latest: TaskItem) => {
    const next = splitTaskBody(latest.body)
    lastBody.current = latest.body
    dirty.current = false
    setDescription(next.description)
    setCriteria(next.criteria)
    setTitle(latest.title)
    setEpoch((value) => value + 1)
  }, [])
  const { save, pending } = useContentSaver(task, adopt)

  // Someone else changed the task: show their version where nothing is being edited.
  const descriptionRef = useRef(description)
  useEffect(() => {
    descriptionRef.current = description
  })
  const id = task.id
  useEffect(
    () =>
      useTasks.subscribe((state, previous) => {
        const latest = state.tasks[id]
        const before = previous.tasks[id]
        if (!latest || latest === before) return
        if (!titleFocused.current && latest.title !== before?.title) setTitle(latest.title)
        if (latest.body === lastBody.current || pending.current > 0 || dirty.current) return
        lastBody.current = latest.body
        const next = splitTaskBody(latest.body)
        setCriteria(next.criteria)
        if (next.description !== descriptionRef.current) {
          setDescription(next.description)
          setEpoch((value) => value + 1)
        }
      }),
    [id, pending],
  )

  const saveBody = useCallback(
    (nextCriteria: Criterion[] = criteriaRef.current) => {
      clearTimeout(timer.current)
      const text = read.current?.() ?? description
      const body = composeTaskBody(text, nextCriteria)
      dirty.current = false
      if (body === lastBody.current) return
      lastBody.current = body
      void save({ body })
    },
    [description, save],
  )

  const host = useMemo(
    () => ({
      bodyEdited() {
        dirty.current = true
        clearTimeout(timer.current)
        timer.current = setTimeout(() => saveBody(), SAVE_DELAY_MS)
      },
      flush() {
        if (dirty.current) saveBody()
      },
      bindBody(reader: (() => string) | null) {
        read.current = reader
      },
    }),
    [saveBody],
  )
  useEffect(() => () => clearTimeout(timer.current), [])

  const snapshot = useMemo(() => ({ content: { body: description }, epoch, deleted: false }), [description, epoch])
  const onEditor = useCallback(() => {}, [])

  // A new task opens with its title ready for typing.
  const titleRef = useRef<HTMLTextAreaElement>(null)
  const titleFocus = useTasks((s) => s.titleFocus)
  useEffect(() => {
    if (titleFocus !== task.id) return
    titleRef.current?.focus()
    useTasks.setState({ titleFocus: null })
  }, [titleFocus, task.id])
  useLayoutEffect(() => {
    const field = titleRef.current
    if (!field) return
    field.style.height = "0px"
    field.style.height = `${field.scrollHeight}px`
  }, [title])

  const commitTitle = () => {
    titleFocused.current = false
    const text = title.replace(/\s+/g, " ").trim()
    if (text === task.title) return
    void save({ title: text })
  }

  const changeCriteria = (next: Criterion[], persist: boolean) => {
    setCriteria(next)
    if (persist) saveBody(next)
  }

  return (
    <>
      <textarea
        ref={titleRef}
        className="tk-dtitle"
        rows={1}
        value={title}
        placeholder="Task title"
        aria-label="Title"
        onFocus={() => (titleFocused.current = true)}
        onChange={(event) => setTitle(event.target.value.replace(/\n/g, ""))}
        onBlur={commitTitle}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault()
            commitTitle()
            ;(event.currentTarget.closest(".tk-dcol")?.querySelector(".ProseMirror") as HTMLElement | null)?.focus()
          } else if (event.key === "Escape") {
            event.preventDefault()
            setTitle(task.title)
            event.currentTarget.blur()
          }
        }}
      />
      {meta}
      <div className="tk-desc">
        <Suspense fallback={<div className="tk-desc-static">{description}</div>}>
          <NoteBody host={host} snapshot={snapshot} variant="compact" onEditor={onEditor} placeholder="Add a description…" />
        </Suspense>
      </div>
      <Criteria criteria={criteria} onChange={changeCriteria} />
    </>
  )
}

function Criteria({ criteria, onChange }: { criteria: Criterion[]; onChange: (next: Criterion[], persist: boolean) => void }) {
  const list = useRef<HTMLDivElement>(null)
  // The row to focus once the list has re-rendered (after Return, Backspace or Add).
  const focusIndex = useRef<number | null>(null)
  const setFocusIndex = (index: number) => {
    focusIndex.current = index
  }
  useLayoutEffect(() => {
    if (focusIndex.current === null) return
    const field = list.current?.querySelectorAll<HTMLTextAreaElement>("textarea")[focusIndex.current]
    focusIndex.current = null
    field?.focus()
    field?.setSelectionRange(field.value.length, field.value.length)
  })
  const done = criteria.filter((criterion) => criterion.checked).length
  const update = (index: number, patch: Partial<Criterion>, persist: boolean) => onChange(criteria.map((criterion, at) => (at === index ? { ...criterion, ...patch } : criterion)), persist)

  return (
    <section aria-labelledby="tk-criteria">
      <h2 className="tk-h" id="tk-criteria">
        Acceptance criteria
        {criteria.length > 0 && (
          <span className="count">
            {done} of {criteria.length}
          </span>
        )}
      </h2>
      <div ref={list}>
        {criteria.map((criterion, index) => (
          <div key={index} className="tk-ci" data-done={criterion.checked || undefined}>
            <button type="button" role="checkbox" aria-checked={criterion.checked} aria-label={plainInline(criterion.text) || "Criterion"} className="box" onClick={() => update(index, { checked: !criterion.checked }, true)}>
              {criterion.checked && (
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                  <path d="M2.2 5.2 4.1 7.1 7.9 3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
            <AutoText
              className="txt"
              value={criterion.text}
              placeholder="Describe what done looks like"
              onChange={(text) => update(index, { text }, false)}
              onBlur={() => onChange(criteria.filter((item) => item.text.trim() || item.extra?.length), true)}
              onEnter={() => {
                const next = [...criteria]
                next.splice(index + 1, 0, { checked: false, text: "" })
                onChange(next, false)
                setFocusIndex(index + 1)
              }}
              onBackspaceEmpty={() => {
                onChange(
                  criteria.filter((_, at) => at !== index),
                  true,
                )
                setFocusIndex(Math.max(0, index - 1))
              }}
            />
          </div>
        ))}
      </div>
      <button
        type="button"
        className="tk-add"
        onClick={() => {
          onChange([...criteria, { checked: false, text: "" }], false)
          setFocusIndex(criteria.length)
        }}
      >
        <PlusIcon className="size-4" aria-hidden />
        Add a criterion
      </button>
    </section>
  )
}

function AutoText({
  value,
  className,
  placeholder,
  onChange,
  onBlur,
  onEnter,
  onBackspaceEmpty,
}: {
  value: string
  className?: string
  placeholder?: string
  onChange: (value: string) => void
  onBlur: () => void
  onEnter: () => void
  onBackspaceEmpty: () => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const field = ref.current
    if (!field) return
    field.style.height = "0px"
    field.style.height = `${field.scrollHeight}px`
  }, [value])
  return (
    <textarea
      ref={ref}
      rows={1}
      className={className}
      value={value}
      placeholder={placeholder}
      aria-label="Criterion"
      onChange={(event) => onChange(event.target.value.replace(/\n/g, " "))}
      onBlur={onBlur}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return
        if (event.key === "Enter") {
          event.preventDefault()
          onEnter()
        } else if (event.key === "Backspace" && !value) {
          event.preventDefault()
          onBackspaceEmpty()
        }
      }}
    />
  )
}

// ---- linked notes ----

function LinkedNotes({ task }: { task: TaskItem }) {
  const notes = useAllNotes()
  const byId = useMemo(() => new Map(notes.map((note) => [note.id, note])), [notes])
  const linked = task.note_ids
  return (
    <section aria-labelledby="tk-linked">
      <h2 className="tk-h" id="tk-linked">
        Linked notes
      </h2>
      {linked.map((id) => {
        const note = byId.get(id)
        const checklist = note?.checklist
        return (
          <div
            key={id}
            role="link"
            tabIndex={0}
            className="tk-lnote"
            onClick={() => note && openNote(id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && note) openNote(id)
            }}
          >
            <span className="g">
              <NoteIcon className="size-4" aria-hidden />
            </span>
            <span className="n">{note ? noteTitle(note) : "A note that is no longer here"}</span>
            {checklist && checklist.total > 0 && (
              <span className="m">
                {checklist.done}/{checklist.total}
              </span>
            )}
            <button
              type="button"
              className="tk-btn rm"
              aria-label="Unlink note"
              style={{ height: 24, minWidth: 24 }}
              onClick={(event) => {
                event.stopPropagation()
                void setTaskNotes(
                  task.id,
                  linked.filter((other) => other !== id),
                )
              }}
            >
              <XIcon className="size-3.5" />
            </button>
          </div>
        )
      })}
      <NotePicker exclude={linked} onPick={(id) => void setTaskNotes(task.id, [...linked, id])} />
    </section>
  )
}

function NotePicker({ exclude, onPick }: { exclude: NoteId[]; onPick: (id: NoteId) => void }) {
  const notes = useAllNotes()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)
  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    return notes
      .filter((note) => !note.deleted_at && !isEmptyThreadNote(note) && !exclude.includes(note.id))
      .filter((note) => !q || noteTitle(note).toLowerCase().includes(q) || note.preview.toLowerCase().includes(q))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, 30)
  }, [notes, query, exclude])
  const pick = (id: NoteId) => {
    onPick(id)
    setOpen(false)
    setQuery("")
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<button type="button" className="tk-add" />}>
        <PlusIcon className="size-4" aria-hidden />
        Link a note
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="start">
        <div className="tk-picker">
          <input
            autoFocus
            value={query}
            placeholder="Find a note"
            aria-label="Find a note"
            onChange={(event) => {
              setQuery(event.target.value)
              setActive(0)
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault()
                setActive((index) => Math.min(results.length - 1, index + 1))
              } else if (event.key === "ArrowUp") {
                event.preventDefault()
                setActive((index) => Math.max(0, index - 1))
              } else if (event.key === "Enter" && results[active]) {
                event.preventDefault()
                pick(results[active].id)
              }
            }}
          />
          <div className="tk-picker-list" role="listbox" aria-label="Notes">
            {results.length === 0 ? (
              <p className="tk-picker-empty">{query.trim() ? `No notes match “${query.trim()}”.` : "No other notes yet."}</p>
            ) : (
              results.map((note, index) => (
                <button
                  key={note.id}
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  className="tk-picker-row"
                  data-active={index === active || undefined}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => pick(note.id)}
                >
                  <NoteIcon className="size-3.5 shrink-0 text-[var(--task-fg3)]" aria-hidden />
                  <span className="n">{noteTitle(note)}</span>
                  <span className="s">{relativeTime(note.updated_at)}</span>
                </button>
              ))
            )}
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  )
}

// ---- activity ----

function Activity({ task }: { task: TaskItem }) {
  const notes = useAllNotes()
  const now = useNow(30_000)
  const events = useMemo(() => taskActivity(task), [task])
  const latest = latestRun(task)
  const timeline = useRef<HTMLDivElement>(null)
  const [line, setLine] = useState(0)
  useLayoutEffect(() => {
    const root = timeline.current
    if (!root) return
    const measure = () => {
      const glyphs = root.querySelectorAll<HTMLElement>(".tk-ev .gi")
      const first = glyphs[0]
      const last = glyphs[glyphs.length - 1]
      setLine(first && last ? last.offsetTop - first.offsetTop : 0)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(root)
    return () => observer.disconnect()
  }, [events.length])
  const sourceTitle = (id: NoteId | null | undefined) => {
    const note = id ? notes.find((entry) => entry.id === id) : undefined
    return note ? noteTitle(note) : null
  }

  return (
    <section aria-labelledby="tk-activity">
      <h2 className="tk-h" id="tk-activity">
        Activity
      </h2>
      <div ref={timeline} className="tk-tl" style={{ "--tk-tl-h": `${line}px` } as React.CSSProperties}>
        {events.map((event) => {
          if (event.kind === "created") {
            const source = sourceTitle(event.noteId)
            return (
              <Event key="created" glyph={source ? <NoteIcon className="size-3.5" /> : <PlusIcon className="size-3.5" />} at={event.at} now={now}>
                {source ? (
                  <>
                    Created from <b>{source}</b>
                  </>
                ) : (
                  "Created"
                )}
              </Event>
            )
          }
          if (event.kind === "status") {
            return (
              <Event key="status" glyph={<TaskStatusGlyph status={event.status} size={12} />} at={event.at} now={now}>
                Moved to <b>{STATUS_LABEL[event.status]}</b>
              </Event>
            )
          }
          const run = event.run
          const isLatest = latest?.number === run.number
          return (
            <div key={`run-${run.number}`}>
              <Event glyph={<AgentMark kind={run.provider.kind} size={13} />} glyphTone={isLatest ? "var(--task-fg2)" : undefined} at={event.at} now={now}>
                <b>Run {run.number}</b> · {PROVIDER_LABEL[run.provider.kind]} · {runOutcome(run, now)}
              </Event>
              {isLatest && (isLiveRun(run) || task.status === "needs_review") && (
                <div className="tk-runbox">
                  <TaskStatusGlyph status={task.status === "needs_review" ? "needs_review" : "running"} size={12} animated />
                  <span className="x">
                    {isLiveRun(run)
                      ? run.state === "waiting"
                        ? "Waiting for your answer in the run"
                        : run.activity || "Working"
                      : runChanges(run)
                        ? changesText(runChanges(run)!)
                        : runOutcome(run, now)}
                  </span>
                  <button type="button" className="tk-tbtn" onClick={() => openRunThread(run.thread_id)}>
                    Open run
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

function changesText(diff: { added: number; removed: number; files: number }): string {
  return `+${diff.added} −${diff.removed} in ${diff.files} ${diff.files === 1 ? "file" : "files"}`
}

function Event({ glyph, glyphTone, at, now, children }: { glyph: ReactNode; glyphTone?: string; at: string; now: number; children: ReactNode }) {
  const ago = relativeTime(at, now)
  return (
    <div className="tk-ev">
      <span className="gi" style={glyphTone ? { color: glyphTone } : undefined}>
        {glyph}
      </span>
      <div className="bd">{children}</div>
      <span className="tm">{ago === "now" ? "just now" : /^\d/.test(ago) ? `${ago} ago` : ago}</span>
    </div>
  )
}

// ---- follow-up ----

function FollowUp({ task, run }: { task: TaskItem; run: ReturnType<typeof latestRun> }) {
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)
  const field = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const element = field.current
    if (!element) return
    element.style.height = "0px"
    element.style.height = `${Math.min(160, element.scrollHeight)}px`
  }, [text])
  const placeholder = !run ? "Add context for the next run…" : isLiveRun(run) ? `Queue a follow-up for Run ${run.number}…` : `Send a follow-up to Run ${run.number}…`
  const submit = async () => {
    const message = text.trim()
    if (!message || busy) return
    setBusy(true)
    const result = await followupTask(task.id, message)
    setBusy(false)
    if (!result) return
    setText("")
    if (result.sent_to) toast(run && isLiveRun(run) ? `Queued for Run ${run.number}` : `Sent to Run ${run?.number ?? ""}`.trim(), { action: { label: "Open", onClick: () => openRunThread(result.sent_to!) } })
    else toast("Saved for the next run")
  }
  return (
    <div className="tk-follow">
      {task.pending_followup?.trim() && (
        <div className="tk-pending">
          <span>Next run includes: {task.pending_followup.trim()}</span>
          <button type="button" className="tk-tbtn" onClick={() => void updateTask(task.id, { pending_followup: "" })}>
            Clear
          </button>
        </div>
      )}
      <div className="tk-fbox">
        <textarea
          ref={field}
          rows={1}
          value={text}
          placeholder={placeholder}
          aria-label={placeholder.replace("…", "")}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void submit()
            } else if (event.key === "Escape") {
              event.currentTarget.blur()
            }
          }}
        />
        <button type="button" className="tk-send-round" aria-label="Send follow-up" data-ready={text.trim() ? true : undefined} disabled={!text.trim() || busy} onClick={() => void submit()}>
          <ArrowUpIcon className="size-4" />
        </button>
      </div>
    </div>
  )
}

// ---- properties ----

function Properties({ task, compact }: { task: TaskItem; compact?: boolean }) {
  const projects = useStore((s) => s.projects)
  const threads = useStore((s) => s.threads)
  const providers = useStore(useShallow(selectAvailableProviders))
  const projectId = task.scope === "project" ? task.project_id ?? null : null
  const project = projectId ? projects[projectId] : undefined
  const [version, setVersion] = useState(0)
  const config = useSendDefaults(projectId, version)
  const run = latestRun(task)
  const branch = run ? threads[run.thread_id]?.worktree?.branch : undefined

  const status = (
    <TaskStatusMenu
      task={task}
      trigger={
        <button type="button" className="v" aria-label={`Status: ${STATUS_LABEL[task.status]}`} data-task-status-trigger={task.id}>
          <TaskStatusGlyph status={task.status} animated />
          <span className="lbl">{STATUS_LABEL[task.status]}</span>
        </button>
      }
    />
  )
  const priority = (
    <TaskPriorityMenu
      task={task}
      trigger={
        <button type="button" className="v" aria-label={`Priority: ${PRIORITY_LABEL[task.priority]}`}>
          <span className="mk">
            <PriorityGlyph priority={task.priority} />
          </span>
          <span className="lbl">{task.priority === 0 ? "No priority" : PRIORITY_LABEL[task.priority]}</span>
        </button>
      }
    />
  )
  const projectMenu = (
    <TaskProjectMenu
      task={task}
      trigger={
        <button type="button" className="v" aria-label={`Project: ${project?.name ?? "Global"}`}>
          <ProjectDot projectId={projectId} />
          <span className="lbl">{project?.name ?? "Global"}</span>
        </button>
      }
    />
  )
  if (compact) {
    return (
      <>
        <div className="tk-prop">{status}</div>
        <div className="tk-prop">{priority}</div>
        <div className="tk-prop">{projectMenu}</div>
      </>
    )
  }

  const chooseAgent = (kind: ProviderKind) => {
    writeSendPrefs(projectId, { provider: { kind, instance: "default" }, model: null, effort: null })
    setVersion((value) => value + 1)
  }
  const chooseWorkspace = (worktree: boolean) => {
    writeSendPrefs(projectId, { useWorktree: worktree })
    setVersion((value) => value + 1)
  }
  const model = modelLabel(config)
  return (
    <>
      <Prop label="Status">{status}</Prop>
      <Prop label="Priority">{priority}</Prop>
      <Prop label="Project">{projectMenu}</Prop>
      <div className="tk-side-sep" />
      <Prop label="Agent">
        <Menu>
          <MenuTrigger render={<button type="button" className="v" aria-label={`Agent for runs: ${agentLabel(config)}`} />}>
            {config.provider && (
              <span className="mk">
                <AgentMark kind={config.provider.kind} size={14} />
              </span>
            )}
            <span className="lbl">{agentLabel(config)}</span>
            {model && <span className="q">{model}</span>}
          </MenuTrigger>
          <ComposerPickerMenuPopup align="start" side="bottom" className="min-w-48">
            <MenuGroup>
              <MenuGroupLabel>Agent for runs</MenuGroupLabel>
              <MenuRadioGroup value={config.provider?.kind ?? ""} onValueChange={(value) => chooseAgent(value as ProviderKind)}>
                {providers.map((item) => (
                  <MenuRadioItem closeOnClick key={item.kind} value={item.kind}>
                    <AgentMark kind={item.kind} size={14} />
                    {PROVIDER_LABEL[item.kind]}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
          </ComposerPickerMenuPopup>
        </Menu>
      </Prop>
      <Prop label="Workspace">
        {project?.is_git ? (
          <Menu>
            <MenuTrigger render={<button type="button" className="v" aria-label="Workspace for runs" />}>
              <span className="mk">
                <WorktreeIcon className="size-3.5" />
              </span>
              <span className="lbl">{config.useWorktree ? "New worktree" : "Local checkout"}</span>
            </MenuTrigger>
            <ComposerPickerMenuPopup align="start" side="bottom" className="min-w-48">
              <MenuGroup>
                <MenuGroupLabel>Workspace for runs</MenuGroupLabel>
                <MenuRadioGroup value={config.useWorktree ? "worktree" : "local"} onValueChange={(value) => chooseWorkspace(value === "worktree")}>
                  <MenuRadioItem closeOnClick value="worktree">New worktree</MenuRadioItem>
                  <MenuRadioItem closeOnClick value="local">Local checkout</MenuRadioItem>
                </MenuRadioGroup>
              </MenuGroup>
            </ComposerPickerMenuPopup>
          </Menu>
        ) : (
          <span className="v" style={{ cursor: "default" }}>
            <span className="mk">
              <WorktreeIcon className="size-3.5" />
            </span>
            <span className="lbl">{project ? "Project folder" : "Chosen when sent"}</span>
          </span>
        )}
      </Prop>
      {branch && <div className="tk-prop-sub">{branch}</div>}
    </>
  )
}

function Prop({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="tk-prop">
      <span className="k">{label}</span>
      {children}
    </div>
  )
}
