import { memo, useEffect, useState } from 'react'
import type { RuntimeTask, Thread } from '../../../../packages/kybern-client/src/types.ts'
import { findSubagentFor } from '../../../../packages/kybern-client/src/subagents.ts'
import { FILL_ISLAND } from '../MatrixLoader.tsx'
import { errorText } from '../nav/actions.ts'
import { N } from '../nav/glyphs.ts'
import { useNav } from '../nav/store.ts'
import { getClient, onOpenEvent } from '../state.ts'
import { RuntimeTaskRow } from '../transcript/rows.tsx'
import { clockDuration, Label, useTheme } from '../ui.tsx'
import { Action, DockEmpty, ErrorLine, Section } from './parts.tsx'

export const isActiveTask = (task: RuntimeTask) => ['pending', 'running', 'waiting', 'stopping'].includes(task.status)
export function useRuntimeTasks(threadId: string) {
  const [tasks, setTasks] = useState<RuntimeTask[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    const client = getClient()
    if (!client) return
    let current = true
    const updates = new Map<string, RuntimeTask>()
    const unsubscribe = onOpenEvent((event) => {
      if (event.thread_id !== threadId || (event.kind !== 'runtime_task_started' && event.kind !== 'runtime_task_updated' && event.kind !== 'runtime_task_completed')) return
      updates.set(event.task.id, event.task)
      setTasks((previous) => [...previous.filter((task) => task.id !== event.task.id), event.task])
    })
    setError(null)
    void client.call('tasks.list', { thread_id: threadId, include_completed: true }).then((result) => {
      if (!current) return
      const merged = new Map(result.tasks.map((task) => [task.id, task]))
      for (const [id, task] of updates) merged.set(id, task)
      setTasks([...merged.values()]); setLoaded(true)
    }, (e) => { if (current) { setError(errorText(e)); setLoaded(true) } })
    return () => { current = false; unsubscribe() }
  }, [threadId, reload])
  return { tasks, error, loaded, retry: () => setReload((n) => n + 1) }
}

export function Activity({ tasks, error, loaded, retry }: ReturnType<typeof useRuntimeTasks>) {
  const children = useNav((s) => s.children)
  const groups = [
    { label: 'Active', tasks: tasks.filter(isActiveTask) },
    { label: 'Recent', tasks: tasks.filter((task) => !isActiveTask(task)) },
  ]
  return <>
    <ErrorLine error={error} retry={retry} />
    {tasks.length === 0 ? loaded && !error ? <DockEmpty icon={N.usage} title="No background work" body="Agents and processes started by this thread appear here." /> : null :
      <div {...FILL_ISLAND} style={{ display: 'flex', flexGrow: 1, minHeight: 0 }}>
        <virtual-list testId="dock-activity-list" style={{ width: '100%', height: '100%' }}>
          {groups.flatMap((group) => group.tasks.length ? [
            <Section key={group.label} label={`${group.label} · ${group.tasks.length} ${group.tasks.length === 1 ? 'task' : 'tasks'}`} />,
            ...group.tasks.map((task) => <Task key={task.id} task={task} thread={findSubagentFor(Object.values(children), { taskId: task.id, toolCallId: task.tool_call_id })} />),
          ] : [])}
        </virtual-list>
      </div>}
  </>
}

const Task = memo(function Task({ task, thread }: { task: RuntimeTask; thread?: Thread }) {
  const t = useTheme()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const active = isActiveTask(task)
  const elapsed = task.stats.duration_ms ?? Math.max(0, Date.parse(task.completed_at ?? task.updated_at) - Date.parse(task.started_at))
  const metrics = [clockDuration(elapsed),
    task.stats.token_count ? `${Intl.NumberFormat(undefined, { notation: 'compact' }).format(task.stats.token_count)} tokens` : '',
    task.stats.cpu_percent != null ? `${task.stats.cpu_percent.toFixed(1)}% CPU` : '',
    task.stats.rss_kb != null ? `${(task.stats.rss_kb / 1024).toFixed(1)} MB` : '',
  ].filter(Boolean).join(' · ')
  const run = async (kind: 'stop' | 'background') => {
    setBusy(true); setError(null)
    try { await getClient()!.call(kind === 'stop' ? 'tasks.stop' : 'tasks.background', { thread_id: task.thread_id, task_id: task.id }) }
    catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  return <div testId={`dock-task-${task.id}`} style={{ display: 'flex', flexDirection: 'column', paddingLeft: task.parent_id ? 22 : 8, paddingRight: 8, paddingBottom: 10 }}>
    <RuntimeTaskRow task={task} thread={thread} />
    <Label color={t.textSecondary} size={11} truncate style={{ paddingLeft: 22 }}>{task.detail || (task.last_tool_name ? `Using ${task.last_tool_name}` : task.backgrounded ? 'Running in background' : task.status)}</Label>
    <Label color={t.textTertiary} size={10} style={{ paddingLeft: 22, paddingTop: 3 }}>{metrics}</Label>
    {active && <div style={{ display: 'flex', paddingLeft: 14, gap: 4 }}>
      {task.capabilities.background && <Action disabled={busy} onClick={() => void run('background')} testId={`dock-task-background-${task.id}`}>Move to background</Action>}
      {task.capabilities.stop && <Action disabled={busy || task.status === 'stopping'} onClick={() => void run('stop')} testId={`dock-task-stop-${task.id}`}>{busy || task.status === 'stopping' ? 'Stopping…' : 'Stop'}</Action>}
    </div>}
    <ErrorLine error={error} />
  </div>
})
