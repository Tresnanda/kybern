import { Icon } from '../icons.tsx'
import { problemSentence } from '../problems/sentence.ts'
import { G } from '../composer/glyphs.ts'
import { useGpuixRequired, type PublicInstance } from '@gpuix/react'
import { observeElementBounds } from '../native/layout.ts'
import { type ReactNode, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RuntimeTask, Thread, ThreadMessageRecord } from '../../../../packages/kybern-client/src/types.ts'
import { toastProblem } from '../problems/toast.ts'
import { heldHeadline, messageSenderName, plainLine, purposeLabel } from '../../../../packages/kybern-client/src/delegations.ts'
import { stripSubagents } from '../../../../packages/kybern-client/src/subagents.ts'
import { useRuntimeTasks, isActiveTask } from '../dock/Activity.tsx'
import { chooseTab, setDock } from '../dock/store.ts'
import { onLiveEvent } from '../nav/live.ts'
import { useNav } from '../nav/store.ts'
import { activeEnvironment } from '../shell/environment.ts'
import { machineOfThreadId, requireThreadClient, threadClient, useApp, type StateThread } from '../state.ts'
import { loadTarget, useComposer } from '../composer/store.ts'
import { useAccountsView } from '../accounts/store.ts'
import { accountAway, daemonSaysUnavailable } from '../accounts/limit.ts'
import { AccountAwayCard, LimitRecovery } from './AccountCards.tsx'
import { Para, muted } from '../transcript/kit.tsx'
import { Button } from '../kit/Button.tsx'
import { Collapse, Rise } from '../motion/kit.tsx'
import { reportError } from '../transcript/store.ts'
import { useTheme } from '../ui.tsx'
import { PanelEnter, PanelPresence } from './Panel.tsx'

function ActivityBody({ children, testId }: { children: ReactNode; testId?: string }) {
  const t = useTheme()
  return <div testId={testId} style={{ display: 'flex', flexDirection: 'column', padding: 8, paddingLeft: 14, paddingRight: 14, borderBottomWidth: 1, borderColor: t.borderLight, minWidth: 0 }}>{children}</div>
}
export function showDock(threadId: string, tab: 'agents' | 'activity') { chooseTab(threadId, tab); setDock(threadId, { open: true }) }
export function useRequestActivity(threadId: string | null) {
  const [held, setHeld] = useState<ThreadMessageRecord[]>([])
  const [loadedChildren, setChildren] = useState<Thread[]>([])
  const liveChildren = useNav(s => s.children)
  const thread = useApp(s => s.open.thread)
  const { tasks } = useRuntimeTasks(threadId ?? '')
  const target = useComposer(d => d.target?.threadId === threadId ? d.target.state : null)
  useEffect(() => {
    const owner = activeEnvironment()
    let client: ReturnType<typeof threadClient> = null
    try { client = threadClient(threadId) } catch { /* that machine is offline */ }
    if (!client || !threadId) return
    let alive = true, generation = 0
    const loadHeld = () => { const version = ++generation; void client.call('threads.messages.list', { thread_id: threadId, states: ['held'] }).then(r => { if (alive && owner === activeEnvironment() && version === generation) setHeld(r.messages.filter(m => m.to_thread_id === threadId)) }).catch(e => { if (alive && owner === activeEnvironment()) reportError('Unable to load held messages', e) }) }
    loadHeld()
    // Children are on their parent's machine and open there.
    const machine = machineOfThreadId(threadId)
    void client.call('threads.list', { parent_thread_id: threadId }).then(r => { if (alive && owner === activeEnvironment()) setChildren(machine ? r.threads.map(child => ({ ...child, machineId: machine })) : r.threads) }).catch(() => {})
    const update = (e: import('../../../../packages/kybern-client/src/types.ts').ThreadEvent) => {
      if (e.thread_id === threadId && e.kind.startsWith('thread_message_')) loadHeld()
      if ((e.kind === 'thread_created' || e.kind === 'thread_updated') && e.thread.parent_thread_id === threadId) setChildren(rows => [...rows.filter(t => t.id !== e.thread.id), e.thread])
      if (e.kind === 'thread_archived') setChildren(rows => rows.filter(t => t.id !== e.thread_id))
    }
    const off = onLiveEvent(update)
    return () => { alive = false; off() }
  }, [threadId])
  // The open thread object of another machine's thread may not carry its machine: the hub knows it.
  const machineId = threadId ? (thread?.id === threadId ? (thread as { machineId?: string }).machineId : undefined) ?? machineOfThreadId(threadId) : undefined
  useEffect(() => { if (threadId) void loadTarget(threadId, machineId) }, [threadId, machineId, thread?.status])
  const children = useMemo(() => {
    const merged = new Map(loadedChildren.filter(c => c.parent_thread_id === threadId).map(c => [c.id, c]))
    for (const child of Object.values(liveChildren)) if (child.parent_thread_id === threadId) merged.set(child.id, child)
    return [...merged.values()].filter(c => c.status !== 'archived')
  }, [loadedChildren, liveChildren, threadId])
  const helpers = children.filter(c => !c.subagent && !c.delegation)
  const turnRunning = thread?.status === 'running' || thread?.status === 'awaiting-approval'
  const turnId = useApp(s => s.open.blocks.reduce<string | null>((id, b) => 'turnId' in b ? b.turnId : id, null))
  const strip = stripSubagents(children.filter(c => !!c.subagent), { turnRunning, turnId })
  const active = tasks.filter(isActiveTask).filter(task => !strip || task.kind !== 'agent')
  // Between turns, a thread whose account isn't usable on its machine asks what to do; it never switches on its own.
  const accounts = useAccountsView()
  const own = thread && thread.id === threadId && !thread.subagent && !turnRunning && !target?.quota_limited ? thread : null
  const awayMachine = machineId ?? accounts.primaryId
  const awayFeatures = accounts.machines.find((m) => m.machineId === awayMachine)?.features
  const away = own ? accountAway(accounts.machines, accounts.groups, awayMachine, target?.target.provider ?? own.provider, daemonSaysUnavailable(target, awayFeatures)) : null
  return { held, setHeld, helpers, strip, active, target, thread, away, visible: !!(held.length || helpers.length || strip || active.length || target?.pending_permission_mode || target?.quota_limited || away) }
}

export function ActivityPanels({ threadId, data }: { threadId: string; data: ReturnType<typeof useRequestActivity> }) {
  const { held, setHeld, target, thread, away } = data
  const t = useTheme()
  const changed = !!target && !!thread && (target.target.provider.kind !== thread.provider.kind || target.target.provider.instance !== thread.provider.instance)
  const [applying, setApplying] = useState(false)
  return <>
    <PanelPresence show={!!target?.pending_permission_mode}><PanelEnter><ActivityBody testId="permission-change-panel"><div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <Para color={t.textSecondary} size={12} style={{ flexGrow: 1 }}>{`${changed ? 'Selected agent uses' : 'Permissions change to'} ${target?.pending_permission_mode === 'full-access' ? 'Full access' : target?.pending_permission_mode} ${changed ? 'with your next message.' : 'after this turn.'}`}</Para>
      {!changed && <Button variant="primary" size="sm" testId="permission-apply" disabled={applying} onClick={() => { setApplying(true); const owner = activeEnvironment(); const machineId = (thread as { machineId?: string } | null)?.machineId; const client = threadClient(threadId, machineId)!; void client.call('threads.permissions.apply', { thread_id: threadId }).then(() => { if (owner === activeEnvironment()) return loadTarget(threadId, machineId) }).catch(e => { if (owner === activeEnvironment()) reportError('Unable to apply permissions', e) }).finally(() => setApplying(false)) }}>Stop and apply now</Button>}
    </div></ActivityBody></PanelEnter></PanelPresence>
    <PanelPresence show={!!target?.quota_limited && !!thread}>{thread && <LimitRecovery thread={thread} />}</PanelPresence>
    <PanelPresence show={!!away && !!thread}>{thread && away && <AccountAwayCard thread={thread} away={away} />}</PanelPresence>
    <PanelPresence show={held.length > 0}><PanelEnter><HeldMessages messages={held} onDone={id => setHeld(items => items.filter(m => m.id !== id))} /></PanelEnter></PanelPresence>
  </>
}

export async function controlSubagent(thread: StateThread, action: 'stop' | 'background') {
  try { await threadClient(thread.id, thread.machineId)!.call(action === 'stop' ? 'tasks.stop' : 'tasks.background', { thread_id: thread.id }) }
  catch (e) { reportError(`Unable to ${action === 'stop' ? 'stop subagent' : 'run in background'}`, e) }
}

/** Background tasks the tray can stop: still running, and the harness can stop them. */
export const stoppableTasks = (tasks: readonly RuntimeTask[]) => tasks.filter(task => isActiveTask(task) && task.status !== 'stopping' && task.capabilities.stop)

/** `tasks.stop` for one background task. `true` once the daemon took the request. */
export async function stopRuntimeTask(task: RuntimeTask): Promise<boolean> {
  try { await requireThreadClient(task.thread_id).call('tasks.stop', { thread_id: task.thread_id, task_id: task.id }); return true }
  catch (e) { toastProblem(e, { action: 'stop that task' }); return false }
}
// Measure visible rows so a short card has no blank tail; long held-message
// lists still mount only the rows inside the capped viewport.
function HeldMessages({ messages, onDone }: { messages: ThreadMessageRecord[]; onDone: (id: string) => void }) {
  const [heights, setHeights] = useState<Record<string, number>>({})
  const measure = useCallback((id: string, height: number) => setHeights(previous => previous[id] === height ? previous : { ...previous, [id]: height }), [])
  // A row enters once, and only if it arrived after the panel first showed: rows there at the start, and rows a scroll brings back, paint plainly.
  const seen = useRef<Set<string> | null>(null)
  seen.current ??= new Set(messages.map(message => message.id))
  return <virtual-list testId="held-messages-panel" style={{ width: '100%', height: Math.min(256, messages.reduce((total, message) => total + (heights[message.id] ?? 56), 0)) }}>{messages.map(message => <MeasuredHeldRow key={message.id} message={message} seen={seen.current!} onDone={() => onDone(message.id)} onHeight={measure} />)}</virtual-list>
}
function MeasuredHeldRow({ message, seen, onDone, onHeight }: { message: ThreadMessageRecord; seen: Set<string>; onDone: () => void; onHeight: (id: string, height: number) => void }) {
  const renderer = useGpuixRequired(), ref = useRef<PublicInstance>(null)
  const [play] = useState(() => !seen.has(message.id))
  useEffect(() => { seen.add(message.id) }, [seen, message.id])
  useEffect(() => ref.current ? observeElementBounds(renderer, ref.current.id, event => { if (event.rect) onHeight(message.id, Math.ceil(event.rect.height)) }) : undefined, [renderer, message.id, onHeight])
  return <div ref={ref} style={{ display: 'flex', flexDirection: 'column', width: '100%' }}><Rise kind="row" play={play}><HeldRow message={message} onDone={onDone} /></Rise></div>
}
const HeldRow = memo(function HeldRow({ message, onDone }: { message: ThreadMessageRecord; onDone: () => void }) {
  const t = useTheme(); const [expanded, setExpanded] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const sender = useApp(s => s.threads.find(t => t.id === message.from_thread_id)?.title)
  const name = messageSenderName({ from_thread_id: message.from_thread_id, from_title: sender ?? '' })
  const act = async (deliver: boolean) => { setBusy(true); setError(''); try { await threadClient(message.to_thread_id)!.call(deliver ? 'threads.messages.deliver' : 'threads.messages.dismiss', { message_id: message.id }); onDone() } catch(e) { setError(problemSentence(e, { action: deliver ? 'deliver the message' : 'dismiss the message' })); setBusy(false) } }
  return <ActivityBody testId={`held-message-${message.id}`}><div style={{ display: 'flex', gap: 8 }}><Icon source={G.hand} size={14} color={t.variant === 'dark' ? '#fcd34d' : '#d97706'} /><div onClick={() => setExpanded(!expanded)} style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0, cursor: 'pointer' }}><Para color={t.text} size={12} weight={500}>{heldHeadline(name, message.purpose)}</Para><Para color={muted(t)} size={12} style={{ lineClamp: expanded ? 8 : 2 }}>{expanded ? message.body : plainLine(message.body, 200)}</Para><Collapse open={expanded}><Para color={muted(t)} size={11}>{`${purposeLabel(message.purpose)}${message.held_reason ? ` · ${message.held_reason}` : ''}`}</Para></Collapse></div><Button variant="ghost" size="sm" testId={`held-dismiss-${message.id}`} disabled={busy} onClick={() => void act(false)}>Dismiss</Button><Button variant="primary" size="sm" testId={`held-deliver-${message.id}`} disabled={busy} onClick={() => void act(true)}>Deliver</Button></div>{error && <Para color={t.red} size={11}>{error}</Para>}</ActivityBody>
})
