import { memo, useRef, useState } from 'react'
import { isOpenStatus, sortTasks, splitTaskBody, STATUS_LABEL } from '@/state/tasksModel'
import { isFreeChatProject, type TaskItem, type Thread } from '../../../../packages/kybern-client/src/types.ts'
import { goPage } from '../nav/history.ts'
import { openTabFromPane } from '../tabs/open.ts'
import { getFocusedPaneId } from '../state.ts'
import { N } from '../nav/glyphs.ts'
import { createTask, chooseFilter, openTask, refreshTasks, useTasks } from '../tasks/store.ts'
import { StatusGlyph, PriorityGlyph } from '../tasks/Glyphs.tsx'
import { TaskWindow, type TaskWindowEntry } from '../tasks/TaskWindow.tsx'
import { IconButton } from '../kit/IconButton.tsx'
import { Button } from '../kit/Button.tsx'
import { TextField } from '../kit/Field.tsx'
import { Label, useTheme } from '../ui.tsx'
import { toast } from '../shell/toasts.tsx'
import { DockFooter, DockSection, ScopeHeader } from './Notes.tsx'
import { DockEmpty, ErrorLine, Section } from './parts.tsx'
import { isPrimary } from '../platform/keys.ts'
/** A task opens as a tab beside the chat (ADE-54); the Tasks page is a click away from its footer. */
const open = (id: string) => { if (!openTabFromPane(getFocusedPaneId(), { kind: 'task', id })) { openTask(id); goPage('tasks') } }
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
    if (task.status !== status) { status = task.status; const label = STATUS_LABEL[task.status]; entries.push({ key: status, height: entries.length ? 36 : 28, render: () => <div style={{ paddingTop: sorted[0]?.status === task.status ? 0 : 8 }}><DockSection label={label} count={sorted.filter(t => t.status === task.status).length} /></div> }) }
    entries.push({ key: task.id, height: 29, render: () => <TaskRow task={task} /> })
  }
  if (entries.length) entries.push({ key: 'footer', height: 40, render: () => <DockFooter testId="dock-all-tasks" onClick={() => { chooseFilter(project ? `project:${project}` : 'global'); goPage('tasks') }}>{sorted.length > 50 ? `Show all ${sorted.length} in Tasks` : 'Show all in Tasks'}</DockFooter> })
  return <div testId="dock-tasks" style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0 }}>
    <ScopeHeader thread={thread} action={<IconButton icon={N.plus} size="sm" label="New task" testId="dock-new-task" onClick={() => setAdding(true)} />} />
    {own && <><Section label="This thread" /><TaskRow task={own} /><Section label={`${splitTaskBody(own.body).criteria.filter(c => c.checked).length} of ${splitTaskBody(own.body).criteria.length} done`}><Button variant="ghost" size="sm" onClick={() => open(own.id)}>Open task</Button></Section></>}
    {adding && <QuickAdd project={project} done={() => setAdding(false)} />}
    <ErrorLine error={error} retry={() => void refreshTasks()} />
    {!loaded ? <Section label="Loading tasks…" /> : entries.length ? <TaskWindow entries={entries} testId="dock-tasks-list" /> : <DockEmpty icon={N.tasks} title="No open tasks" body="Tasks for this project appear here." />}
  </div>
}
const TaskRow = memo(function TaskRow({ task }: { task: TaskItem }) {
  const t = useTheme()
  return <div testId={`dock-task-${task.id}`} role="button" tabIndex={0} onClick={() => open(task.id)} onKeyDown={e => { if (e.key === 'enter') open(task.id) }} style={{ display: 'flex', height: 28, marginLeft: 6, marginRight: 6, alignItems: 'center', gap: 8, paddingLeft: 8, paddingRight: 8, borderRadius: 6, cursor: 'pointer', hover: { backgroundColor: t.hover } }}><StatusGlyph status={task.status} /><Label color={t.textTertiary} size={13} style={{ pointerEvents: 'none' }}>{task.key}</Label><Label color={t.text} size={14} truncate style={{ flexGrow: 1, pointerEvents: 'none' }}>{task.title.trim() || 'Untitled'}</Label>{task.priority !== 0 && <PriorityGlyph priority={task.priority} />}</div>
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
  return <div style={{ display: 'flex', padding: 8, gap: 8, alignItems: 'center' }}><StatusGlyph status="inbox" /><TextField autoFocus testId="dock-task-title" label="New task title" placeholder="Task title" value={title} onChange={v => { draft.current.title = v; setTitle(v) }} onSubmit={e => void commit(isPrimary(e.modifiers) ? 'open' : 'keep')} onBlur={() => void commit('close')} onKeyDown={e => { if (e.key === 'escape') { draft.current.canceled = true; done() } }} theme={{ text: t.text, caret: t.text }} shell={{ flexGrow: 1 }} /></div>
}
