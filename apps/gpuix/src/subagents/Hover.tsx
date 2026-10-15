import { Tooltip, TooltipTrigger, TooltipContent } from '@gpuix/react'
import { useRef, useState, type ReactElement } from 'react'
import type { Thread } from '../../../../packages/kybern-client/src/types.ts'
import { formatTokenCount, subagentTokenCount, subagentPhaseWord, subagentTypeLabel, subagentSpan } from '../../../../packages/kybern-client/src/subagents.ts'
import { Label, ProviderMark, useTheme } from '../ui.tsx'
import { getState } from '../state.ts'
import { Elapsed } from './Elapsed.tsx'
import { Para, muted } from '../transcript/kit.tsx'
export function SubagentHover({ thread, children }: { thread: Thread; children: ReactElement }) {
  const t = useTheme()
  const pointer = useRef(false), [open, setOpen] = useState(false)
  const [prompt] = useState(() => {
    const block = getState().open.blocks.find(b => b.kind === 'tool' && b.call.id === thread.subagent?.tool_call_id)
    if (block?.kind !== 'tool' || !block.call.input || typeof block.call.input !== 'object' || Array.isArray(block.call.input)) return null
    const input = block.call.input as Record<string, unknown>
    return typeof input.prompt === 'string' ? input.prompt : typeof input.task === 'string' ? input.task : null
  })
  const span = subagentSpan(thread)
  return <Tooltip open={open} onOpenChange={next => { if (!next || pointer.current) setOpen(next) }} onMouseEnter={() => { pointer.current = true }} onMouseLeave={() => { pointer.current = false }} delayDuration={400} style={{ flexGrow: 1, minWidth: 0 }}><TooltipTrigger asChild>{children}</TooltipTrigger><TooltipContent testId="subagent-hover" side="top" align="start" sideOffset={6} style={{ width: 300, padding: 12, borderRadius: 12, backgroundColor: t.popover, borderWidth: 1, borderColor: t.border, display: 'flex', flexDirection: 'column', gap: 6 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><ProviderMark kind={thread.provider.kind} /><Label color={t.text} size={13} weight={500} truncate>{thread.title || 'Subagent'}</Label></div>
    <Para color={muted(t)} size={11}>{[subagentTypeLabel(thread.subagent?.agent_type), thread.model, subagentPhaseWord(thread), formatTokenCount(subagentTokenCount(thread))].filter(Boolean).join(' · ')}</Para>
    {span && <Elapsed startedAt={span.startedAt} endedAt={span.endedAt} />}
    {prompt && <Para color={t.textSecondary} size={12} style={{ lineClamp: 3 }}>{prompt}</Para>}
    {thread.subagent?.last_tool_name && <Para color={muted(t)} size={11}>{`Latest tool: ${thread.subagent.last_tool_name}`}</Para>}
    {thread.subagent?.detail && <Para color={t.textSecondary} size={12} style={{ lineClamp: 4 }}>{thread.subagent.detail}</Para>}
    {thread.subagent?.result && <Para color={t.textSecondary} size={12} style={{ lineClamp: 4 }}>{thread.subagent.result}</Para>}
  </TooltipContent></Tooltip>
}
