// The Tasks title-bar row (desktop `SurfaceHeader` + `ListControls`): the current
// view's name, then the List/Board switch and Display.
import { ArrowDown01Icon, ArrowUp01Icon, KanbanIcon, LeftToRightListBulletIcon } from '@hugeicons/core-free-icons'
import { useSyncExternalStore } from 'react'
import { filterLabel } from '@/state/tasksModel'
import { glyph } from '../icons.tsx'
import { Tip } from '../nav/overlay.tsx'
import { CUSTOMIZE } from '../notes/kit.tsx'
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
    <Tip label={label} side="bottom"><div testId={testId} aria-label={label} onClick={disabled ? undefined : onClick} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 7, opacity: disabled ? 0.4 : 1, cursor: 'pointer', hover: disabled ? {} : { backgroundColor: ink(t, 0.05) } }}><Icon source={icon} size={16} color={ink(t, 0.6)} /></div></Tip>
  )
  return (
    <div style={{ display: 'flex', flexGrow: 1, alignItems: 'center', gap: 8, paddingRight: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div testId="task-back" onClick={() => openTask(null)} style={{ cursor: 'pointer' }}><Label color={ink(t, 0.4)} size={13} lineHeight={19.5}>Tasks</Label></div>
        <Label color={ink(t, 0.22)} size={13} lineHeight={19.5}>/</Label>
        <Label color={t.text} size={13} lineHeight={19.5} weight={500}>{task.key}</Label>
      </div>
      <div style={{ flexGrow: 1 }} />
      {run && <div onClick={() => openThread(run.thread_id)} style={{ cursor: 'pointer', paddingLeft: 8, paddingRight: 8 }}><Label color={ink(t, 0.6)} size={13}>Open run</Label></div>}
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
  const dark = t.variant === 'dark'
  const seg = (value: 'list' | 'board', icon: string, label: string) => {
    const on = view === value
    return (
      <Tip label={label} side="bottom" size={24}>
        <div testId={`task-view-${value}`} aria-label={label} aria-pressed={on} onClick={() => prefs({ view: value })} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 24, borderRadius: 6, cursor: 'pointer', backgroundColor: on ? (dark ? ink(t, 0.075) : '#ffffff') : undefined, ...(on && !dark ? { boxShadow: { offsetX: 0, offsetY: 1, blurRadius: 2, spreadRadius: 0, color: 'rgba(0, 0, 0, 0.08)' } } : {}) }}>
          <Icon source={icon} size={15} color={on ? t.text : ink(t, 0.4)} />
        </div>
      </Tip>
    )
  }
  return (
    <div style={{ display: 'flex', flexGrow: 1, alignItems: 'center', gap: 8, paddingRight: 8 }}>
      <Label color={t.text} size={13} lineHeight={19.5} weight={500} truncate>{query.trim() ? 'Search' : filterLabel(filter, (id) => projects.find((p) => p.id === id)?.name)}</Label>
      <div style={{ flexGrow: 1 }} />
      <div style={{ display: 'flex', gap: 2, padding: 2, borderRadius: 8, backgroundColor: ink(t, dark ? 0.05 : 0.04) }}>
        {seg('list', LIST, 'List')}
        {seg('board', BOARD, 'Board')}
      </div>
      <DisplayMenu trigger={() => <div style={{ display: 'flex', alignItems: 'center', gap: 6, height: 28, width: 81, paddingLeft: 8, paddingRight: 8, borderRadius: 7, cursor: 'pointer', hover: { backgroundColor: ink(t, 0.05) } }}><Icon source={CUSTOMIZE} size={15} color={ink(t, 0.6)} /><Label color={ink(t, 0.6)} size={13} lineHeight={19.5}>Display</Label></div>} />
    </div>
  )
}
