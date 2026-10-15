import { PanelPresence, PanelEnter } from '../requests/Panel.tsx'
import { LaunchMember } from '../subagents/Launch.tsx'
import { AgentItemCard } from '../coordinator/AgentItem.tsx'
import { SentToRow } from './Messages.tsx'
import { openThread } from '../nav/history.ts'
import { secretRequestInput, secretOutcomeLine, secretPartsText } from '../../../../packages/kybern-client/src/secretRequest.ts'
import { coordinatorCardLine, cardPartsText } from '../../../../packages/kybern-client/src/coordinatorCards.ts'
// Work rows inside a turn (`views/Transcript.tsx` WorkRows → ToolRow/WorkRow):
// tool calls with their expandable result, runs of settled tools folded into
// one summary row (`chunkWork` + `summarizeToolCalls`), nested child calls
// (`buildWorkHierarchy`), reasoning, approvals, notices, runtime tasks, and
// compact subagent and delegation groups. Labels and icons come from the
// desktop's own helpers.
import { memo, useEffect, useMemo, useState } from 'react'
import { toolLine, toolVisualKind, summarizeToolCalls, type ToolVisualKind } from '../../../desktop/src/lib/toolActivity.ts'
import { toolSurface, surfaceHasOutputText, surfaceOutputText, type ToolSurface } from '../../../desktop/src/lib/toolSurface.ts'
import { hasOutputText, outputText } from '../../../desktop/src/lib/format.ts'
import { responseImages } from '../../../desktop/src/lib/responseImages.ts'
import { agentItemWriteResult, agentItemLabel, agentItemResultText, agentItemTool, parseAgentItemResult } from '../../../desktop/src/lib/agentItemTools.ts'
import { chunkKey, chunkWork, isAgentLaunchBlock, isDelegationLaunchBlock, type WorkChunk } from '../../../desktop/src/lib/workChunks.ts'
import { orchestrationLabel, orchestrationTool, parseDelegateInput, parseDelegateResult, parseSendInput } from '../../../../packages/kybern-client/src/orchestrationTools.ts'
import { isPreviewOpenTool, previewToolLabel } from '../../../../packages/kybern-client/src/previewTool.ts'
import { computerConsent, connectorApproval, isUserInput, notesTasksConsent } from '../../../../packages/kybern-client/src/userInput.ts'
import { shouldRevealLiveText, type Block } from '../../../../packages/kybern-client/src/transcript.ts'
import { findSubagentFor, subagentCounts, subagentGroupDefaultOpen, subagentGroupTitle, subagentPhase, subagentStatusSegments, subagentThreadPhase, type SubagentPhase } from '../../../../packages/kybern-client/src/subagents.ts'
import { launchCounts, launchGroupDefaultOpen, launchGroupTitle, launchState } from '../../../../packages/kybern-client/src/delegations.ts'
import type { ApprovalDecision, ApprovalRequest, JsonValue, RuntimeTask, Thread, ThreadId } from '../../../../packages/kybern-client/src/types.ts'
import { TOOL_RESULT_CHAR_LIMIT, TOOL_RESULT_LINE_LIMIT } from '../../../desktop/src/lib/toolResultText.ts'
import { BoundedMarkdown, TextDetail } from './markdown.tsx'
import { Icon } from '../icons.tsx'
import { MatrixLoader } from '../MatrixLoader.tsx'
import { FONT_UI } from '../theme.ts'
import { Label, useTheme } from '../ui.tsx'
import { T } from './glyphs.ts'
import { ResponseImage } from './images.tsx'
import { MidTurnMessage } from './bubble.tsx'
import { cachedMarkdownTheme, Chevron, CODE, destructive, fg, muted, Para, ROW_LINE, RowIcon, TEXT } from './kit.tsx'
import { Collapse, Rise } from '../motion/kit.tsx'
import { Shimmer, SwapOnChange, useFresh, useSmoothText } from './motion.tsx'
import { hydrateToolOutput, useRowState, type ToolBlock } from './store.ts'

export interface RowContext {
  threadId: ThreadId
  inlineItemIds?: ReadonlySet<string>
  tasksByToolCall: ReadonlyMap<string, RuntimeTask>
  childrenByParent: ReadonlyMap<string, ToolBlock[]>
  /** Subagent and delegated threads this thread launched (`threads.list { parent_thread_id }`). */
  children: readonly Thread[]
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

export function approvalRowText(approval: ApprovalRequest, decision: ApprovalDecision | null, live = true): string {
  const secret = secretRequestInput(approval)
  if (secret) return secretPartsText(secretOutcomeLine(secret, decision, live))
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

const isTaskActive = (task: RuntimeTask) => task.status === 'pending' || task.status === 'running' || task.status === 'waiting' || task.status === 'stopping'

// ---- row lists ----

/** Rows for a block list. `compact` folds settled tool runs and launch groups
 *  like the desktop's settled and live work; nested activity lists every row. */
export const WorkRows = memo(function WorkRows({
  blocks,
  ctx,
  tone = 'muted',
  liveTextId = null,
  liveThinkingId = null,
  compact = false,
}: {
  blocks: readonly Block[]
  ctx: RowContext
  tone?: 'bright' | 'muted'
  liveTextId?: string | null
  liveThinkingId?: string | null
  compact?: boolean
}) {
  const chunks = useMemo<WorkChunk[]>(
    () => (compact ? chunkWork(blocks, ctx.tasksByToolCall) : blocks.map((block) => ({ kind: 'single', block }))),
    [blocks, ctx.tasksByToolCall, compact],
  )
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {chunks.map((chunk) =>
        chunk.kind === 'single' ? (
          <WorkRow
            key={chunk.block.id}
            block={chunk.block}
            ctx={ctx}
            tone={tone}
            live={chunk.block.kind === 'assistant' && chunk.block.id === liveTextId}
            thinking={chunk.block.kind === 'assistant' && chunk.block.id === liveThinkingId}
          />
        ) : chunk.kind === 'tools' ? (
          <ToolGroupRow key={chunkKey(chunk)} blocks={chunk.blocks} ctx={ctx} />
        ) : (
          <LaunchGroupRow key={chunkKey(chunk)} kind={chunk.kind} blocks={chunk.blocks} ctx={ctx} />
        ),
      )}
    </div>
  )
})

/** Muted label that brightens on hover, like `TONE`. */
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
}) {
  const t = useTheme()
  return (
    <div
      testId={testId}
      onClick={onClick}
      style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, cursor: onClick ? 'pointer' : 'default' }}
    >
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

/** Two or more settled tools: one summary row ("Ran 3 commands, read 2 files"). */
const ToolGroupRow = memo(function ToolGroupRow({ blocks, ctx }: { blocks: ToolBlock[]; ctx: RowContext }) {
  const [open, setOpen] = useRowState(`group:${blocks[0]!.id}`, false)
  const summary = useMemo(() => summarizeToolCalls(blocks.map((b) => ({ call: b.call, complete: b.complete, isError: b.isError }))), [blocks])
  if (!summary)
    return (
      <>
        {blocks.map((block) => (
          <ToolRow key={block.id} block={block} ctx={ctx} />
        ))}
      </>
    )
  return (
    <div style={{ display: 'flex', flexDirection: 'column', paddingTop: 4, paddingBottom: 4 }}>
      <RowLine testId="tool-group" icon={workIcon(summary.visual, false)} label={summary.label} chevron={open ? 'open' : 'closed'} onClick={() => setOpen(!open)} />
      <Collapse open={open}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingTop: 2, marginLeft: 22 }}>
          {blocks.map((block) => (
            <ToolRow key={block.id} block={block} ctx={ctx} />
          ))}
        </div>
      </Collapse>
    </div>
  )
})

export const WorkRow = memo(function WorkRow({
  block,
  ctx,
  tone = 'muted',
  live = false,
  thinking = false,
}: {
  block: Block
  ctx: RowContext
  tone?: 'bright' | 'muted'
  live?: boolean
  thinking?: boolean
}) {
  const t = useTheme()
  switch (block.kind) {
    case 'tool':
      return <ToolRow block={block} ctx={ctx} />
    case 'image':
      return <ResponseImage source={block.source} />
    case 'assistant':
      return <AssistantWorkRow block={block} tone={tone} live={live} thinkingLive={thinking} />
    case 'runtime_task':
      return <RuntimeTaskRow task={block.task} thread={block.task.kind === 'agent' ? launchThread(block, ctx) : undefined} />
    case 'approval': {
      const text = approvalRowText(block.approval, block.decision, live)
      const denied = block.decision?.decision === 'deny'
      const color = denied ? destructive(t, 0.85) : block.decision ? fg(t, 0.8) : muted(t)
      const secret = secretRequestInput(block.approval)
      const coordinator = coordinatorCardLine(block.approval, block.decision, live)
      const userInput = isUserInput(block.approval)
      const icon = secret || coordinator ? <RowIcon box={20} size={16} source={block.decision?.decision === 'submit' || block.decision?.decision === 'allow_once' ? T.check : secret ? T.key : T.note} color={block.decision?.decision === 'submit' ? t.green : muted(t)} /> : userInput ? (
        <RowIcon box={20} size={16} source={!block.decision ? T.question : denied ? T.alert : T.checkSquare} color={denied ? destructive(t, 0.85) : block.decision ? fg(t, 0.75) : muted(t)} />
      ) : block.decision ? (
        <RowIcon box={20} size={16} source={T.check} color={fg(t, 0.75)} />
      ) : (
        <div style={{ display: 'flex', width: 20, height: 20, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <MatrixLoader />
        </div>
      )
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 4, paddingBottom: 4, minWidth: 0 }}>
          {/* `IconSwap` loader → check once the request is answered. */}
          {userInput || secret || coordinator ? icon : <SwapOnChange active={block.decision ? 'done' : 'waiting'} style={{ flexShrink: 0 }}>{icon}</SwapOnChange>}
          <Label color={color} lineHeight={ROW_LINE} truncate>
            {text}
          </Label>
        </div>
      )
    }
    case 'notice':
      return (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, paddingTop: 4, paddingBottom: 4, minWidth: 0 }}>
          <RowIcon box={20} size={16} source={T.alert} color={block.level === 'error' ? t.red : muted(t)} />
          <Para color={block.level === 'error' ? t.red : muted(t)} lineHeight={ROW_LINE} selectable style={{ flexGrow: 1 }}>
            {block.text}
          </Para>
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

const ToolRow = memo(function ToolRow({ block, ctx }: { block: ToolBlock; ctx: RowContext }) {
  const t = useTheme()
  const [open, setOpen] = useRowState(`tool:${block.id}`, false)
  const task = ctx.tasksByToolCall.get(block.call.id)
  const active = !!task && isTaskActive(task)
  const view = useMemo(() => {
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
  }, [block, active])
  const children = ctx.childrenByParent.get(block.call.id) ?? []
  // A launch whose child thread is known opens it (`SubagentLaunchRow`, `DelegationLaunchRow`).
  const child = isAgentLaunchBlock(block, task) || isDelegationLaunchBlock(block) ? launchThread(block, ctx) : undefined
  const opensActivity = isAgentLaunchBlock(block, task) || !!child
  const canExpand = !opensActivity && (children.length > 0 || view.hasOutput)
  const tone = block.isError ? destructive(t, 0.8) : muted(t)
  const nested = view.activity.kind === 'delegate' ? 'Subagent activity' : 'Nested activity'
  // Decided once on mount: only a row that just arrived plays `t-row-enter`.
  const fresh = useFresh(block.at)
  if (isAgentLaunchBlock(block, task) || isDelegationLaunchBlock(block)) return <LaunchMember block={block} thread={child} task={task} delegated={isDelegationLaunchBlock(block)} />
  if (orchestrationTool(block.call.name) === 'thread_send' && parseSendInput(block.call.input).threadId) return <SentToRow block={block} threadId={ctx.threadId} />
  return (
    <Rise kind="row" play={fresh} style={{ paddingTop: 4, paddingBottom: 4, minWidth: 0 }}>
      <RowLine
        testId={`tool-row-${block.call.id}`}
        icon={workIcon(view.visual, block.isError)}
        iconColor={tone}
        label={view.label}
        labelColor={tone}
        shimmer={!block.complete || active}
        trailing={
          view.surface?.app && !view.label.endsWith(view.surface.app) ? (
            <Label color={muted(t, 0.55)} size={11}>
              {view.surface.app}
            </Label>
          ) : undefined
        }
        chevron={opensActivity ? 'forward' : canExpand ? (open ? 'open' : 'closed') : undefined}
        onClick={child ? () => openThread(child.id) : canExpand ? () => setOpen(!open) : undefined}
      />
      {view.item?.write && agentItemWriteResult(view.itemResult) && (!ctx.inlineItemIds || ctx.inlineItemIds.has(block.call.id)) && <AgentItemCard result={agentItemWriteResult(view.itemResult)!} />}
      {canExpand && (
        <Collapse open={open} testId={`tool-panel-${block.call.id}`}>
        <div style={{ display: 'flex', flexDirection: 'column', marginLeft: 22, paddingTop: 6, minWidth: 0 }}>
          {children.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', paddingBottom: view.hasOutput ? 10 : 0 }}>
              <Label color={muted(t, 0.45)} size={11} lineHeight={20} style={{ paddingBottom: 2 }}>
                {nested}
              </Label>
              <WorkRows blocks={children} ctx={ctx} />
            </div>
          )}
          {view.hasOutput && (
            <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              {children.length > 0 && (
                <Label color={muted(t, 0.45)} size={11} lineHeight={20} style={{ paddingBottom: 4 }}>
                  Result
                </Label>
              )}
              <ToolResult block={block} threadId={ctx.threadId} surface={view.surface} item={!!view.item} screenshots={view.screenshots} />
            </div>
          )}
        </div>
        </Collapse>
      )}
    </Rise>
  )
})

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

const AssistantWorkRow = memo(function AssistantWorkRow({ block, tone, live, thinkingLive }: { block: Extract<Block, { kind: 'assistant' }>; tone: 'bright' | 'muted'; live: boolean; thinkingLive: boolean }) {
  const t = useTheme()
  const [open, setOpen] = useRowState(`thinking:${block.id}`, false)
  const hasThinking = block.thinking.trim().length > 0
  const hasText = block.text.trim().length > 0
  const showText = hasText && (!live || block.complete || shouldRevealLiveText(block.text, block.complete))
  // Only the segment receiving deltas is paced; settled prose renders whole.
  const text = useSmoothText(block.text, live && !block.complete && process.env.KYBERN_SMOOTH_STREAM !== '0', block.complete)
  if (!hasThinking && !showText) return null
  return (
    <>
      {hasThinking && (
        <div style={{ display: 'flex', flexDirection: 'column', paddingTop: 4, paddingBottom: 4 }}>
          <div testId={`thought-${block.id}`} onClick={() => setOpen(!open)} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            {/* `IconSwap` spinner → brain and `TextSwap` "Thinking" → "Thought". */}
            <SwapOnChange active={thinkingLive ? 'live' : 'done'} style={{ flexShrink: 0 }}>
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
            <div style={{ display: 'flex', paddingTop: 8, marginLeft: 28 }}>
              <text style={{ color: muted(t), fontSize: TEXT.size, lineHeight: TEXT.lineHeight, fontFamily: FONT_UI, userSelect: 'text' }}>{block.thinking}</text>
            </div>
          </Collapse>
        </div>
      )}
      {showText && (
        <div style={{ display: 'flex', flexDirection: 'column', paddingLeft: 2, paddingRight: 2 }}>
          <BoundedMarkdown text={text} tone={tone} />
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
  return (
    <div style={{ paddingTop: 4, paddingBottom: 4 }}>
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
    </div>
  )
}

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
  return (
    <div style={{ display: 'flex', flexDirection: 'column', marginTop: 4, marginBottom: 4 }}>
      <div testId={`launch-group-${blocks[0]!.id}`} onClick={() => setChosen(!expanded)} style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 6, paddingBottom: 6, paddingRight: 6, cursor: 'pointer' }}>
        <div style={{ display: 'flex', width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: t.buttonSecondary, flexShrink: 0 }}>
          <Icon source={T.robot} size={13} color={muted(t)} />
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
          {members.map(member => <LaunchMember key={member.key} block={member.block} thread={member.thread} task={member.task} delegated={kind === 'delegations'} />)}
        </div>
      </PanelEnter></PanelPresence>
    </div>
  )
})

export { isDelegationLaunchBlock }
