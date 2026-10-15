import { MatrixLoader } from '../MatrixLoader.tsx'
import type { Block } from '../../../../packages/kybern-client/src/transcript.ts'
import type { ProviderKind, RuntimeTask, Thread } from '../../../../packages/kybern-client/src/types.ts'
import { delegateTitle, parseDelegateInput, parseDelegateResult } from '../../../../packages/kybern-client/src/orchestrationTools.ts'
import { childStartedAt, childEndedAt, conflictsLabel, delegationRoleLabel, launchState, delegationState, workspaceLabel } from '../../../../packages/kybern-client/src/delegations.ts'
import { subagentSpan, subagentThreadPhase, subagentPhaseWord, subagentTypeLabel } from '../../../../packages/kybern-client/src/subagents.ts'
import { defaultOverrideText } from '../../../../packages/kybern-client/src/coordinatorSettings.ts'
import { toolLine } from '../../../desktop/src/lib/toolActivity.ts'
import { useNav } from '../nav/store.ts'
import { openThread } from '../nav/history.ts'
import { Icon } from '../icons.tsx'
import { Label, ProviderMark, useTheme } from '../ui.tsx'
import { T } from '../transcript/glyphs.ts'
import { Para, muted } from '../transcript/kit.tsx'
import { SubagentHover } from './Hover.tsx'
import { Elapsed } from './Elapsed.tsx'
const providers: readonly string[] = ['claude-code', 'codex', 'cursor', 'opencode', 'pi', 'omp']
export function LaunchMember({ block, thread, task, delegated = false, grouped = false }: { block: Block; thread?: Thread; task?: RuntimeTask; delegated?: boolean; grouped?: boolean }) {
  const t = useTheme(), catalog = useNav(s => s.providers)
  const call = block.kind === 'tool' ? block : null
  const input = call && delegated ? parseDelegateInput(call.call.input) : null
  const result = call && delegated ? parseDelegateResult(call.output) : null
  const id = thread?.id ?? result?.threadId
  const rawProvider = thread?.provider.kind ?? result?.provider ?? input?.provider
  const provider = providers.includes(rawProvider ?? '') ? rawProvider as ProviderKind : 'claude-code'
  const title = thread?.title || task?.title || (call ? delegated ? delegateTitle(call.call.input, result) : toolLine(call.call, call.complete).detail : '') || 'Subagent'
  const state = thread?.subagent ? { phase: subagentThreadPhase(thread), word: subagentPhaseWord(thread) } : result?.status && !thread ? delegationState(result.status) : launchState(thread, { complete: call?.complete ?? true, isError: call?.isError ?? task?.status === 'failed' })
  const info = thread?.delegation
  const meta = [delegated ? delegationRoleLabel(info?.role ?? input?.role ?? 'general') : subagentTypeLabel(thread?.subagent?.agent_type), thread?.model ?? result?.model ?? input?.model, delegated ? info ? workspaceLabel(info) : (result?.workspace ?? input?.workspace) === 'worktree' ? 'Own worktree' : 'Shared checkout' : null].filter(Boolean).join(' · ')
  const start = thread?.subagent ? subagentSpan(thread) : thread ? { startedAt: childStartedAt(thread), endedAt: childEndedAt(thread) } : state.phase === 'working' ? { startedAt: Date.parse(block.at), endedAt: null } : null
  const override = info?.default_override ? defaultOverrideText(info.default_override, catalog) : null
  if (!delegated) {
    const row = <div testId={`launch-member-${block.id}`} role="button" aria-label={`${id ? 'Open ' : ''}${title}, ${state.word}`} tabIndex={0} onClick={id ? () => openThread(id) : undefined} onKeyDown={event => { if (id && (event.key === 'enter' || event.key === 'space')) openThread(id) }} style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 8, height: grouped ? 32 : 40, paddingLeft: 6, paddingRight: 6, borderRadius: 8, minWidth: 0, cursor: id ? 'pointer' : 'default', hover: { backgroundColor: t.buttonSecondaryHover } }}>
      {grouped ? state.phase === 'working' ? <MatrixLoader /> : <Icon source={state.phase === 'failed' ? T.alert : T.check} size={14} color={muted(t)} /> : <ProviderMark kind={provider} size={12} />}
      <Label color={t.text} size={13} truncate style={{ maxWidth: '55%', flexShrink: 0 }}>{title}</Label>
      <Label color={muted(t)} size={12} truncate style={{ flexGrow: 1, minWidth: 0 }}>{grouped ? [subagentTypeLabel(thread?.subagent?.agent_type), thread?.subagent?.detail].filter(Boolean).join(' · ') : meta}</Label>
      {start?.startedAt && <Elapsed startedAt={start.startedAt} endedAt={start.endedAt} />}
      {!grouped && state.phase === 'working' && <MatrixLoader />}
      <Icon source={T.chevronRight} size={14} color={muted(t)} />
    </div>
    return <div style={{ display: 'flex', width: '100%', minWidth: 0 }}>{thread?.subagent ? <SubagentHover thread={thread}>{row}</SubagentHover> : row}</div>
  }
  const row = <div testId={`launch-member-${block.id}`} role="button" aria-label={`${id ? 'Open ' : ''}${title}, ${state.word}`} tabIndex={0} onClick={id ? () => openThread(id) : undefined} style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: 40, paddingLeft: 6, paddingRight: 6, borderRadius: 8, minWidth: 0, cursor: id ? 'pointer' : 'default', hover: { backgroundColor: t.buttonSecondaryHover } }}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderRadius: 12, backgroundColor: t.buttonSecondary, flexShrink: 0 }}><ProviderMark kind={provider} size={12} /></div>
    <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 }}><Label color={t.text} size={13} truncate>{title}</Label>{meta && <Label color={muted(t)} size={11} truncate>{meta}</Label>}</div>
    {!!info?.conflicts?.length && <Label color={t.red} size={11}>{conflictsLabel(info.conflicts.length)}</Label>}
    {start?.startedAt && <Elapsed startedAt={start.startedAt} endedAt={start.endedAt} />}
    <Label color={state.phase === 'failed' ? t.red : muted(t)} size={12}>{state.word}</Label>{id && <Icon source={T.chevronRight} size={14} color={muted(t)} />}
  </div>
  return <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>{thread?.subagent ? <SubagentHover thread={thread}>{row}</SubagentHover> : row}{override && <Para color={muted(t)} size={11} style={{ paddingLeft: 38, paddingBottom: 6 }}>{override}</Para>}</div>
}
