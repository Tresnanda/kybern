// Client-side transcript projection. Seeds from `threads.get`, then folds live
// `ThreadEvent`s into blocks the views render directly.

import { reloadOnHotUpdate } from "@/lib/hot"
import type {
  ApprovalDecision,
  ApprovalRequest,
  Checkpoint,
  EventOrigin,
  JsonValue,
  NoticeLevel,
  RuntimeTask,
  StopReason,
  Thread,
  ThreadEvent,
  ThreadsGetResult,
  ToolCall,
  TranscriptEntry,
  TurnId,
  Usage,
  UserMessage,
} from "@/protocol"

export type Block =
  | { kind: "image"; id: string; turnId: TurnId; at: string; seq: number; source: string }
  | { kind: "user"; id: string; turnId: TurnId; at: string; seq: number; message: UserMessage }
  | {
      kind: "assistant"
      id: string
      turnId: TurnId
      at: string
      seq: number
      origin: EventOrigin
      /** Canonical provider message id shared by its ordered render segments. */
      messageId: string
      /** Stable render segment opened after a row-making event. */
      segment: number
      text: string
      thinking: string
      complete: boolean
    }
  | {
      kind: "tool"
      id: string
      turnId: TurnId
      at: string
      seq: number
      origin: EventOrigin
      call: ToolCall
      stream: string
      output: JsonValue | null
      isError: boolean
      complete: boolean
    }
  | { kind: "runtime_task"; id: string; turnId: TurnId; at: string; seq: number; task: RuntimeTask }
  | { kind: "approval"; id: string; turnId: TurnId; at: string; seq: number; approval: ApprovalRequest; decision: ApprovalDecision | null }
  | { kind: "notice"; id: string; turnId: TurnId; at: string; seq: number; level: NoticeLevel; text: string }
  | {
      kind: "turn_end"
      id: string
      turnId: TurnId
      at: string
      seq: number
      stopReason: StopReason
      usage: Usage
      costUsd: number | null
      durationMs: number
      terminalMessageId: string | null
      error: string | null
    }
  | { kind: "reverted"; id: string; turnId: TurnId; at: string; seq: number; commit: string }

export interface ThreadState {
  thread: Thread | null
  blocks: Block[]
  pendingApprovals: ApprovalRequest[]
  checkpoints: Checkpoint[]
  lastSeq: number
  loaded: boolean
}

export const emptyThreadState = (): ThreadState => ({
  thread: null,
  blocks: [],
  pendingApprovals: [],
  checkpoints: [],
  lastSeq: 0,
  loaded: false,
})

export function seedFromGet(res: ThreadsGetResult, prev?: ThreadState): ThreadState {
  return {
    thread: res.thread,
    blocks: res.transcript.map(entryToBlock).filter((b): b is Block => !!b),
    pendingApprovals: res.pending_approvals,
    checkpoints: prev?.checkpoints ?? [],
    lastSeq: res.thread.last_seq,
    loaded: true,
  }
}

function entryToBlock(e: TranscriptEntry): Block | null {
  switch (e.role) {
    case "image": return e.origin.kind === "root" ? { kind: "image", id: e.id, turnId: e.turn_id, at: e.at, seq: e.seq, source: e.source } : null
    case "approval":
      return { kind: "approval", id: `approval:${e.approval.id}`, turnId: e.turn_id, at: e.approval.created_at, seq: e.seq ?? 0, approval: e.approval, decision: e.decision ?? null }
    case "user":
      return { kind: "user", id: e.id, turnId: e.turn_id, at: e.at, seq: e.seq ?? 0, message: e.message }
    case "assistant": {
      const origin = e.origin ?? ROOT_ORIGIN
      if (origin.kind !== "root") return null
      const segment = e.segment ?? 0
      return { kind: "assistant", id: `${e.id}#${segment}`, turnId: e.turn_id, at: e.at, seq: e.seq ?? 0, origin, messageId: e.id, segment, text: e.text, thinking: e.thinking ?? "", complete: e.complete }
    }
    case "tool_call":
      return {
        kind: "tool",
        id: `tool:${e.call.id}`,
        turnId: e.turn_id,
        at: e.at,
        seq: e.seq ?? 0,
        origin: e.origin ?? ROOT_ORIGIN,
        call: e.call,
        stream: "",
        output: e.output ?? null,
        isError: e.is_error,
        complete: e.complete,
      }
    case "runtime_task":
      return { kind: "runtime_task", id: `task:${e.task.id}`, turnId: e.turn_id, at: e.at, seq: e.seq ?? e.task.started_seq ?? 0, task: e.task }
    case "notice":
      return { kind: "notice", id: `notice:${e.seq}`, turnId: e.turn_id, at: e.at, seq: e.seq ?? 0, level: e.level, text: e.text }
    case "reverted":
      return { kind: "reverted", id: `revert:${e.seq}`, turnId: e.turn_id, at: e.at, seq: e.seq ?? 0, commit: e.commit }
    case "turn_summary":
      return {
        kind: "turn_end",
        id: `end:${e.turn_id}`,
        turnId: e.turn_id,
        at: e.at,
        seq: e.seq ?? 0,
        stopReason: e.stop_reason,
        usage: e.usage,
        costUsd: e.cost_usd ?? null,
        durationMs: e.duration_ms,
        terminalMessageId: e.terminal_message_id ?? null,
        error: e.error ?? null,
      }
    default:
      return null
  }
}

const ROOT_ORIGIN = { kind: "root" } as const satisfies EventOrigin

/** Fold one event. Returns the same object when nothing changed. */
export function applyEvent(state: ThreadState, ev: ThreadEvent): ThreadState {
  if (ev.seq <= state.lastSeq) return state
  const at = ev.at
  let blocks = state.blocks
  // Claude Code can finish a provisional foreground result while a background
  // agent is still running, then resume the root assistant from an internal
  // task notification. Older daemons persisted that continuation without a
  // turn id. Recover it onto the most recent turn instead of creating a second
  // anonymous "Worked" group.
  const turnId = ev.turn_id ?? (isAssistantEvent(ev) ? latestTurnId(blocks) : "")
  let pending = state.pendingApprovals
  let checkpoints = state.checkpoints
  let thread = state.thread

  switch (ev.kind) {
    case "thread_created":
    case "thread_updated":
      thread = ev.thread
      break
    case "thread_archived":
      if (thread) thread = { ...thread, status: "archived" }
      break
    case "turn_started":
      blocks = [...blocks, { kind: "user", id: ev.message_id, turnId, at, seq: ev.seq, message: ev.message }]
      break
    case "image_received":
      if (ev.turn_id && ev.origin.kind === "root" && !blocks.some((block) => block.kind === "image" && block.id === ev.id && block.turnId === ev.turn_id)) blocks = [...blocks, { kind: "image", id: ev.id, turnId: ev.turn_id, at, seq: ev.seq, source: ev.source }]
      break
    case "assistant_text_delta": {
      const origin = ev.origin ?? ROOT_ORIGIN
      if (origin.kind !== "root") break
      const messageId = ev.turn_id == null ? continuationMessageId(blocks, turnId, ev.message_id) : ev.message_id
      const idx = findOpenAssistantSegment(blocks, messageId, origin)
      if (idx !== -1) {
        const b = blocks[idx]!
        if (b.kind === "assistant") blocks = replaceAt(blocks, idx, { ...b, text: b.text + ev.delta })
      } else {
        const segment = nextAssistantSegment(blocks, messageId, origin)
        blocks = [...blocks, { kind: "assistant", id: `${messageId}#${segment}`, turnId, at, seq: ev.seq, origin, messageId, segment, text: ev.delta, thinking: "", complete: false }]
      }
      break
    }
    case "assistant_thinking_delta": {
      const origin = ev.origin ?? ROOT_ORIGIN
      if (origin.kind !== "root") break
      const messageId = ev.turn_id == null ? continuationMessageId(blocks, turnId, ev.message_id) : ev.message_id
      const idx = findOpenAssistantSegment(blocks, messageId, origin)
      if (idx !== -1) {
        const b = blocks[idx]!
        if (b.kind === "assistant") blocks = replaceAt(blocks, idx, { ...b, thinking: b.thinking + ev.delta })
      } else {
        const segment = nextAssistantSegment(blocks, messageId, origin)
        blocks = [...blocks, { kind: "assistant", id: `${messageId}#${segment}`, turnId, at, seq: ev.seq, origin, messageId, segment, text: "", thinking: ev.delta, complete: false }]
      }
      break
    }
    case "assistant_message_completed": {
      const origin = ev.origin ?? ROOT_ORIGIN
      if (origin.kind !== "root") break
      const messageId = ev.turn_id == null ? continuationMessageId(blocks, turnId, ev.message_id) : ev.message_id
      let indices = assistantSegmentIndices(blocks, messageId, origin)
      if (indices.length === 0) {
        const segment = nextAssistantSegment(blocks, messageId, origin)
        blocks = [...blocks, { kind: "assistant", id: `${messageId}#${segment}`, turnId, at, seq: ev.seq, origin, messageId, segment, text: ev.text, thinking: ev.thinking ?? "", complete: true }]
      } else {
        const lastIsTail = indices.at(-1) === blocks.length - 1
        const streamedText = indices.map((index) => {
          const block = blocks[index]
          return block?.kind === "assistant" ? block.text : ""
        }).join("")
        const streamedThinking = indices.map((index) => {
          const block = blocks[index]
          return block?.kind === "assistant" ? block.thinking : ""
        }).join("")
        const trailingText = !lastIsTail && ev.text.startsWith(streamedText) ? ev.text.slice(streamedText.length) : ""
        const trailingThinking = !lastIsTail && ev.thinking?.startsWith(streamedThinking) ? ev.thinking.slice(streamedThinking.length) : ""
        if (trailingText || trailingThinking) {
          const segment = nextAssistantSegment(blocks, messageId, origin)
          blocks = [...blocks, { kind: "assistant", id: `${messageId}#${segment}`, turnId, at, seq: ev.seq, origin, messageId, segment, text: trailingText, thinking: trailingThinking, complete: true }]
          indices = [...indices, blocks.length - 1]
        }
        blocks = reconcileAssistantField(blocks, indices, ev.text, "text")
        if (ev.thinking != null) blocks = reconcileAssistantField(blocks, indices, ev.thinking, "thinking")
        blocks = blocks.map((block, index) =>
          indices.includes(index) && block.kind === "assistant" ? { ...block, complete: true } : block,
        )
      }
      break
    }
    case "tool_call_started":
      blocks = [
        ...blocks,
        { kind: "tool", id: `tool:${ev.call.id}`, turnId, at, seq: ev.seq, origin: ev.origin ?? ROOT_ORIGIN, call: ev.call, stream: "", output: null, isError: false, complete: false },
      ]
      break
    case "tool_call_output_delta": {
      const idx = findLast(blocks, `tool:${ev.tool_call_id}`)
      const b = blocks[idx]
      if (b && b.kind === "tool") blocks = replaceAt(blocks, idx, { ...b, stream: b.stream + ev.delta })
      break
    }
    case "tool_call_completed": {
      const idx = findLast(blocks, `tool:${ev.tool_call_id}`)
      const b = blocks[idx]
      if (b && b.kind === "tool") blocks = replaceAt(blocks, idx, { ...b, output: ev.output, isError: ev.is_error, complete: true })
      break
    }
    case "runtime_task_started":
    case "runtime_task_updated":
    case "runtime_task_completed": {
      const idx = findLast(blocks, `task:${ev.task.id}`)
      const current = blocks[idx]
      const startedSeq = current?.kind === "runtime_task"
        ? current.task.started_seq || current.seq
        : ev.task.started_seq || ev.seq
      const task = { ...ev.task, started_seq: startedSeq, updated_seq: ev.seq }
      if (current?.kind === "runtime_task") {
        if (isActiveRuntimeStatus(current.task.status) || !isActiveRuntimeStatus(task.status)) {
          blocks = replaceAt(blocks, idx, { ...current, task })
        }
      } else {
        blocks = [...blocks, { kind: "runtime_task", id: `task:${task.id}`, turnId: task.origin_turn_id || turnId, at: task.started_at || at, seq: startedSeq, task }]
      }
      break
    }
    case "user_input_requested":
    case "approval_requested":
      if (!pending.some((a) => a.id === ev.approval.id)) pending = [...pending, ev.approval]
      blocks = [...blocks, { kind: "approval", id: `approval:${ev.approval.id}`, turnId, at, seq: ev.seq, approval: ev.approval, decision: null }]
      break
    case "approval_resolved": {
      pending = pending.filter((a) => a.id !== ev.approval_id)
      const idx = findLast(blocks, `approval:${ev.approval_id}`)
      const b = blocks[idx]
      if (b && b.kind === "approval") blocks = replaceAt(blocks, idx, { ...b, decision: ev.decision })
      break
    }
    case "turn_completed":
      blocks = [
        ...finishTurn(blocks, turnId),
        {
          kind: "turn_end",
          id: `end:${turnId}`,
          turnId,
          at,
          seq: ev.seq,
          stopReason: ev.stop_reason,
          usage: ev.usage,
          costUsd: ev.cost_usd,
          durationMs: ev.duration_ms,
          terminalMessageId: ev.terminal_message_id ?? null,
          error: null,
        },
      ]
      break
    case "turn_failed":
      blocks = [
        ...finishTurn(blocks, turnId),
        {
          kind: "turn_end",
          id: `end:${turnId}`,
          turnId,
          at,
          seq: ev.seq,
          stopReason: "error",
          usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
          costUsd: null,
          durationMs: 0,
          terminalMessageId: null,
          error: ev.error,
        },
      ]
      break
    case "provider_notice":
      blocks = [...blocks, { kind: "notice", id: `notice:${ev.seq}`, turnId, at, seq: ev.seq, level: ev.level, text: ev.text }]
      break
    case "checkpoint_updated": {
      const i = checkpoints.findIndex((c) => c.turn_id === ev.checkpoint.turn_id)
      checkpoints = i === -1 ? [...checkpoints, ev.checkpoint] : replaceAt(checkpoints, i, ev.checkpoint)
      break
    }
    case "workspace_reverted":
      blocks = [...blocks, { kind: "reverted", id: `revert:${ev.seq}`, turnId, at, seq: ev.seq, commit: ev.commit }]
      break
    case "provider_session_bound":
      break
    default:
      break
  }
  return { thread, blocks, pendingApprovals: pending, checkpoints, lastSeq: ev.seq, loaded: state.loaded }
}

function isAssistantEvent(ev: ThreadEvent): boolean {
  return ev.kind === "assistant_text_delta" || ev.kind === "assistant_thinking_delta" || ev.kind === "assistant_message_completed"
}

function latestTurnId(blocks: readonly Block[]): TurnId {
  for (let index = blocks.length - 1; index >= 0; index--) {
    const turnId = blocks[index]?.turnId
    if (turnId) return turnId
  }
  return ""
}

/**
 * Some historical Claude continuation chunks were assigned a fresh id per
 * delta after the daemon had already cleared its active turn. While such a
 * continuation is open, keep using its first id so the completed message can
 * reconcile the streamed chunks instead of duplicating them.
 */
function continuationMessageId(blocks: readonly Block[], turnId: TurnId, incoming: string): string {
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index]
    if (block?.kind === "turn_end" && block.turnId === turnId) break
    if (block?.kind === "assistant" && block.turnId === turnId && !block.complete) return block.messageId
  }
  return incoming
}

function findOpenAssistantSegment(blocks: readonly Block[], messageId: string, origin: EventOrigin): number {
  const index = blocks.length - 1
  const block = blocks[index]
  return block?.kind === "assistant" && !block.complete && block.messageId === messageId && sameOrigin(block.origin, origin)
    ? index
    : -1
}

function nextAssistantSegment(blocks: readonly Block[], messageId: string, origin: EventOrigin): number {
  let max = -1
  for (const block of blocks) {
    if (block.kind === "assistant" && block.messageId === messageId && sameOrigin(block.origin, origin)) {
      max = Math.max(max, block.segment)
    }
  }
  return max + 1
}

function assistantSegmentIndices(blocks: readonly Block[], messageId: string, origin: EventOrigin): number[] {
  return blocks.flatMap((block, index) =>
    block.kind === "assistant" && block.messageId === messageId && sameOrigin(block.origin, origin) ? [index] : [],
  )
}

function sameOrigin(left: EventOrigin, right: EventOrigin): boolean {
  return left.kind === right.kind &&
    (left.kind === "root" ||
      (right.kind === "agent" && left.task_id === right.task_id && left.provider_thread_id === right.provider_thread_id))
}

function reconcileAssistantField(
  blocks: Block[],
  indices: readonly number[],
  canonical: string,
  field: "text" | "thinking",
): Block[] {
  const pieces = indices.map((index) => {
    const block = blocks[index]
    return block?.kind === "assistant" ? block[field] : ""
  })
  const streamed = pieces.join("")
  if (streamed === canonical) return blocks

  let commonPrefix = 0
  const streamedChars = Array.from(streamed)
  const canonicalChars = Array.from(canonical)
  for (let position = 0; position < streamedChars.length; position++) {
    if (streamedChars[position] !== canonicalChars[position]) break
    commonPrefix += streamedChars[position]!.length
  }

  let targetPosition = field === "thinking" ? 0 : indices.length - 1
  if (streamed.length > 0) {
    let consumed = 0
    const found = pieces.findIndex((piece) => {
      const contains = commonPrefix < consumed + piece.length
      consumed += piece.length
      return contains
    })
    if (found !== -1) targetPosition = found
  }
  const consumedBefore = pieces.slice(0, targetPosition).reduce((total, piece) => total + piece.length, 0)
  const keep = Math.min(Math.max(0, commonPrefix - consumedBefore), pieces[targetPosition]?.length ?? 0)
  const replacement = `${pieces[targetPosition]?.slice(0, keep) ?? ""}${canonical.slice(commonPrefix)}`

  const next = blocks.slice()
  indices.forEach((index, position) => {
    const block = next[index]
    if (block?.kind !== "assistant") return
    const value = position < targetPosition ? pieces[position]! : position === targetPosition ? replacement : ""
    next[index] = { ...block, [field]: value }
  })
  return next
}

function isActiveRuntimeStatus(status: RuntimeTask["status"]): boolean {
  return status === "pending" || status === "running" || status === "waiting" || status === "stopping"
}

function finishTurn(blocks: Block[], turnId: TurnId): Block[] {
  return blocks.map((b) =>
    b.turnId === turnId && (b.kind === "assistant" || b.kind === "tool") && !b.complete ? { ...b, complete: true } : b,
  )
}

function findLast(blocks: Block[], id: string): number {
  for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i]!.id === id) return i
  return -1
}

function replaceAt<T>(arr: T[], idx: number, value: T): T[] {
  const out = arr.slice()
  out[idx] = value
  return out
}

// ---- turn grouping for the transcript view ----

export interface TurnGroup {
  turnId: TurnId
  user: Extract<Block, { kind: "user" }> | null
  /** Tool calls, thinking, notices and intermediate assistant text, in order. */
  images: Extract<Block, { kind: "image" }>[]
  work: Block[]
  /** Whole terminal root message. It is deliberately absent until settlement. */
  answer: Extract<Block, { kind: "assistant" }> | null
  /** Tail segment currently receiving root text, rendered in place while live. */
  liveTextId: string | null
  approvals: Extract<Block, { kind: "approval" }>[]
  end: Extract<Block, { kind: "turn_end" }> | null
  reverted: Extract<Block, { kind: "reverted" }> | null
  running: boolean
}

type AssistantBlock = Extract<Block, { kind: "assistant" }>
type ToolBlock = Extract<Block, { kind: "tool" }>
type RuntimeTaskBlock = Extract<Block, { kind: "runtime_task" }>

export interface WorkHierarchy {
  roots: Block[]
  childrenByParent: Map<string, ToolBlock[]>
  agentOwnedByTask: Map<string, ToolBlock[]>
  taskChildrenByParent: Map<string, RuntimeTaskBlock[]>
}

/**
 * Keep provider-owned tool activity beneath the tool that launched it. Unknown
 * parents remain at the root so a partial or older transcript never hides work.
 */
export function buildWorkHierarchy(blocks: readonly Block[]): WorkHierarchy {
  const toolIds = new Set(
    blocks.flatMap((block) => (block.kind === "tool" ? [block.call.id] : [])),
  )
  const toolParents = new Map(
    blocks.flatMap((block) => {
      if (block.kind !== "tool") return []
      const parentId = block.call.parent_id
      return parentId && parentId !== block.call.id && toolIds.has(parentId)
        ? [[block.call.id, parentId] as const]
        : []
    }),
  )
  const roots: Block[] = []
  const childrenByParent = new Map<string, ToolBlock[]>()
  const agentOwnedByTask = new Map<string, ToolBlock[]>()
  const taskIds = new Set(blocks.flatMap((block) => (block.kind === "runtime_task" ? [block.task.id] : [])))
  const taskChildrenByParent = new Map<string, RuntimeTaskBlock[]>()

  for (const block of blocks) {
    if (block.kind === "runtime_task") {
      if (block.task.tool_call_id && toolIds.has(block.task.tool_call_id)) continue
      const parentId = block.task.parent_id
      if (parentId && parentId !== block.task.id && taskIds.has(parentId)) {
        const children = taskChildrenByParent.get(parentId) ?? []
        children.push(block)
        taskChildrenByParent.set(parentId, children)
      } else {
        roots.push(block)
      }
      continue
    }
    if (block.kind !== "tool") {
      roots.push(block)
      continue
    }

    const parentId = block.call.parent_id
    const ancestors = new Set([block.call.id])
    let ancestorId = parentId ?? undefined
    while (ancestorId && !ancestors.has(ancestorId)) {
      ancestors.add(ancestorId)
      ancestorId = toolParents.get(ancestorId)
    }
    const cyclic = ancestorId !== undefined

    if (!parentId || parentId === block.call.id || !toolIds.has(parentId) || cyclic) {
      if (block.origin?.kind === "agent") {
        const owned = agentOwnedByTask.get(block.origin.task_id) ?? []
        owned.push(block)
        agentOwnedByTask.set(block.origin.task_id, owned)
        continue
      }
      roots.push(block)
      continue
    }
    const children = childrenByParent.get(parentId) ?? []
    children.push(block)
    childrenByParent.set(parentId, children)
  }

  return { roots, childrenByParent, agentOwnedByTask, taskChildrenByParent }
}

/**
 * A provider can emit a single token and then spend seconds preparing the
 * remainder. Keep the live status visible until the fragment has enough
 * meaning to read as output, instead of presenting a visibly stalled glyph.
 */
export function shouldRevealLiveText(text: string, complete: boolean): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  if (complete) return true
  return /\s/u.test(text) || Array.from(trimmed).length >= 12
}

function splitAssistantForPresentation(block: AssistantBlock): {
  answer: AssistantBlock
  reasoning: AssistantBlock | null
} {
  return {
    answer: block.thinking ? { ...block, thinking: "" } : block,
    reasoning: block.thinking.trim()
      ? { ...block, id: `reasoning:${block.id}`, text: "" }
      : null,
  }
}

/**
 * Rejoin the segments of one message (a provider may split its text across tool
 * calls) into a single block, concatenating text and thinking in order. Raw
 * concatenation reconstructs the original message exactly, so an inline code
 * span or word cut by a tool boundary is made whole again.
 */
function joinSegments(segs: AssistantBlock[]): AssistantBlock {
  const last = segs[segs.length - 1]!
  return {
    ...last,
    id: `answer:${last.messageId}`,
    text: segs.map((s) => s.text).join(""),
    thinking: segs.map((s) => s.thinking).join(""),
    complete: segs.every((s) => s.complete),
  }
}

export function groupTurns(blocks: Block[]): TurnGroup[] {
  const groups: TurnGroup[] = []
  const byId = new Map<string, TurnGroup>()
  const get = (turnId: TurnId) => {
    let g = byId.get(turnId)
    if (!g) {
      g = { turnId, user: null, images: [], work: [], answer: null, liveTextId: null, approvals: [], end: null, reverted: null, running: false }
      byId.set(turnId, g)
      groups.push(g)
    }
    return g
  }
  for (const b of blocks) {
    const g = get(b.turnId)
    switch (b.kind) {
      case "image": g.images.push(b); break
      case "user":
        g.user = b
        break
      case "approval":
        g.approvals.push(b)
        g.work.push(b)
        break
      case "turn_end":
        g.end = b
        break
      case "reverted":
        g.reverted = b
        break
      default:
        g.work.push(b)
    }
  }
  for (const g of groups) {
    g.running = !g.end && !!g.user
    // A final answer is a lifecycle fact, not a guess based on whichever
    // assistant message happened to arrive last. Until TurnCompleted, every
    // root message remains chronological narration in `work`.
    let termId = g.end?.terminalMessageId ?? null
    if (termId === null) {
      for (let i = g.work.length - 1; i >= 0 && g.end; i--) {
        const w = g.work[i]!
        if (w.kind === "assistant" && w.text.trim()) {
          termId = w.messageId
          break
        }
      }
    }
    if (termId !== null) {
      const segs = g.work.filter((w): w is AssistantBlock => w.kind === "assistant" && w.messageId === termId)
      const { answer, reasoning } = splitAssistantForPresentation(joinSegments(segs))
      g.answer = answer
      // Drop the joined segments from work, keeping the reasoning where the
      // message began so its collapsible thinking stays in reading order.
      const firstIdx = g.work.findIndex((w) => w.kind === "assistant" && w.messageId === termId)
      g.work = g.work.flatMap((w, i) =>
        w.kind === "assistant" && w.messageId === termId ? (i === firstIdx && reasoning ? [reasoning] : []) : [w],
      )
    }
    if (g.running) {
      const tail = g.work.at(-1)
      g.liveTextId = tail?.kind === "assistant" && !tail.complete && tail.text.trim() ? tail.id : null
    }
  }
  return groups
}

// Stateful module: a hot update would drop the live connection, so reload instead.
reloadOnHotUpdate(import.meta.hot)
