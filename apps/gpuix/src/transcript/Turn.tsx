import { agentItemTool, agentItemWriteResult, parseAgentItemResult, placeItemCards } from '../../../desktop/src/lib/agentItemTools.ts'
import { AgentItemCard } from '../coordinator/AgentItem.tsx'
// One turn (`Turn` in `views/Transcript.tsx`): the user's bubble, live work
// under "Working for", or the settled work (delegations visible, the rest
// folded under "Worked for"), then the answer with its error/stopped lines,
// the "Edited N files" card and the footer.
import { SubagentDivider } from '../subagents/Page.tsx'
import { memo, useEffect, useMemo, useState } from 'react'
import { calendarDateKey, calendarDateLabel, clockTime, elapsedSince, plural } from '../../../desktop/src/lib/format.ts'
import { isImageGenerationTool } from '../../../desktop/src/lib/toolActivity.ts'
import { responseImages } from '../../../desktop/src/lib/responseImages.ts'
import { isAgentLaunchBlock, isDelegationLaunchBlock, isOrchestrationBlock } from '../../../desktop/src/lib/workChunks.ts'
import { buildWorkHierarchy, shouldRevealLiveText, type Block, type TurnGroup } from '../../../../packages/kybern-client/src/transcript.ts'
import type { Diff, RuntimeTask, ThreadId } from '../../../../packages/kybern-client/src/types.ts'
import { useApp } from '../state.ts'
import { Icon } from '../icons.tsx'
import { MatrixLoader, useLoaderStep } from '../MatrixLoader.tsx'
import { clockDuration, Label, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { CopyAction, SaveToNoteAction, UserBubble } from './bubble.tsx'
import { T } from './glyphs.ts'
import { ResponseImage } from './images.tsx'
import { alpha, cachedMarkdownTheme, Chevron, fg, META, muted, Para, ROW_LINE, RowIcon, TEXT } from './kit.tsx'
import { over } from '../theme.ts'
import { Collapse, Rise } from '../motion/kit.tsx'
import { Shimmer } from './motion.tsx'
import { WorkRows, type RowContext } from './rows.tsx'
import { filePatch, hydrateToolOutput, loadFilePatch, reportError, revertTo, useChildThreads, useRowState, useTurnDiff, type ToolBlock } from './store.ts'

const isTaskActive = (task: RuntimeTask) => task.status === 'pending' || task.status === 'running' || task.status === 'waiting' || task.status === 'stopping'

export const turnTimestamp = (group: TurnGroup) => group.user?.at ?? group.work[0]?.at ?? group.end?.at ?? ''

/** Runtime tasks this turn launched, keyed by the tool call that started them. */
function tasksOf(work: readonly Block[]): Map<string, RuntimeTask> {
  const map = new Map<string, RuntimeTask>()
  for (const block of work) if (block.kind === 'runtime_task' && block.task.tool_call_id) map.set(block.task.tool_call_id, block.task)
  return map
}

export function DateSeparator({ at }: { at: string }) {
  const t = useTheme()
  const line = alpha(t.border, 0.55)
  return (
    <div testId={`date-${calendarDateKey(at)}`} style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: 16, paddingBottom: 16 }}>
      <div style={{ height: 1, minWidth: 16, flexGrow: 1, backgroundColor: line }} />
      <Label color={muted(t, 0.55)} size={11} weight={500} lineHeight={16}>
        {calendarDateLabel(at)}
      </Label>
      <div style={{ height: 1, minWidth: 16, flexGrow: 1, backgroundColor: line }} />
    </div>
  )
}

/** "Working for 12s": the orbit loader and an elapsed clock read on the loader's
 *  steps (a 1s timer only under Reduce Motion, when the clock is still). */
function WorkingHeader({ since }: { since: string }) {
  const t = useTheme()
  useLoaderStep()
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!REDUCED_MOTION) return
    const id = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [])
  return (
    <div testId="working-header" style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: -2 }}>
      <div style={{ display: 'flex', width: 16, justifyContent: 'center' }}>
        <MatrixLoader alpha={0.7} />
      </div>
      <Label color={muted(t)} lineHeight={TEXT.lineHeight}>
        {`Working for ${clockDuration(elapsedSince(since, Date.now()))}`}
      </Label>
    </div>
  )
}

function itemCards(group: TurnGroup) {
  return placeItemCards(group.work.flatMap(block => {
    if (block.kind !== 'tool' || !block.complete || block.isError || !agentItemTool(block.call.name)?.write) return []
    const result = agentItemWriteResult(parseAgentItemResult(block.output))
    return result ? [{ id: block.call.id, result }] : []
  }), group.answer?.text)
}

export const Turn = memo(function Turn({ group, threadId, isLast, threadRunning }: { group: TurnGroup; threadId: ThreadId; isLast: boolean; threadRunning: boolean }) {
  const t = useTheme()
  const subagentThread = useApp(s => s.open.thread?.subagent ? s.open.thread : null)
  const subagent = !!subagentThread
  const firstUserId = useApp(s => s.open.blocks.find(b => b.kind === 'user')?.id)
  // A long live turn can start before the loaded page, so its user message (and
  // with it `running`) is missing; the thread's status still says it is live.
  const running = group.running || (threadRunning && isLast && !group.end)
  const tasksByToolCall = useMemo(() => tasksOf(group.work), [group.work])
  const hierarchy = useMemo(() => buildWorkHierarchy(group.work), [group.work])
  // Launch rows open the child thread they started; look the children up only when there are launches.
  const launches = useMemo(
    () => group.work.some((b) => (b.kind === 'tool' && (isAgentLaunchBlock(b, tasksByToolCall.get(b.call.id)) || isDelegationLaunchBlock(b))) || (b.kind === 'runtime_task' && b.task.kind === 'agent')),
    [group.work, tasksByToolCall],
  )
  const children = useChildThreads(threadId, launches)
  const cards = useMemo(() => itemCards(group), [group.work, group.answer?.text])
  const ctx = useMemo<RowContext>(() => ({ threadId, tasksByToolCall, childrenByParent: hierarchy.childrenByParent, children, inlineItemIds: running ? undefined : cards.inlineCallIds }), [threadId, tasksByToolCall, hierarchy, children, cards, running])
  const settled = useMemo(() => {
    const agentBlocks: Block[] = []
    const disclosureBlocks: Block[] = []
    for (const block of hierarchy.roots) {
      if (
        (block.kind === 'tool' && isAgentLaunchBlock(block, tasksByToolCall.get(block.call.id))) ||
        (block.kind === 'runtime_task' && block.task.kind === 'agent') ||
        isOrchestrationBlock(block)
      )
        agentBlocks.push(block)
      else if (block.kind !== 'visual') disclosureBlocks.push(block)
    }
    return { agentBlocks, disclosureBlocks }
  }, [hierarchy, tasksByToolCall])
  const [expanded, setExpanded] = useRowState(`work:${group.turnId}`, false)
  const hasLiveWork = group.work.some(
    (b) =>
      (b.kind === 'tool' && !b.complete) ||
      (b.kind === 'runtime_task' && isTaskActive(b.task)) ||
      (b.kind === 'assistant' && !b.complete && (b.id === group.liveThinkingId || shouldRevealLiveText(b.text, b.complete))) ||
      (b.kind === 'approval' && !b.decision),
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {subagentThread && group.user?.id === firstUserId && <SubagentDivider thread={subagentThread} />}
      {group.user && (
        <div style={{ paddingBottom: running ? 20 : 16 }}>
          <UserBubble parts={group.user.message.parts} at={group.user.at} clampLines={subagent ? 6 : undefined} />
        </div>
      )}

      {running && (
        <div testId="live-work" style={{ display: 'flex', flexDirection: 'column', paddingBottom: 8 }}>
          <WorkingHeader since={group.user?.at ?? group.work[0]?.at ?? ''} />
          {hierarchy.roots.length > 0 && (
            <div style={{ marginTop: 4 }}>
              <WorkRows compact blocks={hierarchy.roots} ctx={ctx} tone="bright" liveTextId={group.liveTextId} liveThinkingId={group.liveThinkingId} />
            </div>
          )}
          {/* `thinkingRow`: `t-row-enter` each time it mounts. */}
          {!hasLiveWork && (
            <Rise kind="row" style={{ marginTop: 6 }}>
              <Shimmer text="Thinking" color={muted(t)} lineHeight={TEXT.lineHeight} />
            </Rise>
          )}
        </div>
      )}

      {!running && (settled.agentBlocks.length > 0 || settled.disclosureBlocks.length > 0) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 12 }}>
          {settled.agentBlocks.length > 0 && <WorkRows compact blocks={settled.agentBlocks} ctx={ctx} />}
          {settled.disclosureBlocks.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', paddingTop: 4, paddingBottom: 4 }}>
              <div testId={`worked-${group.turnId}`} onClick={() => setExpanded(!expanded)} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <RowIcon source={T.hammer} color={muted(t)} />
                <Label color={muted(t)} lineHeight={ROW_LINE} truncate style={{ flexGrow: 1, hover: { color: t.text } }}>
                  {group.end ? `Worked for ${clockDuration(group.end.durationMs)}` : 'Worked'}
                </Label>
                <Chevron open={expanded} color={muted(t, 0.65)} />
              </div>
              <Collapse open={expanded} testId={`worked-panel-${group.turnId}`}>
                <div style={{ paddingTop: 2, marginLeft: 22 }}>
                  <WorkRows compact blocks={settled.disclosureBlocks} ctx={ctx} />
                </div>
              </Collapse>
            </div>
          )}
          <div style={{ height: 1, marginTop: 4, backgroundColor: t.border }} />
        </div>
      )}

    </div>
  )
})

export const AnswerImages = memo(function AnswerImages({ group, threadId }: { group: TurnGroup; threadId: ThreadId }) {
  const t = useTheme()
  const imageTools = useMemo(() => group.work.filter((b): b is ToolBlock => b.kind === 'tool' && b.origin.kind === 'root' && isImageGenerationTool(b.call)), [group.work])
  const images = useMemo(() => {
    const all = [...group.images.map((image) => ({ source: image.source, label: 'Agent image' })), ...imageTools.flatMap((b) => responseImages(b.output))]
    return [...new Map(all.map((image) => [image.source, image])).values()]
  }, [group.images, imageTools])
  // Generated images are answer content even while the fold is closed
  // (`GeneratedImageOutputLease`): fetch their omitted results once settled.
  useEffect(() => {
    for (const block of imageTools) if (block.outputOmitted) void hydrateToolOutput(threadId, block)
  }, [imageTools, threadId])
  return <div style={{ display: 'flex', flexDirection: 'column' }}>
          {images.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {images.map((image) => (
                <ResponseImage key={image.source} source={image.source} label={image.label} />
              ))}
            </div>
          )}
  </div>
})

export const TurnFooter = memo(function TurnFooter({ group, threadId, isLast }: { group: TurnGroup; threadId: ThreadId; isLast: boolean }) {
  const t = useTheme()
  const subagentThread = useApp(s => s.open.thread?.subagent ? s.open.thread : null)
  const answerText = group.answer?.text ?? ''
  const cards = useMemo(() => itemCards(group), [group.work, group.answer?.text])
  useEffect(() => {
    if (!group.end) return
    for (const block of group.work) if (block.kind === 'tool' && block.outputOmitted && agentItemTool(block.call.name)?.write) void hydrateToolOutput(threadId, block)
  }, [threadId, group.work, group.end])
  const diff = useTurnDiff(threadId, group.turnId, !!group.end)
  return <div style={{ display: 'flex', flexDirection: 'column', paddingBottom: 10 }}>
          {group.end && cards.below.map(card => <AgentItemCard key={card.id} result={card.result} inset={false} />)}
          {group.end?.error && (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 8 }}>
              <Icon source={T.alert} size={14} color={t.red} style={{ marginTop: 4 }} />
              <Para color={t.red} selectable style={{ flexGrow: 1 }}>
                {group.end.error}
              </Para>
            </div>
          )}
          {group.end?.stopReason === 'interrupted' && <Para color={muted(t)}>Stopped.</Para>}
          {diff && diff.files.length > 0 && <EditedFilesCard diff={diff} threadId={threadId} turnId={group.turnId} canUndo={isLast} />}
          {group.reverted && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
              <Icon source={T.undo} size={12} color={muted(t)} />
              <Para color={muted(t)}>Reverted to before this turn</Para>
            </div>
          )}
          {(group.answer || group.end) && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2, marginLeft: -5 }}>
              <CopyAction text={answerText} testId="answer-copy" />
              <SaveToNoteAction text={answerText} testId="answer-save-note" />
              {group.end?.at && (
                <Label color={muted(t)} size={META.size} lineHeight={META.lineHeight}>
                  {clockTime(group.end.at)}
                </Label>
              )}
            </div>
          )}
          {isLast && subagentThread && <SubagentDivider thread={subagentThread} end />}
        </div>
})

const MAX_VISIBLE_CHANGED_FILES = 5

function DiffStat({ additions, deletions }: { additions: number; deletions: number }) {
  const t = useTheme()
  return (
    <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
      <Label color={t.v('--color-decoration-added')} lineHeight={TEXT.lineHeight}>{`+${additions}`}</Label>
      <Label color={t.v('--color-decoration-deleted')} lineHeight={TEXT.lineHeight}>{`-${deletions}`}</Label>
    </div>
  )
}

/** "Edited N files": totals, Undo on the last turn, and per-file rows that unfold
 *  their patch in a native `<diff>`. */
function EditedFilesCard({ diff, threadId, turnId, canUndo }: { diff: Diff; threadId: ThreadId; turnId: string; canUndo: boolean }) {
  const t = useTheme()
  const [expanded, setExpanded] = useRowState(`files:${turnId}`, true)
  const [showAll, setShowAll] = useRowState(`files-all:${turnId}`, false)
  const [reverting, setReverting] = useState(false)
  const adds = diff.files.reduce((n, f) => n + f.additions, 0)
  const dels = diff.files.reduce((n, f) => n + f.deletions, 0)
  const head = diff.files.slice(0, MAX_VISIBLE_CHANGED_FILES)
  const rest = diff.files.slice(MAX_VISIBLE_CHANGED_FILES)
  const border = t.variant === 'dark' ? alpha(t.borderLight, 0.55) : t.borderLight
  const radius = 10.4
  const undo = async () => {
    setReverting(true)
    try {
      await revertTo(threadId, turnId)
    } catch (e) {
      reportError('Unable to revert', e)
    } finally {
      setReverting(false)
    }
  }
  return (
    <div testId="edited-files" style={{ display: 'flex', flexDirection: 'column', marginTop: 8, marginBottom: 4, borderRadius: radius, borderWidth: 1, borderColor: border }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          paddingLeft: 12,
          paddingRight: 12,
          paddingTop: 6,
          paddingBottom: 6,
          backgroundColor: over(alpha(t.codeSurface, 0.4), t.surface),
          borderTopLeftRadius: radius - 1,
          borderTopRightRadius: radius - 1,
          borderBottomLeftRadius: expanded ? 0 : radius - 1,
          borderBottomRightRadius: expanded ? 0 : radius - 1,
          ...(expanded ? { borderBottomWidth: 1, borderColor: border } : {}),
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <Icon source={T.changes} size={14} color={muted(t, 0.7)} />
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <Label color={fg(t, 0.92)} lineHeight={TEXT.lineHeight} truncate>
              {`Edited ${plural(diff.files.length, 'file')}`}
            </Label>
            {(adds > 0 || dels > 0) && <DiffStat additions={adds} deletions={dels} />}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {canUndo && (
            <div testId="edited-undo" onClick={reverting ? undefined : () => void undo()} style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
              <Label color={muted(t)} style={{ hover: { color: t.text } }}>
                Undo
              </Label>
              {reverting ? <MatrixLoader /> : <Icon source={T.undo} size={12} color={muted(t)} />}
            </div>
          )}
          <div testId="edited-files-toggle" onClick={() => setExpanded(!expanded)} style={{ display: 'flex', padding: 4, borderRadius: 6, cursor: 'pointer', hover: { backgroundColor: t.buttonSecondaryHover } }}>
            <Chevron open={expanded} color={muted(t, t.variant === 'dark' ? 0.5 : 0.7)} />
          </div>
        </div>
      </div>
      {/* `DisclosureRegion`s: the file list, and the files past the first five inside it. */}
      <Collapse open={expanded} testId="edited-files-panel">
          {head.map((f, i) => (
            <EditedFileRow key={f.path} file={f} threadId={threadId} turnId={turnId} first={i === 0} border={border} />
          ))}
          {rest.length > 0 && (
            <Collapse open={showAll}>
              {rest.map((f) => <EditedFileRow key={f.path} file={f} threadId={threadId} turnId={turnId} border={border} />)}
            </Collapse>
          )}
          {rest.length > 0 && (
            <div
              onClick={() => setShowAll(!showAll)}
              style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, borderTopWidth: 1, borderColor: border, cursor: 'pointer', hover: { backgroundColor: t.buttonSecondaryHover } }}
            >
              <Chevron open={showAll} color={muted(t)} />
              <Label color={muted(t)}>{showAll ? 'Show less' : `Show ${plural(rest.length, 'more file')}`}</Label>
            </div>
          )}
      </Collapse>
    </div>
  )
}

function EditedFileRow({ file, threadId, turnId, first, border }: { file: Diff['files'][number]; threadId: ThreadId; turnId: string; first?: boolean; border: string }) {
  const t = useTheme()
  const [open, setOpen] = useRowState(`file:${turnId}:${file.path}`, false)
  // The patch is cached outside the row: the virtual list and the card's
  // disclosure both remount rows, and an open row must not come back empty.
  const [patch, setPatch] = useState(() => filePatch(threadId, turnId, file.path))
  const [state, setState] = useState<'idle' | 'loading' | 'failed'>('idle')
  const load = () => {
    if (patch || state === 'loading' || file.binary) return
    setState('loading')
    loadFilePatch(threadId, file.path, turnId)
      .then((result) => {
        setPatch(result)
        setState('idle')
      })
      .catch(() => setState('failed'))
  }
  useEffect(() => {
    if (open) load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  const toggle = () => setOpen(!open)
  // Open once the patch is here, so the tween runs to the diff's real height
  // instead of the loading line's; a slow load shows "Loading changes…" first.
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (state !== 'loading') return setSlow(false)
    const id = setTimeout(() => setSlow(true), 150)
    return () => clearTimeout(id)
  }, [state])
  const ready = !!patch || !!file.binary || state === 'failed' || slow
  return (
    <div style={{ display: 'flex', flexDirection: 'column', ...(first ? {} : { borderTopWidth: 1, borderColor: border }) }}>
      <div
        testId={`edited-file-${file.path}`}
        onClick={toggle}
        style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 12, paddingRight: 8, paddingTop: 10, paddingBottom: 10, minWidth: 0, cursor: 'pointer', hover: { backgroundColor: t.variant === 'dark' ? 'rgba(0, 0, 0, 0)' : t.buttonSecondaryHover } }}
      >
        <Chevron open={open} color={muted(t, 0.6)} />
        <Icon source={T.file} size={16} color={t.text} style={{ opacity: t.variant === 'dark' ? 0.8 : 0.7 }} />
        <Label color={t.text} lineHeight={TEXT.lineHeight} truncate style={{ flexShrink: 1, hover: { textDecoration: 'underline' } }}>
          {file.path}
        </Label>
        <div style={{ flexGrow: 1 }} />
        <DiffStat additions={file.additions} deletions={file.deletions} />
      </div>
      <Collapse open={open && ready}>
        <div style={{ display: 'flex', flexDirection: 'column', borderTopWidth: 1, borderColor: border, backgroundColor: t.v('--background') }}>
          {file.binary ? (
            <Para color={muted(t, 0.75)} size={11} style={{ paddingLeft: 12, paddingTop: 8, paddingBottom: 8 }}>Binary file</Para>
          ) : state === 'loading' ? (
            <div style={{ paddingLeft: 12, paddingTop: 8, paddingBottom: 8 }}>
              <Shimmer text="Loading changes…" color={muted(t, 0.75)} size={11} lineHeight={16} />
            </div>
          ) : state === 'failed' ? (
            <Para color={t.red} size={11} style={{ paddingLeft: 12, paddingTop: 8, paddingBottom: 8 }}>Unable to load this file’s changes.</Para>
          ) : patch ? (
            <>
              {/* The native diff always paints a file header; it sits clipped above the
                  wrapper's top edge, so the card's file row stays the only header. */}
              <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
                <diff patch={patch.text} wordDiff maxLines={400} theme={bodyDiffTheme(t)} style={{ minWidth: 0, marginTop: -DIFF_HEADER }} />
              </div>
              {patch.truncated && <Para color={muted(t, 0.75)} size={11} style={{ paddingLeft: 12, paddingTop: 6, paddingBottom: 8 }}>The patch was truncated.</Para>}
            </>
          ) : null}
        </div>
      </Collapse>
    </div>
  )
}



/** A known file-header height for the native diff, so it can be clipped exactly. */
const DIFF_HEADER = 30
const bodyThemes = new WeakMap<object, ReturnType<typeof cachedMarkdownTheme>>()
function bodyDiffTheme(t: ReturnType<typeof useTheme>): ReturnType<typeof cachedMarkdownTheme> {
  const cached = bodyThemes.get(t)
  if (cached) return cached
  const base = cachedMarkdownTheme(t)
  const theme = { ...base, metrics: { ...base.metrics, diffFileHeaderHeight: DIFF_HEADER } }
  bodyThemes.set(t, theme)
  return theme
}
