// Client-side transcript projection. Seeds from `threads.get`, then folds live
// `ThreadEvent`s into blocks the views render directly.

import { reloadOnHotUpdate } from "@/lib/hot"
import type {
  ApprovalDecision,
  ApprovalRequest,
  Checkpoint,
  JsonValue,
  NoticeLevel,
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
  | { kind: "user"; id: string; turnId: TurnId; at: string; message: UserMessage }
  | {
      kind: "assistant"
      id: string
      turnId: TurnId
      at: string
      /** The provider message id this segment belongs to. */
      messageId: string
      /** Segment index within `messageId`; the fold splits text at row-making events. */
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
      call: ToolCall
      stream: string
      output: JsonValue | null
      isError: boolean
      complete: boolean
    }
  | { kind: "approval"; id: string; turnId: TurnId; at: string; approval: ApprovalRequest; decision: ApprovalDecision | null }
  | { kind: "notice"; id: string; turnId: TurnId; at: string; level: NoticeLevel; text: string }
  | {
      kind: "turn_end"
      id: string
      turnId: TurnId
      at: string
      stopReason: StopReason
      usage: Usage
      costUsd: number | null
      durationMs: number
      error: string | null
    }
  | { kind: "reverted"; id: string; turnId: TurnId; at: string; commit: string }

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
    case "approval":
      return { kind: "approval", id: `approval:${e.approval.id}`, turnId: e.turn_id, at: e.approval.created_at, approval: e.approval, decision: e.decision ?? null }
    case "user":
      return { kind: "user", id: e.id, turnId: e.turn_id, at: e.at, message: e.message }
    case "assistant": {
      const segment = e.segment ?? 0
      return { kind: "assistant", id: `${e.id}#${segment}`, turnId: e.turn_id, at: e.at, messageId: e.id, segment, text: e.text, thinking: e.thinking ?? "", complete: e.complete }
    }
    case "tool_call":
      return {
        kind: "tool",
        id: `tool:${e.call.id}`,
        turnId: e.turn_id,
        at: e.at,
        call: e.call,
        stream: "",
        output: e.output ?? null,
        isError: e.is_error,
        complete: e.complete,
      }
    case "turn_summary":
      return {
        kind: "turn_end",
        id: `end:${e.turn_id}`,
        turnId: e.turn_id,
        at: "",
        stopReason: e.stop_reason,
        usage: e.usage,
        costUsd: e.cost_usd ?? null,
        durationMs: e.duration_ms,
        error: e.error ?? null,
      }
    default:
      return null
  }
}

/** Fold one event. Returns the same object when nothing changed. */
export function applyEvent(state: ThreadState, ev: ThreadEvent): ThreadState {
  if (ev.seq <= state.lastSeq) return state
  const turnId = ev.turn_id ?? ""
  const at = ev.at
  let blocks = state.blocks
  let pending = state.pendingApprovals
  let checkpoints = state.checkpoints
  let thread = state.thread

  // The open segment for a message is only the tail block: once a tool call or
  // approval lands after it, the next delta opens a new segment there instead of
  // folding post-tool prose back above the tool. Mirrors `project_transcript`.
  const openSegment = (messageId: string): number => {
    const last = blocks[blocks.length - 1]
    return last && last.kind === "assistant" && last.messageId === messageId ? blocks.length - 1 : -1
  }
  const newSegment = (messageId: string, make: (segment: number) => Block) => {
    let max = -1
    for (const b of blocks) if (b.kind === "assistant" && b.messageId === messageId && b.segment > max) max = b.segment
    blocks = [...blocks, make(max + 1)]
  }

  switch (ev.kind) {
    case "thread_created":
    case "thread_updated":
      thread = ev.thread
      break
    case "thread_archived":
      if (thread) thread = { ...thread, status: "archived" }
      break
    case "turn_started":
      blocks = [...blocks, { kind: "user", id: ev.message_id, turnId, at, message: ev.message }]
      break
    case "assistant_text_delta": {
      const idx = openSegment(ev.message_id)
      if (idx !== -1) {
        const b = blocks[idx]!
        if (b.kind === "assistant") blocks = replaceAt(blocks, idx, { ...b, text: b.text + ev.delta })
      } else {
        newSegment(ev.message_id, (segment) => ({ kind: "assistant", id: `${ev.message_id}#${segment}`, turnId, at, messageId: ev.message_id, segment, text: ev.delta, thinking: "", complete: false }))
      }
      break
    }
    case "assistant_thinking_delta": {
      const idx = openSegment(ev.message_id)
      if (idx !== -1) {
        const b = blocks[idx]!
        if (b.kind === "assistant") blocks = replaceAt(blocks, idx, { ...b, thinking: b.thinking + ev.delta })
      } else {
        newSegment(ev.message_id, (segment) => ({ kind: "assistant", id: `${ev.message_id}#${segment}`, turnId, at, messageId: ev.message_id, segment, text: "", thinking: ev.delta, complete: false }))
      }
      break
    }
    case "assistant_message_completed": {
      const idxs = blocks.flatMap((b, i) => (b.kind === "assistant" && b.messageId === ev.message_id ? [i] : []))
      if (idxs.length === 0) {
        newSegment(ev.message_id, (segment) => ({ kind: "assistant", id: `${ev.message_id}#${segment}`, turnId, at, messageId: ev.message_id, segment, text: ev.text, thinking: ev.thinking ?? "", complete: true }))
      } else if (idxs.length === 1) {
        const i = idxs[0]!
        const b = blocks[i]!
        if (b.kind === "assistant") blocks = replaceAt(blocks, i, { ...b, text: ev.text, thinking: ev.thinking ?? b.thinking, complete: true })
      } else {
        // Interleaved across tools: keep the streamed slices in place (rewriting
        // them here would re-fold the answer above its tools); just finalize.
        const first = idxs[0]!
        blocks = blocks.map((b, i) =>
          idxs.includes(i) && b.kind === "assistant"
            ? { ...b, complete: true, thinking: i === first && ev.thinking != null ? ev.thinking : b.thinking }
            : b,
        )
      }
      break
    }
    case "tool_call_started":
      blocks = [
        ...blocks,
        { kind: "tool", id: `tool:${ev.call.id}`, turnId, at, call: ev.call, stream: "", output: null, isError: false, complete: false },
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
    case "approval_requested":
      if (!pending.some((a) => a.id === ev.approval.id)) pending = [...pending, ev.approval]
      blocks = [...blocks, { kind: "approval", id: `approval:${ev.approval.id}`, turnId, at, approval: ev.approval, decision: null }]
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
          stopReason: ev.stop_reason,
          usage: ev.usage,
          costUsd: ev.cost_usd,
          durationMs: ev.duration_ms,
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
          stopReason: "error",
          usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
          costUsd: null,
          durationMs: 0,
          error: ev.error,
        },
      ]
      break
    case "provider_notice":
      blocks = [...blocks, { kind: "notice", id: `notice:${ev.seq}`, turnId, at, level: ev.level, text: ev.text }]
      break
    case "checkpoint_updated": {
      const i = checkpoints.findIndex((c) => c.turn_id === ev.checkpoint.turn_id)
      checkpoints = i === -1 ? [...checkpoints, ev.checkpoint] : replaceAt(checkpoints, i, ev.checkpoint)
      break
    }
    case "workspace_reverted":
      blocks = [...blocks, { kind: "reverted", id: `revert:${ev.seq}`, turnId, at, commit: ev.commit }]
      break
    case "provider_session_bound":
      break
    default:
      break
  }
  return { thread, blocks, pendingApprovals: pending, checkpoints, lastSeq: ev.seq, loaded: state.loaded }
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
  work: Block[]
  /** Final assistant message of the settled turn (last assistant segment with text). */
  answer: Extract<Block, { kind: "assistant" }> | null
  /**
   * While the turn runs, the id of the tail assistant segment still streaming —
   * the one work row that reveals its text at the smooth cadence. Segments are
   * born in order, so this is always the last block; it never moves or flips.
   */
  liveAnswerId: string | null
  approvals: Extract<Block, { kind: "approval" }>[]
  end: Extract<Block, { kind: "turn_end" }> | null
  reverted: Extract<Block, { kind: "reverted" }> | null
  running: boolean
}

type AssistantBlock = Extract<Block, { kind: "assistant" }>
type ToolBlock = Extract<Block, { kind: "tool" }>

export interface WorkHierarchy {
  roots: Block[]
  childrenByParent: Map<string, ToolBlock[]>
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

  for (const block of blocks) {
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
      roots.push(block)
      continue
    }
    const children = childrenByParent.get(parentId) ?? []
    children.push(block)
    childrenByParent.set(parentId, children)
  }

  return { roots, childrenByParent }
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

export function groupTurns(blocks: Block[]): TurnGroup[] {
  const groups: TurnGroup[] = []
  const byId = new Map<string, TurnGroup>()
  const get = (turnId: TurnId) => {
    let g = byId.get(turnId)
    if (!g) {
      g = { turnId, user: null, work: [], answer: null, liveAnswerId: null, approvals: [], end: null, reverted: null, running: false }
      byId.set(turnId, g)
      groups.push(g)
    }
    return g
  }
  for (const b of blocks) {
    const g = get(b.turnId)
    switch (b.kind) {
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
    // The answer is the last assistant block with text; everything before it is "work".
    let answerIdx = -1
    for (let i = g.work.length - 1; i >= 0 && g.end; i--) {
      const w = g.work[i]!
      if (w.kind === "assistant" && w.text.trim()) {
        answerIdx = i
        break
      }
    }
    if (answerIdx !== -1) {
      const { answer, reasoning } = splitAssistantForPresentation(g.work[answerIdx] as AssistantBlock)
      g.answer = answer
      g.work = [
        ...g.work.slice(0, answerIdx),
        ...(reasoning ? [reasoning] : []),
        ...g.work.slice(answerIdx + 1),
      ]
    }
    g.running = !g.end && !!g.user
    if (g.running) {
      // Segments are born in tool order, so the assistant text streaming right
      // now is simply the tail block. Reveal that one at the smooth cadence; it
      // stays in place as tools land after it, so there is no promotion, no
      // brightness flip, and no repositioning.
      const tail = g.work.at(-1)
      g.liveAnswerId = tail?.kind === "assistant" && !tail.complete && tail.text.trim() ? tail.id : null
    }
  }
  return groups
}

// Stateful module: a hot update would drop the live connection, so reload instead.
reloadOnHotUpdate(import.meta.hot)
