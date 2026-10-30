import { useEffect, useMemo, useRef, useState } from 'react'
import type { SubagentMessage, Thread, UserMessage } from '../../../../packages/kybern-client/src/types.ts'
import { subagentThreadPhase } from '../../../../packages/kybern-client/src/subagents.ts'
import { ComposerView } from '../Composer.tsx'
import { useComposer } from '../composer/store.ts'
import { activeEnvironment } from '../shell/environment.ts'
import { threadClient, useApp, usePaneAccess } from '../state.ts'
import { Para, muted } from '../transcript/kit.tsx'
import { Button } from '../kit/Button.tsx'
import { errorText, reportError } from '../transcript/store.ts'
import { useTheme } from '../ui.tsx'
import { StackedPanel } from '../transcript/Requests.tsx'
import { SubagentBar } from './Page.tsx'

export function NativeSubagentComposer({ thread }: { thread: Thread }) {
  const pane = usePaneAccess()
  const t = useTheme()
  const providers = useComposer(d => d.providers)
  const updates = useApp(s => s.open.subagentMessages)
  const [saved, setSaved] = useState<SubagentMessage[]>([])
  const [error, setError] = useState('')
  const [forwarding, setForwarding] = useState<string | null>(null)
  const attempt = useRef<{ fingerprint: string; id: string } | null>(null)
  const active = subagentThreadPhase(thread) === 'working'
  useEffect(() => {
    if (pane.frozen) return
    let alive = true
    const owner = activeEnvironment()
    let client: ReturnType<typeof threadClient> = null
    try { client = threadClient(thread.id) } catch { /* that machine is offline */ }
    if (!client) return
    void client.call('subagents.messages', { thread_id: thread.id }).then(messages => { if (alive && owner === activeEnvironment()) { setSaved(messages); setError('') } }).catch(e => { if (alive && owner === activeEnvironment()) setError(errorText(e)) })
    return () => { alive = false }
  }, [thread.id, thread.status, pane.frozen])
  const messages = useMemo(() => {
    const merged = new Map(saved.map(m => [m.id, m]))
    for (const message of updates ?? []) {
      const previous = merged.get(message.id)
      if (!previous || previous.updated_at <= message.updated_at) merged.set(message.id, message)
    }
    const all = [...merged.values()].sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(-100)
    return all.filter(m => m.status !== 'delivered' || m === all.at(-1)).slice(-20)
  }, [saved, updates])
  const send = async (message: UserMessage) => {
    const owner = activeEnvironment()
    const client = threadClient(thread.id)!
    const fingerprint = JSON.stringify([thread.id, message])
    if (attempt.current?.fingerprint !== fingerprint) attempt.current = { fingerprint, id: crypto.randomUUID() }
    const result = await client.call('subagents.send', { thread_id: thread.id, id: attempt.current.id, message })
    if (owner !== activeEnvironment()) return
    setSaved(rows => [...rows.filter(m => m.id !== result.id), result].slice(-100))
    if (result.status === 'failed') throw new Error(result.error ?? 'Not delivered. Send the message to its parent.')
    attempt.current = null
  }
  const forward = async (message: SubagentMessage) => {
    const owner = activeEnvironment()
    const client = threadClient(thread.id)!
    setForwarding(message.id)
    try {
      const result = await client.call('subagents.send_to_parent', { thread_id: thread.id, message_id: message.id })
      if (owner !== activeEnvironment()) return
      setSaved(rows => [...rows.filter(m => m.id !== result.id), result].slice(-100))
    } catch (e) { if (owner === activeEnvironment()) reportError('Unable to send to parent', e) }
    finally { setForwarding(null) }
  }
  return <ComposerView draftKey={`thread:${thread.id}`} currentThreadId={thread.id} projectId={thread.project_id} provider={thread.provider} providers={providers} accounts={[]} mode={thread.permission_mode} onModeChange={() => {}} lockMode model={thread.model} effort={thread.effort} catalogLoading={false} onReloadModels={async () => {}} sendDisabled={!active} readOnly={!active} onSend={send} placeholder={active ? 'Message this subagent' : 'This subagent has finished'} above={<StackedPanel closed={false}>
    <SubagentBar thread={thread} embedded />
    <div testId="subagent-message-status" style={{ display: 'flex', flexDirection: 'column', padding: 12, gap: 6 }}>
      <Para color={muted(t)} size={12}>{active ? 'Messages arrive at this subagent’s next tool call. Attachments are sent as file references.' : 'This subagent has finished. Send an undelivered message to its parent.'}</Para>
      {error && <Para color={t.red} size={12}>{`Unable to load delivery status: ${error}`}</Para>}
      {messages.length > 0 && <virtual-list style={{ width: '100%', height: Math.min(160, messages.length * 56) }}>{messages.map(message => <div key={message.id} testId={`subagent-message-${message.status}`} style={{ display: 'flex', gap: 8, paddingBottom: 8, alignItems: 'center' }}><div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 }}><Para color={message.status === 'failed' && !message.parent_queued ? t.red : muted(t)} size={12}>{message.parent_queued ? 'Queued for parent' : message.status === 'pending' ? 'Waiting for next tool call' : message.status === 'delivered' ? 'Delivered to subagent' : message.error ?? 'Not delivered — subagent finished'}</Para><Para color={muted(t)} size={12} style={{ lineClamp: 2 }}>{message.message.parts.map(part => part.type === 'text' ? part.text : part.type === 'file_mention' ? `@${part.path}` : part.type === 'attachment' ? part.name : part.type === 'image' ? 'Attached image' : 'Reference').join(' ')}</Para></div>{message.status === 'failed' && !message.parent_queued && <Button variant="ghost" size="sm" testId={`subagent-forward-${message.id}`} disabled={forwarding === message.id} onClick={() => void forward(message)}>{forwarding === message.id ? 'Sending…' : 'Send to parent'}</Button>}</div>)}</virtual-list>}
    </div>
  </StackedPanel>} />
}
