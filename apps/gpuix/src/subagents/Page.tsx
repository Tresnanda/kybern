import { Elapsed } from './Elapsed.tsx'
import { motion } from '@gpuix/react'
import { useRef, type ReactNode } from 'react'
import type { Thread } from '../../../../packages/kybern-client/src/types.ts'
import { formatTokenCount, isSubagentQueued, subagentBarState, subagentSpan, subagentThreadPhase, subagentTokenCount } from '../../../../packages/kybern-client/src/subagents.ts'
import { useNav } from '../nav/store.ts'
import { openThread } from '../nav/history.ts'
import { controlSubagent } from '../requests/Activity.tsx'
import { useApp } from '../state.ts'
import { Button, Para, muted } from '../transcript/kit.tsx'
import { copyText } from '../transcript/store.ts'
import { EASE_OUT, Label, ProviderMark, REDUCED_MOTION, useTheme } from '../ui.tsx'

/** Keyboard history is instant. Pointer navigation follows the parent/child
 * hierarchy with a short native left/opacity tween; no JS animation loop. */
export function SubagentPageMotion({ children }: { children: ReactNode }) {
  const id = useApp(s => s.selectedId)
  const open = useApp(s => s.open.thread)
  const child = useNav(s => id ? s.children[id] : undefined)
  const keyboard = useNav(s => s.keyboardNav)
  const thread = open ?? child
  const previous = useRef<{ id: string | null; parent: string | null; subagent: boolean }>({ id: null, parent: null, subagent: false })
  const entrance = useRef({ id, direction: 0, keyboard })
  if (entrance.current.id !== id) {
    const before = previous.current
    entrance.current = { id, direction: before.subagent && before.parent === id ? -1 : thread?.subagent ? 1 : 0, keyboard }
  }
  if (thread) previous.current = { id: thread.id, parent: thread.parent_thread_id ?? null, subagent: !!thread.subagent }
  const play = entrance.current.direction !== 0 && !entrance.current.keyboard
  return <motion.div key={id} initial={play ? { opacity: .4, left: REDUCED_MOTION ? 0 : entrance.current.direction * 40 } : false} animate={{ opacity: 1, left: 0 }} transition={{ duration: play ? .22 : 0, ease: EASE_OUT }} style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, position: 'relative' }}>{children}</motion.div>
}

export function SubagentBar({ thread, embedded = false }: { thread: Thread; embedded?: boolean }) {
  const t = useTheme(), info = thread.subagent!, phase = subagentThreadPhase(thread)
  const span = subagentSpan(thread)
  // Lifecycle timestamps are sufficient here: the transcript already owns the
  // live elapsed clock. Settled values never wake React or GPUI.
  const elapsed = span?.endedAt != null ? span.endedAt - span.startedAt : null
  const state = subagentBarState(thread, elapsed)
  const tokens = formatTokenCount(subagentTokenCount(thread))
  return <div testId="subagent-bar" style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, width: '100%', minHeight: 48, padding: 8, paddingLeft: 16, borderRadius: embedded ? 0 : 19.2, borderWidth: embedded ? 0 : 1, borderColor: t.border, backgroundColor: embedded ? undefined : t.surface }}>
    <Label color={phase === 'failed' ? t.red : t.text} size={13}>{isSubagentQueued(thread) ? 'Starting' : state.label}</Label>
    {phase === 'working' && span && !isSubagentQueued(thread) && <Elapsed startedAt={span.startedAt} endedAt={null} />}
    <div style={{ height: 16, width: 1, backgroundColor: t.border }} />
    <ProviderMark kind={thread.provider.kind} size={12} />
    <Label color={muted(t)} size={12} truncate>{[thread.model, thread.effort, tokens].filter(Boolean).join(' · ')}</Label>
    <div style={{ flexGrow: 1 }} />
    {phase === 'failed' && (info.result || info.detail) && <Button variant="ghost" onClick={() => copyText(info.result || info.detail || '')}>Copy error</Button>}
    {thread.parent_thread_id && <Button variant="ghost" testId="subagent-open-parent" onClick={() => openThread(thread.parent_thread_id!)}>Open parent ⌘↑</Button>}
    {phase === 'working' && info.capabilities?.background && !info.backgrounded && <Button variant="ghost" testId="subagent-run-background" onClick={() => void controlSubagent(thread, 'background')}>Run in background</Button>}
    {phase === 'working' && info.capabilities?.stop !== false && <Button variant="chrome-outline" testId="subagent-stop" onClick={() => void controlSubagent(thread, 'stop')}>Stop</Button>}
  </div>
}

export function SubagentDivider({ thread, end = false }: { thread: Thread; end?: boolean }) {
  const t = useTheme()
  const parent = useApp(s => s.threads.find(t => t.id === thread.parent_thread_id))
  const childParent = useNav(s => thread.parent_thread_id ? s.children[thread.parent_thread_id] : undefined)
  const name = parent?.title || childParent?.title || 'its parent'
  const phase = subagentThreadPhase(thread)
  if (end && phase === 'working') return null
  const label = end ? phase === 'done' ? `Result returned to ${name}` : phase === 'failed' ? `Failure reported to ${name}` : 'Stopped' : `Subagent of ${name}`
  return <div testId={end ? 'subagent-end' : 'subagent-divider'} style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: end ? 22 : 8, paddingBottom: end ? 8 : 18 }}><div style={{ height: 1, flexGrow: 1, backgroundColor: t.border }} /><div onClick={thread.parent_thread_id ? () => openThread(thread.parent_thread_id!) : undefined} style={{ cursor: thread.parent_thread_id ? 'pointer' : 'default', maxWidth: '75%' }}><Para color={phase === 'failed' && end ? t.red : muted(t)} size={11}>{label}</Para></div><div style={{ height: 1, flexGrow: 1, backgroundColor: t.border }} /></div>
}
