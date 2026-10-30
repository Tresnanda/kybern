import { MatrixLoader } from '../MatrixLoader.tsx'
import type { Block } from '../../../../packages/kybern-client/src/transcript.ts'
import type { ProviderKind, RuntimeTask, Thread } from '../../../../packages/kybern-client/src/types.ts'
import { delegateTitle, parseDelegateInput, parseDelegateResult } from '../../../../packages/kybern-client/src/orchestrationTools.ts'
import { childStartedAt, childEndedAt, conflictsLabel, delegationMeta, launchState, delegationState, workspaceLabel } from '../../../../packages/kybern-client/src/delegations.ts'
import { subagentSpan, subagentThreadPhase, subagentPhaseWord, subagentTypeLabel } from '../../../../packages/kybern-client/src/subagents.ts'
import { defaultOverrideText } from '../../../../packages/kybern-client/src/coordinatorSettings.ts'
import { toolLine } from '../../../../packages/kybern-client/src/toolActivity.ts'
import { useNav } from '../nav/store.ts'
import { openThread } from '../nav/history.ts'
import { Icon } from '../icons.tsx'
import { Label, ProviderMark, useTheme } from '../ui.tsx'
import { T } from '../transcript/glyphs.ts'
import { Para, muted } from '../transcript/kit.tsx'
import { SubagentHover } from './Hover.tsx'
import { Elapsed } from './Elapsed.tsx'
import { SwapOnChange } from '../motion/kit.tsx'
import { useState, type ReactNode } from 'react'
import { N } from '../nav/glyphs.ts'
import { Tip } from '../nav/overlay.tsx'
import { IconButton } from '../kit/IconButton.tsx'
import { fadeTo } from '../shell/motion.ts'
import { usePaneAccess } from '../state.ts'
import { openTabFromPane } from '../tabs/open.ts'
import { MachineBadge } from '../sidebar/MachineBadge.tsx'
import { glyphOfMachine, machineHub } from '../machines/index.ts'
const providers: readonly string[] = ['claude-code', 'codex', 'cursor', 'opencode', 'pi', 'omp']
export function LaunchMember({ block, thread, task, delegated = false, grouped = false }: { block: Block; thread?: Thread & { machineId?: string }; task?: RuntimeTask; delegated?: boolean; grouped?: boolean }) {
  const t = useTheme(), catalog = useNav(s => s.providers)
  const call = block.kind === 'tool' ? block : null
  const input = call && delegated ? parseDelegateInput(call.call.input) : null
  const result = call && delegated ? parseDelegateResult(call.output) : null
  const id = thread?.id ?? result?.threadId
  const rawProvider = thread?.provider.kind ?? result?.provider ?? input?.provider
  const provider = providers.includes(rawProvider ?? '') ? rawProvider as ProviderKind : 'claude-code'
  const title = thread?.title || task?.title || (call ? delegated ? delegateTitle(call.call.input, result) : toolLine(call.call, call.complete).detail : '') || 'Subagent'
  const known = thread?.subagent ? { phase: subagentThreadPhase(thread), word: subagentPhaseWord(thread) } : result?.status && !thread ? delegationState(result.status) : launchState(thread, { complete: call?.complete ?? true, isError: call?.isError ?? task?.status === 'failed' })
  // A delegated agent waiting on a request says so, a question as "Needs input" (the sidebar's words), even before its thread loads.
  const pending = useNav(s => delegated && id ? s.pending[id]?.own : undefined)
  const state = pending && (known.phase === 'working' || known.phase === 'waiting') ? { phase: 'waiting' as const, word: pending === 'question' ? 'Needs input' : 'Needs approval' } : known
  const info = thread?.delegation
  // The machine shows as its badge on the avatar and by name after the model ("Sonnet 5.5 · on Windows PC"), and the workspace only when
  // the child has its own worktree: a shared checkout is the default and says nothing. Subagent rows keep their type label.
  const machineId = delegated ? thread?.machineId ?? result?.machine?.id : undefined
  const machineName = machineId ? machineHub().set.displayName(machineId) : undefined
  const meta = delegated
    ? delegationMeta(thread?.model ?? result?.model ?? input?.model, provider, catalog, info ? workspaceLabel(info) : (result?.workspace ?? input?.workspace) === 'worktree' ? 'Own worktree' : null, machineName)
    : [subagentTypeLabel(thread?.subagent?.agent_type), thread?.model ?? result?.model ?? input?.model].filter(Boolean).join(' · ')
  const start = thread?.subagent ? subagentSpan(thread) : thread ? { startedAt: childStartedAt(thread), endedAt: childEndedAt(thread) } : state.phase === 'working' ? { startedAt: Date.parse(block.at), endedAt: null } : null
  const override = info?.default_override ? defaultOverrideText(info.default_override, catalog) : null
  if (!delegated) {
    const row = <div testId={`launch-member-${block.id}`} role="button" aria-label={`${id ? 'Open ' : ''}${title}, ${state.word}`} tabIndex={0} onClick={id ? () => openThread(id, thread?.machineId) : undefined} onKeyDown={event => { if (id && (event.key === 'enter' || event.key === 'space')) openThread(id, thread?.machineId) }} style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 8, height: grouped ? 32 : 40, paddingLeft: 6, paddingRight: 6, borderRadius: 8, minWidth: 0, cursor: id ? 'pointer' : 'default', hover: { backgroundColor: t.buttonSecondaryHover } }}>
      {grouped ? <SwapOnChange kind="icon" active={state.phase} style={{ width: 14, height: 14, flexShrink: 0 }}>{state.phase === 'working' ? <MatrixLoader /> : <Icon source={state.phase === 'failed' ? T.alert : T.check} size={14} color={muted(t)} />}</SwapOnChange> : <ProviderMark kind={provider} size={12} />}
      <Label color={t.text} size={13} truncate style={{ maxWidth: '55%', flexShrink: 0 }}>{title}</Label>
      <Label color={muted(t)} size={12} truncate style={{ flexGrow: 1, minWidth: 0 }}>{grouped ? [subagentTypeLabel(thread?.subagent?.agent_type), thread?.subagent?.detail].filter(Boolean).join(' · ') : meta}</Label>
      {start?.startedAt && <Elapsed startedAt={start.startedAt} endedAt={start.endedAt} />}
      {!grouped && state.phase === 'working' && <MatrixLoader />}
      <Icon source={T.chevronRight} size={14} color={muted(t)} />
    </div>
    return <PinRow id={thread?.machineId ? undefined : id} title={title}>{thread?.subagent ? <SubagentHover thread={thread}>{row}</SubagentHover> : row}</PinRow>
  }
  // Avatar · title over meta · then one trailing column pinned to the card's edge: the status word over the elapsed clock, both
  // right-aligned, so every row's status lines up under the group's chevron however long its title is.
  const row = (pin: ReactNode) => <div testId={`launch-member-${block.id}`} role="button" aria-label={`${id ? 'Open ' : ''}${title}${machineName ? ` on ${machineName}` : ''}, ${state.word}`} tabIndex={0} onClick={id ? () => openThread(id, thread?.machineId) : undefined} style={{ display: 'flex', gap: 10, alignItems: 'center', flexGrow: 1, minHeight: 44, paddingLeft: 6, paddingRight: 5, borderRadius: 8, minWidth: 0, cursor: id ? 'pointer' : 'default', hover: { backgroundColor: t.buttonSecondaryHover } }}>
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderRadius: 12, backgroundColor: t.buttonSecondary, flexShrink: 0 }}>
      <ProviderMark kind={provider} size={12} />
      {machineId && <div style={{ position: 'absolute', right: -4, bottom: -3, display: 'flex' }}><MachineBadge glyph={glyphOfMachine(machineId)} size={12} name={machineName} testId={`launch-machine-${block.id}`} /></div>}
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
      <Label color={t.text} size={13} lineHeight={18} truncate>{title}</Label>
      {meta && <Label color={muted(t)} size={11} lineHeight={15} truncate>{meta}</Label>}
    </div>
    {!!info?.conflicts?.length && <Label color={t.red} size={11} style={{ flexShrink: 0 }}>{conflictsLabel(info.conflicts.length)}</Label>}
    {pin}
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', flexShrink: 0 }}>
      <SwapOnChange active={state.word} style={{ flexShrink: 0 }}><Label color={state.phase === 'failed' ? t.red : state.phase === 'waiting' ? t.text : muted(t)} size={12} lineHeight={18} weight={state.phase === 'waiting' ? 500 : 400}>{state.word}</Label></SwapOnChange>
      {start?.startedAt && <Elapsed startedAt={start.startedAt} endedAt={start.endedAt} tabular />}
    </div>
    <Icon source={T.chevronRight} size={14} color={id ? muted(t) : 'rgba(0, 0, 0, 0)'} style={{ flexShrink: 0 }} />
  </div>
  return <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}><PinRow id={thread?.machineId ? undefined : id} title={title} inline>{row}</PinRow>{override && <Para color={muted(t)} size={11} style={{ paddingLeft: 40, paddingBottom: 6 }}>{override}</Para>}</div>
}

/**
 * A row with "Pin as tab" (ADE-54): the child's live transcript opens as a tab of this thread instead of replacing the page. Used
 * by launch members and the transcript's "Delegating …" row. The pin shows while the pointer is over the row or it has keyboard
 * focus (it stays reachable by Tab).
 */
export function PinRow({ id, title, children, inline = false }: { id?: string; title: string; children: ReactNode | ((pin: ReactNode) => ReactNode); inline?: boolean }) {
  const pane = usePaneAccess()
  const [hover, setHover] = useState(false)
  const [focused, setFocused] = useState(false)
  const render = (pin: ReactNode) => typeof children === 'function' ? children(pin) : children
  if (!id) return <div style={{ display: 'flex', width: '100%', minWidth: 0 }}>{render(null)}</div>
  const pin = () => openTabFromPane(pane.id, { kind: 'thread', id, title })
  const shown = hover || focused
  const button = <Tip label="Pin as tab" side="top">
    <div paintTransform={fadeTo(shown ? 1 : 0).paintTransform} style={{ display: 'flex', flexShrink: 0, ...fadeTo(shown ? 1 : 0).style }}>
      <IconButton testId={`pin-child-${id}`} size="sm" icon={N.pin} glyph={13} label={`Pin ${title} as a tab`} onClick={pin} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} />
    </div>
  </Tip>
  // `inline`: the row places the pin itself (before its trailing status), so rows with and without a pin end at the same edge.
  if (inline) return <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} style={{ display: 'flex', width: '100%', minWidth: 0 }}>{render(button)}</div>
  return <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} style={{ display: 'flex', alignItems: 'center', width: '100%', minWidth: 0, gap: 2 }}>
    {/* A column, so a row without its own width (the transcript's `RowLine`) stretches to the pin. */}
    <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 }}>{render(null)}</div>
    {button}
  </div>
}
