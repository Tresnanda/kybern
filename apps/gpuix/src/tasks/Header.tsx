// The Tasks title-bar row (desktop `SurfaceHeader` + `ListControls`): the current
// view's name, then the List/Board switch and Display.
import { ArrowDown01Icon, ArrowUp01Icon, KanbanIcon, LeftToRightListBulletIcon } from '@hugeicons/core-free-icons'
import { useSyncExternalStore } from 'react'
import { filterLabel } from '@/state/tasksModel'
import { glyph } from '../icons.tsx'
import { Tip } from '../nav/overlay.tsx'
import { CUSTOMIZE } from '../notes/kit.tsx'
import { Button } from '../kit/Button.tsx'
import { IconButton } from '../kit/IconButton.tsx'
import { Segmented } from '../kit/Segmented.tsx'
import { Icon } from '../icons.tsx'
import { useApp } from '../state.ts'
import { ink, Label, useTheme } from '../ui.tsx'
import { DisplayMenu } from './TasksPage.tsx'
import { latestRun } from '@/state/tasksModel'
import { MoreMenu } from './TaskMenus.tsx'
import { openTask, prefs, useTasks } from './store.ts'
import { openThread } from '../nav/history.ts'
import { ICONS } from '../icons.tsx'

// The task page hands its previous/next order to the title bar.
let detailSequence: string[] = []
const detailListeners = new Set<() => void>()
export function setDetailSequence(next: string[]) { detailSequence = next; detailListeners.forEach((l) => l()) }
const UP = glyph(ArrowUp01Icon)
const DOWN = glyph(ArrowDown01Icon)

function Crumb({ id }: { id: string }) {
  const t = useTheme()
  const sequence = useSyncExternalStore((l) => { detailListeners.add(l); return () => { detailListeners.delete(l) } }, () => detailSequence)
  const task = useTasks((s) => s.tasks[id])
  if (!task) return null
  const at = sequence.indexOf(id)
  const run = latestRun(task)
  const btn = (icon: string, label: string, onClick: () => void, disabled: boolean, testId?: string) => (
    <Tip label={label} side="bottom"><div style={{ display: 'flex', flexShrink: 0 }}><IconButton testId={testId} icon={icon} label={label} glyph={16} disabled={disabled} onClick={onClick} /></div></Tip>
  )
  return (
    <div style={{ display: 'flex', flexGrow: 1, alignItems: 'center', gap: 8, paddingRight: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Button testId="task-back" variant="ghost" size="sm" label="Tasks" onClick={() => openTask(null)} style={{ marginLeft: -8 }}>Tasks</Button>
        <Label color={ink(t, 0.22)} size={13} lineHeight={19.5}>/</Label>
        <Label color={t.text} size={13} lineHeight={19.5} weight={500}>{task.key}</Label>
      </div>
      <div style={{ flexGrow: 1 }} />
      {run && <Button variant="ghost" onClick={() => openThread(run.thread_id)}>Open run</Button>}
      {btn(UP, 'Previous task', () => openTask(sequence[at - 1]!), at <= 0, 'task-prev')}
      {btn(DOWN, 'Next task', () => openTask(sequence[at + 1]!), at < 0 || at === sequence.length - 1, 'task-next')}
      <MoreMenu task={task} sequence={sequence} icon={ICONS.ellipsis} />
    </div>
  )
}

const LIST = glyph(LeftToRightListBulletIcon)
const BOARD = glyph(KanbanIcon)

export function TasksBar() {
  const t = useTheme()
  const openId = useTasks((s) => s.openId)
  const view = useTasks((s) => s.prefs.view)
  const filter = useTasks((s) => s.prefs.filter)
  const query = useTasks((s) => s.query)
  const projects = useApp((s) => s.projects)
  if (openId) return <Crumb id={openId} />
  return (
    <div style={{ display: 'flex', flexGrow: 1, alignItems: 'center', gap: 8, paddingRight: 8 }}>
      <Label color={t.text} size={13} lineHeight={19.5} weight={500} truncate>{query.trim() ? 'Search' : filterLabel(filter, (id) => projects.find((p) => p.id === id)?.name)}</Label>
      <div style={{ flexGrow: 1 }} />
      <Segmented testId="task-view" aria-label="View" value={view} onChange={(value) => prefs({ view: value as 'list' | 'board' })} options={[{ value: 'list', label: 'List', icon: LIST }, { value: 'board', label: 'Board', icon: BOARD }]} />
      <DisplayMenu trigger={() => <Button icon={CUSTOMIZE} chevron label="Display">Display</Button>} />
    </div>
  )
}
