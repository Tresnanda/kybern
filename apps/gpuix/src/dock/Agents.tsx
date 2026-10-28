import { pinChildThread } from '../tabs/Body.tsx'
import { getState } from '../state.ts'
import { onEnvironmentChange } from '../shell/environment.ts'
// The Agents pane retains completed children (unlike the sidebar's temporary
// ChildRow). Tree ordering, phases, result clamps and workspace copy are shared.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { getNav, setNav, useNav } from '../nav/store.ts'
import { useDock } from './store.ts'
import { Chevron } from '../sidebar/rows.tsx'
import { Collapse, Rise, SwapOnChange } from '../motion/kit.tsx'
import { Elapsed } from '../subagents/Elapsed.tsx'
import { ownProjectId, threadClient } from '../state.ts'
import { cachedMarkdownTheme } from '../transcript/kit.tsx'
import { ink, Label, modelLabel, ProviderMark, useTheme } from '../ui.tsx'
import { DockEmpty, ErrorLine, Section } from './parts.tsx'
import { Button } from '../kit/Button.tsx'
import { IconButton } from '../kit/IconButton.tsx'
import { flatTree, TICK_GAP, TreeLines, type TreeShape } from '../tree/Tree.tsx'
import { osLabels } from '../platform/os.ts'

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
  const dockKeyboard = useNav((s) => s.keyboardNav)
  const dockInstant = useDock(thread.id).instant || dockKeyboard

  useEffect(() => {
    const client = threadClient(thread.id)
    if (!client) return
    let current = true
    let seeded = false
    const pending: ThreadEvent[] = []
    const fold = (previous: Thread[], event: ThreadEvent) => {
      if (event.kind === 'thread_archived') return previous.filter((th) => th.id !== event.thread_id)
      if (event.kind !== 'thread_created' && event.kind !== 'thread_updated') return previous
      const th = event.thread
      if (th.project_id !== ownProjectId(thread)) return previous
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
    void client.call('threads.list', { project_id: ownProjectId(thread), include_subagents: true }).then((result) => {
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
  }, [thread.id, ownProjectId(thread), reload])

  const rows = useMemo(() => lineageRows(threads, thread.id, { expanded: tree }), [threads, thread.id, tree])
  const connectors = useMemo(() => flatTree(rows.map((row) => row.depth)), [rows])
  // `t-row-enter`: a row that appears after the list first showed (a new child, or children revealed by expanding) rises in; the
  // rows of the first load and of a thread switch render plainly. `fresh` keeps a row's flag for its whole life, so it never replays.
  const seen = useRef(new Set<string>())
  const fresh = useRef(new Set<string>())
  const seeded = useRef(false)
  for (const row of rows) {
    if (seen.current.has(row.thread.id)) continue
    seen.current.add(row.thread.id)
    if (seeded.current) fresh.current.add(row.thread.id)
  }
  if (loaded) seeded.current = true
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
    {!rows.length ? loaded && !error ? <DockEmpty lineage instant={dockInstant} icon={N.users} title="No agents yet" body="Ask the agent to delegate work to another agent; children appear here." /> : null : <>
      <Section label={lineageSummary(counts) || `${counts.total} ${counts.total === 1 ? 'agent' : 'agents'}`}>
        {stoppable.length >= 2 && <Button variant="ghost" size="sm" danger disabled={busy} onClick={() => void run(() => Promise.all(stoppable.map((th) => threadClient(thread.id)!.call('threads.interrupt', { thread_id: th.id }))))}>Stop all</Button>}
      </Section>
      <div {...FILL_ISLAND} style={{ display: 'flex', flexGrow: 1, minHeight: 0 }}>
        <virtual-list testId="dock-agents-list" style={{ width: '100%', height: '100%' }}>
          {rows.map((row, i) => <AgentRow key={row.thread.id} row={row} fresh={fresh.current.has(row.thread.id)} last={connectors[i]!.last} rails={railBits(connectors[i]!.continues)} detailOpen={!!detail[row.thread.id]} owner={thread.id} onToggleTree={toggleTree} onToggleDetail={toggleDetail} onRemove={setRemoving} />)}
        </virtual-list>
      </div>
    </>}
    {removing && <Dialog onClose={() => { if (!busy) setRemoving(null) }} width={420} testId="dock-remove-worktree">
      <DialogHeader title="Remove this worktree?" description={`${removing?.title || 'This agent'} left its worktree on disk because it has unmerged changes. Removing it deletes those files from ${osLabels().thisComputerInline}. The branch is deleted only if already merged.`} onClose={() => { if (!busy) setRemoving(null) }} />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: 12 }}>
        <Button size="lg" disabled={busy} onClick={() => setRemoving(null)}>Cancel</Button>
        <Button size="lg" variant="destructive" busy={busy} onClick={() => void run(async () => { if (removing) await threadClient(thread.id)!.call('delegations.worktree_remove', { thread_id: removing.id, force: true }); setRemoving(null) })}>{busy ? 'Removing…' : 'Remove worktree'}</Button>
      </div>
    </Dialog>}
  </>
}

const railBits = (continues: boolean[]) => continues.reduce((bits, on, level) => (on ? bits | (1 << level) : bits), 0)
/** Tree connectors (`../tree`): a level-L parent's stem runs under its 22px mark (x = 42 + 24·L), ticks stop 3px short of
 *  the child's mark and a child with children of its own wears its chevron on the junction. */
function agentTree(depth: number, last: boolean, rails: number, open: boolean, toggle: boolean): TreeShape {
  const stem = (level: number) => 42 + level * 24
  const outer: number[] = []
  for (let level = 0; level < depth - 1; level++) if (rails & (1 << level)) outer.push(stem(level))
  return {
    anchor: 17,
    rails: outer,
    ...(depth > 0 ? { branch: { x: stem(depth - 1), joint: toggle ? 'toggle' : 'node', last, tickEnd: 31 + depth * 24 - TICK_GAP } } : {}),
    ...(open ? { below: { x: stem(depth), from: 28 + TICK_GAP } } : {}),
  }
}

const AgentRow = memo(function AgentRow({ row, fresh, last, rails, detailOpen, owner, onToggleTree, onToggleDetail, onRemove }: {
  row: LineageRow<Thread>; fresh: boolean; last: boolean; rails: number; detailOpen: boolean; owner: string
  onToggleTree: (id: string, open: boolean) => void; onToggleDetail: (id: string) => void; onRemove: (thread: Thread) => void
}) {
  const t = useTheme()
  const { thread, childCount, depth, open } = row
  const state = childState(thread, useNav((s) => s.pending[thread.id]?.own))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [allFiles, setAllFiles] = useState(false)
  const info = thread.delegation
  const result = info?.result ?? thread.subagent?.result ?? ''
  const clamp = resultNeedsClamp(result)
  const level = Math.min(depth, 3)
  const shape = useMemo(() => agentTree(level, last, rails, open && childCount > 0, childCount > 0), [level, last, rails, open, childCount])
  // A working child ticks on the shared second clock (as the composer tray does); a settled one stops at its end.
  const working = state.phase === 'working' || state.phase === 'waiting'
  const ended = working ? null : childEndedAt(thread) ?? Date.parse(thread.updated_at)
  const role = info ? delegationRoleLabel(info.role) : thread.subagent?.agent_type || 'Helper thread'
  const stop = async () => {
    setBusy(true); setError(null)
    try {
      // Children live on their parent's machine.
      if (thread.subagent) await threadClient(owner)!.call('tasks.stop', { thread_id: thread.id })
      else await threadClient(owner)!.call('threads.interrupt', { thread_id: thread.id })
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  return <Rise kind="row" play={fresh}><div style={{ position: 'relative', paddingLeft: 6, paddingRight: 6, paddingBottom: 1 }}>
    <div style={{ display: 'flex', minHeight: 62, alignItems: 'flex-start', paddingTop: 6, paddingBottom: 6, paddingLeft: 3 + level * 24, paddingRight: 6, borderRadius: 10, hover: { backgroundColor: t.buttonSecondaryHover } }}>
      <div style={{ position: 'relative', left: level > 0 ? -2 : 0, width: 22, flexShrink: 0 }}>
        {childCount > 0 && <TreeToggle open={open} onClick={() => onToggleTree(thread.id, !open)} testId={`dock-agent-tree-${thread.id}`} />}
      </div>
      <div role="button" testId={`dock-agent-${thread.id}`} onClick={() => onToggleDetail(thread.id)} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, flexGrow: 1, minWidth: 0, cursor: 'pointer' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, flexShrink: 0, borderRadius: 6, backgroundColor: t.buttonSecondary }}><ProviderMark kind={thread.provider.kind} size={12} /></div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flexGrow: 1, minWidth: 0 }}>
          <Label color={ink(t, 0.9)} size={13} lineHeight={20} truncate>{thread.title || 'Untitled'}</Label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
            {/* The phase glyph and word cross-swap (`t-icon-swap`, `t-text-swap`) when a child finishes, fails or waits. */}
            <SwapOnChange kind="icon" active={state.phase} style={{ width: 12, height: 12, flexShrink: 0 }}>
              {state.phase === 'working' ? <MatrixLoader /> : <Icon source={state.phase === 'done' ? N.check : state.phase === 'failed' ? N.info : N.clock} size={12} color={state.phase === 'failed' ? t.red : muted(t, 0.7)} />}
            </SwapOnChange>
            <SwapOnChange active={state.word} style={{ flexGrow: 1, minWidth: 0, justifyContent: 'flex-start' }} innerStyle={{ flexGrow: 1, minWidth: 0, justifyContent: 'flex-start' }} leavingStyle={{ right: 0 }}>
              <Label color={state.phase === 'failed' ? t.red : muted(t, 0.85)} size={11} truncate>{`${state.word} · ${role}${thread.model ? ` · ${modelLabel(thread.model)}` : ''}`}</Label>
            </SwapOnChange>
          </div>
          {info && <Label color={muted(t, 0.7)} size={10} truncate>{`${workspaceLabel(info)}${info.diffstat ? ` · ${diffstatLabel(info.diffstat)}` : ''}`}</Label>}
        </div>
        <Elapsed startedAt={childStartedAt(thread)} endedAt={ended} color={muted(t, 0.6)} />
        <Chevron open={detailOpen} color={muted(t, 0.6)} size={12} />
      </div>
    </div>
    <Collapse open={detailOpen}><div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 50 + level * 24, paddingRight: 10, paddingBottom: 10 }}>
      {info?.error && <Label color={t.red} size={12}>{info.error}</Label>}
      {result ? <>
        <Label color={muted(t, 0.65)} size={11}>Result</Label>
        <markdown style={{ userSelect: 'text' }} source={clamp && !expanded ? result.split('\n').slice(0, 8).join('\n').slice(0, 720) : result} theme={cachedMarkdownTheme(t)} />
        {clamp && <Button variant="ghost" size="sm" style={{ alignSelf: 'flex-start' }} onClick={() => setExpanded(!expanded)}>{expanded ? 'Show less' : 'Show more'}</Button>}
      </> : <Label color={muted(t, 0.8)} size={12}>{state.phase === 'working' || state.phase === 'waiting' ? 'The result comes back to this thread when the agent finishes.' : 'Open the thread to see its work.'}</Label>}
      {info?.branch && <Label color={muted(t, 0.8)} size={11}>{`Branch · ${info.branch}`}</Label>}
      {info?.head_commit && <Label color={muted(t, 0.8)} size={11}>{`Commit · ${info.head_commit.slice(0, 7)}`}</Label>}
      {!!info?.owns?.length && <Label color={muted(t, 0.8)} size={11}>{`Owns · ${info.owns.join(', ')}`}</Label>}
      {!!info?.files_touched?.length && <>
        <Label color={muted(t, 0.65)} size={11}>{`Files touched · ${info.files_touched.length}`}</Label>
        <code style={{ userSelect: 'text' }} code={(allFiles ? info.files_touched : info.files_touched.slice(0, 6)).join('\n')} theme={cachedMarkdownTheme(t)} showLineNumbers={false} />
        {info.files_touched.length > 6 && <Button variant="ghost" size="sm" style={{ alignSelf: 'flex-start' }} onClick={() => setAllFiles(!allFiles)}>{allFiles ? 'Show fewer' : `Show all ${info.files_touched.length} files`}</Button>}
      </>}
      {!!info?.conflicts?.length && <Label color={t.warning} size={11}>{`${info.conflicts.length} ownership conflicts · open the thread for details`}</Label>}
      <ErrorLine error={error} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        <Button size="sm" onClick={() => openThread(thread.id)}>Open</Button>
        <Button size="sm" testId={`dock-agent-pin-${thread.id}`} onClick={() => { const host = getState().selectedId ?? thread.parent_thread_id; if (host) pinChildThread(host, thread) }}>Pin as tab</Button>
        {(canStopDelegation(thread) || (thread.subagent && state.phase === 'working' && thread.subagent.capabilities?.stop !== false)) && <Button size="sm" danger busy={busy} onClick={() => void stop()}>{busy ? 'Stopping…' : 'Stop'}</Button>}
        {canRemoveWorktree(info) && <Button size="sm" danger onClick={() => onRemove(thread)}>Remove worktree</Button>}
      </div>
    </div></Collapse>
    <TreeLines shape={shape} />
  </div></Rise>
})

/** The tree's expand toggle: a 22 px ghost button whose chevron turns with the children it reveals (`DisclosureChevron`, 220 ms). */
function TreeToggle({ open, onClick, testId }: { open: boolean; onClick: () => void; testId: string }) {
  const t = useTheme()
  return <IconButton testId={testId} icon={N.chevronDown} label={open ? 'Collapse agents' : 'Expand agents'} size="sm" onClick={onClick}>
    <Chevron open={open} size={14} color={t.iconSecondary} />
  </IconButton>
}

onEnvironmentChange(() => { choices.clear() })
