import { memo, useState } from 'react'
import { useGpuixRequired } from '@gpuix/react'
import { beginTaskDrag, trackTaskDrag, endPendingDrag, regionRef, rowRef, useTaskLift, viewportRef } from './drag.tsx'
import { TaskWindow, type TaskWindowEntry } from './TaskWindow.tsx'
import { isGroupCollapsed, isOpenStatus, latestRun, runOutcome, STATUS_LABEL, type TaskGroup } from '@/state/tasksModel'
import { relativeTime } from '@/lib/format'
import type { TaskItem, TaskStatus } from '../../../../packages/kybern-client/src/types.ts'
import { Button } from '../settings/controls.tsx'
import { ink, Label, useTheme } from '../ui.tsx'
import { Check, PriorityGlyph, StatusGlyph } from './Glyphs.tsx'
import { QuickAdd } from './QuickAdd.tsx'
import { MoreMenu } from './TaskMenus.tsx'
import { openTask, pick, prefs, quickAdd, setTasks, taskState, useTasks } from './store.ts'

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
        height: index ? 50 : 36,
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
            style={{
              display: 'flex',
              alignItems: 'center',
              paddingLeft: 20,
              paddingRight: 20,
              paddingTop: index ? 14 : 0,
              height: index ? 50 : 36,
              gap: 10,
            }}
          >
            <div
              testId={`task-group-${group.key}`}
              onClick={() => prefs({ collapsed: { ...p.collapsed, [group.key]: !collapsed } })}
              style={{ display: 'flex', alignItems: 'center', flexGrow: 1, gap: 10, height: 28, cursor: 'pointer' }}
            >
              {group.status && <StatusGlyph status={group.status} />}
              <Label
                color={t.text}
                weight={500}
                size={13}
                style={{ pointerEvents: 'none', userSelect: 'none' }}
              >{`${group.label}${collapsed ? ' ›' : ''}`}</Label>
              <Label color={t.textTertiary} size={12} style={{ pointerEvents: 'none', userSelect: 'none' }}>
                {String(group.tasks.length)}
              </Label>
            </div>
            {(!group.status || group.status === 'inbox' || group.status === 'todo') && (
              <Button
                testId={`task-add-${group.key}`}
                onClick={() =>
                  quickAdd(group.status === 'todo' ? 'todo' : 'inbox', { projectId: group.projectId, priority: group.priority })
                }
              >
                +
              </Button>
            )}
          </div>
        ),
      },
      ...(quick?.groupKey === group.key
        ? [{ key: `quick:${quick.nonce}`, height: 48, pinned: true, render: () => <QuickAdd request={quick} /> }]
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
  const lifted = useTaskLift(task.id)
  const draggable = useTasks((s) => s.prefs.view === 'board' || s.prefs.grouping === 'status')
  const selected = useTasks((s) => s.selected.has(task.id))
  const selecting = useTasks((s) => s.selected.size > 0)
  const focused = useTasks((s) => s.focused === task.id)
  const [hover, setHover] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const run = latestRun(task)
  const detail = run && (task.status === 'running' || task.status === 'needs_review') ? run.activity || runOutcome(run, Date.now()) : ''
  const background = selected ? ink(t, 0.095) : focused ? ink(t, 0.075) : card ? ink(t, 0.03) : 'transparent'
  return (
    <div style={{ paddingLeft: card ? 2 : 0, paddingRight: card ? 2 : 0, paddingBottom: card ? 8 : 0 }}>
      <div
        ref={(node) => rowRef(task.id, node)}
        testId={`task-row-${task.id}`}
        tabIndex={0}
        aria-label={`${task.key} ${task.title}`}
        onFocus={() => setTasks({ focused: task.id })}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: 'flex',
          flexDirection: card ? 'column' : 'row',
          alignItems: card ? 'stretch' : 'center',
          minHeight: card ? 114 : 40,
          height: card ? cardHeight(task) - 8 : 40,
          paddingLeft: card ? 12 : 20,
          paddingRight: card ? 12 : 20,
          paddingTop: card ? 8 : 0,
          paddingBottom: card ? 8 : 0,
          borderRadius: card ? 8 : 0,
          backgroundColor: background,
          userSelect: 'none',
          opacity: lifted ? 0.35 : 1,
          gap: card ? 8 : 0,
          hover: { backgroundColor: ink(t, 0.05) },
        }}
      >
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
          {hover || selecting ? (
            <Check testId={`task-select-${task.id}`} checked={selected} onClick={() => pick(task.id, sequence)} />
          ) : (
            <div onClick={() => pick(task.id, sequence)} style={{ display: 'flex', width: 26, height: 30, alignItems: 'center' }}>
              <StatusGlyph status={task.status} />
            </div>
          )}
          <div
            testId={`task-drag-${task.id}`}
            onMouseDown={draggable ? (e) => beginTaskDrag(task.id, e, renderer, sequence) : undefined}
            onMouseMove={draggable ? trackTaskDrag : undefined}
            onMouseUp={endPendingDrag}
            onMouseLeave={endPendingDrag}
            onClick={(e) => {
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
            style={{ maxWidth: card ? 240 : 180, paddingLeft: card ? 0 : 12, pointerEvents: 'none', userSelect: 'none' }}
          >
            {detail}
          </Label>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingLeft: card ? 0 : 16 }}>
          <Label
            color={t.textSecondary}
            size={12}
            truncate
            style={{ maxWidth: card ? 160 : 110, pointerEvents: 'none', userSelect: 'none' }}
          >
            {project}
          </Label>
          <Label color={t.textTertiary} size={12} style={{ pointerEvents: 'none', userSelect: 'none' }}>
            {relativeTime(task.created_at, Date.now())}
          </Label>
          {hover || focused || menuOpen ? (
            <MoreMenu task={task} sequence={sequence} onOpenChange={setMenuOpen} />
          ) : (
            <div style={{ width: 28, height: 28 }} />
          )}
        </div>
      </div>
    </div>
  )
})

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
  const quick = useTasks((s) => s.quick)
  return (
    <div
      ref={viewportRef}
      testId="task-board"
      style={{
        display: 'flex',
        flexGrow: 1,
        minHeight: 0,
        overflowX: 'scroll',
        userSelect: 'none',
        paddingLeft: 18,
        paddingRight: 18,
        gap: 18,
      }}
    >
      {columns.map((column) => (
        <div
          key={column.status}
          testId={`task-column-${column.status}`}
          ref={(node) =>
            regionRef(
              `board:${column.status}`,
              node,
              column.status,
              column.tasks.map((task) => task.id),
              true,
            )
          }
          style={{ display: 'flex', flexDirection: 'column', width: 270, minWidth: 270, minHeight: 0, height: '100%' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', height: 42, gap: 8, flexShrink: 0 }}>
            <StatusGlyph status={column.status} />
            <Label color={t.text} size={13} weight={500}>
              {STATUS_LABEL[column.status]}
            </Label>
            <Label color={t.textTertiary} size={12} style={{ flexGrow: 1 }}>
              {String(column.tasks.length)}
            </Label>
            {(column.status === 'inbox' || column.status === 'todo') && (
              <Button onClick={() => quickAdd(column.status as 'inbox' | 'todo')}>+</Button>
            )}
          </div>
          <TaskWindow
            card
            entries={[
              ...(quick?.status === column.status
                ? [{ key: `quick:${quick.nonce}`, height: 196, pinned: true, render: () => <QuickAdd request={quick} card /> }]
                : []),
              ...column.tasks.map((task) => ({
                key: task.id,
                height: cardHeight(task),
                render: () => <TaskRow task={task} sequence={sequence} project={projectName(task)} card />,
              })),
            ]}
          />
        </div>
      ))}
    </div>
  )
}

function cardHeight(task: TaskItem) {
  return latestRun(task) && (task.status === 'running' || task.status === 'needs_review') ? 144 : 122
}
