import type { Thread } from '../../../../packages/kybern-client/src/types.ts'
import { coordinatorEditsEnforced, COORDINATOR_EDITS_NOT_BLOCKED_HINT } from '../../../../packages/kybern-client/src/coordinator.ts'
import { Label, useTheme } from '../ui.tsx'
import { Button } from '../kit/Button.tsx'
import { Tip } from '../nav/overlay.tsx'
import { PickerItem, PickerMenu } from '../composer/Menu.tsx'
import { openAgentItem, useThreadTasks } from './AgentItem.tsx'
import { reportError } from '../transcript/store.ts'
import { providerLabel } from '../sidebar/model.ts'
export function ThreadContextChips({ thread }: { thread: Thread }) {
  const t = useTheme(), tasks = useThreadTasks(thread.id)
  const open = (id: string) => { void openAgentItem('task', id).catch(e => reportError('Unable to open task', e)) }
  return <>
    {thread.coordinator_project_id && !coordinatorEditsEnforced(thread.provider.kind) && <Tip label={COORDINATOR_EDITS_NOT_BLOCKED_HINT} side="bottom"><div style={{ borderRadius: 6, paddingLeft: 6, paddingRight: 6, paddingTop: 3, paddingBottom: 3, backgroundColor: t.buttonSecondary }}><Label color={t.v('--warning')} size={10}>{`Edits not blocked on ${providerLabel(thread.provider.kind)}`}</Label></div></Tip>}
    {tasks.length === 1 && <Tip label={tasks[0]!.title} side="bottom"><Button variant="ghost" size="sm" testId="thread-task-chip" onClick={() => open(tasks[0]!.id)}>{tasks[0]!.key}</Button></Tip>}
    {tasks.length > 1 && <PickerMenu trigger={() => <Button variant="ghost" size="sm" chevron testId="thread-task-chip">{`${tasks[0]!.key} +${tasks.length - 1}`}</Button>}>{tasks.map(task => <PickerItem id={task.id} key={task.id} onSelect={() => open(task.id)}><Label color={t.text} size={12}>{`${task.key} · ${task.title}`}</Label></PickerItem>)}</PickerMenu>}
  </>
}
