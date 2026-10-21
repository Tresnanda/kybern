// P2.23 fixture: a live turn with three finished tool rows; key `c` settles it (assistant complete + turn_end, thread idle), `v` scrolls
// the tail-follow off by faking atTail=false is not possible here, so the "scrolled away" case is the unit of `Transcript`'s own ref.
import '../src/native/local-build.ts'
import { render } from '@gpuix/react'
import { emptyThreadState, type Block } from '../../../packages/kybern-client/src/transcript.ts'
import type { Thread } from '../../../packages/kybern-client/src/types.ts'
import { getState, set } from '../src/state.ts'
import { Transcript } from '../src/Transcript.tsx'
import { ThemeProvider, useTheme } from '../src/ui.tsx'
const at = new Date().toISOString()
const thread = { id: 'fold-fixture', title: 'Fold', project_id: 'fixture', provider: { kind: 'claude-code', instance: 'default' }, status: 'running', permission_mode: 'supervised', created_at: at, updated_at: at } as Thread
const user: Block = { kind: 'user', id: 'u', turnId: 'turn', at, seq: 1, message: { parts: [{ type: 'text', text: 'Fix the date helper.' }] } }
const tool = (n: number, name: string, input: object): Block => ({ kind: 'tool', id: `tool:t${n}`, turnId: 'turn', at, seq: 2 + n, origin: { kind: 'root' }, call: { id: `t${n}`, name, input }, stream: '', output: { text: 'ok' }, isError: false, complete: true } as unknown as Block)
const work: Block[] = [tool(1, 'Read', { file_path: 'src/date.ts' }), tool(2, 'Edit', { file_path: 'src/date.ts', old_string: 'a', new_string: 'b' }), tool(3, 'Bash', { command: 'bun test' })]
const answer = (text: string, complete: boolean): Block => ({ kind: 'assistant', id: 'a', messageId: 'a', segment: 0, turnId: 'turn', at, seq: 20, origin: { kind: 'root' }, text, thinking: '', complete })
set({ status: 'open', selectedId: thread.id, threads: [thread], open: { ...emptyThreadState(), loaded: true, thread, blocks: [user, ...work, answer('Looking at the helper.', false)] } })
function settle() {
  const idle = { ...thread, status: 'idle' } as Thread
  const end = { kind: 'turn_end', id: 'end:turn', turnId: 'turn', at: new Date().toISOString(), seq: 30, stopReason: 'end_turn', usage: {}, costUsd: null, durationMs: 48000, terminalMessageId: 'a' } as unknown as Block
  set({ threads: [idle], open: { ...getState().open, thread: idle, blocks: [user, ...work, answer('The helper now formats in UTC.', true), end] } })
}
function Fixture() { const t = useTheme(); return <div testId="fold-ready" onKeyDown={e => { if (e.key === 'c') settle() }} style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', backgroundColor: t.surface }}><Transcript /></div> }
render(<ThemeProvider><Fixture /></ThemeProvider>, { title: 'Fold', width: 1000, height: 640, focus: false })
process.stdin.on('end', () => process.exit(0))
