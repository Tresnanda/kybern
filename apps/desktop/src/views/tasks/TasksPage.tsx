// The Tasks page: the list or board for the panel's current view, or one task's page.
// Keyboard: C new task, ↑↓ (J K) move, ↵ open, S status, P priority, ⌘↵ send to
// agent, ⌘⌫ delete (with Undo). A quiet hint line says so until it is hidden.
import { useEffect, useMemo } from "react"

import { ComposerPickerMenuPopup } from "@/components/kit/chat/ComposerPickerMenuPopup"
import { Menu, MenuCheckboxItem, MenuGroup, MenuGroupLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from "@/components/kit/menu"
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/kit/tooltip"
import { useNow } from "@/lib/hooks"
import { mod } from "@/lib/format"
import { CustomizeIcon, KanbanIcon, ListBulletIcon } from "@/lib/kit/icons"
import type { TaskItem, TaskItemId } from "@/protocol"
import {
  closeTaskMenu,
  deleteTask,
  openSendSheet,
  openTask,
  openTaskMenu,
  refreshTasks,
  setFocusedTask,
  setTaskPrefs,
  useTasks,
} from "@/state/tasks"
import {
  boardColumns,
  filterLabel,
  groupTasks,
  isGroupCollapsed,
  matchesFilter,
  searchTasks,
  type TaskGrouping,
  type TaskOrdering,
} from "@/state/tasksModel"
import { orderProjects } from "@/state/sidebarOrganize"
import { useStore } from "@/state/store"
import { SurfaceHeader } from "../chrome"
import { SendSheet } from "./SendSheet"
import { TaskBoard } from "./TaskBoard"
import { TaskDetail } from "./TaskDetail"
import { TaskList } from "./TaskList"
import { TaskPriorityMenu, TaskStatusMenu } from "./TaskMenus"
import { newTaskHere } from "./taskActions"

export function TasksView() {
  const taskId = useStore((s) => (s.selected.kind === "tasks" ? s.selected.taskId : undefined))
  const tasks = useTasks((s) => s.tasks)
  const loaded = useTasks((s) => s.loaded)
  const supported = useTasks((s) => s.supported)
  const error = useTasks((s) => s.error)
  const prefs = useTasks((s) => s.prefs)
  const query = useTasks((s) => s.query)
  const quickAdd = useTasks((s) => s.quickAdd)
  const projects = useStore((s) => s.projects)
  const projectOrder = useStore((s) => s.projectOrder)
  const now = useNow(30_000)

  const all = useMemo(() => Object.values(tasks), [tasks])
  const visible = useMemo(() => {
    const filtered = all.filter((task) => matchesFilter(task, prefs.filter, now))
    return query.trim() ? searchTasks(filtered, query) : filtered
  }, [all, prefs.filter, query, now])
  const ordered = useMemo(() => orderProjects(Object.values(projects), projectOrder), [projects, projectOrder])
  // A search shows its matches even among finished work.
  const groupOptions = useMemo(
    () => ({ grouping: prefs.grouping, ordering: prefs.ordering, showDone: prefs.showDone || !!query.trim() || prefs.filter === "done", showCanceled: prefs.showCanceled || !!query.trim() }),
    [prefs.grouping, prefs.ordering, prefs.showDone, prefs.showCanceled, prefs.filter, query],
  )
  const groups = useMemo(() => groupTasks(visible, groupOptions, ordered), [visible, groupOptions, ordered])
  const columns = useMemo(() => boardColumns(visible, groupOptions), [visible, groupOptions])
  const board = prefs.view === "board"

  // The order ↑↓ walks, and the task page's previous/next.
  const sequence = useMemo<TaskItemId[]>(() => {
    if (board) return columns.flatMap((column) => column.tasks.map((task) => task.id))
    return groups.filter((group) => !isGroupCollapsed(prefs, group)).flatMap((group) => group.tasks.map((task) => task.id))
  }, [board, columns, groups, prefs])

  const open = taskId ? tasks[taskId] : undefined
  useTaskKeys({ sequence, columns: board ? columns : null, openId: open?.id })

  let content
  if (!supported) {
    content = <Message title="Tasks need a newer version" detail="Update Kybern on this environment to use tasks." />
  } else if (!loaded) {
    content = error ? <Message title="Couldn’t load tasks" detail={error} action={{ label: "Try again", run: refreshTasks }} /> : null
  } else if (taskId) {
    content = open ? (
      <TaskDetail task={open} siblings={sequence.includes(open.id) ? sequence : [open.id]} />
    ) : (
      <Message title="This task is gone" detail="It may have been deleted on another device." action={{ label: "Show all tasks", run: () => useStore.getState().selectTasks() }} />
    )
  } else if (all.length === 0 && !quickAdd) {
    content = (
      <Message
        title="Plan the work, then hand it off"
        detail="Write down what needs doing. When a task is ready, send it to an agent and keep working."
        action={{ label: "New task", run: () => newTaskHere() }}
      />
    )
  } else if (board) {
    content = <TaskBoard columns={columns} tasks={tasks} now={now} />
  } else if (groups.length === 0 && !quickAdd) {
    content = query.trim() ? (
      <Message title={`No tasks match “${query.trim()}”`} detail="Try a key like ADE-14 or a word from the title." />
    ) : (
      <Message title={emptyTitle(prefs.filter)} detail="Tasks show up here as their status changes." />
    )
  } else {
    content = (
      <div className="tk-scroll">
        <TaskList groups={groups} tasks={tasks} now={now} />
      </div>
    )
  }

  const title = query.trim() ? "Search" : filterLabel(prefs.filter, (id) => projects[id]?.name)
  return (
    <div className="tk-page font-system-ui">
      {!taskId && (
        <SurfaceHeader trailing={<ListControls board={board} />}>
          <h1 className="tk-title">{title}</h1>
        </SurfaceHeader>
      )}
      {content}
      {!taskId && loaded && supported && prefs.showHints && all.length > 0 && <HintBar />}
      <KeyboardMenus />
      <SendSheet />
    </div>
  )
}

function emptyTitle(filter: string): string {
  if (filter === "running") return "No agents are running"
  if (filter === "needs_review") return "Nothing waiting for review"
  if (filter === "inbox") return "Inbox is empty"
  if (filter === "done") return "Nothing finished lately"
  return "No tasks here yet"
}

function Message({ title, detail, action }: { title: string; detail: string; action?: { label: string; run: () => void } }) {
  return (
    <div className="tk-empty">
      <h2>{title}</h2>
      <p>{detail}</p>
      {action && (
        <button type="button" className="tk-btn" onClick={action.run}>
          {action.label}
        </button>
      )}
    </div>
  )
}

function ListControls({ board }: { board: boolean }) {
  const prefs = useTasks((s) => s.prefs)
  return (
    <>
      <span className="tk-seg" role="group" aria-label="View">
        <Tooltip>
          <TooltipTrigger render={<button type="button" aria-label="List" aria-pressed={!board} onClick={() => setTaskPrefs({ view: "list" })} />}>
            <ListBulletIcon className="size-[15px]" />
          </TooltipTrigger>
          <TooltipPopup side="bottom">List</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<button type="button" aria-label="Board" aria-pressed={board} onClick={() => setTaskPrefs({ view: "board" })} />}>
            <KanbanIcon className="size-[15px]" />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Board</TooltipPopup>
        </Tooltip>
      </span>
      <Menu>
        <MenuTrigger render={<button type="button" className="tk-btn" style={{ padding: "0 8px" }} />}>
          <CustomizeIcon className="size-[15px]" aria-hidden />
          Display
        </MenuTrigger>
        <ComposerPickerMenuPopup align="end" side="bottom" className="min-w-52">
          {!board && (
            <>
              <MenuGroup>
                <MenuGroupLabel>Group by</MenuGroupLabel>
                <MenuRadioGroup value={prefs.grouping} onValueChange={(value) => setTaskPrefs({ grouping: value as TaskGrouping })}>
                  <MenuRadioItem value="status">Status</MenuRadioItem>
                  <MenuRadioItem value="project">Project</MenuRadioItem>
                  <MenuRadioItem value="priority">Priority</MenuRadioItem>
                </MenuRadioGroup>
              </MenuGroup>
              <MenuSeparator />
            </>
          )}
          <MenuGroup>
            <MenuGroupLabel>Order by</MenuGroupLabel>
            <MenuRadioGroup value={prefs.ordering} onValueChange={(value) => setTaskPrefs({ ordering: value as TaskOrdering })}>
              <MenuRadioItem value="manual">Manual</MenuRadioItem>
              <MenuRadioItem value="priority">Priority</MenuRadioItem>
              <MenuRadioItem value="updated">Last updated</MenuRadioItem>
            </MenuRadioGroup>
          </MenuGroup>
          <MenuSeparator />
          <MenuGroup>
            <MenuCheckboxItem checked={prefs.showDone} onCheckedChange={(checked) => setTaskPrefs({ showDone: checked })}>
              Show done
            </MenuCheckboxItem>
            <MenuCheckboxItem checked={prefs.showCanceled} onCheckedChange={(checked) => setTaskPrefs({ showCanceled: checked })}>
              Show canceled
            </MenuCheckboxItem>
            <MenuCheckboxItem checked={prefs.showHints} onCheckedChange={(checked) => setTaskPrefs({ showHints: checked })}>
              Show hints
            </MenuCheckboxItem>
          </MenuGroup>
        </ComposerPickerMenuPopup>
      </Menu>
    </>
  )
}

function HintBar() {
  return (
    <div className="tk-hints" aria-label="Keyboard shortcuts">
      <span>
        <b>↑↓</b>Move
      </span>
      <span>
        <b>↵</b>Open
      </span>
      <span>
        <b>S</b>Status
      </span>
      <span>
        <b>P</b>Priority
      </span>
      <span>
        <b>{mod}↵</b>Send to agent
      </span>
      <button type="button" className="hide" onClick={() => setTaskPrefs({ showHints: false })}>
        Hide hints
      </button>
    </div>
  )
}

/** The S and P menus, opened from the keyboard and anchored to the focused task. */
function KeyboardMenus() {
  const menu = useTasks((s) => s.menu)
  const task = useTasks((s) => (s.menu ? s.tasks[s.menu.taskId] : undefined))
  if (!menu || !task) return null
  const anchor =
    document.querySelector(`[data-task-row="${task.id}"] .st, [data-task-card="${task.id}"] .r1`) ??
    document.querySelector(`[data-task-status-trigger="${task.id}"]`) ??
    document.querySelector(".tk-dtitle")
  const props = { task, open: true, anchor, onOpenChange: (next: boolean) => !next && closeTaskMenu() }
  return menu.kind === "status" ? <TaskStatusMenu key={menu.nonce} {...props} /> : <TaskPriorityMenu key={menu.nonce} {...props} />
}

function editable(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  if (!element) return false
  return element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.isContentEditable || !!element.closest("[role=menu], [role=dialog], [role=listbox]")
}

function useTaskKeys({ sequence, columns, openId }: { sequence: TaskItemId[]; columns: { tasks: TaskItem[] }[] | null; openId: TaskItemId | undefined }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      const store = useStore.getState()
      if (store.settingsOpen || store.paletteOpen || store.selected.kind !== "tasks") return
      const tasks = useTasks.getState()
      if (tasks.sheet || tasks.menu) return
      const meta = event.metaKey || event.ctrlKey
      const typing = editable(event.target)
      const current = openId ?? tasks.focusedId ?? undefined

      // ⌘↵ and ⌘⌫ act on the focused (or open) task, even from the search field.
      if (meta && event.key === "Enter" && current && !(typing && openId)) {
        event.preventDefault()
        openSendSheet(current)
        return
      }
      if (meta && event.key === "Backspace" && current && !typing) {
        event.preventDefault()
        const at = sequence.indexOf(current)
        const after = sequence[at + 1] ?? sequence[at - 1]
        void deleteTask(current)
        if (openId) store.selectTasks(after)
        else if (after) focusTask(after)
        return
      }
      if (typing || meta || event.altKey) return

      const key = event.key.toLowerCase()
      if (key === "c" && !event.shiftKey) {
        event.preventDefault()
        newTaskHere()
        return
      }
      if (openId) {
        // On a task's page: J/K step through the list, Escape goes back to it.
        if (key === "j" || key === "k") {
          const at = sequence.indexOf(openId)
          const target = sequence[at + (key === "j" ? 1 : -1)]
          if (target) {
            event.preventDefault()
            openTask(target)
          }
        } else if (key === "escape") {
          event.preventDefault()
          store.selectTasks()
          setFocusedTask(openId)
          requestAnimationFrame(() => focusTask(openId))
        } else if (key === "s" || key === "p") {
          event.preventDefault()
          openTaskMenu(openId, key === "s" ? "status" : "priority")
        }
        return
      }
      const down = key === "arrowdown" || key === "j"
      const up = key === "arrowup" || key === "k"
      if (down || up) {
        event.preventDefault()
        if (!sequence.length) return
        const at = current ? sequence.indexOf(current) : -1
        const next = at < 0 ? sequence[down ? 0 : sequence.length - 1] : sequence[Math.max(0, Math.min(sequence.length - 1, at + (down ? 1 : -1)))]
        if (next) focusTask(next)
        return
      }
      if (columns && (key === "arrowleft" || key === "arrowright") && current) {
        event.preventDefault()
        const from = columns.findIndex((column) => column.tasks.some((task) => task.id === current))
        const row = from >= 0 ? columns[from]!.tasks.findIndex((task) => task.id === current) : 0
        for (let step = 1; step < columns.length; step++) {
          const target = columns[from + (key === "arrowright" ? step : -step)]
          if (!target) break
          if (target.tasks.length) {
            focusTask(target.tasks[Math.min(row, target.tasks.length - 1)]!.id)
            break
          }
        }
        return
      }
      if (!current) return
      if (key === "enter") {
        event.preventDefault()
        openTask(current)
      } else if (key === "s" || key === "p") {
        event.preventDefault()
        openTaskMenu(current, key === "s" ? "status" : "priority")
      } else if (key === "escape" && tasks.focusedId) {
        setFocusedTask(null)
        ;(document.activeElement as HTMLElement | null)?.blur()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [sequence, columns, openId])
}

function focusTask(id: TaskItemId) {
  setFocusedTask(id)
  requestAnimationFrame(() => {
    const element = document.querySelector<HTMLElement>(`[data-task-row="${id}"], [data-task-card="${id}"]`)
    element?.focus({ preventScroll: true })
    element?.scrollIntoView({ block: "nearest" })
  })
}
