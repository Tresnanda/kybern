// A real transcript with three failed turns (signed out, a lost connection, and a failure Kybern cannot name), so
// `scripts/errors-p5-check.ts` can assert what is painted and capture it in light and dark. No daemon: the buttons are
// the real ones, the daemon calls they would make go nowhere.
import '../src/native/local-build.ts'
import { render } from '@gpuix/react'
import { emptyThreadState, type Block } from '../../../packages/kybern-client/src/transcript.ts'
import type { Thread } from '../../../packages/kybern-client/src/types.ts'
import { onWindowKeyDown } from '../src/nav/keys.ts'
import { setWindowWidth } from '../src/shell/layout.ts'
import { set } from '../src/state.ts'
import { Transcript } from '../src/Transcript.tsx'
import { ThemeProvider, useTheme } from '../src/ui.tsx'

const at = '2026-11-06T09:00:00Z'
const usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }
const thread = { id: 'failed', title: 'lumen-web', provider: { kind: 'claude-code', instance: 'default' }, status: 'failed', permission_mode: 'supervised', created_at: at, updated_at: at } as Thread

const failed = (n: number, user: string, error: string, problem?: object): Block[] => [
  { kind: 'user', id: `u${n}`, turnId: `turn${n}`, at, seq: n * 10, message: { parts: [{ type: 'text', text: user }] } },
  { kind: 'turn_end', id: `end${n}`, turnId: `turn${n}`, at, seq: n * 10 + 2, stopReason: 'error', usage, costUsd: null, durationMs: 0, terminalMessageId: null, error, ...(problem ? { problem } : {}) } as Block,
]
const blocks: Block[] = [
  ...failed(1, 'Fix the expired-login redirect.', 'Invalid API key · Please run /login', { kind: 'signed_out', subject: 'claude', detail: 'Invalid API key · Please run /login', retryable: true }),
  ...failed(2, 'Try the same thing again.', 'API Error: Unable to connect to API (ECONNREFUSED)', { kind: 'offline', subject: 'network', detail: 'API Error: Unable to connect to API (ECONNREFUSED)', retryable: true }),
  ...failed(3, 'And once more.', 'claude: error_during_execution'),
]

function Screen() {
  const t = useTheme()
  return <div testId="errors-ready" style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', backgroundColor: t.surface }}><Transcript /></div>
}

setWindowWidth(900)
set({ status: 'open', threads: [thread], projects: [], selectedId: thread.id, open: { ...emptyThreadState(), loaded: true, thread, blocks } })
render(<ThemeProvider><Screen /></ThemeProvider>, { title: 'Failed turns', width: 900, height: 760, focus: false, onKeyDown: onWindowKeyDown })
process.stdin.on('end', () => process.exit(0))
process.stdin.on('close', () => process.exit(0))
