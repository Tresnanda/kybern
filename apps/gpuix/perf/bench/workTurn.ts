// A busy agent turn for `KYBERN_BENCH_STREAM_WORK=1` (perf/work-groups-2026-10-23.md): reasoning, a short narration, then
// a run of tool calls, repeated. One payload per stream tick, deterministic, provider events only (no thread/turn/seq).
// Each segment is 15 ticks: three reasoning deltas, its end, two narration deltas, the message, four tools started and
// finished; every seventh tool fails. The narration keeps the "Streaming paragraph" text the stream scenarios wait for.

const FILES = ['src/transcript/Turn.tsx', 'src/requests/Requests.tsx', 'apps/desktop/src/lib/workChunks.ts', 'styles/system.css', 'crates/kybern-store/src/projection.rs', 'README.md']
const COMMANDS = ['bun test src/transcript', 'pnpm typecheck', 'cargo test -p kybern-store', 'git status --short']
const QUERIES = ['chunkWork', 'useFresh', 'TreeGroup', 'summarizeToolCalls']

export const WORK_TICKS_PER_SEGMENT = 15

const origin = { kind: 'root' }
const message = (segment: number) => `bench-work-${segment}`
const thinking = (segment: number) => `Checking how step ${segment} fits the transcript. `
const narration = (segment: number, part: number) => part === 0 ? `Streaming paragraph ${segment}: the tools below ` : `preserve **formatted output** and Unicode 🌿.\n\n`

function toolCall(segment: number, index: number) {
  const n = segment * 4 + index, id = `bench-work-tool-${n}`
  switch (index) {
    case 0: return { id, name: 'Read', input: { file_path: `/workspace/${FILES[n % FILES.length]}` } }
    case 1: return { id, name: 'Grep', input: { pattern: QUERIES[segment % QUERIES.length], path: 'src' } }
    case 2: return { id, name: 'Edit', input: { file_path: `/workspace/${FILES[(n + 2) % FILES.length]}`, old_string: 'const a = 1\nconst b = 2', new_string: 'const a = 1\nconst b = 3\nconst c = 4' } }
    default: return { id, name: 'Bash', input: { command: COMMANDS[segment % COMMANDS.length] } }
  }
}

/** The payload for stream tick `tick` (0-based). */
export function workTurnEvent(tick: number): Record<string, unknown> {
  const segment = Math.floor(tick / WORK_TICKS_PER_SEGMENT), step = tick % WORK_TICKS_PER_SEGMENT, id = message(segment)
  if (step < 3) return { kind: 'assistant_thinking_delta', message_id: id, origin, delta: thinking(segment) }
  if (step === 3) return { kind: 'assistant_thinking_completed', message_id: id, origin }
  if (step < 6) return { kind: 'assistant_text_delta', message_id: id, origin, delta: narration(segment, step - 4) }
  if (step === 6) return { kind: 'assistant_message_completed', message_id: id, origin, text: narration(segment, 0) + narration(segment, 1), thinking: thinking(segment).repeat(3) }
  const index = Math.floor((step - 7) / 2), call = toolCall(segment, index)
  if ((step - 7) % 2 === 0) return { kind: 'tool_call_started', call, origin }
  const failed = (segment * 4 + index) % 7 === 6
  return { kind: 'tool_call_completed', tool_call_id: call.id, output: failed ? 'Error: exit code 1' : `ok ${segment}.${index}\n`, is_error: failed }
}
