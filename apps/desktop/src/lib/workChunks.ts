// How a turn's work blocks fold into rows: runs of settled tool calls become one group,
// two or more subagent launches become one "N subagents" row, and two or more Kybern
// delegations (`kybern_agent_delegate`) become one "N delegated agents" row.

import type { Block } from "../../../../packages/kybern-client/src/transcript.ts"
import { isDelegateTool, orchestrationTool } from "../../../../packages/kybern-client/src/orchestrationTools.ts"
import type { RuntimeTask } from "../../../../packages/kybern-client/src/types.ts"
import { agentItemTool } from "./agentItemTools"
import { isAgentLaunchTool } from "./toolActivity"

type ToolBlock = Extract<Block, { kind: "tool" }>

export type WorkChunk =
  | { kind: "single"; block: Block }
  /**
   * Everything the agent did between two pieces of narration (`chunkRuns`): tool calls in any state, reasoning, and
   * background processes, in order. A block with both reasoning and text is a member for its reasoning and then a
   * `single` for its text.
   */
  | { kind: "run"; blocks: Block[] }
  | { kind: "tools"; blocks: ToolBlock[] }
  /** Two or more subagent launches (tool calls or runtime tasks), launch order. */
  | { kind: "subagents"; blocks: Block[] }
  /** Two or more `kybern_agent_delegate` calls, launch order. */
  | { kind: "delegations"; blocks: Block[] }

/** What `chunkWork` returns: every chunk but a run. */
export type ToolChunk = Exclude<WorkChunk, { kind: "run" }>

const isTaskActive = (task: RuntimeTask) =>
  task.status === "pending" || task.status === "running" || task.status === "waiting" || task.status === "stopping"

export function isAgentLaunchBlock(block: ToolBlock, task?: RuntimeTask): boolean {
  return task?.kind === "agent" || isAgentLaunchTool(block.call)
}

/** A block that starts a provider subagent: its launch tool call, or an agent runtime task. */
export function isSubagentLaunchBlock(block: Block, tasksByToolCall: ReadonlyMap<string, RuntimeTask>): boolean {
  if (block.kind === "tool") return isAgentLaunchBlock(block, tasksByToolCall.get(block.call.id))
  return block.kind === "runtime_task" && block.task.kind === "agent"
}

/** A `kybern_agent_delegate` call: it starts a Kybern child thread, not a provider subagent. */
export function isDelegationLaunchBlock(block: Block): boolean {
  return block.kind === "tool" && isDelegateTool(block.call.name)
}

/** A `kybern_thread_send` call: a message to another thread, worth its own row rather than a place in a tool group. */
export function isThreadSendBlock(block: Block): boolean {
  return block.kind === "tool" && orchestrationTool(block.call.name) === "thread_send"
}

/** Delegations and messages to other threads stay visible above a settled turn's "Worked for" fold. */
export function isOrchestrationBlock(block: Block): boolean {
  return isDelegationLaunchBlock(block) || isThreadSendBlock(block)
}

/** Reasoning with no answer text: it may sit between two launches without breaking a group. */
const isThinkingOnly = (block: Block) => block.kind === "assistant" && !block.text.trim()

export function chunkWork(blocks: readonly Block[], tasksByToolCall: ReadonlyMap<string, RuntimeTask>): ToolChunk[] {
  const chunks: ToolChunk[] = []
  let tools: ToolBlock[] = []
  let launches: Block[] = []
  let launchKind: "subagents" | "delegations" = "subagents"
  // Thinking seen since the last launch. If another launch follows it joins the group's
  // lead-in; otherwise it follows the group.
  let held: Block[] = []
  let absorbed: Block[] = []

  const flushTools = () => {
    if (tools.length >= 2) chunks.push({ kind: "tools", blocks: tools })
    else if (tools[0]) chunks.push({ kind: "single", block: tools[0] })
    tools = []
  }
  const flushLaunches = () => {
    for (const block of absorbed) chunks.push({ kind: "single", block })
    if (launches.length >= 2) chunks.push(launchKind === "delegations" ? { kind: "delegations", blocks: launches } : { kind: "subagents", blocks: launches })
    else if (launches[0]) chunks.push({ kind: "single", block: launches[0] })
    for (const block of held) chunks.push({ kind: "single", block })
    launches = []
    held = []
    absorbed = []
  }

  for (const block of blocks) {
    const delegation = isDelegationLaunchBlock(block)
    if (delegation || isSubagentLaunchBlock(block, tasksByToolCall)) {
      flushTools()
      // A different kind of launch starts its own group.
      if (launches.length > 0 && (launchKind === "delegations") !== delegation) flushLaunches()
      launchKind = delegation ? "delegations" : "subagents"
      if (launches.length > 0) {
        absorbed.push(...held)
        held = []
      }
      launches.push(block)
      continue
    }
    if (launches.length > 0 && isThinkingOnly(block)) {
      held.push(block)
      continue
    }
    flushLaunches()
    const linkedTask = block.kind === "tool" ? tasksByToolCall.get(block.call.id) : undefined
    if (
      block.kind === "tool" &&
      block.complete &&
      !block.isError &&
      !agentItemTool(block.call.name)?.write &&
      !isThreadSendBlock(block) &&
      (!linkedTask || !isTaskActive(linkedTask))
    ) {
      tools.push(block)
    } else {
      flushTools()
      chunks.push({ kind: "single", block })
    }
  }
  flushLaunches()
  flushTools()
  return chunks
}

/** Stable React/virtual key of a chunk. */
export function chunkKey(chunk: WorkChunk): string {
  switch (chunk.kind) {
    case "single":
      return chunk.block.id
    case "tools":
    case "run":
      return `group:${chunk.blocks[0]!.id}`
    case "subagents":
      return `subagents:${chunk.blocks[0]!.id}`
    case "delegations":
      return `delegations:${chunk.blocks[0]!.id}`
  }
}

/** A block that stays its own row between runs: narration, launches, approvals, messages, notices, images. */
function standsAlone(block: Block, tasksByToolCall: ReadonlyMap<string, RuntimeTask>): boolean {
  switch (block.kind) {
    case "tool":
      return isSubagentLaunchBlock(block, tasksByToolCall) || isDelegationLaunchBlock(block) || isThreadSendBlock(block) || !!agentItemTool(block.call.name)?.write
    case "runtime_task":
      return block.task.kind === "agent"
    case "assistant":
      return false
    default:
      return true
  }
}

/** Narration: answer text between the work, whether or not reasoning came before it in the same block. */
export const narrates = (block: Block) => block.kind === "assistant" && !!block.text.trim()

/**
 * Work folded around narration: every stretch of tool calls, reasoning and background processes between two pieces
 * of prose is one `run` (running and failed calls included), so a turn reads as prose with one compact summary row
 * per gap. Approvals, mid-turn messages, notices and images stand alone; launches keep their own groups
 * (`chunkWork`'s subagent and delegation rules). A run's key is its first block's, so it never changes as the run grows.
 */
export function chunkRuns(blocks: readonly Block[], tasksByToolCall: ReadonlyMap<string, RuntimeTask>): WorkChunk[] {
  const chunks: WorkChunk[] = []
  let run: Block[] = []
  let launches: Block[] = []
  const flushRun = () => {
    if (run.length > 0) chunks.push({ kind: "run", blocks: run })
    run = []
  }
  const flushLaunches = () => {
    if (launches.length > 0) chunks.push(...chunkWork(launches, tasksByToolCall))
    launches = []
  }
  for (const block of blocks) {
    if (isSubagentLaunchBlock(block, tasksByToolCall) || isDelegationLaunchBlock(block)) {
      flushRun()
      launches.push(block)
      continue
    }
    // Reasoning between launches stays with them (`chunkWork` keeps it above or after the group).
    if (launches.length > 0 && block.kind === "assistant" && !narrates(block)) {
      launches.push(block)
      continue
    }
    flushLaunches()
    if (standsAlone(block, tasksByToolCall)) {
      flushRun()
      chunks.push({ kind: "single", block })
      continue
    }
    if (block.kind === "assistant") {
      if (block.thinking.trim()) run.push(block)
      if (narrates(block)) {
        flushRun()
        chunks.push({ kind: "single", block })
      }
      continue
    }
    run.push(block)
  }
  flushLaunches()
  flushRun()
  return chunks
}
