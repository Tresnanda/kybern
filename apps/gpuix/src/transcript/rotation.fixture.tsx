// Standalone native verification of the Coordinator context refresh UI: no daemon connection, no production data.
//   ROTATION_MODE=rows        the row in each state (pending → settled, opened, edited, no handoff, switch, manual)
//   ROTATION_MODE=transcript  the real transcript of a Coordinator thread and the composer's context meter
//   ROTATION_MODE=off         the same with automatic refresh off for the project
// Run through @gpuix/react/automation with GPUIX_BACKGROUND=1 (`rotation.verify.ts`).
import '../native/local-build.ts'
import { render } from '@gpuix/react'
import { useState } from 'react'
import { emptyThreadState, type Block } from '../../../../packages/kybern-client/src/transcript.ts'
import type { Project, ProviderStatus, Thread } from '../../../../packages/kybern-client/src/types.ts'
import { ComposerView } from '../Composer.tsx'
import { Button } from '../kit/Button.tsx'
import { onWindowKeyDown } from '../nav/keys.ts'
import { setWindowWidth } from '../shell/layout.ts'
import { set } from '../state.ts'
import { Transcript } from '../Transcript.tsx'
import { ThemeProvider, useTheme } from '../ui.tsx'
import type { RotationBlock } from '../coordinator/rotation.ts'
import { RotationRow } from './Rotation.tsx'

const mode = process.env.ROTATION_MODE ?? 'rows'
const now = () => new Date().toISOString()
const old = '2026-10-25T14:02:00Z'

const HANDOFF = `## Goals
Ship expired-login handling for lumen-web before Friday.

## Decisions (date, what, why, commit if any)
Oct 24 · Sessions stay server-side; refresh tokens rotate weekly (\`a41c9e2\`).

## Reversals and removals
Oct 25 · Removed the expired-login fallback to /pre-launch in \`def5678\` (thread "Remove legacy auth fallback"). It was a Lovable leftover that caused the Oct 24 bug. Don't reintroduce a pre-launch check.

## User preferences
"Don't touch the onboarding copy without asking me."

## Open questions
None

## Next steps
Wait for the review agent's result on PR #42.
`

const SHORT = `## Goals
Remove the pre-launch fallback.

## Decisions (date, what, why, commit if any)
None

## Reversals and removals
None

## User preferences
None

## Open questions
None

## Next steps
Check the deploy for an old bundle.
`

const rotation = (patch: Partial<RotationBlock> & { rotationId: string }): RotationBlock => ({
  kind: 'rotation', id: `rotation:${patch.rotationId}`, turnId: 'turn1', at: old, seq: 3, reason: 'budget', pending: false, usedTokens: 203_412, windowTokens: 1_000_000,
  handoff: HANDOFF, handoffStatus: { status: 'written' }, edited: false, carried: { children: 3, pull_requests: 1, tasks: 0, commits: 5 },
  from: { kind: 'claude-code' }, to: { kind: 'claude-code' }, ...patch,
})

const Rows = () => {
  const t = useTheme()
  const [live, setLive] = useState<RotationBlock>(() => rotation({ rotationId: 'live', at: now(), pending: true, handoff: null, handoffStatus: null, carried: null }))
  const save = async (text: string) => { setLive((block) => ({ ...block, handoff: text, edited: true })); return null }
  const missing = rotation({ rotationId: 'missing', handoff: null, handoffStatus: { status: 'missing', why: 'The previous session did not answer within 90 seconds.' }, carried: { children: 2, pull_requests: 0, tasks: 0, commits: 4 } })
  const toCodex = rotation({ rotationId: 'switch', reason: 'harness_switch', to: { kind: 'codex' }, from: { kind: 'claude-code' } })
  const manual = rotation({ rotationId: 'manual', reason: 'manual', at: '2026-10-25T16:20:00Z' })
  return (
    <div testId="rotation-ready" style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', backgroundColor: t.surface, alignItems: 'center', padding: 24, gap: 4 }}>
      <div style={{ display: 'flex', gap: 8, paddingBottom: 12 }}>
        <Button testId="rotation-settle" onClick={() => setLive((block) => ({ ...block, pending: false, handoff: HANDOFF, handoffStatus: { status: 'written' }, carried: { children: 3, pull_requests: 1, tasks: 0, commits: 5 }, to: { kind: 'claude-code' } }))}>Settle</Button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', width: 560, maxWidth: '100%' }}>
        <RotationRow block={live} threadId="fixture" latest onSaveHandoff={save} />
        <RotationRow block={missing} threadId="fixture" latest={false} />
        <RotationRow block={toCodex} threadId="fixture" latest={false} />
        <RotationRow block={manual} threadId="fixture" latest={false} />
      </div>
    </div>
  )
}

const thread = { id: 'coordinator', title: 'lumen-web', project_id: 'proj', coordinator_project_id: 'proj', provider: { kind: 'claude-code', instance: 'default' }, status: 'idle', permission_mode: 'supervised', created_at: old, updated_at: old } as Thread
const project = { id: 'proj', name: 'lumen-web', path: '/tmp/lumen-web', is_git: true, brief_in_all_threads: false, ...(mode === 'off' ? { coordinator: { rotation_budget_tokens: 0 } } : {}) } as Project
const provider = { kind: 'claude-code', available: true, models: [], supported_permission_modes: ['supervised'] } as unknown as ProviderStatus
const turn = (n: number, user: string, answer: string): Block[] => [
  { kind: 'user', id: `u${n}`, turnId: `turn${n}`, at: old, seq: n * 10, message: { parts: [{ type: 'text', text: user }] } },
  { kind: 'assistant', id: `a${n}`, messageId: `a${n}`, segment: 0, turnId: `turn${n}`, at: old, seq: n * 10 + 1, origin: { kind: 'root' }, text: answer, thinking: '', complete: true },
  { kind: 'turn_end', id: `end${n}`, turnId: `turn${n}`, at: old, seq: n * 10 + 2, stopReason: 'completed', usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }, costUsd: null, durationMs: 62_000, terminalMessageId: `a${n}`, error: null },
]
const blocks: Block[] = [
  ...turn(1, 'Remove the pre-launch fallback from expired logins.', 'The fallback is gone. The child removed `src/auth/prelaunch.ts` and the redirect in `src/auth/session.ts` (commit `def5678`). Expired sessions now go to the sign-in page.'),
  rotation({ rotationId: 'r1', turnId: 'turn1', seq: 13, usedTokens: 201_050, handoff: SHORT, carried: { children: 1, pull_requests: 0, tasks: 0, commits: 2 } }),
  ...turn(2, 'Users with expired logins land on pre-launch sometimes. What should we change?', "That shouldn't happen anymore. The pre-launch fallback was removed in `def5678`, and I checked `src/auth/session.ts` at HEAD: an expired session now redirects to `/sign-in`."),
  rotation({ rotationId: 'r2', turnId: 'turn2', seq: 23, reason: 'budget', at: old, edited: false }),
]

function Chat() {
  const t = useTheme()
  const [pending, setPending] = useState(false)
  return (
    <div testId="rotation-ready" style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', backgroundColor: t.surface }}>
      <div style={{ display: 'flex', gap: 8, padding: 12 }}>
        <Button testId="rotation-pending" onClick={() => {
          const next = !pending
          setPending(next)
          set({ open: { ...emptyThreadState(), loaded: true, thread, providerUsage: { context: { used_tokens: 142_000, window_tokens: 1_000_000 } }, blocks: next ? [...blocks.slice(0, -1), rotation({ rotationId: 'r2', turnId: 'turn2', seq: 23, pending: true, at: now(), handoff: null, handoffStatus: null, carried: null })] : blocks } })
        }}>Toggle pending</Button>
      </div>
      <Transcript />
      <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}>
        <ComposerView draftKey="rotation" currentThreadId={thread.id} provider={{ kind: 'claude-code', instance: 'default' }} providers={[provider]} accounts={[]} model="Opus 5.5" effort="high" mode="supervised" onModeChange={() => {}} catalogLoading={false} onReloadModels={async () => {}} running={false} canSteer onSend={async () => {}} />
      </div>
    </div>
  )
}

// The shell's poller sets this in the app; popovers size themselves against it.
setWindowWidth(mode === 'rows' ? 720 : 1000)
if (mode !== 'rows') set({ status: 'open', threads: [thread], projects: [project], selectedId: thread.id, open: { ...emptyThreadState(), loaded: true, thread, blocks, providerUsage: { context: { used_tokens: 142_000, window_tokens: 1_000_000 } } } })
render(<ThemeProvider>{mode === 'rows' ? <Rows /> : <Chat />}</ThemeProvider>, { title: 'Rotation verification', width: mode === 'rows' ? 720 : 1000, height: mode === 'rows' ? 780 : 860, focus: false, onKeyDown: onWindowKeyDown })
process.stdin.on('end', () => process.exit(0))
process.stdin.on('close', () => process.exit(0))
