import { shouldRevealLiveText, type Block } from '../../../../packages/kybern-client/src/transcript.ts'

type Assistant = Extract<Block, { kind: 'assistant' }>

/** Text growth belongs to its row. Publish a new topology only when grouping,
 * disclosure, or the Thinking placeholder can actually change. */
function sameLiveShape(before: Block, after: Block): boolean {
  if (before.kind !== 'assistant' || after.kind !== 'assistant' || before.complete || after.complete) return false
  for (const key of Object.keys(after) as (keyof Assistant)[]) {
    if (key !== 'text' && key !== 'thinking' && before[key] !== after[key]) return false
  }
  return !!before.text.trim() === !!after.text.trim()
    && !!before.thinking.trim() === !!after.thinking.trim()
    && shouldRevealLiveText(before.text, false) === shouldRevealLiveText(after.text, false)
}

/** Per transcript owner; settled objects and the exposed array stay immutable.
 * A final/provider replacement always publishes canonical blocks immediately. */
export function createStreamTopology() {
  let input: Block[] | undefined, topology: Block[] = []
  return (blocks: Block[]): Block[] => {
    if (input === blocks) return topology
    input = blocks
    if (blocks.length !== topology.length) return topology = blocks
    let next: Block[] | undefined
    for (let i = 0; i < blocks.length; i++) {
      const before = topology[i]!, after = blocks[i]!
      if (before === after || sameLiveShape(before, after)) continue
      next ??= topology.slice()
      next[i] = after
    }
    if (next) topology = next
    return topology
  }
}
