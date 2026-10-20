import { Icon } from '../icons.tsx'
import { G } from '../composer/glyphs.ts'
import { T } from '../transcript/glyphs.ts'
import { accountNeedsSignIn } from '../../../desktop/src/lib/accountUi.ts'
import { useGpuixRequired, type PublicInstance } from '@gpuix/react'
import { observeElementBounds } from '../native/layout.ts'
import { type ReactNode, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RuntimeTask, Thread, ThreadMessageRecord } from '../../../../packages/kybern-client/src/types.ts'
import { heldHeadline, messageSenderName, plainLine, purposeLabel } from '../../../../packages/kybern-client/src/delegations.ts'
import { stripSubagents, stripLabel, stoppableSubagents, subagentThreadPhase, subagentTypeLabel, subagentSpan, subagentPhaseWord } from '../../../../packages/kybern-client/src/subagents.ts'
import { useRuntimeTasks, isActiveTask } from '../dock/Activity.tsx'
import { chooseTab, setDock } from '../dock/store.ts'
import { onLiveEvent } from '../nav/live.ts'
import { setNav, useNav } from '../nav/store.ts'
import { openThread } from '../nav/history.ts'
import { activeEnvironment } from '../shell/environment.ts'
import { getClient, useApp } from '../state.ts'
import { loadTarget, useComposer } from '../composer/store.ts'
import { Button, Para, muted } from '../transcript/kit.tsx'
import { errorText, reportError } from '../transcript/store.ts'
import { ink, Label, ProviderMark, useTheme } from '../ui.tsx'
import { PanelEnter, PanelPresence } from './Panel.tsx'
import { PickerMenu, PickerItem } from '../composer/Menu.tsx'
import { Elapsed } from '../subagents/Elapsed.tsx'
import { SubagentHover } from '../subagents/Hover.tsx'

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
    const client = getClient(); if (!client || !threadId) return
    let alive = true, generation = 0
    const loadHeld = () => { const version = ++generation; void client.call('threads.messages.list', { thread_id: threadId, states: ['held'] }).then(r => { if (alive && owner === activeEnvironment() && version === generation) setHeld(r.messages.filter(m => m.to_thread_id === threadId)) }).catch(e => { if (alive && owner === activeEnvironment()) reportError('Unable to load held messages', e) }) }
    loadHeld()
    void client.call('threads.list', { parent_thread_id: threadId }).then(r => { if (alive && owner === activeEnvironment()) setChildren(r.threads) }).catch(() => {})
    const update = (e: import('../../../../packages/kybern-client/src/types.ts').ThreadEvent) => {
      if (e.thread_id === threadId && e.kind.startsWith('thread_message_')) loadHeld()
      if ((e.kind === 'thread_created' || e.kind === 'thread_updated') && e.thread.parent_thread_id === threadId) setChildren(rows => [...rows.filter(t => t.id !== e.thread.id), e.thread])
      if (e.kind === 'thread_archived') setChildren(rows => rows.filter(t => t.id !== e.thread_id))
    }
    const off = onLiveEvent(update)
    return () => { alive = false; off() }
  }, [threadId])
  useEffect(() => { if (threadId) void loadTarget(threadId) }, [threadId, thread?.status])
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
  return { held, setHeld, helpers, strip, active, target, thread, visible: !!(held.length || helpers.length || strip || active.length || target?.pending_permission_mode || target?.quota_limited) }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
/** `activeTaskSummary` (`lib/runtimeActivity.ts`). */
function activeTaskSummary(tasks: RuntimeTask[]) {
  const agents = tasks.filter(task => task.kind === 'agent').length
  const background = tasks.length - agents
  if (agents > 0) return `${plural(agents, 'agent')} working${background > 0 ? ` · ${plural(background, 'background task')}` : ''}`
  return plural(background, 'background task')
}
/** `RuntimeActivityPanel` (`views/Thread.tsx`): the primary task's kind icon, the summary, then its title. */
function RuntimeActivityRow({ tasks, onView }: { tasks: RuntimeTask[]; onView: () => void }) {
  const t = useTheme()
  const foreground = tasks.find(task => !task.backgrounded)
  const primary = foreground ?? tasks[0]
  const detail = primary?.title
  const icon = primary?.kind === 'process' ? T.terminal : primary?.kind === 'agent' ? T.robot : G.workflow
  return <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
    <Icon source={icon} size={14} color={t.textSecondary} style={primary?.kind === 'process' ? { marginTop: 1 } : undefined} />
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexGrow: 1, minWidth: 0 }}>
      <Label color={ink(t, 0.85)} size={12} weight={500} truncate style={{ flexShrink: 0, maxWidth: '100%' }}>{activeTaskSummary(tasks)}</Label>
      {detail && <Label color={muted(t, 0.55)} size={12} truncate style={{ minWidth: 0 }}>{`· ${detail}`}</Label>}
    </div>
    <Button variant="ghost" testId="runtime-view" onClick={onView}>View activity</Button>
  </div>
}

export function ActivityPanels({ threadId, data }: { threadId: string; data: ReturnType<typeof useRequestActivity> }) {
  const { held, setHeld, helpers, strip, active, target, thread } = data
  const t = useTheme()
  const changed = !!target && !!thread && (target.target.provider.kind !== thread.provider.kind || target.target.provider.instance !== thread.provider.instance)
  const [helpersOpen, setHelpersOpen] = useState(false)
  const [stripOpen, setStripOpen] = useState(true)
  const [applying, setApplying] = useState(false)
  return <>
    <PanelPresence show={!!target?.pending_permission_mode}><PanelEnter><ActivityBody testId="permission-change-panel"><div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <Para color={t.textSecondary} size={12} style={{ flexGrow: 1 }}>{`${changed ? 'Selected agent uses' : 'Permissions change to'} ${target?.pending_permission_mode === 'full-access' ? 'Full access' : target?.pending_permission_mode} ${changed ? 'with your next message.' : 'after this turn.'}`}</Para>
      {!changed && <Button variant="ghost" testId="permission-apply" disabled={applying} onClick={() => { setApplying(true); const owner = activeEnvironment(); const client = getClient()!; void client.call('threads.permissions.apply', { thread_id: threadId }).then(() => { if (owner === activeEnvironment()) return loadTarget(threadId) }).catch(e => { if (owner === activeEnvironment()) reportError('Unable to apply permissions', e) }).finally(() => setApplying(false)) }}>Stop and apply now</Button>}
    </div></ActivityBody></PanelEnter></PanelPresence>
    <PanelPresence show={!!target?.quota_limited && !!thread}>{thread && <LimitRecovery thread={thread} />}</PanelPresence>
    <PanelPresence show={helpers.length > 0}><PanelEnter><ActivityBody testId="helper-threads-panel">
      <div style={{ display: 'flex', justifyContent: 'space-between' }}><Button variant="ghost" onClick={() => setHelpersOpen(!helpersOpen)}>{`${helpers.length} ${helpers.length === 1 ? 'helper' : 'helpers'}${helpers.some(c => c.status === 'awaiting-approval') ? ` · ${helpers.filter(c => c.status === 'awaiting-approval').length} need approval` : helpers.some(c => c.status === 'running') ? ` · ${helpers.filter(c => c.status === 'running').length} working` : ''} ${helpersOpen ? '⌃' : '⌄'}`}</Button><Button variant="ghost" onClick={() => showDock(threadId, 'agents')}>Details</Button></div>
      {helpersOpen && <virtual-list style={{ width: '100%', height: Math.min(176, helpers.length * 32) }}>{helpers.map(child => <div key={child.id} onClick={() => openThread(child.id)} testId={`helper-${child.id}`} style={{ display: 'flex', alignItems: 'center', height: 32, gap: 8, cursor: 'pointer', hover: { backgroundColor: t.buttonSecondaryHover } }}><ProviderMark kind={child.provider.kind} size={12} /><Label color={t.text} size={12} truncate style={{ flexGrow: 1 }}>{child.title || 'Untitled'}</Label><Label color={child.status === 'failed' ? t.red : t.textSecondary} size={10}>{child.status === 'running' ? 'Working' : child.status === 'awaiting-approval' ? 'Needs approval' : child.status === 'failed' ? 'Failed' : 'Idle'}</Label></div>)}</virtual-list>}
    </ActivityBody></PanelEnter></PanelPresence>
    <PanelPresence show={!!strip}>{strip && <PanelEnter><ActivityBody testId="subagent-strip"><div style={{ display: 'flex', justifyContent: 'space-between' }}><Button variant="ghost" onClick={() => setStripOpen(!stripOpen)}>{`${stripLabel(strip.rows.length, strip.working)} ${stripOpen ? '⌃' : '⌄'}`}</Button>{stoppableSubagents(strip.rows).length >= 2 && <Button variant="ghost" testId="subagents-stop-all" onClick={() => { for (const child of stoppableSubagents(strip.rows)) void controlSubagent(child, 'stop') }}>Stop all</Button>}</div>
      {stripOpen && <virtual-list style={{ width: '100%', height: Math.min(176, strip.rows.length * 28) }}>{strip.rows.map(child => <SubagentRow key={child.id} thread={child} />)}</virtual-list>}
    </ActivityBody></PanelEnter>}</PanelPresence>
    <PanelPresence show={active.length > 0}><PanelEnter><ActivityBody testId="runtime-activity-panel"><RuntimeActivityRow tasks={active} onView={() => showDock(threadId, 'activity')} /></ActivityBody></PanelEnter></PanelPresence>
    <PanelPresence show={held.length > 0}><PanelEnter><HeldMessages messages={held} onDone={id => setHeld(items => items.filter(m => m.id !== id))} /></PanelEnter></PanelPresence>
  </>
}

export async function controlSubagent(thread: Thread, action: 'stop' | 'background') {
  try { await getClient()!.call(action === 'stop' ? 'tasks.stop' : 'tasks.background', { thread_id: thread.id }) }
  catch (e) { reportError(`Unable to ${action === 'stop' ? 'stop subagent' : 'run in background'}`, e) }
}
function SubagentAction({ thread, action, visible }: { thread: Thread; action: 'stop' | 'background'; visible: boolean }) {
  const t = useTheme()
  const label = action === 'stop' ? `Stop ${thread.title || 'subagent'}` : `Run ${thread.title || 'subagent'} in background`
  return <div testId={`subagent-${action}-${thread.id}`} role="button" aria-label={label} tabIndex={visible ? 0 : -1}
    onClick={() => void controlSubagent(thread, action)} onKeyDown={event => { if (event.key === 'enter' || event.key === 'space') void controlSubagent(thread, action) }}
    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: 6, cursor: 'pointer', hover: { backgroundColor: t.buttonSecondaryHover } }}>
    <Icon source={action === 'stop' ? G.stop : G.background} size={12} color={ink(t, .48)} />
  </div>
}
export const SubagentRow = memo(function SubagentRow({ thread }: { thread: Thread }) {
  const t = useTheme(), phase = subagentThreadPhase(thread), info = thread.subagent!
  const [hover, setHover] = useState(false), span = subagentSpan(thread)
  const canBackground = phase === 'working' && info.capabilities?.background === true && !info.backgrounded
  const canStop = phase === 'working' && info.capabilities?.stop !== false
  const actions = (canBackground || canStop) && hover
  return <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} onFocus={() => setHover(true)} onBlur={() => setHover(false)} style={{ display: 'flex', alignItems: 'center', height: 28, borderRadius: 7, backgroundColor: hover ? t.buttonSecondaryHover : 'transparent' }}>
    <SubagentHover thread={thread}><div testId={`subagent-open-${thread.id}`} role="button" tabIndex={0} onClick={() => openThread(thread.id)} onKeyDown={event => { if (event.key === 'enter' || event.key === 'space') openThread(thread.id) }} style={{ display: 'flex', alignItems: 'center', gap: 8, flexGrow: 1, minWidth: 0, height: 28, paddingLeft: 6, cursor: 'pointer' }}><ProviderMark kind={thread.provider.kind} size={14} /><Label color={ink(t, .85)} size={14} weight={500} truncate>{thread.title || 'Subagent'}</Label><Label color={ink(t, .45)} size={14} truncate>{[subagentTypeLabel(info.agent_type), thread.model].filter(Boolean).join(' · ')}</Label></div></SubagentHover>
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', minWidth: 52, paddingLeft: 8, paddingRight: 6, flexShrink: 0, height: 28 }}>
      <div style={{ opacity: actions ? 0 : 1, pointerEvents: 'none' }}>{span && <Elapsed startedAt={span.startedAt} endedAt={span.endedAt} />}</div>
      <div style={{ position: 'absolute', right: 2, top: 3, display: 'flex', gap: 2, opacity: actions ? 1 : 0, pointerEvents: actions ? undefined : 'none' }}>
        {canBackground && <SubagentAction thread={thread} action="background" visible={actions} />}
        {canStop && <SubagentAction thread={thread} action="stop" visible={actions} />}
      </div>
    </div>
  </div>
})
// Measure visible rows so a short card has no blank tail; long held-message
// lists still mount only the rows inside the capped viewport.
function HeldMessages({ messages, onDone }: { messages: ThreadMessageRecord[]; onDone: (id: string) => void }) {
  const [heights, setHeights] = useState<Record<string, number>>({})
  const measure = useCallback((id: string, height: number) => setHeights(previous => previous[id] === height ? previous : { ...previous, [id]: height }), [])
  return <virtual-list testId="held-messages-panel" style={{ width: '100%', height: Math.min(256, messages.reduce((total, message) => total + (heights[message.id] ?? 56), 0)) }}>{messages.map(message => <MeasuredHeldRow key={message.id} message={message} onDone={() => onDone(message.id)} onHeight={measure} />)}</virtual-list>
}
function MeasuredHeldRow({ message, onDone, onHeight }: { message: ThreadMessageRecord; onDone: () => void; onHeight: (id: string, height: number) => void }) {
  const renderer = useGpuixRequired(), ref = useRef<PublicInstance>(null)
  useEffect(() => ref.current ? observeElementBounds(renderer, ref.current.id, event => { if (event.rect) onHeight(message.id, Math.ceil(event.rect.height)) }) : undefined, [renderer, message.id, onHeight])
  return <div ref={ref} style={{ display: 'flex', flexDirection: 'column', width: '100%' }}><HeldRow message={message} onDone={onDone} /></div>
}
const HeldRow = memo(function HeldRow({ message, onDone }: { message: ThreadMessageRecord; onDone: () => void }) {
  const t = useTheme(); const [expanded, setExpanded] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const sender = useApp(s => s.threads.find(t => t.id === message.from_thread_id)?.title)
  const name = messageSenderName({ from_thread_id: message.from_thread_id, from_title: sender ?? '' })
  const act = async (deliver: boolean) => { setBusy(true); setError(''); try { await getClient()!.call(deliver ? 'threads.messages.deliver' : 'threads.messages.dismiss', { message_id: message.id }); onDone() } catch(e) { setError(errorText(e)); setBusy(false) } }
  return <ActivityBody testId={`held-message-${message.id}`}><div style={{ display: 'flex', gap: 8 }}><Icon source={G.hand} size={14} color={t.variant === 'dark' ? '#fcd34d' : '#d97706'} /><div onClick={() => setExpanded(!expanded)} style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0, cursor: 'pointer' }}><Para color={t.text} size={12} weight={500}>{heldHeadline(name, message.purpose)}</Para><Para color={muted(t)} size={12} style={{ lineClamp: expanded ? 8 : 2 }}>{expanded ? message.body : plainLine(message.body, 200)}</Para>{expanded && <Para color={muted(t)} size={11}>{`${purposeLabel(message.purpose)}${message.held_reason ? ` · ${message.held_reason}` : ''}`}</Para>}</div><Button variant="ghost" testId={`held-dismiss-${message.id}`} disabled={busy} onClick={() => void act(false)}>Dismiss</Button><Button variant="subtle" testId={`held-deliver-${message.id}`} disabled={busy} onClick={() => void act(true)}>Deliver</Button></div>{error && <Para color={t.red} size={11}>{error}</Para>}</ActivityBody>
})
function LimitRecovery({ thread }: { thread: Thread }) {
  const t = useTheme(), accounts = useComposer(d => d.accounts)
  const options = accounts.filter(a => a.provider.kind === thread.provider.kind && a.provider.instance !== thread.provider.instance && !accountNeedsSignIn(a))
  const [selected, setSelected] = useState(''), [busy, setBusy] = useState(false)
  const attempt = useRef<string | null>(null)
  const choice = options.find(a => a.provider.instance === selected) ?? options[0]
  return <ActivityBody testId="usage-limit-recovery"><div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><Para color={t.text} size={12} weight={500} style={{ width: 145, flexShrink: 0 }}>Account usage limit reached</Para><Para color={muted(t)} size={12} style={{ flexGrow: 1 }}>Choose an account to continue the interrupted task in this conversation.</Para><div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexShrink: 0 }}>{choice ? <><PickerMenu trigger={() => <Button variant="ghost">{choice.name || choice.provider.instance}</Button>}>{options.map(a => <PickerItem id={a.provider.instance} key={a.provider.instance} onSelect={() => { setSelected(a.provider.instance); attempt.current = null }}><Label color={t.text} size={12}>{a.name || a.provider.instance}</Label></PickerItem>)}</PickerMenu><Button testId="usage-switch-continue" disabled={busy} onClick={() => { setBusy(true); attempt.current ??= crypto.randomUUID(); const owner = activeEnvironment(); const client = getClient()!; void client.call('threads.switch_continue', { thread_id: thread.id, provider: choice.provider, message_id: attempt.current }).then(() => { if (owner === activeEnvironment()) return loadTarget(thread.id) }).catch(e => { if (owner === activeEnvironment()) reportError('Unable to continue', e) }).finally(() => setBusy(false)) }}>Switch and continue</Button></> : <Button variant="ghost" onClick={() => setNav({ settingsOpen: true })}>Add an account</Button>}</div></div></ActivityBody>
}
