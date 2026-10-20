import { useTreeSlot } from '../tree/Tree.tsx'
import { memo, useMemo, useState, type ReactNode } from 'react'
import type { AgentResultItem, ThreadMessagePart } from '../../../../packages/kybern-client/src/types.ts'
import { delegationState, messageSenderName, plainLine, purposeLabel, resultNeedsClamp, resultPreview } from '../../../../packages/kybern-client/src/delegations.ts'
import { liveSend } from '../../../../packages/kybern-client/src/messageStates.ts'
import { parseSendInput, parseSendResult } from '../../../../packages/kybern-client/src/orchestrationTools.ts'
import { clockTime } from './clock.ts'
import { useApp } from '../state.ts'
import { openThread } from '../nav/history.ts'
import { useNav } from '../nav/store.ts'
import { useMessages } from '../requests/messages.ts'
import { Label, LOGO_SVG, ProviderMark, useTheme } from '../ui.tsx'
import { Icon } from '../icons.tsx'
import { T } from './glyphs.ts'
import { Button, Chevron, Para, fg, muted } from './kit.tsx'
import { PanelPresence, PanelEnter, keyboardAnswer } from '../requests/Panel.tsx'
import { clear } from '../notes/kit.tsx'
import { SwapOnChange } from '../motion/kit.tsx'
import { over } from '../theme.ts'
import { BoundedMarkdown, TextDetail } from './markdown.tsx'
import { useRowState, type ToolBlock } from './store.ts'


/** `SENDER_CHIP` (`ThreadMessageRows.tsx`): a 20px pill, mark and name inline. A message from Kybern itself has no thread to open. */
function SenderChip({ part, kind }: { part: ThreadMessagePart; kind?: string }) {
  const t = useTheme()
  const name = messageSenderName(part), from = part.from_thread_id
  const open = from ? () => openThread(from) : undefined
  return <div testId="inbound-sender" role={open ? 'button' : undefined} aria-label={open ? `Open ${name}` : undefined} tabIndex={open ? 0 : undefined}
    onClick={open} onKeyDown={open ? e => { if (e.key === 'enter' || e.key === 'space') { keyboardAnswer(); open() } } : undefined}
    style={{ display: 'flex', alignItems: 'center', gap: 4, height: 20, minWidth: 0, maxWidth: 288, flexShrink: 1, paddingLeft: 6, paddingRight: 6, borderRadius: 10, backgroundColor: fg(t, 0.06), ...(open ? { cursor: 'pointer', hover: { backgroundColor: fg(t, 0.1) } } : {}) }}>
    {!from ? <svg source={LOGO_SVG} style={{ width: 11, height: 7, flexShrink: 0, color: fg(t, 0.7), pointerEvents: 'none' }} /> : kind ? <ProviderMark kind={kind} size={11} /> : null}
    <Label color={fg(t, 0.85)} size={12} lineHeight={16} truncate>{name}</Label>
  </div>
}

/** `ClampedMarkdown` (`lineage/detail.tsx`): past eight lines or 720 characters the text stops at 11rem, fades out and offers
 *  "Show more". `fade` is the surface behind it; the state is kept per row so a recycled row keeps its choice. */
function ClampedMarkdown({ id, text, fade }: { id: string; text: string; fade: string }) {
  const t = useTheme()
  const clamp = resultNeedsClamp(text)
  const [expanded, setExpanded] = useRowState(`clamp:${id}`, false)
  const shut = clamp && !expanded
  return <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
    <div testId="clamped-markdown" style={{ display: 'flex', flexDirection: 'column', position: 'relative', minWidth: 0, ...(shut ? { maxHeight: 176, overflow: 'hidden' as const } : {}) }}>
      <BoundedMarkdown text={text} />
      {shut && <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 49, pointerEvents: 'none', background: { type: 'linear-gradient', angle: 180, stops: [{ color: clear(fade), position: 0 }, { color: fade, position: 1 }] } }} />}
    </div>
    {clamp && <div testId="clamp-toggle" role="button" tabIndex={0} aria-expanded={expanded} onClick={() => setExpanded(!expanded)} onKeyDown={e => { if (e.key === 'enter' || e.key === 'space') { keyboardAnswer(); setExpanded(!expanded) } }} style={{ display: 'flex', alignSelf: 'flex-start', marginLeft: -4, paddingLeft: 4, paddingRight: 4, paddingTop: 2, paddingBottom: 2, borderRadius: 6, cursor: 'pointer' }}>
      <Label color={fg(t, 0.55)} size={12} lineHeight={16} style={{ hover: { color: t.text } }}>{expanded ? 'Show less' : 'Show more'}</Label>
    </div>}
  </div>
}

/** `DetailSection`: an 11px quiet label over its content. */
function DetailSection({ label, children }: { label: string; children: ReactNode }) {
  const t = useTheme()
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}><Label color={fg(t, 0.45)} size={11} lineHeight={16} weight={500}>{label}</Label>{children}</div>
}
const card = (t: ReturnType<typeof useTheme>) => t.v('--color-background-elevated-secondary')
function purposeIcon(purpose: string) { return purpose === 'question' ? T.question : purpose === 'warning' ? T.alert : purpose === 'task' ? T.listChecks : purpose === 'reply' ? T.undo : T.chatBubble }
export const InboundMessage = memo(function InboundMessage({ part, at }: { part: ThreadMessagePart; at: string }) {
  const t = useTheme()
  const openBlocks = useApp(s => s.open.blocks)
  const sender = useApp(s => s.threads.find(th => th.id === part.from_thread_id))
  const [quoted] = useState(() => {
    const block = openBlocks.find(b => b.kind === 'tool' && b.complete && parseSendResult(b.output)?.messageId === part.reply_to)
    return block?.kind === 'tool' ? plainLine(parseSendInput(block.call.input).body, 80) : null
  })
  return <div testId="inbound-message" style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12, marginBottom: 12, padding: 12, borderRadius: 12, backgroundColor: card(t) }}>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Icon source={purposeIcon(part.purpose)} size={14} color={muted(t)} /><Label color={t.text} size={12} weight={500}>{purposeLabel(part.purpose)}</Label><Label color={muted(t)} size={12}>from</Label>
      <SenderChip part={part} kind={sender?.provider.kind} />
      <div style={{ flexGrow: 1 }} /><Label color={muted(t)} size={11}>{clockTime(at)}</Label>
    </div>
    {part.reply_to && <Para color={muted(t)} size={12}>{quoted ? `Reply to “${quoted}”` : 'Reply to your question'}</Para>}
    {part.body.trim() && <ClampedMarkdown id={part.message_id} text={part.body} fade={over(card(t), t.v('--app-opaque-content-surface'))} />}
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
      <ProviderMark kind={item.provider} size={14} /><Label color={t.text} size={13} truncate style={{ flexGrow: 1 }}>{item.title}</Label><SwapOnChange active={phase.word} style={{ flexShrink: 0 }}><Label color={item.status === 'failed' ? t.red : muted(t)} size={12}>{phase.word}</Label></SwapOnChange><Chevron open={expanded} color={muted(t)} />
    </div>
    <Para color={muted(t)} size={11}>{[item.role, item.model, item.workspace === 'worktree' ? 'Worktree' : 'Shared workspace', item.conflicts?.length ? `${item.conflicts.length} ${item.conflicts.length === 1 ? 'conflict' : 'conflicts'}` : ''].filter(Boolean).join(' · ')}</Para>
    {!expanded && <Para color={muted(t)} size={12} style={{ lineClamp: 2 }}>{resultPreview(item)}</Para>}
    <PanelPresence show={expanded}><PanelEnter><div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 8 }}>
      {(item.result || item.error) && <ClampedMarkdown id={`result:${item.task_id}`} text={item.result || item.error || ''} fade={over(card(t), t.v('--app-opaque-content-surface'))} />}
      <WorkspaceFacts item={item} /><div style={{ display: 'flex' }}><Button variant="subtle" testId={`result-open-${item.task_id}`} onClick={() => openThread(item.thread_id)}>Open agent</Button></div>
    </div></PanelEnter></PanelPresence>
  </div>
}
export const DelegatedResults = memo(function DelegatedResults({ items, at }: { items: AgentResultItem[]; at: string }) {
  const t = useTheme(), attention = items.filter(i => i.status !== 'completed' || i.conflicts?.length).length
  return <div testId="delegated-results" style={{ display: 'flex', flexDirection: 'column', padding: 12, borderRadius: 12, backgroundColor: card(t) }}>
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
  const tree = useTreeSlot()
  return <div testId="sent-to-row" paintTransform={tree.rise} style={{ position: 'relative', display: 'flex', flexDirection: 'column', paddingTop: 4, paddingBottom: 4 }}>
    <div testId={`sent-toggle-${block.id}`} role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'enter' || e.key === 'space') { keyboardAnswer(); setExpanded(!expanded) } }} onClick={() => setExpanded(!expanded)} style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 28, cursor: 'pointer' }}><Icon source={purposeIcon(input.purpose)} size={14} color={muted(t)} /><Label color={muted(t)} truncate style={{ flexGrow: 1 }}>{`${block.complete ? 'Sent to' : 'Sending to'} ${title} · ${purposeLabel(input.purpose)}`}</Label><SwapOnChange active={live.word} style={{ flexShrink: 0 }}><Label color={block.isError || live.state === 'failed' ? t.red : muted(t)} size={12}>{live.word}</Label></SwapOnChange><Chevron open={expanded} color={muted(t)} /></div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginLeft: 22 }}>
      <Para color={muted(t)} size={12} style={{ lineClamp: 1 }}>{`“${plainLine(input.body, 160)}”`}</Para>
      {live.reply && <Para color={muted(t)} size={12} style={{ lineClamp: 1 }}>{`Reply: “${plainLine(live.reply.body, 160)}”`}</Para>}
      {live.held && <Para color={muted(t)} size={12}>{`Waiting for you to approve it in ${title}.`}</Para>}
      {live.state === 'dismissed' && <Para color={muted(t)} size={12}>{`Dismissed in ${title}. It was not delivered.`}</Para>}
      <PanelPresence show={expanded}><PanelEnter><div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 8 }}><DetailSection label="Message"><ClampedMarkdown id={`sent:${block.id}`} text={input.body} fade={t.v('--app-opaque-content-surface')} /></DetailSection>{live.reply && <DetailSection label="Reply"><ClampedMarkdown id={`sent-reply:${block.id}`} text={live.reply.body} fade={t.v('--app-opaque-content-surface')} /></DetailSection>}{result?.waitTimedOut && !live.reply && <Para color={muted(t)} size={12}>No reply yet. It will arrive here when the thread answers.</Para>}</div></PanelEnter></PanelPresence>
      {(expanded || live.held) && input.threadId && <div style={{ display: 'flex' }}><Button variant="subtle" onClick={() => openThread(input.threadId)}>Open</Button></div>}
    </div>
    {tree.lines}
  </div>
}
