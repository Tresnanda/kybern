import { SelectionBar } from './SelectionBar.tsx'
import { useEffect, useMemo } from 'react'
import {
  boardColumns,
  filterLabel,
  groupTasks,
  isGroupCollapsed,
  matchesFilter,
  searchTasks,
  type TaskGrouping,
  type TaskOrdering,
} from '@/state/tasksModel'
import { addWindowKeyHandler } from '../nav/keys.ts'
import { getNav, setNav } from '../nav/store.ts'
import { Menu, MenuItem, MenuSeparator } from '../nav/overlay.tsx'
import { useApp } from '../state.ts'
import { Button, Segmented, selectOwnsEscape } from '../settings/controls.tsx'
import { ink, Label, useTheme } from '../ui.tsx'
import { cancelTaskDrag, draggingTask, escapeTaskDrag } from './drag.tsx'
import { TaskList, TaskBoard } from './TaskList.tsx'
import { TaskDetail } from './TaskDetail.tsx'
import { TaskMenus } from './TaskMenus.tsx'
import { RunComposer } from './RunComposer.tsx'
import {
  deleteTasks,
  isTaskTyping,
  taskTyping,
  openTask,
  pick,
  prefs,
  quickAdd,
  refreshTasks,
  setTasks,
  taskState,
  useTasks,
} from './store.ts'

export function TasksPage() {
  const t = useTheme()
  const s = useTasks((s) => s)
  const projects = useApp((s) => s.projects)
  const all = useMemo(() => Object.values(s.tasks), [s.tasks])
  const visible = useMemo(
    () =>
      searchTasks(
        all.filter((task) => matchesFilter(task, s.prefs.filter, Date.now())),
        s.query,
      ),
    [all, s.prefs.filter, s.query],
  )
  const options = useMemo(
    () => ({
      ...s.prefs,
      showDone: s.prefs.showDone || !!s.query || s.prefs.filter === 'done',
      showCanceled: s.prefs.showCanceled || !!s.query,
    }),
    [s.prefs, s.query],
  )
  const groups = useMemo(() => groupTasks(visible, options, projects), [visible, options, projects])
  const columns = useMemo(() => boardColumns(visible, options), [visible, options])
  const sequence = useMemo(
    () =>
      s.prefs.view === 'board'
        ? columns.flatMap((c) => c.tasks.map((task) => task.id))
        : groups.filter((g) => !isGroupCollapsed(s.prefs, g)).flatMap((g) => g.tasks.map((task) => task.id)),
    [columns, groups, s.prefs],
  )
  const task = s.openId ? s.tasks[s.openId] : null
  const selected = [...s.selected].filter((id) => !!s.tasks[id])
  useEffect(() => {
    const shown = new Set((s.prefs.view === 'board' ? columns : groups).flatMap((g) => g.tasks.map((task) => task.id)))
    const keep = [...taskState().selected].filter((id) => !!s.tasks[id] && (s.openId || shown.has(id)))
    if (keep.length !== taskState().selected.size) setTasks({ selected: new Set(keep) })
  }, [columns, groups, s.openId, s.tasks, s.prefs.view])
  useEffect(
    () => () => {
      cancelTaskDrag()
      setTasks({ quick: null, composer: null, menu: null })
      taskTyping(false)
    },
    [],
  )
  useEffect(
    () =>
      addWindowKeyHandler((event) => {
        if (getNav().settingsOpen || getNav().paletteOpen || getNav().page !== 'tasks') return
        const s = taskState(),
          key = event.key,
          cmd = event.modifiers?.cmd || event.modifiers?.ctrl
        if (draggingTask()) {
          if (key === 'escape') escapeTaskDrag()
          return true
        }
        if (cmd && key === 'n') {
          setNav({ keyboardNav: true })
          quickAdd()
          return true
        }
        if (selectOwnsEscape() || s.menu) return
        const current = s.openId ?? s.focused
        const targets = !s.openId && s.selected.size ? [...s.selected] : current ? [current] : []
        const instant = () => setNav({ keyboardNav: true })
        if (cmd && key === 'n') {
          instant()
          quickAdd()
          return true
        }
        if (cmd && key === 'enter' && !s.composer && targets.length && !isTaskTyping()) {
          instant()
          setTasks({ composer: targets })
          return true
        }
        if (isTaskTyping() || s.quick || s.composer) return
        if (cmd && key === 'a' && !s.openId) {
          instant()
          setTasks({ selected: new Set(sequence), anchor: sequence[0] ?? null })
          return true
        }
        if (cmd && key === 'backspace' && targets.length) {
          instant()
          void deleteTasks(targets)
          return true
        }
        if (cmd || event.modifiers?.alt) return
        if (key === 'c') {
          instant()
          quickAdd()
          return true
        }
        if ((key === 's' || key === 'p') && targets.length) {
          instant()
          setTasks({ menu: key === 's' ? 'status' : 'priority' })
          return true
        }
        if (key === 'escape') {
          instant()
          if (s.openId) openTask(null)
          else if (s.selected.size) setTasks({ selected: new Set() })
          else setTasks({ focused: null })
          return true
        }
        if (key === 'x' && current && !s.openId) {
          instant()
          pick(current, sequence)
          return true
        }
        if (key === 'enter' && current && !s.openId) {
          instant()
          openTask(current)
          return true
        }
        if (key === 'j' || key === 'k' || key === 'down' || key === 'up') {
          const down = key === 'j' || key === 'down'
          const at = current ? sequence.indexOf(current) : -1
          const next =
            sequence[at < 0 ? (down ? 0 : sequence.length - 1) : Math.max(0, Math.min(sequence.length - 1, at + (down ? 1 : -1)))]
          if (next) {
            instant()
            if (s.openId) openTask(next)
            else if (event.modifiers?.shift) pick(next, sequence, true)
            else setTasks({ focused: next })
          }
          return true
        }
        if ((key === 'left' || key === 'right') && s.prefs.view === 'board' && current) {
          const from = columns.findIndex((c) => c.tasks.some((task) => task.id === current))
          const row = columns[from]?.tasks.findIndex((task) => task.id === current) ?? 0
          for (let i = from + (key === 'right' ? 1 : -1); i >= 0 && i < columns.length; i += key === 'right' ? 1 : -1) {
            const target = columns[i]!.tasks[Math.min(row, columns[i]!.tasks.length - 1)]
            if (target) {
              instant()
              setTasks({ focused: target.id })
              break
            }
          }
          return true
        }
      }),
    [sequence, columns],
  )
  const projectName = (task: { project_id?: string | null }) => projects.find((p) => p.id === task.project_id)?.name ?? 'Global'
  return (
    <div testId="page-tasks" style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, width: '100%' }}>
      {task ? (
        <TaskDetail key={task.id} task={task} sequence={sequence} />
      ) : (
        <>
          {s.error && (
            <div style={{ padding: 20, display: 'flex', gap: 12 }}>
              <Label color={t.red} size={13}>
                {s.error}
              </Label>
              <Button
                onClick={() => {
                  void refreshTasks()
                }}
              >
                Try again
              </Button>
            </div>
          )}
          {!s.loaded ? (
            <div style={{ padding: 32 }}>
              <Label color={t.textSecondary}>Loading tasks…</Label>
            </div>
          ) : !visible.length && !s.quick ? (
            <div style={{ display: 'flex', flexGrow: 1, alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12 }}>
              <Label color={t.text} size={17}>
                {s.query ? 'No matching tasks' : 'No tasks yet'}
              </Label>
              <Label color={t.textTertiary} size={13}>
                {s.query ? 'Try another search.' : 'Create a task to keep track of work.'}
              </Label>
              <Button onClick={() => quickAdd()}>New task</Button>
            </div>
          ) : s.prefs.view === 'board' ? (
            <TaskBoard columns={columns} sequence={sequence} projectName={projectName} />
          ) : (
            <TaskList groups={groups} sequence={sequence} projectName={projectName} />
          )}
          <SelectionBar ids={selected} show={selected.length > 0 && !s.composer} hints={s.prefs.showHints} />
          {!selected.length && s.focused && s.menu && (
            <div style={{ display: 'flex', padding: 8 }}>
              <TaskMenus ids={[s.focused]} property={s.menu} />
            </div>
          )}
          {s.prefs.showHints && <Hints selecting={selected.length > 0} />}
        </>
      )}
      {s.composer && <RunComposer key={s.composer.join(',')} ids={s.composer} />}
    </div>
  )
}

function Hints({ selecting }: { selecting: boolean }) {
  const t = useTheme()
  const keys: [string, string][] = selecting
    ? [['S', 'Status'], ['P', 'Priority'], ['⌘↵', 'Send to agent'], ['⌘⌫', 'Delete'], ['⌘A', 'Select all'], ['Esc', 'Clear']]
    : [['↑↓', 'Move'], ['↵', 'Open'], ['S', 'Status'], ['P', 'Priority'], ['⌘↵', 'Send to agent']]
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 20, height: 36, flexShrink: 0, paddingLeft: 20, paddingRight: 20 }}>
      {keys.map(([key, label]) => (
        <div key={key} style={{ display: 'flex', gap: 5 }}>
          <Label color={ink(t, 0.6)} size={12} lineHeight={18} weight={500}>{key}</Label>
          <Label color={t.textTertiary} size={12} lineHeight={18}>{label}</Label>
        </div>
      ))}
      <div style={{ flexGrow: 1 }} />
      <div testId="task-hide-hints" onClick={() => prefs({ showHints: false })} style={{ cursor: 'pointer' }}>
        <Label color={ink(t, 0.22)} size={12} lineHeight={18}>Hide hints</Label>
      </div>
    </div>
  )
}

export function DisplayMenu({ trigger }: { trigger?: () => React.ReactNode } = {}) {
  const t = useTheme(),
    p = useTasks((s) => s.prefs)
  return (
    <Menu
      testId="task-display"
      align="end"
      sideOffset={6}
      trigger={trigger ?? (() => (
        <div style={{ padding: 8, pointerEvents: 'none' }}>
          <Label color={t.textSecondary} size={13}>
            Display
          </Label>
        </div>
      ))}
    >
      <MenuItem id="group-label" label="Group by" disabled onSelect={() => {}} />
      {(['status', 'project', 'priority'] as TaskGrouping[]).map((grouping) => (
        <MenuItem
          testId={`task-grouping-${grouping}`}
          key={grouping}
          id={grouping}
          label={grouping[0]!.toUpperCase() + grouping.slice(1)}
          checked={p.grouping === grouping}
          disabled={p.view === 'board'}
          onSelect={() => prefs({ grouping })}
        />
      ))}
      <MenuSeparator />
      <MenuItem id="sort-label" label="Order by" disabled onSelect={() => {}} />
      {(['manual', 'priority', 'updated'] as TaskOrdering[]).map((ordering) => (
        <MenuItem
          key={ordering}
          id={`order-${ordering}`}
          label={ordering === 'updated' ? 'Last updated' : ordering === 'manual' ? 'Manual' : 'Priority'}
          checked={p.ordering === ordering}
          onSelect={() => prefs({ ordering })}
        />
      ))}
      <MenuSeparator />
      {(
        [
          { key: 'showDone', label: 'Show done' },
          { key: 'showCanceled', label: 'Show canceled' },
          { key: 'showHints', label: 'Show keyboard hints' },
        ] as const
      ).map(({ key, label }) => (
        <MenuItem key={key} id={key} label={label} checked={p[key]} keepOpen onSelect={() => prefs({ [key]: !p[key] })} />
      ))}
    </Menu>
  )
}
