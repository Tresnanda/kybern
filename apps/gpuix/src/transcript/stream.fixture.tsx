import '../native/local-build.ts'
import { render } from '@gpuix/react'
import { emptyThreadState, type Block } from '../../../../packages/kybern-client/src/transcript.ts'
import type { Thread } from '../../../../packages/kybern-client/src/types.ts'
import { getState, set } from '../state.ts'
import { Transcript } from '../Transcript.tsx'
import { ThemeProvider, useTheme } from '../ui.tsx'
const at = new Date().toISOString()
const thread = { id: 'stream-fixture', title: 'Streaming', project_id: 'fixture', provider: { kind: 'claude-code', instance: 'default' }, status: 'running', permission_mode: 'supervised', created_at: at, updated_at: at } as Thread
const user: Block = { kind: 'user', id: 'u', turnId: 'turn', at, seq: 1, message: { parts: [{ type: 'text', text: 'Explain paced streaming.' }] } }
const answer: Block = { kind: 'assistant', id: 'a', messageId: 'a', segment: 0, turnId: 'turn', at, seq: 2, origin: { kind: 'root' }, text: '', thinking: '', complete: false }
set({ status: 'open', selectedId: thread.id, threads: [thread], open: { ...emptyThreadState(), loaded: true, thread, blocks: [user, answer] } })
let n = 0
const stopAt = Number(process.env.STREAM_STOP ?? Infinity)
const timer = setInterval(() => {
  if (n >= stopAt) {
    // `STREAM_COMPLETE=1`: the answer settles when the stream stops, as a finished turn does.
    if (process.env.STREAM_COMPLETE === '1' && !getState().open.blocks.some(b => b.kind === 'assistant' && b.complete)) {
      const idle = { ...thread, status: 'idle' } as Thread
      const end = { kind: 'turn_end', id: 'end:turn', turnId: 'turn', at: new Date().toISOString(), seq: 3, stopReason: 'end_turn', usage: {}, costUsd: null, durationMs: n * 300, terminalMessageId: 'a' } as unknown as Block
      set({ threads: [idle], open: { ...getState().open, thread: idle, blocks: [...getState().open.blocks.map(b => (b.kind === 'assistant' ? { ...b, complete: true } : b)), end] } })
    }
    return
  }
  n++
  // `STREAM_PARAGRAPHS=1`: a long reply of paragraphs, a table and a code block (many `textChunks` pieces).
  const text = process.env.STREAM_PARAGRAPHS === '1'
    ? Array.from({ length: n }, (_, i) => i % 40 === 20 ? `| Piece | Lines |\n|---|---|\n| ${i} | two |\n\n` : i % 40 === 30 ? `\`\`\`ts\nconst piece = ${i}\n\`\`\`\n\n` : `Streaming paragraph ${i}: preserve **formatted output** and Unicode 🌿.\n\n`).join('')
    : Array.from({ length: n }, (_, i) => `Word ${i}: smooth output preserves **formatting** and Unicode 🌿. `).join('')
  set({ open: { ...getState().open, blocks: [user, { ...answer, text }] } })
}, Number(process.env.STREAM_INTERVAL ?? 300))
function Fixture() { const t = useTheme(); return <div testId="stream-ready" style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', backgroundColor: t.surface }}><Transcript /></div> }
render(<ThemeProvider><Fixture /></ThemeProvider>, { title: 'Streaming parity', width: 1280, height: 820, focus: false })
process.stdin.on('end', () => { clearInterval(timer); process.exit(0) })
