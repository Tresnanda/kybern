import { useWorkspaceProgress } from '../groups/store.ts'
import { editedFilesTitle, groupFilesByRepo, includedMembers, stripRepoPrefix, workspaceProgressLabel } from '../../../../packages/kybern-client/src/groups.ts'
import { OutsideChange } from './OutsideChange.tsx'
import { openTab } from '../tabs/open.ts'
import { expiredQuestion } from '../../../../packages/kybern-client/src/requestCards.ts'
import type { PublicInstance } from '@gpuix/react'
import { chooseTab, setDock } from '../dock/store.ts'
import { getFileIconName } from '../shared/lib/kit/fileIcons.ts'
import { diffFileIcons } from '../native/diff-file-icons.ts'
import { desktopDiffTheme } from '../native/diff.ts'
import { GlassEdge } from '../kit/GlassEdge.tsx'
import { raisedRim, useGlass } from '../platform/glass.ts'
import { VisualCard } from './Visual.tsx'
import { agentItemTool, agentItemWriteResult, parseAgentItemResult, placeItemCards } from '../../../../packages/kybern-client/src/agentItemTools.ts'
import { AgentItemCard } from '../coordinator/AgentItem.tsx'
// One turn (`Turn` in `views/Transcript.tsx`): the user's bubble, live work
// under "Working for", or the settled work (delegations visible, the rest
// folded under "Worked for"), then the answer with its error/stopped lines,
// the "Edited N files" card and the footer.
import { SubagentDivider } from '../subagents/Page.tsx'
import { Fragment, memo, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { N } from '../nav/glyphs.ts'
import { calendarDateKey, calendarDateLabel, elapsedSince, plural } from '../shared/lib/format.ts'
import { clockTime } from './clock.ts'
import { isImageGenerationTool } from '../../../../packages/kybern-client/src/toolActivity.ts'
import { responseImages } from '../../../../packages/kybern-client/src/responseImages.ts'
import { chunkRuns, isAgentLaunchBlock, isDelegationLaunchBlock, isOrchestrationBlock } from '../shared/lib/workChunks.ts'
import { buildWorkHierarchy, shouldRevealLiveText, type Block, type TurnGroup } from '../../../../packages/kybern-client/src/transcript.ts'
import type { ContentPart, Diff, RuntimeTask, ThreadId } from '../../../../packages/kybern-client/src/types.ts'
import { removePending, usePendingSend } from '../composer/pending.ts'
import { machineName } from '../composer/outbox.ts'
import { waitingLabel } from '../../../../packages/kybern-client/src/pendingSends.ts'
import { useNewChat } from '../composer/newChats.ts'
import { PREPARING_WORKTREE } from '../../../../packages/kybern-client/src/newChat.ts'
import { restoreToComposer, retryPending } from '../composer/store.ts'
import { useApp } from '../state.ts'
import { TranscriptTail } from './Window.tsx'
import { isWindowVisible } from '../native/visibility.ts'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { Icon } from '../icons.tsx'
import { useLoopVisibility } from '../native/loop-visibility.ts'
import { MatrixLoader, useLoaderSecond } from '../MatrixLoader.tsx'
import { clockDuration, Label, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { Button } from '../kit/Button.tsx'
import { IconButton } from '../kit/IconButton.tsx'
import { CopyAction, messageText, SaveToNoteAction, UserBubble } from './bubble.tsx'
import { T } from './glyphs.ts'
import { ResponseImage } from './images.tsx'
import { alpha, cachedMarkdownTheme, Chevron, fg, META, muted, Para, ROW_LINE, RowIcon, TEXT } from './kit.tsx'
import { over } from '../theme.ts'
import { Collapse, Rise } from '../motion/kit.tsx'
import { Shimmer } from './motion.tsx'
import { agentName } from '../requests/model.ts'
import { silenceNotice } from '../../../../packages/kybern-client/src/silence.ts'
import { GROUP_TREE, HEADER_STEM, WorkRows, type RowContext } from './rows.tsx'
import { markTreeOpen, TreeGroup, TreeLines } from '../tree/Tree.tsx'
import { filePatch, hydrateToolOutput, loadFilePatch, reportError, revertTo, interrupt, useChildThreads, useRowState, useTurnDiff, type ToolBlock } from './store.ts'
import { signInRows } from '../../../../packages/kybern-client/src/signIn.ts'

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

/** The orbit loader animates independently; elapsed labels update once a second. */
function WorkingHeader({ since, lastAt, quiet, threadId }: { since: string; lastAt: number; quiet: boolean; threadId: ThreadId }) {
  const t = useTheme()
  const loop = useLoopVisibility()
  useLoaderSecond(loop.visible)
  const kind = useApp(s => s.open.thread?.provider.kind)
  const [stopping, setStopping] = useState(false)
  // Nothing has arrived from the agent for a long time and nothing is running: say so, with a way out.
  const silence = quiet ? silenceNotice(Date.now() - lastAt, agentName(kind)) : null
  return (
    <div ref={loop.ref} testId="working-header" style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: -2 }}>
      <div style={{ display: 'flex', width: 16, justifyContent: 'center' }}>
        <MatrixLoader alpha={0.7} />
      </div>
      <Label color={muted(t)} lineHeight={TEXT.lineHeight}>
        {`Working for ${clockDuration(elapsedSince(since, Date.now()))}`}
      </Label>
      {silence && <div testId="silence-notice"><Label color={muted(t)} lineHeight={TEXT.lineHeight}>{`· ${silence}`}</Label></div>}
      {silence && <Button size="sm" variant="ghost" testId="silence-stop" disabled={stopping} onClick={() => { setStopping(true); void interrupt(threadId).catch(() => setStopping(false)) }}>{stopping ? 'Stopping…' : 'Stop'}</Button>}
    </div>
  )
}

/** When this turn last showed anything: its newest block, else the message that started it. */
function lastActivityAt(group: TurnGroup): number {
  let last = Date.parse(group.user?.at ?? '') || 0
  for (const block of group.work) last = Math.max(last, Date.parse(block.at) || 0)
  return last || Date.now()
}

function itemCards(group: TurnGroup) {
  return placeItemCards(group.work.flatMap(block => {
    if (block.kind !== 'tool' || !block.complete || block.isError || !agentItemTool(block.call.name)?.write) return []
    const result = agentItemWriteResult(parseAgentItemResult(block.output))
    return result ? [{ id: block.call.id, result }] : []
  }), group.answer?.text)
}

export const Turn = memo(function Turn({ group, threadId, isLast, threadRunning, userRef }: { group: TurnGroup; threadId: ThreadId; isLast: boolean; threadRunning: boolean; userRef?: (node: PublicInstance | null) => void }) {
  const t = useTheme()
  const subagentThread = useApp(s => s.open.thread?.subagent ? s.open.thread : null)
  const subagent = !!subagentThread
  const firstUserId = useApp(s => s.open.blocks.find(b => b.kind === 'user')?.id)
  // An optimistic send the daemon rejected (`composer/pending.ts`): its bubble stays, with Retry and Edit, and no turn runs.
  const send = usePendingSend(threadId, group.user?.id)
  const failed = send?.state === 'failed'
  // A new chat in worktree mode: its first turn starts once the daemon has made the worktree (`composer/newChats.ts`).
  const chat = useNewChat(threadId)
  const preparing = !!chat && chat.worktree && chat.state === 'creating' && chat.messageId === group.user?.id
  // A group's worktrees are made one repository at a time: "Preparing worktrees… 2 of 3" (`threads.workspace_progress`).
  const progress = useWorkspaceProgress(preparing ? threadId : null)
  // A send queued for a machine that is away: "Waiting for satyamas" until it takes it (`composer/outbox.ts`).
  const waiting = send?.state === 'waiting' ? waitingLabel(chat?.machineName ?? machineName(send.machineId)) : null
  // A long live turn can start before the loaded page, so its user message (and
  // with it `running`) is missing; the thread's status still says it is live.
  const running = !failed && (group.running || (threadRunning && isLast && !group.end))
  const tasksByToolCall = useMemo(() => tasksOf(group.work), [group.work])
  const hierarchy = useMemo(() => buildWorkHierarchy(group.work), [group.work])
  // A context refresh lands in the turn it followed but is its own row below the turn (`Transcript.tsx`), not part of its work.
  const roots = useMemo(() => hierarchy.roots.filter((block) => block.kind !== 'rotation'), [hierarchy])
  // Launch rows open the child thread they started; look the children up only when there are launches.
  const launches = useMemo(
    () => group.work.some((b) => (b.kind === 'tool' && (isAgentLaunchBlock(b, tasksByToolCall.get(b.call.id)) || isDelegationLaunchBlock(b))) || (b.kind === 'runtime_task' && b.task.kind === 'agent')),
    [group.work, tasksByToolCall],
  )
  const children = useChildThreads(threadId, launches)
  const cards = useMemo(() => itemCards(group), [group.work, group.answer?.text])
  const signIn = useMemo(() => signInRows(group.work), [group.work])
  const ctx = useMemo<RowContext>(() => ({ threadId, tasksByToolCall, childrenByParent: hierarchy.childrenByParent, children, inlineItemIds: running ? undefined : cards.inlineCallIds, signIn }), [threadId, tasksByToolCall, hierarchy, children, cards, running, signIn])
  const settled = useMemo(() => {
    const agentBlocks: Block[] = []
    const disclosureBlocks: Block[] = []
    for (const block of roots) {
      if (
        (block.kind === 'tool' && isAgentLaunchBlock(block, tasksByToolCall.get(block.call.id))) ||
        (block.kind === 'runtime_task' && block.task.kind === 'agent') ||
        isOrchestrationBlock(block) ||
        // A question a restart cut off still wants an answer (its "Reply in chat"), and an answer an agent gave for the user
        // ("Answered by Coordinator") is the user's to see: both stay outside the fold.
        (block.kind === 'approval' && (expiredQuestion(block.approval, block.decision) || !!block.answeredBy))
      )
        agentBlocks.push(block)
      else if (block.kind !== 'visual') disclosureBlocks.push(block)
    }
    return { agentBlocks, disclosureBlocks }
  }, [roots, tasksByToolCall])
  const [expanded, setExpanded] = useRowState(`work:${group.turnId}`, false)
  // The fold: when this turn settles while it is on screen at the tail, the "Worked for" disclosure first shows its work, then closes
  // with the same 220 ms height tween as a click (the rows fold away instead of vanishing). A turn first rendered settled, one the reader
  // has scrolled away from, a hidden window and Reduce Motion skip it; the anchor logic in `Transcript.tsx` is untouched.
  const tail = useContext(TranscriptTail)
  const wasRunning = useRef(running)
  const [folding, setFolding] = useState(false)
  if (running) wasRunning.current = true
  else if (wasRunning.current) {
    wasRunning.current = false
    if (PATCHED_NATIVE && !REDUCED_MOTION && tail.current && isWindowVisible()) setFolding(true)
  }
  useEffect(() => {
    if (!folding) return
    // One beat for the expanded rows to paint, so the close has a height to measure.
    const timer = setTimeout(() => { setFolding(false); setExpanded(false) }, 64)
    return () => clearTimeout(timer)
  }, [folding])
  const hasLiveWork = group.work.some(
    (b) =>
      (b.kind === 'tool' && !b.complete) ||
      (b.kind === 'runtime_task' && isTaskActive(b.task)) ||
      (b.kind === 'assistant' && !b.complete && (b.id === group.liveThinkingId || shouldRevealLiveText(b.text, b.complete))) ||
      (b.kind === 'approval' && !b.decision),
  )
  // Between calls the newest run says "thinking" in its tail, instead of a separate row blinking in under it.
  const endsInRun = useMemo(() => running && !hasLiveWork && chunkRuns(roots, tasksByToolCall).at(-1)?.kind === 'run', [running, hasLiveWork, roots, tasksByToolCall])

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {subagentThread && group.user?.id === firstUserId && <SubagentDivider thread={subagentThread} />}
      {group.user && (
        <div ref={userRef} testId={`turn-user:${group.user.id}`} style={{ paddingBottom: running ? 20 : 16 }}>
          <UserBubble parts={group.user.message.parts} at={group.user.at} id={group.user.id} clampLines={subagent ? 6 : undefined} />
          {failed && <SendFailed threadId={threadId} id={send.id} error={send.error} parts={group.user.message.parts} />}
          {waiting && !running && <div testId={`send-waiting:${send!.id}`} style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: 6 }}><Label color={muted(t)} size={12} lineHeight={16}>{waiting}</Label></div>}
        </div>
      )}

      {group.visuals?.map(block => <VisualCard key={block.id} visual={block.visual} answer={block.answer} threadId={threadId} />)}
      {running && (
        <div testId="live-work" style={{ display: 'flex', flexDirection: 'column', paddingBottom: 8 }}>
          <WorkingHeader since={group.user?.at ?? group.work[0]?.at ?? ''} lastAt={lastActivityAt(group)} quiet={!hasLiveWork} threadId={threadId} />
          {roots.length > 0 && (
            <div style={{ marginTop: 4 }}>
              <WorkRows compact blocks={roots} ctx={ctx} tone="bright" liveTextId={group.liveTextId} liveThinkingId={group.liveThinkingId} waiting={endsInRun} />
            </div>
          )}
          {/* `thinkingRow`: `t-row-enter` each time it mounts. */}
          {!hasLiveWork && !endsInRun && (
            <Rise kind="row" style={{ marginTop: 6 }}>
              <Shimmer text={waiting ?? (preparing ? (progress ? workspaceProgressLabel(progress) : PREPARING_WORKTREE) : 'Thinking')} color={muted(t)} lineHeight={TEXT.lineHeight} />
            </Rise>
          )}
        </div>
      )}

      {!running && (settled.agentBlocks.length > 0 || settled.disclosureBlocks.length > 0) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 12 }}>
          {settled.agentBlocks.length > 0 && <WorkRows compact blocks={settled.agentBlocks} ctx={ctx} />}
          {settled.disclosureBlocks.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', paddingTop: 4, paddingBottom: 4 }}>
              <div testId={`worked-${group.turnId}`} onClick={() => { if (!expanded) markTreeOpen(); setExpanded(!expanded) }} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                {(expanded || folding) && <TreeLines shape={HEADER_STEM} />}
                <RowIcon source={T.hammer} color={muted(t)} />
                <Label color={muted(t)} lineHeight={ROW_LINE} truncate style={{ flexGrow: 1, hover: { color: t.text } }}>
                  {group.end ? `Worked for ${clockDuration(group.end.durationMs)}` : 'Worked'}
                </Label>
                <Chevron open={expanded || folding} color={muted(t, 0.65)} />
              </div>
              <Collapse open={expanded || folding} testId={`worked-panel-${group.turnId}`}>
                <div style={{ paddingTop: 2, marginLeft: 22 }}>
                  <TreeGroup {...GROUP_TREE} inset={2} gap={2} open={expanded || folding}>
                    <WorkRows compact blocks={settled.disclosureBlocks} ctx={ctx} />
                  </TreeGroup>
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
    const all = [...group.images.map((image) => ({ source: image.source, label: 'Agent image', at: image.at })), ...imageTools.flatMap((b) => responseImages(b.output).map((image) => ({ ...image, at: b.at })))]
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
                <ResponseImage key={image.source} source={image.source} label={image.label} at={image.at} />
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
          {group.outside?.map((block) => <OutsideChange key={block.id} repos={block.repos} />)}
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
  const g = useGlass()
  const [expanded, setExpanded] = useRowState(`files:${turnId}`, true)
  const [showAll, setShowAll] = useRowState(`files-all:${turnId}`, false)
  const [reverting, setReverting] = useState(false)
  const adds = diff.files.reduce((n, f) => n + f.additions, 0)
  const dels = diff.files.reduce((n, f) => n + f.deletions, 0)
  // A group thread lists the files under their repository (paths stay relative to the group folder, so links resolve).
  const members = useApp((s) => (s.open.thread?.id === threadId ? s.open.thread.members : undefined))
  const groups = members?.length ? groupFilesByRepo(diff, includedMembers(members)).filter((g) => g.files.length > 0) : null
  const files = groups ? groups.flatMap((g) => g.files) : diff.files
  const head = files.slice(0, MAX_VISIBLE_CHANGED_FILES)
  const rest = files.slice(MAX_VISIBLE_CHANGED_FILES)
  const repoOf = (file: Diff['files'][number]) => groups?.find((g) => g.files.includes(file))
  // The repository's caption goes before its first file, in the part of the list that shows that file.
  const rowsFor = (part: Diff['files'], offset: number) => part.map((f, i) => {
    const repo = repoOf(f)
    const first = repo && repo.files[0] === f
    return (
      <Fragment key={f.path}>
        {first && <RepoCaption name={repo.repo.name} border={offset + i > 0 ? border : undefined} />}
        <EditedFileRow file={f} threadId={threadId} turnId={turnId} first={offset + i === 0 || !!first} border={border} repo={repo?.repo.path} />
      </Fragment>
    )
  })
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
    <div testId="edited-files" style={{ position: 'relative', display: 'flex', flexDirection: 'column', marginTop: 8, marginBottom: 4, borderRadius: radius, overflow: 'hidden', borderWidth: 1, borderColor: raisedRim(g, border), backgroundColor: g.on ? g.raised : undefined }}>
      <GlassEdge radius={radius} color={g.highlight} />
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
          backgroundColor: g.on ? g.band : over(alpha(t.codeSurface, 0.4), t.surface),
          borderTopLeftRadius: radius - 1,
          borderTopRightRadius: radius - 1,
          borderBottomLeftRadius: expanded ? 0 : radius - 1,
          borderBottomRightRadius: expanded ? 0 : radius - 1,
          ...(expanded ? { borderBottomWidth: 1, borderColor: raisedRim(g, border) } : {}),
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <Icon source={T.changes} size={14} color={muted(t, 0.7)} />
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <Label color={fg(t, 0.92)} lineHeight={TEXT.lineHeight} truncate>
              {groups ? editedFilesTitle(files.length, groups.map((g) => g.repo.name)) : `Edited ${plural(diff.files.length, 'file')}`}
            </Label>
            {(adds > 0 || dels > 0) && <DiffStat additions={adds} deletions={dels} />}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {canUndo && (
            <Button variant="ghost" size="sm" testId="edited-undo" busy={reverting} iconAfter={T.undo} onClick={() => void undo()}>Undo</Button>
          )}
          <Button testId="edited-review" size="sm" onClick={() => openTab(threadId, { kind: 'diff' })}>Review</Button>
          <IconButton testId="edited-files-toggle" label={expanded ? 'Hide edited files' : 'Show edited files'} icon={T.chevronDown} size="sm" onClick={() => setExpanded(!expanded)}>
            <Chevron open={expanded} color={muted(t, t.variant === 'dark' ? 0.5 : 0.7)} />
          </IconButton>
        </div>
      </div>
      {/* `DisclosureRegion`s: the file list, and the files past the first five inside it. */}
      <Collapse open={expanded} testId="edited-files-panel">
          {rowsFor(head, 0)}
          {rest.length > 0 && (
            <Collapse open={showAll}>
              {rowsFor(rest, head.length)}
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

/** A repository's caption over its files in a group thread's card: the glyph and name, quiet. */
function RepoCaption({ name, border }: { name: string; border?: string }) {
  const t = useTheme()
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 2, ...(border ? { borderTopWidth: 1, borderColor: border } : {}) }}>
      <Icon source={N.repo} size={12} color={muted(t, 0.55)} />
      <Label color={muted(t, 0.7)} size={12} lineHeight={16}>{name}</Label>
    </div>
  )
}

function EditedFileRow({ file, threadId, turnId, first, border, repo }: { file: Diff['files'][number]; threadId: ThreadId; turnId: string; first?: boolean; border: string; /** The member it belongs to: its path prefix is drawn muted. */ repo?: string }) {
  const t = useTheme()
  const g = useGlass()
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
        style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 12, paddingRight: 8, paddingTop: 10, paddingBottom: 10, minWidth: 0, cursor: 'pointer', hover: { backgroundColor: t.variant === 'dark' ? 'rgba(0, 0, 0, 0)' : t.buttonSecondaryHover } }}
      >
        <div testId={`edited-file-${file.path}`} onClick={toggle} style={{ display: 'flex', alignItems: 'center', gap: 8, flexGrow: 1, minWidth: 0 }}>
        <Chevron open={open} color={muted(t, 0.6)} />
        <Icon source={diffFileIcons[getFileIconName(file.path)] ?? T.file} size={16} color={t.text} style={{ opacity: t.variant === 'dark' ? 0.8 : 0.7 }} />
        {repo && repo !== '.' && file.path.startsWith(`${repo}/`) ? (
          <div style={{ display: 'flex', minWidth: 0, flexShrink: 1 }}>
            <Label color={muted(t, 0.6)} lineHeight={TEXT.lineHeight} style={{ flexShrink: 0 }}>{`${repo}/`}</Label>
            <Label color={t.text} lineHeight={TEXT.lineHeight} truncate style={{ flexShrink: 1, hover: { textDecoration: 'underline' } }}>{stripRepoPrefix(file.path, repo)}</Label>
          </div>
        ) : (
          <Label color={t.text} lineHeight={TEXT.lineHeight} truncate style={{ flexShrink: 1, hover: { textDecoration: 'underline' } }}>
            {file.path}
          </Label>
        )}
        <div style={{ flexGrow: 1 }} />
        <DiffStat additions={file.additions} deletions={file.deletions} />
        </div>
        <IconButton testId={`edited-review-${file.path}`} label={`Open the changes in ${file.path} in a tab`} icon={T.panelRight} size="sm" onClick={() => openTab(threadId, { kind: 'diff', path: file.path })} />
      </div>
      <Collapse open={open && ready}>
        <div style={{ display: 'flex', flexDirection: 'column', borderTopWidth: 1, borderColor: raisedRim(g, border), backgroundColor: g.on ? 'rgba(0, 0, 0, 0)' : t.v('--background') }}>
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
              <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
                <diff patch={patch.text} scroll={file.additions + file.deletions > 200} theme={desktopDiffTheme(t, false, 13, { glass: g.on })} style={{ userSelect: 'text', minWidth: 0, ...(file.additions + file.deletions > 200 ? { height: 360 } : {}) }} />
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

/** Under a rejected send: what went wrong, Retry (same message id, so a send the daemon did take is not doubled) and Edit
 * (back into the composer). */
function SendFailed({ threadId, id, error, parts }: { threadId: ThreadId; id: string; error?: string; parts: ContentPart[] }) {
  const t = useTheme()
  return (
    <Rise kind="row" style={{ alignItems: 'flex-end', width: '100%' }}>
      {/* Below the bubble's hover footer (Copy, Save to note), which reaches 28 px under it. */}
      {/* The reason wraps instead of truncating: its last clause is usually what to do next. */}
      <div testId="send-failed" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, paddingTop: 30, maxWidth: '80%' }}>
        <Label color={t.v('--destructive')} size={META.size} lineHeight={META.lineHeight} style={{ textAlign: 'right' }}>
          {/* Daemon errors may start lowercase ("thread is no longer idle"); the reason reads as its own sentence. */}
          {`Not sent. ${error ? error.charAt(0).toUpperCase() + error.slice(1) : 'The daemon did not answer.'}`}
        </Label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Button size="sm" testId="send-retry" onClick={() => retryPending(threadId, id)}>Retry</Button>
          <Button variant="ghost" size="sm" testId="send-edit" onClick={() => {
            if (restoreToComposer(`thread:${threadId}`, parts, messageText(parts))) removePending(threadId, id)
          }}>Edit</Button>
        </div>
      </div>
    </Rise>
  )
}
