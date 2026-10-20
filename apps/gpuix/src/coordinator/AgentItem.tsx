import { memo, useEffect, useMemo, useState } from 'react'
import type { Note, TaskItem } from '../../../../packages/kybern-client/src/types.ts'
import { agentItemChangeSummary, type AgentNoteResult, type AgentTaskResult } from '../../../desktop/src/lib/agentItemTools.ts'
import { getClient, useApp } from '../state.ts'
import { Label, useTheme } from '../ui.tsx'
import { Icon } from '../icons.tsx'
import { T } from '../transcript/glyphs.ts'
import { Button, muted } from '../transcript/kit.tsx'
import { openNote } from '../notes/store.ts'
import { openTask, useTasks } from '../tasks/store.ts'
import { goPage } from '../nav/history.ts'
import { latestRun } from '@/state/tasksModel'
import { activeEnvironment } from '../shell/environment.ts'
import { reportError, useRowState } from '../transcript/store.ts'

async function readAgentItem(kind: 'note' | 'task', id: string) {
  const client = getClient()!
  return kind === 'note' ? (await client.call('notes.get', { id })).note : (await client.call('tasks.items.get', { id })).task
}
export async function openAgentItem(kind: 'note' | 'task', id: string): Promise<void> {
  if (kind === 'note') openNote(id)
  else { openTask(id); goPage('tasks') }
}
export function useThreadTasks(threadId: string): TaskItem[] {
  const tasks = useTasks(s => s.tasks)
  return useMemo(() => Object.values(tasks).filter(task => latestRun(task)?.thread_id === threadId).sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true })), [tasks, threadId])
}
const statusLabels: Record<string, string> = { inbox: 'Inbox', todo: 'To do', running: 'Running', needs_review: 'Needs review', done: 'Done', canceled: 'Canceled' }
export const AgentItemCard = memo(function AgentItemCard({ result, inset = true }: { result: AgentNoteResult | AgentTaskResult; inset?: boolean }) {
  const t = useTheme()
  const [live, setLive] = useState<Note | TaskItem | null | undefined>()
  const [undo, setUndo] = useRowState<'idle' | 'removing' | 'removed' | 'restoring'>(`agent-item:${result.kind}:${result.id}`, 'idle')
  const project = useApp(s => s.projects.find(p => p.id === (live?.project_id ?? result.projectId)))
  useEffect(() => {
    let alive = true
    const owner = activeEnvironment()
    const refresh = () => { void readAgentItem(result.kind, result.id).then(value => { if (alive && owner === activeEnvironment()) setLive(value ?? null) }).catch(() => {}) }
    refresh()
    const off = getClient()?.onNotification(result.kind === 'note' ? 'notes.changed' : 'tasks.items.changed', refresh)
    return () => { alive = false; off?.() }
  }, [result.id, result.kind])
  const removed = undo === 'removed' || undo === 'restoring'
  const gone = live === null || (live && 'deleted_at' in live && !!live.deleted_at)
  const disabled = removed || gone
  const title = live?.title || result.title || `Untitled ${result.kind}`
  const meta = removed ? 'Removed' : gone ? 'Deleted' : [result.kind === 'task' ? statusLabels[live && 'status' in live ? live.status : result.status] : '', result.kind === 'note' && result.scope === 'thread' ? 'This chat’s note' : project?.name || (result.projectId ? 'Project' : 'Global'), result.kind === 'task' && result.criteriaTotal ? `${result.criteriaDone}/${result.criteriaTotal} criteria` : '', agentItemChangeSummary(result)].filter(Boolean).join(' · ')
  const remove = async (restore: boolean) => {
    const owner = activeEnvironment()
    const client = getClient()!
    setUndo(restore ? 'restoring' : 'removing')
    try {
      if (result.kind === 'note') await client.call(restore ? 'notes.restore' : 'notes.delete', { id: result.id })
      else await client.call(restore ? 'tasks.items.restore' : 'tasks.items.delete', { id: result.id })
      if (owner !== activeEnvironment()) return
      setUndo(restore ? 'idle' : 'removed')
      if (restore) { const item = await readAgentItem(result.kind, result.id); if (owner === activeEnvironment()) setLive(item ?? null) }
    } catch (error) { if (owner !== activeEnvironment()) return; setUndo(restore ? 'removed' : 'idle'); reportError(restore ? 'Unable to restore' : 'Unable to undo', error) }
  }
  return <>
    <div testId={`agent-item-${result.id}`} style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: 52, padding: 12, paddingTop: 8, paddingBottom: 8, marginLeft: inset ? 22 : 0, marginTop: 4, marginBottom: 4, borderRadius: 10.4, borderWidth: 1, borderColor: t.borderLight, backgroundColor: t.codeSurface }}>
      <Icon source={result.kind === 'task' ? T.listChecks : T.note} size={16} color={muted(t, disabled ? .45 : .7)} />
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flexGrow: 1 }}><Label color={disabled ? muted(t) : t.text} size={13} truncate>{`${result.kind === 'task' ? `${result.key} ` : ''}${title}`}</Label><Label color={muted(t)} size={11.5} lineHeight={20} truncate>{meta}</Label></div>
      <div style={{ display: 'flex', gap: 6, minWidth: 116, justifyContent: 'flex-end' }}>
        {result.action === 'created' && !gone && !removed && <Button variant="ghost" testId={`item-undo-${result.id}`} disabled={undo === 'removing'} onClick={() => void remove(false)}>Undo</Button>}
        {removed && <Button variant="ghost" testId={`item-restore-${result.id}`} disabled={undo === 'restoring'} onClick={() => void remove(true)}>Restore</Button>}
        {!disabled && <Button variant="ghost" testId={`item-open-${result.id}`} onClick={() => { void openAgentItem(result.kind, result.id).catch(e => reportError('Unable to open item', e)) }}>Open</Button>}
      </div>
    </div>
  </>
})
