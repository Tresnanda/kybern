// How a turn's work blocks fold into rows: runs of settled tool calls become one group,
// and two or more subagent launches become one "N subagents" row.

import type { Block } from "../../../../packages/kybern-client/src/transcript.ts"
import type { RuntimeTask } from "../../../../packages/kybern-client/src/types.ts"
import { agentItemTool } from "./agentItemTools"
import { isAgentLaunchTool } from "./toolActivity"

type ToolBlock = Extract<Block, { kind: "tool" }>

export type WorkChunk =
  | { kind: "single"; block: Block }
  | { kind: "tools"; blocks: ToolBlock[] }
  /** Two or more subagent launches (tool calls or runtime tasks), launch order. */
  | { kind: "subagents"; blocks: Block[] }

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

/** Reasoning with no answer text: it may sit between two launches without breaking a group. */
const isThinkingOnly = (block: Block) => block.kind === "assistant" && !block.text.trim()

export function chunkWork(blocks: readonly Block[], tasksByToolCall: ReadonlyMap<string, RuntimeTask>): WorkChunk[] {
  const chunks: WorkChunk[] = []
  let tools: ToolBlock[] = []
  let launches: Block[] = []
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
    if (launches.length >= 2) chunks.push({ kind: "subagents", blocks: launches })
    else if (launches[0]) chunks.push({ kind: "single", block: launches[0] })
    for (const block of held) chunks.push({ kind: "single", block })
    launches = []
    held = []
    absorbed = []
  }

  for (const block of blocks) {
    if (isSubagentLaunchBlock(block, tasksByToolCall)) {
      flushTools()
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
      return `group:${chunk.blocks[0]!.id}`
    case "subagents":
      return `subagents:${chunk.blocks[0]!.id}`
  }
}
