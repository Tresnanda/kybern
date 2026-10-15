import { PRIORITY_LABEL, PRIORITY_MENU_ORDER, STATUS_LABEL, USER_STATUSES } from '@/state/tasksModel'
import type { TaskItem } from '../../../../packages/kybern-client/src/types.ts'
import { Menu, MenuItem, MenuSeparator } from '../nav/overlay.tsx'
import { Label, useTheme } from '../ui.tsx'
import { useApp } from '../state.ts'
import { deleteTasks, setTasks, taskState, updateMany, updateTask, useTasks } from './store.ts'

export function TaskMenus({ ids, property, label }: { ids: string[]; property: 'status' | 'priority'; label?: string }) {
  const t = useTheme()
  const menu = useTasks((s) => s.menu)
  const tasks = useTasks((s) => s.tasks)
  const first = tasks[ids[0]!]
  return (
    <Menu
      testId={`task-${property}`}
      open={menu === property}
      onOpenChange={(open) => setTasks({ menu: open ? property : null })}
      trigger={() => (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            height: 28,
            paddingLeft: 8,
            paddingRight: 8,
            borderRadius: 7,
            hover: { backgroundColor: t.hover },
            pointerEvents: 'none',
          }}
        >
          <Label color={t.textSecondary} size={13}>
            {label ?? (first ? (property === 'status' ? STATUS_LABEL[first.status] : PRIORITY_LABEL[first.priority]) : property)}
          </Label>
        </div>
      )}
    >
      {(property === 'status' ? USER_STATUSES : PRIORITY_MENU_ORDER).map((value) => (
        <MenuItem
          testId={`task-${property}-${value}`}
          key={value}
          id={String(value)}
          label={
            property === 'status' ? STATUS_LABEL[value as keyof typeof STATUS_LABEL] : PRIORITY_LABEL[value as keyof typeof PRIORITY_LABEL]
          }
          checked={ids.every((id) => tasks[id]?.[property] === value)}
          onSelect={() => {
            void updateMany(ids, { [property]: value })
          }}
        />
      ))}
      {property === 'status' && (
        <>
          <MenuSeparator />
          <MenuItem id="send" label="Send to agent…" onSelect={() => setTasks({ composer: ids })} />
        </>
      )}
    </Menu>
  )
}
export function ProjectMenu({ task }: { task: TaskItem }) {
  const t = useTheme()
  const projects = useApp((s) => s.projects)
  return (
    <Menu
      testId="task-project"
      trigger={() => (
        <div style={{ display: 'flex', alignItems: 'center', height: 28, paddingLeft: 8, paddingRight: 8, pointerEvents: 'none' }}>
          <Label color={t.textSecondary} size={12} truncate>
            {projects.find((p) => p.id === task.project_id)?.name ?? 'Global'}
          </Label>
        </div>
      )}
    >
      {[{ id: '', name: 'Global' }, ...projects].map((p) => (
        <MenuItem
          key={p.id}
          id={p.id || 'global'}
          label={p.name}
          checked={(task.project_id ?? '') === p.id}
          onSelect={() => {
            void updateTask(task.id, { scope: p.id ? 'project' : 'global', project_id: p.id || null }).catch(() => {})
          }}
        />
      ))}
    </Menu>
  )
}
export function MoreMenu({ task, sequence, onOpenChange }: { task: TaskItem; sequence: string[]; onOpenChange?: (open: boolean) => void }) {
  const t = useTheme()
  const column = sequence.filter((id) => taskState().tasks[id]?.status === task.status)
  const index = column.indexOf(task.id)
  const move = (before_id: string | null) => {
    void updateTask(task.id, { before_id }).catch(() => {})
  }
  return (
    <Menu
      onOpenChange={onOpenChange}
      testId={`task-more-${task.id}`}
      trigger={() => (
        <div style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
          <Label color={t.textTertiary}>⋯</Label>
        </div>
      )}
    >
      <MenuItem id="status" label="Change status…" shortcut="S" onSelect={() => setTasks({ focused: task.id, menu: 'status' })} />
      <MenuItem id="priority" label="Change priority…" shortcut="P" onSelect={() => setTasks({ focused: task.id, menu: 'priority' })} />
      <MenuItem
        id="up"
        label="Move up"
        disabled={index <= 0 || taskState().prefs.ordering !== 'manual'}
        onSelect={() => move(column[index - 1]!)}
      />
      <MenuItem
        id="down"
        label="Move down"
        disabled={index < 0 || index === column.length - 1 || taskState().prefs.ordering !== 'manual'}
        onSelect={() => move(column[index + 2] ?? null)}
      />
      <MenuSeparator />
      <MenuItem
        id="delete"
        label="Delete task"
        destructive
        onSelect={() => {
          void deleteTasks([task.id])
        }}
      />
    </Menu>
  )
}
