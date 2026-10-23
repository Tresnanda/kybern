// The batch composer's two tray chips, in the Draft tray's chip style (`PickerChip bare`, menus open upward 8px from the chip):
// the tasks the run covers, with a remove control per task, and how the run goes ("Separate runs" or "One run").
import type { TaskBatchMode, TaskItem } from '../../../../packages/kybern-client/src/types.ts'
import { CheckMark, muted, PickerItem, PickerLabel, PickerMenu } from '../composer/Menu.tsx'
import { IconButton } from '../kit/IconButton.tsx'
import { PickerChip } from '../kit/PickerChip.tsx'
import { N } from '../nav/glyphs.ts'
import { Label, useTheme } from '../ui.tsx'

/** Rows past this scroll inside the menu. */
const MENU_MAX_HEIGHT = 264

/** "4 tasks": opens the list of tasks in the run. Removing the last one calls `onRemove` like any other (the owner closes the composer). */
export function TasksChip({ tasks, onRemove }: { tasks: TaskItem[]; onRemove: (id: string) => void }) {
  const t = useTheme()
  return (
    <PickerMenu
      testId="task-batch-tasks"
      side="top"
      align="start"
      sideOffset={8}
      width={320}
      trigger={(open) => <PickerChip bare icon={N.tasks} open={open}>{`${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}`}</PickerChip>}
    >
      <PickerLabel>Tasks in this run</PickerLabel>
      <div style={{ display: 'flex', flexDirection: 'column', maxHeight: MENU_MAX_HEIGHT, overflowY: 'scroll' }}>
        {tasks.map((task) => (
          <PickerItem key={task.id} id={task.id} testId={`task-batch-task-${task.id}`} keepOpen onSelect={() => {}} style={{ paddingRight: 2 }}>
            <Label color={muted(t, 0.6)} size={12} style={{ flexShrink: 0, width: 52 }} truncate>{task.key}</Label>
            <Label color={t.text} truncate style={{ flexGrow: 1 }}>{task.title || 'Untitled task'}</Label>
            <IconButton testId={`task-batch-remove-${task.id}`} size="sm" icon={N.x} glyph={12} label={`Remove ${task.key} from this run`} onClick={() => onRemove(task.id)} />
          </PickerItem>
        ))}
      </div>
    </PickerMenu>
  )
}

const MODES: { value: TaskBatchMode; label: string; hint: string }[] = [
  { value: 'separate', label: 'Separate runs', hint: 'One agent per task' },
  { value: 'combined', label: 'One run', hint: 'One agent for all tasks' },
]

/** Replaces the Separate runs / One run switch above the tray. */
export function BatchModeChip({ value, onChange }: { value: TaskBatchMode; onChange: (value: TaskBatchMode) => void }) {
  const t = useTheme()
  const current = MODES.find((mode) => mode.value === value)!
  return (
    <PickerMenu
      testId="task-batch-mode"
      side="top"
      align="start"
      sideOffset={8}
      width={256}
      trigger={(open) => <PickerChip bare open={open} label="Run tasks">{current.label}</PickerChip>}
    >
      <PickerLabel>Run tasks as</PickerLabel>
      {MODES.map((mode) => (
        <PickerItem key={mode.value} id={mode.value} testId={`task-batch-mode-${mode.value}`} onSelect={() => onChange(mode.value)}>
          <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0, paddingTop: 3, paddingBottom: 3 }}>
            <Label color={t.text} truncate>{mode.label}</Label>
            <Label color={muted(t, 0.7)} size={12} lineHeight={16} truncate>{mode.hint}</Label>
          </div>
          <CheckMark color={t.text} visible={value === mode.value} />
        </PickerItem>
      ))}
    </PickerMenu>
  )
}
