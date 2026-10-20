import { memo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { ISLAND } from '../MatrixLoader.tsx'
import { useGpuixRequired, useWindowSize, type PublicInstance, type StyleDesc } from '@gpuix/react'
import { useSidebarWidth } from '../shell/layout.ts'
import { beginTaskDrag, trackTaskDrag, endPendingDrag, endTaskDrag, taskDragConsumesClick, regionRef, rowRef, taskPlaceholder, taskShift, useTaskDragOpacity, viewportRef } from './drag.tsx'
import { ShiftRow } from '../drag/shift.tsx'
import { PaintTranslate } from '../drag/PaintTranslate.tsx'
import { leftSource } from '../drag/leave.ts'
import { TASK_SORT_MOTION } from './motion.ts'
import { TaskWindow, type TaskWindowEntry } from './TaskWindow.tsx'
import { isGroupCollapsed, isOpenStatus, latestRun, runOutcome, STATUS_LABEL, type TaskGroup } from '@/state/tasksModel'
import { relativeTime } from '@/lib/format'
import type { TaskItem, TaskStatus } from '../../../../packages/kybern-client/src/types.ts'
import { Button } from '../settings/controls.tsx'
import { Icon } from '../icons.tsx'
import { ProjectDot } from '../notes/kit.tsx'
import { N } from '../nav/glyphs.ts'
import { ink, Label, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { over } from '../theme.ts'
import { Check, PriorityGlyph, StatusGlyph } from './Glyphs.tsx'
import { CountPop } from './CountPop.tsx'
import { CheckSlot } from './CheckSlot.tsx'
import { QuickAdd } from './QuickAdd.tsx'
import { MoreMenu } from './TaskMenus.tsx'
import { openTask, pick, prefs, quickAdd, setTasks, taskState, useTasks } from './store.ts'

/** `.tk-btn add`: a 28px plus at the row's end, shown while the group header is hovered. */
function AddButton({ testId, onClick, shown }: { testId: string; onClick: () => void; shown: boolean }) {
  const t = useTheme()
  const [hover, setHover] = useState(false)
  return (
    <div testId={testId} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} onClick={onClick} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 7, cursor: 'pointer', opacity: shown || hover ? 1 : 0, hover: { backgroundColor: ink(t, 0.05) } }}>
      <Icon source={N.plus} size={14} color={ink(t, hover ? 1 : 0.6)} />
    </div>
  )
}

export function TaskList({
  groups,
  sequence,
  projectName,
}: {
  groups: TaskGroup[]
  sequence: string[]
  projectName: (task: TaskItem) => string
}) {
  const t = useTheme()
  const p = useTasks((s) => s.prefs)
  const quick = useTasks((s) => s.quick)
  const [hoverGroup, setHoverGroup] = useState<string | null>(null)
  const shown: TaskGroup[] =
    quick && !groups.some((g) => g.key === quick.groupKey)
      ? [
          ...groups,
          { key: quick.groupKey, label: 'New task', tasks: [], status: quick.groupKey.startsWith('status:') ? quick.status : undefined },
        ]
      : groups
  const entries: TaskWindowEntry[] = shown.flatMap((group, index) => {
    const collapsed = isGroupCollapsed(p, group) && quick?.groupKey !== group.key
    return [
      {
        key: group.key,
        height: index ? 50 : 40,
        render: () => (
          <div
            ref={(node) => {
              if (group.status)
                regionRef(
                  group.key,
                  p.grouping === 'status' ? node : null,
                  group.status,
                  group.tasks.map((task) => task.id),
                  false,
                )
            }}
            onMouseEnter={() => setHoverGroup(group.key)}
            onMouseLeave={() => setHoverGroup((key) => (key === group.key ? null : key))}
            style={{ display: 'flex', flexDirection: 'column', height: index ? 50 : 40 }}
          >
          {/* The header moves with the rows when a drag between groups reflows the list; its region box stays put. */}
          <ShiftRow store={taskShift} id={`header:${group.key}`} transition={TASK_SORT_MOTION}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              paddingLeft: 20,
              paddingRight: 20,
              paddingTop: index ? 14 : 4,
              height: index ? 50 : 40,
              gap: 10,
            }}
          >
            <div
              testId={`task-group-${group.key}`}
              onClick={() => prefs({ collapsed: { ...p.collapsed, [group.key]: !collapsed } })}
              style={{ display: 'flex', alignItems: 'center', flexGrow: 1, gap: 10, height: 28, cursor: 'pointer' }}
            >
              {group.status && <div style={{ display: 'flex', width: 28, marginRight: -10, pointerEvents: 'none' }}><StatusGlyph status={group.status} /></div>}
              <Label
                color={t.text}
                weight={500}
                size={13}
                style={{ pointerEvents: 'none', userSelect: 'none' }}
              >{`${group.label}${collapsed ? ' ›' : ''}`}</Label>
              <CountPop value={group.tasks.length} color={t.textTertiary} size={13} style={{ pointerEvents: 'none', userSelect: 'none' }} />
            </div>
            {(!group.status || group.status === 'inbox' || group.status === 'todo') && (
              <AddButton
                shown={hoverGroup === group.key}
                testId={`task-add-${group.key}`}
                onClick={() =>
                  quickAdd(group.status === 'todo' ? 'todo' : 'inbox', { projectId: group.projectId, priority: group.priority })
                }
              />
            )}
          </div>
          </ShiftRow>
          </div>
        ),
      },
      ...(quick?.groupKey === group.key
        ? [{ key: `quick:${quick.nonce}`, height: 40, pinned: true, render: () => <QuickAdd request={quick} /> }]
        : []),
      ...(!collapsed
        ? group.tasks.map((task) => ({
            key: task.id,
            height: 40,
            render: () => <TaskRow task={task} sequence={sequence} project={projectName(task)} />,
          }))
        : []),
    ]
  })
  return (
    <div
      ref={viewportRef}
      testId="task-list-viewport"
      style={{ display: 'flex', flexGrow: 1, minHeight: 0, width: '100%', userSelect: 'none' }}
    >
      <TaskWindow testId="task-list" entries={entries} />
    </div>
  )
}
export const TaskRow = memo(function TaskRow({
  task,
  sequence,
  project,
  card = false,
}: {
  task: TaskItem
  sequence: string[]
  project: string
  card?: boolean
}) {
  const t = useTheme()
  const renderer = useGpuixRequired()
  const dragOpacity = useTaskDragOpacity(task.id)
  const draggable = useTasks((s) => s.prefs.view === 'board' || s.prefs.grouping === 'status')
  const selected = useTasks((s) => s.selected.has(task.id))
  const focused = useTasks((s) => s.focused === task.id)
  const [hover, setHover] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const detail = cardDetail(task)
  // tasks.css: selected+hover > selected > focused > hover, each a step brighter; selected+focused adds a 2px ring.
  const strong = t.variant === 'dark'
  const rowAlpha = selected && hover ? (strong ? 0.12 : 0.105) : selected ? (strong ? 0.095 : 0.08) : focused ? (strong ? 0.075 : 0.06) : hover ? (strong ? 0.035 : 0.03) : 0
  const background = rowAlpha ? ink(t, rowAlpha) : 'transparent'
  if (card) {
    const raised = hover || focused || selected
    return (
      <ShiftRow store={taskShift} id={task.id} transition={TASK_SORT_MOTION}>
      <div style={{ paddingBottom: 8 }}>
        <div
          ref={(node) => rowRef(task.id, node)}
          testId={`task-row-${task.id}`}
          tabIndex={0}
          aria-label={`${task.key} ${task.title}`}
          onFocus={() => setTasks({ focused: task.id })}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={(e) => { setHover(false); if (!leftSource(e, renderer)) return; if (draggable) trackTaskDrag(e, true); endPendingDrag() }}
          onMouseDown={(e) => beginTaskDrag(task.id, e, renderer, sequence, draggable)}
          onMouseMove={draggable ? (e) => trackTaskDrag(e) : undefined}
          onMouseUp={endTaskDrag}
          onClick={(e) => {
            if (taskDragConsumesClick()) return
            if (e.modifiers?.cmd || e.modifiers?.ctrl || e.modifiers?.shift) pick(task.id, sequence, !!e.modifiers?.shift)
            else openTask(task.id)
          }}
          style={{ ...cardSurface(t, raised, focused), opacity: dragOpacity }}
        >
          <CardLines task={task} detail={detail} checkShown={hover || selected} check={<Check testId={`task-select-${task.id}`} checked={selected} onClick={() => pick(task.id, sequence)} />} />
        </div>
      </div>
      </ShiftRow>
    )
  }
  return (
    <ShiftRow store={taskShift} id={task.id} transition={TASK_SORT_MOTION}>
    <div style={{ paddingLeft: card ? 2 : 0, paddingRight: card ? 2 : 0, paddingBottom: card ? 8 : 0 }}>
      <div
        {...ISLAND}
        ref={(node) => rowRef(task.id, node)}
        testId={`task-row-${task.id}`}
        tabIndex={0}
        aria-label={`${task.key} ${task.title}`}
        onFocus={() => setTasks({ focused: task.id })}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: 'flex',
          position: 'relative',
          flexDirection: card ? 'column' : 'row',
          alignItems: card ? 'stretch' : 'center',
          minHeight: card ? 114 : 40,
          width: '100%',
          height: 40,
          paddingLeft: card ? 12 : 20,
          paddingRight: card ? 12 : 20,
          paddingTop: card ? 8 : 0,
          paddingBottom: card ? 8 : 0,
          borderRadius: card ? 8 : 0,
          backgroundColor: background,
          userSelect: 'none',
          opacity: dragOpacity,
          gap: card ? 8 : 0,
        }}
      >
        {selected && focused && <div style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, borderWidth: 2, borderColor: ink(t, 0.14), borderRadius: card ? 8 : 0, pointerEvents: 'none' }} />}
        <div onClick={() => openTask(task.id)} style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
          <div style={{ width: 28, pointerEvents: 'none', userSelect: 'none' }}>
            <PriorityGlyph priority={task.priority} />
          </div>
          <Label
            color={t.textTertiary}
            size={12}
            truncate
            style={{ width: card ? 68 : 58, flexShrink: 0, userSelect: 'none', pointerEvents: 'none' }}
          >
            {task.key}
          </Label>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', flexGrow: 1, minWidth: 0 }}>
          {/* The status glyph and the checkbox share one 26x30 slot and cross-fade over 80 ms on hover and selection. */}
          <CheckSlot
            show={hover || selected}
            base={<div onClick={() => pick(task.id, sequence)} style={{ display: 'flex', width: 26, height: 30, alignItems: 'center' }}><StatusGlyph status={task.status} /></div>}
            over={<Check testId={`task-select-${task.id}`} checked={selected} onClick={() => pick(task.id, sequence)} />}
          />
          <div
            testId={`task-drag-${task.id}`}
            onMouseDown={(e) => beginTaskDrag(task.id, e, renderer, sequence, draggable)}
            onMouseMove={draggable ? (e) => trackTaskDrag(e) : undefined}
            onMouseUp={endTaskDrag}
            onMouseLeave={(e) => { if (!leftSource(e, renderer)) return; if (draggable) trackTaskDrag(e, true); endPendingDrag() }}
            onClick={(e) => {
              if (taskDragConsumesClick()) return
              if (e.modifiers?.cmd || e.modifiers?.ctrl || e.modifiers?.shift) pick(task.id, sequence, !!e.modifiers?.shift)
              else openTask(task.id)
            }}
            style={{ display: 'flex', alignItems: 'center', flexGrow: 1, minWidth: 0, minHeight: 40 }}
          >
            <Label
              color={isOpenStatus(task.status) ? t.text : t.textSecondary}
              size={13}
              truncate
              style={{ flexGrow: 1, pointerEvents: 'none', userSelect: 'none' }}
            >
              {task.title || 'Untitled'}
            </Label>
          </div>
        </div>
        {!!detail && (
          <Label
            color={t.textTertiary}
            size={12}
            truncate
            style={{ maxWidth: card ? 240 : 300, paddingLeft: card ? 0 : 16, pointerEvents: 'none', userSelect: 'none' }}
          >
            {detail}
          </Label>
        )}
        {card ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Label color={t.textSecondary} size={12} truncate style={{ maxWidth: 160, pointerEvents: 'none', userSelect: 'none' }}>{project}</Label>
            <Label color={t.textTertiary} size={12} style={{ pointerEvents: 'none', userSelect: 'none' }}>{relativeTime(task.created_at, Date.now())}</Label>
            {hover || focused || menuOpen ? <MoreMenu task={task} sequence={sequence} onOpenChange={setMenuOpen} /> : <div style={{ width: 28, height: 28 }} />}
          </div>
        ) : (
          <>
            {/* `.proj` (132px, dot and name) then `.age` (34px, right-aligned). */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: 132, flexShrink: 0, paddingLeft: 12 }}>
              <ProjectDot projectId={task.scope === 'project' ? task.project_id ?? null : null} />
              <Label color={ink(t, 0.6)} size={12} lineHeight={18} truncate style={{ pointerEvents: 'none', userSelect: 'none' }}>{project}</Label>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', width: 34, flexShrink: 0 }}>
              <Label color={t.textTertiary} size={12} lineHeight={18} style={{ pointerEvents: 'none', userSelect: 'none' }}>{relativeTime(task.created_at, Date.now())}</Label>
            </div>
            {(hover || focused || menuOpen) && (
              <div style={{ position: 'absolute', right: 20, top: 6 }}>
                <MoreMenu task={task} sequence={sequence} onOpenChange={setMenuOpen} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
    </ShiftRow>
  )
})

function cardDetail(task: TaskItem) {
  const run = latestRun(task)
  return run && (task.status === 'running' || task.status === 'needs_review') ? run.activity || runOutcome(run, Date.now()) : ''
}
/** `.tk-card` at rest, raised (hover, focus, selection) and focused. */
function cardSurface(t: ReturnType<typeof useTheme>, raised: boolean, focused: boolean): StyleDesc {
  const dark = t.variant === 'dark'
  const base = dark ? over(ink(t, 0.03), t.surface) : t.surface
  const fill = dark ? (raised ? over(ink(t, 0.055), t.surface) : base) : base
  return { position: 'relative', display: 'flex', flexDirection: 'column', flexShrink: 0, paddingTop: 11, paddingBottom: 12, paddingLeft: 12, paddingRight: 12, borderRadius: 10, backgroundColor: fill, userSelect: 'none', boxShadow: dark ? { offsetX: 0, offsetY: raised ? 6 : 1, blurRadius: raised ? 18 : 2, spreadRadius: raised ? -6 : 0, color: raised ? 'rgba(0, 0, 0, 0.5)' : 'rgba(0, 0, 0, 0.25)' } : { offsetX: 0, offsetY: raised ? 4 : 1, blurRadius: raised ? 14 : 2, spreadRadius: raised ? -4 : 0, color: raised ? 'rgba(0, 0, 0, 0.12)' : 'rgba(0, 0, 0, 0.05)' }, borderWidth: dark ? 0 : 0.5, borderColor: 'rgba(0, 0, 0, 0.09)', ...(focused ? { borderWidth: 1.5, borderColor: ink(t, 0.14) } : {}) }
}
/** The card's key row, title and run line; `check` cross-fades with the priority glyph (the hover checkbox). */
function CardLines({ task, detail, check, checkShown = false }: { task: TaskItem; detail: string; check?: ReactNode; checkShown?: boolean }) {
  const t = useTheme()
  return <>
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, height: 16, flexShrink: 0 }}>
      <ProjectDot projectId={task.scope === 'project' ? task.project_id ?? null : null} />
      <Label color={t.textTertiary} size={12} lineHeight={16} style={{ pointerEvents: 'none', userSelect: 'none' }}>{task.key}</Label>
      <div style={{ flexGrow: 1 }} />
      {check ? <CheckSlot show={checkShown} width={26} height={16} align="end" base={task.priority !== 0 ? <PriorityGlyph priority={task.priority} /> : undefined} over={check} /> : task.priority !== 0 && <PriorityGlyph priority={task.priority} />}
    </div>
    <div testId={`task-drag-${task.id}`} style={{ display: 'flex', flexDirection: 'column', marginTop: 6, flexShrink: 0, width: '100%', pointerEvents: 'none' }}>
      <Label color={isOpenStatus(task.status) ? t.text : t.textSecondary} size={13} lineHeight={18} style={{ width: '100%', pointerEvents: 'none', userSelect: 'none' }}>{task.title || 'Untitled'}</Label>
    </div>
    {!!detail && <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 10 }}><Label color={ink(t, 0.6)} size={12} lineHeight={16} truncate style={{ pointerEvents: 'none' }}>{detail}</Label></div>}
  </>
}

/** The held card in a column it did not start in: the source's dimmed `.tk-card[data-dragging]` in
 * its slot, under the column's cards and clipped to the column, as dnd-kit draws it after moving it
 * there. It appears in place and slides between slots of this column like a sorted card. */
function TaskDropPlaceholder({ status }: { status: TaskStatus }) {
  const t = useTheme()
  const renderer = useGpuixRequired()
  const held = useSyncExternalStore(taskPlaceholder.subscribe, taskPlaceholder.get)
  const [node, setNode] = useState<PublicInstance | null>(null)
  const shown = held?.status === status ? held : null
  const task = shown && taskState().tasks[shown.id]
  const origin = shown && node && renderer.getElementBounds?.(node.id)
  return (
    <div ref={setNode} style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', overflow: 'hidden', pointerEvents: 'none' }}>
      {shown && task && origin && (
        <PaintTranslate key={shown.entry} initial={{ translateX: 0, translateY: shown.slot.y - origin.y }} animate={{ translateX: 0, translateY: shown.slot.y - origin.y }}
          transition={REDUCED_MOTION ? { duration: 0 } : TASK_SORT_MOTION}
          style={{ position: 'absolute', left: shown.slot.x - origin.x, top: 0, width: shown.slot.width, height: shown.slot.height, pointerEvents: 'none' }}>
          <div testId="task-drop-placeholder" style={{ ...cardSurface(t, false, false), width: '100%', height: '100%', opacity: 0.35, pointerEvents: 'none' }}>
            <CardLines task={task} detail={cardDetail(task)} />
          </div>
        </PaintTranslate>
      )}
    </div>
  )
}

export function TaskBoard({
  columns,
  sequence,
  projectName,
}: {
  columns: { status: TaskStatus; tasks: TaskItem[] }[]
  sequence: string[]
  projectName: (task: TaskItem) => string
}) {
  const t = useTheme()
  const size = useWindowSize({ intervalMs: 300 })
  const sidebar = useSidebarWidth()
  const quick = useTasks((s) => s.quick)
  const [hoverColumn, setHoverColumn] = useState<string | null>(null)
  // `.tk-col`: equal columns of at least 196px between 16px gutters, 12px apart.
  const available = size.width - 52 - sidebar - 8 - 32
  const columnWidth = Math.max(196, (available - 12 * (columns.length - 1)) / columns.length)
  return (
    <div
      ref={viewportRef}
      testId="task-board"
      style={{ display: 'flex', flexGrow: 1, minHeight: 0, overflowX: 'scroll', userSelect: 'none', paddingTop: 8, paddingLeft: 16, paddingRight: 16, gap: 12 }}
    >
      {columns.map((column) => (
        <div
          key={column.status}
          testId={`task-column-${column.status}`}
          onMouseEnter={() => setHoverColumn(column.status)}
          onMouseLeave={() => setHoverColumn((s) => (s === column.status ? null : s))}
          ref={(node) =>
            regionRef(
              `board:${column.status}`,
              node,
              column.status,
              column.tasks.map((task) => task.id),
              true,
            )
          }
          style={{ display: 'flex', flexDirection: 'column', width: columnWidth, minWidth: columnWidth, minHeight: 0, height: '100%' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', height: 34, gap: 9, flexShrink: 0, paddingLeft: 4, paddingRight: 4 }}>
            <StatusGlyph status={column.status} />
            <Label color={t.text} size={13} lineHeight={19.5} weight={500}>
              {STATUS_LABEL[column.status]}
            </Label>
            <CountPop value={column.tasks.length} color={t.textTertiary} size={13} lineHeight={19.5} />
            <div style={{ flexGrow: 1 }} />
            {(column.status === 'inbox' || column.status === 'todo') && (
              <div testId={`task-board-add-${column.status}`} onClick={() => quickAdd(column.status as 'inbox' | 'todo')} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 7, marginRight: -4, opacity: hoverColumn === column.status ? 1 : 0, cursor: 'pointer', hover: { backgroundColor: ink(t, 0.05) } }}>
                <Icon source={N.plus} size={14} color={ink(t, 0.6)} />
              </div>
            )}
          </div>
          <div style={{ height: 4, flexShrink: 0 }} />
          <TaskWindow
            card
            underlay={<TaskDropPlaceholder status={column.status} />}
            entries={[
              ...(quick?.status === column.status
                ? [{ key: `quick:${quick.nonce}`, height: 96, pinned: true, render: () => <QuickAdd request={quick} card /> }]
                : []),
              ...column.tasks.map((task) => ({ key: task.id, height: 71, intrinsic: true, render: () => <TaskRow task={task} sequence={sequence} project={projectName(task)} card /> })),
            ]}
          />
        </div>
      ))}
    </div>
  )
}
