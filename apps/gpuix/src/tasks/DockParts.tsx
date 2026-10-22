// The small controls in a run composer's tray (`views/tasks/DockButtons.tsx`, `TaskRunDock.tsx`): text buttons, the Hide chevron
// with its tooltip, the task's context chip, and the run's state line.
import type { TaskItem, TaskRun } from '../../../../packages/kybern-client/src/types.ts'
import { Button } from '../kit/Button.tsx'
import { IconButton } from '../kit/IconButton.tsx'
import { PickerChip } from '../kit/PickerChip.tsx'
import { Tip } from '../nav/overlay.tsx'
import { openTask } from './store.ts'

/** `TrayButton`: a small ghost button in the run composer's tray, with a tooltip when it needs one. */
export function TrayButton({ label, tip, onClick, testId }: { label: string; tip?: string; onClick: () => void; testId?: string }) {
  const button = (
    <div style={{ display: 'flex', flexShrink: 0 }}>
      <Button testId={testId} variant="ghost" size="sm" onClick={onClick}>{label}</Button>
    </div>
  )
  return tip ? <Tip label={tip}>{button}</Tip> : button
}

/** `HideButton`: a chevron that tucks the composer away; Esc does the same and the draft stays. */
export function TrayHide({ onClick, testId }: { onClick: () => void; testId?: string }) {
  return (
    <Tip label="Hide (Esc). Your draft stays.">
      <div style={{ display: 'flex', flexShrink: 0 }}>
        <IconButton testId={testId} icon="chevronDown" label="Hide" glyph={14} onClick={onClick} />
      </div>
    </Tip>
  )
}

/** The task the message is about, as a chip that opens it. */
export function ContextChip({ task }: { task: TaskItem }) {
  return <PickerChip testId={`task-run-reference-${task.id}`} chevron={false} truncate maxWidth={220} onClick={() => openTask(task.id)}>{`${task.key} · ${task.title}`}</PickerChip>
}

export function runState(run: TaskRun, task: TaskItem): string {
  if (run.state === 'waiting') return 'Waiting for you'
  if (run.state === 'running') return 'Working'
  return task.status === 'needs_review' ? 'Needs review' : 'Finished'
}
