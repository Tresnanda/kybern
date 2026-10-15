// The Agents pane retains completed children (unlike the sidebar's temporary
// ChildRow). Tree ordering, phases, result clamps and workspace copy are shared.
import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import {
  canRemoveWorktree, canStopDelegation, childState, childStartedAt, childEndedAt,
  delegationRoleLabel, diffstatLabel, lineageCounts, lineageRows, lineageSummary,
  resultNeedsClamp, stoppableDescendants, workspaceLabel, type LineageRow,
} from '../../../../packages/kybern-client/src/delegations.ts'
import type { Thread, ThreadEvent } from '../../../../packages/kybern-client/src/types.ts'
import { Icon } from '../icons.tsx'
import { FILL_ISLAND, MatrixLoader } from '../MatrixLoader.tsx'
import { errorText } from '../nav/actions.ts'
import { N } from '../nav/glyphs.ts'
import { openThread } from '../nav/history.ts'
import { Dialog, DialogHeader, muted } from '../nav/overlay.tsx'
import { getNav, setNav } from '../nav/store.ts'
import { Chevron, IconButton } from '../sidebar/rows.tsx'
import { getClient } from '../state.ts'
import { cachedMarkdownTheme } from '../transcript/kit.tsx'
import { clockDuration, ink, Label, modelLabel, ProviderMark, useTheme } from '../ui.tsx'
import { Action, DockEmpty, ErrorLine, Section } from './parts.tsx'

const choices = new Map<string, { tree: Record<string, boolean>; detail: Record<string, boolean> }>()
function initialChoices(id: string) {
  if (!choices.has(id)) {
    if (choices.size >= 40) choices.delete(choices.keys().next().value!)
    choices.set(id, { tree: {}, detail: {} })
  }
  return choices.get(id)!
}

export function Agents({ thread }: { thread: Thread }) {
  const [threads, setThreads] = useState<Thread[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [tree, setTree] = useState(() => initialChoices(thread.id).tree)
  const [detail, setDetail] = useState(() => initialChoices(thread.id).detail)
  const [removing, setRemoving] = useState<Thread | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const client = getClient()
    if (!client) return
    let current = true
    let seeded = false
    const pending: ThreadEvent[] = []
    const fold = (previous: Thread[], event: ThreadEvent) => {
      if (event.kind === 'thread_archived') return previous.filter((th) => th.id !== event.thread_id)
      if (event.kind !== 'thread_created' && event.kind !== 'thread_updated') return previous
      const th = event.thread
      if (th.project_id !== thread.project_id) return previous
      const old = previous.find((item) => item.id === th.id)
      if (old && old.last_seq > th.last_seq) return previous
      if (th.status === 'archived') return previous.filter((item) => item.id !== th.id)
      return old ? previous.map((item) => item.id === th.id ? th : item) : [...previous, th]
    }
    const subscription = client.subscribeEvents({ include_tool_output: false }, (event) => {
      if (!current || !['thread_created', 'thread_updated', 'thread_archived'].includes(event.kind)) return
      if (!seeded) pending.push(event)
      else setThreads((previous) => fold(previous, event))
    })
    setError(null)
    void client.call('threads.list', { project_id: thread.project_id, include_subagents: true }).then((result) => {
      if (!current) return
      const merged = pending.reduce(fold, result.threads)
      setThreads(merged)
      // Reuse navigation's child cache so Open and breadcrumbs resolve immediately.
      const children = { ...getNav().children }
      for (const child of merged) {
        if (child.parent_thread_id && (!children[child.id] || children[child.id]!.last_seq <= child.last_seq)) children[child.id] = child
      }
      setNav({ children })
      seeded = true
      setLoaded(true)
    }, (e) => { if (current) { setError(errorText(e)); setLoaded(true) } })
    return () => { current = false; subscription.unsubscribe() }
  }, [thread.id, thread.project_id, reload])

  const rows = useMemo(() => lineageRows(threads, thread.id, { expanded: tree }), [threads, thread.id, tree])
  const counts = useMemo(() => lineageCounts(threads, thread.id), [threads, thread.id])
  const stoppable = useMemo(() => stoppableDescendants(lineageRows(threads, thread.id, { expanded: Object.fromEntries(threads.map((th) => [th.id, true])) })), [threads, thread.id])
  const toggleTree = useCallback((id: string, open: boolean) => setTree((previous) => {
    const next = { ...previous, [id]: open }; initialChoices(thread.id).tree = next; return next
  }), [thread.id])
  const toggleDetail = useCallback((id: string) => setDetail((previous) => {
    const next = { ...previous, [id]: !previous[id] }; initialChoices(thread.id).detail = next; return next
  }), [thread.id])
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true); setError(null)
    try { await work() } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }

  return <>
    <ErrorLine error={error} retry={() => setReload((n) => n + 1)} />
    {!rows.length ? loaded && !error ? <DockEmpty icon={N.users} title="No agents yet" body="Ask the agent to delegate work to another agent; children appear here." /> : null : <>
      <Section label={lineageSummary(counts) || `${counts.total} ${counts.total === 1 ? 'agent' : 'agents'}`}>
        {stoppable.length >= 2 && <Action disabled={busy} onClick={() => void run(() => Promise.all(stoppable.map((th) => getClient()!.call('threads.interrupt', { thread_id: th.id }))))}>Stop all</Action>}
      </Section>
      <div {...FILL_ISLAND} style={{ display: 'flex', flexGrow: 1, minHeight: 0 }}>
        <virtual-list testId="dock-agents-list" style={{ width: '100%', height: '100%' }}>
          {rows.map((row) => <AgentRow key={row.thread.id} row={row} detailOpen={!!detail[row.thread.id]} onToggleTree={toggleTree} onToggleDetail={toggleDetail} onRemove={setRemoving} />)}
        </virtual-list>
      </div>
    </>}
    {removing && <Dialog onClose={() => { if (!busy) setRemoving(null) }} width={420} testId="dock-remove-worktree">
      <DialogHeader title="Remove this worktree?" description={`${removing?.title || 'This agent'} left its worktree on disk because it has unmerged changes. Removing it deletes those files from this Mac. The branch is deleted only if already merged.`} onClose={() => { if (!busy) setRemoving(null) }} />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: 12 }}>
        <Action disabled={busy} onClick={() => setRemoving(null)}>Cancel</Action>
        <Action disabled={busy} onClick={() => void run(async () => { if (removing) await getClient()!.call('delegations.worktree_remove', { thread_id: removing.id, force: true }); setRemoving(null) })}>{busy ? 'Removing…' : 'Remove worktree'}</Action>
      </div>
    </Dialog>}
  </>
}

const AgentRow = memo(function AgentRow({ row, detailOpen, onToggleTree, onToggleDetail, onRemove }: {
  row: LineageRow<Thread>; detailOpen: boolean
  onToggleTree: (id: string, open: boolean) => void; onToggleDetail: (id: string) => void; onRemove: (thread: Thread) => void
}) {
  const t = useTheme()
  const { thread, childCount, depth, open } = row
  const state = childState(thread)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [allFiles, setAllFiles] = useState(false)
  const info = thread.delegation
  const result = info?.result ?? thread.subagent?.result ?? ''
  const clamp = resultNeedsClamp(result)
  const level = Math.min(depth, 3)
  const ended = childEndedAt(thread)
  // Progress events refresh this elapsed time; no separate idle clock.
  const elapsed = clockDuration((ended ?? Date.parse(thread.updated_at)) - childStartedAt(thread))
  const role = info ? delegationRoleLabel(info.role) : thread.subagent?.agent_type || 'Helper thread'
  const stop = async () => {
    setBusy(true); setError(null)
    try {
      if (thread.subagent) await getClient()!.call('tasks.stop', { thread_id: thread.id })
      else await getClient()!.call('threads.interrupt', { thread_id: thread.id })
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  return <div style={{ paddingLeft: 6, paddingRight: 6, paddingBottom: 1 }}>
    <div style={{ display: 'flex', minHeight: 62, alignItems: 'flex-start', paddingTop: 6, paddingBottom: 6, paddingLeft: 3 + level * 14, paddingRight: 6, borderRadius: 10, hover: { backgroundColor: t.buttonSecondaryHover } }}>
      <div style={{ width: 22, flexShrink: 0 }}>
        {childCount > 0 && <IconButton icon={open ? N.chevronDown : N.chevronRight} size={22} label={open ? 'Collapse agents' : 'Expand agents'} onClick={() => onToggleTree(thread.id, !open)} testId={`dock-agent-tree-${thread.id}`} />}
      </div>
      <div role="button" testId={`dock-agent-${thread.id}`} onClick={() => onToggleDetail(thread.id)} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, flexGrow: 1, minWidth: 0, cursor: 'pointer' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: 6, backgroundColor: t.buttonSecondary }}><ProviderMark kind={thread.provider.kind} size={12} /></div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flexGrow: 1, minWidth: 0 }}>
          <Label color={ink(t, 0.9)} size={13} lineHeight={20} truncate>{thread.title || 'Untitled'}</Label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
            {state.phase === 'working' ? <MatrixLoader /> : <Icon source={state.phase === 'done' ? N.check : state.phase === 'failed' ? N.info : N.clock} size={12} color={state.phase === 'failed' ? t.red : muted(t, 0.7)} />}
            <Label color={state.phase === 'failed' ? t.red : muted(t, 0.85)} size={11} truncate>{`${state.word} · ${role}${thread.model ? ` · ${modelLabel(thread.model)}` : ''}`}</Label>
          </div>
          {info && <Label color={muted(t, 0.7)} size={10} truncate>{`${workspaceLabel(info)}${info.diffstat ? ` · ${diffstatLabel(info.diffstat)}` : ''}`}</Label>}
        </div>
        <Label color={muted(t, 0.6)} size={11}>{elapsed}</Label>
        <Chevron open={detailOpen} color={muted(t, 0.6)} size={12} />
      </div>
    </div>
    {detailOpen && <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 50 + level * 14, paddingRight: 10, paddingBottom: 10 }}>
      {info?.error && <Label color={t.red} size={12}>{info.error}</Label>}
      {result ? <>
        <Label color={muted(t, 0.65)} size={11}>Result</Label>
        <markdown source={clamp && !expanded ? result.split('\n').slice(0, 8).join('\n').slice(0, 720) : result} theme={cachedMarkdownTheme(t)} />
        {clamp && <Action onClick={() => setExpanded(!expanded)}>{expanded ? 'Show less' : 'Show more'}</Action>}
      </> : <Label color={muted(t, 0.8)} size={12}>{state.phase === 'working' || state.phase === 'waiting' ? 'The result comes back to this thread when the agent finishes.' : 'Open the thread to see its work.'}</Label>}
      {info?.branch && <Label color={muted(t, 0.8)} size={11}>{`Branch · ${info.branch}`}</Label>}
      {info?.head_commit && <Label color={muted(t, 0.8)} size={11}>{`Commit · ${info.head_commit.slice(0, 7)}`}</Label>}
      {!!info?.owns?.length && <Label color={muted(t, 0.8)} size={11}>{`Owns · ${info.owns.join(', ')}`}</Label>}
      {!!info?.files_touched?.length && <>
        <Label color={muted(t, 0.65)} size={11}>{`Files touched · ${info.files_touched.length}`}</Label>
        <code code={(allFiles ? info.files_touched : info.files_touched.slice(0, 6)).join('\n')} theme={cachedMarkdownTheme(t)} showLineNumbers={false} />
        {info.files_touched.length > 6 && <Action onClick={() => setAllFiles(!allFiles)}>{allFiles ? 'Show fewer' : `Show all ${info.files_touched.length} files`}</Action>}
      </>}
      {!!info?.conflicts?.length && <Label color={t.warning} size={11}>{`${info.conflicts.length} ownership conflicts · open the thread for details`}</Label>}
      <ErrorLine error={error} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        <Action onClick={() => openThread(thread.id)}>Open</Action>
        {(canStopDelegation(thread) || (thread.subagent && state.phase === 'working' && thread.subagent.capabilities?.stop !== false)) && <Action disabled={busy} onClick={() => void stop()}>{busy ? 'Stopping…' : 'Stop'}</Action>}
        {canRemoveWorktree(info) && <Action onClick={() => onRemove(thread)}>Remove worktree</Action>}
      </div>
    </div>}
  </div>
})
