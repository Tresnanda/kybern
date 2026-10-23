// Which tool rows of a turn get the "Sign in to …" chip (`SignInChip.tsx`): commands whose output says their CLI is signed out,
// the latest one per CLI. Pure, so it is tested without a window.
import { signInChips, type FinishedCommand, type LoginRecipe } from '../../../../packages/kybern-client/src/loginRecipes.ts'
import type { Block } from '../../../../packages/kybern-client/src/transcript.ts'
import type { JsonValue } from '../../../../packages/kybern-client/src/types.ts'

const record = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null)

/** The shell command a tool call ran (`command` as a string or argv, Codex's `cmd`), or ''. */
export function commandOf(input: JsonValue): string {
  const fields = record(input)
  const command = fields?.command ?? fields?.cmd
  if (typeof command === 'string') return command
  if (Array.isArray(command)) return command.filter((part): part is string => typeof part === 'string').join(' ')
  return ''
}

/** Everything a command printed that the row kept: plain output, stdout and stderr, and the live stream. */
export function printedText(output: JsonValue | null, stream: string): string {
  const pieces: string[] = []
  if (typeof output === 'string') pieces.push(output)
  const fields = record(output)
  if (fields) for (const key of ['output', 'stdout', 'stderr', 'content', 'text', 'result', 'error']) if (typeof fields[key] === 'string') pieces.push(fields[key] as string)
  if (stream) pieces.push(stream)
  return pieces.join('\n')
}

export function signInRows(work: readonly Block[]): Map<string, LoginRecipe> {
  const rows: FinishedCommand[] = []
  for (const block of work) {
    if (block.kind !== 'tool' || !block.complete) continue
    const command = commandOf(block.call.input)
    if (!command) continue
    rows.push({ id: block.call.id, command, output: printedText(block.output, block.stream), complete: true })
  }
  return rows.length ? signInChips(rows) : new Map()
}
