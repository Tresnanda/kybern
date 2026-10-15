import { PRIORITY_LABEL, PRIORITY_MENU_ORDER, STATUS_LABEL, USER_STATUSES } from '@/state/tasksModel'
import type { TaskItem } from '../../../../packages/kybern-client/src/types.ts'
import { Menu, MenuItem, MenuSeparator } from '../nav/overlay.tsx'
import { ink, Label, useTheme } from '../ui.tsx'
import { ProjectDot } from '../notes/kit.tsx'
import { PriorityGlyph, StatusGlyph } from './Glyphs.tsx'
import { Icon } from '../icons.tsx'
import { useApp } from '../state.ts'
import { deleteTasks, setTasks, taskState, updateMany, updateTask, useTasks } from './store.ts'

/** `.tk-prop .v`: 28px, 6px padding, a glyph and the value, on the properties panel. */
function Value({ children }: { children: React.ReactNode }) {
  const t = useTheme()
  return <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 28, marginLeft: -6, paddingLeft: 6, paddingRight: 6, borderRadius: 6, pointerEvents: 'none', hover: { backgroundColor: ink(t, 0.05) } }}>{children}</div>
}

export function TaskMenus({ ids, property, label, value, bar }: { ids: string[]; property: 'status' | 'priority'; label?: string; value?: boolean; bar?: boolean }) {
  const t = useTheme()
  const menu = useTasks((s) => s.menu)
  const tasks = useTasks((s) => s.tasks)
  const first = tasks[ids[0]!]
  return (
    <Menu
      testId={`task-${property}`}
      open={menu === property}
      onOpenChange={(open) => setTasks({ menu: open ? property : null })}
      trigger={() => value && first ? (
        <Value>
          {property === 'status' ? <StatusGlyph status={first.status} /> : <PriorityGlyph priority={first.priority} />}
          <Label color={ink(t, 0.86)} size={13} lineHeight={19.5}>{property === 'status' ? STATUS_LABEL[first.status] : PRIORITY_LABEL[first.priority]}</Label>
        </Value>
      ) : (
        // `.tk-selbar .tk-btn` (bar): 32px, 10px padding, 7px gap, the glyph at secondary ink.
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: bar ? 7 : 0,
            height: bar ? 32 : 28,
            paddingLeft: bar ? 10 : 8,
            paddingRight: bar ? 10 : 8,
            borderRadius: bar ? 8 : 7,
            hover: { backgroundColor: t.hover },
            pointerEvents: 'none',
          }}
        >
          {bar && (property === 'status' ? <StatusGlyph status="todo" mono /> : <PriorityGlyph priority={3} />)}
          <Label color={bar ? ink(t, 0.86) : t.textSecondary} size={13}>
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
export function ProjectMenu({ task, value }: { task: TaskItem; value?: boolean }) {
  const t = useTheme()
  const projects = useApp((s) => s.projects)
  return (
    <Menu
      testId="task-project"
      trigger={() => value ? (
        <Value><ProjectDot projectId={task.scope === 'project' ? task.project_id ?? null : null} /><Label color={ink(t, 0.86)} size={13} lineHeight={19.5} truncate>{projects.find((p) => p.id === task.project_id)?.name ?? 'Global'}</Label></Value>
      ) : (
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
export function MoreMenu({ task, sequence, onOpenChange, icon }: { task: TaskItem; sequence: string[]; onOpenChange?: (open: boolean) => void; icon?: string }) {
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
          {icon ? <Icon source={icon} size={16} color={ink(t, 0.6)} /> : <Label color={t.textTertiary}>⋯</Label>}
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
