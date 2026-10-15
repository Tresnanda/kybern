import { Icon } from '../icons.tsx'
import { T } from '../transcript/glyphs.ts'
import { Tooltip, TooltipTrigger, TooltipContent } from '@gpuix/react'
import { useRef, useState, type ReactElement } from 'react'
import type { Thread } from '../../../../packages/kybern-client/src/types.ts'
import { formatTokenCount, subagentTokenCount, subagentPhaseWord, subagentTypeLabel, subagentSpan } from '../../../../packages/kybern-client/src/subagents.ts'
import { Label, ProviderMark, useTheme } from '../ui.tsx'
import { usePaneAccess } from '../state.ts'
import { Elapsed } from './Elapsed.tsx'
import { Para, muted } from '../transcript/kit.tsx'
export function SubagentHover({ thread, children }: { thread: Thread; children: ReactElement }) {
  const pane = usePaneAccess()
  const t = useTheme()
  const pointer = useRef(false), [open, setOpen] = useState(false)
  const [prompt] = useState(() => {
    const block = pane.get().open.blocks.find(b => b.kind === 'tool' && b.call.id === thread.subagent?.tool_call_id)
    if (block?.kind !== 'tool' || !block.call.input || typeof block.call.input !== 'object' || Array.isArray(block.call.input)) return null
    const input = block.call.input as Record<string, unknown>
    return typeof input.prompt === 'string' ? input.prompt : typeof input.task === 'string' ? input.task : null
  })
  const span = subagentSpan(thread)
  return <Tooltip open={open} onOpenChange={next => { if (!next || pointer.current) setOpen(next) }} onMouseEnter={() => { pointer.current = true }} onMouseLeave={() => { pointer.current = false }} delayDuration={400} style={{ flexGrow: 1, minWidth: 0 }}><TooltipTrigger asChild>{children}</TooltipTrigger><TooltipContent testId="subagent-hover" side="top" align="start" sideOffset={6} style={{ width: 320, padding: 12, paddingLeft: 14, paddingRight: 14, borderRadius: 12, backgroundColor: t.popover, borderWidth: 1, borderColor: t.border, display: 'flex', flexDirection: 'column', gap: 6 }}>
    <Label color={t.text} size={13} lineHeight={18} weight={500} truncate>{thread.title || 'Subagent'}</Label>
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><ProviderMark kind={thread.provider.kind} size={12} /><Label color={muted(t)} size={12} truncate style={{ flexGrow: 1 }}>{[subagentTypeLabel(thread.subagent?.agent_type), thread.model, thread.effort].filter(Boolean).join(' · ')}</Label><Label color={muted(t)} size={12}>{subagentPhaseWord(thread).replace(/^./, c => c.toUpperCase())} ·</Label>{span && <Elapsed startedAt={span.startedAt} endedAt={span.endedAt} />}</div>
    {prompt && <Para color={t.textSecondary} size={12} style={{ lineClamp: 3, borderTopWidth: 1, borderColor: t.border, marginTop: 2, paddingTop: 8 }}>{prompt}</Para>}
    {(thread.subagent?.detail || thread.subagent?.last_tool_name) && <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}><Icon source={T.hammer} size={12} color={muted(t)} /><Label color={muted(t)} size={12} truncate style={{ flexGrow: 1 }}>{thread.subagent.detail || `Used ${thread.subagent.last_tool_name}`}</Label></div>}
    {thread.subagent?.result && <Para color={t.textSecondary} size={12} style={{ lineClamp: 4 }}>{thread.subagent.result}</Para>}
    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}><Label color={t.textTertiary} size={11}>{[formatTokenCount(subagentTokenCount(thread)), thread.subagent?.stats?.tool_uses ? `${thread.subagent.stats.tool_uses} tool calls` : null].filter(Boolean).join(' · ')}</Label><Label color={t.textTertiary} size={11}>Click to open</Label></div>
  </TooltipContent></Tooltip>
}
