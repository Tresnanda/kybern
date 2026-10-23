// The words of a run's summary row (`WorkRunRow`): what the agent did between two pieces of narration, as one line.
// Settled calls are counted ("Edited 2 files · ran 3 commands · read 4 files"), the call in flight is the live tail
// ("reading Requests.tsx"), failures are counted apart. Pure, so the copy is tested without a window.
import { joinSummaryPhrases, toolLine, toolSummaryPhrases, toolTarget } from '../../../desktop/src/lib/toolActivity.ts'
import type { Block } from '../../../../packages/kybern-client/src/transcript.ts'
import type { ToolCall } from '../../../../packages/kybern-client/src/types.ts'

export interface RunSummary {
  /** Settled work, sentence case; empty while nothing has finished yet. */
  label: string
  /** What is happening now: lower case after a label ("reading Requests.tsx"), sentence case alone. */
  live: string | null
  /** "1 failed": calls that ended in an error (not counted in `label`). */
  failed: string | null
}

export const basename = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path

const lower = (text: string) => text.charAt(0).toLowerCase() + text.slice(1)
const upper = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** The call in flight, in present tense: "Reading Requests.tsx", "Running bun test", "Searching for chunkWork". */
export function liveAction(call: ToolCall): string {
  const activity = toolLine(call, false)
  const target = toolTarget(call, activity)
  if (target?.kind === 'files') return `${activity.verb} ${basename(target.paths[0]!)}${target.paths.length > 1 ? ` and ${target.paths.length - 1} more` : ''}`
  if (target?.kind === 'command') return `${activity.verb} ${target.command}`
  if (target?.kind === 'query') return `${activity.verb} for ${target.query}`
  return activity.detail ? `${activity.verb} ${activity.detail}` : activity.verb
}

/** The summary of a run's blocks. `liveThinkingId` is the reasoning still streaming, if it is in this run; `waiting`: the
 *  turn is live with nothing in flight and this run is its newest work (the agent is thinking about what comes next). */
export function runSummary(blocks: readonly Block[], liveThinkingId: string | null = null, waiting = false): RunSummary {
  const settled: { call: ToolCall; complete: boolean; isError: boolean }[] = []
  let failed = 0
  let background = 0
  let thought = false
  let live: string | null = null
  for (const block of blocks) {
    if (block.kind === 'tool') {
      if (block.isError) failed++
      else if (block.complete) settled.push({ call: block.call, complete: true, isError: false })
    } else if (block.kind === 'runtime_task') background++
    else if (block.kind === 'assistant' && block.thinking.trim()) thought = true
  }
  // The newest thing still happening is the tail: a call in flight, or reasoning still streaming.
  for (let i = blocks.length - 1; i >= 0 && live === null; i--) {
    const block = blocks[i]!
    if (block.kind === 'tool' && !block.complete) live = liveAction(block.call)
    else if (block.kind === 'assistant' && block.id === liveThinkingId) live = 'Thinking'
  }
  if (live === null && waiting) live = 'Thinking'
  const phrases = toolSummaryPhrases(settled)
  if (background > 0) phrases.push(`started ${background} background ${background === 1 ? 'task' : 'tasks'}`)
  const label = phrases.length > 0 ? joinSummaryPhrases(phrases) : !live && !failed ? (thought ? 'Thought' : 'Used tools') : ''
  return {
    label,
    live: live === null ? null : label ? lower(live) : upper(live),
    failed: failed === 0 ? null : label || live ? `${failed} failed` : `${failed} ${failed === 1 ? 'call' : 'calls'} failed`,
  }
}
