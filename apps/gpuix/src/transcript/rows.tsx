import { ProviderMark } from '../ui.tsx'
import { getState } from '../state.ts'
import { getNav } from '../nav/store.ts'
import { PanelPresence, PanelEnter } from '../requests/Panel.tsx'
import { LaunchMember, PinRow } from '../subagents/Launch.tsx'
import { AgentItemCard } from '../coordinator/AgentItem.tsx'
import { SentToRow } from './Messages.tsx'
import { openThread } from '../nav/history.ts'
import { pickRecordText, pickRequestInput } from '../../../../packages/kybern-client/src/pickRequest.ts'
import { secretRequestInput, secretOutcomeLine, secretPartsText } from '../../../../packages/kybern-client/src/secretRequest.ts'
import { answerRowText, visualAnswerInput } from '../../../../packages/kybern-client/src/visualAnswer.ts'
import { coordinatorCardLine, cardPartsText } from '../../../../packages/kybern-client/src/coordinatorCards.ts'
import { recordText, requestRecord } from '../../../../packages/kybern-client/src/requestCards.ts'
import { RequestRecordRow } from './RequestRecord.tsx'
import { SignInChip } from './SignInChip.tsx'
import type { LoginRecipe } from '../../../../packages/kybern-client/src/loginRecipes.ts'
// Work rows inside a turn (`views/Transcript.tsx` WorkRows → ToolRow/WorkRow):
// tool calls with their expandable result, the work between two pieces of
// narration folded into one summary row (`chunkRuns`, `WorkRun.tsx`), nested child calls
// (`buildWorkHierarchy`), reasoning, approvals, notices, runtime tasks, and
// compact subagent and delegation groups. Labels and icons come from the
// desktop's own helpers.
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { toolLine, toolVisualKind, type ToolVisualKind } from '../../../../packages/kybern-client/src/toolActivity.ts'
import { toolSurface, surfaceHasOutputText, surfaceOutputText, type ToolSurface } from '../../../../packages/kybern-client/src/toolSurface.ts'
import { hasOutputText, outputText } from '../../../desktop/src/lib/format.ts'
import { responseImages } from '../../../../packages/kybern-client/src/responseImages.ts'
import { agentItemWriteResult, agentItemLabel, agentItemResultText, agentItemTool, parseAgentItemResult } from '../../../../packages/kybern-client/src/agentItemTools.ts'
import { chunkKey, chunkRuns, isAgentLaunchBlock, isDelegationLaunchBlock, type WorkChunk } from '../../../desktop/src/lib/workChunks.ts'
import { RUN_ANCHOR, RUN_TICK_END, WorkRunRow } from './WorkRun.tsx'
import { orchestrationLabel, orchestrationTool, parseDelegateInput, parseDelegateResult, parseSendInput } from '../../../../packages/kybern-client/src/orchestrationTools.ts'
import { isPreviewOpenTool, previewToolLabel } from '../../../../packages/kybern-client/src/previewTool.ts'
import { computerConsent, connectorApproval, isUserInput, notesTasksConsent } from '../../../../packages/kybern-client/src/userInput.ts'
import { shouldRevealLiveText, type Block } from '../../../../packages/kybern-client/src/transcript.ts'
import { findSubagentFor, subagentCounts, subagentGroupDefaultOpen, subagentGroupTitle, subagentPhase, subagentStatusSegments, subagentThreadPhase, type SubagentPhase } from '../../../../packages/kybern-client/src/subagents.ts'
import { launchCounts, launchGroupDefaultOpen, launchGroupTitle, launchState } from '../../../../packages/kybern-client/src/delegations.ts'
import type { ApprovalDecision, ApprovalRequest, JsonValue, RequestAnswerer, RuntimeTask, Thread, ThreadId } from '../../../../packages/kybern-client/src/types.ts'
import { TOOL_RESULT_CHAR_LIMIT, TOOL_RESULT_LINE_LIMIT } from '../../../desktop/src/lib/toolResultText.ts'
import { BoundedMarkdown, TextDetail } from './markdown.tsx'
import { Icon } from '../icons.tsx'
import { MatrixLoader } from '../MatrixLoader.tsx'
import { SuccessCheck } from '../motion/SuccessCheck.tsx'
import { FONT_UI } from '../theme.ts'
import { Label, useTheme } from '../ui.tsx'
import { T } from './glyphs.ts'
import { ResponseImage } from './images.tsx'
import { MidTurnMessage } from './bubble.tsx'
import { cachedMarkdownTheme, Chevron, CODE, destructive, fg, muted, Para, ROW_LINE, RowIcon, TEXT } from './kit.tsx'
import { Collapse, Rise } from '../motion/kit.tsx'
import { markTreeOpen, TICK_GAP, TreeBox, TreeGroup, TreeItem, TreeLines, useTreeSlot, type Joint, type TreeShape } from '../tree/Tree.tsx'
import { useLoopVisibility } from '../native/loop-visibility.ts'
import { Shimmer, SwapOnChange, useFresh, useSmoothText, useStreamEffects } from './motion.tsx'
import { hydrateToolOutput, useRowState, usePacedAssistant, type ToolBlock } from './store.ts'

export interface RowContext {
  threadId: ThreadId
  inlineItemIds?: ReadonlySet<string>
  tasksByToolCall: ReadonlyMap<string, RuntimeTask>
  childrenByParent: ReadonlyMap<string, ToolBlock[]>
  /** Subagent and delegated threads this thread launched (`threads.list { parent_thread_id }`). */
  children: readonly Thread[]
  /** Tool rows (by call id) that get the "Sign in to …" chip: the turn's latest signed-out failure of each CLI. */
  signIn?: ReadonlyMap<string, LoginRecipe>
}

/** The child thread a launch started: a subagent by its task or call
 *  (`findSubagentFor`), a delegation by its result or operation id. */
export function launchThread(block: Block, ctx: RowContext): Thread | undefined {
  if (block.kind === 'runtime_task') return findSubagentFor(ctx.children, { toolCallId: block.task.tool_call_id, taskId: block.task.id })
  if (block.kind !== 'tool') return undefined
  if (isDelegationLaunchBlock(block)) {
    const id = parseDelegateResult(block.output)?.threadId
    if (id) return ctx.children.find((thread) => thread.id === id)
    const operationId = block.isError ? null : parseDelegateInput(block.call.input).operationId
    return operationId ? ctx.children.find((thread) => thread.delegation?.operation_id === operationId) : undefined
  }
  return findSubagentFor(ctx.children, { toolCallId: block.call.id, taskId: ctx.tasksByToolCall.get(block.call.id)?.id })
}

// ---- labels and icons (Transcript.tsx workIcon / workLabel / surfaceLabel) ----

export function workIcon(kind: ToolVisualKind | 'other', isError: boolean): string {
  if (isError && !['github', 'web', 'mcp', 'skill', 'computer', 'note', 'task'].includes(kind)) return T.alert
  switch (kind) {
    case 'note': return T.note
    case 'task': return T.listChecks
    case 'message': return T.chatBubble
    case 'github': return T.github
    case 'web': return T.globe
    case 'mcp': return T.mcp
    case 'computer': return T.laptop
    case 'skill': return T.skill
    case 'command': return T.terminal
    case 'edit':
    case 'write': return T.pencil
    case 'read':
    case 'search':
    case 'list': return T.search
    case 'fetch': return T.globe
    case 'image': return T.eye
    case 'delegate': return T.robot
    default: return T.hammer
  }
}

function workLabel({ verb, detail, kind }: ReturnType<typeof toolLine>, name: string, complete: boolean, isError = false): string {
  if (isError) {
    if (kind === 'other') return detail ? `Failed to use ${detail}` : 'Tool call failed'
    const action =
      kind === 'command' ? 'run a command'
        : kind === 'read' ? 'read'
          : kind === 'search' ? 'search'
            : kind === 'list' ? 'list'
              : kind === 'write' ? 'write'
                : kind === 'edit' ? 'edit'
                  : kind === 'fetch' ? 'fetch'
                    : kind === 'delegate' ? 'delegate'
                      : 'use the tool'
    return detail ? `Failed to ${action} ${detail}` : `Failed to ${action}`
  }
  if (kind === 'command' && !detail) return complete ? 'Ran a command' : 'Running a command'
  if (kind === 'read' && !detail) return complete ? 'Read a file' : 'Reading a file'
  if (detail) return `${verb} ${detail}`
  return verb === name ? `Used ${name}` : verb
}

function surfaceLabel(surface: ToolSurface, input: JsonValue, complete: boolean, isError: boolean): string {
  const rawTitle = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>).title : undefined
  const title = typeof rawTitle === 'string' ? rawTitle.trim() : ''
  const target = surface.app ?? (surface.kind === 'browser' ? 'the browser' : 'your computer')
  if (isError) return title ? `Failed to ${title.charAt(0).toLowerCase()}${title.slice(1)}` : `Failed to use ${target}`
  if (title) return title
  const app = surface.app
  switch (surface.kybernTool) {
    case 'apps': return complete ? 'Listed open windows' : 'Listing open windows'
    case 'launch': return complete ? `Opened ${app ?? 'an app'}` : `Opening ${app ?? 'an app'}`
    case 'observe': return complete ? `Read ${app ?? 'an app window'}` : `Reading ${app ?? 'an app window'}`
    case 'screenshot': return complete ? (app ? `Took a screenshot of ${app}` : 'Took a screenshot') : app ? `Taking a screenshot of ${app}` : 'Taking a screenshot'
    case 'help': return complete ? 'Read computer use help' : 'Reading computer use help'
  }
  return complete ? `Used ${target}` : `Using ${target}`
}

export function approvalRowText(approval: ApprovalRequest, decision: ApprovalDecision | null, live = true, auto = false): string {
  if (auto) return `Allowed by Full access — ${approval.summary || approval.tool_name}`
  const secret = secretRequestInput(approval)
  if (secret) return secretPartsText(secretOutcomeLine(secret, decision, live))
  const asked = visualAnswerInput(approval)
  if (asked) return answerRowText(asked.title, decision)
  const pick = pickRequestInput(approval)
  if (pick) return pickRecordText(pick, decision, live)
  // The daemon resolves every card when its turn ends, so a card with no decision is still waiting.
  const record = requestRecord(approval, decision, true)
  if (record) return recordText(record)
  const coordinator = coordinatorCardLine(approval, decision, live)
  if (coordinator) return cardPartsText(coordinator)
  const connector = connectorApproval(approval)
  if (connector) {
    const target = connector.app ? `${connector.connector} to use ${connector.app}` : connector.connector
    return decision ? (decision.decision === 'deny' ? `Declined ${target}` : `Allowed ${target}`) : `Waiting to allow ${target}`
  }
  const computer = computerConsent(approval)
  if (computer) {
    const target = computer.foreground ? `foreground control of ${computer.app}` : `control of ${computer.app}`
    return decision ? (decision.decision === 'deny' ? `Declined ${target}` : `Allowed ${target}`) : `Waiting to allow ${target}`
  }
  if (isUserInput(approval)) return decision ? (decision.decision === 'deny' ? 'Input request declined' : 'Answers submitted') : 'Waiting for your input'
  const notesTasks = notesTasksConsent(approval)
  if (notesTasks && notesTasks.summary)
    return `${decision ? (decision.decision === 'deny' ? 'Declined: ' : 'Allowed: ') : 'Waiting to allow: '}${notesTasks.summary}`
  return `${decision ? (decision.decision === 'deny' ? 'Declined ' : 'Approved ') : 'Waiting to approve '}${approval.summary || approval.tool_name}`
}

export const isTaskActive = (task: RuntimeTask) => task.status === 'pending' || task.status === 'running' || task.status === 'waiting' || task.status === 'stopping'

// ---- row lists ----

/** Rows for a block list. `compact` folds the work between narration into runs and launches into groups
 *  (`chunkRuns`); nested activity lists every row. */
export const WorkRows = memo(function WorkRows({
  blocks,
  ctx,
  tone = 'muted',
  liveTextId = null,
  liveThinkingId = null,
  compact = false,
  waiting = false,
}: {
  blocks: readonly Block[]
  ctx: RowContext
  tone?: 'bright' | 'muted'
  liveTextId?: string | null
  liveThinkingId?: string | null
  compact?: boolean
  /** A live turn with nothing in flight: a trailing run says "thinking" (`Turn` drops its own "Thinking" row). */
  waiting?: boolean
}) {
  // A streamed event re-chunks the turn; runs whose members did not change keep their chunk object, so their memoized
  // rows skip the render (only the run that grew, or whose call settled, recounts its summary).
  const previous = useRef(new Map<string, WorkChunk>())
  const chunks = useMemo<WorkChunk[]>(() => {
    if (!compact) return blocks.map((block) => ({ kind: 'single', block }))
    const next = chunkRuns(blocks, ctx.tasksByToolCall).map((chunk) => {
      if (chunk.kind === 'single') return chunk
      const old = previous.current.get(chunkKey(chunk))
      return old && old.kind === chunk.kind && old.blocks.length === chunk.blocks.length && old.blocks.every((block, i) => block === chunk.blocks[i]) ? old : chunk
    })
    previous.current = new Map(next.flatMap((chunk) => (chunk.kind === 'single' ? [] : [[chunkKey(chunk), chunk] as const])))
    return next
  }, [blocks, ctx.tasksByToolCall, compact])
  // Inside a disclosure (`TreeGroup`) every row hangs from the parent's stem; outside one `TreeItem` adds nothing.
  const places = useMemo(() => {
    const list = chunks.map(treePlace)
    let lastNode = list.length - 1
    while (lastNode >= 0 && list[lastNode]!.joint === 'pass') lastNode--
    return list.map((place, i) => ({ ...place, last: i >= lastNode }))
  }, [chunks])
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {chunks.map((chunk, i) => (
        <TreeItem key={chunk.kind === 'single' ? chunk.block.id : chunkKey(chunk)} index={i} count={chunks.length} {...places[i]!}>
          {chunk.kind === 'single' ? (
            <WorkRow
              block={chunk.block}
              ctx={ctx}
              tone={tone}
              live={chunk.block.kind === 'assistant' && chunk.block.id === liveTextId}
              thinking={chunk.block.kind === 'assistant' && chunk.block.id === liveThinkingId}
              // Its reasoning is the last member of the run just above (`chunkRuns`): only the narration is left here.
              textOnly={i > 0 && chunks[i - 1]!.kind === 'run' && (chunks[i - 1] as Extract<WorkChunk, { kind: 'run' }>).blocks.at(-1) === chunk.block}
            />
          ) : chunk.kind === 'run' || chunk.kind === 'tools' ? (
            // Streaming reasoning is always a run's last member: only that run hears about it.
            <WorkRunRow blocks={chunk.blocks} ctx={ctx} liveThinkingId={chunk.blocks.at(-1)?.id === liveThinkingId ? liveThinkingId : null} waiting={waiting && i === chunks.length - 1} />
          ) : (
            <LaunchGroupRow kind={chunk.kind} blocks={chunk.blocks} ctx={ctx} />
          )}
        </TreeItem>
      ))}
    </div>
  )
})

/** Where a work row meets its group's stem: the y of its icon's centre and the x its tick stops at (3px short of the
 *  icon). Prose, images and mid-turn messages are not steps, so the stem runs past them (`pass`); a reasoning block
 *  is a step through its "Thought" row. */
function treePlace(chunk: WorkChunk): { joint: Joint; anchor: number; tickEnd?: number } {
  if (chunk.kind === 'run' || chunk.kind === 'tools') return { joint: 'node', anchor: RUN_ANCHOR, tickEnd: RUN_TICK_END }
  // `LaunchGroupRow`: 6px padding, then a 36px header around its 24px badge (its 4px margins sit outside the box).
  if (chunk.kind !== 'single') return { joint: 'node', anchor: 24, tickEnd: -TICK_GAP }
  const block = chunk.block
  switch (block.kind) {
    case 'assistant':
      return block.thinking.trim() ? { joint: 'node', anchor: 16, tickEnd: 2 - TICK_GAP } : { joint: 'pass', anchor: 16 }
    case 'image':
    case 'user':
      return { joint: 'pass', anchor: 16 }
    case 'notice':
      return { joint: 'node', anchor: 14, tickEnd: 2 - TICK_GAP }
    case 'approval':
      return { joint: 'node', anchor: 16, tickEnd: 2 - TICK_GAP }
    case 'tool':
      // `SentToRow`: a 14px icon at the left edge of a 28px line under 4px of padding.
      if (orchestrationTool(block.call.name) === 'thread_send' && parseSendInput(block.call.input).threadId) return { joint: 'node', anchor: 18, tickEnd: -TICK_GAP }
      return { joint: 'node', anchor: 16 }
    default:
      return { joint: 'node', anchor: 16 }
  }
}

/** The stem leaving below a 16px row icon when its group is open (`RowLine`, the "Worked for" header): 3px under the glyph. */
export const HEADER_STEM: TreeShape = { anchor: 12, below: { x: 8, from: 19 + TICK_GAP, to: ROW_LINE } }
/** A group's children sit 22px in; their stem is the parent icon's centre line and ticks stop 3px short of their own icons. */
export const GROUP_TREE = { x: 8 - 22, tickEnd: 1 - TICK_GAP } as const

/** Muted label that brightens on hover, like `TONE`. */
/** The generic approval's `IconSwap`: the matrix loader, then `<CheckIcon className="t-success" />` once answered. The check
 *  plays only when the answer arrives while the row is mounted (a row first rendered answered shows it at rest). */
function ApprovalStatus({ decided, color }: { decided: boolean; color: string }) {
  const [answeredAtMount] = useState(decided)
  return (
    <SwapOnChange kind="icon" active={decided ? 'done' : 'waiting'} style={{ flexShrink: 0 }}>
      <div style={{ display: 'flex', width: 20, height: 20, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        {decided ? <SuccessCheck size={16} color={color} play={!answeredAtMount} /> : <MatrixLoader />}
      </div>
    </SwapOnChange>
  )
}

function ToneLabel({ children, color, shimmer = false }: { children: string; color?: string; shimmer?: boolean }) {
  const t = useTheme()
  if (shimmer) return <Shimmer text={children} color={color ?? muted(t)} />
  return (
    <Label color={color ?? muted(t)} lineHeight={ROW_LINE} truncate style={{ flexGrow: 1, hover: { color: t.text } }}>
      {children}
    </Label>
  )
}

/** The clickable line every disclosure row uses: 16px icon, label, chevron. */
function RowLine({
  icon,
  iconColor,
  label,
  labelColor,
  shimmer,
  chevron,
  trailing,
  onClick,
  testId,
  stem = false,
}: {
  icon: React.ReactNode
  iconColor?: string
  label: string
  labelColor?: string
  shimmer?: boolean
  chevron?: 'open' | 'closed' | 'forward'
  trailing?: React.ReactNode
  onClick?: () => void
  testId?: string
  /** Its children are open below: the tree's stem starts under the icon. */
  stem?: boolean
}) {
  const t = useTheme()
  return (
    <div
      testId={testId}
      onClick={onClick}
      style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, cursor: onClick ? 'pointer' : 'default' }}
    >
      {stem && <TreeLines shape={HEADER_STEM} />}
      {typeof icon === 'string' ? <RowIcon source={icon} color={iconColor ?? muted(t)} /> : icon}
      <div style={{ display: 'flex', flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
        <ToneLabel color={labelColor} shimmer={shimmer}>{label}</ToneLabel>
      </div>
      {trailing}
      {chevron === 'forward' ? (
        <Icon source={T.chevronRight} size={14} color={muted(t, 0.55)} />
      ) : chevron ? (
        <Chevron open={chevron === 'open'} color={muted(t, 0.7)} />
      ) : null}
    </div>
  )
}

export const WorkRow = memo(function WorkRow({
  block,
  ctx,
  tone = 'muted',
  live = false,
  thinking = false,
  textOnly = false,
}: {
  block: Block
  ctx: RowContext
  tone?: 'bright' | 'muted'
  live?: boolean
  thinking?: boolean
  /** An assistant block whose reasoning is shown in the run above it. */
  textOnly?: boolean
}) {
  const t = useTheme()
  const tree = useTreeSlot()
  switch (block.kind) {
    case 'tool':
      return <ToolRow block={block} ctx={ctx} />
    case 'image':
      return <TreeBox><ResponseImage source={block.source} at={block.at} /></TreeBox>
    case 'assistant':
      return <AssistantWorkRow block={block} tone={tone} live={live} thinkingLive={thinking} textOnly={textOnly} />
    case 'runtime_task':
      return <RuntimeTaskRow task={block.task} thread={block.task.kind === 'agent' ? launchThread(block, ctx) : undefined} />
    case 'approval': {
      // An undecided card is waiting: the daemon resolves it when the turn ends.
      const record = block.auto ? null : requestRecord(block.approval, block.decision, true, undefined, block.answeredBy && answererNow(block.answeredBy))
      if (record) return (
        <div paintTransform={tree.rise} style={{ position: 'relative', display: 'flex', alignItems: 'center', paddingTop: 4, paddingBottom: 4, minWidth: 0 }}>
          <RequestRecordRow approval={block.approval} decision={block.decision} record={record} />
          {tree.lines}
        </div>
      )
      const text = approvalRowText(block.approval, block.decision, live, block.auto)
      const denied = block.decision?.decision === 'deny'
      const color = denied ? destructive(t, 0.85) : block.decision ? fg(t, 0.8) : muted(t)
      const secret = secretRequestInput(block.approval)
      const coordinator = coordinatorCardLine(block.approval, block.decision, live)
      const userInput = isUserInput(block.approval)
      const icon = secret || coordinator ? <RowIcon box={20} size={16} source={block.decision?.decision === 'submit' || block.decision?.decision === 'allow_once' ? T.check : secret ? T.key : T.note} color={block.decision?.decision === 'submit' ? t.green : muted(t)} /> : userInput ? (
        <RowIcon box={20} size={16} source={!block.decision ? T.question : denied ? T.alert : T.checkSquare} color={denied ? destructive(t, 0.85) : block.decision ? fg(t, 0.75) : muted(t)} />
      ) : null
      return (
        <div paintTransform={tree.rise} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 8, paddingTop: 4, paddingBottom: 4, minWidth: 0 }}>
          {/* `IconSwap` loader → check once the request is answered. */}
          {icon ?? <ApprovalStatus decided={!!block.decision} color={fg(t, 0.75)} />}
          <Label color={color} lineHeight={ROW_LINE} truncate>
            {text}
          </Label>
          {tree.lines}
        </div>
      )
    }
    case 'notice':
      return (
        <div paintTransform={tree.rise} style={{ position: 'relative', display: 'flex', alignItems: 'flex-start', gap: 8, paddingTop: 4, paddingBottom: 4, minWidth: 0 }}>
          <RowIcon box={20} size={16} source={T.alert} color={block.level === 'error' ? t.red : muted(t)} />
          <Para color={block.level === 'error' ? t.red : muted(t)} lineHeight={ROW_LINE} selectable style={{ flexGrow: 1 }}>
            {block.text}
          </Para>
          {tree.lines}
        </div>
      )
    case 'user':
      // A message sent mid-turn sits between work rows with a bubble's breathing room.
      return <MidTurnMessage parts={block.message.parts} at={block.at} />
    default:
      return null
  }
})

// ---- tool rows ----

/** What a tool row shows: its activity, glyph, surface, Kybern item, screenshots and label, and whether it has output. */
export function toolView(block: ToolBlock, active: boolean) {
  const complete = block.complete && !active
  const activity = toolLine(block.call, complete)
  const visual = toolVisualKind(block.call, activity)
  const surface = toolSurface(block.call, block.output)
  const item = agentItemTool(block.call.name)
  const orchestration = orchestrationTool(block.call.name)
  const itemResult = item && block.complete && !block.isError ? parseAgentItemResult(block.output) : null
  const screenshots = surface?.screenshots ?? responseImages(block.output).map((image) => image.source)
  const hasText = surface ? surfaceHasOutputText(block.output) : hasOutputText(block.output, block.stream)
  const label = isPreviewOpenTool(block.call.name)
    ? previewToolLabel(block.call.input, complete, block.isError)
    : orchestration
      ? orchestrationLabel(orchestration, complete, block.isError)
      : item
        ? agentItemLabel(item, block.call.input, itemResult, complete, block.isError)
        : surface
          ? surfaceLabel(surface, block.call.input, complete, block.isError)
          : workLabel(activity, block.call.name, complete, block.isError)
  const hasOutput = hasText || screenshots.length > 0 || !!block.outputOmitted || !!block.streamOmitted
  return { activity, visual, surface, item, itemResult, screenshots, label, hasOutput }
}

const ToolRow = memo(function ToolRow({ block, ctx }: { block: ToolBlock; ctx: RowContext }) {
  const t = useTheme()
  const [open, setOpen] = useRowState(`tool:${block.id}`, false)
  const task = ctx.tasksByToolCall.get(block.call.id)
  const active = !!task && isTaskActive(task)
  const view = useMemo(() => toolView(block, active), [block, active])
  const children = ctx.childrenByParent.get(block.call.id) ?? []
  // A launch whose child thread is known opens it (`SubagentLaunchRow`, `DelegationLaunchRow`).
  const child = isAgentLaunchBlock(block, task) || isDelegationLaunchBlock(block) ? launchThread(block, ctx) : undefined
  const opensActivity = isAgentLaunchBlock(block, task) || !!child
  const canExpand = !opensActivity && (children.length > 0 || view.hasOutput)
  const tone = block.isError ? destructive(t, 0.8) : muted(t)
  // Decided once on mount: only a row that just arrived plays `t-row-enter`.
  const fresh = useFresh(block.at)
  const tree = useTreeSlot()
  if (isAgentLaunchBlock(block, task) || isDelegationLaunchBlock(block)) return <TreeBox><LaunchMember block={block} thread={child} task={task} delegated={isDelegationLaunchBlock(block)} /></TreeBox>
  if (orchestrationTool(block.call.name) === 'thread_send' && parseSendInput(block.call.input).threadId) return <SentToRow block={block} threadId={ctx.threadId} />
  return (
    <Rise kind="row" play={fresh} paint={tree.rise} style={{ position: 'relative', paddingTop: 4, paddingBottom: 4, minWidth: 0 }}>
      <RowLine
        testId={`tool-row-${block.call.id}`}
        icon={workIcon(view.visual, block.isError)}
        iconColor={tone}
        label={view.label}
        labelColor={tone}
        shimmer={!block.complete || active}
        trailing={
          ctx.signIn?.get(block.call.id) ? (
            <SignInChip callId={block.call.id} threadId={ctx.threadId} recipe={ctx.signIn.get(block.call.id)!} />
          ) : view.surface?.app && !view.label.endsWith(view.surface.app) ? (
            <Label color={muted(t, 0.55)} size={11}>
              {view.surface.app}
            </Label>
          ) : undefined
        }
        chevron={opensActivity ? 'forward' : canExpand ? (open ? 'open' : 'closed') : undefined}
        stem={open && canExpand && children.length > 0}
        onClick={child ? () => openThread(child.id) : canExpand ? () => { if (!open) markTreeOpen(); setOpen(!open) } : undefined}
      />
      {view.item?.write && agentItemWriteResult(view.itemResult) && (!ctx.inlineItemIds || ctx.inlineItemIds.has(block.call.id)) && <AgentItemCard result={agentItemWriteResult(view.itemResult)!} />}
      {canExpand && <ToolPanel block={block} ctx={ctx} view={view} open={open} nested={children} />}
      {tree.lines}
    </Rise>
  )
})

/** A tool row's disclosure: its nested calls ("Nested activity"), then its result. */
export function ToolPanel({ block, ctx, view, open, nested }: { block: ToolBlock; ctx: RowContext; view: ReturnType<typeof toolView>; open: boolean; nested: ToolBlock[] }) {
  const t = useTheme()
  const label = view.activity.kind === 'delegate' ? 'Subagent activity' : 'Nested activity'
  return (
    <Collapse open={open} testId={`tool-panel-${block.call.id}`}>
      <div style={{ display: 'flex', flexDirection: 'column', marginLeft: 22, paddingTop: 6, minWidth: 0 }}>
        {nested.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', paddingBottom: view.hasOutput ? 10 : 0 }}>
            <Label color={muted(t, 0.45)} size={11} lineHeight={20} style={{ paddingBottom: 2 }}>
              {label}
            </Label>
            {/* The stem passes the label: the first child's slice reaches up over the panel's padding and the label. */}
            <TreeGroup {...GROUP_TREE} inset={6 + 22} gap={2} open={open}>
              <WorkRows blocks={nested} ctx={ctx} />
            </TreeGroup>
          </div>
        )}
        {view.hasOutput && (
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            {nested.length > 0 && (
              <Label color={muted(t, 0.45)} size={11} lineHeight={20} style={{ paddingBottom: 4 }}>
                Result
              </Label>
            )}
            <ToolResult block={block} threadId={ctx.threadId} surface={view.surface} item={!!view.item} screenshots={view.screenshots} />
          </div>
        )}
      </div>
    </Collapse>
  )
}

/** Lines a collapsed result shows: the desktop's `max-h-72` (288px) at 21px rows. */
const PREVIEW_LINES = TOOL_RESULT_LINE_LIMIT
/** Lines an expanded result mounts at most; `<code>` builds one row per line. */


function languageFor(path: string | undefined): string | undefined {
  if (!path) return undefined
  const ext = path.split('.').pop()?.toLowerCase()
  return ext && ext !== path ? ext : undefined
}

/** `ToolResult`: screenshots, then the text in a code-surface card. GPUIX has no
 *  nested scroller, so long output shows its first lines and a "Show all" row. */
function ToolResult({ block, threadId, surface, item, screenshots }: { block: ToolBlock; threadId: ThreadId; surface: ToolSurface | null; item: boolean; screenshots: string[] }) {
  const t = useTheme()
  const [all, setAll] = useRowState(`result:${block.id}`, false)
  useEffect(() => {
    if (block.outputOmitted || block.streamOmitted) void hydrateToolOutput(threadId, block)
  }, [threadId, block])
  const out = useMemo(() => {
    if (surface) return surfaceOutputText(block.output)
    const text = outputText(block.output, block.stream)
    return item ? agentItemResultText(text) : text
  }, [surface, item, block.output, block.stream])
  const lines = useMemo(() => out.replace(/\n+$/, '').split('\n'), [out])
  if ((block.outputOmitted || block.streamOmitted) && !out.trim() && screenshots.length === 0)
    return <Para color={muted(t, 0.7)} size={13} lineHeight={19.5}>Loading the saved result.</Para>
  const shown = lines.slice(0, PREVIEW_LINES)
  const preview = shown.join('\n').slice(0, TOOL_RESULT_CHAR_LIMIT)
  const hidden = lines.length - shown.length
  const path = (() => {
    const input = block.call.input as Record<string, unknown> | null
    return toolLine(block.call).kind === 'read' && input && typeof input === 'object' && typeof input.file_path === 'string' ? input.file_path : undefined
  })()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
      {screenshots.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {screenshots.map((source, i) => (
            <ResponseImage key={source} source={source} label={surface?.app ? `Screenshot of ${surface.app}` : `Screenshot ${i + 1}`} compact />
          ))}
        </div>
      )}
      {out.trim() && (
        <div
          testId={`tool-result-${block.call.id}`}
          style={{
            display: 'flex',
            flexDirection: 'column',
            borderRadius: 8,
            borderWidth: 1,
            borderColor: t.variant === 'dark' ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.06)',
            backgroundColor: t.codeSurface,
            overflow: 'hidden',
            minWidth: 0,
          }}
        >
          <code
            code={preview}
            path={path}
            language={path ? languageFor(path) : 'text'}
            theme={cachedMarkdownTheme(t)}
            style={{
              paddingLeft: 12,
              paddingRight: 12,
              paddingTop: 10,
              paddingBottom: hidden > 0 ? 4 : 10,
              fontFamily: CODE.font,
              fontSize: CODE.size,
              lineHeight: CODE.lineHeight,
              color: block.isError ? destructive(t, 0.9) : fg(t, 0.92),
              userSelect: 'text',
            }}
          />
          {all && <TextDetail text={out} title="Tool output" code onClose={() => setAll(false)} />}
          {(hidden > 0 || out.length > TOOL_RESULT_CHAR_LIMIT) && (
            <div
              testId="tool-result-more"
              onClick={() => setAll(!all)}
              style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 12, paddingRight: 12, paddingTop: 4, paddingBottom: 8, cursor: 'pointer' }}
            >
              <Chevron open={all} color={muted(t, 0.7)} size={12} />
              <Label color={muted(t)} size={12} lineHeight={18} style={{ hover: { color: t.text } }}>
                Show more
              </Label>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ---- reasoning and interim prose ----

const AssistantWorkRow = memo(function AssistantWorkRow({ block, tone, live, thinkingLive, textOnly }: { block: Extract<Block, { kind: 'assistant' }>; tone: 'bright' | 'muted'; live: boolean; thinkingLive: boolean; textOnly: boolean }) {
  block = usePacedAssistant(block)
  const t = useTheme()
  const [open, setOpen] = useRowState(`thinking:${block.id}`, false)
  const hasThinking = !textOnly && block.thinking.trim().length > 0
  const hasText = block.text.trim().length > 0
  const showText = hasText && (!live || block.complete || shouldRevealLiveText(block.text, block.complete))
  // Only the segment receiving deltas is paced; settled prose renders whole.
  const text = useSmoothText(block.text, live && !block.complete && process.env.KYBERN_SMOOTH_STREAM !== '0', block.complete)
  const caret = useLoopVisibility(live && !block.complete && showText)
  const stream = useStreamEffects(text, live && !block.complete && showText, caret.visible)
  // A "Thought" line is the step (its tick); prose after it, or prose alone, lets the stem run past.
  const head = useTreeSlot()
  const rest = useTreeSlot('rest')
  if (!hasThinking && !showText) return null
  const prose = hasThinking ? rest : head
  return (
    <>
      {hasThinking && (
        <div paintTransform={head.rise} style={{ position: 'relative', display: 'flex', flexDirection: 'column', paddingTop: 4, paddingBottom: 4 }}>
          <div testId={`thought-${block.id}`} onClick={() => setOpen(!open)} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            {/* `IconSwap` spinner → brain and `TextSwap` "Thinking" → "Thought". */}
            <SwapOnChange kind="icon" active={thinkingLive ? 'live' : 'done'} style={{ flexShrink: 0 }}>
              {thinkingLive ? (
                <div style={{ display: 'flex', width: 20, height: 20, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <MatrixLoader />
                </div>
              ) : (
                <RowIcon box={20} size={16} source={T.brain} color={muted(t)} />
              )}
            </SwapOnChange>
            <SwapOnChange active={thinkingLive ? 'live' : 'done'} style={{ flexShrink: 1, minWidth: 0, justifyContent: 'flex-start' }}>
              {thinkingLive ? <Shimmer text="Thinking" color={muted(t)} /> : <ToneLabel>Thought</ToneLabel>}
            </SwapOnChange>
            <Chevron open={open} color={muted(t, 0.7)} />
          </div>
          <Collapse open={open}>
            {/* A column, so the text takes the row's width and wraps (desktop: `min-w-0 whitespace-pre-wrap`). */}
            <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, paddingTop: 8, marginLeft: 28 }}>
              <text style={{ color: muted(t), fontSize: TEXT.size, lineHeight: TEXT.lineHeight, fontFamily: FONT_UI, userSelect: 'text' }}>{block.thinking}</text>
            </div>
          </Collapse>
          {head.lines}
        </div>
      )}
      {showText && (
        <div ref={caret.ref} paintTransform={prose.rise} style={{ position: 'relative', display: 'flex', flexDirection: 'column', paddingLeft: 2, paddingRight: 2 }}>
          <BoundedMarkdown text={text} tone={tone} stream={stream} at={block.at} />
          {prose.lines}
        </div>
      )}
    </>
  )
})

// ---- runtime tasks, subagents and delegations (compact) ----

export function RuntimeTaskRow({ task, thread }: { task: RuntimeTask; thread?: Thread }) {
  const t = useTheme()
  const active = isTaskActive(task)
  const noun = task.kind === 'agent' ? 'agent' : task.kind === 'process' ? 'process' : 'monitor'
  const status = active
    ? task.status === 'waiting' ? 'Monitoring' : task.status === 'stopping' ? 'Stopping' : 'Active'
    : task.status === 'failed' ? 'Failed' : task.status === 'stopped' || task.status === 'interrupted' ? 'Stopped' : 'Completed'
  const tree = useTreeSlot()
  const line = (
    <RowLine
      icon={task.kind === 'process' ? T.terminal : T.robot}
      label={task.kind === 'agent' ? `${active ? 'Delegating' : 'Delegated'} ${task.title}` : `Started ${noun} · ${task.title}`}
      trailing={
        <Label color={task.status === 'failed' ? t.red : muted(t, 0.55)} size={11}>
          {status}
        </Label>
      }
      chevron={task.kind === 'agent' ? 'forward' : undefined}
      onClick={thread ? () => openThread(thread.id) : undefined}
    />
  )
  return (
    <div paintTransform={tree.rise} style={{ position: 'relative', paddingTop: 4, paddingBottom: 4 }}>
      {/* A delegated agent's row pins its child thread as a tab (ADE-54), like the launch members. */}
      {task.kind === 'agent' && thread ? <PinRow id={thread.id} title={thread.title || task.title}>{line}</PinRow> : line}
      {tree.lines}
    </div>
  )
}

/** The stem under a launch group's 24px badge (centre 12, 24 from the top of its 48px header). */
const LAUNCH_STEM: TreeShape = { anchor: 24, below: { x: 12, from: 36 + TICK_GAP } }

/** "N subagents" / "N delegated agents": counts by phase, members on expand.
 *  A member with a known child thread takes its title and phase and opens it. */
const LaunchGroupRow = memo(function LaunchGroupRow({ kind, blocks, ctx }: { kind: 'subagents' | 'delegations'; blocks: Block[]; ctx: RowContext }) {
  const t = useTheme()
  const members = useMemo(
    () =>
      blocks.map((block) => {
        const task = block.kind === 'runtime_task' ? block.task : block.kind === 'tool' ? ctx.tasksByToolCall.get(block.call.id) : undefined
        const call = block.kind === 'tool' ? block : null
        const thread = launchThread(block, ctx)
        const title = thread?.title || task?.title || (call ? toolLine(call.call, call.complete).detail : '') || (kind === 'subagents' ? 'Subagent' : 'Delegated agent')
        let phase: SubagentPhase = thread?.subagent ? subagentThreadPhase(thread) : task ? subagentPhase(task.status) : call?.complete ? (call.isError ? 'failed' : 'done') : 'working'
        if (kind === 'delegations' && call) {
          const state = launchState(thread, call)
          phase = state.phase === 'working' || state.phase === 'waiting' ? 'working' : state.phase === 'failed' ? 'failed' : state.phase === 'stopped' ? 'stopped' : 'done'
        }
        return { key: block.id, title, phase, threadId: thread?.id, block, thread, task }
      }),
    [blocks, ctx, kind],
  )
  const counts = subagentCounts(members.map((m) => m.phase))
  const segments = subagentStatusSegments(counts)
  const defaultOpen = kind === 'subagents' ? subagentGroupDefaultOpen(counts) : launchGroupDefaultOpen(launchCounts(members.map((m) => m.phase)))
  const [chosen, setChosen] = useRowState<boolean | null>(`launch:${blocks[0]!.id}`, null)
  const expanded = chosen ?? defaultOpen
  const title = kind === 'subagents' ? subagentGroupTitle(members.length) : launchGroupTitle(members.length)
  const tree = useTreeSlot()
  return (
    <div paintTransform={tree.rise} style={{ position: 'relative', display: 'flex', flexDirection: 'column', marginTop: 4, marginBottom: 4 }}>
      <div testId={`launch-group-${blocks[0]!.id}`} onClick={() => { if (!expanded) markTreeOpen(); setChosen(!expanded) }} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 10, paddingTop: 6, paddingBottom: 6, paddingRight: 6, cursor: 'pointer' }}>
        {expanded && <TreeLines shape={LAUNCH_STEM} />}
        <div style={{ display: 'flex', width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: t.buttonSecondary, flexShrink: 0 }}>
          {kind === 'subagents' && members[0]?.thread ? <ProviderMark kind={members[0].thread.provider.kind} size={13} /> : <Icon source={T.robot} size={13} color={muted(t)} />}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 }}>
          <Label color={fg(t, 0.88)} lineHeight={20} style={{ hover: { color: t.text } }}>
            {title}
          </Label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {segments.map((segment, i) => (
              <Label key={segment.phase} color={segment.phase === 'failed' ? t.red : muted(t)} size={12} lineHeight={16}>
                {`${i > 0 ? '· ' : ''}${segment.text}`}
              </Label>
            ))}
          </div>
        </div>
        <Chevron open={expanded} color={fg(t, 0.55)} size={12} />
      </div>
      <PanelPresence show={expanded}><PanelEnter>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1, marginLeft: 28, paddingBottom: 4 }}>
          {/* Hung from the 24px badge's centre; each member's status glyph sits 6px into its row. */}
          <TreeGroup x={12 - 28} tickEnd={6 - TICK_GAP} gap={1} open={expanded}>
            {members.map((member, i) => (
              <TreeItem key={member.key} joint="node" last={i === members.length - 1} index={i} count={members.length} anchor={16}>
                <TreeBox><LaunchMember grouped block={member.block} thread={member.thread} task={member.task} delegated={kind === 'delegations'} /></TreeBox>
              </TreeItem>
            ))}
          </TreeGroup>
        </div>
      </PanelEnter></PanelPresence>
      {tree.lines}
    </div>
  )
})

export { isDelegationLaunchBlock }

/** The agent that answered for the user, under its current name (titles change after the answer); the lead is "Coordinator". */
function answererNow(by: RequestAnswerer): RequestAnswerer {
  const thread = getState().threads.find((t) => t.id === by.thread_id) ?? getNav().children[by.thread_id]
  if (!thread) return by
  return { ...by, title: thread.coordinator_project_id ? 'Coordinator' : thread.title || by.title }
}
