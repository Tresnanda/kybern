// The small controls in a run composer's tray (`views/tasks/DockButtons.tsx`, `TaskRunDock.tsx`): text buttons, the Hide chevron
// with its tooltip, the task's context chip, and the run's state line.
import type { TaskItem, TaskRun } from '../../../../packages/kybern-client/src/types.ts'
import { FooterChip } from '../composer/chips.tsx'
import { Icon } from '../icons.tsx'
import { Tip } from '../nav/overlay.tsx'
import { Label, useTheme } from '../ui.tsx'
import { openTask } from './store.ts'

/** `TrayButton`: a 28px footer chip with a text label, and a tooltip when it needs one. */
export function TrayButton({ label, tip, onClick, testId }: { label: string; tip?: string; onClick: () => void; testId?: string }) {
  const chip = (
    <div style={{ display: 'flex', flexShrink: 0 }}>
      <FooterChip testId={testId} onClick={onClick}>
        {(color) => <Label color={color} size={13} lineHeight={18}>{label}</Label>}
      </FooterChip>
    </div>
  )
  return tip ? <Tip label={tip}>{chip}</Tip> : chip
}

/** `HideButton`: a chevron that tucks the composer away; Esc does the same and the draft stays. */
export function TrayHide({ onClick, testId }: { onClick: () => void; testId?: string }) {
  return (
    <Tip label="Hide (Esc). Your draft stays.">
      <div style={{ display: 'flex', flexShrink: 0 }}>
        <FooterChip testId={testId} paddingX={6} onClick={onClick}>
          {(color) => <Icon name="chevronDown" size={14} color={color} />}
        </FooterChip>
      </div>
    </Tip>
  )
}

/** The task the message is about, as a chip that opens it. */
export function ContextChip({ task }: { task: TaskItem }) {
  const t = useTheme()
  return (
    <div
      testId={`task-run-reference-${task.id}`}
      onClick={() => openTask(task.id)}
      style={{ display: 'flex', alignItems: 'center', maxWidth: 220, minWidth: 0, flexShrink: 1, paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4, borderRadius: 999, cursor: 'pointer', hover: { backgroundColor: t.buttonSecondaryHover } }}
    >
      <Label color={t.textSecondary} size={13} lineHeight={18} truncate>{`${task.key} · ${task.title}`}</Label>
    </div>
  )
}

export function runState(run: TaskRun, task: TaskItem): string {
  if (run.state === 'waiting') return 'Waiting for you'
  if (run.state === 'running') return 'Working'
  return task.status === 'needs_review' ? 'Needs review' : 'Finished'
}
