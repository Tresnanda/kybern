import { memo, useRef, useState } from 'react'
import { isOpenStatus, sortTasks, splitTaskBody, STATUS_LABEL } from '@/state/tasksModel'
import { isFreeChatProject, type TaskItem, type Thread } from '../../../../packages/kybern-client/src/types.ts'
import { goPage } from '../nav/history.ts'
import { N } from '../nav/glyphs.ts'
import { createTask, chooseFilter, openTask, refreshTasks, useTasks } from '../tasks/store.ts'
import { StatusGlyph, PriorityGlyph } from '../tasks/Glyphs.tsx'
import { TaskWindow, type TaskWindowEntry } from '../tasks/TaskWindow.tsx'
import { IconButton } from '../sidebar/rows.tsx'
import { Label, useTheme } from '../ui.tsx'
import { toast } from '../shell/toasts.tsx'
import { ScopeHeader } from './Notes.tsx'
import { Action, DockEmpty, ErrorLine, Section } from './parts.tsx'
const open = (id: string) => { openTask(id); goPage('tasks') }
export function TasksPane({ thread }: { thread: Thread }) {
  const tasks = useTasks(s => s.tasks)
  const loaded = useTasks(s => s.loaded)
  const error = useTasks(s => s.error)
  const [adding, setAdding] = useState(false)
  const project = isFreeChatProject(thread.project_id) ? null : thread.project_id
  const own = Object.values(tasks).find(task => task.runs.some(run => run.thread_id === thread.id))
  const sorted = sortTasks(Object.values(tasks).filter(task => isOpenStatus(task.status) && (project ? task.scope === 'project' && task.project_id === project : task.scope === 'global')), 'manual', false)
  const entries: TaskWindowEntry[] = []
  let status = ''
  for (const task of sorted.slice(0, 50)) {
    if (task.status !== status) { status = task.status; const label = STATUS_LABEL[task.status]; entries.push({ key: status, height: 32, render: () => <Section label={label} /> }) }
    entries.push({ key: task.id, height: 30, render: () => <TaskRow task={task} /> })
  }
  return <div testId="dock-tasks" style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0 }}>
    <ScopeHeader thread={thread} action={<IconButton icon={N.plus} label="New task" testId="dock-new-task" onClick={() => setAdding(true)} />} />
    {own && <><Section label="This thread" /><TaskRow task={own} /><Section label={`${splitTaskBody(own.body).criteria.filter(c => c.checked).length} of ${splitTaskBody(own.body).criteria.length} done`}><Action onClick={() => open(own.id)}>Open task</Action></Section></>}
    {adding && <QuickAdd project={project} done={() => setAdding(false)} />}
    <ErrorLine error={error} retry={() => void refreshTasks()} />
    {!loaded ? <Section label="Loading tasks…" /> : entries.length ? <TaskWindow entries={entries} testId="dock-tasks-list" /> : <DockEmpty icon={N.tasks} title="No open tasks" body="Tasks for this project appear here." />}
    <Action testId="dock-all-tasks" onClick={() => { chooseFilter(project ? `project:${project}` : 'global'); goPage('tasks') }}>{sorted.length > 50 ? `Show all ${sorted.length} in Tasks` : 'Show all in Tasks'}</Action>
  </div>
}
const TaskRow = memo(function TaskRow({ task }: { task: TaskItem }) {
  const t = useTheme()
  return <div testId={`dock-task-${task.id}`} role="button" tabIndex={0} onClick={() => open(task.id)} onKeyDown={e => { if (e.key === 'enter') open(task.id) }} style={{ display: 'flex', height: 30, alignItems: 'center', gap: 8, paddingLeft: 14, paddingRight: 14, borderRadius: 6, cursor: 'pointer', hover: { backgroundColor: t.hover } }}><StatusGlyph status={task.status} /><Label color={t.textTertiary} size={11} style={{ pointerEvents: 'none' }}>{task.key}</Label><Label color={t.text} size={12} truncate style={{ flexGrow: 1, pointerEvents: 'none' }}>{task.title.trim() || 'Untitled'}</Label>{task.priority !== 0 && <PriorityGlyph priority={task.priority} />}</div>
})
function QuickAdd({ project, done }: { project: string | null; done: () => void }) {
  const t = useTheme()
  const [title, setTitle] = useState('')
  const draft = useRef({ title: '', busy: false, canceled: false })
  const commit = async (after: 'keep' | 'close' | 'open') => {
    const value = draft.current.title.trim()
    if (draft.current.canceled || draft.current.busy) return
    if (!value) { if (after !== 'keep') done(); return }
    draft.current.busy = true; draft.current.title = ''; setTitle('')
    try { const task = await createTask({ scope: project ? 'project' : 'global', project_id: project, title: value, status: 'inbox' }); if (after === 'open') open(task.id); if (after !== 'keep') done() }
    catch (error) { draft.current.title ||= value; setTitle(draft.current.title); toast.error('Unable to add the task', { description: String(error) }) }
    finally { draft.current.busy = false }
  }
  return <div style={{ display: 'flex', padding: 8, gap: 8, alignItems: 'center' }}><StatusGlyph status="inbox" /><input autoFocus testId="dock-task-title" aria-label="New task title" placeholder="Task title" value={title} onChange={e => { draft.current.title = e.value ?? ''; setTitle(draft.current.title) }} onSubmit={e => void commit(e.modifiers?.cmd ? 'open' : 'keep')} onBlur={() => void commit('close')} onKeyDown={e => { if (e.key === 'escape') { draft.current.canceled = true; done() } }} theme={{ text: t.text, caret: t.text }} style={{ flexGrow: 1, minWidth: 0, height: 30, fontSize: 12, color: t.text, backgroundColor: t.buttonSecondary }} /></div>
}
