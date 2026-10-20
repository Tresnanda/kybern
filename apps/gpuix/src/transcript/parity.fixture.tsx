// Standalone native verification: no daemon connection and no production data.
// Run through @gpuix/react/automation with GPUIX_BACKGROUND=1.
import '../native/local-build.ts'
import { render } from '@gpuix/react'
import { useState } from 'react'
import { emptyThreadState, type Block } from '../../../../packages/kybern-client/src/transcript.ts'
import type { Thread, ProviderStatus, UserMessage } from '../../../../packages/kybern-client/src/types.ts'
import { ComposerView } from '../Composer.tsx'
import { onWindowKeyDown } from '../nav/keys.ts'
import { getState, set } from '../state.ts'
import { Transcript } from '../Transcript.tsx'
import { Label, ThemeProvider, useTheme } from '../ui.tsx'
import { Button } from './kit.tsx'
import { ResponseImage } from './images.tsx'

const at = '2026-10-15T06:00:00Z'
const thread = (id: string, title: string) => ({ id, title, project_id: 'fixture', provider: { kind: 'claude-code', instance: 'default' }, status: 'idle', permission_mode: 'supervised', created_at: at, updated_at: at }) as Thread
const first = thread('fixture-first', 'First message')
const second = thread('fixture-second', 'Second message')
const blocks = (long: boolean): Block[] => [
  { kind: 'user', id: 'u1', turnId: 'turn1', at, seq: 1, message: { parts: [{ type: 'text', text: 'Review this code sample.' }] } },
  { kind: 'assistant', id: 'a1', messageId: 'a1', segment: 0, turnId: 'turn1', at, seq: 2, origin: { kind: 'root' }, text: long ? '```typescript\n' + Array.from({ length: 5000 }, (_, i) => `export const value${i} = ${i};`).join('\n') + '\n```' : 'A short answer.', thinking: '', complete: true },
  { kind: 'turn_end', id: 'end1', turnId: 'turn1', at, seq: 3, stopReason: 'completed', usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }, costUsd: null, durationMs: 1000, terminalMessageId: 'a1', error: null },
]
const longBlocks = blocks(true), shortBlocks = blocks(false)
if (process.env.KYBERN_PARITY_MODE === 'narrow' && longBlocks[1]?.kind === 'assistant') longBlocks[1].text = '```typescript\nexport const example = someVeryLongFunctionName(firstArgument, secondArgument, thirdArgument, fourthArgument);\n```'
function select(long: boolean) {
  const current = long ? first : second
  set({ selectedId: current.id, open: { ...emptyThreadState(), thread: current, loaded: true, blocks: long ? longBlocks : shortBlocks } })
}
set({ status: 'open', threads: [first, second], selectedId: first.id, open: { ...emptyThreadState(), loaded: true, thread: first, blocks: longBlocks } })
if (process.env.KYBERN_PARITY_MODE === 'prompt') {
  const promptBlocks = blocks(false)
  if (promptBlocks[0]?.kind === 'user') promptBlocks[0].message = { parts: [{ type: 'text', text: Array.from({ length: 20 }, (_, i) => `Prompt line ${i + 1}: inspect the requested implementation.`).join('\n') }] }
  set({ open: { ...emptyThreadState(), loaded: true, thread: { ...first, subagent: {} } as Thread, blocks: promptBlocks } })
}
const provider = { kind: 'claude-code', available: true, models: [], supported_permission_modes: ['supervised'] } as unknown as ProviderStatus

function Fixture() {
  const t = useTheme()
  const [running, setRunning] = useState(false)
  const [events, setEvents] = useState<{ delivery: string; message: UserMessage }[]>([])
  const keys = process.env.KYBERN_PARITY_MODE === 'keys'
  return <div testId="fixture-ready" style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', backgroundColor: t.surface }}>
    <div style={{ display: 'flex', gap: 8, padding: 12 }}>
      <Button testId="fixture-long" onClick={() => select(true)}>Long thread</Button>
      <Button testId="fixture-short" onClick={() => select(false)}>Short thread</Button>
      <Button testId="fixture-running" onClick={() => setRunning(!running)}>Toggle running</Button>
      <Button testId="fixture-approval" onClick={() => set({ open: { ...getState().open, pendingApprovals: [{ id: 'fixture-approval', thread_id: first.id, tool_name: 'Write', input: {}, reason: 'Fixture approval', requested_at: at } as never] } })}>Pending approval</Button>
    </div>
    {keys ? <text testId="send-events" style={{ color: t.text }}>{JSON.stringify(events)}</text> : <Transcript />}
    {keys && <div style={{ flexGrow: 1 }} />}
    {!keys && <ResponseImage source={new URL('../../../desktop/public/release-background.png', import.meta.url).pathname} thumbnail />}
    <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}>
      <ComposerView draftKey="fixture" currentThreadId="fixture-current" provider={{ kind: 'claude-code', instance: 'default' }} providers={[provider]} accounts={[]} model={process.env.KYBERN_PARITY_MODE === 'narrow' ? 'Claude Haiku 5.5 long model name' : 'Claude Haiku 5.5'} effort="high" mode="supervised" onModeChange={() => {}} catalogLoading={false} onReloadModels={async () => {}} running={running} canSteer onSend={async (message, delivery) => { setEvents(value => [...value, { message, delivery }]) }} />
    </div>
  </div>
}
render(<ThemeProvider><Fixture /></ThemeProvider>, { title: 'Transcript verification', width: process.env.KYBERN_PARITY_MODE === 'narrow' ? 426 : 1280, height: 820, focus: false, onKeyDown: onWindowKeyDown })
process.stdin.on('end', () => process.exit(0))
process.stdin.on('close', () => process.exit(0))
