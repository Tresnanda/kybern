import { memo, useMemo, useState } from 'react'
import type { AgentResultItem, ThreadMessagePart } from '../../../../packages/kybern-client/src/types.ts'
import { delegationState, messageSenderName, plainLine, purposeLabel, resultPreview } from '../../../../packages/kybern-client/src/delegations.ts'
import { liveSend } from '../../../../packages/kybern-client/src/messageStates.ts'
import { parseSendInput, parseSendResult } from '../../../../packages/kybern-client/src/orchestrationTools.ts'
import { clockTime } from '../../../desktop/src/lib/format.ts'
import { useApp } from '../state.ts'
import { openThread } from '../nav/history.ts'
import { useNav } from '../nav/store.ts'
import { useMessages } from '../requests/messages.ts'
import { Label, ProviderMark, useTheme } from '../ui.tsx'
import { Icon } from '../icons.tsx'
import { T } from './glyphs.ts'
import { Button, Chevron, Para, muted } from './kit.tsx'
import { PanelPresence, PanelEnter, keyboardAnswer } from '../requests/Panel.tsx'
import { BoundedMarkdown, TextDetail } from './markdown.tsx'
import { useRowState, type ToolBlock } from './store.ts'

function purposeIcon(purpose: string) { return purpose === 'question' ? T.question : purpose === 'warning' ? T.alert : purpose === 'task' ? T.listChecks : purpose === 'reply' ? T.undo : T.chatBubble }
export const InboundMessage = memo(function InboundMessage({ part, at }: { part: ThreadMessagePart; at: string }) {
  const t = useTheme()
  const openBlocks = useApp(s => s.open.blocks)
  const sender = useApp(s => s.threads.find(th => th.id === part.from_thread_id))
  const [quoted] = useState(() => {
    const block = openBlocks.find(b => b.kind === 'tool' && b.complete && parseSendResult(b.output)?.messageId === part.reply_to)
    return block?.kind === 'tool' ? plainLine(parseSendInput(block.call.input).body, 80) : null
  })
  return <div testId="inbound-message" style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12, marginBottom: 12, padding: 12, borderRadius: 12, backgroundColor: t.v('--color-background-elevated-secondary') }}>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Icon source={purposeIcon(part.purpose)} size={14} color={muted(t)} /><Label color={t.text} size={12} weight={500}>{purposeLabel(part.purpose)}</Label><Label color={muted(t)} size={12}>from</Label>
      <Button variant="subtle" testId="inbound-sender" onClick={part.from_thread_id ? () => openThread(part.from_thread_id!) : undefined}>{sender && <ProviderMark kind={sender.provider.kind} size={11} />}{messageSenderName(part)}</Button>
      <div style={{ flexGrow: 1 }} /><Label color={muted(t)} size={11}>{clockTime(at)}</Label>
    </div>
    {part.reply_to && <Para color={muted(t)} size={12}>{quoted ? `Reply to “${quoted}”` : 'Reply to your question'}</Para>}
    <BoundedMarkdown text={part.body} />
  </div>
})

/** Shared delegation facts; paths and conflicts stay bounded and available. */
export function WorkspaceFacts({ item }: { item: Pick<AgentResultItem, 'workspace' | 'branch' | 'base_commit' | 'head_commit' | 'diffstat' | 'files_touched' | 'conflicts'> }) {
  const t = useTheme()
  const [all, setAll] = useState(false)
  const files = item.files_touched ?? [], conflicts = item.conflicts ?? []
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
    <Para color={muted(t)} size={12}>{item.workspace === 'worktree' ? `Worktree${item.branch ? ` · ${item.branch}` : ''}` : 'Shared workspace'}</Para>
    {item.head_commit && <Para color={muted(t)} size={11} selectable>{`${item.base_commit ? `${item.base_commit.slice(0, 8)} → ` : ''}${item.head_commit.slice(0, 8)}`}</Para>}
    {item.diffstat && <Para color={muted(t)} size={12}>{`${item.diffstat.files} files · +${item.diffstat.additions} −${item.diffstat.deletions}`}</Para>}
    {files.slice(0, 5).map(file => <Para key={file} color={muted(t)} size={11} selectable>{file}</Para>)}
    {files.length > 5 && <div style={{ display: 'flex' }}><Button variant="ghost" onClick={() => setAll(true)}>{`Show all ${files.length} files`}</Button></div>}
    {all && <TextDetail text={files.join('\n')} title="Changed files" code onClose={() => setAll(false)} />}
    {conflicts.map((c, i) => <div key={`${c.path}:${i}`} style={{ display: 'flex', gap: 8 }}><Para color={t.red} size={12} selectable style={{ flexGrow: 1 }}>{`Ownership conflict: ${c.path}`}</Para><Button variant="ghost" onClick={() => openThread(c.owner_thread_id)}>Open owner</Button></div>)}
  </div>
}
function ResultRow({ item }: { item: AgentResultItem }) {
  const t = useTheme(), phase = delegationState(item.status)
  const [expanded, setExpanded] = useRowState(`result:${item.task_id}`, false)
  return <div style={{ display: 'flex', flexDirection: 'column', paddingTop: 8, paddingBottom: 8, borderTopWidth: 1, borderColor: t.border }}>
    <div testId={`result-toggle-${item.task_id}`} role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'enter' || e.key === 'space') { keyboardAnswer(); setExpanded(!expanded) } }} onClick={() => setExpanded(!expanded)} style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: 28, cursor: 'pointer' }}>
      <ProviderMark kind={item.provider} size={14} /><Label color={t.text} size={13} truncate style={{ flexGrow: 1 }}>{item.title}</Label><Label color={item.status === 'failed' ? t.red : muted(t)} size={12}>{phase.word}</Label><Chevron open={expanded} color={muted(t)} />
    </div>
    <Para color={muted(t)} size={11}>{[item.role, item.model, item.workspace === 'worktree' ? 'Worktree' : 'Shared workspace', item.conflicts?.length ? `${item.conflicts.length} ${item.conflicts.length === 1 ? 'conflict' : 'conflicts'}` : ''].filter(Boolean).join(' · ')}</Para>
    {!expanded && <Para color={muted(t)} size={12} style={{ lineClamp: 2 }}>{resultPreview(item)}</Para>}
    <PanelPresence show={expanded}><PanelEnter><div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 8 }}>
      {(item.result || item.error) && <BoundedMarkdown text={item.result || item.error || ''} />}
      <WorkspaceFacts item={item} /><div style={{ display: 'flex' }}><Button variant="subtle" testId={`result-open-${item.task_id}`} onClick={() => openThread(item.thread_id)}>Open agent</Button></div>
    </div></PanelEnter></PanelPresence>
  </div>
}
export const DelegatedResults = memo(function DelegatedResults({ items, at }: { items: AgentResultItem[]; at: string }) {
  const t = useTheme(), attention = items.filter(i => i.status !== 'completed' || i.conflicts?.length).length
  return <div testId="delegated-results" style={{ display: 'flex', flexDirection: 'column', padding: 12, borderRadius: 12, backgroundColor: t.v('--color-background-elevated-secondary') }}>
    <div style={{ display: 'flex', gap: 8, paddingBottom: 8, alignItems: 'center' }}><Icon source={T.robot} size={14} color={muted(t)} /><Label color={t.text} size={12} weight={500} style={{ flexGrow: 1 }}>{`Results from ${items.length} delegated ${items.length === 1 ? 'agent' : 'agents'}`}</Label>{attention > 0 && <Label color={t.red} size={11}>{`${attention} ${attention === 1 ? 'needs' : 'need'} a look`}</Label>}<Label color={muted(t)} size={11}>{clockTime(at)}</Label></div>
    {items.map(item => <ResultRow key={item.task_id} item={item} />)}
  </div>
})
export function SentToRow({ block, threadId }: { block: ToolBlock; threadId: string }) {
  const t = useTheme(), input = useMemo(() => parseSendInput(block.call.input), [block.call.input]), result = useMemo(() => parseSendResult(block.output), [block.output])
  const target = useApp(s => s.threads.find(th => th.id === input.threadId))
  const child = useNav(s => input.threadId ? s.children[input.threadId] : undefined)
  const index = useMessages(threadId), record = result?.messageId ? index.byId[result.messageId] : undefined
  const reply = result?.messageId ? index.byId[index.replies[result.messageId] ?? ''] : undefined
  const live = liveSend(result, record, reply, block.complete, block.isError)
  const [expanded, setExpanded] = useRowState(`sent:${block.id}`, false)
  const title = target?.title || child?.title || 'another thread'
  return <div testId="sent-to-row" style={{ display: 'flex', flexDirection: 'column', paddingTop: 4, paddingBottom: 4 }}>
    <div testId={`sent-toggle-${block.id}`} role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'enter' || e.key === 'space') { keyboardAnswer(); setExpanded(!expanded) } }} onClick={() => setExpanded(!expanded)} style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 28, cursor: 'pointer' }}><Icon source={purposeIcon(input.purpose)} size={14} color={muted(t)} /><Label color={muted(t)} truncate style={{ flexGrow: 1 }}>{`${block.complete ? 'Sent to' : 'Sending to'} ${title} · ${purposeLabel(input.purpose)}`}</Label><Label color={block.isError || live.state === 'failed' ? t.red : muted(t)} size={12}>{live.word}</Label><Chevron open={expanded} color={muted(t)} /></div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginLeft: 22 }}>
      <Para color={muted(t)} size={12} style={{ lineClamp: 1 }}>{`“${plainLine(input.body, 160)}”`}</Para>
      {live.reply && <Para color={muted(t)} size={12} style={{ lineClamp: 1 }}>{`Reply: “${plainLine(live.reply.body, 160)}”`}</Para>}
      {live.held && <Para color={muted(t)} size={12}>{`Waiting for you to approve it in ${title}.`}</Para>}
      {live.state === 'dismissed' && <Para color={muted(t)} size={12}>{`Dismissed in ${title}. It was not delivered.`}</Para>}
      <PanelPresence show={expanded}><PanelEnter><div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 8 }}><BoundedMarkdown text={input.body} />{live.reply && <BoundedMarkdown text={live.reply.body} />}{result?.waitTimedOut && !live.reply && <Para color={muted(t)} size={12}>No reply yet. It will arrive here when the thread answers.</Para>}</div></PanelEnter></PanelPresence>
      {(expanded || live.held) && input.threadId && <div style={{ display: 'flex' }}><Button variant="subtle" onClick={() => openThread(input.threadId)}>Open</Button></div>}
    </div>
  </div>
}
