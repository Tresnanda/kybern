import { PRIORITY_LABEL, PRIORITY_MENU_ORDER, STATUS_LABEL, USER_STATUSES } from '@/state/tasksModel'
import type { TaskItem } from '../../../../packages/kybern-client/src/types.ts'
import { Menu, MenuItem, MenuSeparator } from '../nav/overlay.tsx'
import { ink, Label, useTheme } from '../ui.tsx'
import { ProjectDot } from '../notes/kit.tsx'
import { PriorityGlyph, StatusGlyph } from './Glyphs.tsx'
import { ICONS } from '../icons.tsx'
import { IconButton } from '../kit/IconButton.tsx'
import { useApp } from '../state.ts'
import { useSpaceProjects } from '../spaces/current.ts'
import { deleteTasks, setTasks, taskState, updateMany, updateTask, useTasks } from './store.ts'
import { Button } from '../kit/Button.tsx'
import { PickerChip } from '../kit/PickerChip.tsx'

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
      trigger={(open) => value && first ? (
        // The property panel's picker: quiet (no fill at rest, the chevron and a neutral fill on hover).
        <PickerChip quiet size="sm" open={open} lead={property === 'status' ? <StatusGlyph status={first.status} /> : <PriorityGlyph priority={first.priority} />}>{property === 'status' ? STATUS_LABEL[first.status] : PRIORITY_LABEL[first.priority]}</PickerChip>
      ) : (
        // The selection bar's Status and Priority: secondary buttons at the bar's 32.
        <Button size={bar ? 'lg' : 'sm'} chevron>{label ?? (first ? (property === 'status' ? STATUS_LABEL[first.status] : PRIORITY_LABEL[first.priority]) : property)}</Button>
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
  const projects = useSpaceProjects()
  return (
    <Menu
      testId="task-project"
      trigger={(open) => value ? (
        <PickerChip quiet size="sm" open={open} lead={<ProjectDot projectId={task.scope === 'project' ? task.project_id ?? null : null} />} truncate>{projects.find((p) => p.id === task.project_id)?.name ?? 'Global'}</PickerChip>
      ) : (
        <PickerChip quiet size="sm" open={open} truncate>{projects.find((p) => p.id === task.project_id)?.name ?? 'Global'}</PickerChip>
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
      trigger={() => (icon ? <IconButton icon={icon} label="More actions" glyph={16} /> : <IconButton icon={ICONS.ellipsis} label="More actions" />)}
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
